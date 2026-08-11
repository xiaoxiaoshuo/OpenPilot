/**
 * i18n — 轻量国际化模块（零依赖）
 *
 * - 字典驱动：key 用点分命名（nav.files、sessions.newChat）
 * - 语言规则：默认中文；localStorage["ui.lang"] 记录用户手动切换的选择并优先
 * - 切换：setLang() 写入 localStorage 并刷新页面（函数式渲染下最可靠的重渲染方式）
 * - 占位符：t("hello", { name: "world" }) 支持 {name} 替换
 */

export type Lang = "zh" | "en";

const STORAGE_KEY = "ui.lang";

const zh: Record<string, string> = {
  // 导航
  "nav.browse": "浏览",
  "nav.projects": "项目",
  "nav.chats": "对话",
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
  "sessions.title": "对话",
  "sessions.newChat": "新建对话",
  "sessions.newSession": "新建会话",
  "sessions.search": "搜索对话…",
  "sessions.active": "进行中",
  "sessions.waiting": "等待中",
  "sessions.archived": "已归档",

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
  "nav.projects": "Projects",
  "nav.chats": "Chats",
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
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "zh" || stored === "en") return stored;
  return "zh";
}

let current: Lang = typeof localStorage !== "undefined" ? detectLang() : "zh";

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

/** 切换语言：写入 localStorage，同步 <html lang>，刷新页面重渲染 */
export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
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
