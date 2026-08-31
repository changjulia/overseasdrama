# QS-MAT-LYCAN-13 第九轮独立复测

Golden v1 未修改，SHA `ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d`。正式 PocketBase v9 快照 SHA 为 `2eef808360f9f1f71327e61a2289de183c8872aa0483539ce98b3750772fa958`。

## 结论

v8 剩余的说话人 P1 已关闭：

- 三条对白/文本事实继续保持 verified，只表示内容在对应时间出现；
- `character-title-speaker` 与 `character-command-recipient` 均降为 unverified；
- `mention_response` 关系降为 unverified；
- speakerVerified 仍为 0；
- 所有正式投影中不存在 verified 人物或关系路径。

没有新泄漏：全发布 invalid fact refs=0、rejected visual leak IDs=0，四个 rejected visual events 状态仍正确，边界与生产阻断未回退。

工程与推断隔离 **PASS**。内容仍 **NO-GO**，因为跪地服从和旁观者震惊没有 accepted 视觉事实。范围归一分升至 **79/100**。

## 说话人/实体分层

| 层 | 状态 | 结论 |
|---|---|---|
| `local-dialogue-title` | verified | 只证明 16.8–20.04s 出现称号对白/OCR |
| `local-dialogue-response` | verified | 只证明 20.9–21.86s 出现回应台词 |
| speakerLinks | 0 verified | 不从相邻台词推断说话人 |
| 两个 characters | unverified | 不再把对白提升为人物身份 |
| mention_response | unverified | 保留候选邻接，不声称已验证人物关系 |

该分层符合 Golden 的拒绝/降级条件：没有声纹、唇同步或说话人画面证据时，不硬判紫衣女子、Killian 或具体关系。

## 回归检查

- visual accepted=0、rejected=4、speakerVerified=0。
- 四个 rejectedEvents 均 unverified + reviewRequired。
- `boundaryAssessment` 推荐 15.1–23.9s，action/semantic unverified，shot/dialogue verified。
- 正式 Hook 15.1–23.9s、unverified、reviewRequired。
- Material needs_review、confidence=49、qualityGate=false、production blocked。

## 评分

| 维度 | v8 | v9 | 说明 |
|---|---:|---:|---|
| 事实/证据准确性 | 72 | 76 | 对白事实与人物身份/关系彻底分层 |
| 高光定位 | 84 | 84 | 边界稳定 |
| 钩子留人 | 79 | 79 | 视觉反转仍缺 accepted 证据 |
| 故事完整性 | 72 | 72 | 跪地/震惊仍缺 |
| 工程可靠性 | 96 | 97 | 无新泄漏或状态回退 |
| 范围归一 | 77 | 79 | 仍未满足内容硬门禁 |

## 剩余开发项

1. **P1 多帧/短视频视觉事实**：为 20.9–25.2s 跪地动作和旁观者可观察反应补足时序证据；不得推断情绪、因果、说话人或身份。
2. **P2 审核状态一致性**：unverified characters/relationship 当前没有显式 `reviewRequired=true`，应补字段或统一消费者契约。
3. **P2 ASR/OCR 融合**：正确点 OCR 应覆盖错误称号 ASR；`Wreckus brat` 生成 verified 风险仍缺可靠依据。

本轮没有新的 P0，生产阻断行为正确。
