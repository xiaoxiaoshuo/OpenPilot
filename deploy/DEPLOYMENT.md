# OpenPilot Chat 生产部署文档

本文档记录 OpenPilot Chat 在 **腾讯云 CentOS 7** 上的完整部署流程（HTTP 模式，公网端口 `8200`）。

> 实际部署记录：
>
> - 服务器：`101.32.98.238`（CentOS 7，内核 3.10.0，glibc 2.17）
> - 域名：`openpilot.lijingang.ccwu.cc`（DNS A 记录直连，未走 CDN 代理）
> - 部署目录：`/opt/openpilot`
> - 进程管理：pm2 + systemd 开机自启

---

## 1. 架构与端口

```text
Browser
  │  http://openpilot.lijingang.ccwu.cc:8200
  ▼
gateway :8200（统一入口 / OIDC Client / 反代）
  │
  ├──► IdP :8201（/idp/* 反代，GitHub / Google / Demo 登录）
  └──► web-ui :8202（Lit 前端 + 服务端代理 /api）
          │
          └──► core :8203（业务 API）
                  ├──► 本地 JSON 存储 data/db.json
                  └──► DeepSeek（AI 回复）
```

| 端口 | 服务 | 是否对外 |
|---|---|---|
| `8200` | gateway | ✅ 公网（安全组需放行） |
| `8201` | IdP | ❌ 仅内网（127.0.0.1） |
| `8202` | web-ui | ❌ 仅内网（127.0.0.1） |
| `8203` | core | ❌ 仅内网（127.0.0.1） |

---

## 2. 前置条件

- 一台 CentOS 7 服务器（本流程针对 glibc 2.17 的老系统）
- 域名已解析到服务器 IP
- 腾讯云安全组放行 `8200` 端口（TCP）
- 服务器可访问 `github.com`、`registry.npmjs.org`、`unofficial-builds.nodejs.org`、`api.deepseek.com`

---

## 3. 部署步骤

### 3.1 安装 Node.js 22（兼容 glibc 2.17）

CentOS 7 的 glibc 是 2.17，官方 Node 22 二进制要求 glibc ≥ 2.28，**无法直接运行**。
需使用 unofficial-builds 提供的 glibc-217 兼容版：

```bash
cd /tmp
wget -q https://unofficial-builds.nodejs.org/download/release/v22.19.0/node-v22.19.0-linux-x64-glibc-217.tar.gz
tar -xzf node-v22.19.0-linux-x64-glibc-217.tar.gz
mv node-v22.19.0-linux-x64-glibc-217 /usr/local/nodejs

ln -sf /usr/local/nodejs/bin/node  /usr/local/bin/node
ln -sf /usr/local/nodejs/bin/npm   /usr/local/bin/npm
ln -sf /usr/local/nodejs/bin/npx   /usr/local/bin/npx
ln -sf /usr/local/nodejs/bin/corepack /usr/local/bin/corepack

node --version   # v22.19.0
npm --version    # 10.9.3
```

> Node 22.18+ 已默认开启 TypeScript 类型剥离（type stripping），因此本项目源码可以直接
> `node src/index.ts` 运行，无需 `tsc` 编译、也无需 `--experimental-strip-types` 标志。

### 3.2 安装 pm2

```bash
npm install -g pm2 --no-fund --no-audit
# npm 全局前缀是 /usr/local/nodejs，pm2 会被装到 /usr/local/nodejs/bin
ln -sf /usr/local/nodejs/bin/pm2 /usr/local/bin/pm2
pm2 --version
```

### 3.3 上传代码

在本地打包源码（排除依赖、构建产物、本地数据与密钥）：

```bash
cd /path/to/OpenPilot
tar \
  --exclude='./.git' \
  --exclude='node_modules' \
  --exclude='.DS_Store' \
  --exclude='dist-web' \
  --exclude='./.env' \
  --exclude='.env.local' \
  --exclude='*.log' \
  --exclude='./core/data' \
  --exclude='./backups' \
  --exclude='./test' \
  --exclude='./IdP/.idp-jwk.json' \
  -czf /tmp/openpilot-src.tar.gz .

scp -i ~/.ssh/skey-k0s7i7vh /tmp/openpilot-src.tar.gz root@101.32.98.238:/tmp/
```

