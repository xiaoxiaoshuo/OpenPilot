# OpenPilot Chat — API 文档

本文档描述 OpenPilot 实际对外提供的 HTTP API（与代码实现一致）。三层服务：

| 端口 | 服务 | 角色 |
|---|---|---|
| `8200` | gateway | 浏览器唯一入口：登录、Session、反代 |
| `8202` | web-ui | 前端静态托管 + `/api` 服务端代理（组装/转发到 core） |
| `8203` | core | 业务 API（`/v1/*`，仅内网，由 web-ui/gateway 转发调用） |

## 请求链路

```text
Browser
  └─> gateway :8200
       ├─ 会话校验（gateway_session 签名 Cookie，未登录 302 /auth/login 或 401）
       └─ 注入签名身份头 x-portal-identity → web-ui :8202
            └─ web-ui 转发（透传身份）→ core :8203  /v1/*
```

## 认证

- 登录走 OIDC：`/auth/login` 发起 → IdP（GitHub / Google / Demo）→ `/auth/callback` 完成，签发 `gateway_session` Cookie。
- gateway 用 `PORTAL_IDENTITY_SECRET` 为已登录用户 mint `x-portal-identity` 头；web-ui 与 core 各自用同一密钥校验。
- 数据隔离：所有会话/项目查询以身份中的 `principal`（邮箱小写）为基准解析可访问 scope，越权统一 `404`（不泄露存在性）。

通用返回：

```json
// 未登录
401 { "error": "sign in", "mode": "portal" }
// 越权/不存在
404 { "error": "not_found" }
// 参数错误
400 { "error": "bad_request", "message": "..." }
```

---

## 一、网关端点（gateway :8200）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查，返回 `{ "ok": true, "service": "gateway" }` |
| GET | `/auth/login?provider=&returnTo=&lang=&theme=` | 登录页；`provider ∈ {github, google, demo}` 时发起 OIDC 跳转 |
| GET | `/auth/callback` | OIDC 回调，换 token 后签发会话 Cookie 并跳回 `returnTo` |
| GET | `/auth/logout?returnTo=` | 清除会话 Cookie 并跳转 |
| GET | `/me` | 当前用户：`{ user, org, mode, name?, ... }` |
| `/idp/*` | 任意 | 反代到 IdP（去掉 `/idp` 前缀） |

---

## 二、Web UI `/api` 端点（web-ui :8202）

### 会话与标签

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions` | 当前用户会话列表（含 `tags`、实时状态） |
| GET | `/api/contexts` | 按 scope 分组的会话列表（侧边栏：个人 + 群组） |
| GET | `/api/sessions/:id` | 会话详情 + 转写（支持 `tailTurns` / `sinceSeq` / `beforeSeq` 分页窗口） |
| POST | `/api/sessions/:id` | 更新会话元数据：`title` / `archived` / `pinned` / `color` / **`tags`** |
| POST | `/api/sessions/:id/title` | 重命名会话标题 |
| POST | `/api/sessions/:id/fork` | 从会话 fork 出分支（可选 `upToSeq`） |
| DELETE | `/api/sessions/:id` | 永久删除会话 |
| GET | `/api/sessions/:id/entries/:seq` | 取单条消息条目 |
| GET | `/api/sessions/:id/approvals` | 会话审批列表 |

会话对象主要字段：`id`、`type`（`dm`/`group`）、`scopeId`、`threadRef`、`title`、`createdAt`、`lastActivityAt`、`messages`、`turns`、`tags: string[]`、`archived`、`pinned`、`color`。

**标签更新示例**：

```json
POST /api/sessions/<id>
{ "tags": ["工作", "待跟进", "工作"] }
```

→ core 内部去重为 `["工作","待跟进"]`，上限 20 个，过滤空串。

### 发消息 / run 生命周期

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/turn` | 发送消息（新会话/续聊/审批/附件/群组 scope） |
| GET | `/api/runs/active?threadRef=` | 查找线程上活跃的 run |
| GET | `/api/runs/:id` | run 详情（status / partial / activity 等） |
| GET | `/api/runs/:id/events` | **SSE**：run 流式事件（`partial` / `activity` / `done` / `stale`） |
| POST | `/api/runs/:id/signal` | 运行时控制：`{ "kind": "abort" }` 或 `{ "kind": "steer", "text": "..." }` |
| GET | `/api/deliveries/events` | **SSE**：会话投递通知（新消息/partial/机器人消息） |

`POST /api/turn` 请求体（主要字段）：

```json
{
  "text": "你好",
  "threadRef": "web:<principal>:<id>",
  "scopeId": "personal:<principal> 或 group:web-project-<id>",
  "model": "deepseek-chat",
  "attachments": [],
  "approval": null
}
```

响应（异步）：

```json
{ "status": "queued", "runId": "...", "sessionId": "...", "threadRef": "..." }
```

