# QS-MAT-LYCAN-13 第五轮独立复测

继续使用未改写的 Golden v1（SHA `ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d`）。v5 系统快照 SHA 为 `e861fd1a3abb749d8fb268113603c1f19b0a1512a473e470bbb394b3d767bafc`。

## 结论

| 层面 | 结论 |
|---|---|
| 工程执行 | **PASS**：任务 succeeded、100%，结果持久化 |
| OCR 点证据 | **PASS**：17.5s 独立帧真实存在，画面字幕确为 `Killian the Juggernaut.` |
| 内容结构 | **改善**：3 个 verified facts、2 个角色、1 条关系；未把跪地/震惊冒充 verified |
| 内容事实 | **FAIL**：唯一关系把 0s 壮汉发令与 21s 对后续点名的回应错误串联 |
| 边界安全 | **PASS（继续阻断）**：23.9s 为真实 shot boundary，但 action/semantic 未验证、仍需人工审核 |
| 硬门禁 | **NO-GO**：关键关系归因错误；完整发布图仍有 verified claim 引用不存在/被拒事实 |

范围归一得分 **69/100**。结构字段增多不等于事实质量提高；由于新增关系包含关键因果误归因，得分没有随字段数量上升。

## OCR 独立核验

- `ocr_frame` 使用 `sampleType=point`，时间码 17.5–17.5s，不再伪装为持续区间。
- `framePath` 文件存在，SHA-256 为 `de0558457a05b623e3d97ee8fb78491352bc53d525fffb5e20cfb228fce9064a`。
- 独立查看该帧，画面明确显示字幕 `Killian the Juggernaut.`。
- 因此 `local-dialogue-title` 获得 OCR 点证据支持；但 ASR `Killed in the Juggernaut...` 仍有转写错误，不能用 ASR 原文强化错误文本。

## 关键因果错误

Golden 的可观察链条是：

1. 0–3.4s：兽纹重甲壮汉命令 Juggernaut 终结女战士。
2. 16.1–20.4s：另一名紫衣女子点名 Killian，并出现冠军称号。
3. 20.9–21.86s：Killian 对后续点名作出 `At your command.` 回应。

系统却把 `character-command-speaker` 建在 `fact-002`（0–2.86s 壮汉发令）上，再将其直接连接到 `local-dialogue-response`（20.9–21.86s）。这把两个不同时间、不同人物的发令事件合并成一条 verified 关系。该错误改变核心权力反转含义，属于 **P0 关键关系/剧情事实错误**。

新增角色节点也只覆盖“开场发令者”和“Killian”，没有表示 16s 的紫衣点名者。跪地与旁观者震惊没有被标 verified，而是保留人工核验，这一安全处理正确。

## 证据图与诊断

- v4 指定的 observations/segments/timeline/transitions/hooks 核心层闭包仍通过。
- 过时的“当前 segment/transition/timeline 仍引用坏边”诊断已从 `qualityGate.reasons` 删除，rejected transition 带 `rejectionReason`，此项修复通过。
- 但全量发布层仍未闭包：`creative.bodyFormat` 以 verified 状态引用不存在的 `fact-001/fact-003`；`value.risks[1]` 引用 `fact-003`；`hookSourceStatus` 引用 `fact-001`。
- 因此需要把闭包从核心故事层扩展到所有面向消费者的投影。被拒事实可且仅可在 `review.rejectedClaims` 保留审计副本。

## Hook 边界

Hook 从 15.1–23.46 调整为 **15.1–23.9s**，与 Golden 15.1–23.5 高度接近。23.9s 是相邻 shot 22.133–23.9 与 23.9–25.1 的真实边界；对话已完整。

但 `safeEnd.status=unverified`，action 仅为 `shot_boundary_only`，semantic/frame 仍 unverified。继续 `reviewRequired=true` 和生产 blocked 是正确行为；不能称边界已经完全安全。

## 评分

| 维度 | v4 | v5 | 说明 |
|---|---:|---:|---|
| 事实/证据准确性 | 62 | 52 | OCR 更强，但新增关键关系发生因果误归因，且完整发布图仍有悬空引用 |
| 高光定位 | 80 | 82 | 23.9s 吸附真实镜头边界 |
| 钩子留人 | 74 | 77 | 标题与回应更可追溯，视觉爽点仍待核 |
| 故事完整性 | 65 | 68 | 角色结构出现，但点名者缺失且关系错误 |
| 工程可靠性 | 88 | 90 | 点 OCR、诊断清理、安全阻断有效 |
| 范围归一 | 70 | 69 | 新增 P0 事实错误抵消结构提升 |

## 剩余 P0/P1

1. **P0 关系归因**：不得把 0s 发令者与 21s 回应直接连线；必须建立 16s 后续点名者或把关系降为 unverified。
2. **P0 全发布图闭包**：`bodyFormat/value.risks/hookSourceStatus` 也必须清除悬空事实引用。
3. **P1 视觉事实**：为跪地与旁观者反应增加可回放的正时长 frame/clip 证据；当前未冒充已修，安全行为正确。
4. **P1 边界**：保留 23.9 shot snap，补 action/semantic 结束证据后才允许批准。
5. **P1 格式**：没有真实组装/来源边界证据时，`EPISODE_SPLICE` 应投影为未确定。

下一轮继续沿用同一冻结 golden，不覆盖 v1–v5 历史。
