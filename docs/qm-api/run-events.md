# GET /api/runs/:id/events (SSE)

run 的流式事件接口。**轮询式 SSE**（非推送）：Web UI 定时拉 Core `/v1/runs/:id`，按增量发事件。

## 请求

```
GET /api/runs/<runId>/events
Accept: text/event-stream
```

## 链路

```
浏览器 ← SSE ← Web UI:8096 (index.ts:1615)
              └─ 循环轮询 → Core /v1/runs/:id (turns.ts:160, auth:source)
                              → app.getRun (app-turn.ts:454)
```

## 权限预检

`ownsRun(runId, user)`：web-ui 进程内 `runOwners` Map（发起时 rememberRun 登记）。非本人发起 → 向 Core 验证 run 可访问，失败 404/502。

## 事件流

| 事件 | 触发 | 载荷 |
|---|---|---|
| `: open` / `: ping` | 连接建立 / 心跳 | 注释行 |
| `partial` | `run.partial` 字符串变长 | `{ partial }`（流式文本增量） |
| `activity` | `run.activity` 数组变长 | `{ activity, startedAt }`（工具活动） |
| `stale` | `run.stale` 状态变化 | `{ stale }`（run 卡死/租约丢失） |
| `alive` | 心跳时 run 活跃 | `{ at }` |
| `done` | 终态或 replyComplete | `{ status, result, partial, activity, startedAt, finishedAt }` |
| `failed` | Core 两次不可达 | `{ reason }` |

## 断开条件

- 客户端 close
- 终态（done/failed/result!=null/replyComplete）→ 发 `done` 后 `forgetRun`
- `SSE_IDLE_MS` 无进展

## Core 侧动态字段（app.getRun）

| 字段 | 来源 | 说明 |
|---|---|---|
| `partial` | `turnStream.snapshot(runId)` | harness 流式生成中的文本快照 |
| `alive` | `turnStream.alive` | 是否活跃 |
| `replying` / `replyComplete` | `turnStream` | 是否在回复 / 回复完成 |
| `activity` | `runActivity.list(runId)` | 工具调用活动（postgres-run-activity-store） |
| `tasks` | `tasks.list` | 关联任务 |
| `stale` | pending 且 attempts>0，或非 alive 且租约超时 | 宽限 `STALE_LEASE_GRACE_MS` |

权限：`viewerMayUseRun` —— dm 必须同人；channel/group 必须 scope 成员，group 还要求 project 版本一致。

## 响应示例（Core /v1/runs/:id）

```json
{
  "status": "running",
  "startedAt": 1720000000000,
  "partial": "我在生成回答的中间文本……",
  "firstBlock": { "text": "第一段" },
  "alive": true,
  "activity": [ { "kind": "tool_call", "tool": "execute", "ts": 1720000000000 } ]
}
```