服务器上解压：

```bash
mkdir -p /opt/openpilot
cd /opt/openpilot
tar -xzf /tmp/openpilot-src.tar.gz
find . -name '._*' -delete
find . -name '.DS_Store' -delete
```

### 3.4 配置环境变量

#### 根 `.env`（gateway / IdP / core 共用，路径 `/opt/openpilot/.env`）

```ini
GITHUB_CLIENT_ID=xxxx
GITHUB_CLIENT_SECRET=xxxx
GOOGLE_CLIENT_ID=xxxx
GOOGLE_CLIENT_SECRET=xxxx

# ── 公网地址（HTTP 模式，端口 8200）──
IDP_ISSUER=http://openpilot.lijingang.ccwu.cc:8200/idp
IDP_REDIRECT_URI=http://openpilot.lijingang.ccwu.cc:8200/auth/callback
GITHUB_CALLBACK_URI=http://openpilot.lijingang.ccwu.cc:8200/idp/callback/github
GOOGLE_CALLBACK_URI=http://openpilot.lijingang.ccwu.cc:8200/idp/callback/google
GATEWAY_PUBLIC_URL=http://openpilot.lijingang.ccwu.cc:8200

# ── 内部上游（固定 127.0.0.1）──
IDP_UPSTREAM=http://127.0.0.1:8201
WEB_UI_UPSTREAM=http://127.0.0.1:8202

# ── OIDC / 会话 ──
OIDC_CLIENT_ID=openpilot-web
IDP_CLIENT_ID=openpilot-web
IDP_CLIENT_SECRET=<至少32位>
IDP_TOKEN_SECRET=<至少32位>
GATEWAY_SESSION_TTL_S=604800

# ── portal 身份签名密钥（gateway/web-ui/core 必须一致）──
PORTAL_IDENTITY_SECRET=<随机密钥>

# ── core ──
CORE_ORG_ID=local
CORE_DATA_DIR=data

# ── DeepSeek ──
DEEPSEEK_API_KEY=sk-xxxx
CORE_MODEL=deepseek-chat
CORE_MODELS=deepseek-chat,deepseek-reasoner

# ── 演示登录（HTTP 部署下可用；若 NODE_ENV=production 会被禁用）──
IDP_DEMO_LOGIN_ENABLED=true
```

> ⚠️ 生产服务器**不要**配置 `HTTPS_PROXY / HTTP_PROXY / all_proxy`（除非服务器上真有对应代理）。
> 本项目的 GitHub 登录请求走 `fetch` 直连；Google 登录在无代理的国内服务器上不可用，属正常现象。

#### `web-ui/.env`（路径 `/opt/openpilot/web-ui/.env`）

web-ui 的 `serve` 脚本读的是 `web-ui/.env`（不是根 `.env`），必须单独配置：

```ini
CORE_API_URL=http://127.0.0.1:8203
CORE_ORG_ID=local
PORTAL_IDENTITY_SECRET=<与根 .env 完全一致>
WEB_UI_PUBLIC_URL=http://openpilot.lijingang.ccwu.cc:8200
```

### 3.5 安装依赖与构建

```bash
# gateway（运行时依赖 jose / lru-cache）
cd /opt/openpilot/gateway && npm ci --omit=dev --no-fund --no-audit

# IdP（运行时依赖 jose / undici）
cd /opt/openpilot/IdP && npm ci --omit=dev --no-fund --no-audit

# core 无第三方运行时依赖，跳过 npm install

# web-ui（需要完整依赖 + 构建产物 dist-web）
cd /opt/openpilot/web-ui && npm ci --no-fund --no-audit
cd /opt/openpilot/web-ui && npm run build
```

### 3.6 pm2 启动（务必使用 wrapper 脚本）

> ⚠️ **关键坑**：pm2 fork 模式会用 `ProcessContainerFork.js` 包装进程，导致进程内
> `process.argv[1]` 不是真正的脚本路径。本项目 gateway/IdP/web-ui 的入口判断依赖
> `import.meta.url === argv[1]`，被 pm2 包装后会**静默不启动**（进程在线但不监听端口）。
>
> 解决：用一个 shell 脚本 `cd` 到服务目录后 `exec node` 启动，让 argv 恢复正常。

