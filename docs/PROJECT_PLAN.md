# OpenPilot Chat —— 项目规划文档

> 版本：v0.1（草稿）
> 状态：规划中
> 本文档为项目级规划，涵盖目标、架构、里程碑、数据模型、API、安全、AI 集成、测试与部署，是开发实施的依据。

---

## 1. 项目概述

### 1.1 定位

OpenPilot Chat 是一个**简化版在线聊天应用**，核心能力：

- 多用户注册 / 登录，会话与数据按用户严格隔离
- 个人对话管理（标签 / 分类，便于整理检索）
- AI 自动回复（接入 LLM，如 DeepSeek）
- 群组对话：多人 + 多机器人共同参与

### 1.2 目标（Goals）

| 编号 | 目标 |
|---|---|
| G1 | 用户可注册登录，通过 OIDC 获得安全、可续期的会话 |
| G2 | 个人会话支持标签与分类，消息可持久化、可检索 |
| G3 | AI 机器人可自动回复，回复过程稳定（幂等、重试、队列化） |
| G4 | 群组对话支持多人 + 多机器人并发参与 |
| G5 | 用户数据、会话、消息按 Scope 严格隔离，互不可见 |
| G6 | 提供服务端渲染管理台，便于运维与配置管理 |

### 1.3 非目标（Non-Goals，本期不做）

- 不做实时视频 / 语音通话
- 不做移动端原生 App（Web 优先，移动浏览器可用即可）
- 不做端到端加密（本期以传输层 TLS + 服务端隔离为准）
- 不做分布式多机房部署（单机可水平扩展为多实例即可）

### 1.4 成功指标

- 注册登录流程端到端可用（含邮件验证码）
- 消息发送 → 持久化 → AI 回复全链路延迟可控（AI 首字 < 3s，受 LLM 影响）
- 数据隔离测试覆盖所有多租户查询路径
- 任务队列：失败任务可重试，不丢消息、不重复投递（幂等）

---

## 2. 总体架构

### 2.1 服务拓扑

```text
Browser
  │
  ▼
Portal :8097（网关 / OIDC Client / 统一入口）
  │
  ├──► Web UI :8096（Lit 前端静态资源 + 服务端代理 /api）
  ├──► Admin :8090（服务端渲染管理台，裸 HTML）
  └──► Core :8080（Fastify 5 主 API，业务逻辑唯一入口）
          │
          ├──► PostgreSQL（users/sessions/conversations/messages/配置）
          ├──► 本地文件存储 data/docstore/files/<sha256>
          ├──► DeepSeek（AI 回复，OpenAI 兼容协议）
          └──► pg-boss（任务队列：AI 回复、异步任务）
```

### 2.2 分层职责

| 层 | 服务 | 职责 | 技术 |
|---|---|---|---|
| 入口 | Portal | 网关转发、OIDC Client 认证流程、会话管理 | `node:http` 手写路由 |
| 前端 | Web UI | 页面渲染、WebSocket/轮询消息、与 Core 通信 | Lit 3 + Vite 5 |
| 管理台 | Admin | 服务端渲染管理页面（用户/配置/任务监控） | `node:http` + 裸 HTML |
| 业务 | Core | 所有业务 API：认证、对话、消息、AI、文件 | Fastify 5 + `pg` |
| 存储 | PostgreSQL | 唯一持久化真相源 | Aiven 云 PG / 本地 PG |
| 任务 | pg-boss | 异步任务队列（AI 回复、重试） | pg-boss |
| AI | DeepSeek | LLM 自动回复 | OpenAI 兼容 API |

### 2.3 关键设计原则

1. **后端分层**：Fastify（Core 业务）+ 原生 `node:http`（网关 / 管理台 / OIDC IdP），边界清晰、互不耦合。
2. **无 ORM**：`pg` 官方驱动 + 手写 SQL + `jsonb` 通用表，SQL 显式可控，避免 ORM 生成劣化查询。
3. **前端组件化**：Lit Web Components，不用 React/Vue；组件自包含、可复用、无框架锁定。
4. **少依赖**：能用手写/原生实现的不引第三方库（如网关反代、管理台渲染）。
5. **数据隔离优先**：所有查询强制带 Scope 条件，不允许出现跨用户裸查询。
6. **可靠性内置**：任务队列化 + 幂等键 + 重试，AI 调用的不稳定被隔离在任务层。

