/**
 * gateway 认证路由 — 参考 qm plugins/portal/src/index.ts 的 authLogin/authCallback
 * 路由：/auth/login?provider=&returnTo= / /auth/callback / /auth/logout / /me
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";
import { json } from "../../core/chassis/src/http.ts";
import { buildAuthorizeUrl, exchangeCode, pkcePair, verifyIdToken, type OidcConfig } from "./oidc.ts";
import {
  clearCookie,
  deriveKey,
  openTmp,
  openSession,
  randomToken,
  readCookie,
  sanitizeReturnTo,
  seal,
  setCookie,
  type SessionClaims,
} from "./session.ts";

export interface GatewayAuthConfig {
  publicUrl: string;
  oidc: OidcConfig;
  sessionSecret: string;
  tmpTtlS: number;
  sessionTtlS: number;
  secureCookies: boolean;
}

const TMP_COOKIE = "gateway_oidc_tmp";
const SESSION_COOKIE = "gateway_session";

/** state 防重放：一次性消费，短 TTL */
function createStateCache(ttlMs: number): { consume(state: string): boolean; add(state: string): void } {
  const cache = new LRUCache<string, number>({ max: 5000, ttl: ttlMs });
  return {
    add(state: string) {
      cache.set(state, Date.now());
    },
    consume(state: string): boolean {
      const found = cache.has(state);
      if (found) cache.delete(state);
      return found;
    },
  };
}

