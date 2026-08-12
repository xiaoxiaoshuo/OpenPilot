# GET /api/contexts

按 scope 分组的会话列表（Web UI 侧边栏分组）。与 `/api/sessions` 共享同一个会话查询源。

## 请求

```
GET /api/contexts
```

无参数。

## 链路

```
浏览器 → Portal → Web UI:8096 (index.ts:803)
       → Core /v1/contexts?principalId=<user> (surface.ts:448, auth:source)
       → app.listContexts (app-sessions.ts:245) = contextsFor (app-helpers.ts:256)
```

## 组装逻辑（contextsFor）

1. **初始化 scope 集合**（sessionCount=0）：
   - `personal:<email>`：永远存在
   - internal 用户：`directory.listChannelsFor` → channel scopes（带 isPrivate）
   - `projectsForViewer` → group scopes（带 project 详情）
2. **遍历会话灌计数**（`sessionsForViewer`，与 /api/sessions 同源）：
   - 只统计 kind ∈ {personal, channel, group}；group 但不在集合且用户是群成员的补建
   - 空会话过滤同 /api/sessions（hasEntries 或 title）
   - `sessionCount++`，`lastActivityAt = max(lastActivityAt, s.lastActivityAt ?? s.createdAt)`
3. **排序**：personal 永远第一，其余按 lastActivityAt 降序。

## 响应

```json
{
  "contexts": [
    {
      "scopeId": "personal:171232349@qq.com",
      "kind": "personal",
      "name": null,
      "sessionCount": 2,
      "lastActivityAt": 1720000000000
    },
    {
      "scopeId": "group:web-project-120078e7-...",
      "kind": "group",
      "name": "2121121",
      "sessionCount": 1,
      "lastActivityAt": 1720000000000,
      "project": { "id": "...", "name": "2121121", "orgId": "local" }
    },
    {
      "scopeId": "channel:C0123",
      "kind": "channel",
      "name": "general",
      "isPrivate": false,
      "sessionCount": 0,
      "lastActivityAt": null
    }
  ]
}
```

## 类型（app-types.ts:512 ContextSummary）

```ts
interface ContextSummary {
  scopeId: ScopeId;
  kind: "personal" | "channel" | "group";
  name: string | null;
  isPrivate?: boolean;
  sessionCount: number;
  lastActivityAt: number | null;
  project?: ProjectView;
}
```

## 子路由

`GET/PUT /api/contexts/:scope/ambient-policy` → Core `/v1/contexts/policy`（见 [ambient-policy.md](./ambient-policy.md)）。

## 注意

- scope 命名：`personal:<email>` / `channel:<channelId>` / `group:web-project-<uuid>`。
- 空 channel/group 也返回（成员身份即可见），sessionCount=0。
