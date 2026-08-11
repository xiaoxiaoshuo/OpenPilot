/**
 * 一次性 claim（防重放）— 替代 qm 中 Core 的 /v1/auth/broker/claim + source_auth_replay 表。
 * OpenPilot 暂无独立 Core，这里在 IdP 进程内实现：
 *   - code:<jti> 只能消费一次（OIDC authorization code）
 *   - 内存 Set + 过期清理；进程重启后签名有效期内的 token 仍受签名保护（无法伪造），
 *     但"已用"状态会丢失（简化版取舍，生产可换 SQLite/Postgres 持久化）。
 */
export interface ClaimStore {
  claimOnce(id: string, expiresAtMs: number): Promise<boolean>;
}

export function createMemoryClaimStore(): ClaimStore {
  const claimed = new Map<string, number>();
  let nextPruneAt = 0;
  const PRUNE_INTERVAL_MS = 60_000;

  return {
    async claimOnce(id, expiresAtMs) {
      const t = Date.now();
      if (t >= nextPruneAt) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        for (const [key, exp] of claimed) {
          if (exp < t) claimed.delete(key);
        }
      }
      if (claimed.has(id)) return false;
      claimed.set(id, expiresAtMs);
      return true;
    },
  };
}

export async function claimOnce(store: ClaimStore, id: string, expiresAtMs: number): Promise<boolean> {
  return store.claimOnce(id, expiresAtMs);
}
