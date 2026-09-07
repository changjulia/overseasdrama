/** One compact semantic request per opening; never submits full-video analysis. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const version = "narration-semantic-v1";

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
  // Existing local provider configuration; credentials never enter logs or caches.
  try {
    for (const line of (await readFile(".env.analysis.local", "utf8")).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
  const endpoint = process.env.LUMINA_SEMANTIC_ENDPOINT;
  const model = process.env.LUMINA_SEMANTIC_MODEL;
  const key = process.env.LUMINA_SEMANTIC_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
  if (!endpoint?.endsWith("/chat/completions") || !model || !key) throw new Error("existing Chat Completions-compatible semantic provider configuration required");
  const token = (process.env.LUMINA_WORKER_TOKEN || await readFile(".analysis-worker-token", "utf8")).trim();
  const root = "http://127.0.0.1:8090";
  const reportPath = resolve(option("--report", ".codex-runtime/narration-intake/pilot-semantics.json"));
  const input = JSON.parse(await readFile(option("--input", ".codex-runtime/narration-intake/pilot-applied.json"), "utf8"));
  const cacheDir = resolve(".codex-runtime/narration-intake/semantic-cache");
  await mkdir(cacheDir, { recursive: true });
  const limit = Number(option("--limit", "12"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error("pilot limit must be 1–12");
  const report = { version, model, runId: new Date().toISOString().replace(/[:.]/g, "-"), calls: 0, reused: 0, inputTokens: 0, outputTokens: 0, evidenceInputTokens: 0, evidenceOutputTokens: 0, unmeteredCalls: 0, results: [] };
  const persist = async () => {
    const data = JSON.stringify(report, null, 2) + "\n";
    await writeFile(reportPath, data);
    await writeFile(join(cacheDir, "run-" + report.runId + ".json"), data);
  };
  for (const item of input.results.slice(0, limit)) {
    const response = await fetch(root + "/api/collections/hook_assets/records/" + encodeURIComponent(item.hookId));
    if (!response.ok) throw new Error("cannot load imported opening");
    const hook = await response.json(), evidence = hook.analysis;
    let frame;
    try { frame = await readFile(join("outputs/narration-mvp-20260904", item.key + ".jpg")); } catch {}
    const frameHash = frame ? digest(frame) : "";
    // Identical evidence can share semantics across URLs; different frames/timecodes cannot.
    const cacheKey = digest(JSON.stringify({ version, model, endpoint, transcript: evidence.transcript, openingType: evidence.openingType, frame: frameHash }));
    const legacyKey = digest(JSON.stringify({ version, model, endpoint, source: evidence.cacheKey, frame: frameHash }));
    const cacheFile = join(cacheDir, cacheKey + ".json");
    let cached;
    try { cached = JSON.parse(await readFile(cacheFile, "utf8")); } catch {}
    if (!cached) {
      try {
        cached = JSON.parse(await readFile(join(cacheDir, legacyKey + ".json"), "utf8"));
        await writeFile(cacheFile, JSON.stringify({ ...cached, cacheKey }, null, 2) + "\n");
      } catch {}
    }
    if (cached) report.reused++;
    else {
      const prompt = {
        task: version, openingType: evidence.openingType, transcript: evidence.transcript.map((s, index) => ({ index, ...s })),
        rules: ["仅分析提供的开头片段，不推断整片剧情、投放表现或来源归属", "所有字段用简体中文。没有证据时使用空字符串或空数组。", "这不是整片报告。禁止批准剪辑边界；15秒处可能仍在半句话或动作中。", "图片若提供，是前15秒约0、5、10秒抽帧拼图；只用于辅助核对，不推断未见画面。", "每项语义必须由引用的转写行支持；evidenceRows填写实际行号。不得因同题材就判定跨剧能拼接。", "identityConstraints明确原叙述视角、不可替换的人物身份/亲属/事实，以及跨剧承接需核对什么。", "若需要后续语音才知道完整事件或语句如何结束，needsMoreContext=true。输出仅一个JSON对象。"],
        output: { spokenSummary: "简短叙述", conflict: "核心冲突", emotion: "情绪", narrativePromise: "观众期待看到什么", informationGap: "未揭晓的问题", hookType: "具体机制", themes: ["主题"], relationships: ["关系"], contentTags: ["内容标签"], identityConstraints: "兼容限制", evidenceRows: [0], needsMoreContext: true },
      };
      const content = [{ type: "text", text: JSON.stringify(prompt) }];
      if (frame) content.push({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + frame.toString("base64"), detail: "low" } });
      const result = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify({ model, messages: [{ role: "user", content }], response_format: { type: "json_object" }, max_tokens: 1600, stream: false }), signal: AbortSignal.timeout(90000) });
      report.calls++;
      if (!result.ok) { await persist(); throw new Error(`semantic provider HTTP ${result.status}; no automatic retry`); }
      const payload = await result.json();
      const raw = payload.choices?.[0]?.message?.content;
      if (payload.choices?.[0]?.finish_reason === "length") { await persist(); throw new Error("semantic response truncated; not saved"); }
      cached = { version, cacheKey, sourceCacheKey: evidence.cacheKey, semantic: JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "")), usage: payload.usage || null };
      if (payload.usage) { report.inputTokens += payload.usage.prompt_tokens || 0; report.outputTokens += payload.usage.completion_tokens || 0; }
      else report.unmeteredCalls++;
      await writeFile(cacheFile, JSON.stringify(cached, null, 2) + "\n");
    }
    const saved = await fetch(root + "/api/lumina/narration-intake/semantics", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ hookId: hook.id, sourceCacheKey: evidence.cacheKey, semanticCacheKey: cacheKey, semantic: cached.semantic }), signal: AbortSignal.timeout(30000) });
    const result = await saved.json();
    if (!saved.ok) { await persist(); throw new Error(result.message || `save HTTP ${saved.status}`); }
    report.evidenceInputTokens += cached.usage?.prompt_tokens || 0;
    report.evidenceOutputTokens += cached.usage?.completion_tokens || 0;
    report.results.push({ key: item.key, hookId: hook.id, ...result, needsMoreContext: cached.semantic.needsMoreContext });
    await persist();
    console.log(`opening ${report.results.length}/${Math.min(limit,input.results.length)} saved; model calls=${report.calls}, cache hits=${report.reused}`);
  }
  console.log(JSON.stringify({ ...report, results: report.results.length, reportPath }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
