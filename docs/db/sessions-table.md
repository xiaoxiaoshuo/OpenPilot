# `sessions` 表 — 字段说明

> QM 项目数据库文档 · 会话表（Conversation Sessions）

## 表用途

`sessions` 表保存**每一个对话会话**（Conversation / Session）的元数据：

```text
谁（scope_id）在什么渠道（surface）用什么类型（type）创建了哪条会话
标题、消息数、轮次数、最后活跃时间
以及会话之间的 fork（分支）关系
```

会话的**具体消息内容**不在这张表，而在关联表 `session_entries` / `session_tape`。

---

## 字段清单

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `text` | `PRIMARY KEY` | 会话唯一 ID（UUID） |
| `type` | `text` | `NOT NULL` | 会话类型：`dm`（个人私聊）/ `channel`（频道）/ `group`（群组）/ `web-project` 等 |
| `scope_id` | `text` | `NOT NULL` | **归属范围**（数据隔离的关键）：`personal:<principal>` / `group:...` / `org:...` |
| `thread_ref` | `text` | `UNIQUE NOT NULL` | 线程引用，格式 `<surface>:<principal>:<随机串>`，如 `web:171232349@qq.com:abc123` |
| `created_at` | `bigint` | `NOT NULL` | 创建时间（Unix 毫秒） |
| `title` | `text` | | 会话标题（自动生成或用户改名） |
| `channel_name` | `text` | | 频道名（仅 channel 类型有值，dm 为 NULL） |
| `surface` | `text` | | 来源渠道：`web`（Web UI）/ `slack` 等 |
| `last_activity` | `bigint` | | 最后活跃时间（Unix 毫秒），用于排序"最近会话" |
| `messages` | `integer` | | 消息总数（冗余计数，由 `session_entries` 汇总） |
| `turns` | `integer` | | 轮次总数（用户发言轮次，冗余计数） |
| `forked_from_session_id` | `text` | | 若本会话是分支，指向源会话 ID |
| `forked_from_title` | `text` | | 分支时源会话的标题快照 |
| `fork_boundary_seq` | `integer` | | 分支边界（从源会话哪个 seq 开始 fork） |

---

## 约束与索引

### 主键

```sql
PRIMARY KEY (id)
```

### 唯一约束

```sql
UNIQUE (thread_ref)   -- 同一渠道+用户+随机串唯一
```

### 检查约束：fork 来源成对出现

```sql
CONSTRAINT sessions_fork_provenance_pair
CHECK ((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL)) NOT VALID
```

含义：要么"有源会话 ID 且有边界 seq"（真 fork），要么两者都为空（非 fork），不允许只有其一。

### 索引

```sql
CREATE INDEX sessions_by_scope
  ON sessions(scope_id, created_at DESC)          -- 按 scope 查会话列表

CREATE INDEX sessions_by_activity
  ON sessions((COALESCE(last_activity, created_at)) DESC, id DESC)  -- "最近活跃"排序

CREATE INDEX sessions_by_scope_activity
  ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC)  -- scope 内按活跃排序
```

---

## 关联表

| 表 | 关系 | 说明 |
|---|---|---|
| `session_entries` | 1 : N（`session_id, seq` 复合主键） | 会话的正文消息（用户消息/工具调用等） |
| `session_tape` | 1 : N（`session_id, seq`） | 会话的完整记录带（含 harness 信息、隐藏/旁听消息） |
| `participants` | N : N（`session_id, principal_id`） | 会话参与者（人/机器人），含加入/退出时间 |
| `session_leases` | 1 : 1（`session_id` 主键） | 会话写入租约（防止多实例并发写同一会话） |
| `session_llm_requests` | 1 : N | 每次 LLM 调用记录（模型、耗时、用量） |

---

## 数据隔离说明

`sessions.scope_id` 是**用户数据隔离的核心字段**：

```text
personal:171232349@qq.com   → 171232349 的会话
personal:admin@local.test   → admin 的会话
```

查询时按 `principalId` 解析出用户可访问的 scopes，再按 `scope_id` 过滤，其他用户的会话不可见。

---

## 实际数据示例（本地 LAN PG 7 行概览）

| id（前 8 位） | type | scope_id | surface | title | messages | turns |
|---|---|---|---|---|---|---|
| `5f933663` | dm | `personal:admin@local.test` | web | Connect first account | 27 | 6 |
| `c04cd452` | dm | `personal:admin@local.test` | web | LAN PG DeepSeek OK | 99 | 7 |
| `5af902d0` | dm | `personal:171232349@qq.com` | web | Turn chat orange | 45 | 7 |
| `de6ef3b3` | dm | `personal:2756239006@qq.com` | web | Intro to QM setup | 2 | 1 |
| `18de57c3` | dm | `personal:2756239006` | web | （无标题） | 10 | 1 |
| `abdf4892` | dm | `personal:171232349@qq.com` | web | Deploy app | 32 | 4 |
| `5fb6e22f` | dm | `personal:171232349@qq.com` | web | Deploy app (fork) | 32 | 4 |

> 第 7 行 `5fb6e22f` 为第 6 行 `abdf4892` 的 fork（`forked_from_session_id` 指向后者）。

---

## 表结构定义位置（源码）

```text
src/sessions/postgres-session-store.ts
```

通过 `createPgPool(connectionString, SCHEMA)` 启动时自动执行 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 完成建表和渐进式加列。
