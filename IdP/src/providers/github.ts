/**
 * GitHub OAuth2 Provider — Authorization Code 流程
 * 文档：skills/github-sso-login/SKILL.md
 */
import type { IdpConfig } from "../config.ts";

export interface ProviderUser {
  /** 第三方平台的稳定用户 id（GitHub 数字 id / Google sub） */
  providerSub: string;
  /** principal：邮箱（与 qm 规则一致） */
  principal: string;
  /** 显示名 */
  name: string;
}

export function githubAuthorizeUrl(
  cfg: IdpConfig,
  args: { state: string; scope: string },
): string {
  const params = new URLSearchParams({
    client_id: cfg.githubClientId,
    redirect_uri: cfg.githubCallbackUri,
    scope: args.scope,
    state: args.state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

interface GithubTokenResponse {
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

export async function githubExchangeCode(
  cfg: IdpConfig,
  code: string,
): Promise<ProviderUser> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.githubClientId,
      client_secret: cfg.githubClientSecret,
      code,
      redirect_uri: cfg.githubCallbackUri,
    }),
  });
  if (!tokenRes.ok) throw new Error(`github token endpoint HTTP ${tokenRes.status}`);
  const tokenBody = (await tokenRes.json()) as GithubTokenResponse;
  if (!tokenBody.access_token) {
    throw new Error(`github token exchange failed: ${tokenBody.error_description ?? tokenBody.error ?? "no access_token"}`);
  }
  const accessToken = tokenBody.access_token;

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `token ${accessToken}`, accept: "application/json", "user-agent": "openpilot-idp" },
  });
  if (!userRes.ok) throw new Error(`github user endpoint HTTP ${userRes.status}`);
  const user = (await userRes.json()) as GithubUser;

  let principal = user.email ?? "";
  if (!principal) {
    // 隐私邮箱：用户允许 user:email scope 时，从 /user/emails 取主邮箱
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `token ${accessToken}`, accept: "application/json", "user-agent": "openpilot-idp" },
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as GithubEmail[];
      const primary = emails.find((e) => e.primary && e.verified);
      if (primary) principal = primary.email;
      else {
        const verified = emails.find((e) => e.verified);
        if (verified) principal = verified.email;
      }
    }
  }
  if (!principal) throw new Error("github user has no usable email address");

  return {
    providerSub: String(user.id),
    principal: principal.toLowerCase(),
    name: user.name ?? user.login,
  };
}
