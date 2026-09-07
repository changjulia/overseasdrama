# 解说开头轻量接入（本地）

## 数据契约

- 来源为 `narration_opening`，用途明确为 `usage_role=pre_roll`，不是“已确认跨剧外搭”。
- 素材类型直接采用用户已确认的“正片剧集解说”，不再调用模型分类；类型筛选先在服务端查询，再分页。
- `ad_materials.opening_analysis` 保存转写、前 15 秒覆盖范围、原筛选理由和缓存键。整片 `analysis_result`、`analysis_status` 不被伪造或改写。
- `hook_assets` 保存可供分析的片段、真实转写证据和提炼语义。导入后切点一律 `unverified`。
- 导入不触发整片任务。仅保存 URL 引用，已有同 URL 素材优先复用；不把来源散列冒充文件内容散列。
- 样本只是开头筛选通过，不代表独立钩子完整、跨剧事实适配或授权已确认。

## 本地操作

1. 先应用 `1788751000_narration_opening_intake.js`，正常启动本地 PocketBase，关闭自动 Worker 以免消费无关队列。
2. `node scripts/import-narration-openings.mjs`：只预检，默认选择四类共 12 条；不会写入业务库。
3. `node scripts/import-narration-openings.mjs --apply --report .codex-runtime/narration-intake/pilot-applied.json`：凭已有 `.analysis-worker-token` 导入；只能写本机地址。
4. `node scripts/analyze-narration-openings.mjs`：复用 `.env.analysis.local` 的现有服务，对这 12 条各做一次短篇分析，最多 1600 输出 tokens，不自动重试；命中本地缓存不再次调用模型。报告记录本次 API 调用和供应商返回的 token 用量。
5. 登录灵感大屏，钩子资产可选“解说开场”；进入内容工厂可选“解说开头”。草稿可匹配高光，实际生产前必须核对完整对白、动作和镜头切点。
6. 用户于 2026-09-07 明确批准全部 900 条入库；运行 `node scripts/import-narration-openings.mjs --all --apply --report .codex-runtime/narration-intake/all-applied.json`。该步骤不触发整片分析，不代表成片验收完成。

## 900 条预算与完整钩子终点

- 固定单条累计上限 **2079 API tokens**，包含原 12 条已付费轻分析。不是每次请求各享一份上限。
- `prepare-narration-boundaries.py` 复用本地历史转写，缺失时用本机 Whisper small 转写前最多 180 秒；音频/视频时长从实际媒体取得，不把 15 秒缓存当素材总长。180 秒是扫描上限而非钩子终点。
- 先根据实际语句末尾和停顿提出时间候选，再读取连续的开头转写选语义终点；不按固定 15/60 秒截断。不充分的结果保留 `needs_context`。
- `analyze-narration-boundaries.mjs --model qwen-plus --tokenizer --follow --python <Python3.12>` 使用现有 DashScope 账号和本地 Qwen 分词器预检，保留 25% 分词漂移余量、200 对话开销和输出余量。每次请求前落盘预留额度，响应后按实际 usage 结算；超出预估则停批。
- 模型先只选终点；第二次请求只接收 0–候选终点的原文生成中文摘要/矛盾/承接/身份约束，不能混入后续正文。两个阶段共用同一预算。剩余额度不足则保留“中文摘要待生成”，不再把原文冒充摘要。
- `boundary-ledger/<hookId>.json` 保存每条历史消耗、请求摘要、响应、预留和实际费用、范围、语言及版本。网络超时/未知消耗占用完整预留，不自动重试。续跑不重复付费。运行锁防止重复消费。
- 自动候选始终 `unverified`，不批准对白、动作、镜头切点、版权或跨剧事实适配。解说候选/人工复核/匹配入口允许最长 180 秒，其他来源时长限制不放宽。
- `boundary-evidence` 是本地语音证据；`boundary-report.json` 是本轮进度；台账才是跨轮累计费用依据。原语言转写保留在 evidence，中文概括用 `hook-summary-zh-v1` 和实际覆盖终点校验。
- 钩子卡片按 24 条逐批展示，先筛选全部资产再展示，避免 900 个视频同时加载。
- 批次停止后可运行 `recover-narration-summary-fields.mjs`：只恢复已经付费、因长度截断的响应中语法完整的字段，不猜补残缺句子。再运行 `normalize-narration-summaries.mjs` 清理旧范围或中英夹杂的结果；不额外请求模型。文本抽查发现的延续性切点由 `flag-narration-boundary-samples.mjs` 退回待确认，而非强行给新终点。
- `audit-narration-batch.mjs` 汇总实际用量、未决预留、完成数量、中文摘要数量、待补原因和长短钩子分布。逐条台账比批次平均值优先。
- 对完整但未本地化的已付费摘要，`localize-narration-cached-summaries.mjs <Python3.12>` 只翻译该摘要，不再次读取或分析视频；翻译预留和实际用量也写入同一条累计台账。缺失或未通过语言检查的其他字段留空，不猜补事实。

## 复用与保护

- 按来源 URL 复用素材，按素材 ID＋导入契约复用钩子；重复入库不清空人工复核或语义字段。
- 语义缓存包含转写、时间码、开头类型、图像内容散列、模型、服务端点和提示版本。相同证据可跨 URL 复用；不同画面不能仅凭相同文案共用视觉结论。
- 证据改变会拒绝静默覆盖，需显式修订。语义更新会改变 `analysis_version`，现有匹配缓存随之失效。
- 整片补全分析不会复用、覆盖或自动删除导入钩子，即使来源类型和区间相同；两者使用独立资产。人工批准过的资产不接受静默语义替换。
- 人工修改切点会推进钩子分析版本；生产接口和渲染器拒绝版本不一致的旧高光匹配。
- 前端、推荐/匹配服务、Python 匹配器和渲染器均采用相同的用途准入；历史整片模板仍走原来的完整分析要求。
- 原始转写存放在片段证据中。模型语义不是人工验证，也不自动赋予版权或来源归属。

## 当前边界

导入和语义提炼不等于已产生成片。完整视频可读性、首尾切点、目标剧事实承接、实际渲染仍需逐项验收。模型调用的 token 报告不包含 Codex 对话本身消耗。
