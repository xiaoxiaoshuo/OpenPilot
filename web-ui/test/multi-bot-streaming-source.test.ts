import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const core = readFileSync(new URL("../../core/src/index.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
const conversations = readFileSync(new URL("../src/conversations.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("attached bots persist a streaming draft and publish throttled partial delivery events", () => {
  assert.match(core, /const BOT_PARTIAL_DELIVERY_MS = 120;/);
  assert.match(core, /const payload: \{[\s\S]*text: "",[\s\S]*streaming: true,/);
  assert.match(core, /onPartial: publishPartial/);
  assert.match(core, /pushDelivery\(session\.threadRef, true\)/);
  assert.match(core, /payload\.streaming = false/);
  assert.match(core, /pushDelivery\(session\.threadRef\);/);
  assert.match(core, /background: true,/);
  assert.match(core, /r\.status === "working" && !r\.background/);
});

test("the signed event bridge forwards delivery frames only to the matching web thread owner", () => {
  assert.match(server, /function forwardDelivery\(frame: \{ threadRef\?: unknown; partial\?: unknown \}\)/);
  assert.match(server, /const owner = ownerOfWebThread\(threadRef\)/);
  assert.match(server, /sseEvent\(res, "delivery", visible\)/);
  assert.match(server, /else if \(event === "delivery"\) forwardDelivery\(parsed\)/);
});

test("partial delivery refreshes only the active transcript and uses the existing streaming renderer", () => {
  assert.match(bridge, /export interface DeliveryEvent \{[\s\S]*partial: boolean;/);
  assert.match(conversations, /if \(!partial\) void refreshSessions\(\{ silent: true \}\);/);
  assert.match(conversations, /conv\.onDelivery\(threadRef\)/);
  assert.match(chat, /Boolean\(\(m as unknown as \{ streaming\?: boolean \}\)\.streaming\)/);
});
