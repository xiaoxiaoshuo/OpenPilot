/**
 * IdP 入口 — OpenPilot 身份提供方（OIDC IdP），对接 GitHub / Google
 * 运行：npm run dev（:8201，经 gateway /idp/* 对外暴露）
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { json } from "../../core/chassis/src/http.ts";
import { portFromEnv } from "../../core/chassis/src/env.ts";
import { bootProblems, readConfig } from "./config.ts";
import { loadSigningKey, type SigningKey } from "./keys.ts";
import { TokenSigner } from "./tokens.ts";
import { createMemoryClaimStore } from "./claims.ts";
import { createIdpHandler } from "./server.ts";

const PORT = portFromEnv(8201);
const IS_PROD = process.env.NODE_ENV === "production";
const CFG = readConfig(process.env);

/** 签名密钥：优先 env IDP_SIGNING_JWK；否则读/写 IdP/.idp-jwk.json（自动生成，不打印私钥） */
async function resolveSigningKey(): Promise<{ jwk: Record<string, unknown> }> {
  if (CFG.signingJwk) return { jwk: CFG.signingJwk };
  const file = join(process.cwd(), ".idp-jwk.json");
  if (existsSync(file)) {
    try {
      const jwk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (jwk.kty === "EC" && typeof jwk.d === "string") return { jwk };
    } catch {
      // 损坏则重新生成
    }
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify(jwk, null, 2) + "\n", { mode: 0o600 });
  console.log(`[idp] generated signing key at ${file} (set IDP_SIGNING_JWK in env to override)`);
  return { jwk };
}

export async function startServer(): Promise<void> {
  const { jwk } = await resolveSigningKey();
  CFG.signingJwk = jwk; // 自动生成兜底后，再执行启动校验
  const problems = bootProblems(CFG, IS_PROD);
  if (problems.length) {
    for (const p of problems) console.error(`[idp] FATAL: ${p}`);
    throw new Error(`idp refusing to start: ${problems.length} misconfiguration(s)`);
  }
  const signingKey: SigningKey = await loadSigningKey(jwk);
  const handle = createIdpHandler({
    cfg: CFG,
    signer: new TokenSigner(CFG.tokenSecret, CFG.issuer),
    claims: createMemoryClaimStore(),
    signingKey,
  });
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      console.error(`[idp] 500 ${req.method ?? "?"} ${(req.url ?? "?").split("?")[0]}:`, err);
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
  server.listen(PORT, () => {
    console.log(
      `[idp] OIDC provider on http://localhost:${PORT} (issuer ${CFG.issuer}, github=${CFG.githubClientId ? "ok" : "missing"}, google=${CFG.googleClientId ? "ok" : "missing"})`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
