# OpenPilot Chat

> 简化版在线聊天应用 · 多用户认证 · 对话管理 · AI 自动回复 · 群组对话

**🌐 在线演示**：<http://openpilot.lijingang.ccwu.cc:8200>

**🎬 演示录制**：https://meeting.tencent.com/crm/KPXnz4DWfe

## 项目简介

OpenPilot Chat 是一个多用户在线聊天应用：支持用户认证、个人对话（含**标签/分类**）、AI 自动回复，以及**多人与多机器人**参与的群组对话。项目使用 Node + TypeScript 生态构建，注重后端健壮性、数据隔离与 AI 交互稳定性。

核心能力：

- **多用户认证**：OIDC（GitHub / Google / Demo），会话与数据按用户严格隔离
- **个人对话管理**：会话支持**标签（tags）**、归档、置顶、颜色，便于整理检索
- **AI 自动回复**：接入 DeepSeek（OpenAI 兼容协议），支持流式响应
- **群组对话**：多人 + 多机器人协作，含机器人交互规则、防循环与回复保障
- **数据隔离**：个人 / 群组 / 频道按 Scope 隔离，越权统一 404

---

## 测试用户（Demo 登录）

Demo 登录**无需密码**，任意邮箱即可进入（便于评审直接体验）：

| 用途 | 账号 |
|---|---|
| 测试用户 1 | `tester1@example.com` |
| 测试用户 2 | `tester2@example.com` |

> 打开演示地址 → 登录页选择 **Demo 登录** → 输入上述任一邮箱即可。两个账号可分别登录，用于验证「多人 + 多机器人」群组对话（创建项目后可互加成员）。

---

## 技术栈及版本

| 层 | 当前实现 | 版本 | 说明 |
|---|---|---|---|
| 运行时 | Node.js + TypeScript | Node 22.19.0 / TS 5 | 直接运行 `.ts`（Node 原生 type stripping） |
| 后端框架 | **Node 原生 `node:http` 手写路由** | — | 四个服务均零/少依赖；**Fastify 5 为目标演进（TODO）** |
| 认证 | OIDC（`jose`）+ Session Cookie | jose 6.x | 内置 IdP 对接 GitHub / Google OAuth + Demo 登录 |
| 数据存储 | **JSON 文件存储**（`core/data/db.json`，原子写入） | — | 当前实现；**PostgreSQL 为目标演进（TODO，schema 见 [docs/db/](./docs/db/)）** |
| 前端 | Lit 3 + Vite 5 + esbuild | Lit 3.3 / Vite 5 / esbuild 0.19 | Web Components，不用 React/Vue |
| AI Provider | DeepSeek（OpenAI 兼容协议） | `deepseek-chat` / `deepseek-reasoner` | 流式 `chat/completions` |
| 测试 | Node 内置 test runner + jsdom | — | 见各包 `test/` |



---

## 项目结构

```text
OpenPilot/
├── gateway/          # :8200 统一入口 / OIDC Client / 反代（node:http）
├── IdP/              # :8201 身份提供方（GitHub / Google / Demo，node:http + jose）
├── web-ui/           # :8202 Lit 前端 + 服务端代理 /api（node:http + Vite）
│   ├── server/       #   服务端：静态托管 + /api → core /v1 代理 + SSE
│   └── src/          #   前端：会话/群聊/标签/机器人等 Web Components
├── core/             # :8203 业务 API（会话/消息/AI/项目/机器人，node:http 零运行时依赖）
│   ├── chassis/      #   共享：http 工具、身份签名、branding
│   └── src/          #   会话存储、AI 调用、机器人编排
├── deploy/           # 部署文档 + pm2 配置 + wrapper 脚本
├── docs/             # API / 数据库 schema / 认证 / 群聊设计 / 项目计划
├── Dockerfile        # 单容器多服务镜像（含 .dockerignore / docker-entrypoint.sh）
└── README.md
```

端口分配：

| 端口 | 服务 | 说明 |
|---|---|---|
| `8200` | gateway | 统一入口 / OIDC Client / 反代 |
| `8201` | IdP | 身份提供方 |
| `8202` | web-ui | 前端 + `/api` 服务端代理 |
| `8203` | core | 业务 API（会话/消息/DeepSeek AI） |

