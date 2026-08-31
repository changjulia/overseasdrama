/// <reference path="../pb_data/types.d.ts" />

// Local workstation adapter for locked collections. Hosted browsers continue
// to use the authenticated server gateway; this route is unreachable unless
// PocketBase was explicitly started in local-loopback mode.
const LOCAL_COLLECTIONS = [
  "dramas", "drama_episodes", "ad_materials", "analysis_jobs",
  "material_analysis_jobs", "hook_assets", "hook_match_jobs",
  "hook_story_matches", "supplemental_highlight_jobs", "entry_precision_jobs",
];
const LOCAL_WRITABLE = ["dramas", "drama_episodes", "ad_materials"];
const LOCAL_FILE_COLLECTIONS = [
  "dramas", "pbc_lumdramas1", "drama_episodes", "pbc_lumepisodes",
  "ad_materials", "pbc_lumadmat001", "hook_assets", "pbc_lumhooks001",
  "factory_renders", "pbc_lumrenders1",
];

function allowedCollection(name, writable) {
  const list = writable ? LOCAL_WRITABLE : LOCAL_COLLECTIONS;
  if (!list.includes(name)) throw new ForbiddenError("Local UI collection is not allowed");
  return name;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function exportRecords(app, records, expand, fields) {
  const valid = records.filter(Boolean);
  if (expand.length) app.expandRecords(valid, expand, null);
  // PocketBase's publicExport is a Go-backed map; returning the complete safe
  // export is reliable across the JS boundary. `fields` remains a bandwidth
  // hint for hosted PocketBase, not a security boundary.
  return valid.map((record) => record.publicExport());
}

function listRecords(e) {
  const collection = allowedCollection(e.request.pathValue("collection"), false);
  const query = e.requestInfo().query;
  const page = boundedInteger(query.page, 1, 1, 100000);
  const perPage = boundedInteger(query.perPage, 30, 1, 500);
  const filter = String(query.filter || "");
  const sort = String(query.sort || "-id");
  const expand = String(query.expand || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 10);
  const fields = String(query.fields || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 200);
  const all = e.app.findRecordsByFilter(collection, filter, sort, perPage + 1, (page - 1) * perPage).filter(Boolean);
  const hasNext = all.length > perPage;
  const items = exportRecords(e.app, all.slice(0, perPage), expand, fields);
  return { page, perPage, totalItems: hasNext ? page * perPage + 1 : (page - 1) * perPage + items.length, totalPages: hasNext ? page + 1 : page, items };
}

function getRecord(e) {
  const collection = allowedCollection(e.request.pathValue("collection"), false);
  const record = e.app.findRecordById(collection, e.request.pathValue("id"));
  const expand = String(e.requestInfo().query.expand || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 10);
  if (expand.length) e.app.expandRecord(record, expand, null);
  return record.publicExport();
}

function saveLocalRecord(e, creating) {
  const collectionName = allowedCollection(e.request.pathValue("collection"), true);
  const record = creating
    ? new Record(e.app.findCollectionByNameOrId(collectionName))
    : e.app.findRecordById(collectionName, e.request.pathValue("id"));
  const contentType = String(e.request && e.request.header ? e.request.header.get("content-type") : "");
  const uploaded = {};
  if (/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    ["poster", "video"].forEach((field) => {
      try {
        const pair = e.request.formFile(field);
        if (pair && pair[0]) pair[0].close();
        uploaded[field] = pair && pair[1] ? [$filesystem.fileFromMultipart(pair[1])] : [];
      } catch (_) { uploaded[field] = []; }
    });
  }
  const multipartFields = {
    dramas: ["external_id", "title", "cn", "genre", "language", "total_episodes", "free_episodes", "copyright_status", "parse_state", "parse_config", "analysis", "source_type", "source_platform", "source_record_id", "acquisition_method", "external_cover_url", "source_metadata"],
    drama_episodes: ["drama", "episode_number", "original_name", "mime_type", "byte_size", "duration_seconds", "analysis_status", "analysis_progress", "analysis_error", "analysis_result"],
    ad_materials: ["title", "type", "source", "platform", "market", "language", "theme", "exposure", "days", "original_name", "mime_type", "byte_size", "duration_seconds", "analysis_status", "analysis_progress", "analysis_error", "analysis_result", "prototype", "review_status", "analysis_schema_version", "analysis_stage", "segment_count", "hook_count", "creative_tier", "material_format", "review_flags", "prototype_inputs", "source_attribution", "content_hash", "source_url", "rights_status", "intake_status", "intake_batch_id", "intake_error", "source_identity_hash"],
  };
  const body = /^multipart\/form-data(?:;|$)/i.test(contentType)
    ? Object.fromEntries(multipartFields[collectionName].map((key) => [key, e.request.formValue(key)]).filter(([, value]) => value !== ""))
    : (e.requestInfo().body || {});
  Object.keys(body).forEach((key) => {
    if (!["id", "collectionId", "collectionName", "created", "updated", "poster", "video"].includes(key)) record.set(key, body[key]);
  });
  if (/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    ["poster", "video"].forEach((field) => {
      const files = uploaded[field] || [];
      if (files.length > 1) throw new BadRequestError(`Only one ${field} file is allowed`);
      if (files.length === 1) record.set(field, files[0]);
    });
  }
  e.app.save(record);
  return { status: creating ? 201 : 200, record: record.publicExport() };
}

function createRecord(e) { return saveLocalRecord(e, true); }

function importMaterialFile(e) {
  const body = e.requestInfo().body || {};
  const root = $filepath.clean(String($os.getenv("LUMINA_LOCAL_MEDIA_IMPORT_ROOT") || ""));
  const sourcePath = $filepath.clean(String(body.path || ""));
  if (!root || !$filepath.isAbs(root) || !$filepath.isAbs(sourcePath)) throw new BadRequestError("Local media import root and absolute path are required");
  const relative = $filepath.rel(root, sourcePath);
  if (!relative || relative === "." || relative === ".." || relative.startsWith("../") || relative.startsWith("..\\") || $filepath.isAbs(relative)) throw new ForbiddenError("Local media path is outside the configured import root");
  if (![".mp4", ".mov", ".webm", ".mkv", ".avi", ".mpeg"].includes($filepath.ext(sourcePath).toLowerCase())) throw new BadRequestError("Unsupported local media extension");
  const expectedHash = String(body.content_hash || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new BadRequestError("A SHA-256 content_hash is required");
  const record = new Record(e.app.findCollectionByNameOrId("ad_materials"));
  const allowed = ["title", "type", "source", "platform", "market", "language", "theme", "exposure", "days", "original_name", "mime_type", "byte_size", "duration_seconds", "rights_status", "intake_batch_id"];
  allowed.forEach((field) => { if (body[field] != null) record.set(field, body[field]); });
  record.set("content_hash", expectedHash);
  record.set("analysis_status", "queued"); record.set("analysis_progress", 0); record.set("analysis_stage", "queued");
  record.set("analysis_schema_version", "material-v2"); record.set("review_status", "pending"); record.set("intake_status", "stored");
  record.set("video", $filesystem.fileFromPath(sourcePath));
  e.app.save(record);
  return record.publicExport();
}
function updateRecord(e) { return saveLocalRecord(e, false); }
function deleteRecord(e) {
  const collection = allowedCollection(e.request.pathValue("collection"), true);
  e.app.delete(e.app.findRecordById(collection, e.request.pathValue("id")));
  return true;
}

function getFile(e) {
  const supplied = e.request.pathValue("collection");
  if (!LOCAL_FILE_COLLECTIONS.includes(supplied)) throw new ForbiddenError("Local UI file collection is not allowed");
  const record = e.app.findRecordById(supplied, e.request.pathValue("id"));
  const filename = e.request.pathValue("filename");
  const exported = record.publicExport();
  const ownsFile = Object.keys(exported).some((key) => exported[key] === filename || (Array.isArray(exported[key]) && exported[key].includes(filename)));
  if (!ownsFile) throw new NotFoundError("File does not belong to record");
  const filesystem = e.app.newFilesystem();
  let reader = null;
  try {
    reader = filesystem.getReader(`${record.collection().id}/${record.id}/${filename}`);
    e.stream(200, reader.contentType(), reader);
  } finally {
    if (reader) reader.close();
    filesystem.close();
  }
}

module.exports = { listRecords, getRecord, createRecord, importMaterialFile, updateRecord, deleteRecord, getFile };
