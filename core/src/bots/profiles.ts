/**
 * 群组附加机器人预设（主 agent 协调者模式的被召唤者）
 * - enabled=false 的预设不出现在群组配置选择器中（全局禁用）
 * - capabilities 渲染进主 agent 的"群组机器人协作"提示词块
 */

export interface BotProfile {
  botId: string;
  name: string;
  avatar: string; // emoji 头像
  personality: string; // 角色性格（bot run 的 system prompt 素材）
  capabilities: string; // 能力描述（渲染进主 agent 提示词）
  enabled: boolean;
}

export const BOT_PROFILES: BotProfile[] = [
  {
    botId: "customer-service",
    name: "客服机器人",
    avatar: "🎧",
    personality: "你是客服机器人。风格：耐心、专业、结构化。回答订单、售后、退款、账号类问题，给出清晰步骤。",
    capabilities: "订单/售后/退款/账号问题",
    enabled: true,
  },
  {
    botId: "tech-support",
    name: "技术机器人",
    avatar: "🔧",
    personality: "你是技术机器人。风格：精确、直接、给方案。回答部署、报错、代码、服务器类问题，附上可执行的操作步骤。",
    capabilities: "部署/报错/代码/服务器问题",
    enabled: true,
  },
  {
    botId: "fun-bot",
    name: "幽默机器人",
    avatar: "😄",
    personality: "你是幽默机器人。风格：轻松、有梗、不冒犯。活跃群组气氛，可以讲段子或接梗，但不偏离问题主题。",
    capabilities: "活跃气氛、段子",
    enabled: true,
  },
];

export function botProfileById(botId: string): BotProfile | undefined {
  return BOT_PROFILES.find((b) => b.botId === botId);
}

export function enabledProfiles(): BotProfile[] {
  return BOT_PROFILES.filter((b) => b.enabled);
}
