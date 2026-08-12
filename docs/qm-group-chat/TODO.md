# TODO：QM 群组多机器人对话（最终版 v2 — 主 agent 协调模式）

> 状态：**需求拷问全部确认，设计冻结，尚未开始实现**
> 相关文档：[机器人预设清单](./bot-profiles.md) · [QM Web UI 接口文档](../qm-api/README.md)

## 需求模型

```
群组（= 项目，group:web-project-<uuid> scope）
├── 人类成员（项目成员，可在 Web 聊天窗口发言）
├── 主 agent（= 现有项目 agent，协调者，必回所有人类消息）
├── 附加机器人 0..N 个（预设角色：客服🎧/技术🔧/幽默😄，由主 agent 通过 summon 工具调度）
└── 多个群会话（每个成员自己的会话线程，各聊各的 = B 模型）
     每个会话动态继承群组配置，改配置全组即时生效
```

## 已确认决策（拷问结论）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 群组载体 | **复用项目** scope；群组下可新建多个群会话 |
| 2 | 会话模型 | **B：各聊各的**——每人自己的线程，不共享会话 |
| 2B | 历史视图 | **自己视角**：进入群组看到"我"在该项目下所有会话的历史 |
| 3 | 主 agent | **= 现有项目 agent**（零改动复用触发/模型/记忆/保证回复） |
| 4 | 触发机制 | **主 agent 协调者模式**：主 agent 判断是否召唤附加机器人（summon 工具）；**无关键词匹配** |
| 4a | 召唤上限 | 一次 turn 最多 summon **2 个**附加机器人 |
| 4b | 无召唤时 | 只有主 agent 回复（保证回复由主 agent 承担） |
| 5 | 配置继承 | **动态引用**：`Project.botConfig` JSONB，改一处全组生效 |
| 6 | 主 agent 身份 | **带身份显示**：默认"群助手 🤖"（`primaryName` 可改），回复带 author |
| 7 | web-ui 架构 | **a：群组 → 会话列表 → 聊天窗口** + 群组设置（成员 + 机器人管理） |
| 8 | summon 上下文 | B 机器人**读同一会话历史**（与主 agent 看到的一致），summon 只传 bot_id |
| 9 | 触发时机 | 主 agent turn **结束后**统一解析 summon → 触发 bot run |

## 核心消息流（协调者模式）

```
你在群组会话里发消息（POST /api/turn，现有）
  → 主 agent turn（现有机制 + 两处注入）：
      ① system prompt 追加"群组机器人协作"块（含所有附加机器人的能力/性格）
      ② 工具列表暴露 summon_bot 工具（仅群组 + human 消息时）
  → 主 agent 正常回复文本（必回，assistant 条目带 author = primaryName）
  → turn 结束后统一解析 summon_bot 调用（最多 2 个，每个 bot_id 一次）
  → 每个被召唤的机器人入队一个 bot run（异步）：
      actor = { externalId: "bot:<botId>", isBot: true, displayName: name }
      origin.kind = "automation"（防循环主防线）
      system prompt = 角色 personality + 被召唤提示
      回复写入同一会话（assistant 条目带 author = 机器人名）
```

## 系统提示词设计

### 主 agent（orchestrator.ts:800 systemPrompt 组装处，群组 + botConfig 存在时追加）

```
## 群组机器人协作
本群组配置了以下机器人助手，你可以调用 summon_bot 工具请它们补充回答：
- 客服机器人 🎧：订单/售后/退款/账号问题；性格：耐心、专业、结构化
- 技术机器人 🔧：部署/报错/代码/服务器问题；性格：精确、直接、给方案
- 幽默机器人 😄：活跃气氛、段子；性格：轻松、有梗、不冒犯

规则：
- 用户问题对应某机器人的专长、或需要多角度回答时，调用 summon_bot（可一次多个）
- 主回答始终由你完成，不要用 summon 代替你自己的回答
- 不确定时不要 summon，宁缺毋滥
```

能力/性格描述来自 `BOT_PROFILES` 常量（动态渲染，配置变了提示词跟着变）。

### summon_bot 工具

```
summon_bot(bot_id: string)   // bot_id ∈ 群组启用的附加机器人
工具立即返回："已通知 <机器人名>，它将基于本会话上下文补充回答"
core 记录调用（turn 结束后统一解析），不直接入队（避免回复交错）
```

### B 机器人（personality 之外追加）

```
你是被群助手召唤来回答的用户问题。基于本会话上下文回答，风格遵循你的角色设定。
不要回复或评价其他机器人的发言。
```

## 防循环（三层）

1. **主防线**：fan-out 只由主 agent 的 summon 触发；bot run 是 automation → 其回复不触发任何新 turn/fan-out
2. **连续计数**：人类消息触发时，若会话最近连续 assistant(bot) 消息 ≥2，只解析 1 个 summon（保险）
3. **响应窗口**：summon 解析基于该人类消息的 turn，迟到/孤立调用丢弃

## 架构映射

| 能力 | 来源 | 改动 |
|---|---|---|
| 群组存储 | `artifactMap("projects")` JSONB | Project 类型 + botConfig 字段（零迁移） |
| 会话/转写/历史 | 现有 sessions store | 无 |
| 主 agent | 现有项目 agent | ① system prompt 注入 ② summon 工具注册 ③ 回复条目 author |
| 消息发送 | 现有 `POST /api/turn` | 无 |
| roster 版本/并发锁 | 现有 project-store | setBotConfig 不 bump updatedAt |
| 附加机器人 fan-out | **新增**（turn 结束后解析 summon） | 新 |
| 机器人预设 | **新增** `src/bots/profiles.ts` 常量 | 新 |

