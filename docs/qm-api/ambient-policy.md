# GET/PUT /api/contexts/:scope/ambient-policy

scope 的 ambient 策略（standing order / bots / ambient 开关）。**仅 channel 和 group scope 有效**。

## 请求

```
GET /api/contexts/group:web-project-13535954-.../ambient-policy
PUT /api/contexts/group:web-project-13535954-.../ambient-policy
```

PUT body：

```json
{
  "orders": "每日早上同步进度到频道",
  "bots": {},
  "ambientEnabled": true,
  "baseUpdatedAt": 1720000000000
}
```

| 字段 | 说明 |
|---|---|
| `orders` | standing order 文本，**上限 20000 字符**（渲染进每次 ambient 判断） |
| `bots` | bot 账本（parseBotLedger 校验，非法 → 400） |
| `ambientEnabled` | true/false/null（null=默认规则） |
| `baseUpdatedAt` | 并发冲突检测：与当前 updatedAt 不一致 → **409 conflict**，提示重新加载 |

## 链路

```
浏览器 → Web UI:8096 (index.ts:810)
       → Core /v1/contexts/policy (context-policy.ts:94, auth:source)
       → deps.channelPolicy.get/set（channel-policy-store，Postgres 持久化）
```

## 校验（getContextPolicy / setContextPolicy）

| 条件 | 返回 |
|---|---|
| 缺 principalId/scope | 400 |
| scope 非 channel/group | 400 "ambient policy applies to channel and group scopes only" |
| deployment 无 channelPolicy | 404 |
| 非该 scope 成员（memberScope = listContexts 包含该 scope） | **403 forbidden** |
| orders 超长 / bots 非法 / ambientEnabled 类型错 | 400 |
| baseUpdatedAt 冲突 | 409 conflict |

## 响应

```json
// GET / PUT 成功
{
  "policy": {
    "orders": "",
    "bots": {},
    "ambientEnabled": null,
    "updatedAt": 0
  }
}
```

实测新项目返回空策略（`updatedAt: 0`，从未配置）。PUT 成功会审计 `surface.policy.set`。

## 相关

- ambient 机制：core 的 ambient judge 用该策略决定"无人说话时是否主动发言"。
- 与 `/api/turn` 的 `proactiveOpener`、watches（`/api/sessions` 的 `watches` 字段）相关。
