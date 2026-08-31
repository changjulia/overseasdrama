# 隔离盲标 v2 冻结记录

- 隔离任务：`isolated_blind_reannotation_v2`
- 上下文：`fork_turns=none`
- 冻结时间：`2026-08-30T22:43:45+08:00`
- 当前系统输出：未提供给隔离评测者；监督者亦未在冻结前开启对照轨。
- 访问证明：`artifacts/quality-golden/isolated-v2-run-20260830/access-attestation.json`
- 访问违规：`false`

隔离评测者实际声明读取了三条原视频、监督 schema、自生成证据，以及运行时强制要求的通用视频/计算机操作 skill 指令。skill 指令只包含工具与流程约束，不包含本项目业务答案；未读取禁止的旧样片目录、v1、系统输出、推进文档、旧帧/场景或 git 状态/历史。

## 机械校验结果

监督者没有用 v1 或系统答案修改 v2 内容，只执行以下机械检查：

- 三条原视频 SHA-256 与用户冻结值一致；
- case ID、输入 SHA、媒体时长（容差 0.01 秒）、`goldenVersion=v2` 正确；
- 草稿均为 `draft_blind`、`frozenAt=null`，提升时只改为 `frozen_blind` 并写入统一冻结时间；
- JSON 全部通过 `protocol.schema.json`；
- 40 个证据/候选时间区间全部满足有限数值、`0 ≤ start < end ≤ duration`；
- v2 文本未引用 `artifacts/golden-hook-samples`、`golden-v1` 或上线推进文档；
- 三份冻结文件的 SHA sidecar 复核通过。

| case_id | 区间数 | frozen SHA-256 |
|---|---:|---|
| QS-GH-001 | 13 | `27ded9d88ac3f31d95de28bf92e0b12112a76cfedfe4935ad099223ea74b45bc` |
| QS-GH-002 | 14 | `240ce251d266a581163fbb5dae24de1f202330b8320c5e6fa8c4adcd450d0251` |
| QS-GH-003 | 13 | `749df05d132aae8231d2722ed21449f3f9d4916b5f233f5eae9b76d41b9ddfb7` |

## 使用约束

v2 可进入严格盲评指标分母，但在读取当前系统输出前仍须保持不可变。后续比较只新建差距报告，不覆盖 v2。来源血缘、对应原剧、匹配、转场与真实渲染缺失的字段继续保持 pending；冻结成功不等于系统质量通过。
