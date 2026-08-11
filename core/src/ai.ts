/**
 * DeepSeek AI 调用 — OpenAI 兼容协议
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

export async function completeChat(args: {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<string> {
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
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`deepseek HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("deepseek returned empty content");
  return text;
}
