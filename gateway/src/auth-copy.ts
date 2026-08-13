export type AuthLocale = "zh-CN" | "en";
export type AuthTheme = "light" | "dark" | "system";

export interface AuthCopy {
  htmlLang: string;
  languageLabel: string;
  switchLanguage: string;
  themeLight: string;
  themeDark: string;
  themeSystem: string;
  brandKicker: string;
  signInTitle: string;
  signInSubtitle: string;
  github: string;
  google: string;
  demoTitle: string;
  demoEmailLabel: string;
  demoEmailPlaceholder: string;
  demoContinue: string;
  demoHint: string;
  noProvider: string;
  errorTitle: string;
  retry: string;
  secureNote: string;
  providerNotConfigured: (provider: string) => string;
  invalidDemoEmail: string;
  providerReturnedError: string;
  loginExpired: string;
  invalidState: string;
  loginUsed: string;
  genericSignInFailure: string;
}

const EN: AuthCopy = {
  htmlLang: "en",
  languageLabel: "Language",
  switchLanguage: "中文",
  themeLight: "Light theme",
  themeDark: "Dark theme",
  themeSystem: "Use system theme",
  brandKicker: "YOUR WORKSPACE",
  signInTitle: "Welcome to OpenPilot",
  signInSubtitle: "Sign in to continue to your conversations, projects, and automations.",
  github: "Continue with GitHub",
  google: "Continue with Google",
  demoTitle: "Demo workspace",
  demoEmailLabel: "Email address",
  demoEmailPlaceholder: "demo@example.com",
  demoContinue: "Continue as demo user",
  demoHint: "No password or registration required. Access may be limited by your administrator.",
  noProvider: "No sign-in provider is configured. Ask your administrator to configure GitHub or Google OAuth.",
  errorTitle: "Sign-in failed",
  retry: "Try signing in again",
  secureNote: "Secure sign-in · Your session is protected",
  providerNotConfigured: (provider) => `Sign-in with ${provider} is not configured.`,
  invalidDemoEmail: "Enter a valid email address for demo sign-in.",
  providerReturnedError: "The identity provider did not complete the sign-in request. Please try again.",
  loginExpired: "Your sign-in session expired. Please try again.",
  invalidState: "We could not verify this sign-in request. Please try again.",
  loginUsed: "This sign-in request has already been used. Please start again.",
  genericSignInFailure: "We could not complete your sign-in. Please try again.",
};

const ZH_CN: AuthCopy = {
  htmlLang: "zh-CN",
  languageLabel: "语言",
  switchLanguage: "English",
  themeLight: "浅色主题",
  themeDark: "深色主题",
  themeSystem: "跟随系统主题",
  brandKicker: "你的工作空间",
  signInTitle: "欢迎使用 OpenPilot",
  signInSubtitle: "登录后即可继续访问你的对话、项目和自动化任务。",
  github: "使用 GitHub 继续",
  google: "使用 Google 继续",
  demoTitle: "演示工作空间",
  demoEmailLabel: "邮箱地址",
  demoEmailPlaceholder: "demo@example.com",
  demoContinue: "以演示用户身份继续",
  demoHint: "无需密码或注册。演示访问范围可能受管理员限制。",
  noProvider: "尚未配置登录方式。请联系管理员配置 GitHub 或 Google OAuth。",
  errorTitle: "登录失败",
  retry: "重新开始登录",
  secureNote: "安全登录 · 你的会话受到保护",
  providerNotConfigured: (provider) => `尚未配置 ${provider} 登录方式。`,
  invalidDemoEmail: "请输入有效的演示登录邮箱地址。",
  providerReturnedError: "身份提供方未完成本次登录请求，请重新尝试。",
  loginExpired: "登录会话已过期，请重新开始登录。",
  invalidState: "无法验证本次登录请求，请重新开始登录。",
  loginUsed: "该登录请求已使用过，请重新开始登录。",
  genericSignInFailure: "无法完成登录，请重新尝试。",
};

export function resolveAuthLocale(explicit: string | null | undefined, acceptLanguage: string | undefined): AuthLocale {
  if (explicit === "zh-CN" || explicit === "zh") return "zh-CN";
  if (explicit === "en" || explicit === "en-US") return "en";
  return /(?:^|[,;\s-])zh(?:[-_]|$)/i.test(acceptLanguage ?? "") ? "zh-CN" : "en";
}

export function resolveAuthTheme(value: string | null | undefined): AuthTheme {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

export function authCopy(locale: AuthLocale): AuthCopy {
  return locale === "zh-CN" ? ZH_CN : EN;
}

export function otherAuthLocale(locale: AuthLocale): AuthLocale {
  return locale === "zh-CN" ? "en" : "zh-CN";
}
