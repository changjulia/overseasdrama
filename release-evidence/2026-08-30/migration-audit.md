# PocketBase 迁移前向／回滚兼容性审计

- 审计日期：2026-08-30
- 范围：`pb_migrations/*.js`，共 36 个迁移
- 审计方式：静态逐文件检查 `up`、`down`、数据改写、约束变化、访问规则和旧版本读写路径
- 明确边界：本次未执行生产迁移、生产回滚或生产数据写入。现有 fresh PocketBase 测试只能证明空库前向建库可执行，不能替代带真实数据的升级／回滚演练。

## 判定口径

- **Reversible**：存在对应 `down`，且在满足注明前置条件时可恢复旧 schema。若 `down` 会删除新字段、集合或文件，仍标记为“有损可逆”，不得在无备份时用于生产回滚。
- **Forward-fix**：数据改写不可逆、`down` 为空、不精确恢复旧定义，或回滚可能因新数据不满足旧约束而失败；生产故障应优先新增前向修复迁移。
- **旧版本兼容**：指旧应用在新 schema 上继续读取／写入的可能性。它不代表新应用可以在旧 schema 上运行。

## 结论

当前迁移链适合“备份后只向前升级”，不具备可直接承诺的一键无损回滚能力。

- 36 个迁移中，27 个有 schema `down`，但创建集合或删除新增字段的 `down` 都会丢失迁移后数据。
- 6 个数据迁移明确不回滚：时间戳回填、ontology 回填、三轮素材标题归一化，以及标题排序修正；应使用新的 forward-fix 修正。
- `1786595500` 的 `down` 没有恢复最初的 `video/*`，而是写成空 MIME 列表，属于不精确回滚。
- `1787569200` 回滚会收缩枚举，却未先处理 `1_5m` 数据，带真实短时长记录时存在回滚失败／数据失效风险。
- `1787570100` 回滚重新启用 `free_episodes.required`，未回填空值，可能被新数据阻断。
- `1787570800` 的安全锁定会有意中断旧版浏览器直连 PocketBase；上线必须与认证 gateway 同批切换，回滚该迁移会重新开放匿名规则，不能作为普通应用回滚步骤。
- `1787570900` 回滚会删除旁白音轨记录和关联文件，必须视为灾难性有损操作。

## 逐迁移审计

