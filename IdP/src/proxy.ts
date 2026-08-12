/**
 * 出站请求代理支持（大陆网络访问 Google/GitHub 走本机代理）
 * - 读 env：HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy / all_proxy
 * - Node 内置 fetch 不读环境变量代理，且与 npm undici 的 dispatcher 混用会冲突，
 *   因此这里统一用 undici 包的 fetch + ProxyAgent（自洽）
 */
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

let cached: Dispatcher | undefined | null;

export function proxyDispatcher(): Dispatcher | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const url =
    process.env.all_proxy ||
    process.env.ALL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    "";
  try {
    cached = url
      ? new ProxyAgent(url, {
          connectTimeout: 30_000,
          headersTimeout: 120_000,
          bodyTimeout: 120_000,
          keepAliveTimeout: 0,
          keepAliveMaxTimeout: 0,
        })
      : null;
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}

/** 带代理的 fetch（无代理配置时等同普通 fetch） */
export function proxiedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const dispatcher = proxyDispatcher();
  return undiciFetch(input, dispatcher ? { ...init, dispatcher } : init);
}