---

## 快速开始（本地开发）

```bash
# 1) 根目录准备 .env（参考下方环境变量，或从 .env 示例复制）
# 2) 四个服务各开一个终端：

cd IdP      && npm install && npm run dev    # :8201
cd gateway  && npm install && npm run dev    # :8200
cd web-ui   && npm install && npm run serve  # :8202（或 npm run dev 走 Vite HMR）
cd core     && npm install && npm run dev    # :8203
```

浏览器访问 `http://127.0.0.1:8200`，使用 Demo 登录（任意邮箱）。

生产部署（腾讯云 CentOS 7 · pm2 · HTTP 8200 端口）见 **[deploy/DEPLOYMENT.md](./deploy/DEPLOYMENT.md)**；Docker 方式见根目录 `Dockerfile`。

---

## API 文档

完整的 RESTful API 端点列表、请求/响应说明、SSE 事件与认证方式，见：

- 📘 **[docs/API.md](./docs/API.md)** — 统一 API 文档（含 gateway / web-ui `/api` / core `/v1` 三层端点）

---

## 数据库设计

- **当前实现**：JSON 文件存储（`core/data/db.json`，原子写入，内存缓存）。
- **目标架构**：PostgreSQL + `pg`（手写 SQL，无 ORM）+ `pg-boss` 任务队列。

Schema 设计思路与字段/索引/约束说明见：

- [docs/db/sessions-table.md](./docs/db/sessions-table.md) — 会话表（scope 隔离、fork、索引）
- [docs/db/projects-table.md](./docs/db/projects-table.md) — 项目表（群组 scope 映射、成员权限、并发控制）
- [docs/db/durable-map-tables.md](./docs/db/durable-map-tables.md) — 通用 `id+jsonb` 配置表模式
- [docs/db/acl-grants-table.md](./docs/db/acl-grants-table.md) — 跨 scope 资源授权
- [docs/db/source-auth-replay-table.md](./docs/db/source-auth-replay-table.md) — 一次性凭证防重放

> 标签（tags）在 JSON 存储下设计为会话上的 `string[]`；迁移到 PostgreSQL 时可演化为「标签表 + GIN 索引」或「`jsonb` + GIN」，见下文「对话标签」设计思路。

---

## 核心设计思路与权衡

### 1. 对话标签（个人会话 tags）

**设计**：标签作为会话（session）上的一个字段 `tags: string[]`，与归档/置顶/颜色一样通过 `PATCH /v1/sessions/:id`（web-ui 侧 `POST /api/sessions/:id`）更新。

**关键约束**（core 内统一处理）：

- 去重：`patch.tags = [...new Set(tags)]`
- 上限：最多 20 个，单个 `trim()` 后非空才保留
- 筛选：前端对已加载会话做大小写不敏感的子串匹配（`tag.toLowerCase().includes(query)`）

**为什么这样选**：

- 当前数据层是 JSON 存储，标签随会话一起原子写入，**读多写少、标签数量少**，用数组字段零额外查询成本；
- 避免为低频标签维护一张关联表 + 级联删除的复杂度；
- 未来切 PostgreSQL：标签仍可先放 `jsonb` 列，若出现「按标签跨会话聚合/排序」需求，再升级为 `session_tags(session_id, tag)` 关联表 + `GIN` 倒排索引，接口无需变化（对前端仍是 `tags: string[]`）。

### 2. AI API 调用健壮性

针对「外部 DeepSeek API 不可靠」的分层处理（`core/src/ai.ts` + `core/src/index.ts`）：

- **流式解析容错**：逐行解析 SSE，跳过非 `data:` 行、`JSON.parse` 失败的行直接 `continue`，不因个别脏分片中断整段回复；
- **空内容校验**：非流式与流式都在收尾检查「无正文且无 tool_calls」，视为失败并抛错；
- **可中断**：所有流式调用透传 `AbortSignal`，用户 abort 时真正中断底层 fetch；
- **失败兜底**：`runAssistant` / `runBot` 捕获异常后，写入一条**可见的错误消息**（`⚠️ AI 回复失败：…`），并把 run 状态置为 `failed`，绝不静默丢失用户消息；
- **幂等/并发防护**：消息写入用会话级锁串行化，活跃 run 期间的新消息转 `steer` 信号而非并发二次调度。