---

## 阶段 1 — 数据层

- [x] **1.1 `BOT_PROFILES` 常量**（`src/bots/profiles.ts`）：3 预设 `customer-service` 🎧 / `tech-support` 🔧 / `fun-bot` 😄；字段 `botId`/`name`/`avatar`/`personality`/`capabilities`（能力描述，供主 agent 提示词渲染）/`enabled`
- [x] **1.2 `Project` 类型扩展**：`botConfig`（`primaryName` + `attached[]`）
- [x] **1.3 project-store 方法**：`setBotConfig`（不 bump updatedAt）/ `botConfigFor` / `enabledBotsForSession`
- [x] **1.4 群组创建接入**：`POST /api/projects` 支持 `bots` 数组初始化 botConfig（UI 走建后设置）

## 阶段 2 — Core 逻辑

- [x] **2.1 主 agent 系统提示词注入**：群组 + botConfig 时追加"群组机器人协作"块（渲染 enabled 机器人的能力/性格）
- [x] **2.2 summon_bot 工具**：注册进 completeChat tools（仅群组 scope + 有启用 bot 时）；handler 校验 bot_id ∈ 启用列表 + 去重 + 上限 2；记录调用到 run 结果
- [x] **2.3 turn 结束后解析 summon**（runAssistant done 分支）：遍历主 agent 的 summon 调用 → fan-out bot run
- [x] **2.4 bot run 构造**：actor = bot 身份（payload author/bot/avatar）、automation 语义（不触发新 turn → 防循环主线）、system prompt = personality + 被召唤提示
- [x] **2.5 主 agent 回复身份**：群组 scope 的 assistant 条目 payload 带 `author: primaryName`（仅群组，个人会话不变）
- [x] **2.6 防循环三层**：automation 不触发 ✓；连续计数（跳过，出 bug 再补）；响应窗口（仅本次 turn 成功结束时解析）
- [x] **2.7 并发安全**：会话级写锁 `withSessionLock`（主 agent 与附加机器人并发写串行化）
- [x] **2.8 保证回复**：主 agent 必回（现有机制）；summon 解析失败静默（不阻塞人类消息）

## 阶段 3 — API

- [x] **3.1 `GET /api/bot-profiles`**：预设列表 → `/v1/bot-profiles`
- [x] **3.2 `GET /api/projects/:id/bots`**：群组机器人配置（成员读）
- [x] **3.3 `PATCH /api/projects/:id/bots`**：更新配置（primaryName / attached 增删启停）；权限：owner 改、成员读
- [x] **3.4 消息**：复用 `/api/turn`，零改动

## 阶段 4 — Web UI

- [x] **4.1 群组入口**：项目卡片显示机器人数量 badge
- [x] **4.2 群组内页**（a 架构）：会话列表（按 `web:<me>:` 过滤）+ "新建会话"按钮 + 点开聊天窗口
- [x] **4.3 聊天窗口身份渲染**：主 agent（primaryName）与附加机器人按 author 显示名称；bot 消息带 emoji 头像（avatar 由 core 写入 payload 透传）
- [x] **4.4 群组设置 → 机器人管理**：主 agent 名称可改；附加机器人从 `/api/bot-profiles` 添加/移除/启停（内嵌 section，owner 可编辑）

## 阶段 5 — 测试与验证

- [x] **5.2 手动验证**（已做，见提交记录）：
  1. 创建群组（带 bots）→ 2. 发消息 → 3. 主 agent 回复 + 按判断召唤机器人，身份/头像正确 → 4. 未召唤时只有主 agent 回（感谢消息验证）→ 5. 连续消息无死循环 → 6. 改群组配置所有会话即时生效（动态引用）→ 7. 新建会话配置继承
- [ ] **5.1 单测**：summon 解析 / 防循环 / setBotConfig 不 bump updatedAt / 身份注入（未做）
- [ ] **5.3 回归**：非群组项目/个人会话行为不变（已手动验证）；Slack 集成无冲突（OpenPilot 无 Slack）

## 风险与注意

- **LLM 行为不确定性**：主 agent 是否召唤由模型判断决定——提示词要写清楚"宁缺毋滥"；测试时验证召唤行为稳定
- **并发写会话**：主 agent + 附加机器人同时回复，写入顺序/lease 是关键（2.7 优先验证）
- **成本**：每消息 = 1 主 agent（原有）+ 0..2 附加调用（仅当主 agent 召唤时）
- **updatedAt 语义**：botConfig 变更不 bump updatedAt
- **isBot 冲突**：Slack 的 isBot 用于跳过 bot 消息，群组 bot run 走 core 直连，无冲突

## 里程碑

1. **M1（阶段 1+2）**：core 可跑通——curl 建群组带机器人 → 发消息 → 主 agent 回复 + summon 触发附加机器人 → 验证防循环/上限/身份
2. **M2（阶段 3）**：API 完整，可脚本验证配置管理
3. **M3（阶段 4+5）**：Web UI 群组视图可用 + 测试齐全
