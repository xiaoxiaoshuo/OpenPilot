/**
 * IdP 配置 — 参考 qm plugins/auth/src/config.ts
 * 差异：认证方式从"邮箱 magic link"换成"GitHub / Google 第三方登录"
 */

export type ProviderKind = "github" | "google" | "demo";

export interface IdpConfig {
  /** 对外 issuer（浏览器可见，经 gateway 暴露），如 http://127.0.0.1:8200/idp */
  issuer: string;
  /** issuer 的路径部分，如 /idp（gateway 反代会去掉该前缀再转发到本服务） */
  publicPath: string;
  /** 本 IdP 的 client（即 gateway），token 端点用它做 Basic 认证 */
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  signingJwk: Record<string, unknown> | null;
  tokenSecret: string;
  /** 邮箱白名单（与 qm 一致：域名或精确邮箱，二选一或都填） */
  allowedEmails: readonly string[];
  allowedEmailDomain: string | undefined;
  brandName: string;
  codeTtlS: number;
  accessTtlS: number;
  idTokenTtlS: number;
  githubClientId: string;
  githubClientSecret: string;
  githubCallbackUri: string;
  googleClientId: string;
  googleClientSecret: string;
  googleCallbackUri: string;
  /** 仅用于本地开发和受控演示，默认关闭。 */
  demoLoginEnabled: boolean;
}

const PLACEHOLDER = /^(replace-me|placeholder|changeme|todo)$/i;

function isMissingOrPlaceholder(value: string | undefined): boolean {
  const candidate = value?.trim();
  return !candidate || PLACEHOLDER.test(candidate);
}

