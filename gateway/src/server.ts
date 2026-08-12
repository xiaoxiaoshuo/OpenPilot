/**
 * gateway — OpenPilot 网关（OIDC Client + 反代）
 *
 * 路由：
 *   /auth/login?provider=&returnTo=  登录选择 + 发起 OIDC
 *   /auth/callback                   回调（code 换 token → session cookie）
 *   /auth/logout                     登出
 *   /me                              当前用户
 *   /idp/*                           反代到 IdP :8201
 *   其余                             反代到 Web UI :8202（注入 x-portal-identity）
 *
 * 运行：
 *   npm run dev    （--watch 热重载）
 *   npm start
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAuthHandlers, type GatewayAuthConfig } from "./auth.ts";
import { createProxy } from "./proxy.ts";

export type Params = Record<string, string>;

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Params,
) => void | Promise<void>;

type Route = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
};

const routes: Route[] = [];

function addRoute(method: string, path: string, handler: Handler): void {
  const paramNames: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
        paramNames.push(name);
        return "([^/]+)";
      }) +
      "/?$",
  );
  routes.push({ method, pattern, paramNames, handler });
}

export const get = (path: string, handler: Handler) => addRoute("GET", path, handler);
export const post = (path: string, handler: Handler) => addRoute("POST", path, handler);
export const put = (path: string, handler: Handler) => addRoute("PUT", path, handler);
export const patch = (path: string, handler: Handler) => addRoute("PATCH", path, handler);
export const del = (path: string, handler: Handler) => addRoute("DELETE", path, handler);

// ───────────────────────── 配置 ─────────────────────────

const PORT = Number(process.env.PORT ?? 8200);
const HOST = process.env.HOST ?? "0.0.0.0";
const PUBLIC_URL = (process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const IDP_UPSTREAM = process.env.IDP_UPSTREAM ?? "http://127.0.0.1:8201";
const WEB_UI_UPSTREAM = process.env.WEB_UI_UPSTREAM ?? "http://127.0.0.1:8202";
const IDP_ISSUER = (process.env.IDP_ISSUER ?? `${PUBLIC_URL}/idp`).replace(/\/$/, "");
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "openpilot-web";
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || process.env.IDP_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.GATEWAY_SESSION_SECRET || process.env.IDP_TOKEN_SECRET || "";
const IDENTITY_SECRET = process.env.PORTAL_IDENTITY_SECRET ?? (SESSION_SECRET || undefined);
const SECURE_COOKIES = PUBLIC_URL.startsWith("https://");
const providerConfigured = (clientId: string | undefined, clientSecret: string | undefined): boolean =>
  Boolean(clientId?.trim() && clientSecret?.trim());

if (!OIDC_CLIENT_SECRET) {
  console.error("[gateway] FATAL: OIDC_CLIENT_SECRET / IDP_CLIENT_SECRET is required");
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error("[gateway] FATAL: GATEWAY_SESSION_SECRET / IDP_TOKEN_SECRET is required");
  process.exit(1);
}
if (SESSION_SECRET.length < 16) {
  console.error("[gateway] FATAL: GATEWAY_SESSION_SECRET must be at least 16 characters");
  process.exit(1);
}

const authCfg: GatewayAuthConfig = {
  publicUrl: PUBLIC_URL,
  oidc: {
    authEndpoint: `${IDP_ISSUER}/authorize`,
    tokenEndpoint: `${IDP_UPSTREAM}/token`,
    userinfoEndpoint: `${IDP_UPSTREAM}/userinfo`,
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
    scopes: "openid email profile",
    redirectUri: `${PUBLIC_URL}/auth/callback`,
    issuer: IDP_ISSUER,
    jwksUri: `${IDP_UPSTREAM}/.well-known/jwks.json`,
  },
  sessionSecret: SESSION_SECRET,
  tmpTtlS: Number(process.env.GATEWAY_TMP_TTL_S ?? 600),
  sessionTtlS: Number(process.env.GATEWAY_SESSION_TTL_S ?? 7 * 24 * 3600),
  secureCookies: SECURE_COOKIES,
  providers: {
    github: providerConfigured(process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET),
    google: providerConfigured(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET),
  },
};

const auth = createAuthHandlers(authCfg);
const proxy = createProxy({
  idpUpstream: IDP_UPSTREAM,
  webUiUpstream: WEB_UI_UPSTREAM,
  identitySecret: IDENTITY_SECRET,
});

// ───────────────────────── 路由 ─────────────────────────

get("/healthz", (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "gateway", uptime: process.uptime() }));
});

get("/auth/login", (req, res) => void auth.login(req, res));
get("/auth/callback", (req, res) => void auth.callback(req, res));
get("/auth/logout", (req, res) => auth.logout(req, res));
get("/me", (req, res) => auth.me(req, res));

// ───────────────────────── server ─────────────────────────

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // 认证路由优先（精确匹配）
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (!match) continue;
    const params: Params = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1] ?? "");
    });
    try {
      await route.handler(req, res, params);
    } catch (err) {
      console.error(`[gateway] ${method} ${path} failed:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      } else {
        res.end();
      }
    }
    return;
  }

  // /idp/* → IdP
  if (path === "/idp" || path.startsWith("/idp/")) {
    proxy.idp(req, res);
    return;
  }

  // 其余 → Web UI（未登录先跳 /auth/login）
  const session = auth.currentSession(req, Date.now());
  const isStaticLike = method === "GET" && (path.startsWith("/assets/") || path.endsWith(".js") || path.endsWith(".css"));
  if (!session && !isStaticLike) {
    res.writeHead(302, { location: `/auth/login?returnTo=${encodeURIComponent(path)}`, "cache-control": "no-store" });
    res.end();
    return;
  }
  proxy.web(req, res, session);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[gateway] public front door on http://${HOST}:${PORT} (idp=${IDP_UPSTREAM}, web-ui=${WEB_UI_UPSTREAM}, issuer=${IDP_ISSUER})`,
  );
});

server.on("error", (err) => {
  console.error("[gateway] server error:", err);
  process.exit(1);
});
