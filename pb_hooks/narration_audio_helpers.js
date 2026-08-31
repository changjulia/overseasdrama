const MIME_BY_EXTENSION = {
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav",
  aac: "audio/aac", ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac"
};

function probeAudio(file) {
  const ffprobe = String($os.getenv("LUMINA_FFPROBE_PATH") || "ffprobe");
  const dd = String($os.getenv("LUMINA_DD_PATH") || "/bin/dd");
  const temporary = $filepath.join($os.tempDir(), `lumina-narration-${$security.randomString(24)}.audio`);
  const reader = file.reader.open();
  try {
    const copy = $os.cmd(dd, `of=${temporary}`, "status=none");
    copy.stdin = reader;
    copy.run();
    const command = $os.cmd(ffprobe, "-v", "error", "-show_entries", "format=duration,format_name", "-show_entries", "stream=codec_type,codec_name", "-of", "json", "-i", temporary);
    let parsed;
    try { parsed = JSON.parse(toString(command.output())); }
    catch (_) { throw new BadRequestError("audio could not be decoded by server ffprobe"); }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const audioStreams = streams.filter((stream) => stream && stream.codec_type === "audio");
    const duration = Number(parsed.format && parsed.format.duration);
    if (!audioStreams.length || !Number.isFinite(duration) || duration <= 0)
      throw new BadRequestError("uploaded file does not contain a decodable audio stream");
    return {
      tool: "ffprobe",
      formatName: String(parsed.format.format_name || ""),
      codecs: audioStreams.map((stream) => String(stream.codec_name || "unknown")),
      durationSeconds: duration,
      audioStreamCount: audioStreams.length,
    };
  } finally {
    reader.close();
    try { $os.remove(temporary); } catch (_) {}
  }
}

function commandSha256File(file) {
  const executable = String($os.getenv("LUMINA_SHA256_PATH") || "");
  if (!executable || !/^\//.test(executable))
    throw new BadRequestError("server SHA-256 executable is not configured");
  const reader = file.reader.open();
  try {
    const command = /(^|\/)shasum$/.test(executable)
      ? $os.cmd(executable, "-a", "256")
      : $os.cmd(executable);
    command.stdin = reader;
    const digest = toString(command.output()).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new BadRequestError("server SHA-256 calculation failed");
    return digest;
  } finally { reader.close(); }
}

function validateProbedFormat(extension, formatName) {
  const formats = String(formatName || "").toLowerCase().split(",");
  const expected = {
    wav: ["wav"], flac: ["flac"], ogg: ["ogg"], webm: ["webm", "matroska"],
    m4a: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    mp4: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"], aac: ["aac"], mp3: ["mp3"],
  }[extension] || [];
  if (!expected.some((item) => formats.includes(item)))
    throw new BadRequestError("ffprobe container signature does not match the file extension");
}

function audioMetadata(file) {
  const originalName = String(file.originalName || file.name || "").trim();
  const extension = originalName.toLowerCase().split(".").pop();
  const mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType) throw new BadRequestError("audio must be mp3, m4a, mp4, wav, aac, ogg, webm or flac");
  if (!Number(file.size) || Number(file.size) > 104857600) throw new BadRequestError("audio must be between 1 byte and 100 MiB");
  const probe = probeAudio(file);
  validateProbedFormat(extension, probe.formatName);
  return { originalName: originalName.slice(0, 500), mimeType, byteSize: Number(file.size), sha256: commandSha256File(file), probe };
}

function workerBaseUrl() {
  const configured = String($os.getenv("LUMINA_POCKETBASE_WORKER_BASE_URL") || "").replace(/\/$/, "");
  if (/^https:\/\/[^/]+$/i.test(configured)) return configured;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured)) return configured;
  throw new BadRequestError("secure PocketBase worker base URL is not configured");
}

function mediaToken(record) {
  const secret = String($os.getenv("LUMINA_WORKER_TOKEN") || "");
  if (!secret) throw new BadRequestError("narration media signing is not configured");
  return $security.hs256(`${record.id}:${record.getString("project")}:${record.getString("sha256")}`, secret);
}

function assertAssetMutable(app, project) {
  if (project.getString("status") === "rendering")
    throw new BadRequestError("narration audio cannot change while rendering");
  const active = app.findRecordsByFilter(
    "factory_renders",
    "project = {:project} && (status = 'queued' || status = 'rendering')",
    "-version", 500, 0, { project: project.id },
  );
  if (active.length)
    throw new BadRequestError("narration audio cannot change while a preview or final render is queued or rendering");
}

function invalidateTransition(app, project, removedAssetId) {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  const transition = helpers.jsonObject(project, "transition");
  if (!transition.type) return Math.max(1, Number(transition.version || 1));
  const voice = transition.voice && typeof transition.voice === "object" ? transition.voice : {};
  if (removedAssetId && String(voice.assetId || "") === String(removedAssetId)) {
    transition.voice = { mode: "manual_audio", speakingRate: Number(voice.speakingRate || 1) };
  }
  transition.reviewStatus = "draft";
  transition.reviewerNote = "";
  transition.reviewPreviewUrl = "";
  transition.reviewPreviewHash = "";
  transition.reviewPreviewVersion = 0;
  transition.reviewPreviewTransitionVersion = 0;
  transition.version = Math.max(1, Number(transition.version || 1)) + 1;
  project.set("transition", transition);
  project.set("review", {});
  project.set("status", "draft");
  app.save(project);
  return transition.version;
}

module.exports = { audioMetadata, workerBaseUrl, mediaToken, assertAssetMutable, invalidateTransition };
