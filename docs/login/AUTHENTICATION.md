# 用户认证与授权（Authentication & Authorization）

> 功能描述文档 · 版本 v0.1
> 对应参考项目：yc-software/qm（Scope 隔离模型）
> 相关文档：docs/PROJECT_PLAN.md（总体规划）、README.md（技术框架）

---

## 1. 功能概述

实现**多用户登录**，并保证：

- 用户只能访问和管理**自己的数据**（完整的访问控制 ACL）
- **严格数据隔离**：用户 A 绝不能访问、修改或删除用户 B 的任何对话或消息
- **群组对话权限**妥善管理：群组的加入、发言、管理权限按角色区分

---

## 2. 登录方式

登录方式为**可配置可切换**，支持以下两种主要方式，并保留邮件验证码登录作为补充。

### 2.1 方式一：用户名 / 密码注册与登录（默认）

| 环节 | 说明 |
|---|---|
| 注册 | 填写用户名（唯一）+ 密码 + 邮箱（可选绑定），创建账户 |
| 密码存储 | `argon2id` 哈希（带盐），绝不明文存储 |
| 密码策略 | 最小 8 位，含字母与数字；支持强度校验（zod 校验） |
| 登录 | 用户名/邮箱 + 密码 → 校验通过签发会话 |
| 失败限流 | 同一账户连续失败 5 次锁定 15 分钟（按 IP + 账户双重限流） |
| 找回密码 | 绑定邮箱后可用邮箱验证码重置（复用邮件服务） |

**数据表**：`users`（email 唯一、password_hash、nickname、avatar_url、status、role）。

### 2.2 方式二：第三方登录（Google / GitHub / SSO）

支持 OAuth 2.0 / OIDC 协议接入，配置方式如下。

#### 2.2.1 通用配置步骤

1. 在第三方平台创建 OAuth Client（或 OIDC Provider），登记回调地址：
   `https://<domain>/api/v1/auth/oauth/callback/<provider>`
2. 将获得的 `client_id` / `client_secret` 写入环境变量（见下表）
3. 重启 Core 服务，第三方登录入口自动出现在登录页

| Provider | 环境变量 | 说明 |
|---|---|---|
| Google | `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth 2.0 Client，授权范围 `openid email profile` |
| GitHub | `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET` | GitHub Settings → Developer settings → OAuth Apps |
| 通用 SSO | `OAUTH_OIDC_ISSUER` / `OAUTH_OIDC_CLIENT_ID` / `OAUTH_OIDC_CLIENT_SECRET` | 任意 OIDC Provider，`jose` 校验 id_token 签名（JWKS） |

#### 2.2.2 登录流程

```text
用户点击 [Google / GitHub / SSO] 登录
  → 跳转第三方授权页（scope: openid email profile）
  → 用户授权 → 回调至 /api/v1/auth/oauth/callback/<provider>
  → 校验 code（换取 token）+ 校验 id_token 签名（jose, JWKS）
  → 按 email 关联/创建本地用户 → 签发会话
