# GET /api/sessions/:id

单个会话详情 + 转写（消息列表），支持分页窗口。

## 请求

```
GET /api/sessions/<sessionId>
```

| 查询参数 | 说明 |
|---|---|
| `tailTurns` | 只看尾部 N 个回合 |
| `sinceSeq` | 只看 seq 之后的条目 |
| `beforeSeq` | 只看 seq 之前的条目 |

`viewer=<user>` 由 Web UI 自动附加。

## 链路

```
浏览器 → Web UI:8096 (index.ts:1086)
       → Core /v1/sessions/:id?viewer=...&tailTurns=... (surface.ts:1325, auth:source)
       → getSession (surface.ts:212)
       → app.getSessionForViewer (app-sessions.ts:85)
```

## 实现（app.getSessionForViewer）

```ts
const session = (await sessionsForViewer(principalId)).find((s) => s.id === sessionId);
if (!session) return null;                                   // 不可见 → 404
const w = windowedTranscript(
  transcriptEntries(await deps.sessions.visibleEntries(sessionId, principalId)),
  window,
);
return { session, entries: w.entries, ...(w.earlier > 0 ? { earlierEntries: w.earlier } : {}) };
```

- 可见性：`sessionsForViewer`（participants 表 + 窗口过滤），不可见统一 404。
- `visibleEntries`：带 `withinParticipantWindow` 过滤（fork/中途加入的条目对参与者不可见）。

## 响应

```json
{
  "session": {
    "id": "4261a30c-...",
    "type": "chat",
    "scopeId": "personal:171232349@qq.com",
    "threadRef": "web:171232349@qq.com:default",
    "title": null,
    "createdAt": 1720000000000
  },
  "entries": [
    { "seq": 1, "type": "user", "payload": { "text": "你好" }, "scopeLabel": "personal:...", "createdAt": 1720000000000 }
  ],
  "earlierEntries": 12
}
```

`earlierEntries > 0` 表示还有更早条目（前端"加载更多"）。

## 同前缀子路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/sessions/:id/title` | POST | 重命名会话（→ `/v1/sessions/:id/title`） |
| `/api/sessions/:id/fork` | POST | 复制会话（→ `/v1/sessions/:id/fork`） |
| `/api/sessions/:id/approvals` | GET | 会话待审批列表 |
| `/api/sessions/:id/background` | GET | 会话后台任务 |
| `/api/sessions/:id` | PATCH | 更新 archived/pinned/title/color（participants 私有视图） |
