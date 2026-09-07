import test from 'node:test';
import assert from 'node:assert/strict';
import { PreRollWorkspaceStore, restorePreRollWorkspace } from '../app/lib/pre-roll-workspace-store.ts';

const context = { drama: '缓存测试剧', plan: { id: 'plan', title: '门外证人', storylineSummary: '证人将要到场。', segments: [{ episode: 1, start: 0, end: 10, plot: '脚步声在门外停下。', highlightAssetId: 'h1' }] }, duration: 10, language: 'en-US', descriptionLocale: 'zh-CN', subtitleLocale: 'none', ratio: '9:16', brief: '' };
const ideas = [0, 1, 2].map(i => ({ title: `方案${i}`, direction: `方向${i}`, opening: '开门', escalation: '争执', cliffhanger: '门外来人', bodyConnection: '脚步声接正片', appeal: '证人是谁', inventedDetails: [], evidenceSegments: [0], dialogue: [] }));
const script = { style: '写实', scene: '客厅', mood: '紧张', characters: '依参考图', continuity: '保持站位', handoff: '脚步声接正片', referenceChecklist: ['人物参考图'], shots: [{ start: 0, end: 5, narrative: '门把手转动。', dialogue: [] }, { start: 5, end: 10, narrative: '女主看向门口。', dialogue: [] }], tags: Object.fromEntries(['conflict', 'emotion', 'framing', 'camera', 'image', 'action', 'voice', 'sellingPoint'].map(k => [k, '测试'])) };
const storage = () => { const data = new Map(); return { getItem: k => data.get(k) || null, setItem: (k,v) => data.set(k,v), data }; };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('drafts, selections, history and scripts restore after a fresh store is created', async () => {
  const disk = storage(), store = new PreRollWorkspaceStore(context.drama, disk);
  store.patchDraft({ duration: 20, subtitleLocale: 'es-ES', brief: '保留创作要求' });
  const id = store.addRecord(context, ideas);
  store.updateRecord(id, r => ({ ...r, selected: [0,2], active: 2 }));
  await store.generateScripts(id, [0,2], async () => Response.json({ script }));
  const second = store.addRecord({ ...context, duration: 15 }, ideas);
  store.selectRecord(id);
  const restored = new PreRollWorkspaceStore(context.drama, disk).getSnapshot();
  assert.equal(restored.records.length, 2);
  assert.equal(restored.currentId, id);
  assert.equal(restored.draft.brief, '保留创作要求');
  assert.deepEqual(restored.records.find(r => r.id === id).selected, [0,2]);
  assert.deepEqual(restored.records.find(r => r.id === id).scripts[2], script);
  assert.equal(restored.records.find(r => r.id === second).context.duration, 15);
  assert.equal(new PreRollWorkspaceStore('另一部剧', disk).getSnapshot().records.length, 0);
});

test('batch concurrency is bounded and a failed item does not discard successful siblings', async () => {
  const store = new PreRollWorkspaceStore(context.drama, storage()), id = store.addRecord(context, ideas);
  const gates = [defer(), defer(), defer()];
  let active = 0, maxActive = 0, calls = 0;
  const done = store.generateScripts(id, [0,1,2,2], async (_url, init) => {
    const i = Number(JSON.parse(init.body).idea.title.slice(-1));
    calls++; maxActive = Math.max(maxActive, ++active);
    await gates[i].promise; active--;
    return i === 1 ? Response.json({ message: '该方案校验失败' }, { status: 502 }) : Response.json({ script });
  });
  assert.equal(calls, 2);
  gates.forEach(g => g.resolve()); await done;
  const record = store.getSnapshot().records[0];
  assert.equal(maxActive, 2); assert.equal(calls, 3);
  assert.deepEqual(Object.keys(record.scripts), ['0','2']);
  assert.equal(record.jobs[1].state, 'failed');
  assert.match(record.jobs[1].error, /校验失败/);
  assert.equal(store.getSnapshot().batchRecordId, '');
});

test('navigation removes subscribers without cancelling work; pending reload jobs are interrupted', async () => {
  const disk = storage(), store = new PreRollWorkspaceStore(context.drama, disk), id = store.addRecord(context, ideas);
  const gate = defer(); const unsubscribe = store.subscribe(() => {});
  const done = store.generateScripts(id, [0], async () => { await gate.promise; return Response.json({ script }); });
  unsubscribe();
  const reload = new PreRollWorkspaceStore(context.drama, disk).getSnapshot();
  assert.equal(reload.records[0].jobs[0].state, 'interrupted');
  assert.equal(reload.batchRecordId, '');
  gate.resolve(); await done;
  const later = new PreRollWorkspaceStore(context.drama, disk).getSnapshot();
  assert.equal(later.records[0].jobs[0].state, 'complete');
  assert.deepEqual(later.records[0].scripts[0], script);
});

test('cancel keeps previously saved scripts and prevents queued requests', async () => {
  const store = new PreRollWorkspaceStore(context.drama, storage()), id = store.addRecord(context, ideas);
  await store.generateScripts(id, [0], async () => Response.json({ script }));
  let calls = 0;
  const done = store.generateScripts(id, [0,1,2], async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  });
  store.cancelBatch(); await done;
  assert.equal(calls, 2);
  assert.deepEqual(store.getSnapshot().records[0].scripts[0], script);
  assert.ok(Object.values(store.getSnapshot().records[0].jobs).every(j => j.state === 'cancelled'));
});

test('late results stay attached to their original history record', async () => {
  const store = new PreRollWorkspaceStore(context.drama, storage()), first = store.addRecord(context, ideas);
  const gate = defer();
  const done = store.generateScripts(first, [1], async () => { await gate.promise; return Response.json({ script }); });
  const second = store.addRecord(context, ideas);
  gate.resolve(); await done;
  assert.equal(store.getSnapshot().currentId, second);
  assert.deepEqual(store.getSnapshot().records.find(r => r.id === second).scripts, {});
  assert.deepEqual(store.getSnapshot().records.find(r => r.id === first).scripts[1], script);
});

test('storage failure is visible, corrupt caches do not crash, and in-memory results survive', async () => {
  const store = new PreRollWorkspaceStore(context.drama, { getItem: () => '{broken', setItem: () => { throw new Error('quota'); } });
  assert.match(store.getSnapshot().saveError, /无法读取/);
  const id = store.addRecord(context, ideas);
  await store.generateScripts(id, [0], async () => Response.json({ script }));
  assert.match(store.getSnapshot().saveError, /自动保存失败/);
  assert.deepEqual(store.getSnapshot().records[0].scripts[0], script);
  assert.throws(() => restorePreRollWorkspace('{"version":99,"records":[]}', context.drama));
});