function numberFrom(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function listFrom(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function issuerPath(issuer: string): string {
  try {
    return new URL(issuer).pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function parseJwk(raw: string | undefined): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readConfig(env: NodeJS.ProcessEnv): IdpConfig {
  const issuer = (env.IDP_ISSUER ?? `http://localhost:${env.IDP_PORT ?? 8201}`).replace(/\/$/, "");
  return {
    issuer,
    publicPath: issuerPath(issuer),
    clientId: env.IDP_CLIENT_ID?.trim() ?? "",
    clientSecret: env.IDP_CLIENT_SECRET ?? "",
    redirectUri: env.IDP_REDIRECT_URI?.trim() ?? "",
    signingJwk: parseJwk(env.IDP_SIGNING_JWK),
    tokenSecret: env.IDP_TOKEN_SECRET ?? "",
    allowedEmails: listFrom(env.IDP_ALLOWED_EMAILS ?? env.AUTH_ALLOWED_EMAILS),
    allowedEmailDomain: (env.IDP_ALLOWED_EMAIL_DOMAIN ?? env.AUTH_ALLOWED_EMAIL_DOMAIN)?.trim().toLowerCase() || undefined,
    brandName: env.IDP_BRAND_NAME?.trim() || "OpenPilot",
    codeTtlS: numberFrom(env.IDP_CODE_TTL_S, 120),
    accessTtlS: numberFrom(env.IDP_ACCESS_TTL_S, 120),
    idTokenTtlS: numberFrom(env.IDP_ID_TOKEN_TTL_S, 3600),
    githubClientId: env.GITHUB_CLIENT_ID ?? "",
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? "",
    githubCallbackUri: (env.GITHUB_CALLBACK_URI ?? `${issuer}/callback/github`).replace(/\/$/, ""),
    googleClientId: env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    googleCallbackUri: (env.GOOGLE_CALLBACK_URI ?? `${issuer}/callback/google`).replace(/\/$/, ""),
    demoLoginEnabled: env.IDP_DEMO_LOGIN_ENABLED?.trim().toLowerCase() === "true",
  };
}

function validEmailDomain(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every(
      (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}

export function emailAllowed(cfg: IdpConfig, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  // 未配置任何限制时：允许本地开发；一旦配置邮箱或域名白名单，两者任一命中才允许。
  if (cfg.allowedEmails.length === 0 && !cfg.allowedEmailDomain) return true;
  if (cfg.allowedEmails.includes(normalized)) return true;
  return Boolean(cfg.allowedEmailDomain && normalized.endsWith(`@${cfg.allowedEmailDomain}`));
}

function httpsUrlProblem(label: string, value: string, requireHttps: boolean): string | null {
  if (isMissingOrPlaceholder(value)) return `${label} is required and may not be a placeholder`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${label} must be an absolute URL`;
  }
  if (requireHttps && url.protocol !== "https:") return `${label} must be https in production`;
  if (url.search || url.hash) return `${label} must not carry a query string or fragment`;
  return null;
}

export function bootProblems(cfg: IdpConfig, isProd: boolean): string[] {
  const problems: string[] = [];
  const push = (problem: string | null): void => {
    if (problem) problems.push(problem);
  };

  push(httpsUrlProblem("IDP_ISSUER", cfg.issuer, isProd));
  push(httpsUrlProblem("IDP_REDIRECT_URI", cfg.redirectUri, isProd));
  if (isMissingOrPlaceholder(cfg.clientId)) problems.push("IDP_CLIENT_ID is required and may not be a placeholder");
  if (isMissingOrPlaceholder(cfg.clientSecret))
    problems.push("IDP_CLIENT_SECRET is required and may not be a placeholder");
  else if (cfg.clientSecret.trim().length < 32)
    problems.push("IDP_CLIENT_SECRET must be at least 32 characters");
  if (isMissingOrPlaceholder(cfg.tokenSecret)) problems.push("IDP_TOKEN_SECRET is required and may not be a placeholder");
  else if (cfg.tokenSecret.trim().length < 32) problems.push("IDP_TOKEN_SECRET must be at least 32 characters");
  if (!cfg.signingJwk) problems.push("IDP_SIGNING_JWK is required and must be a JSON Web Key object");
  else if (cfg.signingJwk.kty !== "EC" || cfg.signingJwk.crv !== "P-256" || typeof cfg.signingJwk.d !== "string") {
    problems.push("IDP_SIGNING_JWK must be a P-256 private JSON Web Key (kty EC, crv P-256, with d)");
  }

  const githubConfigured = !isMissingOrPlaceholder(cfg.githubClientId) && !isMissingOrPlaceholder(cfg.githubClientSecret);
  const googleConfigured = !isMissingOrPlaceholder(cfg.googleClientId) && !isMissingOrPlaceholder(cfg.googleClientSecret);
  if (!cfg.demoLoginEnabled && !githubConfigured && !googleConfigured) {
    problems.push("at least one of (GITHUB_CLIENT_ID/SECRET, GOOGLE_CLIENT_ID/SECRET) or IDP_DEMO_LOGIN_ENABLED=true must be configured");
  }
  if (cfg.demoLoginEnabled && isProd) {
    problems.push("IDP_DEMO_LOGIN_ENABLED must not be enabled in production");
  }
  if (!isMissingOrPlaceholder(cfg.githubClientId) || !isMissingOrPlaceholder(cfg.githubClientSecret)) {
    push(httpsUrlProblem("GITHUB_CALLBACK_URI", cfg.githubCallbackUri, isProd));
  }
  if (!isMissingOrPlaceholder(cfg.googleClientId) || !isMissingOrPlaceholder(cfg.googleClientSecret)) {
    push(httpsUrlProblem("GOOGLE_CALLBACK_URI", cfg.googleCallbackUri, isProd));
  }

  if (cfg.allowedEmailDomain && !validEmailDomain(cfg.allowedEmailDomain)) {
    problems.push("IDP_ALLOWED_EMAIL_DOMAIN must be a valid email domain when set");
  }
  for (const bad of cfg.allowedEmails.filter((e) => !validEmail(e) || isMissingOrPlaceholder(e))) {
    problems.push(`IDP_ALLOWED_EMAILS contains an invalid address: ${bad}`);
  }
  return problems;
}