| 迁移 | 类型与可逆性 | 主要风险／推荐动作 | 旧版本读取兼容性 |
|---|---|---|---|
| `1786594000_create_drama_library.js` | **Reversible（有损）**：down 依次删除分集和剧目集合。 | 回滚永久删除剧目、视频、海报和分析 JSON；仅限空库或已验证全量备份恢复。 | 新建基础集合本身无旧 schema 兼容问题；比此版本更旧的应用没有该功能。 |
| `1786595000_create_analysis_jobs.js` | **Reversible（有损）**：down 删除任务集合和新增状态字段。 | up 会为所有既有视频创建 coarse 任务并把分集状态改为 `queued`；down 不恢复迁移前 `analysis_status`，任务历史也丢失。生产回滚优先 forward-fix。 | 新增字段对按名称读取的旧客户端通常透明；旧 worker 可能观察到新排队任务并重复消费，升级时需停旧 worker。 |
| `1786595100_add_analysis_timestamps.js` | **Reversible（字段数据有损）**：down 恢复旧索引并删时间字段。 | 回滚丢失任务时间信息；索引替换期间需关注大表锁时长。 | 字段为自动字段，旧 reader/writer 可忽略；旧查询仍可使用原 status/stage。 |
| `1786595200_backfill_analysis_timestamps.js` | **Forward-fix**：down 为空。 | 所有缺失时间被同一个迁移时刻覆盖，无法还原真实创建时间；超过 10,000 条不会被本迁移覆盖。应另建补偿迁移。 | 仅填已有字段，旧代码通常兼容。 |
| `1786595300_hide_analysis_lease_token.js` | **Reversible**：仅切换字段 `hidden`。 | 回滚会重新把租约 token 暴露在普通 API 序列化中，属于安全降级；不建议因应用问题回滚。 | 旧客户端若错误依赖读取 lease token，会在 up 后失效；worker 自定义接口不应依赖公开字段。 |
| `1786595400_create_ad_material_analysis.js` | **Reversible（有损）**：down 删除素材与任务集合。 | 删除集合会删除上传视频、封面、分析结果及任务；只允许空库或可恢复备份。 | 新功能集合对旧应用无影响；初始匿名规则随后会被安全迁移收紧。 |
| `1786595500_fix_ad_material_video_mimes.js` | **Forward-fix**：down 设置 `mimeTypes=[]`，未恢复最初的 `['video/*']`。 | 不精确回滚；不同 PocketBase 版本对空列表语义可能不同。需要精确恢复时新增迁移明确 MIME 列表。 | up 收紧到常见视频格式，旧客户端上传列表外格式会被拒绝；已有文件读取不受影响。 |
| `1786595600_add_material_analysis_v2_fields.js` | **Reversible（字段数据有损）**。 | down 删除 V2 结果、校准、归因等字段及索引；应用降级前必须确认旧代码不再写 V2，并备份 JSON。 | 全部新增字段非必填，旧读写基本兼容。 |
| `1786595700_add_material_intake_fields.js` | **Reversible（字段数据有损）**。 | 唯一内容哈希索引在已有非空重复值时会使 up 失败；当前迁移没有预检／去重。down 丢失来源 URL、rights 和 hash。 | 新字段可选，旧客户端兼容；旧写入不产生 hash，去重能力会退化但不会被 schema 拒绝。 |
| `1786595800_add_paused_analysis_status.js` | **Reversible（语义有损）**：down 先把 paused 改回 queued。 | 回滚会让人工暂停任务重新进入消费队列；执行 down 前必须停 worker 并记录暂停清单。 | 枚举扩展对旧 reader 通常兼容，但旧代码若使用封闭枚举可能无法展示／处理 `paused`。 |
| `1786969600_create_hook_factory_pipeline.js` | **Reversible（灾难性有损）**：down 删除 5 个生产集合。 | 会删除钩子、匹配、任务、项目、渲染文件与审核血缘；生产不得用作常规回滚。 | 新集合不影响旧基础链；旧应用不认识 factory 数据但可继续使用剧库／素材。 |
| `1786970200_allow_zero_hook_start.js` | **Reversible（有条件）**：把 `start_seconds.min` 从 1 降到 0，再可升回 1。 | 若已有 `start_seconds=0`，down 会因旧约束不满足而失败或使记录无效；回滚前需迁移这些记录，但业务上 0 秒是合法边界，推荐 forward-fix。 | up 放宽写入，旧读取兼容；旧 writer 不受影响。 |
| `1786970800_extend_factory_production.js` | **Reversible（字段数据有损）**。 | down 丢失多钩子／多匹配关系及 render worker 租约、尝试次数；降级时可能遗留正在执行的 worker。 | 新字段非必填，旧客户端可读取旧字段；新 worker 与旧 schema 不兼容。 |
| `1786971000_add_factory_render_urls.js` | **Reversible（字段数据有损）**。 | down 丢失真实预览／输出地址和 SHA，历史成片将不可追溯；优先 forward-fix。 | 可选文本字段，旧客户端兼容。 |
| `1786971200_add_factory_history_lineage.js` | **Reversible（字段数据有损）**。 | down 丢失父项目、fork 原因和版本快照；不会删除子项目本体，但审计链断裂。 | 可选字段，旧客户端兼容。 |
| `1786971300_add_factory_output_parameters.js` | **Reversible（字段数据有损）**。 | down 丢失画幅和语言；降级后旧代码可能以默认值渲染，需冻结新渲染任务。 | 可选字段，旧客户端兼容；旧 writer 留空时新代码必须有安全默认值。 |
| `1786971400_add_story_match_job_lineage.js` | **Reversible（字段数据有损）**。 | down 丢失 match→job 血缘，不影响 match 记录本身。 | 可选关系，旧客户端兼容。 |
| `1787040000_add_analysis_quality_contracts.js` | **Reversible（高价值数据有损）**。 | down 删除 ontology、story/event graph、calibration、production gate 等质量证据；会直接破坏当前人工验收可追溯性。 | JSON 字段均非必填，旧代码通常兼容。 |
| `1787040100_add_hook_match_context_contract.js` | **Reversible（高价值数据有损）**。 | down 删除付费范围、上下文哈希、质量分、business gate 与标签证据；降级会失去生产门禁依据。 | 新字段非必填，旧 reader/writer 可运行，但旧 writer 产生的记录缺少新门禁证据，必须由新代码拒绝进入生产。 |
| `1787040200_add_hook_match_execution_v2.js` | **Reversible（灾难性有损）**。 | down 删除精细入口／补充高光任务集合及付费确认、override、contract/legacy 字段；所有队列历史消失。执行 up 前需确认依赖集合已存在。 | 新字段非必填且新集合独立，旧应用基本兼容；旧 worker 不应领取新集合任务。 |
| `1787040300_add_hook_match_outcome.js` | **Reversible（字段数据有损）**。 | down 丢失 outcome、diagnostics 和版本，任务仍在但完成语义退化。 | 可选字段，旧代码兼容；旧 UI 可能无法区分 partial/no-candidates。 |
| `1787569200_add_short_factory_duration_band.js` | **Forward-fix / 高风险回滚**：down 直接移除 `1_5m` 枚举值。 | 若任一 job/match 已写 `1_5m`，down 无预处理，可能保存 schema 失败或产生非法值。回滚前必须把数据显式映射，且映射会丢失业务语义。 | up 是枚举扩展；旧代码若使用封闭枚举可能拒绝或误显示 `1_5m`。 |
| `1787569300_create_historical_templates.js` | **Reversible（有损）**：down 删除模板集合。 | 删除历史表现证据、审核状态和模板快照；只应在空集合回滚。 | 新集合独立，对旧应用无影响。 |
| `1787569400_backfill_drama_ontology_tags.js` | **Forward-fix**：数据保留，down 明确不清理。 | migration VM 无法加载 hook 时会静默跳过，造成“迁移已应用但部分／全部数据未回填”；并有 100,000 剧、每剧 10,000 集上限。上线前必须运行覆盖率核验或显式重投影任务。 | 只写已由先前迁移创建的 JSON 字段，旧代码可忽略；不会改变核心标题或关系字段。 |
| `1787569500_add_hook_attribution.js` | **Reversible（字段数据有损）**。 | down 丢失来源判定和装配类型，直接影响外搭分层评测；不建议回滚。 | 可选枚举，旧代码兼容；旧写入会留下空归因，需人工复核。 |
| `1787570000_add_external_drama_source.js` | **Reversible（字段数据有损）**。 | down 丢失外部源平台、record ID、获取方式和元数据，无法追溯接口导入剧目。 | 可选字段，旧代码兼容；旧 writer 不提供来源血缘。 |
| `1787570100_allow_zero_free_episodes.js` | **Forward-fix / 有条件回滚**：down 重设 required。 | up 允许空值；若新记录把 `free_episodes` 留空，down 未回填，会被旧约束阻断。数值 0 本身在原 schema 已允许，此迁移实际解决的是“未知／缺失”而非 0。 | up 放宽写入；旧 reader 必须区分空值和 0，否则会误判付费范围。 |
| `1787570200_optimize_material_intake_queue.js` | **Reversible（字段数据有损）**。 | down 丢失 intake 批次、错误、重试时间、优先级与 checkpoint；执行时必须停队列，否则任务恢复语义不一致。 | 新字段可选，旧 worker 可忽略；但旧 worker 不遵守 `next_attempt_at`，混跑会提前重试。 |
| `1787570300_add_material_source_identity_hash.js` | **Reversible（字段数据有损）**。 | up 的唯一索引会在既有重复非空 hash 时失败；迁移自身未回填，所以首次 up 通常安全，后续回滚再升级需先查重。 | 可选字段，旧写入兼容但不会获得来源级去重。 |
| `1787570400_rank_ad_material_titles.js` | **Forward-fix**：标题原值未保存，down 为空。 | 排名依赖 exposure 和 ID；会破坏把标题当外部稳定 ID 的消费者。最多处理 100,000 条。需要修正时必须从 source identity/备份重建。 | 旧 UI 若只展示标题可兼容；若解析 `ADX-*` 后缀或以 title 查找，会失效。 |
| `1787570500_normalize_all_ad_material_titles.js` | **Forward-fix**：不可逆标题重写。 | 对无规范日期标题使用 `created` 推导；原始标题未存档，重复运行后的组排名可能变化。最多 100,000 条。 | 与上一条相同：展示兼容，依赖原始标题格式／唯一性的旧代码不兼容。 |
| `1787570600_rank_legacy_bare_ad_material_titles.js` | **Forward-fix（高数据质量风险）**。 | 找不到同 base 日期时硬编码 `20260825`，会制造并非来自素材证据的日期；原名不可恢复。上线前应抽检并以 source metadata 前向修正。 | 旧标题解析／按名检索不兼容；纯展示通常可用。 |
| `1787570700_add_worker_retry_backoff.js` | **Reversible（运行状态有损）**。 | down 丢失所有 worker lane 的 next retry 和 error kind；旧 worker 混跑会无视退避。回滚或升级须先停 worker、清租约并记录失败队列。 | 新字段可选，旧 worker schema 可读，但行为不兼容（会提前重试永久／媒体错误）。 |
| `1787570800_lock_hosted_collections.js` | **Reversible（安全高风险）**：down 恢复硬编码旧规则。 | up 会中断所有匿名 PocketBase 直连，必须先验证认证 gateway、worker token 路由和文件白名单；down 会重新开放多个集合的匿名读写，可能与迁移前实际规则漂移，不可当普通回滚。 | **不兼容旧直连客户端**，这是预期安全断点；仅经新版 gateway 的客户端兼容。旧 worker hook 通过 `e.app` 不受规则影响。 |
| `1787570900_create_narration_audio_assets.js` | **Reversible（灾难性有损）**：down 删除集合。 | cascade 项目删除会删资产；迁移 down 会删除全部音频文件、probe、SHA 和上传血缘。上线后禁止无备份回滚。 | 新集合为 superuser-only，自定义上传／签名媒体接口之外的旧客户端不可见；对其他旧功能无影响。 |
| `1787571000_add_manual_retry_audit.js` | **Reversible（审计数据有损）**：down 删除人工重试审计、幂等键、server-owned updated 和 render retry_of，但不删任务或媒体。 | 回滚会永久切断人工重试操作者/原因/次数和失败 render→新版本血缘；旧 retry UI 也失去乐观锁字段。只能在停用新 retry API 后降级，生产优先 forward-fix。 | 新字段不改变旧队列核心读写；但新版 retry API 依赖 updated/audit/key，旧 schema 不兼容。旧应用可忽略字段，新旧 writer 不应混跑人工重试。 |

