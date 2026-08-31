# 待输入监督登记

## QS-DRAMA-LYCAN-DW-EP01-10

- 剧名：`The Rise of the Lycan Queen`
- 数据源：`dramawave`
- 预期范围：连续第 1–10 集，集号必须严格为 `1,2,3,4,5,6,7,8,9,10`，不得混用 netshort 版本。
- 当前状态：`pending_input`；不创建 golden、不填媒体 hash、不填系统分。
- 当前阻塞证据：本机剪贴板所取凭据调用上游时返回 HTTP `401` / 业务码 `1003`（API Key 无效）。监督记录不得保存或输出 Key。
- 已知上游能力：播放契约应返回 `items[].total_episodes` 与完整 `episodes[{episode,url,type}]`；此前对该剧 dramawave 第 1–10 集签名 URL 使用 `GET Range: bytes=0-0` 均得到 HTTP `206`、`video/mp4`、首字节可读。
- 健康检查规则：对象存储 `HEAD` 可能返回 `403`；不得把 HEAD 403 判为失效。必须使用 `GET Range: bytes=0-0`，并核对 206、Content-Type、Content-Range 和可读字节。
- URL 时效：签名播放地址有效期约 86400 秒；恢复访问后应及时落盘、逐集计算 SHA-256，并只在监督台账记录脱敏后的剧目/集号/媒体 hash，不记录签名 URL。

### 预期真实输入标识

以下标识必须由真实 UI/API/worker 路径返回后填写，目前均为 `TBD`：

- 上游榜单月份/条目：`2026-07` / `The Rise of the Lycan Queen`
- playback source item：`dramawave`（真实 item/source ID：`TBD`）
- 本地 drama record ID：`TBD`
- episode record IDs（EP01–EP10）：`TBD`
- import job ID：`TBD`
- analysis task IDs（粗分析/细分析/高光）：`TBD`
- 分析版本、模型、提示词版本：`TBD`

### 真实 UI 入库门槛

1. 从真实月榜或剧名检索入口打开 playback 全集，不允许最终验收直接写数据库。
2. 在 UI 使用“全集加入剧库”或等价生产入口，选择 dramawave，并验证剧库列表、详情和 EP01–EP10 分集播放。
3. 落盘前逐集 Range GET；落盘后校验容器、视频流、时长、首尾可解码、连续集号与 SHA-256。
4. 创建“前 10 集分析”任务，记录状态、进度、失败重试和结果回写；人工复核剧情摘要、人物关系、因果、标签、高光 Top3 和安全边界。
5. 监督者在读取系统答案前，必须由未参与实现且未接触系统输出的评测者基于冻结的 EP01–EP10 独立制作剧集 golden。

### 不得误报

- 上游曾经 Range 206 只证明当时签名 URL 可读，不证明本轮已完成下载或 UI 入库。
- Key 401 不能被写成上游数据不存在。
- 本地目录、合成夹具、数据库直写或只验证 HTTP 200 均不能替代完整业务 E2E。
