import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { emptyCharacterState, characterAnchorKey, validateCharacterPack, validateCharacterBindings } from '../app/lib/pre-roll-characters.ts';
import { validatePreRollContext, validatePreRollScript, formatPreRollScript } from '../app/lib/pre-roll-script.ts';
import { createCharacterReferenceZip, buildCharacterManifest, cropBounds } from '../app/lib/pre-roll-reference-assets.ts';
import { PreRollWorkspaceStore, restorePreRollWorkspace } from '../app/lib/pre-roll-workspace-store.ts';

const state = { ...emptyCharacterState(), costume: '红裙', props: '手机', condition: '无伤', emotion: '警惕', position: '门口', knowledge: '尚不知道背叛' };
const plan = { id: 'p1', title: '门外的证人', storylineSummary: '女主被误解，等待证人。', segments: [{ episode: 2, start: 10, end: 30, plot: '女主站在门口，手机握在手里。', highlightAssetId: 'h1', analysisVersion: 'v1' }] };
const character = { id: 'female1', name: '林雨', aliases: ['女主'], origin: 'body', identity: '妻子', relationships: '丈夫为周远', appearance: '黑色长发', voice: '低柔女声', entryState: state, references: [{ id: 'face1', fileName: 'face1.jpg', source: 'episode', episode: 2, seconds: 10, view: 'front', note: '正片女主' }] };
const pack = { version: 1, anchorKey: characterAnchorKey(plan), characters: [character] };
const context = { drama: '测试剧', plan, characterPack: pack, duration: 10, language: '英语', ratio: '9:16', brief: '' };
const bound = { characterId: 'female1', startState: state, endState: state, transition: '' };
const script = { style: '写实', scene: '门口', mood: '紧张', characters: '林雨', continuity: '服装与物品衔接', handoff: '脚步声接入正片', referenceChecklist: ['女主参考图'], shots: [{ start: 0, end: 5, narrative: '女主抬眼望向门边。', dialogue: [{ speaker: '女主', text: 'Who is there?' }], characterStates: [bound] }, { start: 5, end: 10, narrative: '门把手静止，脚步声靠近。', dialogue: [], characterStates: [] }], tags: { conflict: '误解', emotion: '紧张', framing: '近景', camera: '固定', image: '门口', action: '抬眼', voice: '脚步声', sellingPoint: '等待真相' } };
const idea = { title: '门外', direction: '悬念', opening: '抬眼', escalation: '脚步声靠近', cliffhanger: '门把手转动', bodyConnection: '正片继续等待证人', appeal: '等真相', inventedDetails: [], evidenceSegments: [0] };

test('fixed identity survives renaming, but ambiguous aliases and foreign anchors are rejected', () => {
  assert.equal(validateCharacterPack({ ...pack, characters: [{ ...character, name: '林女士' }] }).characters[0].id, 'female1');
  assert.throws(() => validateCharacterPack({ ...pack, characters: [character, { ...character, id: 'female2', name: '另一人', references: [] }] }), /多个角色/);
  assert.throws(() => validatePreRollContext({ ...context, plan: { ...plan, segments: [{ ...plan.segments[0], start: 11 }] } }), /另一条故事线或切入点/);
  assert.throws(() => validateCharacterPack({ ...pack, characters: [{ ...character, references: [{ ...character.references[0], fileName: '../face.jpg' }] }] }), /元数据/);
});

test('shots and speakers cannot silently use another identity', () => {
  assert.deepEqual(validatePreRollScript(script, 10, '英语', false, context), script);
  assert.throws(() => validateCharacterBindings([{ ...script.shots[0], characterStates: [{ ...bound, characterId: 'unknown' }] }], pack), /未知角色/);
  assert.throws(() => validateCharacterBindings([{ ...script.shots[0], characterStates: [] }], pack), /未绑定/);
  assert.throws(() => validateCharacterBindings([{ ...script.shots[0], characterStates: undefined }], pack), /characterStates/);
});

test('unexplained state jumps require a transition; a preceding event can explain a change', () => {
  const second = { ...script.shots[1], characterStates: [{ ...bound, startState: { ...state, costume: '白裙' } }] };
  assert.throws(() => validateCharacterBindings([script.shots[0], second], pack), /状态发生变化/);
  assert.doesNotThrow(() => validateCharacterBindings([script.shots[0], { ...second, characterStates: [{ ...second.characterStates[0], transition: '镜间时间跳跃，换上白裙；镜内再取出红裙换装，接回正片' }] }], pack));
});

test('per-shot prompts keep only bound references and normalize timing', () => {
  const first = formatPreRollScript(script, context, 0), second = formatPreRollScript(script, context, 1);
  assert.match(first, /female1／林雨/); assert.match(first, /references\/face1.jpg/);
  assert.match(first, /尚不知道背叛/); assert.match(first, /\[00:00-00:05\]/);
  assert.doesNotMatch(second, /references\/face1.jpg/);
  const manifest = buildCharacterManifest(script, context);
  assert.equal(manifest.shots[0].references[0].characterId, 'female1');
  assert.equal(manifest.shots[1].references.length, 0);
});

test('download bundle includes the actual image bytes and fails visibly if an image is missing', async () => {
  const bytes = new Uint8Array([255, 216, 255, 217]);
  const zip = await createCharacterReferenceZip(script, context, async () => new Blob([bytes], { type: 'image/jpeg' }));
  const files = unzipSync(zip);
  assert.deepEqual(files['references/face1.jpg'], bytes);
  assert.match(strFromU8(files['shots/01.txt']), /female1／林雨/);
  assert.equal(JSON.parse(strFromU8(files['manifest.json'])).bodyEntry.episode, 2);
  await assert.rejects(() => createCharacterReferenceZip(script, context, async () => undefined), /已丢失/);
});

test('history restores immutable role packs and all per-shot bindings', async () => {
  const items = new Map(); const storage = { getItem: k => items.get(k) || null, setItem: (k, v) => items.set(k, v) };
  const store = new PreRollWorkspaceStore('测试剧', storage);
  const recordId = store.addRecord(context, [idea]);
  await store.generateScripts(recordId, [0], async () => Response.json({ script }));
  store.patchDraft({ characterPacks: { [pack.anchorKey]: { ...pack, characters: [{ ...character, appearance: '修改后的描述' }] } } });
  const restored = new PreRollWorkspaceStore('测试剧', storage).getSnapshot();
  assert.equal(restored.records[0].context.characterPack.characters[0].appearance, '黑色长发');
  assert.equal(restored.records[0].scripts[0].shots[0].characterStates[0].characterId, 'female1');
  assert.equal(restored.draft.characterPacks[pack.anchorKey].characters[0].appearance, '修改后的描述');
  const malformedDraft = { ...restored, draft: { characterPacks: { bad: { version: 1, characters: [{ name: '' }] } } } };
  assert.equal(restorePreRollWorkspace(JSON.stringify(malformedDraft), '测试剧').records.length, 1);
});

test('frame cropping uses actual video dimensions and rejects out-of-frame crops', () => {
  assert.deepEqual(cropBounds({ x: 25, y: 0, width: 50, height: 100 }, 1080, 1920), { x: 270, y: 0, width: 540, height: 1920 });
  assert.throws(() => cropBounds({ x: 70, y: 0, width: 50, height: 100 }, 1080, 1920), /画面内/);
});
