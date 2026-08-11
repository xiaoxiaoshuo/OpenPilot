# `acl_grants` 表 — 字段说明

> QM 项目数据库文档 · 访问控制授权表（Access Control Grants）

## 表用途

`acl_grants` 保存**资源访问授权**：某个资源的拥有者（owner scope）把某个资源（path）授权给另一个 scope（grantee）使用，并指定权限级别（read / write）。

它是 QM **跨用户/跨 scope 数据共享**的核心表：

```text
我的个人 scope（owner_scope_id）
  └─ 授权 "某文件/某目录/某应用"（path）
     └─ 给另一个用户或群组（grantee_scope_id）
        └─ 权限 read 或 write（permission）
```

> 对比：`admin_grants` 管"谁是管理员"，`acl_grants` 管"谁能访问什么资源"。

---

## 字段清单

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `owner_scope_id` | `text` | `NOT NULL`，主键之一 | 资源所有者的 scope，如 `personal:171232349@qq.com` |
| `path` | `text` | `NOT NULL`，主键之一 | 资源路径（ref），如 `artifacts/xxx`、文件路径、项目路径 |
| `grantee_scope_id` | `text` | `NOT NULL`，主键之一 | 被授权方的 scope：另一个用户 `personal:xxx` 或群组 `group:xxx` |
| `permission` | `text` | `NOT NULL`，主键之一 | 权限级别，取值 `read` / `write` |
| `granted_by` | `text` | `NOT NULL` | 授权人（谁执行的这次授权） |

### 主键

```sql
PRIMARY KEY (owner_scope_id, path, grantee_scope_id, permission)
```

含义：同一 owner 的同一资源对同一 grantee 的同一权限，只能有一条记录（幂等 upsert）。

---

## 权限取值

源码定义（`src/types.ts`）：

```ts
export type Permission = "read" | "write";
```

| 值 | 含义 |
|---|---|
| `read` | 只读：可查看资源内容 |
| `write` | 读写：可修改、更新资源 |

---

## 并发控制：advisory lock

由于同一 owner 的同一资源可能有多条 grant（不同 grantee / 不同权限），修改时只锁单行不够，代码用**事务 + advisory lock** 把"同一 owner+path 的所有授权操作"串行化：

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('acl-grants:' || owner_scope_id || E'\n' || path));
-- 增删改 acl_grants
COMMIT;
```

好处：事务结束锁自动释放，不用手动 unlock。

---

## 写入是幂等 upsert

```sql
INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (owner_scope_id, path, grantee_scope_id, permission)
DO UPDATE SET granted_by = EXCLUDED.granted_by
```

重复授权同一项不会报错，只更新 `granted_by`。

---

## 数据隔离关系

`sessions` 表靠 `scope_id` 天然隔离；`acl_grants` 则是**主动共享**的通道：

```text
无 grant  → 资源只属于 owner scope，其他人不可见
有 grant  → grantee scope 可访问该资源（按 permission 级别）
```

查询时（例如 `listSessions(principalId)` / `listScopeResources(principalId, scope)`）会先解析用户所属 scope，再 union 上被授权（grantee）的 scope 资源。

---

## 实际数据（本地 LAN PG）

当前表中 **0 行**：

```text
还没有任何共享授权（还没有把资源分享给其他人/群组）
```

---

## 表结构定义位置（源码）

```text
src/acl/postgres-grant-store.ts
```

启动时自动执行：

```sql
CREATE TABLE IF NOT EXISTS acl_grants(...)
```

---

## 与其他表的关系

| 表 | 关系 |
|---|---|
| `admin_grants` | 管"管理员权限"，`acl_grants` 管"资源访问权限"，两者独立 |
| `sessions` / `file_artifacts` | 它们的 `scope_id` / `owner_scope_id` 是 `acl_grants` 的 owner/grantee 取值来源 |
| `directory_members` | 群组成员关系，可推导出"某群组被授权的资源" |

---

## 一句话总结

> `acl_grants(owner_scope_id, path, grantee_scope_id, permission, granted_by)` 记录"谁（owner）把哪个资源（path）以什么权限（read/write）授权给谁（grantee）"，四列联合主键保证幂等；写入用 advisory lock 保证同一资源的并发授权安全。它是 QM 数据隔离之外"主动共享"的唯一通道。
