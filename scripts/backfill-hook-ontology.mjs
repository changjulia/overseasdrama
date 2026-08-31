import taxonomy from "../shared/global-taxonomy.json" with { type: "json" };

const apply = process.argv.includes("--apply");
const base = (process.env.LUMINA_POCKETBASE_URL || "http://127.0.0.1:8090").replace(/\/$/, "");
const key = (value) => String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s_]+/g, "");
const slug = (value) => key(value).replace(/[^\w\u4e00-\u9fff-]+/g, "-").slice(0, 64) || "unknown";
const pendingAliases = new Set((taxonomy.pendingAliases || []).map(key));
const byCode = new Map(taxonomy.definitions.map((item) => [item.code, item]));
const byAlias = new Map();
for (const definition of taxonomy.definitions) {
  for (const alias of definition.aliases || []) {
    if (!pendingAliases.has(key(alias))) byAlias.set(key(alias), definition);
  }
}

const text = (value) => {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object") return String(value.label || value.value || value.tag || value.name || "").trim();
  return "";
};
const values = (value) => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]).map(text).filter(Boolean);
const normalize = (raw, fallbackDimension, evidence) => {
  const original = text(raw);
  if (!original) return null;
  const explicitCode = raw && typeof raw === "object" ? String(raw.code || "") : "";
  const candidate = byCode.get(explicitCode) || byAlias.get(key(original));
  const definition = candidate || {
    code: `${fallbackDimension}.${slug(original)}`,
    label: original,
    dimension: fallbackDimension,
    aliases: [original],
    related: [],
    contradicts: [],
  };
  return {
    code: definition.code,
    label: definition.label,
    dimension: definition.dimension,
    aliases: definition.aliases || [definition.label],
    ...(definition.parent ? { parent: definition.parent } : {}),
    related: definition.related || [],
    contradicts: definition.contradicts || [],
    original,
    evidence: [evidence],
    mappingStatus: candidate ? "mapped" : "pending_mapping",
    taxonomyVersion: taxonomy.version,
  };
};

async function request(path, init) {
  const response = await fetch(`${base}${path}`, {
    cache: "no-store",
    headers: { "content-type": "application/json", "x-lumina-ui": "local", ...(init?.headers || {}) },
    ...init,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
  return payload;
}

const listPayload = await request("/api/lumina/local-ui/collections/hook_assets/records?perPage=500&sort=-id");
const records = listPayload.items || [];
const audit = process.argv.includes("--audit");
const summary = { mode: apply ? "apply" : "dry-run", total: records.length, changed: 0, unchanged: 0, protectedLegacy: 0, mapped: 0, pending: 0, written: 0, pendingLabels: {}, pendingByField: {} };
const updates = [];

for (const record of records) {
  const existingOntology = Array.isArray(record.ontology_tags) ? record.ontology_tags : [];
  if (existingOntology.some((tag) => typeof tag !== "object" || tag === null)) {
    summary.protectedLegacy += 1;
    summary.unchanged += 1;
    continue;
  }
  const incoming = [];
  const add = (field, dimension) => {
    for (const raw of values(record[field])) {
      const tag = normalize(raw, dimension, `hook_asset:${record.id}:${field}`);
      if (tag) {
        if (tag.mappingStatus === "mapped") incoming.push(tag);
        if (tag.mappingStatus !== "mapped") {
          const label = tag.original || tag.label || tag.code;
          summary.pendingByField[field] ||= {};
          summary.pendingByField[field][label] = (summary.pendingByField[field][label] || 0) + 1;
        }
      }
    }
  };
  add("themes", "theme");
  add("relationships", "relation");
  add("conflict", "conflict");
  add("emotion", "emotion");
  add("character_roles", "role");
  add("content_tags", "acquisition");
  add("hook_type", "acquisition");

  const merged = new Map();
  for (const tag of [...existingOntology, ...incoming]) {
    if (!tag || typeof tag !== "object" || !tag.code) continue;
    const identity = `${tag.code}|${tag.original || tag.label || ""}`;
    const previous = merged.get(identity);
    merged.set(identity, previous ? { ...previous, ...tag, evidence: [...new Set([...(previous.evidence || []), ...(tag.evidence || [])])] } : tag);
  }
  const next = [...merged.values()];
  for (const tag of next) {
    if (tag.mappingStatus === "mapped") summary.mapped += 1;
    else {
      summary.pending += 1;
      const label = tag.original || tag.label || tag.code;
      summary.pendingLabels[label] = (summary.pendingLabels[label] || 0) + 1;
    }
  }
  const before = JSON.stringify(record.ontology_tags || []);
  const after = JSON.stringify(next);
  if (before === after) {
    summary.unchanged += 1;
    continue;
  }
  summary.changed += 1;
  if (apply) {
    updates.push({ id: record.id, ontology_tags: next });
  }
}

if (apply && updates.length) {
  const result = await request("/api/lumina/local-ui/hook-ontology-backfill", {
    method: "POST",
    body: JSON.stringify({ confirm: "BACKFILL_MAPPED_HOOK_ONTOLOGY", updates }),
  });
  summary.written = Number(result.written || 0);
}

summary.pendingLabels = Object.fromEntries(Object.entries(summary.pendingLabels).sort((a, b) => b[1] - a[1]).slice(0, 40));
for (const [field, labels] of Object.entries(summary.pendingByField)) {
  summary.pendingByField[field] = Object.fromEntries(Object.entries(labels).sort((a, b) => b[1] - a[1]).slice(0, audit ? 500 : 20));
}
console.log(JSON.stringify(summary, null, 2));
