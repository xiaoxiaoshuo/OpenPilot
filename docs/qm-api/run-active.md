# GET /api/runs/active?threadRef=

找回线程上活跃的 run（页面刷新/重连后恢复现场）。

## 请求

```
GET /api/runs/active?threadRef=web:171232349@qq.com:9f477be6-...
```

`threadRef` 必须以 `web:` 开头，否则 404。

## 链路与两级查找

```
浏览器 → Web UI:8096 (index.ts:1574)
       ├─ ① 内存 activeRunsByThread（rememberRun 登记的 runId 列表）
       │    逐个 GET /v1/runs/:id 验证：done/failed → forgetRun；活跃 → 返回
       └─ ② 兜底 → Core GET /v1/runs?threadRef=... (turns.ts:161)
                     → app.activeRunForThread (app-turn.ts:487)
```

Web UI 的 `runOwners`/`activeRunsByThread` 是**进程内内存 Map**，刷新即丢（run 本身在 Postgres，不丢）——所以需要 ② 兜底从 Core 找回。

## 响应

```json
// 活跃 run
200 { "runId": "run_xxx", "run": { "status": "running", ... } }
// 无活跃 run
200 { "runId": null, "run": null }
```

## Core 侧

`activeRunForThread(threadRef, viewer)` → `runs.activeForThread` → `viewerMayUseRun` 权限校验。

## 典型配合流程

```
POST /api/turn            → 202 {runId} → rememberRun（内存登记）
GET  /api/runs/active     → 刷新后找回 runId
GET  /api/runs/:id/events → 重挂 SSE 继续看流式输出
GET  /api/sessions/:id    → 拉完整转写
```
