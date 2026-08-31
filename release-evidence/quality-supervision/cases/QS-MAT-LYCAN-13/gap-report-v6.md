# QS-MAT-LYCAN-13 第六轮独立复测

沿用未改写 Golden v1，SHA `ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d`。v6 快照 SHA 为 `9fce0b2a615ed8fbf46639b31cd1c06a8e5aed895757ea4459ac3d24f3f260ca`。

## 结论

v5 的两个 P0 均已修复：

1. 0–2.86s 壮汉发令者不再错误连接 20.9s 回应；当前仅保留 16.8–20.04s 点名与 20.9–21.86s 回应的 `mention_response`，明确限定为相邻对白层。
2. 全部可消费字段的 `basedOnFactIds` 已闭包。`bodyFormat`、`hookSourceStatus`、`value.risks` 等外围字段没有再引用不存在或被拒事实。

工程执行与生产阻断 **PASS**，但内容仍 **NO-GO**。原因不再是错误事实泄漏，而是最核心的视觉反转兑现——跪地服从与旁观者震惊——仍未进入 verified 故事链。当前系统正确地没有冒充已修，并继续阻断生产。

范围归一分升至 **77/100**。

## 全发布证据闭包

- verified facts：`fact-002`、`local-dialogue-title`、`local-dialogue-response`。
- 扫描范围：`material.analysis_result` 下所有含 `basedOnFactIds` 的对象，排除仅用于审计的 `review.rejectedClaims`。
- invalid published references：**0**。
- `material_format=未确定`；`bodyFormat.verification=unverified`、`reviewRequired=true`，只引用 `fact-002`。
- `hookSourceStatus.basedOnFactIds=[]` 且 UNKNOWN/unverified。
- risks 只剩引用 `fact-002` 的一项。

因此 `QS-L13-V5-P0-002` 判定 fixed。

## 人物和因果真实性

当前关系：

- subject：`character-title-speaker`，身份待核；
- object：`character-command-recipient` / Killian 称号候选；
- 类型：`mention_response`；
- 证据：16.8–20.04s 点名/称号对白，20.9–21.86s `At your command.`；
- 不声称跪地、震惊或主仆身份。

这避免了 v5 把开场壮汉与后续回应跨事件误连的问题，`QS-L13-V5-P0-001` 判定 fixed。

仍有两个质量残项：ASR 没有说话人分离，因此 `character-title-speaker` 作为 verified 人物节点证据偏弱；黄金中的跪地动作与旁观者震惊没有结构化事实。前者应保持身份 pending，后者必须通过正时长 frame/clip 证据补齐，不能仅凭台词反推。

## Hook 与生产安全

- Hook：15.1–23.9s，与 Golden 15.1–23.5s 高度吻合。
- 23.9s 是真实 shot boundary；对话无跨界。
- action 仅 `shot_boundary_only`；semantic/frame 为 unverified。
- `boundaryStatus=unverified`、`reviewRequired=true`、confidence=49、productionStatus=blocked。

这意味着边界技术吸附通过，但尚未达到人工可批准的动作/语义安全标准。当前阻断正确。

## 评分

| 维度 | v5 | v6 | 说明 |
|---|---:|---:|---|
| 事实/证据准确性 | 52 | 70 | 两个 P0 关闭；说话人证据和视觉事实仍不足 |
| 高光定位 | 82 | 84 | 15.1–23.9 稳定，真实镜头边界 |
| 钩子留人 | 77 | 79 | 身份点名与回应成立，跪地/震惊爽点未结构化 |
| 故事完整性 | 68 | 72 | 相邻对白链正确，但核心视觉兑现缺失 |
| 工程可靠性 | 90 | 94 | 全发布图闭包、格式降级和阻断均正确 |
| 范围归一 | 69 | 77 | 仍低于内容上线门槛 |

## 剩余 P1/P2

1. **P1 视觉事实**：为 20.9–25.2s 跪地和旁观者反应补正时长 frame/clip 证据，区分“听到回应”与“观察到跪地”。
2. **P1 说话人归因**：没有 diarization/frame speaker 证据时，点名事件可以保留，但人物节点不得仅凭相邻 ASR 标 verified。
3. **P1 边界语义闭合**：23.9 shot snap 保留；action/semantic 未确认前不得批准。
4. **P2 ASR/OCR 融合**：正确 OCR 已确认称号，应修正/降权错误 ASR；`Wreckus brat` 不应直接生成 verified 争议风险。

当前无未修复的 v5 P0 实现缺陷；NO-GO 来自内容硬门禁仍未满足，而非工程执行失败。