---

## 3. 里程碑规划

采用分阶段交付，每阶段有明确验收标准。

### Phase 0 —— 工程骨架（约 1 周）

**目标**：可运行的空壳服务 + 统一构建/测试/代码规范。

- [ ] 仓库结构：`apps/`（portal / web / admin / core）、`packages/`（共享类型、配置）
- [ ] TypeScript 5 + esbuild / Vite 5 构建打通
- [ ] 四个服务端口可启动，Portal 可转发到 Core
- [ ] oxlint / eslint / prettier / knip 接入 CI
- [ ] Node 内置 test runner + jsdom 测试骨架

**验收**：`pnpm dev` 一键起全部服务，健康检查 `/healthz` 全绿。

### Phase 1 —— 认证与用户系统（约 2 周）

**目标**：注册 / 登录 / 会话 / 登出闭环，OIDC 打通。

- [ ] `users` 表 + 密码哈希（argon2/bcrypt）
- [ ] 邮件验证码登录（Resend API / 自实现 SMTP 二选一，可配置）
- [ ] OIDC Client（Portal 侧）+ 内置 auth broker（IdP，jose 签发 JWT/JWK）
- [ ] Session cookie + `sessions` 表，支持续期与吊销
- [ ] 用户资料（昵称、头像）

**验收**：新用户注册 → 邮件收码 → 登录 → 刷新保持会话 → 登出 → 会话失效；多用户互不可见彼此数据。

### Phase 2 —— 对话与消息核心（约 2 周）

**目标**：个人对话 CRUD、消息收发、标签分类。

- [ ] `conversations` / `messages` 表 + 分页查询
- [ ] 对话创建、重命名、归档、删除（软删）
- [ ] 消息发送、历史加载（游标分页）、编辑/撤回（可选）
- [ ] 标签与分类：标签 CRUD、对话打标、按标签过滤
- [ ] 消息实时性：WebSocket 或 SSE（本期可先轮询，预留协议）
- [ ] 文件上传：本地 docstore 存储 + `files` 元数据表，sha256 去重

**验收**：两个用户分别建对话互不干扰；标签过滤正确；消息分页无重复无遗漏。

### Phase 3 —— AI 自动回复与群组对话（约 3 周）

**目标**：AI 机器人入群、自动回复、任务队列稳定。

- [ ] `bots` / `conversation_participants` 表（用户 + 机器人统一参与方模型）
- [ ] AI 回复任务入 pg-boss：消息落库 → 入队 → 消费 → 调 LLM → 回复落库
- [ ] 幂等：以 `(conversation_id, trigger_message_id)` 去重，防重复回复
- [ ] 重试：LLM 超时/限流退避重试，指数退避 + 最大次数
- [ ] 机器人配置：系统提示词、模型、是否自动回复、冷却时间
- [ ] 群组对话：多人 + 多机器人同时参与，AI 回复标记为对应机器人
- [ ] 流式输出（可选增强）：SSE 逐字返回 AI 回复

**验收**：群组中 3 人 + 2 机器人对话稳定；LLM 故障时任务不丢，恢复后补执行；无重复回复。

### Phase 4 —— 管理台与运维完善（约 2 周）

**目标**：管理台可用、可观测、可部署。

- [ ] Admin :8090 服务端渲染：用户列表/禁用、配置管理、任务队列监控、消息审计
- [ ] 配置中心：`durable-map`（id + jsonb 通用表）承载运行期配置
- [ ] 日志：结构化日志 + 请求 ID 贯穿全链路
- [ ] 指标：请求数、延迟、队列深度、LLM 错误率
- [ ] 部署：Dockerfile + compose（core/web/portal/admin/pg），环境变量化配置
- [ ] S3 可选存储：`@aws-sdk/client-s3` 切换（本地 docstore 为默认）

