import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fromRecord, type InspirationMaterial } from "../app/lib/inspiration-material-store";

const base = "http://127.0.0.1:8090";
const response = await fetch(`${base}/api/collections/ad_materials/records?perPage=500&sort=-id`);
if (!response.ok) throw new Error(`PocketBase ${response.status}`);
const payload = await response.json() as { items?: Record<string, unknown>[] };
const directory = resolve("public/material-analysis");
await mkdir(directory, { recursive: true });
const cachedMaterials: InspirationMaterial[] = [];

for (const record of payload.items ?? []) {
  if (record.analysis_status !== "succeeded" && record.analysis_status !== "completed") continue;
  const material = fromRecord(record);
  cachedMaterials.push(material);
  await writeFile(resolve(directory, `${material.id}.json`), JSON.stringify(material), "utf8");
}

await writeFile(resolve(directory, "index.json"), JSON.stringify(cachedMaterials), "utf8");

console.log(`Cached ${cachedMaterials.length} material records.`);
