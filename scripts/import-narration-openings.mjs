/** Deterministic, resumable opening-only intake. Default: dry run of 12 samples. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function category(type) {
  if (type.includes("系统")) return "系统播报";
  if (type.includes("内心")) return "内心独白";
  if (/第一人称|自述|回忆/.test(type)) return "角色自述";
  return "第三人称";
}

export function buildOpening(decision, cached, frameHash = "") {
  if (basename(decision.key) !== decision.key || /[\\/]/.test(decision.key)) throw new Error("invalid source key");
  const url = new URL(cached.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("media URL must be HTTP(S)");
  let coverageEnd = 15.05;
  let segments = (cached.segments || []).filter((s) => Number(s.start) >= 0 && Number(s.end) <= coverageEnd);
  // A cached sentence may straddle 15s. Keep its actual end, never truncate it
  // or fabricate duration merely to pass the five-second evidence requirement.
  if (segments.length && Number(segments.at(-1).end) - Number(segments[0].start) < 5) {
    segments = (cached.segments || []).filter((s) => Number(s.start) >= 0 && Number(s.start) < 15.05 && Number(s.end) <= 30);
    coverageEnd = Math.max(coverageEnd, ...segments.map((s) => Number(s.end)));
  }
  const transcript = segments.map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || "").trim() }));
  if (!transcript.length || transcript.some((s, i) => !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start || !s.text || (i && s.start < transcript[i-1].start))) throw new Error("invalid cached transcript");
  const duration = transcript.at(-1).end - transcript[0].start;
  if (duration < 5 || duration > 60) throw new Error("opening evidence must span 5–60 seconds");
  const sourceHash = hash("narration-url:" + url.href);
  const cacheKey = hash(JSON.stringify({ schema: "narration-opening-v1", url: url.href, transcript, frameHash, openingType: decision.type }));
  return {
    key: decision.key, group: decision.group, title: String(cached.title || cached.drama || decision.key).slice(0,450),
    url: url.href, sourceHash, cacheKey, transcript, coverageEnd,
    duration: Number(cached.duration) || 0, language: cached.language || "未知语种",
    exposure: Number(cached.exposure) || 0, days: Number(cached.days) || 0,
    openingType: decision.type, reason: decision.reason, verified: decision.verified,
    frameHash, category: category(decision.type || ""),
  };
}

export function selectPilot(rows, limit = 12) {
  const groups = ["第三人称", "角色自述", "内心独白", "系统播报"].map((type) => rows.filter((row) => row.category === type));
  const selected = [];
  for (let i = 0; selected.length < Math.min(limit, rows.length); i++) {
    for (const group of groups) if (group[i] && selected.length < limit) selected.push(group[i]);
  }
  return selected;
}

export async function loadOpenings(directory) {
  const decisions = JSON.parse(await readFile(join(directory, "decisions.json"), "utf8"));
  const rows = [], errors = [], seen = new Set();
  for (const decision of decisions.accepted || []) {
    try {
      if (basename(decision.key) !== decision.key || /[\\/]/.test(decision.key)) throw new Error("invalid source key");
      const cached = JSON.parse(await readFile(join(directory, decision.key + ".json"), "utf8"));
      let frameHash = "";
      try { frameHash = hash(await readFile(join(directory, decision.key + ".jpg"))); } catch {}
      const row = buildOpening(decision, cached, frameHash);
      if (seen.has(row.sourceHash)) throw new Error("duplicate source URL");
      seen.add(row.sourceHash); rows.push(row);
    } catch (error) { errors.push({ key: decision.key, message: error.message }); }
  }
  return { rows, errors, accepted: decisions.accepted?.length || 0 };
}

async function main() {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name)+1] : fallback;
  const directory = resolve(option("--directory", "outputs/narration-mvp-20260904"));
  const loaded = await loadOpenings(directory);
  const limit = argv.includes("--all") ? loaded.rows.length : Number(option("--limit", "12"));
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const rows = selectPilot(loaded.rows, limit);
  const report = { schemaVersion: 1, mode: argv.includes("--apply") ? "apply" : "dry-run", accepted: loaded.accepted, eligible: loaded.rows.length, selected: rows.length, errors: loaded.errors, results: [], modelCalls: 0, analysisQueued: 0 };
  const output = resolve(option("--report", ".codex-runtime/narration-intake/report.json"));
  await mkdir(resolve(output, ".."), { recursive: true });
  const persist = () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (argv.includes("--apply")) {
    if (loaded.errors.length) throw new Error("preflight found invalid sources; fix them before applying");
    const root = option("--pb-url", "http://127.0.0.1:8090").replace(/\/$/, "");
    const parsed = new URL(root);
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error("this importer only writes to local PocketBase");
    const token = (process.env.LUMINA_WORKER_TOKEN || await readFile(resolve(".analysis-worker-token"), "utf8")).trim();
    for (const row of rows) {
      try {
        const response = await fetch(root + "/api/lumina/narration-intake", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(row), signal: AbortSignal.timeout(30000) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
        report.results.push({ key: row.key, category: row.category, ...result });
      } catch (error) { report.errors.push({ key: row.key, message: error.message }); await persist(); break; }
      await persist();
    }
  } else report.results = rows.map(({ key, category, cacheKey }) => ({ key, category, cacheKey }));
  await persist();
  console.log(JSON.stringify({ ...report, results: report.results.length, report: output }));
  if (report.errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
