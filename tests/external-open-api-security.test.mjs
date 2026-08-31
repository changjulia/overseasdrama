import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/lib/server/external-open-api.ts", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("external API refuses remote plaintext HTTP before sending the API key", () => {
  assert.doesNotMatch(source, /DEFAULT_BASE_URL\s*=\s*["']http:\/\//);
  assert.match(source, /parsedBaseUrl\.protocol !== "https:" && !trustedLoopback/);
  assert.match(source, /拒绝通过明文远程 HTTP 发送 API Key/);
});

test("documentation no longer recommends the retired plaintext endpoint", () => {
  assert.doesNotMatch(readme, /121\.41\.8\.142:3000/);
  assert.match(readme, /https:\/\/由服务方提供的安全地址/);
});