创建 4 个 wrapper 脚本（本目录已提供，直接复制到 `/opt/openpilot/`）：

```bash
cp deploy/run-core.sh deploy/run-idp.sh deploy/run-web-ui.sh deploy/run-gateway.sh /opt/openpilot/
chmod +x /opt/openpilot/run-*.sh
```

`run-*.sh` 内容（以 IdP 为例）：

```sh
#!/bin/sh
cd /opt/openpilot/IdP
exec /usr/local/bin/node src/index.ts
```

把本目录的 `deploy/ecosystem.config.cjs` 复制到服务器并**把其中的密钥占位符替换成真实值**，然后：

```bash
cp deploy/ecosystem.config.cjs /opt/openpilot/
cd /opt/openpilot
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
```

### 3.7 开机自启

```bash
pm2 save
pm2 startup systemd -u root --hp /root
```

---

## 4. 验证

```bash
# 服务与端口
pm2 list
ss -tlnp | grep -E ':8200|:8201|:8202|:8203'

# 内部健康检查
curl -s http://127.0.0.1:8200/healthz   # {"ok":true,"service":"gateway",...}
curl -s http://127.0.0.1:8203/healthz   # {"ok":true}

# 公网自检（本机执行）
curl -s http://openpilot.lijingang.ccwu.cc:8200/healthz
curl -s -o /dev/null -w '%{http_code}\n' http://openpilot.lijingang.ccwu.cc:8200/
# 预期：302 跳转 /auth/login

# Demo 登录端到端（本机执行）
curl -s -c cj -b cj -L \
  "http://openpilot.lijingang.ccwu.cc:8200/auth/login?provider=demo&email=you@example.com&returnTo=/" \
  -o /dev/null
curl -s -b cj http://openpilot.lijingang.ccwu.cc:8200/me
# 预期返回：{"user":"you@example.com","org":"local",...}
```

---

## 5. 常用管理命令

```bash
ssh -i ~/.ssh/skey-k0s7i7vh -o IdentitiesOnly=yes root@101.32.98.238

pm2 list              # 查看 4 个服务状态
pm2 logs              # 实时日志
pm2 logs <name>       # 单个服务日志
pm2 restart all       # 重启全部
pm2 reload all        # 平滑重启
pm2 describe <name>   # 查看进程详情
```

日志位置：`/root/.pm2/logs/openpilot-*.log`

---

## 6. 排障记录

| 现象 | 原因 | 处理 |
|---|---|---|
| `node --version` 报 `GLIBC_2.28 not found` | 官方 Node 22 与 CentOS 7 glibc 2.17 不兼容 | 用 unofficial-builds 的 glibc-217 版 |
| pm2 显示 online 但 IdP/web-ui 不监听端口、无日志 | pm2 `ProcessContainerFork.js` 包装破坏 `process.argv[1]` 入口判断 | 用 `run-*.sh` wrapper 脚本 `exec node` 启动 |
| pm2 的 `interpreter_args`（`--env-file-if-exists` 等）未生效 | pm2 fork 包装对 .ts 脚本处理异常 | 改用 ecosystem 的 `env` 字段直接注入环境变量 |
| GitHub 登录回调报错 | GitHub OAuth App 未登记新回调地址 | 在 GitHub OAuth App 增加 `http://openpilot.lijingang.ccwu.cc:8200/idp/callback/github` |
| Google 登录不可用 | 国内服务器无代理，访问 Google 被墙 | 属预期；改用 Demo / GitHub 登录 |

---

## 7. 与开发模式的区别

| 项 | 开发（macOS） | 生产（本部署） |
|---|---|---|
| 启动方式 | `npm run dev`（各自目录） | pm2 + `run-*.sh` wrapper |
| 公网地址 | `http://127.0.0.1:8200` | `http://openpilot.lijingang.ccwu.cc:8200` |
| 出站代理 | 本地 `127.0.0.1:7897` | 不配置代理 |
| NODE_ENV | 未设置 | 未设置（保持 HTTP + demo 登录可用） |
| web-ui 产物 | Vite dev / `serve` | `npm run build` 后 `server/index.ts` 静态托管 |
| 进程守护 | 手动 | pm2 + systemd 开机自启 |
