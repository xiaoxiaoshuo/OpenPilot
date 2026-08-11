/**
 * Google OIDC Provider — Authorization Code + nonce 校验
 * 文档：skills/google-sso-login/SKILL.md
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdpConfig } from "../config.ts";
import type { ProviderUser } from "./github.ts";

export function googleAuthorizeUrl(
  cfg: IdpConfig,
  args: { state: string; nonce: string; scope: string },
): string {
  const params = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: cfg.googleCallbackUri,
    response_type: "code",
    scope: args.scope,
    state: args.state,
    nonce: args.nonce,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface GoogleTokenResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function googleExchangeCode(
  cfg: IdpConfig,
  code: string,
  expectedNonce: string,
): Promise<ProviderUser> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      redirect_uri: cfg.googleCallbackUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`google token endpoint HTTP ${tokenRes.status}`);
  const body = (await tokenRes.json()) as GoogleTokenResponse;
  if (!body.id_token) {
    throw new Error(`google token exchange failed: ${body.error_description ?? body.error ?? "no id_token"}`);
  }

  // 用 Google 公钥（JWKS）验证 id_token：签名 / iss / aud / nonce / exp
  const { payload } = await jwtVerify(body.id_token, googleJwks, {
    issuer: [...GOOGLE_ISSUERS],
    audience: cfg.googleClientId,
    algorithms: ["RS256", "ES256"],
    requiredClaims: ["sub", "iss", "aud", "exp", "iat"],
  });
  if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) {
    throw new Error("google id_token nonce mismatch");
  }
  const email = payload.email;
  if (typeof email !== "string" || !email) throw new Error("google id_token missing email");
  if (payload.email_verified === false) throw new Error("google email not verified");

  return {
    providerSub: String(payload.sub),
    principal: email.toLowerCase(),
    name: typeof payload.name === "string" ? payload.name : email.split("@")[0] ?? email,
  };
}
