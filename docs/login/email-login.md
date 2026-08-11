# QM 邮箱登录（Email Magic Link + OIDC）详细文档

> 基于 QM 项目实际代码整理：`plugins/auth`（OIDC IdP）、`plugins/portal`（OIDC Client）、`src/auth`（防重放）

---

## 一、总体架构

```text
浏览器
  │  ① 访问 /auth/login
  ▼
Portal :8097（OIDC Client / 网关）
  │  ② 302 → /idp/authorize（Portal 反代到 auth broker）
  ▼
auth broker :8099（OIDC IdP，plugins/auth）
  │  ③ 输入邮箱 → 白名单校验 → ④ 调 Resend 发一次性链接
  ▼
用户邮箱 → 打开 /idp/verify#token=... → 点击确认
  │  ⑤ 生成 authorization code → 302 回 Portal /auth/callback?code=..&state=..
  ▼
Portal ⑥ 用 code + code_verifier 换 token（POST /idp/token）
      ⑦ 验证 id_token（签名/issuer/aud/nonce）
      ⑧ 设置自己的 session cookie → 302 回 returnTo
```

一句话：**前端拿 code，后端 code 换 token，应用验证 id_token 后发自己的 session cookie。**

---

## 二、完整分步流程

### 第 1 步：用户访问 Portal 发起登录

- 用户访问 `http://127.0.0.1:8097/`，无 session → 302 到 `/auth/login?returnTo=/`
- 如果启用了本地开发免登（`PORTAL_LOCAL_AUTH_BYPASS`），直接发本地 session cookie，流程结束

### 第 2 步：Portal 生成 OIDC 参数并发起重定向

`plugins/portal/src/index.ts` 的 `authLogin()`：

```text
生成 state（随机串）         → 防 CSRF
生成 nonce（随机串）         → 防 id_token 重放
生成 PKCE pair：
  code_verifier（随机 43+ 字符）
  code_challenge = base64url(sha256(verifier))，S256
```

把这些临时状态密封进 `portal_oidc_tmp` cookie：

```ts
setCookie("portal_oidc_tmp", seal(tmp, tmpKey), { path: "/auth", maxAge: TMP_TTL_S, ... })
```

然后 302 到 auth broker 的 authorize endpoint：

```text
http://127.0.0.1:8097/idp/authorize
  ?client_id=qm-local
  &redirect_uri=http://127.0.0.1:8097/auth/callback
  &response_type=code
  &scope=openid email
  &state=<state>
  &nonce=<nonce>
  &code_challenge=<challenge>
  &code_challenge_method=S256
```

> `/idp/*` 由 Portal 反代到 `AUTH_BROKER_UPSTREAM=http://127.0.0.1:8099`，所以浏览器看到的 issuer 全是 Portal 域名。

### 第 3 步：auth broker 校验授权请求

`plugins/auth/src/server.ts` 的 `readAuthorizeRequest()` 逐项校验：

```text
client_id             必须等于 AUTH_CLIENT_ID（qm-local）
redirect_uri          必须等于 AUTH_REDIRECT_URI（注册的回调地址）
response_type         必须是 code（只支持授权码流程）
code_challenge_method 必须是 S256
code_challenge        格式 ^[A-Za-z0-9\-_]{43}$
state / nonce         存在且 ≤512 字符
scope                 必须包含 openid
```

任何一项不通过 → 显示错误页（"This sign-in request is ..."）。

### 第 4 步：用户输入邮箱，发送一次性链接

- 邮箱页校验通过后，`POST /idp/authorize` 提交邮箱
- 白名单校验：

```env
AUTH_ALLOWED_EMAIL_DOMAIN=qq.com    # 域名白名单
AUTH_ALLOWED_EMAILS=...             # 或精确邮箱白名单
```

- 不在白名单 → 403 "Your administrator has not allowed this email address"
- 通过 → 用 Resend 发送邮件：

```env
AUTH_EMAIL_TRANSPORT=resend
AUTH_EMAIL_FROM="QM <login@mail.lijingang.ccwu.cc>"
```

邮件内容是**一次性登录链接**（签名密封 token，默认 ~15 分钟有效）：

```text
http://127.0.0.1:8097/idp/verify#token=<sealed>
```

> token 放在 URL fragment（`#` 后面）：不会作为 HTTP 请求路径发送，减少进入服务端日志/Referer 的机会。

### 第 5 步：用户打开链接并确认

- 用户打开链接 → `GET /idp/verify#token=...` 显示"确认登录"页
- 点击 Sign in → `POST /idp/verify` 提交 token
- auth broker 校验：

