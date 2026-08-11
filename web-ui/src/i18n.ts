/**
 * i18n — 轻量国际化模块（零依赖）
 *
 * - 字典驱动：key 用点分命名（nav.files、sessions.newChat）
 * - 语言规则：默认中文；sessionStorage["ui.lang"] 仅记住当前标签页会话内的手动切换，
 *   新开标签页/新会话一律回到中文默认
 * - 切换：setLang() 写入 sessionStorage 并刷新页面（函数式渲染下最可靠的重渲染方式）
 * - 占位符：t("hello", { name: "world" }) 支持 {name} 替换
 */

export type Lang = "zh" | "en";

const STORAGE_KEY = "ui.lang";
const zh: Record<string, string> = {
  // 导航
  "nav.browse": "浏览",
  "nav.projects": "群组",
  "nav.chats": "会话",
  "nav.files": "文件",
  "nav.crons": "定时任务",
  "nav.keychain": "密钥库",
  "nav.apps": "应用",
  "nav.memory": "记忆",
  "nav.skills": "技能",
  "nav.sessions": "会话",
  "nav.recents": "最近",
  "nav.langToggle": "EN",

  // 会话页
  "sessions.title": "会话",
  "sessions.newChat": "新建对话",
  "sessions.newSession": "新建会话",
  "sessions.search": "搜索对话…",
  "sessions.active": "进行中",
  "sessions.waiting": "等待中",
  "sessions.archived": "已归档",
  "sessions.today": "今天",
  "sessions.yesterday": "昨天",
  "sessions.prev7": "最近 7 天",
  "sessions.prev30": "最近 30 天",
  "sessions.older": "更早",

  // 定时任务页
  "crons.title": "定时任务",
  "crons.yours": "我的",
  "crons.shared": "共享",
  "crons.archived": "已归档",
  "crons.newCron": "新建任务",
  "crons.search": "搜索任务",

  // 应用（部署）页
  "deploys.title": "应用",
  "deploys.yours": "我的",
  "deploys.shared": "共享",
  "deploys.archived": "已归档",
  "deploys.deployWithAgent": "让 Agent 部署",
  "deploys.search": "搜索应用",

  // 技能页
  "skills.title": "技能",
  "skills.newSkill": "新建技能",
  "skills.search": "搜索技能…",
  "skills.active": "启用中",
  "skills.archived": "已归档",
  "skills.all": "全部",

  // 上下文页
  "contexts.personal": "个人",
  "contexts.sharedSpace": "共享个人空间",
  "contexts.personalSub": "只有你——你的 Web 对话和与 Agent 的私聊都在这里。",

  // 记忆页
  "memory.discardConfirm": "放弃未保存的记忆修改？",
  "memory.title": "记忆",

  // 登录门（auth gate）
  "auth.devSignIn": "开发登录",
  "auth.devBody": "未配置身份提供方，此实例信任本地 Cookie。设置 CORE_SIGNING_SECRET 并运行 portal 即可使用正式登录。",
  "auth.principal": "主体（Principal）",
  "auth.principalPlaceholder": "you@org.com",
  "auth.continue": "继续",
  "auth.signingIn": "登录中…",
  "auth.signInFailed": "登录失败。",
  "auth.devMode": "开发模式",
  "auth.devBannerSuffix": "——未配置身份提供方，以 {user} 登录",
  "auth.signOut": "退出登录",
  "auth.portalTitle": "通过 portal 登录",
  "auth.portalBody": "此界面经由 portal 访问，但那里的登录未为此实例产生会话。请直接打开 portal 地址，而非此地址。",
  "auth.portalHint": "如果你直接打开了此界面的地址，那就是原因——它无法自行认证任何人。",
  "auth.sessionEnded": "会话已结束",
  "auth.sessionEndedBody": "你已退出登录。重新登录后将回到此页面。",
  "auth.signIn": "登录",
  "auth.deniedTitle": "你无权访问",
  "auth.deniedBody": "你的账号已登录并通过验证——只是不允许访问此实例。请联系管理员添加你。",
  "auth.deniedHint": "此实例在 WEB_UI_PRINCIPALS 中列出其主体。",
  "auth.unreachableTitle": "无法连接助手",
  "auth.unreachableBody": "服务未响应。这通常是暂时的。",
  "auth.tryAgain": "重试",
  "auth.unreachableHint": "如果持续发生，核心服务可能已宕机。",

  // 通用
  "common.cancel": "取消",
  "common.save": "保存",
  "common.delete": "删除",
  "common.edit": "编辑",
  "common.close": "关闭",
  "common.search": "搜索",
  "common.loading": "加载中…",
  "common.retry": "重试",
};