```

#### 2.2.3 测试账号

> 说明：本项在接入第三方登录后提供**两个测试账号**用于验收——
> 1. `test01@openpilot.chat`（密码登录账号，预置若干对话与消息）
> 2. `test02@openpilot.chat`（第三方登录绑定账号，预置若干对话与消息）
> 两个账号分别持有**互不相同的数据集**，用于验证数据隔离（见 §4 验收用例）。

### 2.3 补充：邮件验证码登录（README 已规划）

- 输入邮箱 → 发送 6 位验证码（Resend API 或自实现 SMTP，可切换）→ 校验通过登录
- 验证码 5 分钟有效、单次使用、每邮箱每小时限 5 次

---

## 3. 会话管理

| 项目 | 方案 |
|---|---|
| 会话载体 | Session cookie（`HttpOnly` + `Secure` + `SameSite=Lax`），默认 7 天 |
| 会话存储 | PostgreSQL `sessions` 表，存 token 的 sha256 哈希（泄漏 DB 不泄漏会话） |
| 续期 | 滑动续期：活跃会话自动延长 |
| 吊销 | 登出、修改密码、管理员禁用 → 立即吊销全部/指定会话 |
| 多端 | 支持同一用户多设备会话并存，可在"我的会话"中查看并踢出 |

---

## 4. 数据隔离与访问控制（ACL）

### 4.1 隔离原则（硬性要求）

> **用户 A 绝不能访问、修改或删除用户 B 的任何对话或消息。** 此条为不可协商的硬性约束，通过架构与测试双重保证。

### 4.2 实现机制

1. **Scope 字段**：所有多租户表带 `scope`（owner 用户 id），个人资源查询强制 `WHERE scope = $current_user`。
2. **统一封装**：Core 层所有多租户 SQL 经 `scoped()` 辅助函数生成，禁止手写裸查询漏条件。
3. **群组校验**：群组资源先校验 `conversation_participants` 中是否存在当前用户（或用户被授予的角色），再放行。
4. **行级权限检查**：任何按 id 取资源的接口（`GET /conversations/:id` 等）必须带 scope/参与方校验，404 而非 403（避免资源存在性泄漏）。
5. **操作级 ACL**：读、写、删分别校验（见下表）。
6. **专项测试**：数据隔离测试覆盖所有多租户查询路径，CI 强制通过。

### 4.3 个人数据操作权限矩阵

| 资源 | 读 | 写（增/改） | 删 |
|---|---|---|---|
| 个人对话 | 仅 owner | 仅 owner | 仅 owner |
| 个人消息 | 仅 owner | 仅 owner | 仅 owner（或软删） |
| 标签 | 仅 owner | 仅 owner | 仅 owner |
| 文件 | 仅 owner | 仅 owner | 仅 owner |
| 机器人配置 | 仅 owner | 仅 owner | 仅 owner |

### 4.4 数据隔离验收用例

1. 用户 A、B 分别登录，A 创建对话与消息
2. A 尝试通过 B 的资源 id 直接调用 `GET/PATCH/DELETE` → 全部返回 404
3. A 的对话列表中不出现 B 的任何对话（列表接口带 scope 过滤）
4. A 无法通过消息分页接口翻到 B 的消息
5. A 无法给 B 的对话添加标签或参与方
6. 以上用例自动化进 CI

---

## 5. 群组对话权限管理

### 5.1 角色模型

| 角色 | 说明 |
|---|---|
| owner | 群组创建者，拥有全部权限，可转让所有权 |
| admin | 可管理成员与机器人、修改群组信息、删除任意成员消息 |
| member | 默认角色，可发言、可查看历史消息 |
| bot | 机器人参与方，仅可发送机器人消息，受冷却限制 |

### 5.2 群组权限矩阵

| 操作 | owner | admin | member | bot |
|---|---|---|---|---|
| 查看群组与历史消息 | ✅ | ✅ | ✅ | ✅（经群组授权） |
| 发送消息 | ✅ | ✅ | ✅ | ✅（冷却限制） |
| 邀请/移除成员 | ✅ | ✅ | ❌ | ❌ |
| 添加/移除机器人 | ✅ | ✅ | ❌ | ❌ |
| 修改群组信息/标题 | ✅ | ✅ | ❌ | ❌ |
| 删除他人消息 | ✅ | ✅ | ❌ | ❌ |
| 解散群组 / 转让 | ✅ | ❌ | ❌ | ❌ |

### 5.3 群组权限校验流程

```text
请求群组资源
  → 取当前用户 → 查 conversation_participants 得角色
  → 角色不在该操作允许集合 → 403
  → 通过 → 放行（消息按群组 id 过滤，禁止跨群取数）
```

---

## 6. 与现有技术栈的衔接

| 模块 | 实现 |
|---|---|
| 认证协议 | OIDC（Portal 作 Client，内置 auth broker 作 IdP）；第三方登录复用同一 OIDC 流程 |
| JWT/JWK/JWKS | `jose`（RS256，`/.well-known/jwks.json` 暴露公钥） |
| 密码哈希 | argon2id |
| 会话 | Session cookie + PostgreSQL `sessions` 表 |
| 邮箱 | Resend API（fetch）或自实现 SMTP（`node:net` + `node:tls`） |
| 校验 | zod / typebox（注册、登录、授权参数全量校验） |
| 限流 | 登录/发码/敏感操作按用户 + IP 限流（429） |

---

## 7. 验收标准

- [ ] 用户名/密码注册 → 登录 → 登出 → 会话吊销全流程可用
- [ ] 密码以 argon2id 存储，库泄漏无法反推明文
- [ ] 第三方登录（Google / GitHub / SSO）任一可配置接入，`测试账号 test01 / test02` 可登录
- [ ] §4.4 数据隔离用例全部通过（自动化）
- [ ] 群组角色权限矩阵与 §5.2 一致
- [ ] 会话续期、吊销、多端管理可用
- [ ] 登录接口限流生效（429）
