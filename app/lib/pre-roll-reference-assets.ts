import { strToU8, zipSync } from 'fflate';
import { formatPreRollScript, type PreRollContext, type PreRollScript } from './pre-roll-script';
import { characterReadiness, validateCharacterBindings, validateCharacterPack } from './pre-roll-characters';

async function referenceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('lumina-pre-roll-references', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法访问图片存储，请允许浏览器本地存储'));
  });
}
export async function saveReferenceImage(id: string, blob: Blob): Promise<void> {
  const db = await referenceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('参考图保存失败，请检查浏览器存储空间'));
    });
  } finally { db.close(); }
}
export async function readReferenceImage(id: string): Promise<Blob | undefined> {
  const db = await referenceDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').get(id);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : undefined);
      request.onerror = () => reject(new Error('参考图读取失败'));
    });
  } finally { db.close(); }
}

export type ReferenceCrop = { x: number; y: number; width: number; height: number };
export function cropBounds(crop: ReferenceCrop, width: number, height: number) {
  if (!Object.values(crop).every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 100 || crop.y + crop.height > 100) throw new Error('裁切范围应在画面内，宽度与高度须大于零');
  return { x: width * crop.x / 100, y: height * crop.y / 100, width: width * crop.width / 100, height: height * crop.height / 100 };
}
function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片编码失败')), 'image/jpeg', .88); }
    catch { reject(new Error('该片源不允许浏览器截图，请上传从原片保存的角色图片')); }
  });
}
export async function captureCharacterFrame(video: HTMLVideoElement, crop: ReferenceCrop): Promise<Blob> {
  if (video.readyState < 2 || video.seeking || !video.videoWidth) throw new Error('请等待视频画面加载完成后再截图');
  video.pause();
  const rect = cropBounds(crop, video.videoWidth, video.videoHeight);
  const scale = Math.min(1, 1024 / Math.max(rect.width, rect.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(rect.width * scale)); canvas.height = Math.max(1, Math.round(rect.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器暂时无法截图');
  context.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
  return jpeg(canvas);
}
export async function prepareReferenceUpload(file: File): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024) throw new Error('请上传 15 MB 以内的 JPG、PNG 或 WebP 图片');
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('图片处理失败');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return jpeg(canvas);
  } finally { image.close(); }
}

export function buildCharacterManifest(script: PreRollScript, context: PreRollContext) {
  if (!context.characterPack?.characters.length) throw new Error('该记录未绑定角色包，请补充角色后另存一轮生成');
  const pack = validateCharacterPack(context.characterPack);
  validateCharacterBindings(script.shots, pack);
  const used = new Set(script.shots.flatMap(s => (s.characterStates || []).map(c => c.characterId)));
  const characters = pack.characters.filter(c => used.has(c.id));
  return {
    version: 1, drama: context.drama, planId: context.plan.id, anchorKey: pack.anchorKey,
    bodyEntry: { episode: context.plan.segments[0].episode, seconds: context.plan.segments[0].start },
    characters, warnings: characterReadiness({ ...pack, characters }),
    shots: script.shots.map((shot, index) => ({ index: index + 1, start: shot.start, end: shot.end, states: shot.characterStates || [],
      references: (shot.characterStates || []).flatMap(s => characters.find(c => c.id === s.characterId)!.references.map(r => ({ characterId: s.characterId, file: `references/${r.fileName}`, view: r.view }))),
    })),
  };
}

/** Assets remain local; the returned package must be uploaded by the user to the video model. */
export async function createCharacterReferenceZip(script: PreRollScript, context: PreRollContext, readImage = readReferenceImage): Promise<Uint8Array> {
  const manifest = buildCharacterManifest(script, context);
  const files: Record<string, Uint8Array> = {
    'script.txt': strToU8(formatPreRollScript(script, context)),
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'README.txt': strToU8(`上传 references 中对应角色的图片，再使用 script.txt 或 shots 中的逐镜提示词。文件名和角色 ID 对应关系见 manifest.json。前贴末镜同时参照 entry 类型图片与正片入口状态。\n这是一份角色参考包，尚未执行视频生成或视觉一致性核验。\n${manifest.warnings.join('\n')}`),
  };
  for (const c of manifest.characters) {
    for (const r of c.references) {
      const blob = await readImage(r.id);
      if (!blob) throw new Error(`${c.name}的参考图 ${r.fileName} 已丢失，请重新添加后生成新的记录；本次未导出缺图包`);
      files[`references/${r.fileName}`] = new Uint8Array(await blob.arrayBuffer());
    }
  }
  script.shots.forEach((_, i) => { files[`shots/${String(i + 1).padStart(2, '0')}.txt`] = strToU8(formatPreRollScript(script, context, i)); });
  return zipSync(files, { level: 0 });
}