const en: Record<string, string> = {
  "nav.browse": "Browse",
  "nav.projects": "Groups",
  "nav.chats": "Conversations",
  "nav.files": "Files",
  "nav.crons": "Crons",
  "nav.keychain": "Keychain",
  "nav.apps": "Apps",
  "nav.memory": "Memory",
  "nav.skills": "Skills",
  "nav.sessions": "Sessions",
  "nav.recents": "Recents",
  "nav.langToggle": "中文",

  "sessions.title": "Chats",
  "sessions.newChat": "New chat",
  "sessions.newSession": "New session",
  "sessions.search": "Search chats…",
  "sessions.active": "Active",
  "sessions.waiting": "Waiting",
  "sessions.archived": "Archived",
  "sessions.today": "Today",
  "sessions.yesterday": "Yesterday",
  "sessions.prev7": "Previous 7 days",
  "sessions.prev30": "Previous 30 days",
  "sessions.older": "Older",

  "crons.title": "Crons",
  "crons.yours": "Yours",
  "crons.shared": "Shared",
  "crons.archived": "Archived",
  "crons.newCron": "New cron",
  "crons.search": "Search crons",

  "deploys.title": "Apps",
  "deploys.yours": "Yours",
  "deploys.shared": "Shared",
  "deploys.archived": "Archived",
  "deploys.deployWithAgent": "Deploy with Agent",
  "deploys.search": "Search apps",

  "skills.title": "Skills",
  "skills.newSkill": "New skill",
  "skills.search": "Search skills…",
  "skills.active": "Active",
  "skills.archived": "Archived",
  "skills.all": "All",

  "contexts.personal": "Personal",
  "contexts.sharedSpace": "Shared personal space",
  "contexts.personalSub": "Just you — your web chats and DMs with the agent live here.",

  "memory.discardConfirm": "Discard unsaved memory changes?",
  "memory.title": "Memory",

  "auth.devSignIn": "Dev sign-in",
  "auth.devBody": "No identity provider is configured, so this instance trusts a local cookie. Set CORE_SIGNING_SECRET and run the portal to use real sign-in.",
  "auth.principal": "Principal",
  "auth.principalPlaceholder": "you@org.com",
  "auth.continue": "Continue",
  "auth.signingIn": "Signing in…",
  "auth.signInFailed": "Sign-in failed.",
  "auth.devMode": "Dev mode",
  "auth.devBannerSuffix": "— no identity provider, signed in as {user}",
  "auth.signOut": "Sign out",
  "auth.portalTitle": "Sign in through the portal",
  "auth.portalBody": "This surface is reached through the portal, and signing in there didn't produce a session for it. Open the portal address directly rather than this one.",
  "auth.portalHint": "If you opened this surface's own address, that's the cause — it can't authenticate anyone on its own.",
  "auth.sessionEnded": "Your session ended",
  "auth.sessionEndedBody": "You've been signed out. Sign in again and you'll come back to this page.",
  "auth.signIn": "Sign in",
  "auth.deniedTitle": "You don't have access",
  "auth.deniedBody": "Your account is signed in and verified — it just isn't allowed on this instance. Ask an administrator to add you.",
  "auth.deniedHint": "This instance lists its principals in WEB_UI_PRINCIPALS.",
  "auth.unreachableTitle": "We couldn't reach the assistant",
  "auth.unreachableBody": "The service didn't respond. This is usually temporary.",
  "auth.tryAgain": "Try again",
  "auth.unreachableHint": "If this keeps happening, the core service may be down.",

  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.close": "Close",
  "common.search": "Search",
  "common.loading": "Loading…",
  "common.retry": "Retry",
};

const dicts: Record<Lang, Record<string, string>> = { zh, en };

function detectLang(): Lang {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored === "zh" || stored === "en") return stored;
  return "zh";
}

let current: Lang = typeof sessionStorage !== "undefined" ? detectLang() : "zh";

/** 当前语言 */
export function lang(): Lang {
  return current;
}

/** 取翻译文本，支持 {param} 占位符；缺失 key 时原样返回 key 便于排查 */
export function t(key: string, params?: Record<string, string | number>): string {
  let text = dicts[current][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

/** 切换语言：写入 sessionStorage（仅当前标签页会话），同步 <html lang>，刷新页面重渲染 */
export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 隐私模式下忽略
  }
  applyLangAttr();
  location.reload();
}

/** 同步 <html lang> 属性（供无障碍与字体选择使用） */
export function applyLangAttr(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  }
}
