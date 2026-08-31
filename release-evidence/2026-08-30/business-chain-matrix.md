# 完整业务功能链条验收矩阵

版本：2026-08-30
范围：本地/验收环境，不执行生产部署
当前总状态：`NO-GO — business_pending`

## 判定边界

- 最终验收必须从真实 UI 或公开 API 生产入口发起，并经过真实 worker、存储、QC、发布、轮询、审核与导出路径。禁止直接写数据库，禁止用测试夹具、mock、合成媒体或手工改状态绕过任何生产入口。
- 组件测试、契约测试、隔离 PocketBase、合成媒体和失败注入只能记为 `component_passed`；它们不能证明完整业务 E2E，也不能替代真实内容质量人工审核。
- HTTP 200、字段非空、任务显示成功不等于内容质量通过。每站必须人工检查语义正确性、时间码/因果、人物关系、安全边界及可播放性。
- 状态枚举：`not_run`、`blocked`、`failed`、`component_passed`、`business_passed`、`quality_passed`。只有生产入口链路通过且内容人工抽检通过，相关站点才可同时具备 `business_passed` 与 `quality_passed` 结论。
- 当前真实验收已有 `dramas=1`、`drama_episodes=10`；`hook_assets=0`、`factory_projects=0`、`factory_renders=0`。剧集数据与分析任务已进入真实链路，但仍不存在完整业务通过结论。

## 主链路矩阵