### 3. 群组对话（机器人交互规则 / 防循环 / 确保回复）

**角色模型**：群组 = 项目（`group:web-project-<id>`），成员可启用预设机器人（客服/技术/幽默）+ 一个「群助手」主 agent。

**机器人交互规则**（`core/src/index.ts`）：

- 人类消息由**主 agent（协调者）**统一应答，主 agent 通过 `summon_bot` 工具按需召唤附加机器人；
- 每个附加机器人收到结构化指令（角色设定 + 「不要回复或评价其他机器人的发言」），独立生成并流式发布；
- 每轮最多召唤 `MAX_SUMMON_PER_TURN = 2` 个机器人，按 `bot_id` 去重、只允许启用的预设。

**防循环机制**：

1. **事件源头约束**：只有主 agent 的 turn 结束时会解析 `summon_bot` 并 fan-out 机器人；**机器人消息本身绝不触发新的调度**（`runBot` 不调用 `resolveSummons`）；
2. **提示词约束**：附加机器人 system prompt 明确禁止回应/评价其他机器人；
3. **数量熔断**：单轮召唤上限 2，去重 + 仅启用成员，从结构上杜绝机器人互相点名导致的无限接力。

**确保回复（回复保障）**：

- 主 agent 若只调用工具而未产出正文，回退为固定文案（「我来召唤机器人帮你补充解答这个问题。」），保证有可见结果；
- 机器人流式生成期间写「草稿条目」（`streaming: true`）实时推送；**失败/中止时回滚草稿**，避免残留空消息；
- 群组下主 agent 也走草稿 + 增量 partial 投递，多机器人并行流式时前端也能稳定刷新。

> 更完整的「多机器人编排 / 循环防护 / 回复保障」设计与异常矩阵见 [docs/qm-group-chat/群组对话功能：多机器人编排、循环防护与回复保障.md](./docs/qm-group-chat/群组对话功能：多机器人编排、循环防护与回复保障.md)。

---

## 部署

- **在线演示**：<http://openpilot.lijingang.ccwu.cc:8200>
- **部署文档**：[deploy/DEPLOYMENT.md](./deploy/DEPLOYMENT.md)（Node glibc-217 安装 / pm2 / 开机自启 / 验证 / 排障）
- **Docker**：根目录 `Dockerfile`（多阶段构建，单容器跑 4 服务）

---

## 加分项完成情况

| 加分项 | 状态 | 说明 |
|---|---|---|
| 单元测试 / 集成测试 | ✅ 已实现 | 各包 `test/`（Node 内置 test runner + jsdom） |
| 流式响应 | ✅ 已实现 | DeepSeek `stream:true` + SSE 推送（`/api/runs/:id/events`） |
| 错误处理与输入验证 | ✅ 部分 | 外部 API 失败兜底、zod/typebox 校验（部分端点） |
| 部署说明文档 | ✅ 已实现 | `deploy/DEPLOYMENT.md` + Dockerfile |
| 日志记录 | ✅ 已实现 | 各服务结构化日志 + pm2 日志 |
| 性能优化（索引设计） | ⚠️ 仅设计 | PostgreSQL 索引见 `docs/db/`；JSON 存储为内存缓存 |


---

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/API.md](./docs/API.md) | 统一 API 文档（REST 端点 + SSE + 认证） |
| [docs/PROJECT_PLAN.md](./docs/PROJECT_PLAN.md) | 项目计划与设计 |
| [docs/db/](./docs/db/) | 数据库 Schema 设计（sessions / projects / durable-map / acl / replay） |
| [docs/login/](./docs/login/) | 认证与登录设计 |
| [docs/qm-group-chat/](./docs/qm-group-chat/) | 群组对话：机器人编排 / 防循环 / 回复保障设计 |
| [deploy/DEPLOYMENT.md](./deploy/DEPLOYMENT.md) | 生产部署文档 |

---

## 参考项目

> 参考仓库：[yc-software/qm](https://github.com/yc-software/qm) —— 一个多人在线 agent 工作平台。OpenPilot 的架构理念（Scope 隔离、无头 Core + HTTP API、Vite + Lit 前端、OIDC 身份）参考自此项目。
