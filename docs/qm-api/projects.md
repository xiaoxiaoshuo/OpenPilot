# POST /api/projects

创建项目（生成 `group:web-project-<uuid>` scope）。属主成为唯一初始成员。

## 请求

```
POST /api/projects
Content-Type: application/json
Origin: http://127.0.0.1:8097        ← 必须！否则 403 cross-origin

{ "name": "2121121" }
```

⚠️ **同源校验**：portal 对非 GET/HEAD 请求检查 `Origin`（或 `Sec-Fetch-Site: same-origin`）。浏览器自动带；curl 测试必须手加 `-H 'Origin: http://127.0.0.1:8097'`，否则 `403 {"error":"forbidden","message":"cross-origin request refused"}`。

## 链路

```
浏览器 → Portal（同源校验）→ Web UI:8096 (index.ts:841)
       → Core /v1/projects (projects.ts:22, auth:either)
       → app.createProject (app-sessions.ts:253)
       → projects.create → Postgres + 审计 project.create
```

## 关键校验：capabilityPrincipal（projects.ts:5）

```ts
function capabilityPrincipal(ctx, requested) {
  if (!ctx.capability) return requested;                    // 无签名身份：允许不安全模式传 principalId
  if (requested && requested !== ctx.capability.actorId) { // 有签名身份：伪造他人 → 404
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  return ctx.capability.actorId;                            // 强制为签名身份
}
```

**有签名身份时 body 里的 `principalId` 必须等于签名 actor，否则 404 拒绝伪造**；不传则用签名身份。

## 响应

```json
// 201 创建成功
{
  "project": {
    "id": "120078e7-cc6e-41f6-b563-c865982b89c7",
    "name": "2121121",
    "orgId": "local",
    "ownerId": "171232349@qq.com",
    "createdAt": 1786467114470,
    "memberIds": ["171232349@qq.com"],
    "updatedAt": 1786467114470,
    "scopeId": "group:web-project-120078e7-cc6e-41f6-b563-c865982b89c7",
    "members": [{ "principalId": "171232349@qq.com", "displayName": "171232349@qq.com" }]
  }
}
```

失败：`400`（缺 principalId/name）、`403 forbidden`（非 internal）、`404 not_found`（伪造 principalId）。

## 同前缀子路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/projects` | GET | 项目列表（`/v1/projects?principalId=`） |
| `/api/projects/:id` | PATCH | 重命名 |
| `/api/projects/:id/members` | POST | 加成员（必须 internal directory 成员，不能是属主） |
| `/api/projects/:id/members/:memberId` | DELETE | 移除成员 |

## 项目 scope 命名

```
group:web-project-<uuid>
```

`PROJECT_GROUP_PREFIX = "web-project-"`（project-store.ts:9）。`isProjectGroupRef`/`projectIdFromGroupRef` 用它识别项目 scope。