| ID | 验收站 | 真实输入 ID（执行时填写） | UI/API 动作 | 预期数据库状态 | 输出内容质量人工抽检 | 截图/日志 | 文件 SHA-256 | 人工结论 | 缺陷 ID | 状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| BC-01 | 数据源/本地剧目导入 → 剧库列表、详情、分集播放 | drama `s2mhnmm4t9q9yud`；dramawave `3CRScaBEY0`；episode IDs 与 hash 见 intake 证据 | 真实 Chrome UI：数据源管理→playback→前10集验收入库→剧库列表→详情→EP1 播放。生产 HTTPS 强制保护保持不变 | `dramas=1`；`drama_episodes=10`，EP1～10 均为持久化 MP4，权限标记为用户授权内部验收 | 数量、集号、字节、ffprobe 时长、hash、EP1 可播放已核；EP2 已确认无音轨，逐集完整人工播放/seek 仍待完成 | `release-evidence/2026-08-31/lycan-first10-intake.md` | 逐集 SHA-256 已记录于 intake 证据 | 查询、落盘、入库、列表、详情和 EP1 播放子链真实通过；整站仍待逐集播放质检 | `DATA-001` | `in_progress` |
| BC-02 | 前 10 集任务创建 → 粗/细/高光分析 → 状态、进度、失败重试、回写 | drama `s2mhnmm4t9q9yud`；Golden `QS-DRAMA-LYCAN-DW-EP01-10/v1`；detail job `vlpc5yoodbf1d43` | Golden 冻结后由真实 Chrome UI 保存粗解析 10、重点集 1–10、自动精析；真实 worker 完成粗解析并进入 Detail；请求过大 HTTP 400 后由正式 retry 路径同 ID 重试 | 粗解析 10/10 succeeded；Detail 首试失败已留痕，帧/请求预算修复后的真实重试正在运行；Precision 新增版本隔离和零候选待审状态 | 独立监督对首轮输出结论为内容 48/100、硬门禁 NO-GO；EP2/EP3/EP9 事实安全与 Golden Top3 0 命中为 P0，修复后必须同 Golden 复测 | Golden SHA `4f36c1df4593442974ac25ee9a3cec64ac10cff537894035eee1633389c96872`；`release-evidence/quality-supervision/cases/QS-DRAMA-LYCAN-DW-EP01-10/gap-report-v1.md` | EP1～10 输入 hash 见 intake；Golden hash 如左 | 工程粗/细局部链有真实证据，内容质量明确 NO-GO；本轮 Detail/Precision 终态待验 | `P0-DRAMA-LOCAL-UI-AUTH`、`P0-DETAIL-REQUEST-BUDGET`、`P0-DRAMA-CONTENT-SAFETY`、`P0-HIGHLIGHT-RECALL` | `in_progress` |
| BC-03 | 摘要、关系、因果、标签、高光候选及安全边界审核 | `TBD: analysis/result/review IDs` | 从分析结果 UI 打开审核；修改/批准/驳回并复查版本 | 审核状态、审核人、备注、版本、候选与安全边界持久化且可追溯 | 人工对照原片核验剧情摘要、人物关系、因果方向、标签、起止时间、台词/动作不截断及付费边界 | `TBD` | `TBD` | 尚无真实分析输出可审核 | — | `not_run` |
| BC-04 | 跑量素材采集/入库 → 灵感大屏 → 外搭、T1/T2、结构化分析、原型聚合筛选 | `TBD: source/hook/job/prototype IDs` | 从真实采集/入库入口提交约 40 条素材；在灵感大屏筛选、查看分析与原型 | 素材、来源证据等级、分析任务、外搭/T1/T2、结构化结果、原型聚合关联一致 | 分 8 题材抽检；每类检查异源外搭、人物资产复用外搭、原生/混合型；输出题材识别、外搭、T1/T2、完整率及跑量证据 | `TBD` | `TBD` | 当前 `hook_assets=0`，仅有 4 条分析任务，不能代替素材主记录 | `DATA-002` | `blocked` |
| BC-05 | 真实剧库/灵感大屏 → 内容工厂 → 钩子检索匹配、解释和质量分 | `TBD: drama/hook/match/project IDs` | 分别从剧库与灵感大屏进入内容工厂；检索并生成 Top3；选择候选 | `hook_match_jobs`、候选、解释、分数、所选钩子和项目引用一致，刷新后不丢失 | 总体及分题材核验 Top3 命中、故事完整度、留人、承诺兑现、连通性；做跨题材负例及少量合理迁移正例 | `TBD` | `TBD` | 无真实剧库/钩子数据，未跑业务链 | — | `not_run` |
| BC-06 | 过渡诊断 → A 转场词或 B 连续 60–100 秒解说 → 真实预览 → 人工批准 | `TBD: real project/transition/narration/review IDs` | 由系统诊断断层并推荐 A/B；B 经项目级受控上传真实音轨；生成真实预览；展示钩子末 10 秒＋过渡＋正片前 20 秒；修改/重生成/批准或驳回 | 正式 production object/version；B 音轨 assetId/hash/probe evidence；预览 hash 与批准绑定当前版本；未批准不可渲染 | 核验时间/因果、可理解性、ASS 可读性、60–100 秒时长/语速、最终 -14 LUFS、动态 ducking、acrossfade、关键原声、无台词截断、过渡后留人；不得虚构剧情 | `TBD` | `TBD` | A/B 技术组件及 B 上传→worker→预览→批准→最终渲染隔离 E2E 17/17 通过；真实素材链和盲评未跑 | `P0-TRANSITION` | `component_passed` |
| BC-07 | 项目保存/版本 → 入队 → worker 下载、合成、QC、原子发布 → 前端轮询 | `TBD: project/version/render/job IDs` | UI 保存版本；批准过渡后点击渲染；真实 worker 领取、下载、合成、QC、发布；前端轮询至终态 | `factory_projects`、版本、`factory_renders`、队列状态、重试、QC、发布路径与时间戳一致；只在 QC 通过后原子发布 | 人工核验最终成片画面、声音、字幕、过渡、时长、编码、完整性；文件 hash 与 UI/API 指向同一产物 | `TBD; component evidence: tests/e2e_episode_splice/README.md` | `TBD` | 隔离 PocketBase＋合成媒体队列 E2E 仅证明技术组件 | — | `component_passed` |
| BC-08 | 预览播放 → 人工审核 → 导出 → 我的创作/历史版本检索复播 | `TBD: render/review/export/history IDs` | UI 播放完整预览；批准/驳回；导出；在我的创作和历史版本检索并复播下载产物 | 审核、导出、历史版本、产物 URL/权限和审计记录一致；刷新/重登后仍可检索 | 完整播放并检查首尾、随机 seek、音画同步、版本对应、下载后 hash；人工记录内容结论 | `TBD; component evidence: tests/e2e_episode_splice/README.md` | `TBD` | 合成夹具覆盖 review/export 仅为组件证据，未走真实 UI 全链 | — | `component_passed` |

## 异常链路矩阵

