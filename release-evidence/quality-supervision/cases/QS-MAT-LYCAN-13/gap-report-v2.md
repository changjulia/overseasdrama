# QS-MAT-LYCAN-13 第二轮独立复测

复测时间：2026-08-31
Golden：沿用冻结 `v1`，SHA `ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d`，未改写。
最新系统快照：`system-snapshot-v2.json`，SHA `4d2371e117adaed0572a65fa2f83891ac71ddb8a61c2ec594b7b38ab6f26ae9b`。

## 三层结论

| 层面 | 结论 | 证据 |
|---|---|---|
| 工程执行 | **通过但有追踪残项** | job/material 均 `succeeded / 100 / completed`，final result 非空；模型、provider、prompt version、processor、Python 和 UI retry lineage 已持久化 |
| 内容质量 | **失败** | 中心反转因果链缺失、无 hook、完整性误判、CTA 被当作 cliffhanger、关键人物关系为空 |
| 硬门禁 | **NO-GO** | 严重故事断裂、虚假完整性、悬空/无效证据仍被成功发布 |

工程成功只证明队列和持久化走到终态，不证明分析内容可用。本轮范围归一分从 22 升至 28，提升主要来自工程成功、来源降级和 T 层级安全化，核心内容能力没有达到上线门槛。

## 最新运行身份

- job：`30wqqaz0u3vav09`
- material：`zmzrljhnwl4uxw5`
- model：`qwen-vl-max`
- provider：`openai-chat-completions`
- prompt：`material-v2-20260830.1`
- retry lineage：`ui_material_retry`，from attempt 0 / queued
- job result：非空，约 74 KB
- quality gate：`review_required / passed=false`
- material hook count：0
- material tier：`TX`

## 逐时间码与因果链复测

| Golden | 最新系统 | 判断 |
|---|---|---|
| 0–3.4s：壮汉命令 Juggernaut 结束女战士 | 捕获 0–2.86s，但 ASR 仍为 `Wreckus brat` | 部分命中，文本未修 |
| 3.4–6.7s：紫衣女子轻蔑死亡预告 | 无人物/观察 | 未命中 |
| 16.1–20.4s：紫衣女子点名 Killian the Juggernaut / Shadow Pack 冠军 | OCR 在 17.5s 读到 Killian the Juggernaut，但 fact-004 悬空，identity 为 unverified | 部分命中，证据链不完整 |
| 18–21.5s：Killian 跪地说 At your command | 未进入 observations/summary/characters/relationships | 未命中，核心动作丢失 |
| 21.5–25.2s：多名旁观者震惊，完成权力反转 | 未进入故事模型 | 未命中，因果结果丢失 |
| 24.48s 后 CTA、29s 后应用尾卡 | CTA 被识别，但 24.48–26.56s 被错误标成 verified cliffhanger/highlight | 标签错误 |
| 最强可制作高光 15.1–23.5s | hooks=[]、entryPoints=[]；仅把 0–2.86s 当情感高峰 | 未命中 |
| 故事停在 Killian 应命后的未完成动作 | `complete / 0.95 / verified`，摘要只有开场一句 | 严重错误，硬门禁 |

## 上轮 9 项缺陷复测

| 缺陷 | 状态 | 摘要 |
|---|---|---|
| P0-001 job 永久失败 | **已修复** | succeeded/100/completed，final result 非空 |
| P0-002 失败中间态污染 | **部分修复/未完全可复测** | 当前成功态正确，TX 已覆盖 T1；但无新失败注入证明原子性，格式仍弱证据投影 |
| P0-003 同剧外搭幻觉 | **已修复，有残项** | 来源未知/unverified/需复核；root attribution 仍写 not_required |
| P0-004 关键身份错误 | **部分修复** | 精确 OCR 与安全降级已有；关键人物/动作/反应链仍空 |
| P0-005 虚假完整＋无 hook | **未修复** | complete 0.95；hooks=0；CTA 被当 cliffhanger |
| P1-001 悬空/零时长证据 | **未修复** | fact-004/005/006 悬空；多个 start=end；仍成功发布 |
| P1-002 T1/格式证据错误 | **部分修复** | T1→TX 已修；正片剧集拼接仍用泛化证据 verified |
| P1-003 运行追踪缺失 | **大部修复** | 模型/prompt/retry 已持久化；历史 failed predecessor 仍不可追 |
| P2-001 质量门原因语义 | **未修复** | 正向陈述仍混在失败原因，且与实际证据缺陷冲突 |

## 新增/提升缺陷

### P0 — 降级结果以 100 置信度发布

系统明确记录“模型摘要契约不完整，已重建”，且 characters、hooks、scores 为空、quality gate=false，却把 `materialFields.confidence` 写为 100 并标 `analysisStatus=succeeded`。这会让下游把结构完整性失败误读为高质量结论。

开发项：修订 `processor/semantic_analysis.py` 的 fallback 置信度聚合和 materialFields 发布条件；置信度必须同时受事实覆盖、关键字段完整度与 quality gate 约束。增加本 case 回归：只剩一条 ASR 摘要时 confidence 不得高于人工复核阈值，且不得进入生产可用态。

### P1 — CTA 被当成剧情 cliffhanger

系统将 24.48–26.56s 的下载引导标成 verified cliffhanger/highlight，同时遗漏真正未完成的 Killian 命令链。

开发项：时间线分类先识别 CTA/品牌尾卡并从剧情高光候选剔除；同案断言 CTA 只能进入 packaging/CTA，15.1–23.5s 才是核心高光。

## 评分

| 维度 | v1 | v2 | 结论 |
|---|---:|---:|---|
| 事实/证据准确性 | 30 | 45 | 来源和身份降级更安全，但主要事实仍缺失 |
| 高光定位 | 0 | 5 | 有时间线但无 hook，且 CTA 错标 |
| 钩子留人 | 45 | 25 | 新结果没有可执行钩子/质量分/承诺链 |
| 故事完整性 | 15 | 10 | 仍虚假标完整，摘要进一步退化 |
| 匹配 | N/A | N/A | 尚未进入正片配对 |
| 转场/解说 | N/A | N/A | 尚未生成正式 production object |
| 工程可靠性 | 0 | 70 | 终态与追踪显著修复，但失败历史和质量发布门仍不足 |
| 范围归一 | 22 | 28 | 仍为 NO-GO |

## 下一轮可执行开发与回归顺序

1. **P0 内容完整性门**：`complete` 必须要求核心未完成动作已解决；CTA 不能证明故事完整。用本 case 断言 `incomplete/cliffhanger`。
2. **P0 hook 定位**：融合 OCR、ASR、frames、shots，在 15.1–23.5s 产出边界可复核的反转 hook；安全结束必须早于 CTA。
3. **P0 fallback 发布门**：qualityGate=false、关键字段为空时不得输出 confidence=100 或进入生产可用态。
4. **P1 证据引用完整性**：final validator 拒绝悬空 fact ID；point frame 与 duration range 分 schema 表达。
5. **P1 实体/因果融合**：一个 Killian the Juggernaut 实体；紫衣女子点名→跪地应命→观众震惊构成可追溯因果。
6. **P1 format/source 一致性**：来源未知时 root attribution 同步为 pending；无拼接边界证据时 format 不得 verified。
7. **P1 retry 审计**：保留 immutable predecessor job/error，而不是只在重用记录里写 queued→retry。
8. **P2 质量门文案**：把正向审计声明与 failure reasons 分开；每条失败原因必须指向字段和可执行动作。

修复后继续使用同一 frozen golden v1 和同一输入 SHA，新增 comparison-v3/retest，不覆盖历史。
