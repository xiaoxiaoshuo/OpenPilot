# GET /api/runtime-config?scopeId=

scope 的运行时配置：可用 harness/模型、org 默认、scope 覆盖、生效值。

## 请求

```
GET /api/runtime-config?scopeId=group:web-project-13535954-9812-46fd-aed2-b1c05edd67b3
```

| 参数 | 说明 |
|---|---|
| `scopeId` | 查询的 scope（`runtimeTarget` 解析；可能是 personal/channel/group/org） |

## 链路

```
浏览器 → Web UI → Core /v1/runtime-config (surface.ts:1365, auth:either)
       → getRuntimeConfig (surface.ts:1194)
       → runtimeTarget(ctx) → runtimeConfigBody
```

`runtimeTarget` 决定生效 scope（签名身份 vs 请求 scopeId 的权限），无权限 → `403 forbidden`。

## 响应（实测）

```json
{
  "scopeId": "group:web-project-13535954-...",
  "approvedHarnesses": ["pi"],
  "modelsByHarness": { "pi": ["deepseek-chat", "deepseek-reasoner"] },
  "modelCatalog": {
    "deepseek-chat": { "name": "deepseek-chat", "provider": "deepseek" },
    "deepseek-reasoner": { "name": "deepseek-reasoner", "provider": "deepseek" }
  },
  "orgDefault": { "harnessId": "pi", "modelId": "deepseek-chat", "revision": 1 },
  "scopeOverride": null,
  "effective": { "harnessId": "pi", "modelId": "deepseek-chat" },
  "upgradeAvailable": false,
  "fastModeModelIds": ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"],
  "interactiveFastMode": false
}
```

| 字段 | 说明 |
|---|---|
| `approvedHarnesses` | 部署允许的 harness |
| `modelsByHarness` | 每 harness 可选模型 |
| `modelCatalog` | 模型元数据（名称、provider） |
| `orgDefault` | org 级默认运行时（`getRuntimeSelectionDurable` 持久化） |
| `scopeOverride` | 本 scope 自定义运行时，null = 继承 org |
| `effective` | 生效值（override ?? orgDefault） |
| `upgradeAvailable` | 是否有新模型提示 |
| `fastModeModelIds` | 支持 fast 模式的模型（deepseek 不在列表） |
| `interactiveFastMode` | org 级交互 fast 开关 |

## 关联 PUT

`PUT /api/runtime-config`（`/v1/runtime-config`，surface.ts:1366）：
- 要求签名身份 `liveActor: true`，否则 403
- body `{ inherit: true }` 恢复继承；`{ keep: true }` 确认当前版本；或 `{ harnessId, modelId }` 设置覆盖
- 写入持久化 runtime selection，审计 `runtime-config.update`

## 注意

- `approvedHarnesses`/`modelsByHarness` 受部署配置限制（本机只有 pi + deepseek）。
- 发消息时（`/api/turn`）的模型校验与此配置一致：模型必须在此列表，否则 `refused`。
