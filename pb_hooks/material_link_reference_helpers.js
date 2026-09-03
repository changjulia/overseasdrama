// Narrow MVP: only the user's verified public media origin; no server fetch.
function allowedReferenceUrl(value) {
  return typeof value === "string" && value.length <= 2000 &&
    /^https:\/\/zqingalioss\.wozhangwan\.com\/[^\s\\#]+$/.test(value);
}
function validateReference(source, attribution) {
  if (!allowedReferenceUrl(source)) throw new Error("Unsupported reference video URL");
  if (!attribution || attribution.schema !== "csv-hook-reference-v1" || attribution.verification !== "unverified")
    throw new Error("Unverified CSV reference metadata is required");
  if (!Array.isArray(attribution.scenes) || attribution.scenes.length < 1 || attribution.scenes.length > 50)
    throw new Error("Between 1 and 50 reference scenes are required");
  attribution.scenes.forEach(scene => {
    if (!scene || !Number.isInteger(scene.sceneNumber) || scene.sceneNumber < 1 ||
        typeof scene.script !== "string" || scene.script.length > 80000 ||
        (scene.frameUrl && (typeof scene.frameUrl !== "string" || !scene.frameUrl.split(/[,\r\n]+/).filter(Boolean).every(url => allowedReferenceUrl(url.trim())))))
      throw new Error("Invalid reference scene");
  });
  return true;
}
module.exports = { allowedReferenceUrl, validateReference };