```text
打开签名 token（签名/过期）
claimOnce("link:<jti>")            → 防重放（存 source_auth_replay 表）
client_id / redirect_uri 仍匹配
邮箱仍在白名单
```

- 全部通过 → 生成 **authorization code**（签名密封，`code:<jti>`，短 TTL）：

```ts
const code = await signer.sealCode({ clientId, redirectUri, nonce, codeChallenge, email }, cfg.codeTtlS, now());
```

- 302 回 Portal 回调地址：

```text
http://127.0.0.1:8097/auth/callback?code=<code>&state=<state>
```

### 第 6 步：Portal 校验回调

`plugins/portal/src/index.ts` 的 `authCallback()`：

```text
读 portal_oidc_tmp cookie → 不存在/过期 → "login session expired"
校验 code 和 state 都存在
state 必须等于 cookie 里的 state          → 防 CSRF
consumeState(state) 防重放（内存 LRU）
```

### 第 7 步：Portal 用 code 换 token（经典一步）

```text
POST /idp/token（Portal 反代到 auth broker :8099/token）
Authorization: Basic base64(qm-local:<client_secret>)
grant_type=authorization_code
code=<code>
redirect_uri=http://127.0.0.1:8097/auth/callback
code_verifier=<verifier>
```

auth broker 校验：

```text
Basic 凭证正确
grant_type 必须是 authorization_code
code 打开成功（签名有效、未过期）
redirect_uri 三处一致（code 里存的 = 表单提交的 = 配置的）
claimOnce("code:<jti>")   → 授权码只能用一次
pkceMatches(verifier, challenge)  → PKCE 校验
邮箱仍在白名单
```

通过后签发：

```json
{
  "access_token": "<sealed>",
  "token_type": "Bearer",
  "expires_in": <accessTtlS>,
  "id_token": "<JWT>",
  "scope": "openid email"
}
```

`id_token` 是 JWT，用 auth broker 的签名私钥签发，claims 含：

```json
{
  "iss": "http://127.0.0.1:8097/idp",
  "sub": "<subjectFor(issuer, email)>",
  "email": "171232349@qq.com",
  "email_verified": true,
  "aud": "qm-local",
  "nonce": "<原 nonce>",
  "exp": ...
}
```

### 第 8 步：Portal 验证 id_token 并建 session

`verifyIdToken()`：

```text
JWKS 获取公钥（http://127.0.0.1:8099/.well-known/jwks.json）
验签名
iss 必须等于 OIDC_ISSUER
aud 必须等于 OIDC_CLIENT_ID
nonce 必须等于 cookie 里的 nonce
未过期
```

再 `fetchUserinfo(access_token)` 拿 `sub`，与 id_token 的 `sub` 比对（防混淆）。

最后解析 principal 并设置自己的 session cookie：

```ts
const session: SessionClaims = {
  k: "session",
  sub,                       // 用户主标识，如 171232349@qq.com
  org: ORG,
  auth: now, iat: now, exp: now + SESSION_TTL_S,
  ...(name ? { name } : {})
};
sessionCookieSet(seal(session, sessionKey))
```

清除 `portal_oidc_tmp` → 302 回 `returnTo`。**登录完成，后续访问全靠这个 cookie。**

---

## 三、核心接口清单

### 1. auth broker（OIDC IdP，实际对外是 Portal 的 `/idp/*`）

| 方法+路径 | 作用 | 关键校验 |
|---|---|---|
| `GET /.well-known/openid-configuration` | OIDC 发现文档 | issuer/authorize/token/userinfo/jwks 地址 |
| `GET /.well-known/jwks.json` | 签名公钥 | 供 Portal 验 id_token |
| `GET /authorize` | 邮箱输入页 | client_id/redirect_uri/code/S256/state/nonce/openid |
| `POST /authorize` | 提交邮箱+发信 | 白名单 → Resend 发一次性链接 |
| `GET /verify#token=` | 确认登录页 | token 在 fragment |
| `POST /verify` | 消费链接 → 发 code | claimOnce(link) → 302 callback?code=..&state=.. |
| `POST /token` | **code 换 token** | Basic 认证 + code + redirect_uri + PKCE + 白名单 → id_token |
| `GET/POST /userinfo` | 用户信息 | Bearer access_token → sub/email/email_verified |
| `GET /healthz` | 健康检查 | |

### 2. Portal（OIDC Client）

| 方法+路径 | 作用 |
|---|---|
| `GET /auth/login?returnTo=` | 生成 state/nonce/PKCE → 存 tmp cookie → 302 authorize |
| `GET /auth/callback?code=&state=` | 验 state → code 换 token → 验 id_token → 发 session cookie |
| `GET /idp/*` | 反代到 auth broker（`AUTH_BROKER_UPSTREAM=:8099`） |

