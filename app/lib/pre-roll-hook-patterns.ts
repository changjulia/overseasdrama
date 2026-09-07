/** Creative mechanisms for short-drama acquisition hooks, not episode outlines. */
export const PRE_ROLL_HOOK_PATTERNS = [
  { id: 'sensory-impact', label: '感官冲击', opening: '第一帧动作正在发生：泼洒、撕裂、撞开、急停等可见冲击，配同步短促声音。', turn: '第二拍暴露动作的对象和关系，第三拍让局势更失控。', expectation: '想看这一下将造成什么后果，谁会反击。' },
  { id: 'forbidden-tension', label: '禁忌关系', opening: '成年角色在不该出现的关系位置上，被另一人当场撞见；用站位、保护或称呼揭示越界。', turn: '撞见者同时握有能改变双方处境的权力或亲密关系。', expectation: '想知道这段不能公开的关系如何收场。' },
  { id: 'power-relationship', label: '特殊人物关系', opening: '用可见行为呈现反常关系：敌人护她、雇主向她低头、丈夫求助的人却听她命令。', turn: '原本掌权的人瞬间失去控制，人物关系改变现场局势。', expectation: '想知道为什么这个人拥有特殊地位。' },
  { id: 'violent-impact', label: '暴力冲突', opening: '从冲突动作已经发生的一刻切入：挥下的手被截住、砸向桌面的文件、被撞开的门；不从争吵铺垫开始。', turn: '受压者反制或第三人介入，力量关系立刻变化。', expectation: '想看谁能制止施压者、下一步如何反击。' },
  { id: 'oppression-reversal', label: '欺压反杀', opening: '直接呈现一次具体的不公或羞辱，让观众迅速站在主角一边。', turn: '对方越过底线，主角露出反击筹码。', expectation: '等着看欺压者被打脸或付出代价。' },
  { id: 'identity-contrast', label: '身份反差', opening: '被所有人轻视的人，遭遇一个清晰的身份误判。', turn: '一个动作或权力人物的反应，暴露主角不寻常的分量。', expectation: '想知道主角是谁，以及旁人知道后会如何反应。' },
  { id: 'betrayal-revenge', label: '背叛复仇', opening: '主角当场撞见背叛，观众立即看懂谁辜负了谁。', turn: '背叛者仍以为主角不知情，主角已经开始行动。', expectation: '想看主角如何揭穿或反击背叛者。' },
  { id: 'danger-rescue', label: '危险救援', opening: '危险已经发生，人物要失去的东西具体可见。', turn: '唯一能救人的人被阻拦、误解，或必须作出艰难选择。', expectation: '急着知道能否及时救下，以及谁会出手。' },
  { id: 'relationship-mystery', label: '关系悬念', opening: '最不该保护主角的人，在冲突现场突然出手保护。', turn: '保护行为付出明显代价，或暴露双方不寻常的关系。', expectation: '想知道为什么偏偏护着这个人，两人到底是什么关系。' },
] as const;

export type PreRollHookPatternId = typeof PRE_ROLL_HOOK_PATTERNS[number]['id'];

export function buildAcquisitionHookGuidance(selected: readonly string[] = []): string {
  const patterns = selected.length ? PRE_ROLL_HOOK_PATTERNS.filter(p => selected.includes(p.id)) : PRE_ROLL_HOOK_PATTERNS;
  return `创作目标：强截流短剧买量前贴，不是剧情摘要或慢热预告。受众没有看过本剧，前三秒必须形成感官冲击、关系冲击或迫近的危险。
开场直接让冲突发生，人物关系随行动自然显露，局势随因果推进；不用按秒划分故事。
首三秒总对白最多8个英文单词或12个汉字，允许无对白；一段长嘲讽、背景介绍、低头沉默、缓慢展示信物都不算强钩子。不得先讲多年经历再发生事件。
每个候选必须输出 story 字符串：用一至两段连贯叙事写清谁做了什么、另一人如何应对、局势如何改变，以及最后怎样接入正片。直接讲故事，不写逐秒拆解、设计术语或“观众会想看”等分析。不要输出 firstThreeSeconds。其他结构字段仅供内部校验，不能代替完整故事。
此后每1–3秒新增一个动作或信息，至少一次真实局势变化。escalation 是压力变大，turn 是筹码、关系、目标或力量对比发生改变，两者不得复述同一段。15秒前贴优先6–9镜，避免动作未完成就切走；末镜卡在结果前再接正片。
禁忌关系使用成年角色的社会身份、权力或情感立场冲突，以非露骨的站位和行为表达；暴力冲击靠动作、声音和反应，不靠伤口特写或血腥堆砌。具体机制须与正片关系设定相容。
先确定一句具体的“观众最想看到的下一步”，再反推开场事件、情绪升级、局势转折和接正片的卡点。
首屏直接发生事件，不用剧名、人物履历、空镜或长旁白铺垫；人物关系与眼前利害必须迅速可读。
前贴每一拍都新增压力、信息或筹码，至少一次局势变化，避免重复争吵。卡在结果即将发生的位置，让正片继续推进观众期待。
围绕与正片相容的机制，主动向前续写新的前因、冲突与行动；无需原片已经拍过这些事件。新增设定写入 inventedDetails，结尾自然导向正片开场，不篡改已确定的身份或关系。
候选机制：\n${patterns.map(p => `${p.id}（${p.label}）：${p.opening} → ${p.turn} → ${p.expectation}`).join('\n')}
${selected.length ? '优先覆盖用户选择的机制。只选择一种时，生成三种不同首屏事件或信息揭露方式的版本；不得只是换台词。' : '优先从感官冲击、禁忌关系、特殊人物关系、暴力冲突中选择适合本剧的开场刺激，再结合其他机制形成三个不同方向，不能为了凑齐标签而篡改剧情。'}
每条候选写明 patternId（上述机制 ID）、viewerExpectation（观众最想看什么）、turn（具体局势变化），并在 appeal 中解释首屏刺激、情绪立场和继续观看的动机，不编造投放分数。`;
}
