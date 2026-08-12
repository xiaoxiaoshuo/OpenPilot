/**
 * OpenPilot Core — 业务 API（对齐 QM /v1/* 契约）
 * 覆盖：会话（sessions/contexts）、消息（turn）、run（events/active/signal）、
 *      项目（projects 全子路由）、scope 资源、ambient policy、runtime-config、成员目录。
 * 认证（dev 模式）：优先验证 x-portal-identity（gateway 注入）；否则信任 query principalId。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { json, readBody } from "../chassis/src/http.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../chassis/src/portal-identity.ts";
import { createStore, type Entry, type StoredProject, type StoredSession } from "./store.ts";
import { completeChat, type ChatTool, type CompleteChatResult, type ToolCall } from "./ai.ts";
import { BOT_PROFILES, botProfileById, enabledProfiles, type BotProfile } from "./bots/profiles.ts";

// ───────────────────────── 配置 ─────────────────────────

const PORT = Number(process.env.PORT ?? 8203);
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
  /** 已请求 abort（AI 调用结果将被丢弃） */
  abortRequested?: boolean;
  /** 流式回复快照（done 后为最终文本） */
  partial?: string;
}
const runs = new Map<string, Run>();
const runsBySession = new Map<string, string[]>(); // sessionId -> runIds

// run 信号（abort/steer），持久化语义参考 qm run_signals（内存版）
interface RunSignal {
  id: string;
  runId: string;
  kind: "abort" | "steer";
  text?: string;
  createdAt: number;
}
const runSignals = new Map<string, RunSignal[]>(); // runId -> signals

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
  const fromQuery = url.searchParams.get("principalId")?.trim() || url.searchParams.get("viewer")?.trim();
  if (fromQuery) return fromQuery;
  return null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  json(res, status, body);
}

function isProjectScope(scopeId: string): boolean {
  return scopeId.startsWith("group:web-project-");
}

function projectIdFromScope(scopeId: string): string | null {
  if (!isProjectScope(scopeId)) return null;
  return scopeId.slice("group:web-project-".length);
}

function projectForScope(scopeId: string): StoredProject | null {
  if (!isProjectScope(scopeId)) return null;
  return store.getProject(projectIdFromScope(scopeId)!);
}

function principalCanAccessScope(principal: string, scopeId: string): boolean {
  if (scopeId === `personal:${principal}`) return true;
  if (isProjectScope(scopeId)) {
    const p = projectIdFromScope(scopeId) ? store.getProject(projectIdFromScope(scopeId)!) : null;
    return p ? p.memberIds.includes(principal) : false;
  }
  return false;
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
    hasEntries: s.entries.length > 0,
    ...(s.tags?.length ? { tags: s.tags } : {}),
    ...(s.archived ? { archived: true } : {}),
    ...(s.pinned ? { pinned: true } : {}),
    ...(s.color ? { color: s.color } : {}),
    ...(working ? { working: true } : {}),
    awaitingInput: false,
    backgroundJobs: 0,
    watches: 0,
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

function projectView(p: StoredProject): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    orgId: ORG,
    ownerId: p.ownerId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    memberIds: [...p.memberIds],
    scopeId: `group:web-project-${p.id}`,
    members: p.memberIds.map((principalId) => ({
      principalId,
      displayName: displayNameOf(principalId),
    })),
  };
}

/** displayName：优先目录里登记的名字，否则退回 principalId（qm fallback 语义） */
const displayNames = new Map<string, string>();
function displayNameOf(principalId: string): string {
  return displayNames.get(principalId) ?? principalId;
}

function scopeOf(principal: string, scopeIdRaw: string | null): string {
  if (scopeIdRaw && (scopeIdRaw.startsWith("group:") || scopeIdRaw.startsWith("channel:"))) return scopeIdRaw;
  return `personal:${principal}`;
}

function findSessionByThread(threadRef: string): StoredSession | null {
  for (const s of store.listSessions()) if (s.threadRef === threadRef) return s;
  return null;
}

/** 线程上活跃（working）的 run */
function activeRunForThread(threadRef: string): Run | null {
  for (const r of runs.values()) if (r.threadRef === threadRef && r.status === "working") return r;
  return null;
}

function runView(run: Run): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    threadRef: run.threadRef,
    partial: run.partial ?? "",
    alive: run.status === "working",
    replying: run.status === "working",
    replyComplete: run.status !== "working",
    activity: [],
    tasks: [],
  };
  if (run.finishedAt) out.finishedAt = run.finishedAt;
  if (run.error) out.error = run.error;
  if (run.status === "done" && run.partial) out.firstBlock = { text: run.partial };
  return out;
}

function runResult(run: Run): Record<string, unknown> {
  return {
    runId: run.id,
    run: runView(run),
    sessionId: run.sessionId,
    threadRef: run.threadRef,
  };
}

// ───────────────────────── 群组机器人（主 agent 协调者模式）─────────────────────────

const DEFAULT_PRIMARY_NAME = "群助手";
const MAX_SUMMON_PER_TURN = 2;

