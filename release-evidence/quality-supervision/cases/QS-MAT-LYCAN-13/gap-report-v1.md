# QS-MAT-LYCAN-13 双轨差距报告 v1

结论：`NO-GO`。严格盲标已先冻结，随后读取真实 PocketBase 状态。权威终态不是 succeeded：job `30wqqaz0u3vav09` 与 material `zmzrljhnwl4uxw5` 均在 92% / review 失败；job.result 为空。任何“正式重试已成功”的表述均被当前数据库终态否定。

## 运行身份与不可变证据

- 输入媒体 SHA：`f8e60a25347848d3d7f07e9badcd0d289fd47753858134e8ba18af21da4b1b43`
- Golden：`artifacts/quality-golden/QS-MAT-LYCAN-13/golden-v1.json`
- Golden SHA：`ca2c502069a14088d018beddc959555d9cd080f75f184933be2efe18da1e1c7d`
- 隔离访问证明：`artifacts/quality-golden/isolated-material-lycan-13-v1/access-attestation.json`，`violation=false`
- 系统快照：`system-snapshot.json`
- 系统快照 SHA：`5679ced8887e2161b28d4762c7eff93ad45dc74828c18c5572b1bf5486cb8c09`
- Git HEAD：`3944d05dc0da8b36376a9040fd7e409a25ea4116`；相关实现工作树为 dirty，另记录文件 hash，不能仅用 HEAD 复现。
- 模型/提示词版本：job/result 未持久化；`qwen-vl-max` 只能记为外部陈述，不能独立核实。

## 工程终态

| 项目 | 实际 |
|---|---|
| job status/progress/stage | `failed / 92 / review` |
| attempt | `1 / 1` |
| error kind | `permanent` |
| error | 千问素材分析返回字段不完整（收到：content, creative, review, value） |
| final job result | `null` |
| material status | `failed` |
| partial analysis | 仍保留约 39 KB |
| 已投影业务字段 | `T1`、`正片剧集拼接`、`高能开场` |

从 56% evidence 到 78% content、92% review 的过程确实由同一 live worker 推进，但最终失败。首次启动器缺陷、正式重试和模型名称没有可追踪的持久化记录，不能靠口头说明补证。

## 逐事实、时间码与因果链对照

| Golden | 系统实际 | 结论 |
|---|---|---|
| 0–3.4s：处决式命令把黑发女战士置于危险 | 0–2.86s 捕捉开场命令，但把 `reckless` 识别成 `Wreckus` | 时间接近，文本错误 |
| 3.4–6.7s：紫衣女子死亡嘲讽 | 未形成观察/人物 | 关键冲突遗漏 |
| 16.1–21.5s：紫衣女子点名 Killian；Shadow Pack 冠军跪地应命 | 16.8–20.04s ASR 把 Killian 识别成 Killed in，并拆出 Juggernaut/Killian 两个角色 | 关键身份与关系错误，硬门禁 |
| 21.5–25.2s：多名旁观者震惊，放大权力反转 | 仅笼统说“身份揭示”，未保留跪地→震惊因果链 | 因果链不完整 |
| 25s 后 CTA；29–34.504s 应用尾卡 | 记录 24.48–26.56s CTA，但把 0–34.504 认证为完整故事 | 完整性严重误判 |
| 最强高光 15.1–23.5s，安全结束应在 CTA 前 | `hooks=[]`、`hookCount=0` | 高光/钩子定位缺失 |
| 无源片/血缘时来源必须待复核 | `同剧外搭`、0.75、`verified`，证据仅开场对白 | 来源血缘幻觉，硬门禁 |
| T1/T2 定义和投放证据缺失，应不可评 | 用开场对白给出 T1/0.85，虽标 unverified 仍投影到 material | 不安全持久化 |

## 评分

该输入只跑素材分析，因此钩子-正片匹配与正式转场/解说不在本输出范围，保持 `not_evaluable`，不以 0 分惩罚。其余范围归一化为 22/100；硬门禁优先，最终仍为 NO-GO。

| 维度 | 分数 | 说明 |
|---|---:|---|
| 事实/证据准确性 | 30 | 捕捉少量对白，但存在关键身份拆错、血缘幻觉、悬空 fact ID |
| 高光定位 | 0 | 无 hooks，漏掉 15.1–23.5s 核心反转 |
| 钩子留人 | 45 | 知道“高能开场/参与度”，但没有可制作钩子、承诺或完整反转链 |
| 故事完整性 | 15 | 错误认证完整，未识别 CTA 截断未完成动作 |
| 匹配 | N/A | 尚未进入配对正片阶段 |
| 转场/解说 | N/A | 尚未生成正式 production object 或真实渲染 |
| 工程可靠性 | 0 | terminal failed、无 final result、失败中间态污染业务字段 |

## 缺陷优先级

### P0

1. `QS-L13-P0-001`：provider 输出修复后仍不满足契约，job 终态 failed；错误只列顶层键，未指出具体缺字段路径。
2. `QS-L13-P0-002`：失败尝试仍把 partial analysis、T1、正片剧集拼接和高能开场写入 material，破坏原子发布语义。
3. `QS-L13-P0-003`：无源片比对却把“同剧外搭”标 verified，且与 `sourceAttribution=not_required` 自相矛盾。
4. `QS-L13-P0-004`：Killian/Juggernaut 被拆成两个角色，主要人物和命令关系错误。
5. `QS-L13-P0-005`：故事完整性虚高且 hooks=0，最强反转与安全边界完全缺失。

### P1

1. `QS-L13-P1-001`：fact-004/fact-005 无定义；1.2s 转场证据为零时长。
2. `QS-L13-P1-002`：T1 和“正片剧集拼接”使用不相关证据，unverified 结论仍投影到业务字段。
3. `QS-L13-P1-003`：模型、提示词、分析 ID 和首次失败→重试血缘未持久化，无法复现。

### P2

1. `QS-L13-P2-001`：质量门失败原因中混入“所有观察和推断均有证据”这种正向陈述，既不可执行又与实际悬空证据冲突。

## 修复与同案回归门槛

实现 Agent 应处理 `processor/semantic_analysis.py` 的 provider 契约诊断/修复、ASR 实体归一、来源证据门、高光定位与 completeness；处理 `processor/job_worker.py` 和 PocketBase hook 的原子结果发布；处理 material projection 对 verification 的过滤。

同一媒体必须从真实 API/worker 重跑，并同时满足：

1. job/material `succeeded / 100 / completed`，final result 非空；失败中间态不污染 material。
2. 角色统一为 Killian the Juggernaut，不产生无证据的“主要反派”身份；紫衣发令者、黑发女战士、跪地和震惊因果链有证据。
3. 来源保持未知/待复核，除非另有源片匹配；T1/T2 无投放/人工证据时保持 TX/待复核。
4. 输出至少包含可复核的 15.1–23.5s 强反转候选，并在 25s CTA 前提供安全边界。
5. 完整性标为 incomplete/cliffhanger；不得把 CTA 截断的 34.5 秒片段认证为完整故事。
6. 所有 fact ID 可解析，所有区间合法；persist model、prompt version、attempt lineage。

复测后只新增 comparison/retest 版本，不覆盖本报告、golden 或失败快照。
