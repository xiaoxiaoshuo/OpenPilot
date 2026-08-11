/**
 * gateway — 原生 node:http 轻量 HTTP 服务
 *
 * 零运行时依赖：不引入 Express/Fastify 等框架，只用 node:http 手写迷你路由。
 * 设计目标：轻量、可控、模块自包含。
 *
 * 运行：
 *   npm run dev    （--watch 热重载）
 *   npm start
 * 环境变量：
 *   PORT  监听端口（默认 8097）
 *   HOST  监听地址（默认 0.0.0.0）
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Params = Record<string, string>;

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Params,
) => void | Promise<void>;

type Route = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
};

const routes: Route[] = [];

/** 注册路由：path 支持 :param 占位符，如 /api/v1/users/:id */
function addRoute(method: string, path: string, handler: Handler): void {
  const paramNames: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
        paramNames.push(name);
        return '([^/]+)';
      }) +
      '/?$',
  );
  routes.push({ method, pattern, paramNames, handler });
}

export const get = (path: string, handler: Handler) => addRoute('GET', path, handler);
export const post = (path: string, handler: Handler) => addRoute('POST', path, handler);
export const put = (path: string, handler: Handler) => addRoute('PUT', path, handler);
export const patch = (path: string, handler: Handler) => addRoute('PATCH', path, handler);
export const del = (path: string, handler: Handler) => addRoute('DELETE', path, handler);

/** JSON 响应 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** 读取请求体（文本），上限 1MB 防滥用 */
export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

// ───────────────────────── 路由示例 ─────────────────────────

get('/healthz', (_req, res) => {
  sendJson(res, 200, { ok: true, service: 'gateway', uptime: process.uptime() });
});

get('/api/v1/ping', (_req, res) => {
  sendJson(res, 200, { pong: true, ts: new Date().toISOString() });
});

// 路径参数示例：GET /api/v1/users/42
get('/api/v1/users/:id', (_req, res, params) => {
  sendJson(res, 200, { user: { id: params.id } });
});

// POST 示例：echo 收到的 JSON body
post('/api/v1/echo', async (req, res) => {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendError(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
    return;
  }
  sendJson(res, 200, { received: body });
});

// ───────────────────────── server ─────────────────────────

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (!match) continue;

    const params: Params = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1] ?? '');
    });

    try {
      await route.handler(req, res, params);
    } catch (err) {
      console.error(`[gateway] ${method} ${path} failed:`, err);
      if (!res.headersSent) {
        sendError(res, 500, 'INTERNAL', 'Internal server error');
      } else {
        res.end();
      }
    }
    return;
  }

  sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${path}`);
});

const PORT = Number(process.env.PORT ?? 8097);
const HOST = process.env.HOST ?? '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`[gateway] listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  console.error('[gateway] server error:', err);
  process.exit(1);
});