/** summon_bot 工具定义（OpenAI 兼容，DeepSeek function calling） */
const summonBotTool: ChatTool = {
  type: "function",
  function: {
    name: "summon_bot",
    description:
      "召唤一个群组附加机器人补充回答。仅在用户问题对应某机器人专长、或需要多角度回答时调用（一次最多 2 个，每个 bot 一次）。主回答始终由你完成。",
    parameters: {
      type: "object",
      properties: {
        bot_id: {
          type: "string",
          description: "要召唤的附加机器人 botId",
        },
      },
      required: ["bot_id"],
    },
  },
};

/** 群组启用状态：项目有 botConfig 且 attached 中 enabled 的附加机器人 */
function enabledBotsForSession(session: StoredSession): BotProfile[] {
  const project = projectForScope(session.scopeId);
  if (!project?.botConfig) return [];
  return project.botConfig.attached
    .filter((a) => a.enabled)
    .map((a) => botProfileById(a.botId))
    .filter((b): b is BotProfile => Boolean(b));
}

/** 群组主 agent 显示名（默认群助手） */
function primaryNameFor(session: StoredSession): string {
  const project = projectForScope(session.scopeId);
  return project?.botConfig?.primaryName?.trim() || DEFAULT_PRIMARY_NAME;
}

/** 群组协作块：渲染 enabled 机器人的能力/性格（配置变了提示词跟着变） */
function groupCoordinationSystem(bots: BotProfile[]): string {
  const roster = bots
    .map((b) => `- ${b.avatar} ${b.name}（${b.botId}）：${b.capabilities}；性格：${b.personality.split("。")[0]}`)
    .join("\n");
  return [
    "",
    "## 群组机器人协作",
    "本群组配置了以下机器人助手，你可以调用 summon_bot 工具请它们补充回答：",
    roster,
    "",
    "规则：",
    "- 用户问题对应某机器人的专长、或需要多角度回答时，调用 summon_bot（可一次多个）",
    "- 主回答始终由你完成，不要用 summon 代替你自己的回答",
    "- 宁缺毋滥：用户只是表达感谢、确认、闲聊，或问题你已经能完整回答时，绝不 summon",
    "- 不要为了展示功能而召唤机器人",
  ].join("\n");
}

// ── 会话级写锁（主 agent 与附加机器人并发写同一会话时串行化）──
const sessionLocks = new Map<string, Promise<void>>();
async function withSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const next = prev.then(() => gate);
  sessionLocks.set(sessionId, next);
  await prev.catch(() => {});
  try {
    await fn();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  }
}

// ───────────────────────── 会话助手 ─────────────────────────

function sessionsForViewer(principal: string): StoredSession[] {
  return store
    .listSessions()
    .filter(
      (s) =>
        s.scopeId === `personal:${principal}` ||
        (isProjectScope(s.scopeId) && (store.getProject(projectIdFromScope(s.scopeId)!)?.memberIds.includes(principal) ?? false)),
    );
}