export function createAuthHandlers(cfg: GatewayAuthConfig) {
  const sessionKey = deriveKey(cfg.sessionSecret, "gateway.session.v1");
  const tmpKey = deriveKey(cfg.sessionSecret, "gateway.tmp.v1");
  const states = createStateCache(cfg.tmpTtlS * 1000 + 30_000);

  function currentSession(req: IncomingMessage, now: number): SessionClaims | null {
    return openSession(readCookie(req.headers.cookie, SESSION_COOKIE), sessionKey, now, "local");
  }

  function setSessionCookies(res: ServerResponse, claims: SessionClaims, extra: string[] = []): void {
    res.setHeader("set-cookie", [
      setCookie(SESSION_COOKIE, seal(claims, sessionKey), {
        path: "/",
        maxAge: claims.exp - Math.floor(Date.now() / 1000),
        secure: cfg.secureCookies,
      }),
      ...extra,
    ]);
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", cfg.publicUrl);
    const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"), cfg.publicUrl);
    const provider = url.searchParams.get("provider");
    if (provider !== "github" && provider !== "google") {
      return sendLoginPage(res, returnTo);
    }
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkcePair();
    const now = Math.floor(Date.now() / 1000);
    const tmp = {
      k: "tmp",
      state,
      nonce,
      pkceVerifier: verifier,
      returnTo,
      provider,
      iat: now,
      exp: now + cfg.tmpTtlS,
    };
    states.add(state);
    res.setHeader("set-cookie", [
      setCookie(TMP_COOKIE, seal(tmp, tmpKey), { path: "/auth", maxAge: cfg.tmpTtlS, secure: cfg.secureCookies }),
    ]);
    res.writeHead(302, {
      location: buildAuthorizeUrl(cfg.oidc, { state, nonce, challenge, provider }),
      "cache-control": "no-store",
    });
    res.end();
  }

  async function callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (detail: string): void => {
      res.setHeader("set-cookie", [clearCookie(TMP_COOKIE, "/auth", cfg.secureCookies)]);
      sendErrorPage(res, "Sign-in failed", detail);
    };

    const url = new URL(req.url ?? "/", cfg.publicUrl);
    if (url.searchParams.get("error")) return fail(`identity provider returned: ${url.searchParams.get("error")}`);
    const code = url.searchParams.get("code") ?? "";
    const stateParam = url.searchParams.get("state") ?? "";
    const tmp = openTmp(readCookie(req.headers.cookie, TMP_COOKIE), tmpKey, Date.now());
    if (!tmp) return fail("login session expired — please try again");
    if (!code || !stateParam || !safeEqual(stateParam, tmp.state)) return fail("invalid login state");
    if (!states.consume(stateParam)) return fail("login already used — please try again");

    let principal: string;
    let name = "";
    try {
      const { idToken } = await exchangeCode(cfg.oidc, { code, codeVerifier: tmp.pkceVerifier });
      const claims = await verifyIdToken(cfg.oidc, idToken, tmp.nonce);
      const email = claims.email;
      if (typeof email !== "string" || !email.includes("@")) throw new Error("identity provider returned no email");
      principal = email.trim().toLowerCase();
      const rawName = claims.name;
      if (typeof rawName === "string") name = rawName.trim().slice(0, 200);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "sign-in failed");
    }

    const now = Math.floor(Date.now() / 1000);
    const session: SessionClaims = {
      k: "session",
      sub: principal,
      org: "local",
      ...(name ? { name } : {}),
      auth: now,
      iat: now,
      exp: now + cfg.sessionTtlS,
    };
    setSessionCookies(res, session, [clearCookie(TMP_COOKIE, "/auth", cfg.secureCookies)]);
    res.writeHead(302, { location: sanitizeReturnTo(tmp.returnTo, cfg.publicUrl), "cache-control": "no-store" });
    res.end();
  }

  function logout(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", cfg.publicUrl);
    const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"), cfg.publicUrl);
    res.setHeader("set-cookie", [clearCookie(SESSION_COOKIE, "/", cfg.secureCookies)]);
    res.writeHead(302, { location: returnTo, "cache-control": "no-store" });
    res.end();
  }

  function me(req: IncomingMessage, res: ServerResponse): void {
    const session = currentSession(req, Date.now());
    if (!session) return json(res, 401, { error: "sign in", mode: "portal", reason: "unauthenticated" });
    // web-ui 前端期望的 Me 结构（含 user 字段）
    return json(res, 200, {
      user: session.sub,
      org: "local",
      mode: "portal",
      slackWorkspaceUrl: null,
      impersonatedBy: null,
      permissions: [],
      ...(session.name ? { name: session.name } : {}),
    });
  }

  return { login, callback, logout, me, currentSession, setSessionCookies };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sendLoginPage(res: ServerResponse, returnTo: string): void {
  const githubHref = `/auth/login?provider=github&returnTo=${encodeURIComponent(returnTo)}`;
  const googleHref = `/auth/login?provider=google&returnTo=${encodeURIComponent(returnTo)}`;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Sign in · OpenPilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;background:#0f1117;color:#e6e6e6;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh}
  main{margin:auto;padding:24px;width:100%;max-width:400px}
  .card{background:#1a1d27;border:1px solid #2a2e3d;border-radius:14px;padding:36px 30px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
  h1{font-size:22px;margin:0 0 6px}
  p.sub{color:#9aa0ae;margin:0 0 26px;font-size:14px}
  a.btn{display:flex;align-items:center;gap:12px;margin:10px 0;padding:12px 16px;border-radius:10px;text-decoration:none;color:#fff;font-weight:600;font-size:15px;border:1px solid #2a2e3d;background:#22263a}
  a.btn:hover{border-color:#3b82f6;background:#262b44}
  a.btn .dot{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px}
  .gh{background:#24292e}.gh .dot{background:#333}.gg{background:#1a73e8}.gg .dot{background:#fff;color:#1a73e8}
</style>
<main><div class="card">
  <h1>Sign in to OpenPilot</h1>
  <p class="sub">Choose how you'd like to continue</p>
  <a class="btn gh" href="${githubHref}"><span class="dot">GH</span> Continue with GitHub</a>
  <a class="btn gg" href="${googleHref}"><span class="dot">G</span> Continue with Google</a>
</div></main></html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow",
  });
  res.end(html);
}

function sendErrorPage(res: ServerResponse, heading: string, detail: string): void {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${heading}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;background:#0f1117;color:#e6e6e6;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh}
  main{margin:auto;padding:24px;width:100%;max-width:400px}
  .card{background:#1a1d27;border:1px solid #2a2e3d;border-radius:14px;padding:36px 30px}
  h1{font-size:20px;margin:0 0 10px}
  .reason{color:#fca5a5;background:#2a1218;border:1px solid #5b1c26;border-radius:10px;padding:12px 14px;font-size:14px}
  a{color:#60a5fa}
</style>
<main><div class="card"><h1>${escapeHtml(heading)}</h1><p class="reason">${escapeHtml(detail)}</p>
<p><a href="/auth/login">Try signing in again</a></p></div></main></html>`;
  res.writeHead(400, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow",
  });
  res.end(html);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
