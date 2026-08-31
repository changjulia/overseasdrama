# B 模式受控音轨上传：端到端验收与安全负例

状态：**组件与上传链路部分通过；完整 B 模式业务 E2E 仍未通过**。本文件是独立验收规格，不把静态契约或上传 E2E 表述为完整成片闭环。

## 当前代码事实

- UI 已改为真实文件选择和受控上传，提供进度、取消、错误与资产元数据，不再提供任意 URL 输入。
- PocketBase 已有按项目关联、级联删除且禁止通用 CRUD 的 `narration_audio_assets`；上传经鉴权、同源 CSRF 网关和服务端 ffprobe/SHA-256 校验。
- fresh PocketBase multipart E2E 已证明：未认证 401、跨站 403、真实 WAV 上传、服务端 hash/时长、签名媒体读取、伪造 hash、格式伪装和伪造时长拒绝。
- 项目保存会重建受信 worker URL，并核对资产归属、状态、hash、大小、MIME 和时长；预览入口再次核对项目归属、状态、hash 和大小。
- 通用 UI 编辑路径会递增 transition version 并清空预览与审核状态；但已经持久化的资产在独立替换/删除事件下是否立即使服务端批准失效，尚无真实 E2E。
- worker 同源下载、混音和字幕组件已有测试，但“上传该资产→真实 B 审核片→批准→最终成片”尚未由同一条 fresh 业务 E2E 贯通。

## 自动审计结果

`tests/narration-audio-upload-acceptance.test.mjs` 当前为 **18 项通过、0 项 TODO**。fresh hosted runtime 证据已覆盖真实上传、worker 预览/最终渲染血缘、资产替换/删除失效、A/B/direct-cut 未批准或驳回时的最终渲染与导出拒绝、通用文件路由拒绝，以及安全负例。超限实体在显式 `Content-Length` 下返回 413；托管网关对缺少 `Content-Length` 的旁白上传统一 fail-closed 为 411，防止无界 chunked multipart 造成转发挂起。两条路径都核对了资产记录与 PocketBase 存储文件清单，未产生孤儿或 partial 文件。其中部分 UI 约束仍是静态生产契约，不单独替代完整业务 E2E 和内容人工验收。

## 最小可上线契约

1. UI 仅提供真实文件选择器，允许用户看到文件名、探测后的格式、时长、大小、上传进度与明确错误；不允许粘贴任意 URL。
2. 上传必须走真实 ChatGPT 鉴权和同源 CSRF 网关，再由 PocketBase 保存到与 `factory_project` 强关联、级联删除的专用资产记录。单文件上限 100 MiB，请求总长度上限 101 MiB（含 multipart 固定余量）；托管入口必须收到有效 `Content-Length`，边缘层若剔除该头则返回 411，不允许降级为无界 chunked 上传。格式以实际 ffprobe 解码结果为准。
3. 服务端返回不可由客户端自行声明的资产身份：`collection`、`recordId`、`fileName`、`projectId`、`byteSize`、`sha256`、`detectedMime`、`durationSeconds`、`createdAt`。项目只保存这份引用，不保存任意 `audioUrl` 作为渲染依据。
4. 通用 `/api/files` 必须拒绝旁白资产，避免绕过项目媒体路由；worker 只通过 HMAC 签名的同源媒体 URL 读取，并校验下载内容。若未来提供浏览器试听，必须另设有用户鉴权的受控播放入口，不能复用 worker token URL。
5. 项目保存、预览入队和最终渲染都重新验证：资产存在、属于当前项目、文件名仍一致、sha256 未变化、含可解码音轨、时长与 60–100 秒脚本窗口相容。
6. 上传成功、换轨、删轨，以及脚本、语言、语速、时长、ducking、关键原声窗口的任何变化，都必须递增 transition version，清空 preview URL/hash，并把审核置回 pending。失败上传不得破坏当前有效选择。
7. 预览和最终成片的 validation 必须记录同一 `audioAssetId`、`audioSha256`、`transitionVersion`；批准请求仍绑定最新 preview version/hash。

## 真实链路验收

不得直接写数据库或用夹具绕过入口。使用 fresh PocketBase、构建后的托管网关和真实 worker：

1. 从内容工厂 UI 选择 B 模式，选择一条真实 60–100 秒音频并上传。
2. 记录浏览器请求、用户身份、Origin/CSRF 结果、项目 ID、资产记录 ID、PB 文件名、字节数、sha256 和 ffprobe 格式/时长。
3. 通过 UI 保存项目；确认项目只引用当前项目的 server-issued asset identity。
4. 从 UI 创建真实过渡预览，让 worker 领取并下载 PB 文件；校验日志与文件 sha256。
5. 在浏览器播放“钩子尾 10 秒＋过渡＋正片头 20 秒”，人工检查旁白、字幕、安全区、音量与关键原声。
6. 从 UI 批准，随后更换音轨或编辑脚本；确认旧批准立即失效且最终渲染被拒绝。
7. 重新生成、批准、渲染最终成片；确认 preview/final validation 的资产 sha256 与 transition version 一致。

## 必须覆盖的拒绝矩阵

| 场景 | 预期 | 持久化不变量 |
| --- | --- | --- |
| 未认证上传 | 401 | 不产生记录或文件 |
| 跨站 multipart / 缺少同源上下文 | 403 | 请求体不被转发 |
| `.mp3` 名称与 `audio/mpeg`，内容却是文本、图片或视频 | 4xx | 不产生资产；记录探测失败 |
| 声称较小但流式内容超过 100 MiB | 413/4xx | 临时文件删除，不留下孤儿记录 |
| 0 字节、损坏文件、无音轨媒体 | 4xx | 不改变当前有效音轨 |
| A 项目引用 B 项目资产 | 403/4xx | 不泄露 B 的文件元数据或内容 |
| 任意公网/内网 URL、相对路径、伪造 record/fileName | 4xx | worker 不发起请求 |
| 文件被替换、删除或 hash 改变 | 409/4xx | 旧预览和批准不可复用 |
| 上传成功后编辑脚本/语言/语速/时长/混音 | 保存成功但审核重置 | version 增加，preview hash 清空 |
| 上传失败后重试 | 可恢复 | 原有效资产仍选中，无重复/孤儿文件 |

每个运行用例保留：UI 截图、请求/响应摘要、真实输入 ID、PB 状态、worker 日志、输入与下载文件 hash、ffprobe 输出、人工结论。敏感 token、cookie 和签名参数必须脱敏。
