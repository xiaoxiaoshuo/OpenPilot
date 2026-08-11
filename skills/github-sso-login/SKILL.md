---
name: github-sso-login
description: 快速集成 GitHub 第三方登录 (SSO)。OAuth 2.0 授权码模式，含 GitHub 开发者中心配置、前端跳转、后端换取 AccessToken 与用户资料、隐私邮箱处理与踩坑注意事项。
---

# 快速集成 GitHub 第三方登录 (SSO)

## 📌 场景与优势

**适用场景**：技术类网站、开发者社区、开源项目工具、独立 SaaS 或面向极客/程序员的平台。

**核心优势**：完全免费、无需企业资质（个人账号几秒钟就能开通）、OAuth 2.0 标准协议、接口对开发者极其友好。

## 🧭 核心实现流程

GitHub 采用经典的 OAuth 2.0 授权码模式 (Authorization Code Grant)：

```text
[ 用户 ] --- 1. 点击"GitHub登录" ---> [ 前端 ] --- 2. 重定向 ---> [ GitHub 授权页 ]
                                                                        |
[ 前端 ] <--- 4. 带上临时 Code 重定向回来 <--- 3. 同意授权 --------------|
   |
   | 5. 将临时 Code 发送给后端
   v
[ 后端 ] --- 6. 用 Code + Client Secret 换取 AccessToken ---> [ GitHub 服务器 ]
[ 后端 ] <--- 7. 返回 AccessToken ---------------------------- [ GitHub 服务器 ]
   |
   | 8. 用 AccessToken 请求用户信息 API
   v
[ 后端 ] --- 9. 获取用户 Profile (ID, 昵称, 头像, 邮箱) -------> [ GitHub 服务器 ]
   |
   +---> 10. [业务逻辑]：本地落库/登录，返回你自己系统的登录态给前端
```

## 🛠️ Step 1: GitHub 开发者中心配置

1. **登录 GitHub**：访问 GitHub 个人设置。
2. **进入开发者设置**：在左侧菜单最下方，点击 `Developer settings`。
3. **创建 OAuth 应用**：点击 `OAuth Apps -> Register a new application`。
   - **Application name**：你的应用名称（展示给授权用户的）。
   - **Homepage URL**：你的主页地址（如本地测试填 `http://localhost:3000`）。
   - **Authorization callback URL**（最重要）：用户授权成功后，GitHub 带着 code 走回调的地址。可以填前端路由或后端接口（例如：`http://localhost:3000/auth/github/callback`）。
4. **生成密钥**：创建成功后，点击 `Generate a new client secret`。
5. **记录凭证**：妥善保存页面上的 **Client ID** 和 **Client Secret**。

## 🌐 Step 2: 前端触发展开 (Vanilla JS / HTML)

GitHub 登录不需要像 Google 那样引入特殊的 JS SDK，它本质上就是一个超链接重定向。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>GitHub SSO 测试</title>
</head>
<body>

    <h2>欢迎登录我的系统</h2>

    <!-- 点击按钮，直接跳转到 GitHub 授权页 -->
    <!-- 注意：请将 YOUR_CLIENT_ID 替换为你在 GitHub 申请到的 ID -->
    <!-- redirect_uri 必须与你在 GitHub 填写的 Authorization callback URL 完全一致 -->
    <a href="https://github.com/login/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fgithub%2Fcallback&scope=user:email">
        <button style="padding: 10px 20px; background: #24292e; color: white; border: none; border-radius: 5px; cursor: pointer;">
            使用 GitHub 账号登录
        </button>
    </a>

    <script>
        // 假设用户在 GitHub 同意授权后，页面跳转回到了当前页，并且 URL 变成了：
        // http://localhost:3000/auth/github/callback?code=xyz123
        
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');

        if (code) {
            console.log("获取到 GitHub 临时 Code:", code);
            
            // 将 Code 发送给后端换取令牌和用户信息
            fetch('http://localhost:8080/api/auth/github', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    alert("登录成功！欢迎回来，" + data.user.name);
                    // 清除 URL 中的 code 防止二次刷新报错
                    window.history.replaceState({}, document.title, window.location.pathname);
                }
            });
        }
    </script>
