# `durable-map` 通用配置表 — 说明

> QM 项目数据库文档 · 通用键值/JSONB 存储模式（id + jsonb）

## 模式概述

QM 里大量**配置类、状态类实体**不是为每个实体建一张正规表，而是统一采用一种通用模式，每类实体一张表：

```sql
CREATE TABLE IF NOT EXISTS ${table} (
  id   TEXT PRIMARY KEY,     -- 实体主键
  json JSONB NOT NULL        -- 整个实体序列化成 JSONB
);
```

配套一张**版本表**：

```sql
CREATE TABLE IF NOT EXISTS durable_map_versions (
  tbl TEXT PRIMARY KEY,      -- 哪张表
  v   BIGINT NOT NULL        -- 当前版本号（每次写入 +1）
);
```

代码层接口叫 `DurableMap<T>`（`src/persistence/durable-map.ts`），对外表现得像一个"内存 Map，但持久化到 PG"。

---

## 为什么这么设计

```text
配置类数据形态多、字段常变
用 jsonb 不需要为每个字段改表结构、跑迁移
TS 类型定义在代码层（zod/typebox 校验），存储层不需要严格列
写入是整行 upsert，简单可靠
```

代价：

```text
SQL 层面看不到结构化字段，不能按字段高效过滤/建索引
数据校验完全靠应用层
```

---

## 当前数据库里的 durable-map 表（40 张）

实测 `192.168.1.5` 上符合 `id + jsonb` 结构的表：

```text
approval_grant_modes      approval_grants          approvals
approved_harness_configs  base_model_configs       branding_configs
browse_max_steps_configs  browse_model_configs     command_policies
connector_clients         connector_status         credential_liveness
crons                     custom_model_providers   deactivated_principals
deployment_identity       deployment_layer         deployments
egress_policies           external_slack_participants_flag
interactive_fast_mode_flag keychain_asks           keychain_credentials
keychain_grants           model_credentials        monitors
org_ambient_flag          people_directory_urls    projects
sandbox_routing           security_postures        skill_packs
skills                    slack_installation       soul_configs
soul_history              turn_wall_clock_configs  unfulfilled_insights_flag
webui_model_configs
```

表名在 `src/wiring.ts` 里通过 `artifactMap<T>(table)` 注册：

```ts
// 示例（src/wiring.ts）
creds:   artifactMap<KeychainCredential>("keychain_credentials"),
skills:  artifactMap<Skill>("skills"),
projects: artifactMap<Project>("projects"),
```

---

## 当前实际数据（本地 LAN PG）

`durable_map_versions` 版本表内容：

```text
base_model_configs:      v=3
connector_status:        v=8
credential_liveness:     v=8
custom_model_providers:  v=1
deployment_identity:     v=4
projects:                v=2
skills:                  v=63   ← 技能被频繁更新
webui_model_configs:     v=1
```

部分表行数：

```text
skills:                  19 行
projects:                2 行
custom_model_providers:  1 行（DeepSeek 自定义 provider）
keychain_credentials:    0 行
```

---

## 核心操作（DurableMap 接口）

| 操作 | SQL 实现 | 说明 |
|---|---|---|
| `get(id)` | `SELECT json FROM t WHERE id=$1` | 单条读取 |
| `all()` / `entries()` | `SELECT id, json FROM t ORDER BY id` | 全表读取（走版本号缓存） |
| `put(id, value)` | `INSERT ... ON CONFLICT (id) DO UPDATE SET json=EXCLUDED.json` | upsert 整行 |
| `putIfAbsent(id, value)` | `INSERT ... ON CONFLICT DO UPDATE SET json=t.json RETURNING json` | 有则返回旧值 |
| `insertIfAbsent(id, value)` | `INSERT ... ON CONFLICT DO NOTHING` | 是否插入成功（布尔） |
| `merge(id, patch)` | `UPDATE t SET json=(json - $2::text[]) || $3::jsonb` | **字段级合并**：`-` 删字段、`\|\|` 合并 |
| `update(id, fn)` | `SELECT ... FOR UPDATE` + `UPDATE` | 读-改-写，行锁保证原子 |
| `deleteIf(id, pred)` | `SELECT ... FOR UPDATE` + `DELETE` | 条件删除，原子 |
| `delete(id)` | `DELETE FROM t WHERE id=$1` | 删除 |
| `take(id)` | `DELETE FROM t WHERE id=$1 RETURNING json` | **原子取走**（消费队列） |

### 版本号 + 缓存

```text
每次写操作（withBump）都会在 durable_map_versions 里给该表版本号 +1
读时比较版本号，变了或超过 15 秒 → 重新全表拉取
否则直接返回内存缓存（structuredClone）
```

好处：配置读取极快，又不至于长期陈旧。

---

## 并发安全

- `update` / `deleteIf` 用 `SELECT ... FOR UPDATE` 行锁，保证读-改-写不丢更新；
- 所有写操作包在 `BEGIN ... COMMIT` 事务里；
- 版本号 bump 在同一事务内完成。

---

## 与正规表的区分

| 特征 | durable-map 通用表 | 正规表（sessions / file_artifacts / acl_grants） |
|---|---|---|
| 结构 | `id + jsonb` | 每列一个字段 |
| 查询 | 按 id / 全表；无法按字段过滤 | 可按字段过滤、建索引 |
| 用途 | 配置、状态、实体快照 | 高频、需要 SQL 过滤的行为数据 |
| 迁移 | 无需（JSONB 自由扩展） | `ALTER TABLE ADD COLUMN IF NOT EXISTS` |

---

## 表结构定义位置（源码）

```text
src/persistence/durable-map.ts     ← DurableMap 实现（内存版 + PG 版）
src/persistence/pg-pool.ts         ← 底层连接池
src/wiring.ts                      ← 表名注册（artifactMap）
```

---

## 一句话总结

> `durable-map` 不是一张表，而是一种存储模式：**每类配置实体一张 `id + jsonb` 表 + 一张 `durable_map_versions` 版本表**。写入走事务 + 行锁 + 版本号自增，读取走"版本号比对 + 15 秒内存缓存"；它让技能、项目、provider、keychain、审批等几十类配置数据无需迁移即可自由演化。
