/**
 * OpenPilot Core — 最小业务 API
 * 提供 web-ui 复制版所需的 /v1/* 端点，覆盖：会话、消息、AI 回复（DeepSeek）、项目、运行时配置。
 * 认证（dev 模式）：优先验证 x-portal-identity（gateway 注入）；否则信任 query principalId。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { json, readBody } from "../chassis/src/http.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../chassis/src/portal-identity.ts";
import { createStore, type Entry, type StoredSession } from "./store.ts";
import { completeChat } from "./ai.ts";

// ───────────────────────── 配置 ─────────────────────────

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST ?? "0.0.0.0";
const ORG = process.env.CORE_ORG_ID ?? "local";
const IDENTITY_SECRET = process.env.PORTAL_IDENTITY_SECRET || process.env.CORE_SIGNING_SECRET || "";
const DATA_DIR = process.env.CORE_DATA_DIR ?? join(process.cwd(), "data");
const MODEL = process.env.CORE_MODEL ?? "deepseek-chat";
const ALLOWED_MODELS = (process.env.CORE_MODELS ?? "deepseek-chat,deepseek-reasoner")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const store = createStore(DATA_DIR);

// ───────────────────────── run 状态（内存）─────────────────────────

interface Run {
  id: string;
  sessionId: string;
  threadRef: string;
  status: "working" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
const runs = new Map<string, Run>();
const runsBySession = new Map<string, string[]>(); // sessionId -> runIds

// ── 推送：SSE 长连接 + 投递队列 ──
const sseClients = new Set<ServerResponse>();
const pendingDeliveries = new Map<string, { threadRef: string; createdAt: number }>();

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    sseClients.delete(res);
  }
}

function pushSessionState(threadRef: string, sessionId: string, state: "working" | "idle", at: number): void {
  const frame = { threadRef, sessionId, state, at };
  for (const res of [...sseClients]) sseWrite(res, "session_state", frame);
}

function enqueueDelivery(threadRef: string): void {
  const id = randomUUID();
  pendingDeliveries.set(id, { threadRef, createdAt: Date.now() });
}

// ───────────────────────── 工具 ─────────────────────────

function principalOf(req: IncomingMessage, url: URL): string | null {
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token && IDENTITY_SECRET) {
    const claims = verifyPortalIdentity(token, IDENTITY_SECRET, Date.now());
    if (claims && claims.p) return claims.p;
  }
  const fromQuery = url.searchParams.get("principalId")?.trim();
  if (fromQuery) return fromQuery;
  return null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  json(res, status, body);
}

function sessionView(s: StoredSession): Record<string, unknown> {
  const sessionRuns = runsBySession.get(s.id) ?? [];
  const working = sessionRuns.some((id) => runs.get(id)?.status === "working");
  return {
    id: s.id,
    type: s.type,
    scopeId: s.scopeId,
    threadRef: s.threadRef,
    title: s.title,
    surface: s.surface,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    messages: s.messages,
    turns: s.turns,
    ...(s.tags?.length ? { tags: s.tags } : {}),
    ...(s.archived ? { archived: true } : {}),
    ...(s.pinned ? { pinned: true } : {}),
    ...(s.color ? { color: s.color } : {}),
    ...(working ? { working: true } : {}),
  };
}

function entryView(e: Entry): Record<string, unknown> {
  return {
    seq: e.seq,
    parentSeq: e.parentSeq,
    type: e.type,
    payload: e.payload,
    createdAt: e.createdAt,
  };
}

function scopeOf(principal: string, scopeIdRaw: string | null): string {
  if (scopeIdRaw && (scopeIdRaw.startsWith("group:") || scopeIdRaw.startsWith("channel:"))) return scopeIdRaw;
  return `personal:${principal}`;
}

function findSessionByThread(threadRef: string): StoredSession | null {
  for (const s of store.listSessions()) if (s.threadRef === threadRef) return s;
  return null;
}

// ───────────────────────── 路由 ─────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const principal = principalOf(req, url);

  // ---- 无认证端点 ----
  if (method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
  if (method === "GET" && path === "/v1/surface-config")
    return send(res, 200, { branding: {}, surface: "web", org: ORG });
  if (method === "GET" && path === "/v1/session-state/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": open\n\n");
    sseClients.add(res);
    const beat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        sseClients.delete(res);
        clearInterval(beat);
      }
    }, 25_000);
    req.on("close", () => {
      clearInterval(beat);
      sseClients.delete(res);
    });
    return;
  }
  if (method === "POST" && path === "/v1/session-cap") return send(res, 200, { token: "", actorId: principal ?? "" });

  // 后台轮询端点（web-ui 定时任务不携带用户身份头）：deliveries 全局队列 + SSE
  if (method === "GET" && path === "/v1/deliveries") {
    const type = url.searchParams.get("type");
    if (type !== "web") return send(res, 200, { deliveries: [] });
    return send(
      res,
      200,
      {
        deliveries: [...pendingDeliveries.entries()].map(([id, d]) => ({
          id,
          idempotencyKey: id,
          createdAt: d.createdAt,
          destination: { target: d.threadRef },
        })),
      },
    );
  }
  if (method === "POST" && path.match(/^\/v1\/deliveries\/[^/]+\/ack$/)) {
    const id = decodeURIComponent(path.split("/")[3] ?? "");
    pendingDeliveries.delete(id);
    return send(res, 200, { ok: true });
  }

  // ---- 需要 principal 的端点 ----
  if (!principal) return send(res, 401, { error: "sign in", message: "principal required" });

  if (method === "GET" && path === "/v1/contexts") {
    const personal = {
      scopeId: `personal:${principal}`,
      kind: "personal",
      name: principal,
      memberCount: 1,
    };
    const projects = store.listProjects().filter((p) => p.memberIds.includes(principal));
    const groupContexts = projects.map((p) => ({
      scopeId: `group:web-project-${p.id}`,
      kind: "group",
      name: p.name,
      memberCount: p.memberIds.length,
    }));
    return send(res, 200, { contexts: [personal, ...groupContexts] });
  }

  if (method === "GET" && path === "/v1/sessions") {
    const scope = url.searchParams.get("scope") ?? null;
    const all = store.listSessions();
    const filtered = scope
      ? all.filter((s) => s.scopeId === scope)
      : all.filter((s) => s.scopeId === `personal:${principal}`);
    return send(res, 200, { sessions: filtered.map(sessionView) });
  }

  if (method === "GET" && path.startsWith("/v1/sessions/")) {
    const rest = path.slice("/v1/sessions/".length);
    const id = decodeURIComponent(rest.split("/")[0] ?? "");
    const s = store.getSession(id);
    if (!s) return send(res, 404, { error: "not_found" });
    if (!(s.scopeId === `personal:${principal}` || s.scopeId.startsWith("group:"))) {
      return send(res, 403, { error: "forbidden" });
    }
    const sub = rest.slice(id.length + 1);
    if (sub === "approvals") return send(res, 200, { approvals: [] });
    if (sub.startsWith("entries/")) {
      const seq = Number(sub.split("/")[1]);
      const entry = s.entries.find((e) => e.seq === seq);
      return entry ? send(res, 200, { entry: entryView(entry) }) : send(res, 404, { error: "not_found" });
    }
    // transcript
    const tailTurns = Number(url.searchParams.get("tailTurns") ?? 0);
    const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? 0);
    const beforeSeq = Number(url.searchParams.get("beforeSeq") ?? 0);
    let entries = s.entries;
    if (sinceSeq > 0) entries = entries.filter((e) => e.seq > sinceSeq);
    if (beforeSeq > 0) entries = entries.filter((e) => e.seq < beforeSeq);
    if (tailTurns > 0) entries = entries.slice(-tailTurns * 2);
    return send(res, 200, {
      session: sessionView(s),
      entries: entries.map(entryView),
      earlierEntries: Math.max(0, s.entries.length - entries.length),
    });
  }

  if (method === "POST" && path.startsWith("/v1/sessions/")) {
    const rest = path.slice("/v1/sessions/".length);
    const id = decodeURIComponent(rest.split("/")[0] ?? "");
    const s = store.getSession(id);
    if (!s) return send(res, 404, { error: "not_found" });
    if (!(s.scopeId === `personal:${principal}` || s.scopeId.startsWith("group:"))) {
      return send(res, 403, { error: "forbidden" });
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 200_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    const patch: Partial<StoredSession> = {};
    if (body.title === null || typeof body.title === "string") patch.title = body.title as string | null;
    if (typeof body.archived === "boolean") patch.archived = body.archived;
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    if (body.color === null || typeof body.color === "string") patch.color = body.color as string | null;
    if (Array.isArray(body.tags)) {
      const tags = body.tags
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 20);
      patch.tags = [...new Set(tags)];
    }
    store.patchSession(id, patch);
    const updated = store.getSession(id)!;
    return send(res, 200, { session: sessionView(updated) });
  }

  if (method === "POST" && path === "/v1/turns") {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 1_000_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request", message: "invalid JSON body" });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return send(res, 400, { error: "bad_request", message: "text required" });
    const scopeId = scopeOf(principal, typeof body.scopeId === "string" ? body.scopeId : null);
    const threadRef =
      typeof body.threadRef === "string" && body.threadRef.startsWith("web:") ? body.threadRef : `web:${principal}:${randomBytes(8).toString("hex")}`;
    const model = typeof body.model === "string" && ALLOWED_MODELS.includes(body.model) ? body.model : MODEL;

    let session = findSessionByThread(threadRef);
    if (!session) {
      session = {
        id: randomUUID(),
        type: "dm",
        scopeId,
        threadRef,
        title: text.slice(0, 48),
        surface: "web",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        messages: 0,
        turns: 0,
        entries: [],
      };
      store.upsertSession(session);
    }
    const at = Date.now();
    session.entries.push({ seq: session.entries.length + 1, parentSeq: null, type: "user", payload: { text }, createdAt: at });
    session.messages += 1;
    session.turns += 1;
    session.lastActivityAt = at;
    store.patchSession(session.id, {
      entries: session.entries,
      messages: session.messages,
      turns: session.turns,
      lastActivityAt: at,
      ...(session.title ? {} : { title: text.slice(0, 48) }),
    });

    const run: Run = { id: randomUUID(), sessionId: session.id, threadRef, status: "working", startedAt: at };
    runs.set(run.id, run);
    runsBySession.set(session.id, [...(runsBySession.get(session.id) ?? []), run.id]);
    pushSessionState(threadRef, session.id, "working", at);
    enqueueDelivery(threadRef);
    runAssistant(session, run, model).catch((e) => console.error(`[core] assistant run ${run.id} failed:`, e));
    return send(res, 200, { runId: run.id, sessionId: session.id, threadRef });
  }

  if (method === "GET" && path === "/v1/runs/active") {
    for (const r of runs.values()) if (r.status === "working") return send(res, 200, { runId: r.id });
    return send(res, 200, { runId: null });
  }

  if (method === "GET" && path.startsWith("/v1/runs/")) {
    const id = decodeURIComponent(path.slice("/v1/runs/".length));
    const run = runs.get(id);
    if (!run) return send(res, 404, { error: "not_found" });
    const session = store.getSession(run.sessionId);
    return send(res, 200, {
      run: {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
        ...(run.error ? { error: run.error } : {}),
        threadRef: run.threadRef,
      },
      session: session ? sessionView(session) : undefined,
    });
  }

  if (method === "GET" && path === "/v1/runtime-config") {
    return send(res, 200, {
      scopeId: url.searchParams.get("scopeId") ?? `personal:${principal}`,
      approvedHarnesses: ["pi"],
      modelsByHarness: { pi: ALLOWED_MODELS },
      modelCatalog: Object.fromEntries(ALLOWED_MODELS.map((m) => [m, { name: m, provider: "deepseek" }])),
      orgDefault: { harnessId: "pi", modelId: MODEL, revision: 1 },
      scopeOverride: null,
      effective: { harnessId: "pi", modelId: MODEL },
      upgradeAvailable: false,
    });
  }

  if (method === "GET" && path === "/v1/directory/meta") return send(res, 200, { workspaceUrl: null });
  if (method === "GET" && path === "/v1/directory/resolve") return send(res, 200, { matches: [] });

  if (method === "POST" && path === "/v1/projects") {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 100_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
    if (!name) return send(res, 400, { error: "bad_request", message: "name required" });
    const project = {
      id: randomUUID(),
      name,
      ownerId: principal,
      memberIds: [principal],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.putProject(project);
    return send(res, 200, { project });
  }

  if (method === "GET" && path === "/v1/scope-resources") return send(res, 200, { files: [], crons: [], apps: [] });
  if (method === "GET" && path === "/v1/memory") return send(res, 200, { memory: null, revision: 0 });
  if (method === "GET" && path === "/v1/memory/history") return send(res, 200, { revisions: [] });
  if (method === "PUT" && path === "/v1/memory") return send(res, 200, { ok: true });
  if (method === "GET" && path === "/v1/skills") return send(res, 200, { skills: [] });
  if (method === "GET" && path.startsWith("/v1/skills/")) return send(res, 404, { error: "not_found" });
  if (method === "POST" && path === "/v1/skills") return send(res, 200, { ok: true });
  if (method === "GET" && path === "/v1/files") return send(res, 200, { files: [] });
  if (method === "GET" && path === "/v1/crons") return send(res, 200, { crons: [] });
  if (method === "GET" && path === "/v1/deployments") return send(res, 200, { deployments: [] });
  if (method === "GET" && path === "/v1/keychain/overview") return send(res, 200, { entries: [] });
  if (method === "GET" && path === "/v1/keychain/credentials") return send(res, 200, { credentials: [] });
  if (method === "GET" && path.startsWith("/v1/keychain/")) return send(res, 200, { credentials: [] });
  if (method === "GET" && path === "/v1/approvals") return send(res, 200, { approvals: [] });
  if (method === "GET" && path.startsWith("/v1/approvals/")) return send(res, 404, { error: "not_found" });
  if (method === "GET" && path === "/v1/connectors/oauth/status") return send(res, 200, { connectors: [] });
  if (method === "POST" && path === "/v1/connectors/oauth/revoke") return send(res, 200, { ok: true });
  if (method === "GET" && path === "/v1/admin/whoami") return send(res, 200, { principal, permissions: [] });

  return send(res, 404, { error: "not_found", path });
}

async function runAssistant(session: StoredSession, run: Run, model: string): Promise<void> {
  const userEntries = session.entries.filter((e) => e.type === "user");
  const messages = userEntries.map((e) => {
    const text = (e.payload as { text?: string })?.text ?? "";
    return { role: "user" as const, content: text };
  });
  let text: string;
  try {
    text = await completeChat({
      model,
      system:
        "You are the OpenPilot assistant, a helpful AI teammate inside the OpenPilot Chat platform. " +
        "Respond concisely in the user's language.",
      messages,
    });
  } catch (e) {
    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = e instanceof Error ? e.message : "assistant failed";
    const errorEntry: Entry = {
      seq: session.entries.length + 1,
      parentSeq: null,
      type: "assistant",
      payload: { text: `⚠️ AI 回复失败：${run.error}` },
      createdAt: Date.now(),
    };
    session.entries.push(errorEntry);
    store.patchSession(session.id, { entries: session.entries, messages: session.messages + 1 });
    pushSessionState(session.threadRef, session.id, "idle", Date.now());
    enqueueDelivery(session.threadRef);
    return;
  }
  const at = Date.now();
  session.entries.push({
    seq: session.entries.length + 1,
    parentSeq: null,
    type: "assistant",
    payload: { text },
    createdAt: at,
  });
  store.patchSession(session.id, {
    entries: session.entries,
    messages: session.messages + 1,
    lastActivityAt: at,
  });
  run.status = "done";
  run.finishedAt = at;
  pushSessionState(session.threadRef, session.id, "idle", at);
  enqueueDelivery(session.threadRef);
}

// ───────────────────────── server ─────────────────────────

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    console.error(`[core] 500 ${req.method ?? "?"} ${req.url ?? "?"}:`, err);
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[core] listening on :${PORT} (org=${ORG}, store=json, model=${MODEL}, data=${DATA_DIR})`);
});

server.on("error", (err) => {
  console.error("[core] server error:", err);
  process.exit(1);
});
