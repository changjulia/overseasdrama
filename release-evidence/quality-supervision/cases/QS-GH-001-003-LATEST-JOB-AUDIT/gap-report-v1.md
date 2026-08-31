# QS-GH-001/002/003 最新任务独立监督 v1

## 结论

**NO-GO，且本轮不可评分。** 指定的三个 succeeded 任务并非三份冻结 Golden 的系统输出：3/3 的 SHA256、时长和资产身份均不一致。不得将当前 Lycan 跑量短素材反向配对给用户三条 16–20 分钟样片，也不得据此宣称人物资产复用困难正例 QS-GH-002 已通过。

## 硬门禁

- **P0 输入—Golden 错配**：Golden SHA 为 `406ba7…` / `eddfbf…` / `0b82e9…`；任务素材 SHA 为 `da4d7f…` / `3b12aa…` / `a7c5a1…`，交集为 0。
- **P0 核心功能无可消费钩子**：当前三条非 Golden 素材虽工程终态为 succeeded，但 `hook_count=0` 且 `qualityGate=false` / `productionStatus=blocked`。安全阻断行为正确，但 3/3 无候选使“钩子筛选/匹配”无法工作，对上线是 P0，不是可忽略的 P1。
- **P0 QS-GH-002 仍未验证**：本轮没有对应输入，因此无法检验“人物连续但仍为外搭”。

## 当前三条系统输出的安全性审计（非 Golden 评分）

| 任务 | 格式 / 来源 | 事实/完整性 | 边界 | 监督结论 |
|---|---|---|---|---|
| `pxxj13fksahdjcf` | EPISODE_NARRATION / UNKNOWN, unverified | 2 facts; incomplete | 无 hook | 保持 blocked 正确；格式不能代替外搭来源判定 |
| `vuvkt4r295ute1g` | EXTERNAL_HOOK_BODY / 疑似外搭 | 1 fact; incomplete | 无 hook | “疑似外搭”可作诊断，但在 sourceAttribution pending 时不应标成 verified |
| `bdwsfa1suhh3si5` | EPISODE_SPLICE / NO_INDEPENDENT_HOOK | 7 facts; completeness undetermined | 0–5.933s 仅待审核 | 不得将角色连续性或正片观感当成“无外搭”证据；必须依原剧镜头匹配/制作血缘 |

T1/T2 在三条当前可消费输出中没有形成可追溯、可评分的独立结论；该维度记为 **missing / not evaluable**，不以 `material_format` 或 `hookSourceStatus` 代填。

## 评分

QS-GH-001/002/003 的事实、高光、留人、完整性、匹配、转场和工程分均为 `not_evaluable`，不给 0 分，避免把资产配对错误污染内容评分。工程任务 succeeded 仅证明三条 Lycan 素材的 worker 完成，不证明 Golden 案例通过。

## 可执行修复与回归

1. **入库/任务绑定 P0**：用 Golden 中的原始 SHA 定位或重新从真实 UI/API 入库三份原视频；任务必须回写 `input_content_hash` 并在评测前断言与 Golden SHA 相等。
2. **来源子类 P0**：输出 external-unrelated / external-reused-original-assets / mixed / unknown-pending-review；人物资产复用不得作否定条件。回归必须单列 QS-GH-002。
3. **Hook 候选 P0**：对边界未确认的候选保留 `needs_review` 对象及证据时码，不得因不能直接生产就整体丢失；未批准仍不得进入匹配/渲染。
4. **评测器 P0**：增加 `job.material.content_hash == golden.input.sha256` 前置硬断言；失败时只产出 identity mismatch，禁止内容评分。
5. **T1/T2 P1**：将视觉初判与镜头来源结论分开，两者都必须有证据、置信度和审核状态。

## 复测准入

只有三个新任务的输入 SHA 分别与 QS-GH-001/002/003 Golden SHA 完全相等，才允许开始逐字段/时码/因果链评分。
