/**
 * gateway 认证路由 — 参考 qm plugins/portal/src/index.ts 的 authLogin/authCallback
 * 路由：/auth/login?provider=&returnTo= / /auth/callback / /auth/logout / /me
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";
import { json } from "../../core/chassis/src/http.ts";
import { buildAuthorizeUrl, exchangeCode, pkcePair, verifyIdToken, type OidcConfig } from "./oidc.ts";
import { authCopy, otherAuthLocale, resolveAuthLocale, resolveAuthTheme, type AuthLocale, type AuthTheme } from "./auth-copy.ts";
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
    const theme = resolveAuthTheme(url.searchParams.get("theme"));
    const copy = authCopy(locale);
    const provider = url.searchParams.get("provider");
    if (provider !== "github" && provider !== "google" && provider !== "demo") {
      return sendLoginPage(res, returnTo, cfg.providers, locale, theme);
    }
    if (!cfg.providers[provider]) {
      return sendLoginPage(res, returnTo, cfg.providers, locale, theme, copy.providerNotConfigured(provider));
    }
    const loginHint = provider === "demo" ? (url.searchParams.get("email") ?? "").trim().toLowerCase() : "";
    if (provider === "demo" && !validEmail(loginHint)) {
      return sendLoginPage(res, returnTo, cfg.providers, locale, theme, copy.invalidDemoEmail);
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
      theme,
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
    const theme = tmp?.theme ?? resolveAuthTheme(url.searchParams.get("theme"));
    const copy = authCopy(locale);
    const fail = (detail: string): void => {
      res.setHeader("set-cookie", [clearCookie(TMP_COOKIE, "/auth", cfg.secureCookies)]);
      sendErrorPage(res, locale, theme, detail);
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

function authQuery(
  returnTo: string,
  locale: AuthLocale,
  theme: AuthTheme,
  provider?: "github" | "google" | "demo",
): string {
  const params = new URLSearchParams({ returnTo, lang: locale, theme });
  if (provider) params.set("provider", provider);
  return `/auth/login?${params.toString()}`;
}

function themeControls(returnTo: string, locale: AuthLocale, theme: AuthTheme): string {
  const copy = authCopy(locale);
  const items: Array<[AuthTheme, string, string]> = [
    ["light", "☀", copy.themeLight],
    ["system", "◐", copy.themeSystem],
    ["dark", "☾", copy.themeDark],
  ];
  return `<nav class="theme-controls" aria-label="${copy.themeSystem}">${items
    .map(([value, glyph, label]) => `<a href="${authQuery(returnTo, locale, value)}" class="theme-choice${theme === value ? " active" : ""}" aria-label="${label}" title="${label}">${glyph}</a>`)
    .join("")}</nav>`;
}

function authPageCss(): string {
  return `
    :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;--bg:#fff;--surface:#fff;--sidebar:#fafafa;--text:#171717;--muted:#737373;--faint:#a3a3a3;--border:#e5e5e5;--control:#fff;--hover:#f5f5f5;--accent:#7c3aed;--accent-strong:#6d28d9;--accent-soft:#f3e8ff;--demo-border:#ddd6fe;--demo-bg:#faf5ff;--shadow:0 18px 48px rgba(15,23,42,.11)}
    :root[data-theme="dark"]{--bg:#080808;--surface:#101010;--sidebar:#151515;--text:#f5f5f5;--muted:#a3a3a3;--faint:#737373;--border:#292929;--control:#151515;--hover:#1d1d1d;--accent:#8b5cf6;--accent-strong:#a78bfa;--accent-soft:#24143d;--demo-border:#453160;--demo-bg:#171020;--shadow:0 20px 56px rgba(0,0,0,.42)}
    @media(prefers-color-scheme:dark){:root[data-theme="system"]{--bg:#080808;--surface:#101010;--sidebar:#151515;--text:#f5f5f5;--muted:#a3a3a3;--faint:#737373;--border:#292929;--control:#151515;--hover:#1d1d1d;--accent:#8b5cf6;--accent-strong:#a78bfa;--accent-soft:#24143d;--demo-border:#453160;--demo-bg:#171020;--shadow:0 20px 56px rgba(0,0,0,.42)}}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);background:var(--bg);display:grid;place-items:center}main{width:min(100%,960px);padding:28px}.shell{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);overflow:hidden;border:1px solid var(--border);border-radius:18px;background:var(--surface);box-shadow:var(--shadow)}
    .intro{padding:50px 44px;background:var(--sidebar);border-right:1px solid var(--border)}.brand{display:inline-flex;align-items:center;gap:10px;color:var(--text);font-weight:750;letter-spacing:-.02em}.brand-mark{display:grid;place-items:center;width:27px;height:27px;border-radius:6px;background:var(--accent);color:#fff;font-size:12px;font-weight:900}.eyebrow{margin:70px 0 12px;color:var(--accent-strong);font-size:11px;font-weight:800;letter-spacing:.12em}.intro h1{max-width:380px;margin:0;font-size:clamp(30px,4vw,44px);line-height:1.1;letter-spacing:-.05em}.intro p{max-width:360px;margin:18px 0 0;color:var(--muted);font-size:15px}.secure{display:flex;gap:8px;align-items:center;margin-top:56px;color:var(--muted);font-size:12px}.secure:before{content:"✓";display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--accent-soft);color:var(--accent-strong);font-weight:800}
    .card{position:relative;padding:34px}.locale{position:absolute;right:24px;top:22px;color:var(--muted);font-size:12px;text-decoration:none}.locale:hover{color:var(--accent-strong);text-decoration:underline}.theme-controls{position:absolute;left:24px;top:20px;display:inline-flex;padding:3px;border:1px solid var(--border);border-radius:9px;background:var(--sidebar)}.theme-choice{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;color:var(--muted);font-size:13px;text-decoration:none}.theme-choice:hover{background:var(--hover);color:var(--text)}.theme-choice.active{background:var(--surface);box-shadow:0 1px 2px rgba(0,0,0,.1);color:var(--accent-strong)}.card h2{margin:48px 0 6px;font-size:24px;letter-spacing:-.035em}.card .sub{margin:0 0 26px;color:var(--muted);font-size:14px}.provider{display:flex;align-items:center;gap:12px;width:100%;margin:10px 0;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--control);color:var(--text);text-decoration:none;font-weight:650;transition:border-color .15s,background .15s}.provider:hover{border-color:var(--accent);background:var(--hover)}.provider-mark{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);font-size:11px;font-weight:900}.provider.github .provider-mark{background:var(--text);color:var(--surface);border-color:var(--text)}.provider-arrow{margin-left:auto;color:var(--faint);font-size:17px}.divider{display:flex;align-items:center;gap:10px;margin:18px 0;color:var(--faint);font-size:11px}.divider:before,.divider:after{content:"";height:1px;flex:1;background:var(--border)}
    .demo{padding:15px;border:1px solid var(--demo-border);border-radius:12px;background:var(--demo-bg)}.demo-head{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:14px}.demo-head .provider-mark{border:0;background:var(--accent);color:#fff}.demo label{display:block;margin-bottom:6px;color:var(--text);font-size:12px;font-weight:650}.demo input{width:100%;padding:10px 11px;border:1px solid var(--border);border-radius:8px;background:var(--control);color:var(--text);font:inherit}.demo input:focus{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:1px}.demo button{width:100%;margin-top:10px;padding:10px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:750 14px inherit;cursor:pointer}.demo button:hover{background:var(--accent-strong)}.demo p{margin:9px 0 0;color:var(--muted);font-size:12px;line-height:1.45}.notice,.reason{margin:0 0 16px;padding:11px 12px;border-radius:9px;font-size:13px;line-height:1.5}.notice{border:1px solid #eab30855;background:#fefce8;color:#854d0e}.reason{border:1px solid #ef444455;background:#fef2f2;color:#b91c1c}:root[data-theme="dark"] .notice{background:#2a210b;color:#fde68a}:root[data-theme="dark"] .reason{background:#2c1418;color:#fecdd3}.retry{display:inline-flex;margin-top:18px;color:var(--accent-strong);font-weight:650;text-decoration:none}.retry:hover{text-decoration:underline}
    @media(max-width:720px){main{padding:16px}.shell{grid-template-columns:1fr}.intro{padding:28px;border-right:0;border-bottom:1px solid var(--border)}.eyebrow{margin:34px 0 9px}.intro h1{font-size:30px}.secure{margin-top:28px}.card{padding:25px}.card h2{margin-top:48px}}
  `;
}

function sendLoginPage(
  res: ServerResponse,
  returnTo: string,
  providers: GatewayAuthConfig["providers"],
  locale: AuthLocale,
  theme: AuthTheme,
  notice = "",
): void {
  const copy = authCopy(locale);
  const githubHref = authQuery(returnTo, locale, theme, "github");
  const googleHref = authQuery(returnTo, locale, theme, "google");
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
        <input type="hidden" name="provider" value="demo"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><input type="hidden" name="lang" value="${locale}"><input type="hidden" name="theme" value="${theme}">
        <div class="demo-head"><span class="provider-mark">DE</span><strong>${copy.demoTitle}</strong></div>
        <label for="demo-email">${copy.demoEmailLabel}</label>
        <input id="demo-email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="${copy.demoEmailPlaceholder}" required maxlength="254">
        <button type="submit">${copy.demoContinue}</button>
        <p>${copy.demoHint}</p>
      </form>`
    : "";
  const providersHtml = demoCard || buttons ? `${demoCard}${demoCard && buttons ? '<div class="divider">OAuth</div>' : ""}${buttons}` : `<p class="notice">${copy.noProvider}</p>`;
  const noticeHtml = notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : "";
  const switchHref = authQuery(returnTo, otherAuthLocale(locale), theme);
  const themesHtml = themeControls(returnTo, locale, theme);
  const html = `<!doctype html><html lang="${copy.htmlLang}" data-theme="${theme}"><meta charset="utf-8"><title>${copy.signInTitle} · OpenPilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${authPageCss()}</style>
<main><div class="shell"><section class="intro"><div class="brand"><span class="brand-mark">OP</span><span>OpenPilot</span></div><p class="eyebrow">${copy.brandKicker}</p><h1>${copy.signInTitle}</h1><p>${copy.signInSubtitle}</p><div class="secure">${copy.secureNote}</div></section>
<section class="card" aria-label="${copy.signInTitle}">${themesHtml}<a class="locale" href="${switchHref}" aria-label="${copy.languageLabel}">${copy.switchLanguage}</a><h2>${copy.signInTitle}</h2><p class="sub">${copy.signInSubtitle}</p>${noticeHtml}${providersHtml}</section></div></main></html>`;
  sendAuthHtml(res, 200, html);
}

function sendErrorPage(res: ServerResponse, locale: AuthLocale, theme: AuthTheme, detail: string): void {
  const copy = authCopy(locale);
  const retryHref = authQuery("/", locale, theme);
  const switchHref = authQuery("/", otherAuthLocale(locale), theme);
  const themesHtml = themeControls("/", locale, theme);
  const html = `<!doctype html><html lang="${copy.htmlLang}" data-theme="${theme}"><meta charset="utf-8"><title>${copy.errorTitle} · OpenPilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${authPageCss()}</style>
<main><div class="shell"><section class="intro"><div class="brand"><span class="brand-mark">OP</span><span>OpenPilot</span></div><p class="eyebrow">${copy.brandKicker}</p><h1>${copy.errorTitle}</h1><p>${copy.signInSubtitle}</p><div class="secure">${copy.secureNote}</div></section>
<section class="card" aria-label="${copy.errorTitle}">${themesHtml}<a class="locale" href="${switchHref}" aria-label="${copy.languageLabel}">${copy.switchLanguage}</a><h2>${copy.errorTitle}</h2><p class="sub">OpenPilot</p><p class="reason" role="alert">${escapeHtml(detail)}</p><a class="retry" href="${retryHref}">← ${copy.retry}</a></section></div></main></html>`;
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
