import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allMessages, localeTags, resolveLocale, setLocale, t } from "../src/i18n.js";

test("全言語で画面の翻訳キーと置換項目が揃う", () => {
  const messages = allMessages();
  const keys = Object.keys(messages.ja).sort();
  const parameters = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const locale of Object.keys(localeTags)) {
    assert.deepEqual(Object.keys(messages[locale]).sort(), keys, `${locale} translation keys`);
    for (const key of keys) assert.deepEqual(parameters(messages[locale][key]), parameters(messages.ja[key]), `${locale}.${key} parameters`);
  }
});

test("HTMLで使う翻訳キーが全て定義されている", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria|-content)?="([^"]+)"/g)].map((match) => match[1]);
  for (const key of keys) assert.ok(key in allMessages().ja, key);
});

test("言語選択はURL、保存設定の順で決め、初回は英語を表示する", () => {
  assert.equal(resolveLocale("?lang=pt", "en"), "pt");
  assert.equal(resolveLocale("", "fr"), "fr");
  assert.equal(resolveLocale(), "en");
  assert.equal(resolveLocale("?lang=xx"), "en");
  setLocale("pt");
  assert.equal(t("loadingYear", { year: 2026 }), "Carregando dados de 2026…");
  setLocale("en");
});
