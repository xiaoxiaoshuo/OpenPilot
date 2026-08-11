/**
 * Token 工具 — 参考 qm plugins/auth/src/tokens.ts
 * 差异：没有 email link（第三方登录取代），保留 code / access 密封 + id_token 签发。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { ID_TOKEN_ALG, type SigningKey } from "./keys.ts";

export type TokenPurpose = "code" | "access";

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope: string;
}

export interface CodeClaims extends AuthRequest {
  /** principal：第三方邮箱（与 qm 规则一致，不加 provider 前缀） */
  principal: string;
  /** 第三方平台的 sub/数字 id（仅记录，不进 principal） */
  providerSub: string;
  provider: string;
}

export interface AccessClaims {
  sub: string;
  principal: string;
}

export interface SealedToken {
  token: string;
  jti: string;
  expiresAtMs: number;
}

const audienceFor = (purpose: TokenPurpose): string => `openpilot-idp:${purpose}`;

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

export function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  if (codeVerifier.length < 43 || codeVerifier.length > 128 || !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) return false;
  return safeEqual(createHash("sha256").update(codeVerifier).digest("base64url"), codeChallenge);
}

/** 与 qm subjectFor 完全一致：sub = sha256(issuer + "\n" + principal) */
export function subjectFor(issuer: string, principal: string): string {
  return createHash("sha256").update(`${issuer}\n${principal}`, "utf8").digest("base64url");
}

export class TokenSigner {
  private readonly keys = new Map<TokenPurpose, Uint8Array>();
  private readonly secret: string;
  private readonly issuer: string;

  constructor(secret: string, issuer: string) {
    this.secret = secret;
    this.issuer = issuer;
  }

  private keyFor(purpose: TokenPurpose): Uint8Array {
    const cached = this.keys.get(purpose);
    if (cached) return cached;
    const derived = new Uint8Array(createHmac("sha256", this.secret).update(`openpilot-idp.${purpose}.v1`).digest());
    this.keys.set(purpose, derived);
    return derived;
  }

  async seal(
    purpose: TokenPurpose,
    claims: Record<string, unknown>,
    ttlS: number,
    nowMs = Date.now(),
  ): Promise<SealedToken> {
    const jti = randomBytes(18).toString("base64url");
    const issuedAt = Math.floor(nowMs / 1000);
    const expiresAt = issuedAt + ttlS;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer)
      .setAudience(audienceFor(purpose))
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(jti)
      .sign(this.keyFor(purpose));
    return { token, jti, expiresAtMs: expiresAt * 1000 };
  }

  async open(purpose: TokenPurpose, token: string, nowMs = Date.now()): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.keyFor(purpose), {
        issuer: this.issuer,
        audience: audienceFor(purpose),
        algorithms: ["HS256"],
        requiredClaims: ["jti", "iat", "exp"],
        currentDate: new Date(nowMs),
        clockTolerance: 5,
      });
      return payload;
    } catch {
      return null;
    }
  }

  async sealCode(claims: CodeClaims, ttlS: number, nowMs?: number): Promise<SealedToken> {
    return this.seal(
      "code",
      { cid: claims.clientId, ru: claims.redirectUri, st: claims.state, sc: claims.scope, no: claims.nonce, cc: claims.codeChallenge, p: claims.principal, ps: claims.providerSub, pv: claims.provider },
      ttlS,
      nowMs,
    );
  }

  async openCode(
    token: string,
    nowMs?: number,
  ): Promise<{ claims: CodeClaims; jti: string; expiresAtMs: number } | null> {
    const payload = await this.open("code", token, nowMs);
    if (!payload) return null;
    const { cid, ru, st, sc, no, cc, p, ps, pv } = payload as Record<string, unknown>;
    if ([cid, ru, st, sc, no, cc, p, ps, pv].some((value) => typeof value !== "string" || !value)) return null;
    return {
      claims: {
        clientId: cid as string,
        redirectUri: ru as string,
        state: st as string,
        scope: sc as string,
        nonce: no as string,
        codeChallenge: cc as string,
        principal: p as string,
        providerSub: ps as string,
        provider: pv as string,
      },
      jti: String(payload.jti),
      expiresAtMs: Number(payload.exp) * 1000,
    };
  }

  async sealAccess(claims: AccessClaims, ttlS: number, nowMs?: number): Promise<SealedToken> {
    return this.seal("access", { sub: claims.sub, p: claims.principal }, ttlS, nowMs);
  }

  async openAccess(token: string, nowMs?: number): Promise<AccessClaims | null> {
    const payload = await this.open("access", token, nowMs);
    if (!payload || typeof payload.sub !== "string" || typeof payload.p !== "string") return null;
    return { sub: payload.sub, principal: payload.p };
  }
}

export async function mintIdToken(
  key: SigningKey,
  args: { issuer: string; clientId: string; sub: string; principal: string; nonce: string; ttlS: number; nowMs?: number },
): Promise<string> {
  const issuedAt = Math.floor((args.nowMs ?? Date.now()) / 1000);
  return new SignJWT({ nonce: args.nonce, azp: args.clientId, email: args.principal, email_verified: true })
    .setProtectedHeader({ alg: ID_TOKEN_ALG, kid: key.kid, typ: "JWT" })
    .setIssuer(args.issuer)
    .setSubject(args.sub)
    .setAudience(args.clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + args.ttlS)
    .sign(key.privateKey);
}
