# 群组多机器人聊天区渲染机制设计

- 日期：2026-08-12
- 分支：pr-17
- 状态：设计文档（待实施）

## 1. 背景与问题

当前聊天区是从「单人单机器人对话」改造而来的。单人会话的渲染模型是：

```
用户发消息 → 页面渲染用户消息
           → 主 agent 通过 SSE 流式输出（打字机）→ 页面实时渲染
           → 主 agent 完成（agent_end）→ 一次落库 → 渲染结束
```

群组会话在此之上叠加了「主 agent（群助手）可召唤多个附加机器人」的能力，但**渲染模型没有跟着升级**，导致以下问题：

1. **客服机器人回复无法实时流式显示**：群助手回答期间（`agent.state.isStreaming === true`），客服机器人的流式事件（partial delivery）被前端丢弃（`pendingDeliveryRefresh = true; return;`），只能等群助手结束后靠兜底轮询（1.5s/4s/8s/16s/24s）才刷出来。
2. **前端不知道「是否有 bot 被召唤」**：群助手回答完后，前端只能不断兜底拉取，因为没有一个明确的「bot 即将/正在回复」信号。
3. **头像缺失**：主 agent 的 entry 此前没有 `avatar` 字段（已修复：主 agent 默认 🤖）。

## 2. 现状数据流

### 2.1 主 agent（群助手）

- 流式输出通过 `completeChatStream` 的 `onPartial` 直接走 SSE（`normalStreamFn`），**只在内存里更新**，完成后才写一条正式 entry（`streaming: false`）。
- 主 agent 流式期间，`entries` 里**没有**主 agent 的 entry（还没落库）。

### 2.2 附加机器人（客服/技术/幽默）

- 开始时写「流式草稿 entry」：`{ text: "", streaming: true, author, bot, avatar }`，然后 `pushDelivery(threadRef)`。
- 每 120ms 节流 `pushDelivery(threadRef, true)`（partial），更新草稿 entry 的 `text`。
- 完成时收敛：`{ text: full, streaming: false }` + `pushDelivery(threadRef)`（非 partial）。

### 2.3 前端 delivery 消费

```ts
function onDelivery(threadRef, partial) {
  if (agent.state.isStreaming && partial) {
    pendingDeliveryRefresh = true;   // ← 丢弃 bot 的流式 partial
    return;
  }
  scheduleTranscriptRefresh(agent, !partial); // 完成投递才 force 刷新
}
```

**丢弃原因**：主 agent 流式期间它的 entry 还没落库，此时 force 拉取 entries 会「丢失」主 agent 正在流式的消息（内存态），所以代码选择了在主 agent 流式期间忽略 bot partial。

## 3. 设计目标

1. 群组会话中，主 agent 与多个附加机器人的流式回复**并行、实时、独立**渲染到聊天区。
2. 不依赖「主 agent 结束后兜底轮询」。
3. **单聊不受影响**：单人会话的 SSE 打字机体验保持原样。
4. 头像：每个机器人写死头像（群助手 🤖、客服 🎧、技术 🔧、幽默 😄）。

## 4. 设计方案：统一「草稿 entry + delivery 定向刷新」

核心思想：**主 agent 也像 bot 一样写流式草稿 entry**，让「所有正在生成的内容」都在 entries 里。前端收到任意 delivery 就定向刷新，entriesToMessages 一次转换出「主 agent 流式 + 各 bot 流式」全部消息，彼此不覆盖。

### 4.1 core 侧改动

#### (a) delivery 事件带来源与定位

`pushDelivery(threadRef, opts)`，其中 `opts`：

```ts
type DeliverySource =
  | { kind: "primary" }
  | { kind: "bot"; botId: string };

interface DeliveryEvent {
  threadRef: string;
  partial?: boolean;
  source?: DeliverySource;
  entrySeq?: number;      // 目标草稿 entry 的 seq（前端定向更新）
}
```

推送帧：

```
event: delivery
data: {"threadRef":"...","partial":true,"source":{"kind":"bot","botId":"customer-service"},"entrySeq":12}
```

#### (b) 主 agent 改为「流式草稿 entry」

主 agent run 开始时（`completeChatStream` 前）：

```ts
const draft = {
  seq: 0, parentSeq: null, type: "assistant",
  payload: { text: "", author: primaryNameFor(session),
            avatar: primaryAvatarFor(session), streaming: true },
  createdAt: at0,
};
// 落库 draft，pushDelivery({ source: { kind: "primary" }, entrySeq })
```

`onPartial`（节流 120ms，与 bot 一致）：

```ts
publishPartial(full) {
  draft.payload.text = full;
  store.patchSession(...);
  pushDelivery(threadRef, { partial: true, source: { kind: "primary" }, entrySeq: draft.seq });
}
```

完成时：

```ts
draft.payload.text = text;
draft.payload.streaming = false;
store.patchSession(...);
pushDelivery(threadRef, { source: { kind: "primary" }, entrySeq: draft.seq }); // 非 partial
```