### 3. Core（防重放落点）

| 方法+路径 | 作用 |
|---|---|
| `POST /v1/auth/broker/claim` | source 签名认证；一次性 claim（link:/code:）持久化到 `source_auth_replay` |

---

## 四、数据库表

邮箱登录**唯一直接依赖的表**：

### `source_auth_replay`

```sql
CREATE TABLE IF NOT EXISTS source_auth_replay (
  event_id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX source_auth_replay_expires_at ON source_auth_replay (expires_at);
```

用途：

```text
link:<jti>  一次性登录链接 → 只能消费一次
code:<jti>  authorization code → 只能换一次 token
INSERT ... ON CONFLICT DO NOTHING 原子防重放（多实例并发也只放行一个）
定期清理过期记录
```

> 未设置 `DATABASE_URL` 时 Core 会拒绝 claim 路由——没有 PG 持久化，重启后已用的链接会"复活"。

### 不落库的部分

```text
Portal session cookie    = 签名密封 JWT（无表）
portal_oidc_tmp cookie   = 临时 state/nonce/PKCE verifier（无表）
authorization code       = 签名 token（无表）
一次性登录链接            = 签名 token（无表）
id_token / access_token  = JWT / 签名 token（无表）
```

---

## 五、安全要点汇总

| 机制 | 防什么 |
|---|---|
| `state` | CSRF / 登录流程被替换 |
| `nonce` | id_token 重放 |
| `PKCE (S256)` | authorization code 被截获 |
| `claimOnce`（source_auth_replay） | 登录链接/授权码二次使用 |
| `redirect_uri` 三处一致 | 开放重定向 |
| Basic 认证（client_id/secret） | token 端点被冒充 |
| 邮箱白名单 | 未授权邮箱登录 |
| token 放 URL fragment | 进日志/Referer 泄漏 |
| 短 TTL（链接 ~15min、code 更短） | 凭证长期有效被滥用 |
| Portal 自己的 session cookie | 不长期依赖浏览器里的第三方 token |

---

## 六、关键环境变量

```env
# auth broker（plugins/auth）
AUTH_ISSUER=http://127.0.0.1:8097/idp
AUTH_CLIENT_ID=qm-local
AUTH_REDIRECT_URI=http://127.0.0.1:8097/auth/callback
AUTH_CLIENT_SECRET=...
AUTH_ALLOWED_EMAIL_DOMAIN=qq.com
AUTH_ALLOWED_EMAILS=...
AUTH_EMAIL_TRANSPORT=resend
AUTH_EMAIL_FROM="QM <login@mail.lijingang.ccwu.cc>"
RESEND_API_KEY=...        # 敏感，避免回显

# portal（plugins/portal）
PORTAL_PUBLIC_URL=http://127.0.0.1:8097
PORTAL_SESSION_SECRET=...
AUTH_BROKER_UPSTREAM=http://127.0.0.1:8099
AUTH_BROKER_PREFIX=/idp
OIDC_ISSUER=http://127.0.0.1:8097/idp
OIDC_AUTH_ENDPOINT=http://127.0.0.1:8097/idp/authorize
OIDC_TOKEN_ENDPOINT=http://127.0.0.1:8099/token
OIDC_USERINFO_ENDPOINT=http://127.0.0.1:8099/userinfo
OIDC_JWKS_URI=http://127.0.0.1:8099/.well-known/jwks.json
OIDC_CLIENT_ID=qm-local
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=http://127.0.0.1:8097/auth/callback
OIDC_PRINCIPAL_CLAIM=email
OIDC_ALLOWED_EMAIL_DOMAIN=qq.com
```

> 当前本地配置 issuer 用的是 `http://127.0.0.1:8097`，因此邮箱登录仅本机可用；外网设备无法访问这些链接。

---

## 七、相关源码位置

```text
plugins/auth/src/index.ts     ← 服务入口（:8099）
plugins/auth/src/server.ts    ← OIDC 端点（authorize/verify/token/userinfo/discovery）
plugins/auth/src/tokens.ts    ← 链接/code/access 密封 + id_token 签发
plugins/auth/src/email.ts     ← Resend 邮件发送（原生 fetch）
plugins/auth/src/keys.ts      ← 签名密钥加载
plugins/auth/src/config.ts    ← 配置读取/校验

plugins/portal/src/index.ts   ← /auth/login、/auth/callback、/idp 反代
plugins/portal/src/oidc.ts    ← PKCE、exchangeCode、verifyIdToken、resolvePrincipal
plugins/portal/src/session.ts ← session cookie、returnTo 校验

src/auth/replay-dedupe.ts     ← source_auth_replay（防重放表）
src/api/routes/auth-broker.ts ← POST /v1/auth/broker/claim
```

