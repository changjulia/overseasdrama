"use client";

import { useEffect, useRef, useState } from 'react';
import type { FactoryEpisodeMedia } from '../types';
import { CHARACTER_STATE_FIELDS, characterReadiness, emptyCharacterState, type PreRollCharacter, type PreRollCharacterPack, type CharacterReference } from '../../../lib/pre-roll-characters';
import { captureCharacterFrame, prepareReferenceUpload, readReferenceImage, saveReferenceImage, type ReferenceCrop } from '../../../lib/pre-roll-reference-assets';
import styles from './PreRollCharacters.module.css';

const VIEW_NAMES = { front: '正脸', side: '侧脸', full: '半身／全身', entry: '正片接点状态' } as const;
type Props = { pack: PreRollCharacterPack; onChange: (pack: PreRollCharacterPack) => void; episodeMedia?: Record<number, FactoryEpisodeMedia>; entry?: { episode: number; start: number } };

function ReferencePreview({ reference, name }: { reference: CharacterReference; name: string }) {
  const [url, setUrl] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let active = true, objectUrl = '';
    void readReferenceImage(reference.id).then(blob => {
      if (!active) return;
      if (!blob) { setMissing(true); return; }
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (active) setMissing(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [reference.id]);
  return <>{url ? <img src={url} alt={`${name} · ${VIEW_NAMES[reference.view]}`} /> : <span>{missing ? '图片已丢失，请重新添加' : '加载参考图…'}</span>}</>;
}

export default function PreRollCharacters({ pack, onChange, episodeMedia = {}, entry }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const selected = pack.characters.find(c => c.id === selectedId) || pack.characters[0];
  const [episode, setEpisode] = useState(entry?.episode || 1);
  const [view, setView] = useState<CharacterReference['view']>('front');
  const [crop, setCrop] = useState<ReferenceCrop>({ x: 0, y: 0, width: 100, height: 100 });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  // Async image persistence must never write an older pack over newer user edits.
  const latest = useRef({ pack, onChange }); latest.current = { pack, onChange };
  const media = episodeMedia[episode];
  const issues = characterReadiness(pack);
  function patch(id: string, patch: Partial<PreRollCharacter>) {
    const current = latest.current;
    current.onChange({ ...current.pack, characters: current.pack.characters.map(c => c.id === id ? { ...c, ...patch } : c) });
  }
  async function addReference(source: 'episode' | 'upload', file?: File) {
    if (!selected || busy || selected.references.length >= 6) return;
    const characterId = selected.id, anchorKey = pack.anchorKey, kind = view, referenceNote = note;
    const video = videoRef.current;
    if (source === 'episode' && !video) { setError('请先选择可播放的正片'); return; }
    if (source === 'episode') video!.pause();
    const seconds = video?.currentTime;
    setBusy(true); setError(''); setNotice('');
    try {
      const blob = source === 'upload' ? await prepareReferenceUpload(file!) : await captureCharacterFrame(video!, crop);
      const id = `ref-${crypto.randomUUID()}`;
      await saveReferenceImage(id, blob);
      const current = latest.current, character = current.pack.characters.find(c => c.id === characterId);
      if (current.pack.anchorKey !== anchorKey || !character) return;
      const reference: CharacterReference = { id, fileName: `${id}.jpg`, view: kind, source, note: referenceNote, ...(source === 'episode' ? { episode, seconds: Math.round(seconds! * 1000) / 1000 } : {}) };
      patch(characterId, { references: [...character.references, reference] });
      setNotice('参考图已保存在此浏览器，并绑定到该角色。请检查画面中人物是否正确。');
    } catch (e) { setError(e instanceof Error ? e.message : '添加参考图失败'); }
    finally { setBusy(false); }
  }
  function jumpToEntry() {
    if (!entry) return;
    setEpisode(entry.episode); setView('entry');
    if (episode === entry.episode && videoRef.current?.readyState) videoRef.current.currentTime = entry.start;
  }
  return <details className={styles.panel} open>
    <summary>人物一致性 · {pack.characters.length} 张角色卡 · {pack.characters.reduce((n, c) => n + c.references.length, 0)} 张参考图</summary>
    <p>角色描述与图片固定复用；为正片入口填写人物状态，再向前续写钩子。图片保存在此浏览器，导出参考包时会包含原图文件。</p>
    <div className={styles.toolbar}>
      <label>当前角色<select value={selected?.id || ''} onChange={e => { setSelectedId(e.target.value); setError(''); }}>
        {!pack.characters.length && <option value="">请添加角色</option>}{pack.characters.map(c => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}
      </select></label>
      <button type="button" disabled={pack.characters.length >= 12 || busy} onClick={() => {
        const id = `cast-${crypto.randomUUID()}`;
        onChange({ ...pack, characters: [...pack.characters, { id, name: `角色 ${pack.characters.length + 1}`, aliases: [], origin: 'body', identity: '', relationships: '', appearance: '', voice: '', entryState: emptyCharacterState(), references: [] }] }); setSelectedId(id);
      }}>＋ 添加角色</button>
    </div>
    {selected && <>
      <div className={styles.fields}>
        <label>角色姓名<input value={selected.name} onChange={e => patch(selected.id, { name: e.target.value })} maxLength={100} /></label>
        <label>别称（用逗号分隔）<input value={selected.aliases.join(',')} onChange={e => patch(selected.id, { aliases: e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) })} /></label>
        <label>角色来源<select value={selected.origin} onChange={e => patch(selected.id, { origin: e.target.value as PreRollCharacter['origin'] })}><option value="body">正片人物</option><option value="original">前贴新增人物</option></select></label>
        <label>身份<input value={selected.identity} onChange={e => patch(selected.id, { identity: e.target.value })} maxLength={1500} /></label>
        <label>人物关系<input value={selected.relationships} onChange={e => patch(selected.id, { relationships: e.target.value })} maxLength={1500} placeholder="谁与谁是什么关系；未知留空" /></label>
        <label>声音特征<input value={selected.voice} onChange={e => patch(selected.id, { voice: e.target.value })} maxLength={1500} placeholder="音色、口音；按正片填写" /></label>
      </div>
      <label>固定外观描述<textarea value={selected.appearance} onChange={e => patch(selected.id, { appearance: e.target.value })} maxLength={1500} placeholder="根据参考图填写年龄感、脸型、发型和标志特征。未知留空，不自动猜测。" /></label>
      <p className={styles.hint}>固定角色 ID：{selected.id}。分镜与参考文件都使用此 ID，改称呼不会变成另一个人。</p>
      <h4>角色参考图</h4>
      <div className={styles.toolbar}>
        <label>图像用途<select value={view} onChange={e => setView(e.target.value as CharacterReference['view'])}>{Object.entries(VIEW_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>选择正片<select value={episode} onChange={e => setEpisode(Number(e.target.value))}>{!Object.keys(episodeMedia).length && <option value={episode}>尚未连接视频，可上传截图</option>}{Object.values(episodeMedia).map(m => <option key={m.episode} value={m.episode}>第 {m.episode} 集</option>)}</select></label>
        <button type="button" onClick={jumpToEntry} disabled={!entry || !episodeMedia[entry.episode]?.url}>定位正片接点</button>
      </div>
      {media?.url && <div className={styles.videoFrame}>
        <video key={`${episode}-${media.url}`} ref={videoRef} src={media.url} crossOrigin="anonymous" controls preload="metadata" onLoadedMetadata={e => { if (entry?.episode === episode) e.currentTarget.currentTime = Math.min(entry.start, Math.max(0, e.currentTarget.duration - .05)); }} onError={() => setError('该片源无法加载或不支持跨域截图，可上传从原片保存的角色图。')} />
        <div aria-hidden="true" className={styles.crop} style={{ left: `${crop.x}%`, top: `${crop.y}%`, width: `${crop.width}%`, height: `${crop.height}%` }} />
      </div>}
      <div className={styles.fields}>{([['x', '裁切左边 %'], ['y', '裁切顶部 %'], ['width', '裁切宽度 %'], ['height', '裁切高度 %']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min={0} max={100} value={crop[key]} onChange={e => setCrop(c => ({ ...c, [key]: Number(e.target.value) }))} /></label>)}</div>
      <label>参考图说明<input value={note} onChange={e => setNote(e.target.value)} maxLength={1500} placeholder="例如：画面左侧穿红裙的是该角色；建议裁切为单人参考" /></label>
      <div className={styles.toolbar}>
        <button type="button" disabled={busy || !media?.url || selected.references.length >= 6} onClick={() => void addReference('episode')}>{busy ? '正在保存…' : '截取当前画面并绑定'}</button>
        <label>上传角色截图<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || selected.references.length >= 6} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void addReference('upload', file); }} /></label>
      </div>
      <div className={styles.references}>{selected.references.map(r => <figure key={r.id}><ReferencePreview reference={r} name={selected.name} /><figcaption>{VIEW_NAMES[r.view]} · {r.source === 'episode' ? `第${r.episode}集 ${r.seconds}秒` : '上传图片'}<small>{r.note}</small></figcaption><button type="button" disabled={busy} onClick={() => patch(selected.id, { references: selected.references.filter(ref => ref.id !== r.id) })}>从当前角色卡移除</button></figure>)}</div>
      <h4>正片入口人物状态{entry ? ` · 第${entry.episode}集 ${entry.start.toFixed(2)}秒` : ''}</h4>
      <p className={styles.hint}>对照接点画面填写，未知留空，不适用填“无”。前贴可以解释这些状态如何形成。</p>
      <div className={styles.fields}>{CHARACTER_STATE_FIELDS.map(([key, label]) => <label key={key}>{label}<input value={selected.entryState[key]} maxLength={1500} onChange={e => patch(selected.id, { entryState: { ...selected.entryState, [key]: e.target.value } })} /></label>)}</div>
      <button type="button" disabled={busy} onClick={() => { onChange({ ...pack, characters: pack.characters.filter(c => c.id !== selected.id) }); setSelectedId(''); }}>从本轮设置移除此角色</button>
    </>}
    {issues.length > 0 && <details><summary>待补充 {issues.length} 项</summary>{issues.map((issue, i) => <p key={i}>{issue}</p>)}</details>}
    <p className={styles.hint}>修改角色或正片接点后，重新生成一轮以采用新设置。历史脚本使用当时保存的角色包；移除当前参考不会删除历史记录中的图片。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}<p role="status">{notice}</p>
  </details>;
}