主 agent 仍保留 SSE 流式通道（单聊打字机体验不变），只是**额外**写草稿 entry。这样群组里 force 刷新不会丢主 agent 内容，单聊也不受影响。

#### (c) bot 侧改用同样的定向 delivery

bot 现有 draft entry 逻辑保留，只需在 `pushDelivery` 里带上 `source: { kind: "bot", botId }` 和 `entrySeq`。

### 4.2 前端侧改动

#### (a) 移除「主 agent 流式期间丢弃 bot partial」的 hack

```ts
function onDelivery(threadRef, partial, source) {
  if (!agent || threadRef !== chatState.threadRef) return;
  scheduleTranscriptRefresh(agent, true); // 所有 delivery 都 force 定向刷新
}
```

因为主 agent 现在也有草稿 entry，force 刷新不会丢失主 agent 消息，所以无需再丢弃 bot partial。

#### (b) refreshTranscriptFromEntries 的守卫对齐

- 三处 `agent.state.isStreaming` 守卫在 force 时全部绕过（第三处已修复）。
- 主 agent 流式期间 force 刷新是**安全的**：entries 里有主 agent 草稿（partial text）+ bot 草稿，entriesToMessages 一次转出全部流式消息。

#### (c) 流式消息去重（关键）

主 agent 现在有两条渲染来源：
1. SSE 通道（`normalStreamFn`）→ `agent.state.messages` 内存流式消息
2. entries 草稿 → refreshTranscriptFromEntries 拉取转换的消息

需要避免主 agent 消息**重复渲染**。策略：

- **群组会话**：主 agent 流式渲染**只以 entries 为准**（关闭 SSE 内存流式的覆盖，或让 SSE 通道只驱动 `drawActiveChat` 不写 messages）。
- **单聊会话**：主 agent 流式渲染**保持 SSE 通道**（不启用草稿 entry 覆盖），行为与现在完全一致。

具体实现：在 `applyLivePartial` / `followRun` 里按 `chatState.scopeId` 是否 group 分支；group 时把 SSE 的 partial 也映射到对应 entry（或用 entrySeq 对齐），个人时走原逻辑。

#### (d) 头像

- core 已为主 agent 写 `avatar`（默认 🤖），bot 已有 🎧🔧😄。
- 前端 `chatMessage` 已有 `botAvatar || "🤖"` 兜底，保持。

### 4.3 定时兜底

- 保留低频兜底（如 agent_end 后 1.5s/4s 各一次，作为网络抖动保险），但**不再依赖它**来渲染 bot。
- 移除 8s/16s/24s 的密集兜底（因为 bot 流式已实时渲染）。

## 5. 数据流时序（群组，目标状态）

```
用户发"我要退货"
 → 主 agent run 开始：写群助手草稿 entry（streaming, text=""）+ pushDelivery(primary)
 → 主 agent SSE 流式 + 节流更新草稿 entry + pushDelivery(primary, partial)
 → 主 agent 调用 summon_bot(customer-service)
 → bot run 开始：写客服草稿 entry（streaming, text=""）+ pushDelivery(bot, customer-service)
 → bot 节流更新草稿 + pushDelivery(bot, partial)  ← 前端实时渲染客服流式
 → 主 agent 完成：收敛群助手 entry + pushDelivery(primary)
 → bot 完成：收敛客服 entry + pushDelivery(bot)
前端：每次 delivery → force refresh → entriesToMessages → 渲染「群助手(流式/完成) + 客服(流式/完成)」
```

## 6. 兼容性与影响面

| 场景 | 影响 |
|---|---|
| 单聊（个人会话） | 无影响：SSE 打字机通道不变，主 agent 草稿 entry 只作为落库记录，前端 group 分支才启用 |
| 群聊主 agent 流式 | 体验提升：主 agent 也有草稿 entry，刷新不丢 |
| 群聊 bot 流式 | 修复：实时流式渲染，不再等兜底 |
| 头像 | 主 agent 🤖、客服 🎧、技术 🔧、幽默 😄 全部写死 |

## 7. 实施步骤

1. core：`pushDelivery` 支持 `source` + `entrySeq`；主 agent 写草稿 entry + 节流 partial；bot 带 source。
2. web-ui：`onDelivery(threadRef, partial, source)` 改为统一 force 刷新；移除丢弃 hack。
3. web-ui：群组分支下主 agent 流式消息以 entries 为准（去重），单聊保持 SSE。
4. 移除 8s/16s/24s 密集兜底，保留 1.5s/4s 保险。
5. 测试：
   - 单聊：发消息 → SSE 打字机正常，无重复消息。
   - 群聊：发「我要退货」→ 群助手流式 + 客服流式**并行实时**出现，头像正确，无需刷新。

## 8. 风险

- 主 agent 双通道（SSE + 草稿 entry）可能造成重复渲染，需在 group 分支做去重（按 entrySeq/身份）。
- DeepSeek function calling 期间主 agent 的 partial 节流与 entry 写入的时序需用 `withSessionLock` 串行化（已有）。
