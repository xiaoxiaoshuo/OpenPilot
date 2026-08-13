import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { createMemoryClaimStore } from "../src/claims.ts";
import { bootProblems, type IdpConfig } from "../src/config.ts";
import { loadSigningKey } from "../src/keys.ts";
import { createIdpHandler } from "../src/server.ts";
import { TokenSigner } from "../src/tokens.ts";

const clientId = "openpilot-web";
const clientSecret = "test-client-secret-must-be-at-least-32-characters";
const tokenSecret = "test-token-secret-must-be-at-least-32-characters";
const redirectUri = "http://127.0.0.1:8200/auth/callback";
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startIdp(overrides: Partial<IdpConfig> = {}): Promise<{ baseUrl: string; cfg: IdpConfig; publicJwk: Record<string, unknown> }> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const signingKey = await loadSigningKey(jwk);
  const cfg: IdpConfig = {
    issuer: "http://127.0.0.1:8201",
    publicPath: "",
    clientId,
    clientSecret,
    redirectUri,
    signingJwk: jwk,
    tokenSecret,
    allowedEmails: [],
    allowedEmailDomain: undefined,
    brandName: "OpenPilot",
    codeTtlS: 120,
    accessTtlS: 120,
    idTokenTtlS: 3600,
    githubClientId: "",
    githubClientSecret: "",
    githubCallbackUri: "http://127.0.0.1:8201/callback/github",
    googleClientId: "",
    googleClientSecret: "",
    googleCallbackUri: "http://127.0.0.1:8201/callback/google",
    demoLoginEnabled: true,
    ...overrides,
  };
  const server = createServer(createIdpHandler({
    cfg,
    signer: new TokenSigner(cfg.tokenSecret, cfg.issuer),
    claims: createMemoryClaimStore(),
    signingKey,
  }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}`, cfg, publicJwk: signingKey.publicJwk as Record<string, unknown> };
}

function authorizeUrl(baseUrl: string, loginHint: string): string {
  const url = new URL("/authorize", baseUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state: "demo-state",
    nonce: "demo-nonce",
    code_challenge: challenge,
    code_challenge_method: "S256",
    provider: "demo",
    login_hint: loginHint,
  }).toString();
  return url.toString();
}

async function issueDemoCode(baseUrl: string, email = "Demo.User@example.com"): Promise<string> {
  const response = await fetch(authorizeUrl(baseUrl, email), { redirect: "manual" });
  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get("location") ?? "");
  assert.equal(destination.origin + destination.pathname, redirectUri);
  assert.equal(destination.searchParams.get("state"), "demo-state");
  const code = destination.searchParams.get("code");
  assert.ok(code);
  return code;
}

test("demo provider issues a PKCE-bound code and a normalized local identity", async () => {
  const { baseUrl, cfg, publicJwk } = await startIdp();
  const code = await issueDemoCode(baseUrl);
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }).toString(),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { access_token: string; id_token: string };
  assert.ok(body.access_token);
  const { payload } = await jwtVerify(body.id_token, await import("jose").then(({ importJWK }) => importJWK(publicJwk, "ES256")), {
    issuer: cfg.issuer,
    audience: clientId,
  });
  assert.equal(payload.email, "demo.user@example.com");
  assert.equal(payload.nonce, "demo-nonce");

  const userinfo = await fetch(`${baseUrl}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.equal(userinfo.status, 200);
  assert.equal((await userinfo.json() as { email: string }).email, "demo.user@example.com");
});

test("demo provider rejects disabled, invalid, and non-allowlisted identities", async () => {
  const disabled = await startIdp({ demoLoginEnabled: false });
  assert.equal((await fetch(authorizeUrl(disabled.baseUrl, "demo@example.com"))).status, 400);

  const invalid = await startIdp();
  assert.equal((await fetch(authorizeUrl(invalid.baseUrl, "not-an-email"))).status, 400);

  const restricted = await startIdp({ allowedEmails: ["allowed@example.com"] });
  const rejected = await fetch(authorizeUrl(restricted.baseUrl, "other@example.com"));
  assert.equal(rejected.status, 403, await rejected.text());
});

test("demo login is rejected by production boot validation", () => {
  const cfg = {
    issuer: "https://example.test/idp",
    publicPath: "/idp",
    clientId,
    clientSecret,
    redirectUri: "https://example.test/auth/callback",
    signingJwk: { kty: "EC", crv: "P-256", d: "test" },
    tokenSecret,
    allowedEmails: [],
    allowedEmailDomain: undefined,
    brandName: "OpenPilot",
    codeTtlS: 120,
    accessTtlS: 120,
    idTokenTtlS: 3600,
    githubClientId: "",
    githubClientSecret: "",
    githubCallbackUri: "https://example.test/callback/github",
    googleClientId: "",
    googleClientSecret: "",
    googleCallbackUri: "https://example.test/callback/google",
    demoLoginEnabled: true,
  } satisfies IdpConfig;
  assert.ok(bootProblems(cfg, true).includes("IDP_DEMO_LOGIN_ENABLED must not be enabled in production"));
});
