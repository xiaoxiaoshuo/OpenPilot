# POST /api/runs/:id/signal

运行时控制接口：`abort`（停止生成）/ `steer`（正在回复时插话）。信号**持久化**（Postgres），非内存消息。

## 请求

```
POST /api/runs/<runId>/signal
Content-Type: application/json

// 停止生成
{ "kind": "abort" }
// 插话引导
{ "kind": "steer", "text": "先别管这个，看看那个" }
```

## 链路

```
浏览器 → Web UI:8096 (index.ts:1608)
       → Core /v1/runs/:id/signal (turns.ts:111, auth:source)
       → app.signalRun (app-turn.ts:497)
       → run_signals 表 INSERT + pg_notify
       → harness 轮询消费（startSignalPoll → takePending）
```

## 校验与返回（app.signalRun）

| 条件 | 返回 |
|---|---|
| signals store 不可用 | 409 `signals_unavailable` |
| run 不存在 / 无权访问（viewerMayUseRun） | 404（不泄露存在） |
| run 已终态 | 409 `terminal` |
| steer 无 text | 400 `text_required` |
| 正常 | 200 `{ accepted: true }` |
| 写后 run 已终态（steer 落在 drain 间隙） | 409 `terminal` + `replayed: true`（孤儿重放成新 run，前端去挂新 runId） |

## 存储（postgres-run-signal-store.ts）

```sql
-- send：插入 + 跨进程通知
WITH ins AS (
  INSERT INTO run_signals(run_id, kind, text, payload, created_at) VALUES ($1,$2,$3,$4,$5)
)
SELECT pg_notify('<channel>', $1);

-- takePending：原子消费（取走即标记，多 worker 竞争安全）
UPDATE run_signals SET consumed_at=$2
 WHERE run_id=$1 AND consumed_at IS NULL
 RETURNING id, kind, text, payload;
```

表：`run_signals(id, run_id, kind, text, payload, created_at, consumed_at)`，部分索引 `(run_id) WHERE consumed_at IS NULL`。

## harness 消费（pi-harness.ts:1708）

| 信号 | 处理 |
|---|---|
| `onSteer` | 按 ts 去重（recordedMessageTimestamps）→ 持久化 `{type:"user", payload:{text, ts, steered:true}}` 进 session_entries → `agentSession.steer(text)` 注入正在跑的 agent |
| `onAbort` | `userAborted=true` → `toolAbort.abort()`（取消执行中工具）→ `agentSession.abort()`（中止 LLM） |

轮询器（run-signal-store.ts `startSignalPoll`）：`onSignal`（LISTEN/NOTIFY）通知 + 定时兜底，`takePending` 原子取走，`draining/redrain` 防重入。

## 与 /api/turn 的关系

`/api/turn` 检测到线程已有活跃 run 时，把新消息转成 **steer 信号**（app-turn.ts 活跃 run 拦截分支）——两端是同一机制：`/api/turn` 负责"检测+转换"，`/api/runs/:id/signal` 是"直接发信号"。

## 设计要点

1. 信号持久化：worker 崩溃不丢，重连补消费
2. 孤儿重放：steer 恰好落在 run 结束间隙时不丢，重放成新 run
3. 无权=404：不暴露 run 是否存在
4. steer 消息落库 + ts 去重：信号重试/重放不产生重复消息
