/**
 * DeepSeek AI 调用 — OpenAI 兼容协议（支持 function calling / tools）
 * 密钥来源（不打印）：env DEEPSEEK_API_KEY，或 ~/.pi/agent/auth.json 的 deepseek.key
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function deepseekApiKey(): string {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { deepseek?: { key?: string } };
    const key = parsed.deepseek?.key?.trim();
    if (key) return key;
  } catch {
    // 忽略
  }
  return "";
}

/** OpenAI 兼容工具定义（function calling） */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** OpenAI 兼容工具调用（响应里） */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** assistant 消息携带的工具调用 */
  tool_calls?: ToolCall[];
  /** tool 消息回填的调用 id */
  tool_call_id?: string;
  name?: string;
}

export interface CompleteChatArgs {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** 可选工具列表（OpenAI 兼容）；传入后响应可能带 tool_calls */
  tools?: ChatTool[];
}

export interface CompleteChatResult {
  text: string;
  toolCalls?: ToolCall[];
}

/** 兼容历史：旧调用方只拿 string */
export async function completeChat(args: CompleteChatArgs): Promise<string | CompleteChatResult> {
  const apiKey = deepseekApiKey();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      messages: [{ role: "system", content: args.system }, ...args.messages],
      ...(args.tools?.length ? { tools: args.tools, tool_choice: "auto" } : {}),
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`deepseek HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = (await r.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  };
  const message = body.choices?.[0]?.message;
  const text = message?.content?.trim() ?? "";
  const toolCalls = message?.tool_calls?.length ? message.tool_calls : undefined;
  if (!text && !toolCalls) throw new Error("deepseek returned empty content");
  return { text, ...(toolCalls ? { toolCalls } : {}) };
}

/**
 * 流式调用（DeepSeek stream:true）——逐 token 增量回调，支持工具调用分片解析。
 * onPartial 每次收到内容增量时回调（传累计全文，供 run.partial 快照）。
 */
export async function completeChatStream(args: {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: ChatTool[];
  onPartial?: (full: string) => void;
  signal?: AbortSignal;
}): Promise<CompleteChatResult> {
  const apiKey = deepseekApiKey();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      messages: [{ role: "system", content: args.system }, ...args.messages],
      ...(args.tools?.length ? { tools: args.tools, tool_choice: "auto" } : {}),
      stream: true,
    }),
    signal: args.signal,
  });
  if (!r.ok) throw new Error(`deepseek HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  if (!r.body) throw new Error("deepseek stream: no body");
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  let toolCalls: ToolCall[] | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: {
        choices?: Array<{
          delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
        }>;
      };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        acc += delta.content;
        args.onPartial?.(acc);
      }
      if (delta.tool_calls?.length) {
        if (!toolCalls) toolCalls = [];
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? toolCalls.length;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
          }
          if (tc.id) toolCalls[idx]!.id = tc.id;
          if (tc.function?.name) toolCalls[idx]!.function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx]!.function.arguments += tc.function.arguments;
        }
      }
    }
  }
  if (!acc && !toolCalls?.length) throw new Error("deepseek returned empty content");
  return { text: acc, ...(toolCalls?.length ? { toolCalls } : {}) };
}