**验收**：管理台可禁用违规用户；一键 compose 部署；重启后配置与任务不丢。

---

## 4. 数据模型设计

> 约定：所有表带 `id`（uuid）、`created_at`、`updated_at`；多租户表带 `scope` 字段（用户维度隔离）；索引前缀 `idx_`。

### 4.1 核心表

| 表 | 字段要点 | 说明 |
|---|---|---|
| `users` | email 唯一、password_hash、nickname、avatar_url、status、role | 用户账户；role: user/admin |
| `sessions` | user_id、token_hash、expires_at、revoked_at、ip、user_agent | 会话；存哈希不存明文 |
| `conversations` | owner_scope、title、type(personal/group)、archived_at、tag_ids | 对话；type 区分个人/群组 |
| `conversation_participants` | conversation_id、participant_type(user/bot)、participant_id、role、joined_at | 参与方统一模型 |
| `messages` | conversation_id、sender_type、sender_id、content、content_type、reply_to_id、created_at | 消息；reply_to 支持引用回复 |
| `tags` | owner_scope、name、color | 标签；个人维度 |
| `bots` | owner_scope、name、avatar、system_prompt、model、auto_reply、cooldown_seconds | AI 机器人配置 |
| `files` | owner_scope、sha256、size、mime、storage(local/s3)、path | 文件元数据；内容按 sha256 去重 |
| `job_events`（可选） | job_id、status、attempts、last_error | 任务执行审计 |

### 4.2 durable-map 配置表

```text
configs (durable-map)
  id         text primary key   -- 配置键
  value      jsonb              -- 配置值（任意 JSON）
  updated_at timestamptz
```

用途：站点配置、LLM 参数、功能开关（feature flags）、邮箱服务配置等，全部走此通用表，避免为每个配置项建表。

### 4.3 数据隔离（Scope）规则

- 个人资源（会话、消息、标签、文件）查询**必须**带 `WHERE scope = $user_id`（或经 participants 关联校验）
- 群组资源校验：先查 `conversation_participants` 确认请求者/机器人是参与方，再放行
- 所有多租户查询在 Core 层统一封装为 `scoped()` SQL 辅助函数，杜绝手写裸查询漏条件

### 4.4 消息分页

- 采用**游标分页**：`WHERE conversation_id=$1 AND id < $cursor ORDER BY id DESC LIMIT $n`，避免深分页 offset 性能问题
- 索引：`(conversation_id, id desc)` 复合索引

---

## 5. 后端 API 设计（Core :8080）

统一前缀 `/api/v1`，JSON 进出，错误格式 `{ error: { code, message } }`。

| 模块 | 路由 | 说明 |
|---|---|---|
| 认证 | `POST /auth/email-code`、`POST /auth/login`、`POST /auth/logout`、`GET /auth/me` | 邮件验证码 + 会话 |
| 用户 | `GET/PATCH /users/me` | 资料 |
| 对话 | `GET/POST /conversations`、`GET/PATCH/DELETE /conversations/:id` | CRUD |
| 参与方 | `GET/POST/DELETE /conversations/:id/participants` | 加人/加机器人 |
| 消息 | `GET /conversations/:id/messages?cursor=&limit=`、`POST /conversations/:id/messages` | 拉取/发送 |
| 标签 | `GET/POST /tags`、`PATCH/DELETE /tags/:id`、`POST /conversations/:id/tags` | 标签管理 |
| 机器人 | `GET/POST /bots`、`PATCH/DELETE /bots/:id` | 机器人配置 |
| 文件 | `POST /files`（multipart）、`GET /files/:id` | 上传/下载 |
| 管理 | `GET /admin/users`、`PATCH /admin/users/:id/status`、`GET /admin/jobs` | Admin 专用（role=admin） |

### 关键实现约定

