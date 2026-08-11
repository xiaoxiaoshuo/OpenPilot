/**
 * 最小存储 — JSON 文件持久化（sessions + entries + projects）
 * 数据文件：core/data/db.json（原子写入）
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
}

interface Db {
  sessions: Record<string, StoredSession>;
  projects: Record<string, StoredProject>;
}

const EMPTY: Db = { sessions: {}, projects: {} };

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
    listProjects(): StoredProject[] {
      return Object.values(db.projects);
    },
    putProject(project: StoredProject): void {
      mutate(() => {
        db.projects[project.id] = project;
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
