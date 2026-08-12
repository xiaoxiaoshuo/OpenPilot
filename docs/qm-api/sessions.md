# GET /api/sessions

当前用户可见的会话列表，附带实时运行状态。

## 请求

```
GET /api/sessions
```

无参数。身份取自 Portal 注入的签名头。

## 链路

```
浏览器 → Portal:8097 (会话+同源校验) → Web UI:8096 (index.ts:798)
       → Core /v1/sessions?principalId=<user> (surface.ts:441, auth:source)
       → app.listSessions (app-sessions.ts:162)
       → sessionsForViewer (app-helpers.ts:247)
       → listByParticipant SQL (postgres-session-store.ts:612)
```

## SQL（listByParticipant）

```sql
SELECT s.*, p.title AS p_title, p.archived AS p_archived, p.pinned AS p_pinned, p.color AS p_color,
       COALESCE(MAX(e.created_at), s.created_at) AS user_last_activity,
       EXISTS (SELECT 1 FROM session_entries x WHERE x.session_id = s.id
                 AND <withinParticipantWindow(x, p)>) AS has_entries
  FROM sessions s
  JOIN participants p ON p.session_id = s.id
  LEFT JOIN session_entries e ON e.session_id = s.id AND e.type = 'user'
 WHERE p.principal_id = $1
 GROUP BY s.id, p.title, p.archived, p.pinned, p.color,
          p.valid_from, p.valid_to, p.valid_from_seq, p.valid_to_seq
```

要点：

- `JOIN participants`：只返回该用户是参与者的会话；title/archived/pinned/color 取 **participants 表的私有视图**（每人看到的不同）。
- `MAX(e.created_at)`：用户最近发言时间；无发言用 `s.created_at` 兜底。
- `has_entries` 子查询用 `withinParticipantWindow`（seq 或时间双边界）过滤 fork/中途加入的可见性。
- 三张表：`sessions`、`participants(session_id, principal_id, valid_from/to, valid_from_seq/to_seq, title, archived)`、`session_entries(session_id, seq, ...)`。

## 响应

```json
{
  "sessions": [
    {
      "id": "4261a30c-...",
      "type": "chat",
      "scopeId": "personal:admin@local.test",
      "threadRef": "web:admin@local.test:default",
      "surface": "web",
      "createdAt": 1720000000000,
      "title": "本周计划",
      "archived": false,
      "pinned": false,
      "color": null,
      "lastActivityAt": 1720000000000,
      "hasEntries": true,
      "working": true,
      "awaitingInput": true,
      "backgroundJobs": 2,
      "watches": 1
    }
  ]
}
```

## 字段语义

| 字段 | 来源 | 说明 |
|---|---|---|
| `working` | `runs.activeSessionIds()` 实时 | 该会话 thread 有活跃 run |
| `awaitingInput` | `approvals.entries()` 实时 | 有待审批且 blocksInput 的记录 |
| `backgroundJobs` | `processes.listLive` 实时 | 关联 background 进程数 |
| `watches` | `monitors.enabled` 实时 | 未过期定时监控数 |
| `hasEntries` | SQL EXISTS | 参与者窗口内是否有条目 |

`working`/`awaitingInput`/`backgroundJobs`/`watches` 不是持久化字段，每次请求实时计算拼入——轮询本接口即可看到会话实时状态。

## 过滤

- 可见性：`sessionsForViewer` 额外剔除无权限的 managed project 会话。
- 空会话：`hasEntries !== false` 或 `title` 非空或正在工作/等待审批才返回。
