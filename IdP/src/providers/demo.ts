/**
 * 本地演示身份提供方。
 *
 * 它不会请求外部服务，也不会保存或校验密码；仅在 IdP 显式启用
 * IDP_DEMO_LOGIN_ENABLED 时，基于经过校验的邮箱签发本地演示身份。
 */
import type { ProviderUser } from "./github.ts";

export function demoIdentity(email: string): ProviderUser {
  const principal = email.trim().toLowerCase();
  const localPart = principal.split("@", 1)[0] ?? principal;
  return {
    providerSub: `demo:${principal}`,
    principal,
    name: localPart.slice(0, 200),
  };
}