### 项目（群组）与机器人

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects` | 我参与的项目列表 |
| POST | `/api/projects` | 创建项目（即群组 scope），body `{ "name": "..." }` |
| PATCH | `/api/projects/:id` | 重命名项目（`{ "name": "..." }`） |
| POST | `/api/projects/:id/members` | 添加成员 `{ "memberId": "user@example.com" }` |
| DELETE | `/api/projects/:id/members/:memberId` | 移除成员 |
| GET | `/api/bot-profiles` | 可用机器人预设列表 |
| GET | `/api/projects/:id/bots` | 群组机器人配置（`config` + `profiles`） |
| PATCH | `/api/projects/:id/bots` | 修改群组机器人：`primaryName`、`attached: [{botId, enabled}]`（仅 owner） |

### 配置 / 策略 / 资源

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/contexts/:scope/ambient-policy` | 读取群组/频道 ambient 策略 |
| PUT | `/api/contexts/:scope/ambient-policy` | 更新策略（`orders` / `bots` / `ambientEnabled` / `baseUpdatedAt`） |
| GET | `/api/runtime-config?scopeId=` | 运行时配置（harness / model） |
| PUT | `/api/runtime-config` | 更新运行时配置 |
| GET | `/api/scope-resources?scope=` | scope 资源聚合（files / crons / skills / deployments） |
| GET | `/api/directory/resolve?q=` | 成员搜索 |
| GET | `/api/surface-config` | 品牌/表面配置 |
| GET | `/api/memory` / PUT `/api/memory` | 读取/写入记忆 |
| GET | `/api/memory/history` | 记忆历史版本 |

---

## 三、Core `/v1` 端点（core :8203，内部契约）

Web UI 的 `/api/*` 最终转发到这些 `/v1/*` 端点。核心列表：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查 |
| GET | `/v1/surface-config` | 品牌/表面配置 |
| GET | `/v1/sessions?scope=` | 会话列表（支持 scope 过滤） |
| GET | `/v1/contexts` | 按 scope 分组的上下文 |
| GET | `/v1/sessions/:id` | 会话详情 + 转写窗口 |
| PATCH | `/v1/sessions/:id` | 更新 `title/archived/pinned/color/tags` |
| POST | `/v1/sessions/:id` | 更新语义（无子路由时同 PATCH；`/title`、`/fork`、`/background` 子路由） |
| DELETE | `/v1/sessions/:id` | 删除会话 |
| GET | `/v1/sessions/:id/entries/:seq` | 单条消息 |
| GET | `/v1/sessions/:id/approvals` | 审批 |
| POST | `/v1/turns?async=1` | 发消息（核心入口，触发 AI run） |
| GET | `/v1/runs?threadRef=` | 线程活跃 run |
| GET | `/v1/runs/:id` | run 详情 |
| POST | `/v1/runs/:id/signal` | abort / steer |
| GET | `/v1/bot-profiles` | 机器人预设 |
| GET | `/v1/projects` / POST `/v1/projects` | 项目列表 / 创建 |
| PATCH | `/v1/projects/:id` | 重命名 |
| POST | `/v1/projects/:id/members` | 加成员 |
| DELETE | `/v1/projects/:id/members/:memberId` | 移除成员 |
| GET | `/v1/projects/:id/bots` / PATCH 同 | 群组机器人配置 |
| GET | `/v1/scope-resources?scope=` | scope 资源聚合 |
| GET | `/v1/contexts/policy` / PUT 同 | ambient 策略 |
| GET | `/v1/runtime-config` / PUT 同 | 运行时配置 |
| GET | `/v1/directory/resolve?q=` | 成员搜索 |
| GET | `/v1/directory/meta` | 目录元信息 |
| GET | `/v1/memory` / PUT `/v1/memory` | 记忆 |
| GET | `/v1/memory/history` | 记忆历史 |
| GET | `/v1/files` / GET `/v1/files/:id/content` | 文件列表 / 内容 |
| GET | `/v1/session-state/events` | **SSE**：会话状态推送 |
| POST | `/v1/session-cap` | 会话能力声明 |
| GET | `/v1/deliveries` | 投递队列 |
| POST | `/v1/deliveries/:id/ack` | 投递确认 |

兼容桩（返回空列表/固定值，供前端不报错）：`/v1/skills*`、`/v1/crons*`、`/v1/keychain*`、`/v1/approvals*`、`/v1/connectors*`、`/v1/deployments*`、`/v1/admin/whoami`。

---

## 四、SSE 事件

| 端点 | 事件 | 载荷 |
|---|---|---|
| `GET /api/runs/:id/events` | `partial` | `{ partial: "累计文本" }` |
| | `activity` | `{ activity: [...], startedAt }` |
| | `done` | `{ status, result, partial, ... }` |
| | `stale` / `alive` | 心跳与陈旧状态 |
| `GET /api/deliveries/events` | `delivery` | `{ threadRef, partial?, source?, entrySeq? }` |
| `GET /v1/session-state/events` | `session_state` | `{ threadRef, sessionId, state, at }` |

---

## 五、错误与安全

- **越权即 404**：对不可见资源统一返回 `404`，不区分「不存在」与「无权限」。
- **输入验证**：正文大小受限（web-ui 侧 1MB 上限），JSON 解析失败返回 `400`。
- **XSS 防护**：前端渲染走 DOMPurify 消毒；服务端对静态内容加 `x-content-type-options: nosniff`、`x-frame-options: DENY`。
- **认证边界**：gateway 只对非静态资源强制登录；静态资源（`/assets/*`、`*.js`、`*.css`）放行，与登录页正常加载一致。