| ID | 异常场景 | 真实输入 ID（执行时填写） | UI/API/worker 动作 | 预期数据库状态与产品反馈 | 内容/恢复人工抽检 | 截图/日志 | 文件 SHA-256 | 人工结论 | 缺陷 ID | 状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| EX-01 | 分析失败 | `TBD real case`; fresh runtime component IDs generated in test | 从真实任务入口触发确定性失败，页面查看并按 job-id 重试 | UI 显示 error/error_kind/attempt/current_stage；重试必填原因、幂等键和乐观锁，活动 lease 不可撤销，旧结果清理并保留审计 | 任务中心组件和 fresh PB runtime 已通过；真实内容失败待跑 | `tests/manual-job-retry-runtime.test.mjs`; `tests/manual-retry-ui-contract.test.mjs` | `N/A` | 安全重试组件通过，真实业务 case 待验 | `P0-RETRY` | `component_passed` |
| EX-02 | worker 重启/超时 | `TBD` | 任务执行中重启 worker；制造 lease/处理超时 | 无重复发布；任务可续租/回收/重试；次数和终态一致 | 前端不会永久假进度，恢复后产物唯一 | `TBD; component evidence: failure-injection/result.json` | `TBD` | 已有 transient/permanent 分类测试仅为组件级 | — | `component_passed` |
| EX-03 | 素材 404 | `TBD` | 生产入口引用随后不可达的真实验收素材 | 明确失败且不发布；错误关联素材和任务 | UI 信息可行动，不静默降级 | `failure-injection/README.md` | `N/A` | 离线失败注入通过，业务反馈待验 | — | `component_passed` |
| EX-04 | 素材损坏 | `TBD` | 生产入口提交损坏媒体 | 探测/解码失败，不发布临时或残缺产物 | 错误定位正确，可替换素材重试 | `failure-injection/README.md` | `TBD` | 离线失败注入通过，业务反馈待验 | — | `component_passed` |
| EX-05 | 无音轨 | `TBD` | 生产入口提交无音轨素材 | QC 阻断并保留可审计原因，不发布 | UI 明示音轨缺失及修复方式 | `failure-injection/README.md` | `TBD` | QC 组件测试通过，真实 UI/API 链待验 | — | `component_passed` |
| EX-06 | 付费范围未确认 | `TBD` | 未确认可用集数/权限时尝试分析或制作 | 创建/渲染被阻断，不能越过授权范围 | 提示明确且确认后可继续 | `TBD` | `N/A` | 未跑 | — | `not_run` |
| EX-07 | 过渡未批准 | `TBD: real business project IDs`; component records generated by fresh hosted E2E | 保存 A pending、B rejected、direct_cut draft，及替换/删除 B 音轨后尝试渲染/导出 | 服务端均返回 400 并命中 `transition review must be approved`；音轨变更使旧批准和旧成片导出失效 | hosted API 负链 19/19 通过；真实 UI 提示与业务素材仍待验 | `tests/hosted-pocketbase-runtime-e2e.test.mjs`; `tests/narration-audio-upload-acceptance.md` | `N/A` | 组件级服务端门禁通过，真实业务入口待跑 | `P0-TRANSITION` | `component_passed` |
| EX-08 | QC 失败 | `TBD` | 真实任务制造可验证 QC 不合格产物 | 失败终态；临时文件不可见；无部分发布 | UI 展示具体 QC 项；修复后重跑得到新版本 | `failure-injection/README.md` | `TBD` | 时长漂移/编码/QC 原子发布组件测试通过 | — | `component_passed` |
| EX-09 | 导出/渲染重试 | `TBD real case`; fresh runtime component IDs generated in test | 失败 render 从 UI 以审计原因重试，创建新版本后重新审核/导出 | 旧失败记录不可变，新 render 记录 `retry_of`；旧审批清空且不能误导出新产物 | fresh PB/runtime 与 UI 契约通过；真实下载中断及最终 hash 待跑 | `tests/manual-job-retry-runtime.test.mjs`; `tests/manual-retry-ui-contract.test.mjs` | `TBD` | 版本/审批隔离组件通过，真实业务 case 待验 | `P0-RETRY` | `component_passed` |

## 执行与取证命令

以下命令只用于启动本地完整环境、记录组件基线和计算证据 hash；最终业务验收动作必须在真实 UI/API 入口完成。

```bash
npm run runtime:check
npm run dev:full
npm run workers:start
python3 -m unittest -v tests.e2e_episode_splice.test_episode_splice_queue_e2e
npm run test:media-e2e
python3 -m unittest -v tests.failure_injection.test_release_failure_injection
shasum -a 256 /absolute/path/to/input-or-output.mp4
```

建议把终端输出保存为纯文本，并在每次执行前记录 commit、配置摘要（不得含密钥）、浏览器版本、PocketBase/worker 版本和开始/结束时间。数据库状态必须通过只读 API 或只读查询取证；不得为了“凑状态”直接写库。

## 截图、日志与文件命名规范

统一格式：`<case-id>__<step>__<input-id>__<UTC-YYYYMMDDTHHMMSSZ>.<ext>`。

示例：

- `BC-01__episode-03-playback__drama-abc__20260830T140501Z.png`
- `BC-07__worker-qc-pass__render-r123__20260830T142233Z.log`
- `EX-08__qc-rejected__render-r124__20260830T143010Z.json`
- `BC-08__exported-master__render-r123__20260830T144100Z.sha256`

