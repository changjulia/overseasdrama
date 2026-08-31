# QS-MAT-LYCAN-13 第四轮独立复测

Golden v1 SHA `ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d` 校验通过且未改写。v4 系统快照 SHA 为 `b41f1561d0de5df7c311d222a9e4f923f9961b271b0ebae1a3e46107a2db27fe`。

## 结论

| 层面 | 结论 |
|---|---|
| 工程执行 | **PASS**：job/material succeeded、100%、completed，最终结果存在 |
| v3 唯一 P0 | **已关闭**：可消费证据图不存在悬空或被拒事实引用 |
| 内容质量 | **改善但未达门槛**：反转 hook 和不完整诊断正确，人物/关系/核心因果链仍缺失 |
| 生产安全 | **PASS**：confidence=49、productionStatus=blocked、qualityGate=false |
| 硬门禁 | **NO-GO**：关键人物、关系和“点名→跪地服从→旁观者震惊”因果链未进入可消费故事模型 |

范围归一分由 v3 的 66 升至 **70/100**。证据闭包修复是真实进展，但不代表素材分析已达到内容质量上线门槛。

## 证据图闭包

- 现存 verified observation 只有 `fact-002`。
- consumable observations/segments/timeline/transitions/hooks 数量分别为 1/1/1/0/1。
- segment 与 timeline 只引用 `fact-002`；hook 使用直接 transcript evidence，不创建悬空 fact 引用。
- 被拒的 `fact-006` cut 与 `fact-003` fade 只位于 `review.rejectedClaims`，没有进入可消费 transition。
- 机械扫描得到 invalid `basedOnFactIds=[]`，因此 `QS-L13-V3-P0-001` 判定 **fixed**。

## 指定口径核验

| 项目 | 结果 | 证据 |
|---|---|---|
| CTA 独立归档 | **通过** | `creative.cta` 两项均 `basedOnFactIds=[]`、`storyCandidate=false`；未进入 segments/timeline/hooks |
| completeness 不再声称完整流程 | **通过** | incomplete、confidence 0.49、unverified；文案明确人物、因果与收束待复核，证据只引用开场命令 |
| 15.1–23.46s hook | **通过但待审核** | 身份称号与 `At your command` 时间证据保留；safeEnd 动作/镜头/语义仍 unverified |
| 来源与生产门 | **通过** | sourceAttribution pending；confidence 49；production blocked |
| 当前 gate reasons | **审计残项** | 仍声称 segments/transitions/timeline 引用 fact-003/004/005/006，与已清理的当前可消费层不一致 |

## 人物、因果与时间码

| Golden | v4 实际 | 判断 |
|---|---|---|
| 0–3.4s 处决命令 | 0–2.86s `fact-002` | 时间部分命中，ASR/对象仍不可靠 |
| 3.4–6.7s 紫衣女子死亡嘲讽 | 未建模 | 遗漏 |
| 16.1–20.4s 点名 Killian / Shadow Pack champion | 16.8–20.04s hook transcript | 时间命中，文字待复核 |
| 20.9–21.86s 跪地应命 | 仅捕捉 `At your command` | 台词命中，动作/人物关系遗漏 |
| 21.5–25.2s 旁观者震惊 | 仅 visualSummary 要求人工核对 | 未进入可消费人物/因果图 |
| 15.1–23.5s 最强高光 | 15.1–23.46s | 高度吻合，结束边界未验证 |
| 25s 后 CTA / 29s 后尾卡 | 独立 CTA、非 story candidate | 命中 |

`characters=[]`、`relationships=[]`。这是当前唯一硬门禁：系统不能只定位一段高光，还必须给出可追溯且不过度推断的角色和因果链。

## 评分

| 维度 | v3 | v4 | 说明 |
|---|---:|---:|---|
| 事实/证据准确性 | 55 | 62 | 证据闭包已修；人物图、部分 ASR 和格式归因仍弱 |
| 高光定位 | 78 | 80 | 黄金区间稳定命中，结束边界仍待审核 |
| 钩子留人 | 72 | 74 | 身份反转与信息缺口存在，视觉动作关系未结构化 |
| 故事完整性 | 60 | 65 | 不完整诊断一致，但故事模型过稀 |
| 匹配 | N/A | N/A | 未进入正片配对 |
| 转场/解说 | N/A | N/A | 未生成 production object |
| 工程可靠性 | 80 | 88 | 闭包与安全阻断正确；当前原因仍混有已修历史缺陷 |
| 范围归一 | 66 | 70 | 仍为 NO-GO |

## 下一轮开发项

1. **P1 人物/因果融合**：用 OCR/ASR/frame 建立可观察角色与“发令→服从→震惊”链；不确定身份必须降级。
2. **P1 hook 结束边界**：补 23.46s 附近正时长的 frame/action/semantic 证据；未验证前继续阻断。
3. **P1 格式证据门**：没有组装边界或来源对照时，不得把 `EPISODE_SPLICE` 标为 verified。
4. **P2 原因重算**：证据图清理后重新生成当前 gate reasons，或明确标为已修历史审计，不得误导操作员。
5. **P2 重试审计**：保留不可变 predecessor job/error 记录以重建首次启动器失败和正式重试。

下一轮继续使用同一冻结 golden，只新增 v5，不覆盖历史。
