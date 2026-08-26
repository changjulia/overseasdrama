# Lumina Growth OS

面向海外短剧发行团队的 AI 增长操作系统原型，目标是打通免费章节分析、自动素材剪辑、社媒分发与广告实验。

## 当前能力

- 浅色专业商务风增长控制台
- 剧集管理、自动剪辑、素材工厂、发布中心与广告实验页面
- 免费章节范围硬限制
- ElevenLabs Scribe v2 批量转写适配器
- 词级时间码、说话人分离与声音事件
- 文件指纹缓存、失败重试与费用预估
- 按剧集生成压缩转写文本和批任务报告

## 本地运行

要求 Node.js `>=22.13.0` 和 Python 3。

```bash
npm install
npm run dev
```

## PocketBase 剧库

剧目元数据、海报和分集视频保存在项目独立的 PocketBase 中。先指定 PocketBase 可执行文件（未指定时脚本使用当前开发机上的默认路径），再启动服务：

```powershell
$env:POCKETBASE_EXE = "C:\path\to\pocketbase.exe"
.\scripts\start-pocketbase.ps1
```

默认地址为 `http://127.0.0.1:8090`，数据写入忽略提交的 `pb_data/`。集合由 `pb_migrations/` 自动创建。如需使用其他地址，启动前设置 `NEXT_PUBLIC_POCKETBASE_URL` 并重新启动前端。

macOS / Linux 可直接启动完整本地开发环境（首次运行会下载项目固定版本的 PocketBase，并从脱敏快照初始化数据库）：

```bash
npm run dev:full
```

也可以只启动数据服务：

```bash
npm run pocketbase:start
```

默认开发地址为终端输出的 Local URL。

## 真实三级分析 worker

剧集视频、任务与分析结果全部保存在 PocketBase，不依赖 D1/R2。设置相同令牌后分别启动 PocketBase 和 worker：

```powershell
$env:LUMINA_WORKER_TOKEN = "replace-with-a-secret"
.\scripts\start-pocketbase.ps1
.\scripts\start-analysis-worker.ps1
```

分析需要 FFmpeg/FFprobe、`processor/requirements-analysis.txt` 中的依赖，以及 `LUMINA_WHISPER_MODEL`、`LUMINA_SEMANTIC_ENDPOINT`、`LUMINA_SEMANTIC_API_KEY`、`LUMINA_SEMANTIC_MODEL`。缺少任一真实能力时任务会进入 `failed` 并保留错误，不会伪造成功。

## 批量转写

复制环境变量模板并填写 ElevenLabs API Key：

```bash
cp .env.example .env
```

仅扫描剧集并预估费用：

```bash
python3 -m processor.batch_transcribe "/path/to/dramas" --free-episodes 10 --estimate-only
```

正式批量转写：

```bash
python3 -m processor.batch_transcribe "/path/to/dramas" --free-episodes 10 --workers 3
```

源视频不会被修改。处理结果写入剧集目录下的 `edit/`，该目录默认不进入 Git。

## 验证

```bash
python3 -m unittest tests/test_processor.py
npm run build
```

## 外部短剧数据接口

月榜、全集播放地址和 ADX 素材查询通过服务端代理接入，浏览器端不会接触上游 API Key。启动前配置：

```powershell
$env:EXTERNAL_OPEN_API_KEY = "由服务方提供的 API Key"
$env:EXTERNAL_OPEN_API_BASE_URL = "http://121.41.8.142:3000/api/open/v1"
npm run dev
```

应用内接口分别为：

- `GET /api/external-data/rankings?month=YYYY-MM`
- `GET /api/external-data/playback?name=完整剧名`
- `POST /api/external-data/materials`

生产环境必须把 `EXTERNAL_OPEN_API_BASE_URL` 换成服务方提供的 HTTPS 地址。

## 安全

- `.env`、API Key、缓存和本地视频不会提交到仓库。
- 默认只处理每部剧设定的免费章节。
- 相同源文件会命中转写缓存，避免重复计费。

## 状态

当前为 MVP 开发阶段。Scribe 转写底座和产品前端已完成；画面分析、音画融合、自动 EDL 与 FFmpeg 渲染仍在建设中。
