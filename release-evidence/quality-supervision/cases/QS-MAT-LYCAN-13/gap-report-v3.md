# QS-MAT-LYCAN-13 第三轮独立复测

Golden v1 SHA `ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d` 校验通过且未改写。最新系统快照 SHA 为 `d928235e6b6ad4cb4ea96152a453bd080ee62e1e3e7ffa4c7c6e2f2bd2d491f8`。

## 结论

| 层面 | 结论 |
|---|---|
| 工程执行 | **PASS**：job/material succeeded、100%、completed，final result 非空 |
| 内容质量 | **显著改善但未达门槛**：核心 hook 已定位，安全降级生效；完整人物与因果仍不足 |
| 生产安全 | **阻断行为正确**：confidence=49、productionStatus=blocked、qualityGate=false |
| 硬门禁 | **NO-GO**：被拒/悬空事实仍被可消费 segment/transition 引用；完整故事模型仍缺关键关系 |

范围归一分从 v1 的 22、v2 的 28 升至 **66/100**。该提升真实存在，但未达到故事完整度/留人门槛，也不能替代后续匹配和三种成片模式验收。

## 指定修复核验

| 项目 | 结果 | 实际证据 |
|---|---|---|
| CTA 从 cliffhanger/highlight 移除 | **通过** | timeline 只保留 0–2.86s emotional peak；CTA 独立为 29.367–34.504s segment |
| 15.1–23.46s 反转 hook | **通过，待审核** | hook-01/identity_reveal_response，包含身份称号与 `At your command`；boundaryStatus=unverified、reviewRequired=true |
| completeness 降为不完整 | **通过，有文案残项** | code/value/label 为 incomplete/不完整，verification=unverified；但 evidence.text 仍说“完整流程” |
| confidence=49 / production blocked | **通过** | materialFields.confidence=49、productionStatus=blocked，production gate=false |
| root sourceAttribution pending | **通过** | sourceAttribution.status=pending；hookSourceStatus UNKNOWN/unverified |
| 无效事实移入 rejectedClaims | **部分通过** | fact-001、fact-003 observation 与 fact-004 inference 已隔离；但 segments 仍引用 fact-003/004，transitions 仍引用 fact-003/006 |
| 正向声明不混入失败原因 | **通过** | 上轮三条正向声明已删除；原因均为契约/事实/来源/完整性缺陷 |

## 逐时间码/因果链

| Golden | v3 实际 | 判断 |
|---|---|---|
| 0–3.4s 处决命令 | 0–2.86s 命令仍在，ASR 仍为 Wreckus | 部分命中 |
| 3.4–6.7s 紫衣女子死亡嘲讽 | 未进入故事模型 | 遗漏 |
| 16.1–20.4s 点名 Killian / Shadow Pack 冠军 | hook 用 16.8–20.04s 错误 ASR，但标待审核 | 时间命中，文字待人工纠正 |
| 20.9–21.86s 跪地应命 | hook 捕捉 `At your command` | 命中 |
| 21.5–25.2s 旁观者震惊 | visualSummary 要求人工核对，但 characters/causal graph 未建 | 部分命中 |
| 15.1–23.5s 最强高光 | 系统 15.1–23.46s | 高度吻合，边界仍待审核 |
| 25s 后 CTA / 29s 后尾卡 | 独立 CTA segment，不再当 cliffhanger | 命中 |

## 上轮缺陷状态

- 已修复：P0-001、P0-003、P2-001、P0-006、P1-004。
- 大部/基本修复：P0-005、P1-003。
- 部分修复：P0-002、P0-004、P1-001、P1-002。
- 完全未修复：无；但 P1-001 的残留提升为当前唯一证据硬门禁。

## 评分

| 维度 | v2 | v3 | 说明 |
|---|---:|---:|---|
| 事实/证据准确性 | 45 | 55 | 来源与不确定性安全；人物图仍空且存在悬空引用 |
| 高光定位 | 5 | 78 | 精确命中黄金反转范围，边界仍待人工 |
| 钩子留人 | 25 | 72 | 有身份反转、信息缺口与承诺；缺人物关系和视觉确认 |
| 故事完整性 | 10 | 60 | 正确降级不完整，但摘要/因果链仍稀薄 |
| 匹配 | N/A | N/A | 未进入正片配对 |
| 转场/解说 | N/A | N/A | 未生成 production object |
| 工程可靠性 | 70 | 80 | 安全阻断和追踪生效；证据图清理仍不彻底 |
| 范围归一 | 28 | 66 | 仍为 NO-GO |

## 剩余开发项

1. **P0 证据图闭包**：拒绝事实后递归清理所有依赖 claim；本 case 的 consumable 层不得再引用 rejected fact-003/004 或不存在 fact-006。
2. **P1 人物/因果融合**：建立紫衣发令者、Killian、黑发女战士及旁观者的可观察角色，覆盖“点名→跪地应命→震惊”。
3. **P1 完整性文案一致**：`incomplete` 的 evidence 不得声称“完整流程”，应引用未完成动作和 CTA 中断。
4. **P1 hook 结束边界**：补 23.46s 附近动作/镜头/语义证据；未验证前继续 blocked，当前行为正确。
5. **P1 格式证据门**：无真实拼接边界/来源比较时不得仅凭连续对白把 EPISODE_SPLICE 标 verified。
6. **P1 重试审计**：仍需不可变 predecessor job/error 历史，不能只保留 queued→UI retry。

下一轮继续使用同一 golden 和输入，只新增 comparison-v4，不覆盖历史。