- 所有路由经 `authMiddleware`（校验 session + 注入 scope）
- 写操作走事务（`BEGIN/COMMIT`），读操作走只读连接
- 请求 ID 中间件：`x-request-id` 贯穿日志与任务
- zod/typebox 校验入参，错误响应 400/401/403/404/429 语义明确

---

## 6. 认证与安全设计

### 6.1 OIDC 流程（Portal 为 Client，内置 broker 为 IdP）

```text
Browser ──► Portal (OIDC Client)
   │           │
   │           └─► /oidc/authorize ──► auth broker (IdP, node:http + jose)
   │                                      │ 签发 JWT（RS256, JWK 管理）
   │ ◄── 授权码 ───────────────────────────┘
   └──► Portal 用授权码换 token（校验 id_token 签名）→ 建立 session cookie
```

- 密钥：JWK 私钥本地生成，公钥通过 `/.well-known/jwks.json` 暴露
- token：短时 access token + 长时 refresh（或直接以 session cookie 为准，本期简单化）
- 邮件验证码：6 位、5 分钟有效、单次使用、失败限流（每邮箱每小时 5 次）

### 6.2 会话安全

- session cookie：`HttpOnly` + `Secure` + `SameSite=Lax` + 合理过期（默认 7 天）
- `sessions` 表存 token 的 sha256 哈希，泄漏 DB 不泄漏会话
- 登出/禁用即吊销；密码修改强制吊销全部会话
- CSRF：SameSite 为主 + 敏感写操作校验 `Origin` 头

### 6.3 其他

- 密码：argon2id（不存明文、不存 md5/sha1）
- 输入校验：zod 全量校验；消息内容存储前转义，渲染端 DOMPurify 消毒（防 XSS）
- 限流：登录/发码/发消息按用户/IP 限流（429）
- 审计：admin 操作写审计日志

---

## 7. AI 集成设计

### 7.1 调用链

```text
用户发送消息 ──► messages 表落库
       └──► pg-boss 入队（job: ai_reply）
                 └──► 消费者：读取 bot 配置（system_prompt/model）
                       └──► DeepSeek API（OpenAI 兼容，fetch 调用）
                             └──► 回复落库（sender_type=bot, sender_id=bot_id）
```

### 7.2 可靠性策略

| 策略 | 实现 |
|---|---|
| 幂等 | 任务负载带 `trigger_message_id`；消费前查 `job_events` 去重；DB 唯一约束兜底 |
| 重试 | 指数退避（1s → 2s → 4s … 上限 5 次），区分可重试错误（超时/429/5xx）与不可重试（4xx 参数错误） |
| 超时 | LLM 请求超时 60s；首字超时 10s 走 SSE 时单独处理 |
| 冷却 | 机器人 `cooldown_seconds` 防止刷屏；队列消费速率限制 |
| 降级 | LLM 不可用时任务保持 pending，恢复后继续；管理台可见队列深度 |

### 7.3 机器人模型抽象

- Provider 抽象层：`LLMProvider` 接口（`chat(prompt, opts)`），默认 DeepSeek 实现，预留 Claude/OpenAI Codex/MCP SDK 接入
- 本地 harness：`@earendil-works/pi-coding-agent` 作为增强工具链（可选）
- 上下文组装：机器人系统提示词 + 最近 N 条群组消息 + 被回复消息，按 token 预算截断

---

## 8. 前端设计（Web UI :8096）

### 8.1 技术栈

- Lit 3 Web Components + `@mariozechner/mini-lit` 轻量组件
- `dockview-core` 分屏布局（对话列表 | 消息区 | 详情面板）
- `marked` + DOMPurify + highlight.js + KaTeX 渲染 Markdown
- `lucide` 图标、`date-fns` 时间处理
- Vite 5 + esbuild 0.19 构建

### 8.2 页面 / 组件树

```text
<app-shell>
 ├─ <sidebar>            对话列表、标签过滤、新建对话
 ├─ <chat-pane>
 │   ├─ <message-list>  消息流（虚拟滚动，游标加载更多）
 │   ├─ <message-item>  Markdown 渲染、引用、发送者头像
 │   └─ <composer>      输入框、发送、@提及机器人、附件
 └─ <detail-panel>      对话信息、参与方管理、标签管理（dockview 可折叠）
```

