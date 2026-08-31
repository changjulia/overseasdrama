# 性能验收补充协议 v1

状态：`supervision-only`。本协议只定义本地验收与证据口径，不修改生产实现、主推进文档或部署配置。

## 1. 目标与不可交换原则

性能优化不能用内容质量、安全边界或可追溯性换取。任何加速方案必须同时满足：

- 同一输入 hash、模型、prompt version、系统版本和终态可重放；
- 快速模型只能生成候选，不得发布最终事实、人物关系、因果、匹配、转场文案或生产边界；
- 最终结论由 Max 级模型基于原始证据重新判定，不得仅复述 Flash 摘要；
- 缓存命中必须绑定完整 cache key，旧 prompt、旧模型、旧输入或旧证据不能复用；
- 超时、重试、降级或成本字段缺失必须显式记录，不能以成功终态掩盖。

## 2. 可审计性能台账

一行代表一个可独立重试、缓存和验收的工作单元。工作单元可为 episode、视频 chunk、hook、highlight、match、transition、render 或 QC。

必填字段：

| 字段 | 含义 |
|---|---|
| `run_id` / `unit_id` | 一次端到端运行及其独立单元标识 |
| `case_id` / `stage` | Golden case 与 coarse/detail/precision/hook/match/transition/render/QC 阶段 |
| `episode_or_asset_id` / `chunk` | 剧集/素材 ID；chunk 起止秒和序号 |
| `input_sha256` | 原始输入或确定性派生输入 hash |
| `model` / `model_tier` | 精确模型名；tier 取 Flash/Max/deterministic |
| `prompt_version` | 非空、不可变版本；无 prompt 的确定性步骤填 `not_applicable` |
| `started_at` / `ended_at` | 实际 worker 开始/结束时间，不以记录 created 代替 |
| `wall_clock_ms` | ended-started；另记 queue_wait_ms |
| `request_count` | 对外模型/API 请求总数，含失败请求 |
| `retry_count` | 首次请求之后的重试次数；另记 retry reasons |
| `cache_status` / `cache_key` | hit/miss/bypass；key 至少含 input hash、model、prompt、stage、chunk config |
| `input_tokens` / `output_tokens` | 可得时必填；供应商不返回时填 null 并写原因 |
| `cost_amount` / `cost_currency` | 可得时必填；未知不可填 0 |
| `terminal_status` | succeeded/failed/blocked/cancelled/paused/needs_review |
| `quality_gate` | pass/fail/not_evaluated；不得从 terminal_status 推导 |
| `output_sha256` | 最终输出 hash；失败或无输出时为 null |
| `error_kind` / `error_summary` | 失败、超时、重试和人工阻断的脱敏原因 |

建议附加：worker/host、软件版本、provider request IDs、峰值内存、GPU/CPU、下载/预处理/模型/持久化分段耗时、人工审核耗时。

机器可校验 schema 见 `performance-ledger-schema-v1.json`；空台账模板见 `performance-ledger-v1.csv`。

## 3. 模型分层硬门禁

### Flash 只允许粗筛

Flash 可做：镜头/对白/OCR 候选召回、低成本标签候选、待分析 chunk 选择、去重建议。

Flash 输出必须：

- `verification=unverified`、`reviewRequired=true`；
- 保留原始证据指针，不得把摘要当证据；
- 不写最终 characters/relationships/causal graph；
- 不批准 safeStart/safeEnd、precisionEligible-for-production、match Top3 或 transition production object；
- 不改变 production gate。

### Max 才能最终判定

以下字段只有 Max 读取原始 ASR/OCR/frame/shot/audio 证据后才能发布：

- 剧情事实、人物实体与关系、因果、完整性；
- Golden 高光事件范围及安全边界；
- 钩子事实、叙事承诺、留人判断；
- 钩子—正片匹配及故事完整/承诺兑现/连通性评分；
- 转场断层、转场词/连续解说事实依据；
- 人工批准前的 production eligibility。

若 Max 不可用、超时或证据不足，必须 fail closed 为 needs_review/blocked。禁止自动回退到 Flash 作为最终答案。

## 4. 建议本地性能门槛

以下为第一轮本地门槛，使用固定硬件、固定网络、缓存冷/热分组统计；连续 3 次运行后再校准。P50/P95 只使用独立 worker 实际开始至结束，不含队列等待。

