"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { StorylinePlan, SelectedRangeStoryUnderstanding } from '../../../lib/hook-match-store';
import { formatPreRollScript, formatShotNarrative, preRollTime, type PreRollContext, type PreRollIdea } from '../../../lib/pre-roll-script';
import { PRE_ROLL_LANGUAGES, normalizePreRollLocale } from '../../../lib/pre-roll-language';
import { EMPTY_PRE_ROLL_WORKSPACE, getPreRollWorkspaceStore } from '../../../lib/pre-roll-workspace-store';
import styles from './PreRollWorkshop.module.css';
import { PRE_ROLL_HOOK_PATTERNS, type PreRollHookPatternId } from '../../../lib/pre-roll-hook-patterns';
import PreRollCharacters from './PreRollCharacters';
import { characterAnchorKey, seedCharacterPack, characterReadiness } from '../../../lib/pre-roll-characters';
import { createCharacterReferenceZip } from '../../../lib/pre-roll-reference-assets';
import type { FactoryEpisodeMedia } from '../types';

type Props = { drama: string; plans: StorylinePlan[]; entryPointIds: Record<string, string>; understanding: SelectedRangeStoryUnderstanding | null; language: string; ratio: string; episodeMedia?: Record<number, FactoryEpisodeMedia> };
export default function PreRollWorkshop(props: Props) {
  const store = useMemo(() => getPreRollWorkspaceStore(props.drama), [props.drama]);
  const workspace = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_PRE_ROLL_WORKSPACE);
  const { draft } = workspace;
  const planId = draft.planId || '';
  const setPlanId = (planId: string) => store.patchDraft({ planId });
  const sourcePlan = props.plans.find(p => p.id === planId) || props.plans[0] || workspace.records.find(r => r.id === workspace.currentId)?.context.plan;
  const entry = sourcePlan?.entryPoints?.find(e => e.id === props.entryPointIds[sourcePlan.id]) || sourcePlan?.entryPoints?.[0];
  const entryIndex = entry ? sourcePlan.segments.findIndex(s => s.episode === entry.episode && s.start <= entry.start && s.end > entry.start) : -1;
  const plan = sourcePlan && entryIndex >= 0 ? { ...sourcePlan, segments: sourcePlan.segments.slice(entryIndex).map((s, i) => i === 0 ? { ...s, start: entry!.start } : s) } : sourcePlan;
  const duration = draft.duration || 15;
  const dialogueLocale = draft.dialogueLocale || '';
  const descriptionLocale = draft.descriptionLocale || 'zh-CN';
  const subtitleLocale = draft.subtitleLocale || 'none';
  const allowMixedDialogue = draft.allowMixedDialogue || false;
  const setDuration = (duration: number) => store.patchDraft({ duration });
  const setDialogueLocale = (dialogueLocale: string) => store.patchDraft({ dialogueLocale });
  const setDescriptionLocale = (descriptionLocale: string) => store.patchDraft({ descriptionLocale });
  const setSubtitleLocale = (subtitleLocale: string) => store.patchDraft({ subtitleLocale });
  const setAllowMixedDialogue = (allowMixedDialogue: boolean) => store.patchDraft({ allowMixedDialogue });
  let inheritedLanguage = 'en-US';
  try { inheritedLanguage = normalizePreRollLocale(props.language); } catch { /* Older projects may have custom labels. */ }
  const brief = draft.brief || '';
  const setBrief = (brief: string) => store.patchDraft({ brief });
  const hookPatterns = (draft.hookPatterns || []).filter(id => PRE_ROLL_HOOK_PATTERNS.some(p => p.id === id)) as PreRollHookPatternId[];
  const [ideaBusy, setBusy] = useState('');
  const busy = ideaBusy || (workspace.batchRecordId ? 'script' : '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const anchorKey = plan ? characterAnchorKey(plan) : '';
  const savedCharacterPack = workspace.records.find(r => r.id === workspace.currentId)?.context.characterPack;
  const characterPack = draft.characterPacks?.[anchorKey] || (savedCharacterPack?.anchorKey === anchorKey ? savedCharacterPack : seedCharacterPack(props.understanding, anchorKey));
  const context: PreRollContext | null = plan ? { drama: props.drama, plan, understanding: props.understanding, language: dialogueLocale || inheritedLanguage, descriptionLocale, subtitleLocale, allowMixedDialogue, ratio: props.ratio, duration, brief, hookPatterns, characterPack } : null;
  const contextKey = JSON.stringify(context);
  const currentKey = useRef(contextKey);
  useEffect(() => {
    currentKey.current = contextKey;
    requestRef.current?.abort();
    queueMicrotask(() => { setBusy(''); setError(''); setNotice(''); });
    return () => requestRef.current?.abort();
  }, [contextKey]);
  const current = workspace.records.find(r => r.id === workspace.currentId);
  const selected = current?.scripts[current.active] ? current.active : Number(Object.keys(current?.scripts || {})[0] ?? current?.active ?? 0);
  const selectedIndexes = current?.selected || [];
  const missingIndexes = selectedIndexes.filter(i => !current?.scripts[i]);
  const retryIndexes = current ? selectedIndexes.filter(i => ['failed', 'interrupted', 'cancelled'].includes(current.jobs[i]?.state)) : [];
  function toggleSelected(index: number) {
    if (current) store.updateRecord(current.id, r => ({ ...r, selected: r.selected.includes(index) ? r.selected.filter(i => i !== index) : [...r.selected, index] }));
  }
  function showScript(index: number) {
    if (current) store.updateRecord(current.id, r => ({ ...r, active: index }));
  }
  function generateBatch(indexes: number[]) {
    if (!current || busy) return;
    setError(''); setNotice('');
    void store.generateScripts(current.id, indexes);
  }
  const script = current?.scripts[selected];

  async function generate(action: 'ideas', append = false) {
    if (!context || busy) return;
    const generationContext = append && current ? current.context : context;
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setBusy(action); setError(''); setNotice('');
    try {
      const response = await fetch('/api/pre-roll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, context: generationContext, count: append ? 3 - (current?.ideas.length || 0) : 3, existingIdeas: append ? current?.ideas : undefined }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '生成失败');
      if (controller.signal.aborted || currentKey.current !== contextKey) return;
      if (action === 'ideas') {
        if (!Array.isArray(data.ideas)) throw new Error('生成结果不完整，请重试');
        if (!data.ideas.length) {
          setError(`本轮暂无新增可用方向。${current ? '已有方向和脚本仍可使用。' : ''}${data.validation?.rejected?.flatMap((r: { issues: string[] }) => r.issues).join('；') || '请重试。'}`);
          return;
        }
        if (append && current) store.updateRecord(current.id, r => ({ ...r, ideas: [...r.ideas, ...data.ideas], selected: [...r.selected, ...data.ideas.map((_: PreRollIdea, i: number) => r.ideas.length + i)], validation: data.validation }));
        else store.addRecord(generationContext, data.ideas, data.validation);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(`本次方向生成失败：${e instanceof Error ? e.message : '请重试'}${current ? ' 已有方向和脚本仍可使用。' : ''}`);
    } finally { if (requestRef.current === controller) setBusy(''); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('已复制提示词脚本'); }
    catch { setError('剪贴板不可用，请使用下载或选中文字复制'); }
  }
  function download() {
    if (!script || !current) return;
    const idea = current.ideas[selected];
    const content = `# ${idea.title}\n\n## 前贴故事线\n${idea.opening}\n${idea.escalation}\n${idea.cliffhanger}\n\n正片兑现：${idea.bodyConnection}\n创作增补：${idea.inventedDetails.join('；') || '无'}\n\n${formatPreRollScript(script, current.context)}\n\n## 正片承接\n${script.handoff}\n\n## 参考素材\n${script.referenceChecklist.map(s => `- ${s}`).join('\n')}\n\n## 正片依据\n${idea.evidenceSegments.map(i => { const s = current.context.plan.segments[i]; return `- 第${s.episode}集 ${s.start}–${s.end}秒 · ${s.plot} · ${s.highlightAssetId}`; }).join('\n')}`;
    const acquisitionNotes = `\n\n## 买量钩子设计\n走向：${PRE_ROLL_HOOK_PATTERNS.find(p => p.id === idea.patternId)?.label || idea.direction}\n观众最想看什么：${idea.viewerExpectation || idea.appeal}\n局势转折：${idea.turn || idea.escalation}\n吸引力依据：${idea.appeal}\n`;
    const url = URL.createObjectURL(new Blob([content, acquisitionNotes], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${props.drama}-${idea.title}-前贴脚本.md`.replace(/[<>:"/\\|?*]/g, '_'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('已下载故事线、制作脚本和正片依据');
  }
  async function downloadReferences() {
    if (!script || !current) return;
    setError(''); setNotice('正在整理角色参考包…');
    try {
      const bytes = await createCharacterReferenceZip(script, current.context);
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }));
      const a = document.createElement('a'); a.href = url; a.download = `${props.drama}-角色参考包.zip`.replace(/[<>:"/\\|?*]/g, '_'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('已下载角色图片、分镜提示词与逐镜绑定清单，请将对应图片上传至视频模型。');
    } catch (e) { setNotice(''); setError(e instanceof Error ? e.message : '参考包下载失败'); }
  }
  function regenerateWithCharacters() {
    if (!current || busy || !characterPack.characters.length || characterPack.anchorKey !== characterAnchorKey(current.context.plan)) return;
    const nextContext = { ...current.context, characterPack };
    const id = store.addRecord(nextContext, current.ideas, current.validation);
    void store.generateScripts(id, selectedIndexes.length ? selectedIndexes : [selected]);
    setNotice('已另存一轮并按当前角色包重新生成，原脚本仍保留在历史记录中。');
  }

  return <section className={styles.panel} aria-label="前贴潜爆故事线">
    <div className={styles.header}><div><span className={styles.eyebrow}>前贴脚本 · 短剧买量</span><h2>让观众迫切想看下一步</h2></div><span className={styles.muted}>首屏事件 → 局势转折 → 卡点接正片</span></div>
    <p className={styles.muted}>围绕高光与后续正片，生成三个有不同吸引力的买量钩子方案。可多选方案批量输出连续分镜，可整段复制或逐镜用于 Seedance 等视频模型。</p>
    <div className={styles.historyBar}>
      <label>脚本历史 · {workspace.records.length} 轮<select aria-label="脚本历史" value={workspace.currentId} disabled={!workspace.records.length} onChange={e => { store.selectRecord(e.target.value); setError(''); setNotice(''); }}>
        {!workspace.records.length && <option value="">暂无记录，生成后自动保存</option>}
        {workspace.records.map(r => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString('zh-CN')} · {r.context.plan.title} · {r.context.language} · {Object.keys(r.scripts).length}/{r.ideas.length} 个脚本</option>)}
      </select></label>
      <span className={workspace.saveError ? styles.warning : styles.muted} role="status">{workspace.saveError || (workspace.savedAt ? '已自动保存到此浏览器' : '生成结果与设置将自动保存在此浏览器')}</span>
    </div>
    {!plan ? <p>先在上方选择一条含高光片段的正片故事线，即可开始创作。</p> : <>
      <div className={styles.controls}><label>正片故事线<select value={plan.id} onChange={e => setPlanId(e.target.value)}>{props.plans.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label><label>前贴时长<select value={duration} onChange={e => setDuration(Number(e.target.value))}>{[10,15,20,30].map(s => <option key={s} value={s}>{s} 秒</option>)}</select></label><label>对白语言<select value={dialogueLocale || inheritedLanguage} onChange={e => setDialogueLocale(e.target.value)}>{PRE_ROLL_LANGUAGES.map(([code,label]) => <option key={code} value={code}>{label}</option>)}</select></label><label>说明语言<select value={descriptionLocale} onChange={e => setDescriptionLocale(e.target.value)}>{PRE_ROLL_LANGUAGES.map(([code,label]) => <option key={code} value={code}>{label}</option>)}</select></label><label>字幕语言<select value={subtitleLocale} onChange={e => setSubtitleLocale(e.target.value)}><option value="none">不生成字幕</option>{PRE_ROLL_LANGUAGES.map(([code,label]) => <option key={code} value={code}>{label}</option>)}</select></label></div>
      <label className={styles.mixed}><input type="checkbox" checked={allowMixedDialogue} onChange={e => setAllowMixedDialogue(e.target.checked)} />允许混合对白（请在创作要求中说明）</label>
      <p className={styles.muted}>界面保持中文。说明、对白与字幕分别生成和校验；切换设置后需重新生成。画幅：{props.ratio}</p>
      <PreRollCharacters key={anchorKey} pack={characterPack} onChange={pack => store.patchDraft({ characterPacks: { ...store.getSnapshot().draft.characterPacks, [anchorKey]: pack } })} episodeMedia={props.episodeMedia} entry={plan.segments[0]} />
      <details><summary>查看正片依据与保留悬念</summary><p>{plan.storylineSummary}</p>{plan.segments.map((s,i) => <p key={`${i}-${s.episode}-${s.start}`}>第{s.episode}集 {preRollTime(Math.floor(s.start))}–{preRollTime(Math.floor(s.end))}：{s.plot}</p>)}<p>不提前揭露：{plan.hookNeed?.prohibitedReveals?.join('；') || '遵循正片当前悬念，不增编结局'}</p>{plan.warnings?.map(w => <p key={w} className={styles.muted}>{w}</p>)}</details>
      <fieldset className={styles.patterns}>
        <legend>买量钩子走向 · 可多选</legend>
        <p className={styles.muted}>默认优先强感官、禁忌关系、特殊关系或暴力冲突；选择一种时，探索三个不同开场。</p>
        <div className={styles.patternGrid}>{PRE_ROLL_HOOK_PATTERNS.map(pattern => <button type="button" key={pattern.id} aria-pressed={hookPatterns.includes(pattern.id)} className={hookPatterns.includes(pattern.id) ? styles.selected : ''} onClick={() => store.patchDraft({ hookPatterns: hookPatterns.includes(pattern.id) ? hookPatterns.filter(id => id !== pattern.id) : [...hookPatterns, pattern.id] })}>
          <b>{pattern.label}</b><span>{pattern.expectation}</span>
        </button>)}</div>
      </fieldset>
      <label>创作要求（可选）<textarea value={brief} maxLength={2000} onChange={e => setBrief(e.target.value)} placeholder="例如：直接从女主被公开羞辱开场，对方越过底线后她露出反击筹码，让观众等着看对方后悔。" /></label>
      <div className={`${styles.actions} ${styles.primaryAction}`}><button className={styles.primary} disabled={!!busy} onClick={() => void generate('ideas')}>{busy === 'ideas' ? '正在理解正片并创作…' : current ? '重新生成三个方向' : '生成前贴故事线'}</button>{busy && <button onClick={() => { requestRef.current?.abort(); store.cancelBatch(); setBusy(''); }}>取消生成</button>}</div>
    </>}
    {error && <p className={current ? styles.warning : styles.error} role="alert">{error}</p>}
    <div role="status" aria-live="polite">{notice}</div>
    {current && <div className={current.ideas.length < 3 ? styles.warning : styles.muted} role="status">已生成 {current.ideas.length} 个可用方向，可以继续生成脚本。{current.ideas.length < 3 && <>其余方向暂未通过校验。<button disabled={!!busy} onClick={() => void generate('ideas', true)}>补生成 {3 - current.ideas.length} 个方向</button></>}</div>}
    {current?.validation && (current.validation.rejected.length > 0 || current.validation.warnings.length > 0) && <details><summary>校验详情与创意建议</summary><p>自动修复 {current.validation.repairs} 次。创意建议不阻断使用。</p>{current.validation.rejected.map(r => <p key={r.index}>未采用方向：{r.issues.join('；')}</p>)}{current.validation.warnings.map((w,i) => <p key={i}>{w}</p>)}</details>}
    {current && <>
      <p className={styles.muted}>当前记录：{current.context.plan.title} · {current.context.language} · {current.context.duration} 秒。批量生成使用本轮保存的语言和剧情设置。{current.contextKey !== contextKey ? '上方设置已变化，生成新方向会另存一轮记录。' : ''}</p>
      <div className={styles.batchBar}>
        <button disabled={!!busy || !characterPack.characters.length || characterPack.anchorKey !== characterAnchorKey(current.context.plan)} onClick={regenerateWithCharacters}>按当前角色包另存并重生成脚本</button>
        <label className={styles.mixed}><input type="checkbox" checked={selectedIndexes.length === current.ideas.length} onChange={e => store.updateRecord(current.id, r => ({ ...r, selected: e.target.checked ? r.ideas.map((_, i) => i) : [] }))} />全选方案</label>
        <span>已选 {selectedIndexes.length} 项 · 已有 {Object.keys(current.scripts).length} 个脚本</span>
        <button className={styles.primary} disabled={!!busy || !missingIndexes.length} onClick={() => generateBatch(missingIndexes)}>批量生成缺少的脚本（{missingIndexes.length}）</button>
        <button disabled={!!busy || !selectedIndexes.length} onClick={() => generateBatch(selectedIndexes)}>重新生成所选（{selectedIndexes.length}）</button>
        {retryIndexes.length > 0 && <button disabled={!!busy} onClick={() => generateBatch(retryIndexes)}>重试未完成（{retryIndexes.length}）</button>}
      </div>
      {workspace.batchRecordId && <p className={styles.muted} role="status">正在批量生成，最多同时处理 2 个方案。切换站内页面后仍会继续；已完成结果即时保存。<button onClick={() => store.cancelBatch()}>取消批量生成</button></p>}
      <div className={styles.grid}>{current.ideas.map((idea,i) => {
        const job = current.jobs[i];
        const status = job ? ({ queued: '等待生成', running: '生成中…', complete: '脚本已保存', failed: '生成失败，可重试', cancelled: '已取消，可重试', interrupted: '生成中断，可重试' }[job.state]) : current.scripts[i] ? '脚本已保存' : '尚未生成';
        return <article key={i} className={`${styles.card} ${selectedIndexes.includes(i) ? styles.selected : ''}`}>
          <label className={styles.mixed}><input type="checkbox" checked={selectedIndexes.includes(i)} onChange={() => toggleSelected(i)} />方案 {i+1}<span className={styles.badge} role="status">{status}</span></label>
          <span className={styles.eyebrow}>{idea.direction}</span><h3>{idea.title}</h3>
          <div className={styles.storyText}>{idea.story || [...new Set([idea.opening, idea.escalation, idea.turn, idea.cliffhanger, idea.bodyConnection].filter(Boolean))].join('\n\n')}</div>
          {idea.dialogue?.map((d,j) => <p key={j}>{d.speaker}：「{d.text}」{d.subtitle && <small>（字幕：{d.subtitle}）</small>}</p>)}
          {job?.error && <p className={styles.warning}>{job.error}</p>}
          <div className={styles.cardActions}>{current.scripts[i] && <button aria-pressed={selected === i} onClick={() => showScript(i)}>查看已保存脚本</button>}<button disabled={!!busy} onClick={() => generateBatch([i])}>{current.scripts[i] ? '重新生成此方案' : '生成此方案'}</button></div>
        </article>;
      })}</div>
      {!!Object.keys(current.scripts).length && <div className={styles.scriptTabs} aria-label="已生成脚本">{current.ideas.map((idea,i) => current.scripts[i] && <button key={i} aria-pressed={selected === i} className={selected === i ? styles.selected : ''} onClick={() => showScript(i)}>方案 {i+1} · {idea.title}</button>)}</div>}
    </>}
    {script && current && <div className={styles.output}><div className={styles.header}><h3>制作脚本 · {current.ideas[selected].title}</h3><div className={styles.actions}><button onClick={() => void copy(formatPreRollScript(script,current.context))}>复制完整提示词</button><button onClick={download}>下载脚本与依据</button></div></div><pre className={styles.script}>{formatPreRollScript(script,current.context)}</pre><h4>与正片的接点</h4><p>{script.handoff}</p><h4>生成前准备参考素材</h4><ul>{script.referenceChecklist.map((item,i) => <li key={i}>{item}</li>)}</ul><details><summary>逐镜复制（时间归零，保留人物与场景约束）</summary>{script.shots.map((shot,i) => <div key={i}><p>{preRollTime(shot.start)}–{preRollTime(shot.end)} · {formatShotNarrative(shot)}</p><button onClick={() => void copy(formatPreRollScript(script,current.context,i))}>复制第 {i+1} 镜</button></div>)}</details><p className={styles.muted}>{workspace.saveError ? '自动保存未成功，请下载备份。' : '脚本已自动保存在当前浏览器，返回页面或刷新后可从历史记录继续查看。'}此处输出提示词，不会自动提交视频生成任务。</p></div>}
    {script && current && <div className={styles.output}>
      <h4>此脚本绑定的角色参考包</h4>
      <p>{current.context.characterPack?.characters.map(c => `${c.name}（${c.references.length} 张图）`).join('、') || '该历史脚本尚未绑定角色参考包。可在上方补充角色，再按当前角色包另存并重生成。'}</p>
      {characterReadiness(current.context.characterPack).map((issue, i) => <p className={styles.warning} key={i}>{issue}</p>)}
      <button disabled={!current.context.characterPack?.characters.length} onClick={() => void downloadReferences()}>下载角色图片与分镜绑定包 ZIP</button>
      <p className={styles.muted}>包含实际图片、角色卡、逐镜人物状态和每镜提示词。将图片上传到视频模型并对应绑定角色；尚未执行视频生成或生成后的视觉核对。</p>
    </div>}
  </section>;
}
