# QM Web UI 接口文档

QM（`yc-software/qm`）Web UI 面向前端的 HTTP API 接口说明。

## 请求链路

所有接口走同一条链路，浏览器只访问 Portal：

```
浏览器
  └─> Portal :8097
       ├─ 会话校验（portal_session 签名 Cookie，未登录 401 {"error":"sign in"} 或 302 /auth/login）
       ├─ 同源校验（非 GET/HEAD 必须带 Origin: http://127.0.0.1:8097，否则 403 cross-origin）
       └─ 注入签名身份头（PORTAL_IDENTITY_HEADER）转发到 Web UI
            └─> Web UI :8096  (透传/校验/组装，coreFetch)
                 └─> Core :8080  (/v1/* 路由，auth: source|either)
                      └─> Postgres / 各类 store
```

| 端口 | 组件 | 角色 |
|---|---|---|
| 8097 | Portal | 唯一浏览器入口：登录、Session、反向代理 |
| 8096 | Web UI | 普通用户界面服务端：API 组装、SSE、上传 |
| 8090 | Admin | 管理界面 |
| 8099 | Auth | 内置 OIDC 邮箱登录 |
| 8080 | Core | 身份/权限/Agent 调度/持久化 |

## 认证

- **来源认证**：Portal 用 `portal_session`（JWT）验证浏览器身份，向 Web UI 转发时注入签名身份头（`PORTAL_IDENTITY_HEADER`），Web UI 再用 `CORE_SIGNING_SECRET` 对 Core 签名。
- Core 路由的 `auth` 标记：
  - `source`：必须签名来源身份
  - `either`：签名来源或配置的不安全身份皆可（本地 dev）
- 权限模型：`identity.classify` 把**所有未停用 principal 视为 internal**（宽松），directory 表不参与权限判定。

## 接口索引

| # | 接口 | 方法 | 作用 | 文档 |
|---|---|---|---|---|
| 1 | `/api/sessions` | GET | 当前用户会话列表（含实时状态） | [sessions.md](./sessions.md) |
| 2 | `/api/contexts` | GET | 按 scope 分组的会话列表（侧边栏） | [contexts.md](./contexts.md) |
| 3 | `/api/turn` | POST | 发消息（新消息/续聊/审批/附件） | [turn.md](./turn.md) |
| 4 | `/api/runs/:id/events` | GET (SSE) | run 流式事件（partial/activity/done） | [run-events.md](./run-events.md) |
| 5 | `/api/sessions/:id` | GET | 会话详情 + 转写（分页窗口） | [session-detail.md](./session-detail.md) |
| 6 | `/api/runs/active?threadRef=` | GET | 找回线程上活跃的 run | [run-active.md](./run-active.md) |
| 7 | `/api/runs/:id/signal` | POST | 运行时控制（abort/steer） | [run-signal.md](./run-signal.md) |
| 8 | `/api/projects` | POST | 创建项目（group scope） | [projects.md](./projects.md) |
| 9 | `/api/scope-resources?scope=` | GET | scope 资源聚合（files/crons/...） | [scope-resources.md](./scope-resources.md) |
| 10 | `/api/contexts/:scope/ambient-policy` | GET/PUT | ambient 策略（standing order） | [ambient-policy.md](./ambient-policy.md) |
| 11 | `/api/runtime-config?scopeId=` | GET | 运行时配置（harness/model） | [runtime-config.md](./runtime-config.md) |
| 12 | `/api/directory/resolve?q=` | GET | 成员搜索 | [directory-resolve.md](./directory-resolve.md) |

## 常见返回

```json
// 未登录
401 { "error": "sign in" }
// 跨域（缺 Origin 的非 GET 请求）
403 { "error": "forbidden", "message": "cross-origin request refused" }
// 权限不足
403 { "status": "refused", "reason": "..." }
// 不存在（对不可见资源统一 404，不泄露存在性）
404 { "error": "not_found" }
```

## 核心设计原则

- **持久化优先**：run、signal、session 全部落 Postgres；`working`/`alive` 等瞬时状态由各 store 实时计算。
- **SSE 是轮询式**：Web UI 定时拉 Core，按增量发事件，浏览器断开不丢 run，重连可恢复现场。
- **会话可见性**：`sessionsForViewer` → `listByParticipant` SQL（participants 表 + 参与者时间窗口过滤）。
