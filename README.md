# OpenPilot Chat

> 简化版在线聊天应用 · 多用户认证 · 对话管理 · AI 自动回复 · 群组对话

**🎬 演示录制 · 欢迎使用 OpenPilot**：https://meeting.tencent.com/crm/KPXnz4DWfe

## 项目介绍

OpenPilot Chat 是一个简化版在线聊天应用，支持多用户认证、个人对话管理（含标签/分类）、AI 自动回复，以及多人与多机器人参与的群组对话。

项目使用 Node 生态构建，注重后端逻辑的健壮性、数据隔离与 AI 交互的稳定性。

核心能力：

- **多用户认证**：用户注册/登录，会话与数据按用户隔离
- **个人对话管理**：个人会话支持标签与分类，便于整理检索
- **AI 自动回复**：接入 LLM（如 DeepSeek），自动生成回复
- **群组对话**：支持多人 + 多机器人共同参与的群聊
- **数据隔离**：用户数据、会话、消息按 Scope 严格隔离
- **稳定性**：PostgreSQL 持久化、任务队列、幂等与重试机制

---

## 技术框架总清单

### 一、后端（Node.js + TypeScript）

| 模块 | 技术 |
|---|---|
| 运行时 | Node.js（nvm v22.19.0）+ TypeScript 5 |
| Core 主 API | **Fastify 5** |
| 网关/反代 | Node 原生 `node:http`，手写路由 |
| 管理台服务 | Node 原生 `node:http`，服务端渲染 HTML |
| OIDC IdP | Node 原生 `node:http` + **jose**（JWT/JWK） |

### 二、数据层

| 模块 | 技术 |
|---|---|
| 数据库 | PostgreSQL |
| 数据库驱动 | **`pg`**（官方驱动，手写 SQL，无 ORM） |
| 表结构 | 分散在各 `postgres-*.ts` 的 `SCHEMA` 常量；配置类走 `durable-map`（`id + jsonb` 通用表） |
| 任务队列 | `pg-boss` |
| 缓存 | `lru-cache` |
| 文件存储 | 本地 `data/docstore/files/<sha256>`；可选 S3（`@aws-sdk/client-s3`） |
| 校验 | `zod` / `typebox` |

### 三、前端

| 模块 | 技术 |
|---|---|
| Web UI 主界面 | **Lit 3**（Web Components） |
| 轻量组件库 | `@mariozechner/mini-lit` |
| 布局/分屏 | `dockview-core` |
| 图标 | `lucide` |
| Markdown 渲染 | `marked` + `DOMPurify` + highlight.js + KaTeX |
| 时间 | `date-fns` + `@date-fns/tz` |
| 构建工具 | **Vite 5** + **esbuild 0.19** |
| 管理台页面 | 服务端渲染裸 HTML（无框架） |

### 四、认证/身份

| 模块 | 技术 |
|---|---|
| 认证协议 | OIDC（Portal 作 Client，内置 auth broker 作 IdP） |
| JWT/JWK/JWKS | **`jose`** |
| 邮件登录 | Resend API（`fetch` 调用）或自实现 SMTP（`node:net`+`node:tls`） |
| 会话 | Session cookie + PostgreSQL `sessions` 表 |

### 五、AI 模型接入

| 模块 | 技术 |
|---|---|
| Harness | `@earendil-works/pi-coding-agent`（本地 pi） |
| LLM Provider | DeepSeek（OpenAI 兼容协议，`api.deepseek.com`） |
| 其他 SDK | Claude Agent SDK、OpenAI Codex、MCP SDK、Slack Bolt |

### 六、工程工具

| 用途 | 工具 |
|---|---|
| 构建 | esbuild / Vite |
| 测试 | Node 内置 test runner + jsdom |
| Lint | oxlint / eslint / typescript-eslint |
| 格式 | prettier |
| 依赖检查 | knip |

---

## 端口分配

### OpenPilot 服务（当前）

| 端口 | 服务 | 说明 |
|---|---|---|
| `8200` | gateway | 统一入口 / OIDC Client / 反代 |
| `8201` | IdP | 身份提供方（GitHub / Google） |
| `8202` | web-ui | Lit 前端 + 服务端代理 |
| `8203` | core | 最小业务 API（会话/消息/DeepSeek AI） |

> ✅ OpenPilot 使用 `8200`~`8203` 端口段，与原 QM 项目（`8080`/`8090`/`8096`/`8097`）**完全隔离**，可同时运行互不冲突。

### 原 QM 项目端口（保持不变，未动）

| 端口 | 服务 | 说明 |
|---|---|---|
| `8080` | Core | Fastify 主 API（业务） |
| `8090` | Admin | 服务端渲染管理台 |
| `8096` | Web UI | 前端 |
| `8097` | Portal | 网关 |

