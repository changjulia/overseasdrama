import type { SelectedRangeStoryUnderstanding } from './hook-match-store';

export type CharacterState = { costume: string; props: string; condition: string; emotion: string; position: string; knowledge: string };
export const CHARACTER_STATE_FIELDS = [['costume', '服装'], ['props', '持有物品'], ['condition', '身体状态／伤势'], ['emotion', '情绪'], ['position', '位置／朝向'], ['knowledge', '已知信息']] as const;
export const emptyCharacterState = (): CharacterState => ({ costume: '', props: '', condition: '', emotion: '', position: '', knowledge: '' });
export type CharacterReference = { id: string; fileName: string; view: 'front' | 'side' | 'full' | 'entry'; source: 'episode' | 'upload'; episode?: number; seconds?: number; note: string };
export type PreRollCharacter = { id: string; name: string; aliases: string[]; origin: 'body' | 'original'; identity: string; relationships: string; appearance: string; voice: string; entryState: CharacterState; references: CharacterReference[] };
export type PreRollCharacterPack = { version: 1; anchorKey: string; characters: PreRollCharacter[] };
export type ShotCharacterState = { characterId: string; startState: CharacterState; endState: CharacterState; transition: string };
export function characterAnchorKey(plan: { id: string; segments: Array<{ episode: number; start: number; analysisVersion?: string }> }) {
  const first = plan.segments[0];
  return `${plan.id}|${first?.episode ?? ''}|${first?.start ?? ''}|${first?.analysisVersion || ''}`;
}

