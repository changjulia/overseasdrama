# QS-MAT-LYCAN-13 第八轮独立复测

Golden v1 未修改，SHA `ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d`。正式 PocketBase v8 快照 SHA 为 `fea680c4a4c986624890a92e2eca5ff689564b5bff26ecf7d35ebc59b6468806`。

## 结论

v7 的两个 P1 契约缺陷均已确定性修复：

- 四个 `rejectedEvents` 全部为 `verification=unverified`、`reviewRequired=true`；
- accepted=0 时，`boundaryAssessment.actionStatus/semanticStatus=unverified`；
- shot/dialogue 仍有独立证据，因此保持 verified；
- 推荐边界为 15.1–23.9s，与正式 Hook 完全一致；14.5–24.5 原始候选没有被提升；
- 拒绝事件未泄漏到任何可消费故事层，全发布 fact 闭包继续通过。

工程与安全隔离 **PASS**。内容仍 **NO-GO**：accepted visual events 仍为 0，黄金中的跪地服从和旁观者震惊没有进入 verified 故事链。范围归一分维持 **77/100**。

## 状态与计数

| 项目 | v8 实际 | 判断 |
|---|---|---|
| Job | succeeded / 100 / completed | 通过 |
| Material | succeeded / needs_review | 通过 |
| Confidence / gate | 49 / false / blocked | 安全阻断通过 |
| Visual accepted | 0 | 无过推断，但内容缺失 |
| Visual rejected | 4，全部 unverified + reviewRequired | 契约通过 |
| Speaker verified | 0 | 安全 |
| Invalid fact refs | 0 | 全发布闭包通过 |
| Rejected leak IDs | 0 | 隔离通过 |

## 边界一致性

`visualEventVerification.boundaryAssessment`：

- candidate：14.5–24.5s；
- recommended：15.1–23.9s；
- shot/dialogue：verified；
- action/semantic：unverified；
- reviewRequired：true。

正式 Hook 同样为 15.1–23.9s，`boundaryStatus=unverified`，action 仅 `shot_boundary_only`，semantic unverified。嵌套评估与权威门禁现在一致，不再存在 v7 的双真相风险。

## 与 Golden 比较

| Golden | v8 实际 | 结论 |
|---|---|---|
| 16.1–20.4s 点名/称号 | 对白和 OCR fact 保留；speakerVerified=0 | 安全部分命中 |
| 20.9–21.5s 跪地并回应 | 回应台词存在，视觉动作 rejected/unverified | 动作缺失 |
| 21.5–25.2s 旁观者震惊 | 候选均 rejected/unverified | 安全但故事缺失 |
| 15.1–23.5s 最强高光 | 15.1–23.9s，人工审核 | 高度吻合 |

## 评分

| 维度 | v7 | v8 | 说明 |
|---|---:|---:|---|
| 事实/证据准确性 | 72 | 72 | 安全隔离延续；视觉事实仍缺 |
| 高光定位 | 84 | 84 | 推荐边界与正式 Hook 一致 |
| 钩子留人 | 79 | 79 | 视觉反转未验证 |
| 故事完整性 | 72 | 72 | 跪地/震惊仍缺 |
| 工程可靠性 | 92 | 96 | 两个契约冲突关闭，无泄漏 |
| 范围归一 | 77 | 77 | 内容质量尚未跨门槛 |

## 剩余开发项

1. **P1 多帧/短视频事实**：获取能证明跪地动作与旁观者可观察反应的时序证据，不从姿态推断情绪、因果或身份。
2. **P1 说话人投影**：speakerVerified=0 时，`character-title-speaker` 不应仅凭相邻 ASR 标 verified。
3. **P2 ASR/OCR 融合**：正确点 OCR 应覆盖错误称号 ASR；`Wreckus brat` 衍生的 verified 风险缺乏可靠依据。

本轮没有新的 P0，生产阻断行为正确。
