import assert from "node:assert/strict";
import test from "node:test";
import { authCopy, otherAuthLocale, resolveAuthLocale, resolveAuthTheme } from "../src/auth-copy.ts";

test("explicit login language takes precedence over Accept-Language", () => {
  assert.equal(resolveAuthLocale("en", "zh-CN,zh;q=0.9"), "en");
  assert.equal(resolveAuthLocale("zh-CN", "en-US,en;q=0.9"), "zh-CN");
});

test("login language falls back to Chinese for Chinese browser preferences", () => {
  assert.equal(resolveAuthLocale(null, "zh-CN,zh;q=0.9,en;q=0.8"), "zh-CN");
  assert.equal(resolveAuthLocale(undefined, "en-US,en;q=0.9"), "en");
});

test("theme preferences support light, dark, and system with a safe default", () => {
  assert.equal(resolveAuthTheme("light"), "light");
  assert.equal(resolveAuthTheme("dark"), "dark");
  assert.equal(resolveAuthTheme("system"), "system");
  assert.equal(resolveAuthTheme("unsupported"), "system");
  assert.equal(resolveAuthTheme(null), "system");
});

test("both language packs include localized sign-in and failure copy", () => {
  const en = authCopy("en");
  const zh = authCopy("zh-CN");
  assert.equal(en.htmlLang, "en");
  assert.equal(zh.htmlLang, "zh-CN");
  assert.match(en.signInTitle, /OpenPilot/);
  assert.match(zh.signInTitle, /OpenPilot/);
  assert.notEqual(en.genericSignInFailure, zh.genericSignInFailure);
  assert.equal(otherAuthLocale("en"), "zh-CN");
  assert.equal(otherAuthLocale("zh-CN"), "en");
});
