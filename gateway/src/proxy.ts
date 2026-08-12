/**
 * gateway 反代 — 参考 qm plugins/portal/src/proxy.ts
 *  - /idp/*         → IdP :8201（去 /idp 前缀）
 *  - 其余 /          → Web UI :8202（注入 x-portal-identity）
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../core/chassis/src/portal-identity.ts";
import type { SessionClaims } from "./session.ts";

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: URL,
  headers: Record<string, string> = {},
): void {
  const u = new URL(req.url ?? "/", upstream);
  const headersOut: Record<string, string> = {
    ...headers,
    host: upstream.host,
  };
  const upstreamReq = httpRequest(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: req.method ?? "GET",
      headers: headersOut,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (err) => {
    console.error(`[gateway] upstream ${upstream.origin} failed:`, err.message);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_unavailable" }));
  });
  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  const chunked = req.headers["transfer-encoding"] !== undefined;
  if (hasBody && (declaredLength > 0 || chunked)) {
    req.pipe(upstreamReq);
  } else {
    upstreamReq.end();
  }
}

export function createProxy(opts: { idpUpstream: string; webUiUpstream: string; identitySecret?: string }) {
  const idpUrl = new URL(opts.idpUpstream);
  const webUrl = new URL(opts.webUiUpstream);

  /** /idp/* → IdP，去掉 /idp 前缀 */
  function idp(req: IncomingMessage, res: ServerResponse): void {
    const raw = new URL(req.url ?? "/", "http://gateway.local");
    const stripped = raw.pathname.replace(/^\/idp/, "") || "/";
    req.url = `${stripped}${raw.search}`;
    forward(req, res, idpUrl);
  }

  /** 其余路径 → Web UI，注入 x-portal-identity（登录用户） */
  function web(req: IncomingMessage, res: ServerResponse, session: SessionClaims | null): void {
    const headers: Record<string, string> = {};
    if (session && opts.identitySecret) {
      headers[PORTAL_IDENTITY_HEADER] = mintPortalIdentity(
        {
          p: session.sub,
          ...(session.name ? { n: session.name } : {}),
          exp: session.exp * 1000,
        },
        opts.identitySecret,
      );
    }
    forward(req, res, webUrl, headers);
  }

  return { idp, web };
}
