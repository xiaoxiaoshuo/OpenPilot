/**
 * OIDC Client — 参考 qm plugins/portal/src/oidc.ts
 * 对接 OpenPilot IdP（:8201，经 gateway /idp/* 对外暴露，issuer 为 http://127.0.0.1:8200/idp）
 */
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OidcConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  issuer: string;
  jwksUri: string;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  cfg: OidcConfig,
  args: { state: string; nonce: string; challenge: string; provider: string },
): string {
  const u = new URL(cfg.authEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", args.state);
  u.searchParams.set("nonce", args.nonce);
  u.searchParams.set("code_challenge", args.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("provider", args.provider);
  return u.toString();
}

export interface TokenResponse {
  accessToken: string;
  idToken: string | null;
}

export async function exchangeCode(
  cfg: OidcConfig,
  args: { code: string; codeVerifier: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: cfg.redirectUri,
    code_verifier: args.codeVerifier,
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const r = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
      accept: "application/json",
    },
    body: body.toString(),
  });
  const json = await readJson(r, "token endpoint");
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("token response missing access_token");
  return { accessToken, idToken: typeof json.id_token === "string" ? json.id_token : null };
}

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyIdToken(
  cfg: OidcConfig,
  idToken: string | null,
  nonce: string,
): Promise<Record<string, unknown>> {
  if (!idToken) throw new Error("token response missing id_token");
  const keySet =
    remoteKeySets.get(cfg.jwksUri) ??
    (() => {
      const created = createRemoteJWKSet(new URL(cfg.jwksUri));
      remoteKeySets.set(cfg.jwksUri, created);
      return created;
    })();
  const { payload } = await jwtVerify(idToken, keySet, {
    issuer: cfg.issuer,
    audience: cfg.clientId,
    algorithms: ["RS256", "ES256", "EdDSA"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    clockTolerance: 5,
  });
  if (payload.nonce !== nonce) throw new Error("nonce mismatch");
  return payload as Record<string, unknown>;
}

async function readJson(r: Response, what: string): Promise<Record<string, unknown>> {
  const text = await r.text();
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${what} returned non-JSON (HTTP ${r.status})`);
  }
}
