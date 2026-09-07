/** Read-only checks of the real local retrieval chain; no matching jobs enqueued. */
import { readFile, writeFile } from "node:fs/promises";
const root = "http://127.0.0.1:8090";
async function json(path, body) {
  const response = await fetch(root + path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Lumina-UI": "local", Origin: "http://localhost:3000" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) } : { signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data.message || ""}`);
  return data;
}
async function main() {
  const input = JSON.parse(await readFile(".codex-runtime/narration-intake/pilot-applied.json", "utf8"));
  try {
    const batch = JSON.parse(await readFile(".codex-runtime/narration-intake/boundary-report.json", "utf8"));
    for(const item of batch.results.filter((x)=>x.status==="candidate" && x.end>60).slice(0,3)) {
      if(!input.results.some((x)=>x.hookId===item.hookId)) input.results.push(item);
    }
  } catch {}
  const dramas = await json("/api/collections/dramas/records?perPage=100&fields=id,title,free_episodes");
  const drama = dramas.items.find((d) => d.free_episodes > 0);
  if (!drama) throw new Error("no drama with free episodes available for pilot retrieval");
  const report = process.argv.includes('--reverse-only') ? JSON.parse(await readFile('.codex-runtime/narration-intake/pilot-verification.json','utf8')) : { drama: { id: drama.id, title: drama.title }, modelCalls: 0, productionValidated: false, results: [] };
  const filter = '(source_class="external_material" || (source_class="narration_opening" && usage_role="pre_roll"))';
  const pool = {items:[]};
  for(let page=1,totalPages=1;page<=totalPages;page++) {
    const part=await json("/api/collections/hook_assets/records?perPage=500&page="+page+"&fields=id,source_class,usage_role&filter="+encodeURIComponent(filter));
    pool.items.push(...part.items);totalPages=part.totalPages;
  }
  for (const item of process.argv.includes('--reverse-only') ? [] : input.results) {
    if (!pool.items.some((h) => h.id === item.hookId)) throw new Error("imported hook missing from factory pool");
    const data = await json("/api/lumina/hook-driven-storyline-plans", { drama_id: drama.id, hook_id: item.hookId, episode_scope: Array.from({ length: Math.min(5,drama.free_episodes) }, (_, i) => i+1), target_duration_seconds: 300, delivery_goal: "停滑与点击" });
    const ids = [...new Set(data.plans.flatMap((p) => (p.segments || []).map((s) => s.highlightAssetId).filter(Boolean)))];
    for (const id of ids) {
      const highlight = await json("/api/collections/hook_assets/records/" + encodeURIComponent(id) + "?fields=id,source_class,drama");
      if (highlight.source_class !== "episode_highlight" || highlight.drama !== drama.id) throw new Error("candidate does not resolve to the selected drama's highlight asset");
    }
    if (data.hook_validation.productionEligible) throw new Error("draft narration was incorrectly made production-ready");
    report.results.push({ hookId: item.hookId, candidatePlans: data.plans.length, resolvedHighlightIds: ids, boundary: data.hook_validation.boundary, productionEligible: false });
  }
  const reverse = await json("/api/lumina/story-hook-recommendations", { drama_id: drama.id, episode_scope: [1,2,3,4,5], delivery_goal: "停滑与点击" });
  report.reverseCandidates = reverse.candidates.length;
  const narrationIds=new Set(pool.items.filter(h=>h.source_class==='narration_opening').map(h=>h.id));
  report.reverseNarrationCandidates = reverse.candidates.filter((c) => narrationIds.has(c.hook_id)).length;
  await writeFile(".codex-runtime/narration-intake/pilot-verification.json", JSON.stringify(report,null,2) + "\n");
  console.log(JSON.stringify({ ...report, results: report.results.length, withPlans: report.results.filter((r) => r.candidatePlans > 0).length }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