</body>
</html>
```

## 🖥️ Step 3: 后端换取 Token 并获取用户资料 (Node.js 示例)

后端需要拿到前端传过来的 code，在服务器端向 GitHub 发起两次请求：第一次换 Token，第二次查资料。

安装网络请求库（如 axios）：

```bash
npm install express axios
```

后端核心逻辑代码：

```javascript
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// 配置你的 GitHub 凭证
const CLIENT_ID = 'YOUR_GITHUB_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_GITHUB_CLIENT_SECRET';

app.post('/api/auth/github', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ success: false, message: "缺少 Code" });
    }

    try {
        // 1. 拿着 code + 密钥，向 GitHub 换取 Access Token
        const tokenResponse = await axios.post('https://github.com/login/oauth/access_token', {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code
        }, {
            headers: { accept: 'application/json' } // 规定返回数据格式为 JSON
        });

        const accessToken = tokenResponse.data.access_token;

        if (!accessToken) {
            return res.status(400).json({ success: false, message: "换取 Access Token 失败" });
        }

        // 2. 使用 Access Token 请求 GitHub API 获取用户信息
        const userResponse = await axios.get('https://api.github.com/user', {
            headers: { Authorization: `token ${accessToken}` }
        });

        const githubUser = userResponse.data;

        // 从数据中提取我们需要的信息
        const userId = githubUser.id;        // GitHub 用户的唯一数字 ID
        const name = githubUser.name || githubUser.login; // 昵称
        const avatar = githubUser.avatar_url; // 头像地址
        const email = githubUser.email;      // 邮箱（注意：有时如果用户设置隐私，这里可能为 null）

        // 3. [业务逻辑]：在此处查询你自己的数据库
        // 判断此 userId 是否存在。若存在则登录；若不存在则自动注册。

        res.json({
            success: true,
            user: { id: userId, name, avatar, email }
        });

    } catch (error) {
        console.error("GitHub 登录失败:", error.message);
        res.status(500).json({ success: false, message: "服务内部错误" });
    }
});

app.listen(8080, () => console.log('后端服务已在 8080 端口启动...'));
```

## ⚠️ 踩坑与注意事项 (Best Practices)

1. **隐私邮箱获取不到（大坑）**：如果用户在 GitHub 把邮箱设为"隐藏"，`/api/github.com` 返回的 email 会是 null。如果你系统强制要求邮箱，需要在授权 URL 的 scope 里加上 `user:email`，并且在后端追加请求单独接口 `https://api.github.com/user/emails` 去读取用户的私有邮箱。
2. **Code 的时效性**：GitHub 返回的临时 code 只能使用一次，且只有 **10 分钟**有效期。一旦用来换过一次 Token，或者超时，这个 Code 就会作废，前端必须刷新重新引导用户授权。
3. **Client Secret 安全**：Client Secret 是你应用的最高机密，绝对不能写在前端、App 或者提交到公开的 GitHub 仓库里！所有换取 Token 的步骤必须在后端完成。
4. **redirect_uri 必须完全一致**：授权请求中的 `redirect_uri` 必须与 GitHub 后台填写的 Authorization callback URL 逐字符一致（含端口、路径、编码），否则 GitHub 会报 `redirect_uri mismatch`。

## 🗂️ 两种 SSO 账号关联模式（数据库设计参考）

同时接入 Google 与 GitHub 时，先决定账号关联策略，它决定 `users` 表结构：

| 模式 | 说明 | 表结构 |
|---|---|---|
| **账号绑定模式** | 一个账号可同时绑定 Google 和 GitHub（第三方 provider 都指向同一本地用户） | `users` 主表 + `user_oauth_accounts(provider, provider_sub, user_id)` 关联表，`provider+provider_sub` 唯一 |
| **独立账号模式** | 各登各的，每个第三方身份自动创建独立新用户 | `users` 表直接存 `provider` + `provider_sub`，或沿用 `user_oauth_accounts` 但每次登录按 provider 身份新开账号 |

**推荐**：账号绑定模式。同一自然人多端登录时数据不分裂，符合"数据按 Scope 隔离"的要求；`user_oauth_accounts` 关联表 + 唯一约束（provider, provider_sub）天然防重复绑定，也兼容后续接入更多 Provider。