export function seedCharacterPack(understanding: SelectedRangeStoryUnderstanding | null | undefined, anchorKey: string): PreRollCharacterPack {
  return { version: 1, anchorKey, characters: (understanding?.canonicalCharacters || []).slice(0, 12).map((c, i) => ({
    id: /^[a-zA-Z0-9_-]{1,80}$/.test(c.id) ? c.id : `cast-${i + 1}`,
    name: c.canonicalName, aliases: c.aliases || [], origin: 'body', identity: c.roles.join('、'),
    relationships: '', appearance: '', voice: '', entryState: emptyCharacterState(), references: [],
  })) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人物一致性数据格式无效');
  return value as Record<string, unknown>;
}
function valueText(value: unknown, max = 1500) {
  if (typeof value !== 'string' || value.length > max) throw new Error('人物描述缺失或过长');
  return value.trim();
}
function id(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('角色或参考素材标识无效');
  return value;
}
export function validateCharacterState(value: unknown): CharacterState {
  const v = object(value);
  return Object.fromEntries(CHARACTER_STATE_FIELDS.map(([key]) => [key, valueText(v[key])])) as CharacterState;
}
export function validateCharacterPack(value: unknown): PreRollCharacterPack {
  const p = object(value);
  if (p.version !== 1 || !Array.isArray(p.characters) || p.characters.length > 12) throw new Error('角色参考包最多包含 12 位人物');
  const referenceIds = new Set<string>();
  const characters = p.characters.map(raw => {
    const c = object(raw);
    if (!['body', 'original'].includes(String(c.origin)) || !Array.isArray(c.aliases) || c.aliases.length > 15 || !Array.isArray(c.references) || c.references.length > 6) throw new Error('角色别称或参考图设置无效');
    const references = c.references.map(rawRef => {
      const r = object(rawRef), refId = id(r.id);
      if (referenceIds.has(refId)) throw new Error('参考图标识重复');
      referenceIds.add(refId);
      if (r.fileName !== `${refId}.jpg` || !['front', 'side', 'full', 'entry'].includes(String(r.view)) || !['episode', 'upload'].includes(String(r.source))) throw new Error('参考图元数据无效');
      if (r.source === 'episode' && (!Number.isInteger(r.episode) || Number(r.episode) < 1 || !Number.isFinite(r.seconds) || Number(r.seconds) < 0)) throw new Error('截图缺少有效原片时间');
      return { id: refId, fileName: `${refId}.jpg`, view: r.view, source: r.source, ...(r.source === 'episode' ? { episode: Number(r.episode), seconds: Number(r.seconds) } : {}), note: valueText(r.note) } as CharacterReference;
    });
    const name = valueText(c.name, 100);
    if (!name) throw new Error('请填写人物姓名或称呼');
    return { id: id(c.id), name, aliases: c.aliases.map(a => valueText(a, 100)).filter(Boolean), origin: c.origin, identity: valueText(c.identity), relationships: valueText(c.relationships), appearance: valueText(c.appearance), voice: valueText(c.voice), entryState: validateCharacterState(c.entryState), references } as PreRollCharacter;
  });
  if (new Set(characters.map(c => c.id)).size !== characters.length) throw new Error('角色 ID 重复');
  const owners = new Map<string, string>();
  for (const c of characters) for (const name of [c.name, ...c.aliases]) {
    const normalized = name.trim().toLowerCase();
    if (owners.has(normalized) && owners.get(normalized) !== c.id) throw new Error(`人物称呼「${name}」指向多个角色，请区分`);
    owners.set(normalized, c.id);
  }
  return { version: 1, anchorKey: valueText(p.anchorKey, 500), characters };
}

export function validateShotCharacters(value: unknown, pack?: PreRollCharacterPack): ShotCharacterState[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('每个分镜须提供 characterStates 数组；空镜使用 []');
  const result = value.map(item => {
    const s = object(item), characterId = id(s.characterId);
    if (pack && !pack.characters.some(c => c.id === characterId)) throw new Error(`分镜引用了未知角色 ${characterId}，请使用角色卡 ID`);
    return { characterId, startState: validateCharacterState(s.startState), endState: validateCharacterState(s.endState), transition: valueText(s.transition) };
  });
  if (new Set(result.map(s => s.characterId)).size !== result.length) throw new Error('同一分镜不能重复绑定同一角色');
  return result;
}

type CharacterShot = { characterStates?: ShotCharacterState[]; dialogue?: Array<{ speaker: string }>; start: number; end: number };
export function validateCharacterBindings(shots: CharacterShot[], pack: PreRollCharacterPack) {
  const last = new Map<string, CharacterState>();
  for (const [i, shot] of shots.entries()) {
    const states = validateShotCharacters(shot.characterStates, pack);
    for (const line of shot.dialogue || []) {
      const speaker = line.speaker.trim().toLowerCase();
      const c = pack.characters.find(c => [c.id, c.name, ...c.aliases].some(n => n.toLowerCase() === speaker));
      if (!c || !states.some(s => s.characterId === c.id)) throw new Error(`第 ${i + 1} 镜说话人物「${line.speaker}」未绑定角色卡（画外音也需绑定）`);
    }
    for (const s of states) {
      const previous = last.get(s.characterId);
      if (previous && CHARACTER_STATE_FIELDS.some(([key]) => previous[key] && s.startState[key] && previous[key] !== s.startState[key]) && !s.transition.trim()) throw new Error(`第 ${i + 1} 镜人物 ${s.characterId} 状态发生变化，请在 transition 交代中间行动或时间变化`);
      last.set(s.characterId, s.endState);
    }
  }
}

export const characterStateText = (state: CharacterState) => CHARACTER_STATE_FIELDS.map(([key, label]) => `${label}：${state[key] || '待确认'}`).join('；');
export function characterReadiness(pack?: PreRollCharacterPack): string[] {
  if (!pack?.characters.length) return ['尚未建立角色卡；现有脚本没有固定角色与参考图绑定'];
  return pack.characters.flatMap(c => [
    ...(!c.references.some(r => r.view !== 'entry') ? [`${c.name}：尚未添加人物外观参考图（正脸、侧脸或全身）`] : []),
    ...(!c.appearance ? [`${c.name}：外观描述待填写`] : []),
    ...(c.origin === 'body' && CHARACTER_STATE_FIELDS.some(([key]) => !c.entryState[key]) ? [`${c.name}：正片接点状态仍有待确认项（不适用可填“无”）`] : []),
  ]);
}
export function characterPromptRules(pack?: PreRollCharacterPack): string {
  if (!pack?.characters.length) return '';
  return `人物一致性：输入 characterPack 是本轮固定角色表。使用角色 ID，姓名、别称、身份、关系、外观和声音从角色卡引用，不重新发明主角外貌。新增有身份或台词的人物须先加入角色卡；远景匿名群众可作为背景，不复用主角身份。
每个分镜必须输出 characterStates 数组（空镜 []），每项 {characterId,startState,endState,transition}。两个 state 对象均含 costume,props,condition,emotion,position,knowledge 六个字符串。未知写空字符串，不能把未知推断为事实。包含画外说话角色，dialogue.speaker 使用角色 ID 或角色卡姓名／别称。
每个角色的上一出场末状态与下一出场初状态衔接；发生变化在 transition 写明原因，保持相同状态时沿用完全相同的文字。最后出场的状态要能自然进入角色卡 entryState；同一时空直接相接的衣着、伤势、物品和已知信息须一致，有时间跳跃则在 handoff 明确交代。允许向前续写造成这些变化的事件。
references 是用户绑定的实际参考图片清单，脚本模型此处只读取元数据和用户填写的描述，没有读取图片像素，不声称视觉核验通过。参考文件由程序自动绑定每个角色，不输出新的参考文件名。视觉生成时同一角色始终上传并引用相同人物参考图，entry 图片只用于接点状态。
`;
}

export function characterBindingText(pack: PreRollCharacterPack | undefined, shots: CharacterShot[]): string {
  if (!pack?.characters.length) return '';
  const used = new Set(shots.flatMap(s => (s.characterStates || []).map(c => c.characterId)));
  const characters = pack.characters.filter(c => used.has(c.id));
  return `\n- 固定角色与实际参考文件：\n${characters.map(c => `  ${c.id}／${c.name}（${c.aliases.join('、') || '无别称'}）：${c.identity || '身份待确认'}；关系：${c.relationships || '待确认'}；外观：${c.appearance || '以参考图为准，尚未描述'}；声音：${c.voice || '待确认'}。人物参考：${c.references.filter(r => r.view !== 'entry').map(r => `references/${r.fileName}`).join('、') || '尚未提供'}；接点参考：${c.references.filter(r => r.view === 'entry').map(r => `references/${r.fileName}`).join('、') || '尚未提供'}。`).join('\n')}\n- 逐镜角色状态：\n${shots.map(s => `  ${s.start}–${s.end} 秒：${(s.characterStates || []).map(v => `${v.characterId} 从「${characterStateText(v.startState)}」到「${characterStateText(v.endState)}」${v.transition ? `；衔接说明：${v.transition}` : ''}`).join(' / ') || '空镜'}`).join('\n')}\n- 后续正片人物状态：\n${characters.filter(c => c.origin === 'body').map(c => `  ${c.id}：${characterStateText(c.entryState)}`).join('\n')}\n- 使用要求：将对应参考文件实际上传到视频模型并绑定该角色；本文中的文件名不会自动上传图片。`;
}
