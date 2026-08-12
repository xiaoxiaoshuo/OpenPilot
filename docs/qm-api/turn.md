# POST /api/turn

发送消息的主入口：新消息、续聊（steer）、审批响应、附件引用都走这一个接口。

## 请求

```
POST /api/turn
Content-Type: application/json

{
  "text": "你好",
  "threadRef": "web:171232349@qq.com:default",
  "scopeId": "personal:171232349@qq.com",
  "model": "deepseek-chat",
  "harness": "pi",
  "thinkingLevel": "...",
  "fastMode": true,
  "timezone": "Asia/Shanghai",
  "attachments": [{ "name": "a.pdf", "mimetype": "application/pdf", "sizeBytes": 123, "blobId": "..." }],
  "approval": { "requestId": "...", "approved": true, "scope": "once|session|always" },
  "proactiveOpener": false
}
```

## 链路

```
浏览器 → Portal（同源校验：非 GET 必须带 Origin）→ Web UI:8096 (index.ts:1438)
       → POST /v1/turns?async=1 (turns.ts:30, auth:source)
       → app.turn (app-turn.ts:56)
       → runs.enqueue → Postgres runs 表 (pending)
       → worker/orchestrator → harness (pi/claude/codex/opencode)
```

## 校验顺序（app.turn）

| # | 校验 | 失败返回 |
|---|---|---|
| 1 | 身份解析 `identity.resolve` | - |
| 2 | group scope：internal + 项目成员 + 项目属本 org | `refused "you're not a member of that context"` |
| 3 | web 非 dm：`mayUseSharedScope` | 同上 |
| 4 | 已存在 thread → scopeId 一致；新 thread → 必须 `web:<user>:` 前缀 | `refused` |
| 5 | 运行时解析 + 模型 provider/白名单 | `refused "that model isn't available..."` |
| 6 | 线程有 pending blocking 审批 → 拒绝（除非带匹配 approval） | `refused` |
| 7 | 幂等 `idempotencyKey` → dedupKey（project 加版本后缀） | - |
| 8 | 线程有活跃 run → 消息转 **steer 信号**注入（见 run-signal.md） | `queued`/`steered` |
| 9 | `runs.enqueue`（pg 队列） | - |
| 10 | 广播 sessionStateBus `working` → Web UI SSE | - |

## 响应

```json
// async 模式（Web UI 固定 async=1）
202 { "status": "queued", "runId": "run_xxx" }
// 或被拒绝
403 { "status": "refused", "reason": "you're not a member of that context" }
// 校验失败
400 { "error": "empty message" }
403 { "error": "forbidden_thread", "message": "this conversation can only be continued from its own context" }
```

## Web UI 层校验（index.ts:1438）

- 解析白名单字段，非法字段忽略
- 空消息（无 text/attachments/approval/proactiveOpener）→ `400 empty message`
- `threadRef` 非 `web:<user>:` 前缀且 scope 非 channel/group → `403 forbidden_thread`（防越权）
- `conversationForScope`：scope 必须 personal 本人或 channel/group → `403 forbidden_scope`

## 执行链路（同步 drive 时）

```
drive(runId) (app-helpers.ts:184)
  → runs.claimById(runId, "inline", ttl)   抢占（否则 waitFor 等 worker）
  → processRun (worker.ts:22)
      → orchestrator.handleTurn (orchestrator.ts:391)
          身份/roster/限流/预算 → scope 解析 → 会话对账
          → 历史/压缩/安全分类 → deps.harness.turns.runTurn (pi-harness.ts:1454)
      → runs.complete / fail（Postgres）
```

注意：`web:<user>:` 线程前缀规则是 Web 表面身份隔离核心——个人线程只能本人发起，共享 scope 线程归 scope 所有。
