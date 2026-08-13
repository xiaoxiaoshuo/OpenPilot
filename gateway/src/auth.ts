/**
 * gateway 认证路由 — 参考 qm plugins/portal/src/index.ts 的 authLogin/authCallback
 * 路由：/auth/login?provider=&returnTo= / /auth/callback / /auth/logout / /me
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";
import { json } from "../../core/chassis/src/http.ts";
import { buildAuthorizeUrl, exchangeCode, pkcePair, verifyIdToken, type OidcConfig } from "./oidc.ts";
import { authCopy, otherAuthLocale, resolveAuthLocale, type AuthLocale } from "./auth-copy.ts";
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
  /** 仅展示 IdP 已配置的第三方登录入口，避免跳转到不可用 provider。 */
  providers: {
    github: boolean;
    google: boolean;
    demo: boolean;
  };
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
    const locale = resolveAuthLocale(url.searchParams.get("lang"), req.headers["accept-language"]);
    const copy = authCopy(locale);
    const provider = url.searchParams.get("provider");
    if (provider !== "github" && provider !== "google" && provider !== "demo") {
      return sendLoginPage(res, returnTo, cfg.providers, locale);
    }
    if (!cfg.providers[provider]) {
      return sendLoginPage(res, returnTo, cfg.providers, locale, copy.providerNotConfigured(provider));
    }
    const loginHint = provider === "demo" ? (url.searchParams.get("email") ?? "").trim().toLowerCase() : "";
    if (provider === "demo" && !validEmail(loginHint)) {
      return sendLoginPage(res, returnTo, cfg.providers, locale, copy.invalidDemoEmail);
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
      locale,
      iat: now,
      exp: now + cfg.tmpTtlS,
    };
    states.add(state);
    res.setHeader("set-cookie", [
      setCookie(TMP_COOKIE, seal(tmp, tmpKey), { path: "/auth", maxAge: cfg.tmpTtlS, secure: cfg.secureCookies }),
    ]);
    res.writeHead(302, {
      location: buildAuthorizeUrl(cfg.oidc, { state, nonce, challenge, provider, ...(loginHint ? { loginHint } : {}) }),
      "cache-control": "no-store",
    });
    res.end();
  }

  async function callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", cfg.publicUrl);
    const tmp = openTmp(readCookie(req.headers.cookie, TMP_COOKIE), tmpKey, Date.now());
    const locale = tmp?.locale ?? resolveAuthLocale(url.searchParams.get("lang"), req.headers["accept-language"]);
    const copy = authCopy(locale);
    const fail = (detail: string): void => {
      res.setHeader("set-cookie", [clearCookie(TMP_COOKIE, "/auth", cfg.secureCookies)]);
      sendErrorPage(res, locale, detail);
    };

    if (url.searchParams.get("error")) return fail(copy.providerReturnedError);
    const code = url.searchParams.get("code") ?? "";
    const stateParam = url.searchParams.get("state") ?? "";
    if (!tmp) return fail(copy.loginExpired);
    if (!code || !stateParam || !safeEqual(stateParam, tmp.state)) return fail(copy.invalidState);
    if (!states.consume(stateParam)) return fail(copy.loginUsed);

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
    } catch {
      return fail(copy.genericSignInFailure);
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

function authQuery(returnTo: string, locale: AuthLocale, provider?: "github" | "google" | "demo"): string {
  const params = new URLSearchParams({ returnTo, lang: locale });
  if (provider) params.set("provider", provider);
  return `/auth/login?${params.toString()}`;
}

function authPageCss(): string {
  return `
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;color:#f7f8fc;background:#070b16;display:grid;place-items:center;overflow-x:hidden}
    body:before,body:after{content:"";position:fixed;width:38rem;height:38rem;border-radius:50%;filter:blur(72px);opacity:.34;pointer-events:none}body:before{top:-20rem;left:-16rem;background:#2563eb}body:after{right:-18rem;bottom:-22rem;background:#0d9488}
    main{position:relative;width:min(100%,960px);padding:28px}.shell{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);overflow:hidden;border:1px solid rgba(148,163,184,.22);border-radius:24px;background:rgba(15,23,42,.82);box-shadow:0 28px 90px rgba(0,0,0,.46);backdrop-filter:blur(18px)}
    .intro{padding:50px 44px;background:linear-gradient(145deg,rgba(37,99,235,.26),rgba(15,23,42,.2) 54%,rgba(13,148,136,.16));border-right:1px solid rgba(148,163,184,.16)}.brand{display:inline-flex;align-items:center;gap:10px;color:#fff;font-weight:750;letter-spacing:-.02em}.brand-mark{display:grid;place-items:center;width:31px;height:31px;border-radius:10px;background:linear-gradient(135deg,#60a5fa,#2dd4bf);color:#082f49;font-size:12px;font-weight:900}.eyebrow{margin:70px 0 12px;color:#93c5fd;font-size:11px;font-weight:800;letter-spacing:.12em}.intro h1{max-width:380px;margin:0;font-size:clamp(30px,4vw,44px);line-height:1.1;letter-spacing:-.05em}.intro p{max-width:360px;margin:18px 0 0;color:#cbd5e1;font-size:15px}.secure{display:flex;gap:8px;align-items:center;margin-top:56px;color:#94a3b8;font-size:12px}.secure:before{content:"✓";display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:rgba(45,212,191,.16);color:#5eead4;font-weight:800}
    .card{position:relative;padding:34px}.locale{position:absolute;right:24px;top:22px;border:1px solid rgba(148,163,184,.26);border-radius:999px;padding:6px 10px;color:#cbd5e1;background:rgba(30,41,59,.68);font-size:12px;text-decoration:none}.locale:hover{border-color:#60a5fa;color:#fff}.card h2{margin:34px 0 6px;font-size:24px;letter-spacing:-.035em}.card .sub{margin:0 0 26px;color:#94a3b8;font-size:14px}.provider{display:flex;align-items:center;gap:12px;width:100%;margin:10px 0;padding:12px 14px;border:1px solid rgba(148,163,184,.25);border-radius:12px;background:rgba(30,41,59,.62);color:#f8fafc;text-decoration:none;font-weight:650;transition:border-color .15s,transform .15s,background .15s}.provider:hover{border-color:#60a5fa;background:#26334b;transform:translateY(-1px)}.provider-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:#f8fafc;color:#0f172a;font-size:11px;font-weight:900}.provider.github .provider-mark{background:#111827;color:#fff;border:1px solid #475569}.provider-arrow{margin-left:auto;color:#94a3b8;font-size:17px}.divider{display:flex;align-items:center;gap:10px;margin:18px 0;color:#64748b;font-size:11px}.divider:before,.divider:after{content:"";height:1px;flex:1;background:rgba(148,163,184,.18)}
    .demo{padding:15px;border:1px solid rgba(45,212,191,.32);border-radius:14px;background:linear-gradient(145deg,rgba(20,184,166,.13),rgba(15,23,42,.4))}.demo-head{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:14px}.demo-head .provider-mark{background:#5eead4;color:#134e4a}.demo label{display:block;margin-bottom:6px;color:#cbd5e1;font-size:12px;font-weight:650}.demo input{width:100%;padding:10px 11px;border:1px solid rgba(148,163,184,.34);border-radius:9px;background:#0b1220;color:#f8fafc;font:inherit}.demo input:focus{outline:2px solid #2dd4bf;outline-offset:1px}.demo button{width:100%;margin-top:10px;padding:10px 12px;border:0;border-radius:9px;background:#5eead4;color:#134e4a;font:750 14px inherit;cursor:pointer}.demo button:hover{background:#99f6e4}.demo p{margin:9px 0 0;color:#a7c8c8;font-size:12px;line-height:1.45}.notice,.reason{margin:0 0 16px;padding:11px 12px;border-radius:10px;font-size:13px;line-height:1.5}.notice{border:1px solid rgba(251,191,36,.36);background:rgba(120,53,15,.26);color:#fde68a}.reason{border:1px solid rgba(251,113,133,.38);background:rgba(127,29,29,.24);color:#fecdd3}.retry{display:inline-flex;margin-top:18px;color:#93c5fd;font-weight:650;text-decoration:none}.retry:hover{text-decoration:underline}
    @media(max-width:720px){main{padding:16px}.shell{grid-template-columns:1fr}.intro{padding:28px;border-right:0;border-bottom:1px solid rgba(148,163,184,.16)}.eyebrow{margin:34px 0 9px}.intro h1{font-size:30px}.secure{margin-top:28px}.card{padding:25px}.card h2{margin-top:28px}}
  `;
}

function sendLoginPage(
  res: ServerResponse,
  returnTo: string,
  providers: GatewayAuthConfig["providers"],
  locale: AuthLocale,
  notice = "",
): void {
  const copy = authCopy(locale);
  const githubHref = authQuery(returnTo, locale, "github");
  const googleHref = authQuery(returnTo, locale, "google");
  const buttons = [
    providers.github
      ? `<a class="provider github" href="${githubHref}"><span class="provider-mark">GH</span><span>${copy.github}</span><span class="provider-arrow">→</span></a>`
      : "",
    providers.google
      ? `<a class="provider google" href="${googleHref}"><span class="provider-mark">G</span><span>${copy.google}</span><span class="provider-arrow">→</span></a>`
      : "",
  ].join("");
  const demoCard = providers.demo
    ? `<form class="demo" method="get" action="/auth/login">
        <input type="hidden" name="provider" value="demo"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><input type="hidden" name="lang" value="${locale}">
        <div class="demo-head"><span class="provider-mark">DE</span><strong>${copy.demoTitle}</strong></div>
        <label for="demo-email">${copy.demoEmailLabel}</label>
        <input id="demo-email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="${copy.demoEmailPlaceholder}" required maxlength="254">
        <button type="submit">${copy.demoContinue}</button>
        <p>${copy.demoHint}</p>
      </form>`
    : "";
  const providersHtml = demoCard || buttons ? `${demoCard}${demoCard && buttons ? '<div class="divider">OAuth</div>' : ""}${buttons}` : `<p class="notice">${copy.noProvider}</p>`;
  const noticeHtml = notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : "";
  const switchHref = authQuery(returnTo, otherAuthLocale(locale));
  const html = `<!doctype html><html lang="${copy.htmlLang}"><meta charset="utf-8"><title>${copy.signInTitle} · OpenPilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${authPageCss()}</style>
<main><div class="shell"><section class="intro"><div class="brand"><span class="brand-mark">OP</span><span>OpenPilot</span></div><p class="eyebrow">${copy.brandKicker}</p><h1>${copy.signInTitle}</h1><p>${copy.signInSubtitle}</p><div class="secure">${copy.secureNote}</div></section>
<section class="card" aria-label="${copy.signInTitle}"><a class="locale" href="${switchHref}" aria-label="${copy.languageLabel}">${copy.switchLanguage}</a><h2>${copy.signInTitle}</h2><p class="sub">${copy.signInSubtitle}</p>${noticeHtml}${providersHtml}</section></div></main></html>`;
  sendAuthHtml(res, 200, html);
}

function sendErrorPage(res: ServerResponse, locale: AuthLocale, detail: string): void {
  const copy = authCopy(locale);
  const retryHref = authQuery("/", locale);
  const switchHref = authQuery("/", otherAuthLocale(locale));
  const html = `<!doctype html><html lang="${copy.htmlLang}"><meta charset="utf-8"><title>${copy.errorTitle} · OpenPilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${authPageCss()}</style>
<main><div class="shell"><section class="intro"><div class="brand"><span class="brand-mark">OP</span><span>OpenPilot</span></div><p class="eyebrow">${copy.brandKicker}</p><h1>${copy.errorTitle}</h1><p>${copy.signInSubtitle}</p><div class="secure">${copy.secureNote}</div></section>
<section class="card" aria-label="${copy.errorTitle}"><a class="locale" href="${switchHref}" aria-label="${copy.languageLabel}">${copy.switchLanguage}</a><h2>${copy.errorTitle}</h2><p class="sub">OpenPilot</p><p class="reason" role="alert">${escapeHtml(detail)}</p><a class="retry" href="${retryHref}">← ${copy.retry}</a></section></div></main></html>`;
  sendAuthHtml(res, 400, html);
}

function sendAuthHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow",
  });
  res.end(html);
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>\"]+@[^@\s,;<>\"]+\.[^@\s,;<>\"]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
