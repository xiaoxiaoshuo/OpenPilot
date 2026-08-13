/**
 * OpenPilot Chat — pm2 生产部署配置模板
 *
 * 使用前请先替换下面的占位符（REPLACE_*）为真实值，
 * 或直接对照 /opt/openpilot/.env 填写。
 *
 * 注意：必须配合 deploy/run-*.sh wrapper 脚本使用（绕过 pm2 ProcessContainerFork
 * 对 process.argv[1] 的破坏）。wrapper 脚本会被 pm2 通过 /bin/sh 执行，
 * 再由其 exec node 真正启动服务，从而保证入口判断 import.meta.url === argv[1] 成立。
 *
 * 部署步骤见 deploy/DEPLOYMENT.md。
 */

const PORTAL_IDENTITY_SECRET = "REPLACE_PORTAL_IDENTITY_SECRET";
// 公网入口（HTTP 模式，端口 8200；如需 HTTPS 则改为 https:// 并自行配置反代/TLS）
const PUBLIC = "http://openpilot.lijingang.ccwu.cc:8200";

const oauth = {
  GITHUB_CLIENT_ID: "REPLACE_GITHUB_CLIENT_ID",
  GITHUB_CLIENT_SECRET: "REPLACE_GITHUB_CLIENT_SECRET",
  GOOGLE_CLIENT_ID: "REPLACE_GOOGLE_CLIENT_ID",
  GOOGLE_CLIENT_SECRET: "REPLACE_GOOGLE_CLIENT_SECRET",
};

const idpSecrets = {
  IDP_CLIENT_ID: "openpilot-web",
  IDP_CLIENT_SECRET: "REPLACE_IDP_CLIENT_SECRET", // 至少 32 位
  IDP_TOKEN_SECRET: "REPLACE_IDP_TOKEN_SECRET", // 至少 32 位
};

module.exports = {
  apps: [
    {
      name: "openpilot-core",
      script: "/opt/openpilot/run-core.sh",
      interpreter: "/bin/sh",
      autorestart: true,
      max_memory_restart: "300M",
      time: true,
      env: {
        PORTAL_IDENTITY_SECRET,
        CORE_ORG_ID: "local",
        CORE_DATA_DIR: "data",
        DEEPSEEK_API_KEY: "REPLACE_DEEPSEEK_API_KEY",
        CORE_MODEL: "deepseek-chat",
        CORE_MODELS: "deepseek-chat,deepseek-reasoner",
      },
    },
    {
      name: "openpilot-idp",
      script: "/opt/openpilot/run-idp.sh",
      interpreter: "/bin/sh",
      autorestart: true,
      max_memory_restart: "300M",
      time: true,
      env: {
        ...oauth,
        ...idpSecrets,
        IDP_ISSUER: `${PUBLIC}/idp`,
        IDP_REDIRECT_URI: `${PUBLIC}/auth/callback`,
        GITHUB_CALLBACK_URI: `${PUBLIC}/idp/callback/github`,
        GOOGLE_CALLBACK_URI: `${PUBLIC}/idp/callback/google`,
        IDP_DEMO_LOGIN_ENABLED: "true",
      },
    },
    {
      name: "openpilot-web-ui",
      script: "/opt/openpilot/run-web-ui.sh",
      interpreter: "/bin/sh",
      autorestart: true,
      max_memory_restart: "400M",
      time: true,
      env: {
        PORTAL_IDENTITY_SECRET,
        CORE_ORG_ID: "local",
        CORE_API_URL: "http://127.0.0.1:8203",
        WEB_UI_PUBLIC_URL: PUBLIC,
      },
    },
    {
      name: "openpilot-gateway",
      script: "/opt/openpilot/run-gateway.sh",
      interpreter: "/bin/sh",
      autorestart: true,
      max_memory_restart: "300M",
      time: true,
      env: {
        ...oauth,
        ...idpSecrets,
        PORTAL_IDENTITY_SECRET,
        CORE_ORG_ID: "local",
        GATEWAY_PUBLIC_URL: PUBLIC,
        IDP_ISSUER: `${PUBLIC}/idp`,
        IDP_UPSTREAM: "http://127.0.0.1:8201",
        WEB_UI_UPSTREAM: "http://127.0.0.1:8202",
        OIDC_CLIENT_ID: "openpilot-web",
        GATEWAY_SESSION_TTL_S: "604800",
        IDP_DEMO_LOGIN_ENABLED: "true",
      },
    },
  ],
};
