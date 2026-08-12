# GET /api/scope-resources?scope=

scope（项目/频道/personal）的资源聚合：文件、cron、deployment、skills，及可管理性。

## 请求

```
GET /api/scope-resources?scope=group:web-project-13535954-9812-46fd-aed2-b1c05edd67b3
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `scope` | 是 | `personal:<email>` / `channel:<id>` / `group:web-project-<uuid>` |

`principalId` 由 Web UI 自动附加。

## 链路

```
浏览器 → Web UI:8096 (index.ts:938)
       → Core /v1/scope-resources (surface.ts:1337, auth:source)
       → listScopeResources (surface.ts:455)
       → app.listScopeResources (app-sessions.ts:336)
```

## 实现（app.listScopeResources）

1. `principalCanAccessCurrentScope(principalId, scope)` 校验——**无权限 → 404 "not a context you can see"**（不泄露存在）
2. 并行聚合：
   - `files`：`filesForViewer` 的 owned+shared（本 scope），按 createdAt 降序
   - `crons`：`ownerScopeId === scope` 的
   - `deployments`：`createdInScope === scope || ownerScopeId === scope`，且带 `principalGitPermission` 过滤（无 git 权限的剔除）
   - `skills`：`scopeId === scope`
3. `manageable`：`principalCanManageScope`

## 响应

```json
{
  "files": [],
  "crons": [],
  "deployments": [],
  "skills": [],
  "manageable": true
}
```

| 字段 | 说明 |
|---|---|
| `files` | `[{ id, ownerScopeId, name, mimetype, sizeBytes, direction, createdAt, openable }]` |
| `crons` | `[{ id, title, schedule, enabled, ... }]` |
| `deployments` | `[{ id, name, status, permission, currentVersion }]` |
| `skills` | `[{ id, name, description, status }]` |
| `manageable` | 当前用户能否管理该 scope |

## 注意

- 实测新项目（创建者视角）返回 `manageable: true`，资源列表为空。
- 权限失败返回 404 而非 403，符合"不可见即不存在"的统一策略。
