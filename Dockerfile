# syntax=docker/dockerfile:1

# ============================================================
# OpenPilot Chat — 单容器镜像（gateway + IdP + web-ui + core）
#
# 说明：
# - 基础镜像用 node:22-bookworm-slim（glibc 新版），官方 Node 22 可直接运行，
#   不需要 bare-metal 部署时的 glibc-217 特殊构建。
# - Node 22 已默认开启 TypeScript 类型剥离，源码直接 `node xxx.ts` 运行。
# - web-ui 前端在 build 阶段用 Vite 构建出 dist-web，运行时只保留产物。
#
# 构建：
#   docker build -t openpilot .
# 运行：
#   docker run -d --name openpilot -p 8200:8200 \
#     -e GATEWAY_PUBLIC_URL=http://你的域名:8200 \
#     -e IDP_ISSUER=http://你的域名:8200/idp \
#     -e IDP_REDIRECT_URI=http://你的域名:8200/auth/callback \
#     -e GITHUB_CALLBACK_URI=http://你的域名:8200/idp/callback/github \
#     -e GOOGLE_CALLBACK_URI=http://你的域名:8200/idp/callback/google \
#     -e IDP_CLIENT_SECRET=xxx -e IDP_TOKEN_SECRET=xxx \
#     -e PORTAL_IDENTITY_SECRET=xxx \
#     -e DEEPSEEK_API_KEY=sk-xxx \
#     -e GITHUB_CLIENT_ID=xxx -e GITHUB_CLIENT_SECRET=xxx \
#     openpilot
# ============================================================

############################################################
# Stage 1：build —— 构建 web-ui 前端产物 dist-web
############################################################
FROM node:22-bookworm-slim AS build

WORKDIR /repo

# 先拷贝 package 清单，利用 Docker 层缓存
COPY web-ui/package.json web-ui/package-lock.json ./web-ui/
RUN cd web-ui && npm ci --no-fund --no-audit

# 拷贝 web-ui 源码（index.html / src / vite 配置等）
COPY web-ui/ ./web-ui/

# 生产构建，产物落在 /repo/web-ui/dist-web
RUN cd web-ui && npm run build


############################################################
# Stage 2：runtime —— 只安装运行时依赖
############################################################
FROM node:22-bookworm-slim

WORKDIR /app

# ------------------------------------------------------------------
# 注意：这里【不要】设置 NODE_ENV=production。
# 因为 IdP/gateway 在 NODE_ENV=production 时会强制要求 HTTPS 回调地址，
# 并禁用 demo 登录；本项目当前走 HTTP + demo 登录，必须保持 NODE_ENV 未设置。
# ------------------------------------------------------------------

# ---- core：无第三方运行时依赖，仅拷贝源码（含 chassis 公共代码）----
COPY core/ ./core/

# ---- gateway：运行时依赖 jose / lru-cache ----
COPY gateway/package.json gateway/package-lock.json ./gateway/
RUN cd gateway && npm ci --omit=dev --no-fund --no-audit
COPY gateway/src ./gateway/src

# ---- IdP：运行时依赖 jose / undici ----
COPY IdP/package.json IdP/package-lock.json ./IdP/
RUN cd IdP && npm ci --omit=dev --no-fund --no-audit
COPY IdP/src ./IdP/src

# ---- web-ui：运行时依赖 + 已构建的 dist-web ----
# server/index.ts 还依赖 ../../core/chassis，上面已随 core/ 一起拷入
COPY web-ui/package.json web-ui/package-lock.json ./web-ui/
RUN cd web-ui && npm ci --omit=dev --no-fund --no-audit
COPY web-ui/server ./web-ui/server
COPY --from=build /repo/web-ui/dist-web ./web-ui/dist-web

# ---- 启动脚本（容器内多进程 supervisor）----
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# ---- 数据目录（core 的 JSON 存储）----
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# ------------------------------------------------------------------
# 环境变量：非敏感配置给默认值；敏感值请通过 docker run -e 覆盖
# ------------------------------------------------------------------
ENV HOST=0.0.0.0 \
    GATEWAY_PUBLIC_URL=http://localhost:8200 \
    IDP_ISSUER=http://localhost:8200/idp \
    IDP_REDIRECT_URI=http://localhost:8200/auth/callback \
    GITHUB_CALLBACK_URI=http://localhost:8200/idp/callback/github \
    GOOGLE_CALLBACK_URI=http://localhost:8200/idp/callback/google \
    IDP_UPSTREAM=http://127.0.0.1:8201 \
    WEB_UI_UPSTREAM=http://127.0.0.1:8202 \
    CORE_API_URL=http://127.0.0.1:8203 \
    CORE_ORG_ID=local \
    CORE_DATA_DIR=/app/data \
    CORE_MODEL=deepseek-chat \
    CORE_MODELS=deepseek-chat,deepseek-reasoner \
    IDP_CLIENT_ID=openpilot-web \
    OIDC_CLIENT_ID=openpilot-web \
    IDP_DEMO_LOGIN_ENABLED=true

# 以下为可启动的占位密钥（请务必用 -e 覆盖成真实随机值）
ENV IDP_CLIENT_SECRET=change-me-idp-client-secret-00000000000000 \
    IDP_TOKEN_SECRET=change-me-idp-token-secret-0000000000000000 \
    PORTAL_IDENTITY_SECRET=change-me-portal-identity-secret-0000000

# 可选：GitHub / Google / DeepSeek，不配置则对应登录/能力不可用，但不影响 demo 登录
#   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
#   DEEPSEEK_API_KEY

EXPOSE 8200 8201 8202 8203

ENTRYPOINT ["docker-entrypoint.sh"]
