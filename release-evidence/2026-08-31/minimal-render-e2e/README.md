# 真实匹配→过渡→成片最小闭环

> 状态：业务 E2E 待通过。本目录严格区分“静态契约已通过”与“真实 API/worker/UI 链路已通过”。

## 2026-08-31 基线盘点

- 真实剧：`drama_id=s2mhnmm4t9q9yud`，前 10 集媒体均已入库且逐集 `analysis_status=succeeded`。
- 前 3 集时长共 435.816 秒，满足 5–15 分钟正片时间线的基础时长要求。
- 真实跑量素材：原有 4 条分析任务全部 `succeeded`，但不包含三条用户 Golden 原片。
- 素材 `zmzrljhnwl4uxw5` 已定位真实钩子候选 `15.1–23.9s`，但边界仍为 `unverified`，不允许匹配/制作。
- 当前表状态：素材型 `hook_assets=0`、`hook_story_matches=0`、`factory_projects=0`、`factory_renders=0`。
- 独立监督复核后确认：现有 4 条素材与用户冻结的 3 条 Golden 在 SHA、时长、资产身份上均不一致，不得用它们代替 Golden 内容评分。
- Golden 本地身份已重算：`QS-GH-001=406ba710…`、`QS-GH-002=eddfbf80…`、`QS-GH-003=0b82e9fc…`。

## 已定位的 P0 产品/实现缺口

1. 素材投影会因钩子开始时间大于 5 秒而丢弃已定位候选；这是错把“钩子在素材内的位置”当成来源门禁。
2. 系统没有人工从真实素材圈定钩子草稿的生产 API，模型漏召回时无法在不直写数据库的前提下继续。
3. 真实 UI 对 207.4MB Golden 文件完成选择与客户端校验后，经认证网关提交稳定返回 `HTTP 502`；直连 PocketBase 则按预期被 `HTTP 403` 生产保护拒绝。

## 修复与安全门

- 已移除“`external_material && start > 5` 则不持久化”的错误筛选；5–60 秒、不得覆盖整条素材、媒体可用等限制保留。
- 新增 `POST /api/lumina/materials/{id}/hook-drafts`：只能产生 `unverified + needs_review`草稿，必须携带人工定位备注，继承素材权限标签。
- 匹配入口仍强制：真实媒体存在、`boundary_status=verified`、`review_status=approved`。
- 过渡预览、过渡审核、最终渲染、QC 的原有门禁未放宽。
- 512MiB 应用内有界缓冲方案已撤回：它仍受 PocketBase 请求体上限限制，并会给应用进程带来不可接受的内存峰值。当前本地验收改走仅 `local-loopback` 可用、根目录受限且 SHA 强绑定的文件导入 API；托管大文件入口仍需对象存储直传/分片上传，保持预生产 `NO-GO`。
- 三条 Golden 已经由正式本地 API 入库并逐条验证 `content_hash` 与冻结 SHA 一致，当前由三个真实 material worker 执行分析；未完成前不创建匹配或成片结论。
- 静态契约：`tests/manual-hook-draft-contract.test.mjs` 与相关 factory 契约已通过。此结论不等于业务 E2E 通过。
- 相关静态契约共 25 项通过；全库 `tsc --noEmit` 仍因已有 Factory/Inspiration/Library 等类型错误失败，本次新增网关路由未产生新的 TS 错误。

## 当前真实链路后续

1. 等待三条 Golden 同 ID 分析终态，并由独立监督先做 hash equality 再逐字段对照。
2. 回放钩子前后边界，由独立审核给出批准/驳回；仅批准后发起真实匹配 worker。
3. 获得至少 3 条真实匹配候选，逐条记录故事完整度、留人、承诺兑现、连通性及一票否决项。
4. 为同一真实输入建立 `direct_cut`、`transition_copy`、`continuous_narration` 三种可执行项目；旁白模式必须上传并探测真实音轨。
5. 先完成 `transition_copy` 的真实 preview → 审核绑定 hash/version → final render → QC → 播放/历史检索。

## 证据记录字段

`case_id, input_asset_id, API/UI action, database state, worker/job id, output hash, preview/final URL presence (not signed URL), QC checks, human conclusion, defect id, regression result`