---

## 八、为什么拆成三个模块（设计解释）

这个
"麻烦"不是 QM 故意的，而是 OIDC 协议本身的固有结构——三个角色必须分开。三个模块对应的正是协议里的三个独立角色：

```text
plugins/auth   = Identity Provider（身份提供方）— 证明"你是谁"
plugins/portal = Client（依赖方）— 决定"谁能进我的系统"
src/auth       = 公共基础设施 — "一次性凭证只能用一次"
```

### 1. 三个模块各管一件事，职责完全不同

| 模块 | 角色 | 它回答的问题 | 它不知道的事 |
|---|---|---|---|
| `plugins/auth` | OIDC IdP | "你输入的邮箱属于你吗？" | 不关心 Portal 内部长什么样 |
| `plugins/portal` | OIDC Client | "我该让谁进来？" | 不关心用户怎么完成验证 |
| `src/auth` | 通用防重放 | "这张凭证用过没？" | 不关心是邮箱还是别的 |

它们不合并，和"银行、商店、清算中心"不合并是同一个道理：

```text
银行（auth broker）验证你的身份并"发卡"
商店（portal）校验你的卡，决定放不放你进门
清算中心（claim 表）防止同一张卡刷两次
```

### 2. 拆开的真正收益：可替换性

**IdP 可以整个换掉，Portal 一行不改。** 现在邮箱登录用内置 `plugins/auth`，但 QM 支持任意标准 OIDC IdP：

```text
Auth0 / Okta / Google / Keycloak / Azure AD ...
```

只要对方支持 OIDC，Portal 只需改环境变量：

```env
OIDC_AUTH_ENDPOINT=https://accounts.google.com/o/oauth2/v2/auth
OIDC_TOKEN_ENDPOINT=https://oauth2.googleapis.com/token
OIDC_JWKS_URI=https://www.googleapis.com/oauth2/v3/certs
```

如果 auth 和 portal 合并成一个模块，换 Google 登录就要把整个登录系统改一遍。反过来，Client 也可以换：以后做移动 App，直接对接同一个 `plugins/auth`，不用碰 Portal。

### 3. 独立进程 = 独立安全边界 + 独立运维

```text
auth broker 挂了 → 只是"暂时不能登录"，在线用户不受影响
安全敏感组件隔离 → IdP 密钥泄漏面小
独立扩缩容     → 登录请求多就只扩 auth broker
```

### 4. `src/auth` 是公共的，不是"为邮箱登录写的"

`claimOnce` / `source_auth_replay` 是**全平台共用**的基础设施，邮箱登录只是用户之一：

```text
keychain 一次性授权（once grant） → 也用 claimOnce
deliveries 消息投递去重          → 也用 claim 机制
邮箱登录链接 / 授权码            → 也用 claimOnce
```

放进 Core（`src/`）而不是 auth broker，因为 Core 是唯一连接 PostgreSQL 的地方，防重放必须持久化（跨进程/重启），所有"只能用一次"的功能共用一张表、一套逻辑。

### 5. 流程本身不复杂，复杂度是"分散"的

```text
auth broker  ：收邮箱 → 发链接 → 验证 → 发 code/token（~9 个端点）
portal       ：跳转 → 回调 → 换 token → 验 id_token → 发 cookie（2 个端点）
src/auth     ：一张表 + 一个 INSERT ON CONFLICT
```

拆开 ≠ 逻辑多。用 3 个小而清晰的模块，换来每个模块都能独立替换、独立部署、独立测试。

### 6. 与项目整体哲学一致

```text
QM = 大仓 + 多进程
插件 = 独立部署单元
src  = Core（所有领域逻辑 + 数据层）
```

邮箱登录的拆分正是这个哲学的微观体现：

```text
identity 领域 → plugins/auth（可插拔的 IdP 插件）
surface 领域  → plugins/portal（网关插件）
持久化领域   → src/auth（Core 基础设施）
```

### 7. 一句话总结

> 不是 QM 把简单的事做复杂，而是 OIDC 协议本来就要求"身份提供方"和"依赖方"是两个角色——拆开让 IdP 可任意替换（换成 Google/Okta）、客户端可任意替换、进程可独立部署、防重放可被全平台复用。如果硬合成一个模块，省下的代码量很小，但换登录提供商、单独重启、安全隔离全都得推倒重来。
