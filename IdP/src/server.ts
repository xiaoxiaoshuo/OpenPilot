/**
 * IdP HTTP 端点 — 对外为标准 OIDC IdP（接口与 qm plugins/auth 保持一致）：
 *   GET  /.well-known/openid-configuration
 *   GET  /.well-known/jwks.json
 *   GET  /authorize            （校验参数后 302 到 GitHub/Google）
 *   GET  /callback/github      （第三方回调，内部）
 *   GET  /callback/google      （第三方回调，内部）
 *   POST /token                （code 换 token）
 *   GET|POST /userinfo
 *   GET  /healthz
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { json, readBody } from "../../core/chassis/src/http.ts";
import type { IdpConfig, ProviderKind } from "./config.ts";
import { emailAllowed, validEmail } from "./config.ts";
import type { ClaimStore } from "./claims.ts";
import { claimOnce } from "./claims.ts";
import type { SigningKey } from "./keys.ts";
import { mintIdToken, pkceMatches, safeEqual, subjectFor, TokenSigner, type AuthRequest } from "./tokens.ts";
import { githubAuthorizeUrl, githubExchangeCode } from "./providers/github.ts";
import { googleAuthorizeUrl, googleExchangeCode } from "./providers/google.ts";
import { problemPage, PAGE_CSP } from "./pages.ts";

const MAX_FORM_BYTES = 100_000;
const ID_TOKEN_TTL_S = 3600;
const PENDING_TTL_MS = 10 * 60_000; // pending request 10 分钟

interface PendingRequest {
  request: AuthRequest;
  provider: ProviderKind;
  at: number;
}

function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  if (!header || !/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  return { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

function readAuthorizeRequest(
  cfg: IdpConfig,
  params: URLSearchParams,
): { request: AuthRequest } | { problem: string } {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!clientId || !safeEqual(clientId, cfg.clientId))
    return { problem: "This sign-in request is for an unknown application." };
  if (!redirectUri || !safeEqual(redirectUri, cfg.redirectUri))
    return { problem: "This sign-in request would return you to an address that is not registered." };
  if ((params.get("response_type") ?? "") !== "code")
    return { problem: "Only the authorization-code flow is supported." };
  if ((params.get("code_challenge_method") ?? "") !== "S256")
    return { problem: "This sign-in request must use PKCE with S256." };
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge))
    return { problem: "This sign-in request carries a malformed PKCE challenge." };
  const state = params.get("state") ?? "";
  const nonce = params.get("nonce") ?? "";
  if (!state || state.length > 512) return { problem: "This sign-in request is missing its state." };
  if (!nonce || nonce.length > 512) return { problem: "This sign-in request is missing its nonce." };
  const scope = params.get("scope") ?? "openid";
  if (!scope.split(/\s+/).includes("openid")) return { problem: "This sign-in request must ask for the openid scope." };
    const provider = params.get("provider");
  if (provider !== "github" && provider !== "google")
    return { problem: "This sign-in request must name a provider (github or google)." };
  if (
    (provider === "github" && (!cfg.githubClientId || !cfg.githubClientSecret)) ||
    (provider === "google" && (!cfg.googleClientId || !cfg.googleClientSecret))
  )
    return { problem: `This provider (${provider}) is not configured on the identity provider.` };
  return { request: { clientId, redirectUri, state, nonce, codeChallenge, scope } };
}

export function createIdpHandler(deps: {
  cfg: IdpConfig;
  signer: TokenSigner;
  claims: ClaimStore;
  signingKey: SigningKey;
  now?: () => number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { cfg, signer, claims, signingKey } = deps;
  const now = deps.now ?? Date.now;
  const pending = new Map<string, PendingRequest>();
  let nextPendingPrune = 0;

  const prunePending = (): void => {
    const t = now();
    if (t < nextPendingPrune) return;
    nextPendingPrune = t + 60_000;
    for (const [state, p] of pending) {
      if (p.at + PENDING_TTL_MS < t) pending.delete(state);
    }
  };

  const problem = (res: ServerResponse, status: number, heading: string, msg: string, detail?: string): void =>
    sendHtml(res, status, problemPage({ brandName: cfg.brandName, heading, msg, ...(detail ? { detail } : {}) }));

  const takePending = (req: IncomingMessage): PendingRequest | null => {
    prunePending();
    const raw = new URL(req.url ?? "/", "http://idp.local").searchParams.get("state") ?? "";
    const p = pending.get(raw);
    if (!p) return null;
    pending.delete(raw);
    return p;
  };

  async function authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://idp.local");
    const params = url.searchParams;
    const parsed = readAuthorizeRequest(cfg, params);
    if ("problem" in parsed)
      return problem(
        res,
        400,
        "This sign-in request isn't valid",
        "Start again from the page you were trying to reach.",
        parsed.problem,
      );
    const provider = params.get("provider") as ProviderKind;
    const request = parsed.request;
    // 保存 pending（按 state 索引），回调时凭 state 取回 nonce / codeChallenge / redirectUri
    pending.set(request.state, { request, provider, at: now() });
    prunePending();

    const scope = provider === "github" ? "read:user user:email" : "openid email profile";
    let location: string;
    if (provider === "github") {
      location = githubAuthorizeUrl(cfg, { state: request.state, scope });
    } else {
      location = googleAuthorizeUrl(cfg, { state: request.state, nonce: request.nonce, scope });
    }
    res.writeHead(302, { location, "cache-control": "no-store" });
    res.end();
  }

  async function providerCallback(req: IncomingMessage, res: ServerResponse, provider: ProviderKind): Promise<void> {
    const fail = (detail: string): Promise<void> =>
      Promise.resolve(problem(res, 400, "This sign-in request no longer works", "Start again.", detail));

    const url = new URL(req.url ?? "/", "http://idp.local");
    if (url.searchParams.get("error")) {
      return fail(`provider returned: ${url.searchParams.get("error")} ${url.searchParams.get("error_description") ?? ""}`);
    }
    const code = url.searchParams.get("code") ?? "";
    if (!code) return fail("provider did not return a code");
    const pendingReq = takePending(req);
    if (!pendingReq) return fail("unknown or expired sign-in request");
    if (pendingReq.provider !== provider) return fail("sign-in provider mismatch");

    // 用第三方 code 换取身份
    let identity: { providerSub: string; principal: string; name: string };
    try {
      if (provider === "github") {
        identity = await githubExchangeCode(cfg, code);
      } else {
        identity = await googleExchangeCode(cfg, code, pendingReq.request.nonce);
      }
    } catch (e) {
      console.error(`[idp] ${provider} exchange failed:`, e instanceof Error ? e.message : e);
      return fail(`sign-in with ${provider} failed`);
    }

    if (!validEmail(identity.principal)) return fail(`${provider} returned an unusable email address`);
    if (!emailAllowed(cfg, identity.principal)) {
      console.warn(`[idp] sign-in suppressed: ${identity.principal} is not on the permitted list`);
      return fail("your administrator has not allowed this email address");
    }

    const codeToken = await signer.sealCode(
      {
        clientId: pendingReq.request.clientId,
        redirectUri: pendingReq.request.redirectUri,
        state: pendingReq.request.state,
        scope: pendingReq.request.scope,
        nonce: pendingReq.request.nonce,
        codeChallenge: pendingReq.request.codeChallenge,
        principal: identity.principal,
        providerSub: identity.providerSub,
        provider,
      },
      cfg.codeTtlS,
      now(),
    );
    const destination = new URL(pendingReq.request.redirectUri);
    destination.searchParams.set("code", codeToken.token);
    destination.searchParams.set("state", pendingReq.request.state);
    res.writeHead(302, { location: destination.toString(), "cache-control": "no-store" });
    res.end();
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credentials = basicCredentials(req.headers.authorization);
    const idOk = credentials !== null && safeEqual(credentials.id, cfg.clientId);
    const secretOk = credentials !== null && safeEqual(credentials.secret, cfg.clientSecret);
    if (!idOk || !secretOk) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Basic realm="openpilot-idp"` });
      return void res.end(JSON.stringify({ error: "invalid_client" }));
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch {
      return sendJson(res, 400, { error: "invalid_request" });
    }
    const form = new URLSearchParams(raw);
    if (form.get("grant_type") !== "authorization_code") return sendJson(res, 400, { error: "unsupported_grant_type" });
    const opened = await signer.openCode(form.get("code") ?? "", now());
    if (!opened) return sendJson(res, 400, { error: "invalid_grant" });
    const { claims: granted } = opened;
    const redirectUri = form.get("redirect_uri") ?? "";
    if (
      !safeEqual(granted.clientId, cfg.clientId) ||
      !safeEqual(granted.redirectUri, redirectUri) ||
      !safeEqual(redirectUri, cfg.redirectUri)
    ) {
      return sendJson(res, 400, { error: "invalid_grant" });
    }
    if (!(await claimOnce(claims, `code:${opened.jti}`, opened.expiresAtMs)))
      return sendJson(res, 400, { error: "invalid_grant" });
    if (!pkceMatches(form.get("code_verifier") ?? "", granted.codeChallenge))
      return sendJson(res, 400, { error: "invalid_grant" });
    if (!emailAllowed(cfg, granted.principal)) return sendJson(res, 400, { error: "invalid_grant" });

    const nowMs = now();
    const sub = subjectFor(cfg.issuer, granted.principal);
    const idToken = await mintIdToken(signingKey, {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      sub,
      principal: granted.principal,
      nonce: granted.nonce,
      ttlS: ID_TOKEN_TTL_S,
      nowMs,
    });
    const access = await signer.sealAccess({ sub, principal: granted.principal }, cfg.accessTtlS, nowMs);
    return sendJson(res, 200, {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: cfg.accessTtlS,
      id_token: idToken,
      scope: "openid email",
    });
  }

  async function userinfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization ?? "";
    if (!/^bearer /i.test(header)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      return void res.end(JSON.stringify({ error: "invalid_token" }));
    }
    const opened = await signer.openAccess(header.slice(7).trim(), now());
    if (!opened) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer error="invalid_token"` });
      return void res.end(JSON.stringify({ error: "invalid_token" }));
    }
    return sendJson(res, 200, { sub: opened.sub, email: opened.principal, email_verified: true });
  }

  function discovery(res: ServerResponse): void {
    sendJson(res, 200, {
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/authorize`,
      token_endpoint: `${cfg.issuer}/token`,
      userinfo_endpoint: `${cfg.issuer}/userinfo`,
      jwks_uri: `${cfg.issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [signingKey.publicJwk.alg ?? "ES256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
  }

  return async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://idp.local");
      const path = url.pathname;

      if (method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
      if (method === "GET" && path === "/.well-known/jwks.json") {
        return sendJson(res, 200, { keys: [signingKey.publicJwk] });
      }
      if (method === "GET" && path === "/.well-known/openid-configuration") return discovery(res);
      if (method === "GET" && path === "/authorize") return authorize(req, res);
      if (method === "GET" && path === "/callback/github") return providerCallback(req, res, "github");
      if (method === "GET" && path === "/callback/google") return providerCallback(req, res, "google");
      if (method === "POST" && path === "/token") return token(req, res);
      if ((method === "GET" || method === "POST") && path === "/userinfo") return userinfo(req, res);

      sendJson(res, 404, { error: "not_found", path });
    } catch (err) {
      console.error(`[idp] 500 ${req.method ?? "?"} ${(req.url ?? "?").split("?")[0]}:`, err);
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      else res.end();
    }
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "content-security-policy": PAGE_CSP,
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow",
  });
  res.end(html);
}

export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}