## 上线与回滚门禁

1. 升级前生成 PocketBase 数据库与 `pb_data/storage` 同一时点快照，并在隔离目录实际恢复一次；只备份 SQLite 不足以恢复视频、渲染和旁白文件。
2. 在预发布复制数据上执行完整 `migrate up`，记录迁移前后 schema hash、集合记录数、文件数／字节数，以及唯一索引冲突检查。
3. 应用、gateway 与 worker 采用兼容窗口：先部署能容忍新旧可选字段的 reader，再迁移 schema，再启用新 writer。`1787570800` 例外，必须将 gateway 可用性验证作为同批原子切换门禁。
4. 迁移期间停发新分析／匹配／渲染任务，并停止旧 worker；恢复后检查 queued/running lease 和 `next_attempt_at`，避免重复消费。
5. 禁止把 `migrate down` 当默认故障恢复。涉及集合删除、字段删除、枚举收缩、required 收紧、匿名规则恢复或数据标题改写时，一律走 forward-fix 或整库快照恢复。
6. 上线前补自动化数据检查：`1_5m` 枚举使用量、空 `free_episodes`、两类 hash 重复、ontology 回填覆盖率、标题迁移异常率、各队列活动租约、旁白资产记录与存储文件一致性。
7. 回滚演练必须同时验证旧应用返回质量；HTTP 200 或 schema 保存成功不能证明旧版本能正确理解 `paused`、`1_5m`、空付费范围、新标题格式及缺失的新生产门禁字段。

## 当前上线判定

**NO-GO（迁移回滚能力尚未形成可执行证据）**。代码层已有 fresh 空库前向迁移证据，但仍缺少：真实数据副本升级、文件与数据库一致快照恢复、唯一索引冲突预检、枚举／required 回滚预处理，以及新版到旧版应用兼容演练。生产部署仍需用户明确授权。
