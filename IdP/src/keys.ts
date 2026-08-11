/**
 * 签名密钥 — 参考 qm plugins/auth/src/keys.ts
 * 用 P-256 私钥签发 id_token（ES256），公钥通过 /.well-known/jwks.json 暴露。
 */
import { calculateJwkThumbprint, importJWK, type JWK } from "jose";

export const ID_TOKEN_ALG = "ES256";

type PrivateSigningKey = Exclude<Awaited<ReturnType<typeof importJWK>>, Uint8Array>;

export interface SigningKey {
  privateKey: PrivateSigningKey;
  publicJwk: JWK;
  kid: string;
}

export async function loadSigningKey(jwk: Record<string, unknown>): Promise<SigningKey> {
  const { d: _secret, kid: _ignored, ...publicMaterial } = jwk as JWK;
  const kid = await calculateJwkThumbprint(publicMaterial as JWK, "sha256");
  const imported = await importJWK({ ...(jwk as JWK), kid }, ID_TOKEN_ALG);
  if (imported instanceof Uint8Array) throw new Error("IDP_SIGNING_JWK must be an asymmetric private key");
  return {
    privateKey: imported,
    publicJwk: { ...(publicMaterial as JWK), kid, use: "sig", alg: ID_TOKEN_ALG },
    kid,
  };
}
