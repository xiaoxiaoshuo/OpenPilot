/**
 * 页面模板 — 简化版（登录选择页在 gateway，IdP 只需要错误页/中间确认页）
 */
import { createHash } from "node:crypto";

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE = `<style>
  :root{
    --bg:#ffffff; --surface:#ffffff; --text:#0a0a0a; --muted:#737373;
    --border:#e5e5e5; --warn:#b42318; --warn-bg:#fdeceb;
    --shadow:0 1px 3px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.05);
    --radius-md:10px; --radius-lg:16px;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0a0a0a; --surface:#171717; --text:#fafafa; --muted:#a3a3a3;
      --border:#2a2a2a; --warn:#ff8a80; --warn-bg:#2a1a1a; }
  }
  *{ box-sizing:border-box; }
  html,body{ height:100%; }
  body{ margin:0; background:var(--bg); color:var(--text); display:flex; min-height:100%;
    font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing:antialiased; }
  main{ margin:auto; padding:32px 20px; width:100%; display:grid; place-items:center; }
  .card{ width:100%; max-width:420px; background:var(--surface); border:1px solid var(--border);
    border-radius:var(--radius-lg); box-shadow:var(--shadow); padding:34px 32px 30px; text-align:center; }
  .icon{ width:52px; height:52px; margin:0 auto 18px; border-radius:var(--radius-md); background:var(--warn-bg);
    display:grid; place-items:center; }
  .icon svg{ width:26px; height:26px; stroke:var(--warn); fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  h1{ font-size:20px; font-weight:600; margin:0 0 8px; }
  .msg{ color:var(--muted); margin:0 auto 22px; max-width:44ch; font-size:14px; }
  .reason{ margin:0 auto 22px; font-size:13px; color:var(--text);
    background:var(--warn-bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:11px 14px; }
</style>`;

function page(body: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title>${STYLE}<main><div class="card">${body}</div></main></html>`;
}

export function problemPage(args: {
  brandName: string;
  heading: string;
  msg: string;
  detail?: string;
  retryUrl?: string;
}): string {
  return page(`
    <div class="icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg></div>
    <h1>${escapeHtml(args.heading)}</h1>
    <p class="msg">${escapeHtml(args.msg)}</p>
    ${args.detail ? `<p class="reason">${escapeHtml(args.detail)}</p>` : ""}
    ${args.retryUrl ? `<p class="msg"><a href="${escapeHtml(args.retryUrl)}">Try signing in again</a></p>` : ""}
  `);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function cspSha256(script: string): string {
  return `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;
}
