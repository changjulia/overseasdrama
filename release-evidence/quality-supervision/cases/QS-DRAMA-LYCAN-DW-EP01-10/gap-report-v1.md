# QS-DRAMA-LYCAN-DW-EP01-10 首轮独立差距报告

Golden v1 SHA `4f36c1df4593442974ac25ee9a3cec64ac10cff537894035eee1633389c96872` 在系统分析前已冻结且未修改。正式系统快照 SHA 为 `015e34fd51e1635176370063a0738d9f27a15a9d705115627dad366609272634`。

## 结论

| 层面 | 结论 |
|---|---|
| 工程执行 | **PASS**：10/10 coarse succeeded；detail job `vlpc5yoodbf1d43` attempt=3 succeeded，qwen-vl-max |
| Precision 安全 | **PASS**：16/16 candidates 均 `precisionEligible=false`，系统没有创建 precision job |
| 剧情事实与关系 | **FAIL**：存在母女/母子误判、否定语义反转、畸形 ASR 生成实体和血缘关系 |
| 高光质量 | **FAIL**：16 条均不可进入 precision；Golden Top3 没有一条可直接制作 |
| 总体 | **NO-GO**：范围归一 48/100 |

## EP2 无音轨专项

EP2 的 coarse engine 正确记录 `asr.status=no_audio`，detail 中没有任何 transcript evidence，因此系统**没有伪造字面对白字段**。

但它发生了严重的画面语义幻觉：

- 把 Amelia 与婴儿标成母子关系；
- 称 Amelia “揭示神秘预言”；
- 把男子标成守护者、把静态同框写成“团聚并共同保护婴儿”；
- 从单帧推断恐惧、低吼、保护欲、威胁意图；
- 将这些推断写入 verified summary/characters/relationship，而不是 pending。

Golden 只允许确认雪林、狼、伤倒、人物到场、Amelia/High Priestess 名卡、符文/狼形意象与室内转场。无音轨时，预言、亲属、意图、情绪和对白均不可验证。

## 关键硬错误

1. **EP3 母女关系错误**：系统称 Elena 是 Cora 的母亲；引用的原句实际是“我的侍女怀了我丈夫的私生子”，与母女结论相矛盾。
2. **EP9 否定反转**：系统把 `No. Not Tiffany.` 写成“Alpha 怀疑 Tiffany、信任动摇”；原句明确排除 Tiffany。
3. **EP4 血缘误判**：畸形 ASR `She's his mother. Killen hadn't...` 被提升为 Arya 是 Killen 母亲/其子关系，Golden 无此证据。
4. **EP5 实体污染**：`Orph's even mine`、`Is my wolf?` 等错误 ASR 生成“奥尔芙”人物、非凡血脉和身份困惑剧情。

严重事实错误已经明显超过暂定 ≤2% 门槛。

## 人物与跨集连续性

系统输出 34 个 characters，但存在明显类型和身份污染：

- 可能连续的主角被拆成 Arya、Orph、Rogue、girl 等多个实体；
- Father、mother、princess、Alpha 等泛角色跨集复用，缺少稳定来源；
- Moonstone、Iron Fang Pact 等物件/组织被计入人物；
- EP2 的 guardian、threat、mother 等角色由单帧姿态直接推断。

因此 characters=34 不能解释为人物分析完整，反而说明实体消歧和类型约束不足。

## Golden Top3 对照

| Golden 高光 | 系统候选 | 结论 |
|---|---|---|
| EP4 27–54s 蛇形生物→光狼攻击→接住婴儿 | 无对应候选 | 漏检 |
| EP7 41.7–57.2s 鞭击攻防 | 系统 EP7 0–41.54s 在动作开始前结束 | 漏检/错边界 |
| EP8 75.5–80.784s 月石内部裂纹增强 | 系统宽段 17.62–77.62s 仅部分覆盖且截断结尾 | 不可制作 |

全部 16 条系统高光 `reviewRequired=true`、`precisionEligible=false`，没有 production-usable candidate，也没有 precision job。安全阻断正确，但 Top3 可用率是 **0%**，未达到 ≥90% 门槛。

## 分集判断

| 集 | 判断 | 主要差距 |
|---:|---|---|
| 1 | 部分命中 | 仪式/婴儿视觉一致；亲属、权威和动机主要依赖未在盲标中验证的 ASR |
| 2 | 失败 | 无字面对白幻觉，但画面被过度推断为预言、母子、守护和团聚 |
| 3 | 失败 | 悬崖冲突一致；Elena–Cora 母女关系错误 |
| 4 | 部分失败 | 漏掉蛇形生物/婴儿救援 Top 高光；Arya–Killen 血缘无可靠证据 |
| 5 | 部分失败 | 项链/寻亲方向可用；畸形 ASR 生成错误实体/血脉剧情 |
| 6 | 部分命中 | 森林冲突与杀令一致；非 diarized ASR 仍不能证明人物身份 |
| 7 | 部分命中 | 地点连续；`heiress` 被转成 `heirless`，漏掉鞭击高光 |
| 8 | 部分命中 | 点名/回应和月石相关内容存在；母亲台词说话人仍未验证，结尾高光被截断 |
| 9 | 失败 | 月石裂纹与战争一致；Tiffany 否定语义被反向解释 |
| 10 | 部分命中 | 集会、物件交接和寻亲一致；说话人/亲属仍需人工验证 |

## 开发项

1. **P0 关系与否定校验**：每条关系/因果必须被引文蕴含；增加 negation polarity 和结论—证据矛盾检查。
2. **P0 无音轨策略**：`no_audio` 时只能消费可观察 frame/OCR；亲属、预言、意图、情绪和保护/威胁角色全部拒绝或待审核。
3. **P0 高光召回与边界**：针对 Golden Top3 重新生成动作感知候选，并补 shot/action/audio 边界；没有边界不得称可用。
4. **P1 ASR 与实体消歧**：畸形 ASR 不得产出 verified 人物/血缘；物件、组织、泛角色与人物分型；跨集实体需证据链接。
5. **P1 Precision 生命周期**：0 eligible + 0 jobs 应显示 `no_eligible_candidates/needs_review`，不能仅标 succeeded；drama production gate 应非空并 blocked。

系统输出数量达标不代表内容达标。本轮应准确表述为：**工程链路完成，安全门生效，内容质量与高光可制作性未通过。**
