# `projects` 表 — 说明

> QM 项目数据库文档 · 项目表（durable-map 模式，id + jsonb）

## 表用途

`projects` 保存 **QM 里的"项目"（Project）**：用户创建的协作空间，用于把一组成员和资源（会话、文件、cron、应用）组织在一起。

```text
创建项目（如 Web UI 里的"New project"）
  → 一个 project 记录：名字 + 所有者 + 成员列表
  → 每个项目对应一个群组 scope：group:web-project-<id>
  → 项目下的会话/文件/资源都挂在这个 scope 下
```

它回答的是"**谁能和谁在同一个项目里协作**"。

---

## 存储结构：durable-map 模式

`projects` 不是正规多列表，而是 **`id + jsonb` 通用表**：

```sql
CREATE TABLE IF NOT EXISTS projects (
  id   TEXT PRIMARY KEY,   -- 项目 UUID
  json JSONB NOT NULL      -- 整个 Project 对象序列化
);
```

表结构定义在 `src/persistence/durable-map.ts`，注册在 `src/wiring.ts`：

```ts
const projects = createProjectStore(artifactMap<Project>("projects"), {...});
```

---

## JSON 内字段（Project 对象）

`src/projects/project-store.ts` 定义：

```ts
export interface Project {
  id: string;          // 项目 ID（UUID）
  orgId: string;       // 所属组织（如 local）
  name: string;        // 项目名称（≤200 字符，去首尾空白、压缩连续空格）
  ownerId: string;     // 所有者 principal（如 admin@local.test）
  memberIds: string[]; // 成员列表（含 owner 自己）
  createdAt: number;   // 创建时间（Unix 毫秒）
  updatedAt: number;   // 最后更新时间（毫秒；成员变更时保证严格递增）
}
```

---

## 项目 ↔ Scope 的映射

项目不是独立的 scope，而是映射到一个群组 scope：

```ts
// project-store.ts
const PROJECT_GROUP_PREFIX = "web-project-";

projectGroupRef(id)  → "web-project-<项目id>"
projectScopeId(id)   → "group:web-project-<项目id>"
projectIdFromGroupRef(ref) → 反向解析出项目 id
```

```text
项目 54307325-...  → scope = group:web-project-54307325-...
项目下的会话/文件/资源 owner_scope_id = group:web-project-<id>
```

`isProjectGroupRef` / `recognizes()` 让系统知道"这个 group scope 是项目"。

---

## 核心操作（ProjectStore）

| 操作 | 说明 |
|---|---|
| `create({name, ownerId})` | 创建项目，owner 自动成为第一个成员；`putIfAbsent` 防 ID 冲突 |
| `get(id)` | 查单个项目 |
| `listForMember(principalId)` | 列出该用户参与的活跃项目（按 updatedAt 倒序） |
| `addMember(id, actor, memberId)` | 加成员：要求 **actor 已是项目成员**（同人归一 `samePerson`），不能加 owner 自己 |
| `removeMember(id, ownerId, memberId)` | 移除成员：**只有 owner 能移除** |
| `rename(id, ownerId, name)` | 改项目名：只有 owner |
| `membership(groupRef, principalId)` | 判断某人是否项目成员（供权限校验） |
| `members(groupRef)` | 取项目成员列表 |
| `version(groupRef)` / `withVersion(...)` | 版本校验（updatedAt），用于带条件的乐观并发 |

### 并发与一致性

```text
每个项目的所有变更走 keyed queue + advisory lock（project:<id>）
成员增删用 DurableMap.update（SELECT ... FOR UPDATE 行锁）读-改-写
updatedAt 严格递增（Math.max(now, updatedAt+1)），保证 version 单调
isActiveMember 过滤停用用户
```

---

## 实际数据（本地 LAN PG）

当前 **2 行**（都是用户建的 "wx" 项目）：

```json
{
  "id": "54307325-26f4-4813-8c3d-d9d571918a0d",
  "name": "wx",
  "orgId": "local",
  "ownerId": "admin@local.test",
  "memberIds": ["admin@local.test"],
  "createdAt": 1786268369960,
  "updatedAt": 1786268369960
}
{
  "id": "8f81853a-f135-4372-91d9-bc9449a9d9b6",
  "name": "wx",
  "orgId": "local",
  "ownerId": "171232349@qq.com",
  "memberIds": ["171232349@qq.com"],
  "createdAt": 1786376634855,
  "updatedAt": 1786376634855
}
```

版本表（`durable_map_versions`）中 `projects: v=2`。

---

## 与相关表的关系

| 表/概念 | 关系 |
|---|---|
| `sessions` | 项目下会话的 `scope_id = group:web-project-<id>` |
| `file_artifacts` | 项目文件的 `owner_scope_id` / `created_in_scope` 同上 |
| `durable_map_versions` | projects 表自身的版本号（每次写 +1） |
| `directory_members` | 成员校验时判断 principal 是否活跃 |
| `acl_grants` | 项目资源共享给项目外的人时用 |

---

## 表结构定义位置（源码）

```text
src/projects/project-store.ts        ← Project 接口 + 业务逻辑 + scope 映射
src/persistence/durable-map.ts       ← 通用 id+jsonb 存储
src/wiring.ts                        ← 表注册 artifactMap("projects")
```

---

## 一句话总结

> `projects` 是 durable-map 模式的 `id + jsonb` 表：每条记录是一个 Project（id/orgId/name/ownerId/memberIds/时间戳），通过 `group:web-project-<id>` scope 把所有项目资源组织在一起；成员变更必须由 owner 或有权限的成员执行，靠行锁 + advisory lock + 递增版本号保证并发一致。它定义了"谁能和谁一起协作"。
