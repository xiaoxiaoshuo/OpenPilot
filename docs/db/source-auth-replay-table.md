# `source_auth_replay` 表 — 字段说明

> QM 项目数据库文档 · 登录防重放表（Single-Use Claim / Replay Dedupe）

## 表用途

`source_auth_replay` 是**邮箱登录流程中唯一真正落库的表**，负责记录"哪些一次性凭证已经被使用过"，实现**防重放**：

```text
邮箱登录链接（link:<jti>）   → 用过一次就作废
authorization code（code:<jti>）→ 用过一次就作废
```

无论进程如何重启，已消费的凭证都不会"复活"——这是它必须存 PostgreSQL 而不是内存的原因。

---

## 字段清单

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `event_id` | `text` | `PRIMARY KEY` | 一次性凭证的全局唯一 ID，格式如 `link:<jti>` / `code:<jti>` |
| `expires_at` | `timestamp with time zone` | `NOT NULL` | 过期时间；过期的记录可被定期清理 |

### 索引

```sql
CREATE INDEX source_auth_replay_expires_at
  ON source_auth_replay (expires_at);
```

用于高效清理过期记录。

---

## 核心逻辑：claim（一次性消费）

```sql
INSERT INTO source_auth_replay (event_id, expires_at)
VALUES ($1, to_timestamp($2 / 1000.0))
ON CONFLICT (event_id) DO NOTHING;
```

```text
返回 rowCount == 1 → 本次插入成功 → 该凭证首次使用，放行
返回 rowCount == 0 → 已存在 → 凭证被用过，拒绝
```

利用 PostgreSQL 主键 + `ON CONFLICT DO NOTHING` 的**原子性**，多实例并发消费同一凭证时也只有一个能成功。

---

## 清理策略

每次 claim 时顺带清理（带节流）：

```sql
DELETE FROM source_auth_replay WHERE expires_at < to_timestamp($1 / 1000.0);
```

```text
过期记录定期删除，表不会无限膨胀
```

---

## 在邮箱登录中的位置

```text
POST /idp/verify          → claimOnce("link:<jti>")  防止登录链接被用两次
POST /idp/token           → claimOnce("code:<jti>")  防止授权码被换两次 token
```

底层调用链：

```text
auth broker（plugins/auth）
  → POST /v1/auth/broker/claim（Core :8080，source 签名认证）
    → replayDedupe.claim(eventId, expiresAtMs)
      → INSERT INTO source_auth_replay ... ON CONFLICT DO NOTHING
```

> Core 的 `POST /v1/auth/broker/claim` 路由要求设置 `DATABASE_URL`：没有 PG 时一次性凭证无法跨重启持久，已用的登录链接可能"复活"。

---

## 实际数据（本地 LAN PG）

当前 **2 行**（说明发生过 2 次一次性凭证消费）：

```text
event_id    : link:xxx / code:xxx（具体的 jti 值）
expires_at  : 各自的过期时间
```

---

## 表结构定义位置（源码）

```text
src/auth/replay-dedupe.ts
```

启动时自动执行：

```sql
CREATE TABLE IF NOT EXISTS source_auth_replay (...);
CREATE INDEX IF NOT EXISTS source_auth_replay_expires_at ON source_auth_replay (expires_at);
```

---

## 一句话总结

> `source_auth_replay(event_id, expires_at)` 用主键 + `ON CONFLICT DO NOTHING` 实现"一次性凭证只能消费一次"的原子语义，存的是邮箱登录链接和授权码的使用痕迹；配合定期清理过期记录，是整套 OIDC 邮件登录防重放、防重放的持久化基石。
