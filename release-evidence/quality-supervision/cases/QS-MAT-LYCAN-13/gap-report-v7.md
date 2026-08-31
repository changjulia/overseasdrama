# QS-MAT-LYCAN-13 第七轮独立复测

Golden v1 保持冻结，SHA `ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d`。正式 PocketBase v7 快照 SHA 为 `9f3b0c8c31c0f0b8834902111e92d8bef92e173f05142d2de3494dcd3171b558`。

## 结论

`visualEventVerification` 的核心安全隔离通过：

- accepted：**0**；
- rejected：**4**；
- speakerVerified：**0**；
- reviewRequired：**true**。

四个视觉候选均未进入正式 observations、segments、hooks 或关系层；单帧/短帧对不能证明的动作、情绪、因果、说话人和身份推断只保留在 rejectedEvents。正式 Hook 仍是 15.1–23.9s、unverified、人工审核；confidence=49、qualityGate=false、production blocked。

工程与安全隔离 **PASS**，内容仍 **NO-GO**。Golden 的跪地服从和旁观者震惊尚无 accepted 视觉事实，核心反转兑现仍不完整。范围归一分维持 **77/100**。

## 逐候选审计

| 候选 | 时间 | 包含的高风险推断 | 结果 |
|---|---:|---|---|
| character-introduction-killian | 17.5–18.0 | 用字幕/单帧暗示人物身份 | rejected，未泄漏 |
| character-introduction-shadow-pack-warrior | 18.783–19.504 | “似乎说话”、字幕证明身份 | rejected，未泄漏 |
| character-reaction-to-announcement | 22.133–22.483 | 震惊情绪、对先前事件的因果反应 | rejected，未泄漏 |
| character-response-to-event | 24.0–24.25 | 紧张/担忧、正在回应某事件 | rejected，未泄漏 |

两个 speakerLinks 均为 `adjacency_only`、unverified、reviewRequired；没有通过相邻台词或单帧证明发言人。

## 与 Golden 的时间码比较

| Golden | v7 实际 | 判断 |
|---|---|---|
| 16.1–20.4s 点名与称号 | 对白/OCR fact 保留；speaker link 未验证 | 安全部分命中 |
| 20.9–21.5s 跪地并回应 | 回应台词 verified，视觉候选 rejected | 台词命中，动作缺失 |
| 21.5–25.2s 旁观者震惊 | 22.133–22.483、24–24.25 候选 rejected | 安全隔离，但故事缺失 |
| 15.1–23.5s 最强高光 | 15.1–23.9s，人工审核 | 高度命中且未误放行 |

## 两个契约残项

1. **P1 rejectedEvents 状态自相矛盾**：四个对象位于 `rejectedEvents`，却都写 `verification=verified`、`reviewRequired=false`。当前因为容器隔离而未泄漏，但任何只按 `verification` 过滤的消费者都可能误用。
2. **P1 boundaryAssessment 与正式 Hook 冲突**：accepted=0 时，嵌套对象仍标 `actionStatus=verified`、`semanticStatus=verified`，并推荐 14.5–24.5s；正式 Hook 则正确保持 action=shot_boundary_only、semantic=unverified、15.1–23.9s。当前没有覆盖正式门禁，但必须明确权威字段并消除矛盾。

## 评分

| 维度 | v6 | v7 | 说明 |
|---|---:|---:|---|
| 事实/证据准确性 | 70 | 72 | 高风险视觉推断安全隔离；嵌套状态仍矛盾 |
| 高光定位 | 84 | 84 | 正式 Hook 未变且安全 |
| 钩子留人 | 79 | 79 | 核心对白保留，视觉爽点未验证 |
| 故事完整性 | 72 | 72 | 核心视觉兑现仍缺 |
| 工程可靠性 | 94 | 92 | 正式状态正确，但 nested contract 存在双真相风险 |
| 范围归一 | 77 | 77 | 仍低于上线内容门槛 |

## 下一轮开发项

1. **P1 拒绝状态契约**：rejectedEvents 不得再使用 `verification=verified`；模型置信度与验收状态分离。
2. **P1 边界单一真相**：accepted=0 时，action/semantic 不得无独立正证据标 verified；正式 Hook gate 必须是唯一权威或显式完成一致性校验。
3. **P1 多帧/短视频事实**：为 20.9–25.2s 跪地与反应收集足够时序证据，只描述可观察动作/状态，不推断情绪、因果或说话人。
4. **P1 说话人投影**：speakerLinks 全部 unverified 时，`character-title-speaker` 也应保持 pending，而不是仅凭相邻 ASR 作为 verified 人物。

本轮没有发现视觉推断进入生产层，生产阻断行为正确。
