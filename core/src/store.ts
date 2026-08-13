/**
 * 最小存储 — JSON 文件持久化（sessions + entries + projects + policies + runtime overrides）
 * 数据文件：core/data/db.json（原子写入）
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Entry {
  seq: number;
  parentSeq: number | null;
  type: "user" | "assistant" | "system" | "thinking";
  payload: unknown;
  createdAt: number;
}

export interface StoredSession {
  id: string;
  type: "dm" | "group";
  scopeId: string;
  threadRef: string;
  title: string | null;
  surface: string;
  createdAt: number;
  lastActivityAt: number;
  messages: number;
  turns: number;
  entries: Entry[];
  /** 会话标签（多个） */
  tags?: string[];
  archived?: boolean;
  pinned?: boolean;
  color?: string | null;
}

export interface StoredProject {
  id: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
  /** 群组机器人配置（群组=项目；改一处全组会话即时生效） */
  botConfig?: BotGroupConfig;
}

export interface BotGroupConfig {
  /** 主 agent 显示名，默认“群助手” */
  primaryName?: string;
  /** 附加机器人（预设 botId + 群组内启停） */
  attached: Array<{ botId: string; enabled: boolean }>;
}

export interface ScopePolicy {
  orders: string;
  bots: Record<string, unknown>;
  ambientEnabled: boolean | null;
  updatedAt: number;
}

export interface RuntimeOverride {
  harnessId: string;
  modelId: string;
  revision: number;
  updatedAt: number;
}

interface Db {
  sessions: Record<string, StoredSession>;
  projects: Record<string, StoredProject>;
  policies: Record<string, ScopePolicy>;
  runtimeOverrides: Record<string, RuntimeOverride>;
}

const EMPTY: Db = { sessions: {}, projects: {}, policies: {}, runtimeOverrides: {} };

export function createStore(dataDir: string) {
  const file = join(dataDir, "db.json");
  mkdirSync(dataDir, { recursive: true });
  let db: Db = EMPTY;
  let dirty = false;
  let saveTimer: NodeJS.Timeout | null = null;

  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<Db>;
    db = {
      sessions: parsed.sessions ?? {},
      projects: parsed.projects ?? {},
      policies: parsed.policies ?? {},
      runtimeOverrides: parsed.runtimeOverrides ?? {},
    };
  } catch {
    db = { ...EMPTY };
  }

  function save(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
        renameSync(tmp, file);
      } catch (e) {
        console.error("[core] store save failed:", e);
      }
    }, 250);
  }

  function mutate(fn: () => void): void {
    fn();
    dirty = true;
    save();
  }

  return {
    // ── sessions ──
    getSession(id: string): StoredSession | null {
      return db.sessions[id] ?? null;
    },
    listSessions(): StoredSession[] {
      return Object.values(db.sessions).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    },
    upsertSession(session: StoredSession): void {
      mutate(() => {
        db.sessions[session.id] = session;
      });
    },
    patchSession(id: string, patch: Partial<StoredSession>): void {
      mutate(() => {
        const s = db.sessions[id];
        if (s) Object.assign(s, patch);
      });
    },
    deleteSession(id: string): boolean {
      if (!db.sessions[id]) return false;
      mutate(() => {
        delete db.sessions[id];
      });
      return true;
    },

    // ── projects ──
    listProjects(): StoredProject[] {
      return Object.values(db.projects).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    getProject(id: string): StoredProject | null {
      return db.projects[id] ?? null;
    },
    putProject(project: StoredProject): void {
      mutate(() => {
        db.projects[project.id] = project;
      });
    },
    patchProject(id: string, patch: Partial<StoredProject>): void {
      mutate(() => {
        const p = db.projects[id];
        if (p) Object.assign(p, patch);
      });
    },
    addProjectMember(id: string, memberId: string): void {
      mutate(() => {
        const p = db.projects[id];
        if (p && !p.memberIds.includes(memberId)) p.memberIds.push(memberId);
      });
    },
    removeProjectMember(id: string, memberId: string): void {
      mutate(() => {
        const p = db.projects[id];
        if (p) p.memberIds = p.memberIds.filter((m) => m !== memberId);
      });
    },
    /** 更新群组机器人配置——不 bump updatedAt（避免 roster 版本拒绝语义） */
    setBotConfig(id: string, config: BotGroupConfig): void {
      mutate(() => {
        const p = db.projects[id];
        if (p) p.botConfig = config;
      });
    },

    // ── ambient policy（scope → policy）──
    getPolicy(scopeId: string): ScopePolicy | null {
      return db.policies[scopeId] ?? null;
    },
    putPolicy(scopeId: string, policy: ScopePolicy): void {
      mutate(() => {
        db.policies[scopeId] = policy;
      });
    },

    // ── runtime override（scope → selection）──
    getRuntimeOverride(scopeId: string): RuntimeOverride | null {
      return db.runtimeOverrides[scopeId] ?? null;
    },
    putRuntimeOverride(scopeId: string, override: RuntimeOverride): void {
      mutate(() => {
        db.runtimeOverrides[scopeId] = override;
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
