import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");

test("project session menu uses localized labels and accessibility copy", () => {
  assert.match(sessions, /t\("sessions\.viewProject"\)/);
  assert.match(sessions, /t\("sessions\.renameProject"\)/);
  assert.match(sessions, /t\("sessions\.projectOptions"\)/);
  assert.match(sessions, /t\("sessions\.optionsFor", \{ name \}\)/);
  assert.match(sessions, /t\("sessions\.newChatIn", \{ name \}\)/);
  assert.match(sessions, /t\("sessions\.projectAriaLabel", \{ name \}\)/);
  assert.doesNotMatch(sessions, /<span>View project<\/span>/);
  assert.doesNotMatch(sessions, /<span>Rename<\/span>/);
});

test("project menu keys are available in Chinese and English", () => {
  for (const key of ["viewProject", "renameProject", "projectOptions", "optionsFor", "newChatIn", "projectAriaLabel"]) {
    assert.match(i18n, new RegExp(`"sessions\\.${key}":`), `missing sessions.${key}`);
  }
  assert.match(i18n, /"sessions\.viewProject": "查看群组"/);
  assert.match(i18n, /"sessions\.viewProject": "View project"/);
});

test("renaming a current session immediately redraws the right-side title and split headers", () => {
  assert.match(sessions, /function redrawActiveSessionTitle\(id: string\)[\s\S]*conversation\.state\.sessionId === id\) conversation\.drawActiveChat\(\)/);
  assert.match(sessions, /if \(patch\.title !== undefined\) redrawActiveSessionTitle\(id\);/);
  assert.match(split, /function paneTitle\(panel: IDockviewPanel\): string \{[\s\S]*sessionTitle\(session\)/);
  assert.match(split, /export function notifySessionsChanged\(\): void \{[\s\S]*refreshHeaders\(\)/);
});

test("session deletion confirms irreversible removal and clears the active chat before choosing a successor", () => {
  assert.match(sessions, /window\.confirm\([\s\S]*t\("sessions\.deleteConversationTitle"\)[\s\S]*t\("sessions\.deleteConversationBody", \{ name: sessionTitle\(s\) \}\)/);
  assert.match(sessions, /await deleteSession\(s\.id\)/);
  assert.match(sessions, /sessionsState\.list = sessionsState\.list\.filter\(\(session\) => session\.id !== s\.id\)/);
  assert.match(sessions, /mainConversation\(\)\.resetChatState\(\)/);
  assert.match(sessions, /syncUrlFromState\(\)/);
  assert.match(sessions, /if \(successor\) await openSession\(successor\)/);
});

test("session UI no longer exposes archive or surface filters", () => {
  assert.doesNotMatch(sessions, /showArchived|toggleShowArchived|setArchived|chatsPageSurface|fieldSelect/);
  assert.doesNotMatch(sessions, /archived-toggle|session-archive-btn/);
  assert.doesNotMatch(contexts, /scopeId === scopeId && !s\.archived/);
});
