# 群组 bot 流式回复「首条消息不实时显示」诊断日志

- 日期：2026-08-12
- 分支：`pr-17`
- 相关提交：`6477fca`、`0915154`

## 1. 问题现象

群组会话中，用户发消息后：

1. 群助手（主 agent）实时流式回复正常。
2. 群助手判断需要召唤机器人（客服机器人 / 技术机器人），bot 的回复**不实时出现**。
3. **刷新页面后**，bot 回复才显示到页面（同时 bot 头像才显示）。
4. core 数据始终完整（bot 回复确实已写入 db.json），问题在前端实时渲染链路。

## 2. 排查过程

### 2.1 第一层：误判为「群助手未召唤」

最初用固定问题「服务器负载高怎么办」反复测试，多轮 bot 都未出现。抓 core 数据发现：

- 群助手对**重复问题**不再召唤 bot（回复「我注意到大量重复的问题…」），属于 LLM 行为，不是 delivery bug。
- 结论：测试必须区分「群助手是否真的召唤了 bot」与「召唤后前端是否显示」。

### 2.2 第二层：定位到「数据在 core，前端不显示」

用「明确点名机器人」的问题（如「请客服机器人回答：商品退货的运费谁承担」）稳定触发召唤，抓取请求序列：

- 失败时兜底刷新**确实执行了**（agent_end 后 1.5s/4s/8s/16s/24s 全量拉取 `/api/sessions/:id`）。
- 手动 `fetch /api/sessions/:id` 返回完整数据（含客服机器人 905 字回复）。
- 结论：数据没问题，问题在 `refreshTranscriptFromEntries` 的转换/渲染链路。

### 2.3 第三层：三处「空流式草稿被丢弃」+ 一处 force 守卫遗漏

bot 回复在 core 里是「流式草稿条目」：开始时 `streaming: true`、`text: ""`（空文本），完成后才填充文本。这个空草稿在前端三处被丢弃：

| 文件 | 位置 | 问题 |
|---|---|---|
| `web-ui/src/core-bridge.ts` | `entriesToMessages` assistant 分支 | 空 text 的 assistant 条目直接跳过，不生成占位消息 |
| `web-ui/src/chat.ts` | `chatMessage` assistant 分支 | 空 text 且无 work 的消息 `hasVisibleContent=false` → `return nothing` |
| `web-ui/src/chat.ts` | `refreshTranscriptFromEntries` 写 messages 前 | 第三处 `isStreaming` 守卫漏了 `force` 绕过 |

**触发条件**：冷启动首条消息时 delivery SSE 链路未完全就绪，bot 完成投递事件丢失；兜底刷新虽然拉到数据，但被上述丢弃/守卫挡住，导致 bot 消息（含头像）不渲染，刷新页面后才出现。

## 3. 修复内容

### 3.1 `web-ui/src/core-bridge.ts`

`entriesToMessages` assistant 分支：空 streaming 草稿 push 空 text activity 生成占位消息，使其能走到 `flushWork`。

### 3.2 `web-ui/src/chat.ts`

- `chatMessage`：streaming draft 且有 author 时强制渲染（即使 text 为空），保证头像 + 占位即时显示。
- `refreshTranscriptFromEntries`：三处 `isStreaming` 守卫全部支持 `force` 绕过（此前只改了第一、二处，第三处遗漏是兜底刷新失效的直接原因）。
- （前序 `6477fca`）transcriptRefresh 串行化 + `onDelivery` 区分 partial/完成投递 + agent_end 多级延时兜底刷新。

## 4. 验证结果（重启后，gateway 8200 链路）

登录 `221221@qq.com`（demo），进入群组会话 `870d3af1-da1d-4a04-90f5-b88093f22d0f`：

### 4.1 打开会话后实时发消息（「订单的物流到哪里了」）

```
t+2s: 客服机器人 头像🎧 len=329（历史）
t+6s: 客服机器人 头像🎧 len=0   （空草稿占位）
t+8s: 客服机器人 头像🎧 len=245 （流式完成）
```

客服机器人实时出现，头像正确。

### 4.2 冷启动首条消息（「发货太慢了…优惠券还能用吗」）

```
beforeCount = 3（历史客服消息）
t+2s: bots=3（尚未新增）
t+4s: bots=3
t+6s: bots=4 客服机器人 头像🎧 len=55  ← 新 bot 实时出现
t+8s: bots=4 客服机器人 头像🎧 len=314 ← 流式完成
```

冷启动首条消息，客服机器人 t+6s 实时出现，头像正确。

## 5. 结论

- 根因是「bot 流式草稿空文本在前端三处被丢弃 + 第三处 force 守卫遗漏」。
- 修复后 gateway 8200 链路下，冷启动首条消息与后续消息均能实时显示 bot 回复和头像。
- 此前「刷新后才出现」的根源已消除。