| 阶段 | 建议门槛 | 硬上限/处理 |
|---|---:|---|
| Flash coarse 单集 | P50 ≤ 90s，P95 ≤ 180s | >240s 标慢并保留证据 |
| 10 集 Flash coarse（2 workers） | 冷缓存 ≤12min | >15min FAIL |
| Max detail 前10集 | ≤20min | >30min FAIL，不降级到 Flash final |
| Max precision 单高光 | P50 ≤90s，P95 ≤180s | 3 Golden 高光总计 ≤10min |
| 单条真实钩子 Max 分析 | P50 ≤120s，P95 ≤180s | 3 条总计 ≤6min |
| 单次钩子—正片匹配 | P50 ≤45s，P95 ≤90s | 3 个匹配总计 ≤3min |
| 转场诊断/脚本生成 | ≤120s | >180s FAIL/人工处理 |
| 真实转场预览 | ≤5min | 需包含真实媒体、字幕与音轨 |
| 最终成片渲染+QC | ≤10min 且 RTF ≤2.0 | 任一 QC/审核失败不得以超时为由绕过 |

可靠性门槛：单元首次成功率 ≥95%；重试后成功率 ≥99%；单元 retry_count ≤1（供应商瞬时故障例外但必须审计）；终态 100% 可解释；同 cache key 输出 hash 或语义版本必须一致。

## 5. 最小闭环顺序

必须按顺序完成，前站质量门失败时不以速度理由跳站：

1. **3 个 Golden 高光**：Max 最终判定事件/上下文/生产边界；至少 1 条可直接制作，目标 3/3。
2. **3 条真实钩子**：逐条完成事实、留人、承诺、安全边界和来源标签；来源不作匹配硬门禁。
3. **3 个真实匹配**：每条钩子至少一个候选，Max 检查故事完整、留人、承诺兑现、连通性与一票否决项。
4. **1 条带过渡真实成片**：完成断层诊断、A/B 过渡 production object、人工批准、真实预览、渲染、QC、播放和可追溯导出。

只有该 3+3+3+1 闭环同时满足质量与性能门，才可称“本地上线性能验收通过”。组件 benchmark 或缓存热跑不能替代。

## 6. 当前审计

证据来自 `QS-DRAMA-LYCAN-DW-EP01-10/system-snapshot-v2.json` 的真实任务记录：

- 10 个 coarse 任务几乎同时创建，两 worker 完成全批约 **11m26s**；按 created→updated 的单任务观测为 112–686s，但该值混入 queue wait，不能当模型 P50/P95。
- coarse 当前使用 `qwen-vl-max`，不是 Flash。它没有造成“Flash 冒充最终答案”的质量风险，但浪费了粗筛阶段的延迟/成本预算，且无法验证目标分层架构。
- detail created→updated 约 **47m32s**，超过建议 30min 硬上限；该区间可能含多轮重跑/排队，现有日志无法拆解。
- `semantic_prompt_version` 为空；没有 request_count、retry_count、cache hit/miss、token、cost、真实 worker start/end、chunk 级耗时。
- 同一 detail job 的历史曾被报告 attempt=3，而当前可变记录显示 attempt=1；不可用它作为可靠重试台账。
- 16 个 precision job 在快照中进入 paused；大多数没有 model/prompt 日志。性能与成本无法审计。

当前性能结论：**NO-GO / NOT AUDITABLE**。批量 coarse 总时间暂时接近建议门槛，但缺少必要字段；detail 观测超时；3+3+3+1 尚未完成。

## 7. 当前质量降级风险

| 风险 | 等级 | 处置 |
|---|---|---|
| 为提速让 Flash 直接写最终事实/关系/匹配/转场 | P0 | Max final 硬门；不可用时 blocked |
| Flash 摘要被 Max 当唯一证据，形成“伪 Max” | P0 | Max 必须读取原始证据并输出 evidence refs |
| chunk 切分丢失跨块对白、动作或因果 | P0 | 重叠窗口+跨块 reconciliation；边界未验不得生产 |
| 缓存 key 不含 model/prompt/input/chunk config | P0 | 缓存污染即整批无效并重跑 |
| 超时后缩短证据/跳过 OCR、ASR、shot 或 QC | P0 | 禁止静默降级；记录 blocked/needs_review |
| 并发过高导致限流重试、顺序污染或重复成本 | P1 | 记录 provider request/retry；受控并发与退避 |
| 只看 HTTP 200/terminal succeeded 作为性能成功 | P1 | performance 与 quality gate 分列 |
| 热缓存 benchmark 冒充真实冷启动 | P1 | 冷/热结果分组，发布时以冷缓存门为主 |

该补充协议不授权部署、付费操作或降低任何安全门禁。
