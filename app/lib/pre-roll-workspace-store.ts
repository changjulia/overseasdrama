import { validatePreRollContext, validatePreRollIdea, validatePreRollScript, type PreRollContext, type PreRollIdea, type PreRollScript } from './pre-roll-script';
import { validateCharacterPack, type PreRollCharacterPack } from './pre-roll-characters';

export type ScriptJob = { state: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted'; error?: string };
export type PreRollRecord = {
  id: string; createdAt: string; updatedAt: string; contextKey: string; context: PreRollContext;
  ideas: PreRollIdea[]; scripts: Record<number, PreRollScript>; jobs: Record<number, ScriptJob>;
  selected: number[]; active: number;
  validation?: { status: string; repairs: number; rejected: Array<{ index: number; issues: string[] }>; warnings: string[] };
};
export type PreRollDraft = { planId: string; duration: number; dialogueLocale: string; descriptionLocale: string; subtitleLocale: string; allowMixedDialogue: boolean; brief: string; hookPatterns: string[]; characterPacks: Record<string, PreRollCharacterPack> };
export type WorkspaceSnapshot = { version: 1; records: PreRollRecord[]; currentId: string; draft: Partial<PreRollDraft>; saveError: string; savedAt: string; batchRecordId: string };
export const EMPTY_PRE_ROLL_WORKSPACE: WorkspaceSnapshot = { version: 1, records: [], currentId: '', draft: {}, saveError: '', savedAt: '', batchRecordId: '' };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function restorePreRollWorkspace(raw: string | null, drama: string): WorkspaceSnapshot {
  if (!raw) return { ...EMPTY_PRE_ROLL_WORKSPACE };
  const data = JSON.parse(raw);
  if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('缓存版本或结构不兼容');
  const records: PreRollRecord[] = data.records.map((record: PreRollRecord) => {
    const context = validatePreRollContext(record.context);
    if (context.drama !== drama || typeof record.id !== 'string' || !record.id || !Array.isArray(record.ideas) || !record.ideas.length || record.ideas.length > 3) throw new Error('缓存记录无效');
    const ideas = record.ideas.map(idea => validatePreRollIdea(idea, context.plan.segments.length));
    const scripts: Record<number, PreRollScript> = {};
    for (const [index, script] of Object.entries(record.scripts || {})) {
      if (!Number.isInteger(Number(index)) || !ideas[Number(index)]) throw new Error('缓存脚本索引无效');
      scripts[Number(index)] = validatePreRollScript(script, context.duration, '', false, { characterPack: context.characterPack });
    }
    const jobs: Record<number, ScriptJob> = {};
    for (const [index, job] of Object.entries(record.jobs || {})) {
      if (!ideas[Number(index)]) continue;
      jobs[Number(index)] = ['queued', 'running'].includes(job.state)
        ? { state: 'interrupted', error: '页面刷新或浏览器关闭，生成已中断，可重试。' }
        : ['complete', 'failed', 'cancelled', 'interrupted'].includes(job.state) ? job : { state: 'interrupted' };
    }
    return { ...record, context, ideas, scripts, jobs, selected: Array.isArray(record.selected) ? [...new Set(record.selected.filter(i => Number.isInteger(i) && ideas[i]))] : [0], active: ideas[record.active] ? record.active : 0 };
  });
  const d = data.draft || {};
  const draft: Partial<PreRollDraft> = {};
  for (const k of ['planId', 'dialogueLocale', 'descriptionLocale', 'subtitleLocale', 'brief'] as const) if (typeof d[k] === 'string') draft[k] = d[k];
  if ([10, 15, 20, 30].includes(d.duration)) draft.duration = d.duration;
  if (typeof d.allowMixedDialogue === 'boolean') draft.allowMixedDialogue = d.allowMixedDialogue;
  if (Array.isArray(d.hookPatterns)) draft.hookPatterns = d.hookPatterns.filter((v: unknown) => typeof v === 'string');
  if (d.characterPacks && typeof d.characterPacks === 'object' && !Array.isArray(d.characterPacks)) {
    draft.characterPacks = {};
    for (const [key, pack] of Object.entries(d.characterPacks)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      // In-progress edits (e.g. an empty name) must not discard completed history.
      try { draft.characterPacks[key] = validateCharacterPack(pack); } catch { /* Reload only valid character drafts. */ }
    }
  }
  return { ...EMPTY_PRE_ROLL_WORKSPACE, records, draft, currentId: records.some(r => r.id === data.currentId) ? data.currentId : records[0]?.id || '', savedAt: typeof data.savedAt === 'string' ? data.savedAt : '' };
}

/** Lives outside React so navigation never loses completed work or cancels a batch. */
export class PreRollWorkspaceStore {
  private snapshot: WorkspaceSnapshot = { ...EMPTY_PRE_ROLL_WORKSPACE };
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private key: string;
  constructor(drama: string, private storage?: Storage) {
    this.key = `lumina.pre-roll.workspace.v1:${encodeURIComponent(drama)}`;
    try { this.snapshot = restorePreRollWorkspace(storage?.getItem(this.key) || null, drama); }
    catch { this.snapshot = { ...EMPTY_PRE_ROLL_WORKSPACE, saveError: '浏览器记录无法读取。新结果仍可下载保存。' }; }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private commit(next: WorkspaceSnapshot) {
    const savedAt = new Date().toISOString();
    this.snapshot = { ...next, savedAt, saveError: '' };
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      this.storage.setItem(this.key, JSON.stringify(this.snapshot));
    } catch { this.snapshot = { ...this.snapshot, savedAt: next.savedAt, saveError: '浏览器自动保存失败（空间不足或存储被禁用），请下载脚本备份。' }; }
    this.listeners.forEach(l => l());
  }
  patchDraft(patch: Partial<PreRollDraft>) { this.commit({ ...this.snapshot, draft: { ...this.snapshot.draft, ...patch } }); }
  selectRecord(id: string) { if (this.snapshot.records.some(r => r.id === id)) this.commit({ ...this.snapshot, currentId: id }); }
  updateRecord(id: string, update: (record: PreRollRecord) => PreRollRecord) {
    this.commit({ ...this.snapshot, records: this.snapshot.records.map(r => r.id === id ? { ...update(r), updatedAt: new Date().toISOString() } : r) });
  }
  addRecord(context: PreRollContext, ideas: PreRollIdea[], validation?: PreRollRecord['validation']) {
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const record: PreRollRecord = { id, createdAt: now, updatedAt: now, context, contextKey: JSON.stringify(context), ideas, scripts: {}, jobs: {}, selected: ideas.map((_, i) => i), active: 0, validation };
    this.commit({ ...this.snapshot, records: [record, ...this.snapshot.records], currentId: id });
    return id;
  }
  cancelBatch() { this.controller?.abort(); }
  async generateScripts(id: string, indexes: number[], request: typeof fetch = fetch) {
    if (this.controller) return;
    const record = this.snapshot.records.find(r => r.id === id);
    if (!record) return;
    const queue = [...new Set(indexes)].filter(i => Number.isInteger(i) && record.ideas[i]);
    if (!queue.length) return;
    const controller = new AbortController(); this.controller = controller;
    this.commit({ ...this.snapshot, batchRecordId: id });
    this.updateRecord(id, r => ({ ...r, jobs: { ...r.jobs, ...Object.fromEntries(queue.map(i => [i, { state: 'queued' }])) } }));
    const job = (index: number, value: ScriptJob) => this.updateRecord(id, r => ({ ...r, jobs: { ...r.jobs, [index]: value } }));
    const worker = async () => {
      while (queue.length) {
        const index = queue.shift()!;
        if (controller.signal.aborted) { job(index, { state: 'cancelled' }); continue; }
        job(index, { state: 'running' });
        try {
          const response = await request('/api/pre-roll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'script', context: record.context, idea: record.ideas[index] }), signal: controller.signal });
          const data = await response.json();
          if (!response.ok) throw new Error(data.message || '脚本生成失败');
          controller.signal.throwIfAborted();
          const script = validatePreRollScript(data.script, record.context.duration, record.context.language, false, record.context);
          this.updateRecord(id, r => ({ ...r, scripts: { ...r.scripts, [index]: script }, jobs: { ...r.jobs, [index]: { state: 'complete' } } }));
        } catch (error) { job(index, controller.signal.aborted ? { state: 'cancelled' } : { state: 'failed', error: error instanceof Error ? error.message : '生成失败，请重试' }); }
      }
    };
    try { await Promise.all([worker(), worker()]); }
    finally { this.controller = null; this.commit({ ...this.snapshot, batchRecordId: '' }); }
  }
}

const stores = new Map<string, PreRollWorkspaceStore>();
export function getPreRollWorkspaceStore(drama: string) {
  if (typeof window === 'undefined') return new PreRollWorkspaceStore(drama);
  let store = stores.get(drama);
  if (!store) {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* The visible save status explains unavailable storage. */ }
    store = new PreRollWorkspaceStore(drama, storage); stores.set(drama, store);
  }
  return store;
}