### 8.3 状态与实时

- 本地状态：会话 token 存内存 + cookie；组件间用事件/轻量 store
- 消息实时：优先 WebSocket（Core 扩展），回退 SSE，再回退轮询（30s）——本期实现顺序：轮询 → SSE
- 分屏布局状态持久化到 localStorage

### 8.4 管理台（Admin :8090）

- 服务端渲染裸 HTML，无前端框架（Node 原生 http + 模板字符串/轻量模板）
- 页面：用户管理、配置管理、任务队列监控、消息审计
- 权限：仅 role=admin 可访问，经 Portal 网关校验

---

## 9. 测试策略

| 层 | 工具 | 覆盖重点 |
|---|---|---|
| 单元测试 | Node 内置 test runner | 工具函数、SQL 拼接、校验规则 |
| 组件测试 | jsdom + Lit | Web Components 渲染与交互 |
| 集成测试 | 测试库 + 本地 PG（test db） | API 全流程：认证→建对话→发消息→AI 回复 |
| 隔离测试 | 集成内专项 | 双用户数据互不可见（每个多租户查询必测） |
| 队列测试 | pg-boss 直测 | 幂等、重试、并发消费、失败恢复 |
| E2E（可选） | Playwright | 注册→登录→聊天→群组主流程 |

- CI：lint + typecheck + unit + integration 全绿才可合并
- 覆盖率目标：Core 业务模块 ≥ 80%

---

## 10. 部署与运维

### 10.1 部署形态

- 单机 Docker Compose：`portal` / `web` / `admin` / `core` / `postgres` 五容器
- PostgreSQL 支持 Aiven 云 PG（现成，sslmode 注意 `verify-full` 问题）或本地实例
- 环境变量配置：`DATABASE_URL`、`OIDC_JWK`、`DEEPSEEK_API_KEY`、`RESEND_API_KEY`、`PORT_*`

### 10.2 可观测性

- 结构化日志（pino 或自实现），带 `request_id` / `scope` / `job_id`
- 指标：HTTP 延迟/错误率、队列深度、LLM 调用延迟与错误率
- 健康检查：`/healthz`（含 DB 连通性探测）

### 10.3 数据与备份

- 文件存储默认本地 `data/docstore/files/<sha256>`，可切 S3
- PG 每日备份 + 恢复演练（本期文档化，管理台可选实现）

---

## 11. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| LLM API 不稳定/限流 | AI 回复失败或延迟 | 队列 + 退避重试 + 降级提示；Provider 抽象可切换 |
| 手写 SQL 引入多租户泄漏 | 数据隔离被突破 | 统一 `scoped()` 封装 + 隔离专项测试 + 代码评审检查单 |
| 自实现 OIDC/会话安全漏洞 | 认证被绕过 | 用成熟库 jose 处理加密原语；安全清单逐项核对 |
| 原生 http 手写路由复杂度 | 维护成本上升 | 仅网关/管理台使用，Core 业务全走 Fastify |
| 前端无框架组件膨胀 | 状态管理混乱 | 组件职责单一化，store 保持最小化 |
| 队列任务堆积 | 回复延迟 | 消费速率监控、冷却控制、管理台告警 |

---

## 12. 任务拆解（下一步行动）

1. Phase 0 工程骨架（目录结构、构建、四个服务跑通）
2. users + sessions 表与注册登录接口
3. 邮件验证码服务（Resend / SMTP 可切换）
4. OIDC Client + auth broker（jose JWT/JWK）
5. 对话 / 消息 / 标签 API 与表
6. 前端骨架（sidebar + chat-pane + composer）
7. pg-boss 接入 + AI 回复任务
8. DeepSeek Provider 实现
9. 群组参与方模型 + 机器人配置
10. Admin 管理台
11. Docker compose 部署 + 可观测性
12. 数据隔离与安全专项测试

---

*本规划随开发迭代更新；各 Phase 完成时回填实际实现差异。*