### 启动 OpenPilot（开发）

```bash
# 1. IdP（:8201）
cd IdP && npm install && npm run dev

# 2. gateway（:8200）
cd gateway && npm install && npm run dev

# 3. web-ui（:8202）
cd web-ui && npm install && npm run serve   # 或 npm run dev（Vite HMR）

# 4. core（:8203）
cd core && npm install && npm run dev
```

---

## 后端内存评估

> 实测环境：macOS + Node.js v22，4 个服务同时运行，空闲/轻负载状态。

| 服务 | 端口 | 实测 RSS（常驻内存） |
|---|---|---|
| gateway | `8200` | ~51 MB |
| IdP | `8201` | ~40 MB |
| web-ui | `8202` | ~63 MB |
| core | `8203` | ~57 MB |
| **合计** | | **~210 MB** |

- 当前 core 使用 JSON 文件存储（`core/data/db.json`，原子写入），数据常驻内存；实测 58 个会话 / 558 条消息仅占 <1 MB，消息量增长到数万条也只需几 MB。
- LLM（DeepSeek）流式回复会产生临时缓冲（通常几 KB~几十 KB，可忽略）。
- **建议配置**：
  - 最低：**512 MB**（可运行，峰值较紧）
  - 推荐：**1 GB**（舒适运行，含峰值余量）
  - 若启用 PostgreSQL + pg-boss（目标架构）：推荐 **1.5~2 GB**

---

## 架构总览

```text
Browser
  │
  ▼
gateway :8200（统一入口 / OIDC Client / 反代）
  │
  ├──► IdP :8201（/idp/* 反代，身份提供方）
  └──► web-ui :8202（Lit 前端 + 服务端代理 /api）
          │
          └──► core :8203（业务 API）
                  │
                  ├──► PostgreSQL（会话/消息/文件元数据/配置）
                  ├──► 本地文件存储 data/docstore/files
                  ├──► DeepSeek（AI 回复）
                  └──► pg-boss（任务队列）
```

## 核心设计哲学

> 后端：Fastify（Core）+ 原生 http（插件层）+ `pg` 手写 SQL + jsonb 通用表，无 ORM；前端：Lit Web Components + Vite，不用 React/Vue；整体少依赖、手写可控、模块自包含，注重健壮性与数据隔离。


---

## 参考项目：yc-software/qm

> 参考仓库：https://github.com/yc-software/qm —— 一个多人在线 agent 工作平台（multiplayer agent harness for work）。OpenPilot Chat 的架构理念与设计取舍参考自此项目。

### qm 项目重点（提炼）

- **定位**：面向团队的多智能体工作平台。每个员工拥有独立隔离的工作区（workspace），互不影响；同时可在频道、群组消息、项目中与 agent 协作。
- **Scope 隔离模型**：每个人、每个房间拥有独立的 memory、文件、keychain、权限、cron、Web 应用与持久化沙箱——数据隔离是一等公民。
- **核心架构**：无头核心（API · 身份 · 策略 · 调度）+ Agent Loop（Pi / OpenCode / Codex / Claude Code 可切换 harness）+ 每 Scope 独立沙箱；Postgres 持久化会话、记忆与队列。
- **技术栈**：TypeScript on Node + Fastify（HTTP 核心）；Web UI 用 Vite + Lit；Slack 插件用 Bolt。
- **安全姿态**：Strict（所有工具调用人工审批）/ Auto（默认，内容分类器筛查）/ Dangerous（无筛查无暂停）三档，叠加预声明命令策略（递归删除、破坏性 SQL 等硬拒绝）。
- **部署模式**：deployment directory——core 保持通用，组织特定配置集中在部署目录，由 CLI 校验并部署；支持私有 fork，用 update-qm / upstream-pr 双技能维护上游边界。

### 对 OpenPilot Chat 的借鉴

| qm 的设计 | OpenPilot Chat 对应实现 |
|---|---|
| Scope 隔离（数据隔离一等公民） | 全部多租户查询强制 scope 条件（见 docs/PROJECT_PLAN.md §4.3） |
| 无头核心 + HTTP API | Core :8203（Fastify 5 主 API） |
| Postgres 持久化（会话/记忆/队列） | PostgreSQL + pg-boss 任务队列 |
| Web UI：Vite + Lit | Web UI :8202（Vite 5 + Lit 3） |
| 身份与权限 | OIDC + session cookie + ACL（见 docs/login/AUTHENTICATION.md） |
| 多 harness / 多模型可切换 | LLM Provider 抽象（DeepSeek 默认，可换 Claude / Codex） |
