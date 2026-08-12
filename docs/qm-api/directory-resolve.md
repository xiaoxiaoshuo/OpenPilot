# GET /api/directory/resolve?q=

成员搜索（收件人解析）。

## 请求

```
GET /api/directory/resolve?q=2212
```

| 参数 | 说明 |
|---|---|
| `q` | 搜索词（trim，最长 80）。归一化：trim + lowercase + 去 `@#` 前缀 |

## 链路

```
浏览器 → Web UI:8096 (index.ts:900)
       → Core /v1/directory/resolve (directory.ts:127, auth:either)
       → app.resolveRecipient → deps.directory.resolve (postgres-directory-store.ts:461)
```

## 匹配顺序（directory.resolve）

1. `slack_id` 精确匹配
2. `principal_id` 精确匹配（normDirectoryQuery）
3. `display_name` 精确匹配（一个 → one，多个 → ambiguous）
4. `display_name` **前缀** LIKE
5. `display_name` **包含** LIKE

## 响应

```json
// 无匹配
{ "matches": [] }
// 唯一
{ "matches": [{ "principalId": "...", "displayName": "...", "type": "internal", "slackId": "U..." }] }
// 模糊
{ "matches": [{ ... }, { ... }] }
```

## ⚠️ 数据来源：查不到人的根因

`directory_members` 表**唯一写入来源是 Slack 快照同步**（全量 DELETE+INSERT）：

```
Slack 快照 → slack/directory.ts:325 pushDirectory
           → Core /v1/directory → upsertDirectory（全量替换）
```

**邮箱注册（OIDC 邮件登录）的用户不会写入这张表** —— auth/onboarding 流程没有任何 directory 注册代码。因此：

- `q=2212` 等任何查询都返回空（本地库实测 0 行）
- 自己的邮箱账号（如 171232349@qq.com）也查不到
- 即使查到了，`displayName` 也来自 Slack 同步的显示名

但邮箱用户仍是 internal（`identity.classify` 宽松判定：未停用即 internal），能登录、建项目、发消息——只是不在成员目录里。

## 影响

| 现象 | 原因 |
|---|---|
| resolve 查不到邮箱用户 | directory_members 无记录 |
| 项目 `members[].displayName` 显示邮箱本身 | `directory.get()` 查无此人，fallback principal_id |
| 建项目/加成员正常 | 权限走 classify，不走 directory 表 |

## 修复方向（如需邮箱用户可搜索）

1. 邮箱首次登录时增量注册 directory（新增单条 upsert API，避开全量替换语义）
2. resolve 增加第二数据源（sessions 参与者 / principals 表）
3. 项目成员搜索直接用 project.memberIds