function listContexts(principal: string): Array<Record<string, unknown>> {
  const personal = {
    scopeId: `personal:${principal}`,
    kind: "personal",
    name: null,
    memberCount: 1,
    sessionCount: 0,
    lastActivityAt: null as number | null,
  };
  const groups: Array<Record<string, unknown>> = store
    .listProjects()
    .filter((p) => p.memberIds.includes(principal))
    .map((p) => ({
      scopeId: `group:web-project-${p.id}`,
      kind: "group",
      name: p.name,
      memberCount: p.memberIds.length,
      sessionCount: 0,
      lastActivityAt: null as number | null,
      project: projectView(p),
    }));

  // 灌计数：personal 第一，group 按 lastActivityAt 降序
  for (const s of sessionsForViewer(principal)) {
    if (s.scopeId === `personal:${principal}`) {
      personal.sessionCount += 1;
      personal.lastActivityAt = Math.max(personal.lastActivityAt ?? 0, s.lastActivityAt ?? s.createdAt);
    } else if (isProjectScope(s.scopeId)) {
      const g = groups.find((x) => x.scopeId === s.scopeId);
      if (g) {
        g.sessionCount = (g.sessionCount as number) + 1;
        g.lastActivityAt = Math.max((g.lastActivityAt as number | null) ?? 0, s.lastActivityAt ?? s.createdAt);
      }
    }
  }
  const rest = groups.sort((a, b) => ((b.lastActivityAt as number | null) ?? 0) - ((a.lastActivityAt as number | null) ?? 0));
  return [personal, ...rest];
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

  // ── 会话列表（对齐 /api/sessions：sessionsForViewer + 实时状态）──
  if (method === "GET" && path === "/v1/sessions") {
    const scope = url.searchParams.get("scope") ?? null;
    const all = sessionsForViewer(principal);
    const filtered = scope ? all.filter((s) => s.scopeId === scope) : all;
    return send(res, 200, { sessions: filtered.map(sessionView) });
  }

  // ── 上下文（对齐 /api/contexts：按 scope 分组 + 计数 + 排序）──
  if (method === "GET" && path === "/v1/contexts") {
    return send(res, 200, { contexts: listContexts(principal) });
  }

  // ── 会话详情 + 转写窗口（对齐 /api/sessions/:id）──
  if (method === "GET" && path.startsWith("/v1/sessions/")) {
    const rest = path.slice("/v1/sessions/".length);
    const id = decodeURIComponent(rest.split("/")[0] ?? "");
    const s = store.getSession(id);
    if (!s) return send(res, 404, { error: "not_found" });
    if (!principalCanAccessScope(principal, s.scopeId)) return send(res, 404, { error: "not_found" });
    const sub = rest.slice(id.length + 1);
    if (sub === "approvals") return send(res, 200, { approvals: [] });
    if (sub.startsWith("entries/")) {
      const seq = Number(sub.split("/")[1]);
      const entry = s.entries.find((e) => e.seq === seq);
      return entry ? send(res, 200, { entry: entryView(entry) }) : send(res, 404, { error: "not_found" });
    }
    // transcript 窗口
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

  // ── 会话 PATCH（title/archived/pinned/color/tags）──
  if (method === "PATCH" && path.startsWith("/v1/sessions/")) {
    const rest = path.slice("/v1/sessions/".length);
    const id = decodeURIComponent(rest.split("/")[0] ?? "");
    const s = store.getSession(id);
    if (!s) return send(res, 404, { error: "not_found" });
    if (!principalCanAccessScope(principal, s.scopeId)) return send(res, 404, { error: "not_found" });
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

  // ── 会话 POST 子路由：title / fork / approvals / background ──
  if (method === "POST" && path.startsWith("/v1/sessions/")) {
    const rest = path.slice("/v1/sessions/".length);
    const id = decodeURIComponent(rest.split("/")[0] ?? "");
    const s = store.getSession(id);
    if (!s) return send(res, 404, { error: "not_found" });
    if (!principalCanAccessScope(principal, s.scopeId)) return send(res, 404, { error: "not_found" });
    const sub = rest.slice(id.length + 1);
    if (sub === "title") {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(await readBody(req, 20_000)) as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: "bad_request" });
      }
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
      if (!title) return send(res, 400, { error: "bad_request", message: "title required" });
      store.patchSession(id, { title });
      return send(res, 200, { session: sessionView(store.getSession(id)!) });
    }
    if (sub === "fork") {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(await readBody(req, 20_000)) as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: "bad_request" });
      }
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : s.title ?? "";
      const fork: StoredSession = {
        ...s,
        id: randomUUID(),
        title,
        threadRef: `web:${principal}:fork-${randomUUID()}`,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        entries: s.entries.map((e) => ({ ...e })),
        tags: s.tags ? [...s.tags] : undefined,
      };
      store.upsertSession(fork);
      return send(res, 200, { session: sessionView(fork) });
    }
    if (sub === "background") return send(res, 200, { background: [] });
    // 无子路由：PATCH 语义（web-ui updateSession 用 POST 发 title/archived/pinned/color/tags 更新）
    if (sub === "") {
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
      return send(res, 200, { session: sessionView(store.getSession(id)!) });
    }
    return send(res, 404, { error: "not_found", path });
  }

  // ── 发消息（对齐 /api/turn → /v1/turns?async=1）──
  if (method === "POST" && path === "/v1/turns") {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 1_000_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request", message: "invalid JSON body" });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const hasAttachment = Array.isArray(body.attachments) && body.attachments.length > 0;
    const hasApproval = body.approval !== undefined && body.approval !== null;
    const hasProactive = body.proactiveOpener === true;
    if (!text && !hasAttachment && !hasApproval && !hasProactive)
      return send(res, 400, { error: "bad_request", message: "empty message" });

    const conv = (body.conversation ?? {}) as {
      kind?: unknown;
      threadRef?: unknown;
      channelRef?: unknown;
      scopeId?: unknown;
    };
    let scopeIdRaw: string | null = null;
    if (typeof body.scopeId === "string") scopeIdRaw = body.scopeId;
    else if (typeof conv.scopeId === "string") scopeIdRaw = conv.scopeId;
    else if (conv.kind === "channel" || conv.kind === "group") {
      const ref = String(conv.channelRef ?? "");
      if (ref) scopeIdRaw = `${conv.kind}:${ref}`;
    }
    const scopeId = scopeOf(principal, scopeIdRaw);
    if (scopeId !== `personal:${principal}` && !isProjectScope(scopeId) && !scopeId.startsWith("channel:"))
      return send(res, 403, { error: "forbidden_scope", message: "forbidden scope" });
    if (isProjectScope(scopeId)) {
      const p = store.getProject(projectIdFromScope(scopeId)!);
      if (!p?.memberIds.includes(principal))
        return send(res, 403, { status: "refused", reason: "you're not a member of that context" });
    }
    const threadRefRaw =
      typeof body.threadRef === "string"
        ? body.threadRef
        : typeof conv.threadRef === "string"
          ? conv.threadRef
          : "";
    const threadRef = threadRefRaw.startsWith("web:") ? threadRefRaw : `web:${principal}:${randomBytes(8).toString("hex")}`;
    const model = typeof body.model === "string" && ALLOWED_MODELS.includes(body.model) ? body.model : MODEL;

    let session = findSessionByThread(threadRef);
    if (session && session.scopeId !== scopeId) {
      return send(res, 403, {
        error: "forbidden_thread",
        message: "this conversation can only be continued from its own context",
      });
    }

    // 线程已有活跃 run：新消息转 steer 信号（qm app-turn 活跃 run 拦截分支）
    const active = activeRunForThread(threadRef);
    if (active && text && !hasApproval) {
      const at = Date.now();
      const sig: RunSignal = { id: randomUUID(), runId: active.id, kind: "steer", text, createdAt: at };
      runSignals.set(active.id, [...(runSignals.get(active.id) ?? []), sig]);
      if (session) {
        session.entries.push({
          seq: session.entries.length + 1,
          parentSeq: null,
          type: "user",
          payload: { text, ts: at, steered: true },
          createdAt: at,
        });
        session.messages += 1;
        session.turns += 1;
        session.lastActivityAt = at;
        store.patchSession(session.id, {
          entries: session.entries,
          messages: session.messages,
          turns: session.turns,
          lastActivityAt: at,
        });
      }
      return send(res, 202, { status: "steered", runId: active.id, sessionId: session?.id, threadRef });
    }

    if (!session) {
      session = {
        id: randomUUID(),
        type: "dm",
        scopeId,
        threadRef,
        title: text.slice(0, 48) || null,
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
    if (text) {
      session.entries.push({ seq: session.entries.length + 1, parentSeq: null, type: "user", payload: { text }, createdAt: at });
      session.messages += 1;
      session.turns += 1;
    }
    session.lastActivityAt = at;
    store.patchSession(session.id, {
      entries: session.entries,
      messages: session.messages,
      turns: session.turns,
      lastActivityAt: at,
      ...(session.title ? {} : { title: text.slice(0, 48) || null }),
    });

    const run: Run = { id: randomUUID(), sessionId: session.id, threadRef, status: "working", startedAt: at };
    runs.set(run.id, run);
    runsBySession.set(session.id, [...(runsBySession.get(session.id) ?? []), run.id]);
    pushSessionState(threadRef, session.id, "working", at);
    enqueueDelivery(threadRef);
    void runAssistant(session, run, model).catch((e) => console.error(`[core] assistant run ${run.id} failed:`, e));
    const wantAsync = url.searchParams.get("async") === "1" || body.async === true;
    if (wantAsync) return send(res, 202, { status: "queued", runId: run.id, sessionId: session.id, threadRef });
    return send(res, 200, { runId: run.id, sessionId: session.id, threadRef });
  }

  // ── 活跃 run 查找：/v1/runs?threadRef= （qm activeRunForThread）──
  if (method === "GET" && path === "/v1/runs") {
    const threadRef = url.searchParams.get("threadRef") ?? "";
    if (!threadRef) return send(res, 400, { error: "bad_request", message: "threadRef required" });
    if (!threadRef.startsWith("web:")) return send(res, 404, { error: "not_found" });
    const active = activeRunForThread(threadRef);
    return send(res, 200, { runId: active?.id ?? null });
  }

  // ── run 详情（对齐 /api/runs/:id/events 轮询源 + 动态字段；qm 契约：直接返回 run 对象）──
  if (method === "GET" && path.startsWith("/v1/runs/")) {
    const id = decodeURIComponent(path.slice("/v1/runs/".length));
    const run = runs.get(id);
    if (!run) return send(res, 404, { error: "not_found" });
    return send(res, 200, runView(run));
  }

  // ── run 信号（对齐 /api/runs/:id/signal → abort/steer）──
  if (method === "POST" && path.startsWith("/v1/runs/") && path.endsWith("/signal")) {
    const id = decodeURIComponent(path.slice("/v1/runs/".length, -"/signal".length));
    const run = runs.get(id);
    if (!run) return send(res, 404, { error: "not_found" });
    const session = store.getSession(run.sessionId);
    if (!session || !principalCanAccessScope(principal, session.scopeId)) return send(res, 404, { error: "not_found" });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 100_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    const kind = body.kind;
    if (kind !== "abort" && kind !== "steer")
      return send(res, 400, { error: "bad_request", message: "kind must be abort or steer" });
    if (run.status !== "working") return send(res, 409, { error: "terminal", message: "run is no longer active" });
    if (kind === "steer") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return send(res, 400, { error: "bad_request", message: "text required" });
    }
    const sig: RunSignal = {
      id: randomUUID(),
      runId: id,
      kind,
      text: kind === "steer" ? String(body.text ?? "") : undefined,
      createdAt: Date.now(),
    };
    runSignals.set(id, [...(runSignals.get(id) ?? []), sig]);
    if (kind === "abort") run.abortRequested = true;
    else {
      // steer：追加 user entry（ts 去重语义，qm 落库 + steered 标记）
      const at = Date.now();
      const text = String(body.text ?? "");
      session.entries.push({
        seq: session.entries.length + 1,
        parentSeq: null,
        type: "user",
        payload: { text, ts: at, steered: true },
        createdAt: at,
      });
      session.messages += 1;
      session.turns += 1;
      session.lastActivityAt = at;
      store.patchSession(session.id, {
        entries: session.entries,
        messages: session.messages,
        turns: session.turns,
        lastActivityAt: at,
      });
    }
    return send(res, 200, { accepted: true });
  }

  // ── 项目：列表（qm listProjects：成员可见）──
  if (method === "GET" && path === "/v1/projects") {
    const projects = store.listProjects().filter((p) => p.memberIds.includes(principal));
    return send(res, 200, { projects: projects.map(projectView) });
  }

  // ── 项目：创建（201，qm createProject）──
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
    return send(res, 201, { project: projectView(project) });
  }

  // ── 机器人预设列表（对齐 /api/bot-profiles）──
  if (method === "GET" && path === "/v1/bot-profiles") {
    return send(res, 200, {
      profiles: enabledProfiles().map((p) => ({
        botId: p.botId,
        name: p.name,
        avatar: p.avatar,
        personality: p.personality,
        capabilities: p.capabilities,
      })),
    });
  }

  // ── 群组机器人配置：GET（成员读）/ PATCH（owner 改）──
  const botsMatch = path.match(/^\/v1\/projects\/([^/]+)\/bots$/);
  if (method === "GET" && botsMatch) {
    const id = decodeURIComponent(botsMatch[1]!);
    const p = store.getProject(id);
    if (!p) return send(res, 404, { error: "not_found" });
    if (!p.memberIds.includes(principal)) return send(res, 404, { error: "not_found" });
    const config = p.botConfig ?? { primaryName: DEFAULT_PRIMARY_NAME, attached: [] };
    return send(res, 200, { config, profiles: enabledProfiles() });
  }

  if (method === "PATCH" && botsMatch) {
    const id = decodeURIComponent(botsMatch[1]!);
    const p = store.getProject(id);
    if (!p) return send(res, 404, { error: "not_found" });
    if (p.ownerId !== principal) return send(res, 403, { error: "forbidden", message: "only the owner can change bots" });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 100_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    const prev = p.botConfig ?? { primaryName: DEFAULT_PRIMARY_NAME, attached: [] as Array<{ botId: string; enabled: boolean }> };
    const config = { ...prev, attached: [...prev.attached] };
    if (body.primaryName !== undefined) {
      const name = typeof body.primaryName === "string" ? body.primaryName.trim().slice(0, 30) : "";
      if (!name) return send(res, 400, { error: "bad_request", message: "primaryName required" });
      config.primaryName = name;
    }
    if (Array.isArray(body.attached)) {
      const seen = new Set<string>();
      const attached: Array<{ botId: string; enabled: boolean }> = [];
      for (const raw of body.attached as unknown[]) {
        if (!raw || typeof raw !== "object") continue;
        const a = raw as { botId?: unknown; enabled?: unknown };
        const botId = typeof a.botId === "string" ? a.botId.trim() : "";
        if (!botId || seen.has(botId)) continue;
        if (!botProfileById(botId)) continue;
        seen.add(botId);
        attached.push({ botId, enabled: a.enabled !== false });
        if (attached.length >= 10) break;
      }
      config.attached = attached;
    }
    store.setBotConfig(id, config);
    return send(res, 200, { config, profiles: enabledProfiles() });
  }

  // ── 项目：重命名 / 加成员 / 移除成员 ──
  const projectIdMatch = path.match(/^\/v1\/projects\/([^/]+)$/);
  if (method === "PATCH" && projectIdMatch) {
    const id = decodeURIComponent(projectIdMatch[1]!);
    const p = store.getProject(id);
    if (!p) return send(res, 404, { error: "not_found" });
    if (!p.memberIds.includes(principal)) return send(res, 404, { error: "not_found" });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 100_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
    if (!name) return send(res, 400, { error: "invalid_name", message: "project name required" });
    store.patchProject(id, { name, updatedAt: Date.now() });
    return send(res, 200, { project: projectView(store.getProject(id)!) });
  }

  const addMemberMatch = path.match(/^\/v1\/projects\/([^/]+)\/members$/);
  if (method === "POST" && addMemberMatch) {
    const id = decodeURIComponent(addMemberMatch[1]!);
    const p = store.getProject(id);
    if (!p) return send(res, 404, { error: "not_found" });
    if (!p.memberIds.includes(principal)) return send(res, 404, { error: "not_found" });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 100_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
    if (!memberId) return send(res, 400, { error: "bad_request", message: "memberId required" });
    if (memberId === p.ownerId || p.memberIds.includes(memberId))
      return send(res, 400, { error: "invalid_member", message: "member cannot be the project owner" });
    store.addProjectMember(id, memberId);
    return send(res, 200, { project: projectView(store.getProject(id)!) });
  }

  const removeMemberMatch = path.match(/^\/v1\/projects\/([^/]+)\/members\/([^/]+)$/);
  if (method === "DELETE" && removeMemberMatch) {
    const id = decodeURIComponent(removeMemberMatch[1]!);
    const memberId = decodeURIComponent(removeMemberMatch[2]!);
    const p = store.getProject(id);
    if (!p) return send(res, 404, { error: "not_found" });
    if (!p.memberIds.includes(principal)) return send(res, 404, { error: "not_found" });
    store.removeProjectMember(id, memberId);
    return send(res, 200, { project: projectView(store.getProject(id)!) });
  }

  // ── scope 资源聚合（对齐 /api/scope-resources）──
  if (method === "GET" && path === "/v1/scope-resources") {
    const scope = url.searchParams.get("scope") ?? "";
    if (!scope) return send(res, 400, { error: "bad_request", message: "scope required" });
    if (!principalCanAccessScope(principal, scope))
      return send(res, 404, { error: "not_found", message: "not a context you can see" });
    const files = store
      .listSessions()
      .filter((s) => s.scopeId === scope)
      .flatMap((s) =>
        s.entries
          .filter((e) => e.type === "user" && Array.isArray((e.payload as { attachments?: unknown[] })?.attachments))
          .flatMap((e) => (e.payload as { attachments: Array<{ name?: string; mimetype?: string; sizeBytes?: number }> }).attachments),
      )
      .map((f, i) => ({
        id: `attachment-${i}-${Date.now()}`,
        ownerScopeId: scope,
        name: f.name ?? "attachment",
        mimetype: f.mimetype ?? "application/octet-stream",
        sizeBytes: f.sizeBytes ?? 0,
        direction: "upload",
        createdAt: Date.now(),
        openable: false,
      }));
    return send(res, 200, {
      files,
      crons: [],
      deployments: [],
      skills: [],
      manageable: principalCanAccessScope(principal, scope),
    });
  }

  // ── ambient policy（对齐 /api/contexts/:scope/ambient-policy）──
  if (method === "GET" && path === "/v1/contexts/policy") {
    const scope = url.searchParams.get("scope") ?? "";
    if (!scope) return send(res, 400, { error: "bad_request", message: "scope required" });
    if (!isProjectScope(scope) && !scope.startsWith("channel:"))
      return send(res, 400, { error: "bad_request", message: "ambient policy applies to channel and group scopes only" });
    if (!principalCanAccessScope(principal, scope)) return send(res, 403, { error: "forbidden" });
    const policy = store.getPolicy(scope) ?? { orders: "", bots: {}, ambientEnabled: null, updatedAt: 0 };
    return send(res, 200, { policy });
  }

  if (method === "PUT" && path === "/v1/contexts/policy") {
    const scope = url.searchParams.get("scope") ?? "";
    if (!scope) return send(res, 400, { error: "bad_request", message: "scope required" });
    if (!isProjectScope(scope) && !scope.startsWith("channel:"))
      return send(res, 400, { error: "bad_request", message: "ambient policy applies to channel and group scopes only" });
    if (!principalCanAccessScope(principal, scope)) return send(res, 403, { error: "forbidden" });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 200_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    const orders = typeof body.orders === "string" ? body.orders : "";
    if (orders.length > 20_000) return send(res, 400, { error: "bad_request", message: "orders too long" });
    if (body.bots !== undefined && (typeof body.bots !== "object" || body.bots === null || Array.isArray(body.bots)))
      return send(res, 400, { error: "bad_request", message: "bots must be an object" });
    if (body.ambientEnabled !== undefined && body.ambientEnabled !== null && typeof body.ambientEnabled !== "boolean")
      return send(res, 400, { error: "bad_request", message: "ambientEnabled must be boolean or null" });
    const current = store.getPolicy(scope);
    const baseUpdatedAt = typeof body.baseUpdatedAt === "number" ? body.baseUpdatedAt : null;
    if (baseUpdatedAt !== null && current && current.updatedAt !== baseUpdatedAt)
      return send(res, 409, { error: "conflict", message: "policy was updated elsewhere, reload and retry" });
    const policy = {
      orders,
      bots: (body.bots as Record<string, unknown>) ?? {},
      ambientEnabled: body.ambientEnabled === undefined ? (current?.ambientEnabled ?? null) : (body.ambientEnabled as boolean | null),
      updatedAt: Date.now(),
    };
    store.putPolicy(scope, policy);
    return send(res, 200, { policy });
  }

  // ── 运行时配置（对齐 /api/runtime-config GET/PUT）──
  if (method === "GET" && path === "/v1/runtime-config") {
    const scopeId = url.searchParams.get("scopeId") ?? `personal:${principal}`;
    const storedOverride = store.getRuntimeOverride(scopeId);
    const override = storedOverride && storedOverride.revision >= 1 ? storedOverride : null;
    const orgDefault = { harnessId: "pi", modelId: MODEL, revision: 1 };
    const effective = override ? { harnessId: override.harnessId, modelId: override.modelId } : { harnessId: orgDefault.harnessId, modelId: orgDefault.modelId };
    return send(res, 200, {
      scopeId,
      approvedHarnesses: ["pi"],
      modelsByHarness: { pi: ALLOWED_MODELS },
      modelCatalog: Object.fromEntries(ALLOWED_MODELS.map((m) => [m, { name: m, provider: "deepseek" }])),
      orgDefault,
      scopeOverride: override ? { harnessId: override.harnessId, modelId: override.modelId, revision: override.revision } : null,
      effective,
      upgradeAvailable: false,
      fastModeModelIds: [],
      interactiveFastMode: false,
    });
  }

  if (method === "PUT" && path === "/v1/runtime-config") {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req, 100_000)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    const scopeId = typeof body.scopeId === "string" && body.scopeId ? body.scopeId : `personal:${principal}`;
    if (body.inherit === true) {
      // inherit = 恢复继承：写入 revision=-1 标记，读取时视为无 override
      store.putRuntimeOverride(scopeId, {
        harnessId: "pi",
        modelId: MODEL,
        revision: -1,
        updatedAt: Date.now(),
      });
    } else if (typeof body.harnessId === "string" && typeof body.modelId === "string") {
      if (!ALLOWED_MODELS.includes(body.modelId))
        return send(res, 403, { error: "forbidden", message: "that model isn't available in this deployment" });
      const current = store.getRuntimeOverride(scopeId);
      store.putRuntimeOverride(scopeId, {
        harnessId: body.harnessId,
        modelId: body.modelId,
        revision: (current?.revision ?? 1) + 1,
        updatedAt: Date.now(),
      });
    } else if (body.keep !== true) {
      return send(res, 400, { error: "bad_request" });
    }
    return send(res, 200, { ok: true });
  }

  // ── 成员目录（对齐 /api/directory/resolve）──
  if (method === "GET" && path === "/v1/directory/meta") return send(res, 200, { workspaceUrl: null });
  if (method === "GET" && path === "/v1/directory/resolve") {
    const raw = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
    if (!raw) return send(res, 200, { matches: [] });
    const q = raw.toLowerCase().replace(/^[@#]/, "");
    // 数据源：所有会话参与者 + 项目成员（qm 的 directory 表在 OpenPilot 无 Slack 同步，用本地身份聚合）
    const known = new Map<string, string>(); // principalId -> displayName
    for (const s of store.listSessions()) {
      const m = s.scopeId.match(/^personal:(.+)$/);
      if (m) known.set(m[1]!, displayNameOf(m[1]!));
    }
    for (const p of store.listProjects()) for (const m of p.memberIds) known.set(m, displayNameOf(m));
    const candidates = [...known.entries()];
    const norm = (x: string) => x.toLowerCase().replace(/^[@#]/, "");
    const matches: Array<{ principalId: string; displayName: string; type: string }> = [];
    // 1. principal_id 精确
    for (const [pid, dn] of candidates) {
      if (norm(pid) === q) matches.push({ principalId: pid, displayName: dn, type: "internal" });
    }
    // 2. display_name 精确
    for (const [pid, dn] of candidates) {
      if (norm(dn) === q && !matches.some((m) => m.principalId === pid))
        matches.push({ principalId: pid, displayName: dn, type: "internal" });
    }
    // 3. 前缀
    for (const [pid, dn] of candidates) {
      if (norm(dn).startsWith(q) && !matches.some((m) => m.principalId === pid))
        matches.push({ principalId: pid, displayName: dn, type: "internal" });
    }
    // 4. 包含
    for (const [pid, dn] of candidates) {
      if (norm(dn).includes(q) && !matches.some((m) => m.principalId === pid))
        matches.push({ principalId: pid, displayName: dn, type: "internal" });
    }
    return send(res, 200, { matches: matches.slice(0, 20) });
  }

  // ── 其余兼容端点（web-ui 依赖，保持现状）──
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

// ───────────────────────── AI 回复 ─────────────────────────

/** 主 agent 协调者：群组时注入协作块 + summon 工具，回复带身份，turn 结束后 fan-out */
async function runAssistant(session: StoredSession, run: Run, model: string): Promise<void> {
  // abort 预检（信号可能已在 enqueue 后到达）
  const signals = runSignals.get(run.id) ?? [];
  const aborted = () => run.abortRequested || signals.some((s) => s.kind === "abort");
  if (aborted()) {
    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = "aborted";
    pushSessionState(session.threadRef, session.id, "idle", Date.now());
    enqueueDelivery(session.threadRef);
    return;
  }

  const isGroup = isProjectScope(session.scopeId);
  const groupBots = isGroup ? enabledBotsForSession(session) : [];
  const userEntries = session.entries.filter((e) => e.type === "user");
  const messages = userEntries.map((e) => {
    const text = (e.payload as { text?: string })?.text ?? "";
    return { role: "user" as const, content: text };
  });
  const baseSystem =
    "You are the OpenPilot assistant, a helpful AI teammate inside the OpenPilot Chat platform. " +
    "Respond concisely in the user's language.";
  const system = groupBots.length ? baseSystem + groupCoordinationSystem(groupBots) : baseSystem;
  const tools = groupBots.length ? [summonBotTool] : undefined;

  let text: string;
  let toolCalls: ToolCall[] | undefined;
  try {
    const result = await completeChat({ model, system, messages, tools });
    text = typeof result === "string" ? result : result.text;
    toolCalls = typeof result === "string" ? undefined : result.toolCalls;
  } catch (e) {
    // abort 期间的结果丢弃（qm userAborted 语义）
    if (aborted()) {
      run.status = "failed";
      run.finishedAt = Date.now();
      run.error = "aborted";
      pushSessionState(session.threadRef, session.id, "idle", Date.now());
      enqueueDelivery(session.threadRef);
      return;
    }
    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = e instanceof Error ? e.message : "assistant failed";
    await withSessionLock(session.id, async () => {
      const errorEntry: Entry = {
        seq: session.entries.length + 1,
        parentSeq: null,
        type: "assistant",
        payload: { text: `⚠️ AI 回复失败：${run.error}` },
        createdAt: Date.now(),
      };
      session.entries.push(errorEntry);
      store.patchSession(session.id, { entries: session.entries, messages: session.messages + 1 });
    });
    pushSessionState(session.threadRef, session.id, "idle", Date.now());
    enqueueDelivery(session.threadRef);
    return;
  }
  // 回复完成后仍被 abort：丢弃结果（qm：abort 落在生成完成后不落库）
  if (aborted()) {
    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = "aborted";
    pushSessionState(session.threadRef, session.id, "idle", Date.now());
    enqueueDelivery(session.threadRef);
    return;
  }
  const at = Date.now();
  await withSessionLock(session.id, async () => {
    const payload: Record<string, unknown> = { text };
    if (isGroup) payload.author = primaryNameFor(session);
    session.entries.push({
      seq: session.entries.length + 1,
      parentSeq: null,
      type: "assistant",
      payload,
      createdAt: at,
    });
    session.messages += 1;
    session.lastActivityAt = at;
    store.patchSession(session.id, {
      entries: session.entries,
      messages: session.messages,
      lastActivityAt: at,
    });
  });
  run.status = "done";
  run.finishedAt = at;
  run.partial = text;
  pushSessionState(session.threadRef, session.id, "idle", at);
  enqueueDelivery(session.threadRef);

  // turn 结束后统一解析 summon（fan-out 附加机器人；失败静默不阻塞）
  if (groupBots.length) resolveSummons(session, toolCalls, model);
}

/** 解析主 agent 的 summon_bot 调用：去重 / 校验启用 / 上限 2，逐个入队 bot run */
function resolveSummons(session: StoredSession, toolCalls: ToolCall[] | undefined, model: string): void {
  if (!toolCalls?.length) return;
  const enabled = enabledBotsForSession(session);
  const seen = new Set<string>();
  const picked: BotProfile[] = [];
  for (const tc of toolCalls) {
    if (tc.function.name !== "summon_bot") continue;
    let args: { bot_id?: string } = {};
    try {
      args = JSON.parse(tc.function.arguments ?? "{}") as { bot_id?: string };
    } catch {
      continue;
    }
    const botId = args.bot_id?.trim();
    if (!botId || seen.has(botId)) continue;
    const profile = enabled.find((b) => b.botId === botId);
    if (!profile) continue;
    seen.add(botId);
    picked.push(profile);
    if (picked.length >= MAX_SUMMON_PER_TURN) break;
  }
  for (const profile of picked) {
    void runBot(session, profile, model).catch((e) => console.error(`[core] bot run ${profile.botId} failed:`, e));
  }
}

/** 附加机器人 run：automation 语义（不触发新 turn → 防循环主线）；回复带 author=机器人名 */
async function runBot(session: StoredSession, profile: BotProfile, model: string): Promise<void> {
  const at0 = Date.now();
  const run: Run = {
    id: randomUUID(),
    sessionId: session.id,
    threadRef: session.threadRef,
    status: "working",
    startedAt: at0,
  };
  runs.set(run.id, run);
  runsBySession.set(session.id, [...(runsBySession.get(session.id) ?? []), run.id]);
  pushSessionState(session.threadRef, session.id, "working", at0);

  // 上下文：同一会话最近条目（与主 agent 看到的一致），只取 user/assistant 文本
  const history = session.entries
    .slice(-16)
    .filter((e) => e.type === "user" || e.type === "assistant")
    .map((e) => {
      const payload = e.payload as { text?: string };
      return {
        role: (e.type === "user" ? "user" : "assistant") as "user" | "assistant",
        content: payload.text ?? "",
      };
    });
  let text: string;
  try {
    const result = await completeChat({
      model,
      system:
        profile.personality +
        "\n\n你是被群助手召唤来回答的用户问题。基于本会话上下文回答，风格遵循你的角色设定。不要回复或评价其他机器人的发言。",
      messages: history,
    });
    text = typeof result === "string" ? result : result.text;
  } catch (e) {
    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = e instanceof Error ? e.message : "bot failed";
    pushSessionState(session.threadRef, session.id, "idle", Date.now());
    enqueueDelivery(session.threadRef);
    return;
  }
  const at = Date.now();
  await withSessionLock(session.id, async () => {
    session.entries.push({
      seq: session.entries.length + 1,
      parentSeq: null,
      type: "assistant",
      payload: { text, author: profile.name, bot: profile.botId },
      createdAt: at,
    });
    session.messages += 1;
    session.turns += 1;
    session.lastActivityAt = at;
    store.patchSession(session.id, {
      entries: session.entries,
      messages: session.messages,
      turns: session.turns,
      lastActivityAt: at,
    });
  });
  run.status = "done";
  run.finishedAt = at;
  run.partial = text;
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