每张截图需包含可识别的页面/步骤、输入 ID、状态和时间；敏感令牌必须遮盖。日志保留请求 ID、任务 ID、worker 尝试号和时间戳。视频/音频/JSON 输出及关键输入均记录 SHA-256；截图也建议计算 hash。

## Go / No-Go 汇总

### BC-04 增量取证（2026-08-30 22:47 CST）

v9 最新结论（取代下文 v7/“等待 v8”进度描述）：独立监督 v8 已关闭拒绝项状态与边界契约两个 P1；v9 确认缺声纹/唇动归因的两个人物候选及 `mention_response` 均为 unverified，已验证对白事实保留，speakerVerified=0，无新泄漏。范围分为 79，内容仍因跪地服从/旁观者震惊没有 accepted 视觉事实而 `NO-GO`。

真实浏览器已经受限本地网关读取锁定的 PocketBase 数据，页面显示“数据连接正常”、`ad_materials=4` 和素材真实任务状态。BC-04 的“已入库素材→灵感大屏可见”子步骤有业务证据。真实 job `30wqqaz0u3vav09` 现经正式 UI API 重试→worker 路径为 `succeeded/100%`，且以 `force_semantic_refresh=false` 复用已存语义缓存；投影为 `TX`、source pending、format 未确定、hook=1（`15.1–23.9s`）、`needs_review`、production blocked。CTA 已与剧情高光分离，虚假完整已改为不完整，全发布图 invalid fact refs=0，错误跨事件命令关系已撤销。新增的多帧视觉事件契约已经真实 `qwen-vl-max` 和正式 worker 回写验证：`visualEventVerification` accepted=0、rejected=4、speakerVerified=0、reviewRequired=true；被拒项统一 `unverified/reviewRequired=true`，action/semantic boundary 保持 unverified，建议边界为正式 hook 15.1–23.9s。独立监督 v1～v7 范围归一分为 22→28→66→70→69→77→77；v7 确认幻觉未泄漏至可消费层，其发现的两个 P1 已修复并等待 v8 复测。内容仍因跪地服从/旁观者震惊没有 accepted 视觉事实而 `NO-GO`。其余素材、题材分层、来源镜头比对、原型聚合及内容质量阈值仍未完成。BC-04 整站不得标记 `business_passed`/`quality_passed`。

增量回归：`tests/local-ui-gateway-runtime.test.mjs` 在 fresh PB/无 superuser 下验证了锁定 collection 403、受限 CRUD、真实 MP4 首次上传/读取、同一剧集 multipart PATCH 媒体替换及新字节读取、越权拒绝和删除；真实浏览器点击素材后已显示播放对话框且无加载失败。PATCH 覆盖真实前10集重复导入时的已有记录更新路径，防止元数据更新但仍保留旧媒体。这些是 BC-01/BC-04 媒体入口的组件与局部业务证据，仍不代表完整入库、分析或内容质量通过。

| 门禁 | Go 条件 | 当前证据 | 当前判定 |
|---|---|---|---|
| 数据门禁 | 已授权且确认连续的前 10 集；约 40 条真实跑量素材按至少 8 题材分层，真实占比保留且每类至少 3 条 | 剧库和钩子主记录为空；候选 10 文件不支持连续集结论 | `NO-GO` |
| 完整业务 E2E | BC-01 至 BC-08 全部走真实 UI/API/worker，证据字段齐全，无直接写 DB/夹具绕行 | 仅局部组件证据 | `NO-GO` |
| 内容质量 | 所有站点完成规定人工抽检；输出总体和分题材指标；跨题材正负例通过 | 未产生真实业务输出 | `NO-GO` |
| 过渡门禁 | A/B 两模式真实渲染、人工批准、时间/因果/可读性/音量/留人通过；未批准服务端阻断 | 无业务级证据 | `NO-GO` |
| 异常恢复 | EX-01 至 EX-09 由生产入口验证，错误可见、可恢复、无错误发布 | 404/损坏/无音轨/QC/部分重试已有组件证据 | `NO-GO` |
| 证据完整性 | 每例具备真实 ID、动作、DB 状态、人工质量结论、截图/日志、hash、缺陷与复测证据 | 模板已建立，实测字段待填 | `NO-GO` |

上线判定规则：任一 P0、任一主链路站点未达 `business_passed`、任一必需质量抽检未达 `quality_passed`、或证据缺字段，均为 No-Go。即使所有组件测试通过，也不得对外表述为“完整功能闭环已通过”。本矩阵不授权且不执行生产部署。
