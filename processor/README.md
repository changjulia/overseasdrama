# Lumina Scribe 转写模块

## PocketBase 三级解析任务

`drama_episodes.video` 是唯一片源。PocketBase 为已上传剧集创建带租约的 `analysis_jobs`；处理器调用 `semantic_analysis` 执行粗解析、整剧细解析和候选区间精解析。缺少真实依赖时任务会明确失败，不会生成模拟结果。

先安装 `processor/requirements-analysis.txt`，并确保 `ffprobe`、`ffmpeg` 可从 PATH 调用。PocketBase 和处理器必须使用同一个工作令牌：

```powershell
$env:LUMINA_WORKER_TOKEN = "replace-with-a-secret"
$env:LUMINA_WHISPER_MODEL = "small"
$env:LUMINA_SEMANTIC_ENDPOINT = "https://your-provider.example/analyze"
$env:LUMINA_SEMANTIC_API_KEY = "..."
$env:LUMINA_SEMANTIC_MODEL = "..."
.\scripts\start-pocketbase.ps1
.\scripts\start-analysis-worker.ps1

# Recommended: run independent drama/material workers.
.\scripts\start-analysis-workers.ps1
```

只领取并处理一个任务：

```bash
python3 -m processor.job_worker --once
```

Worker API 使用 `Authorization: Bearer $LUMINA_WORKER_TOKEN`。领取响应包含 lease token；只有租约持有者能续租或回写。失败任务在 `max_attempts` 内自动重试，也可以显式重新排队。

用于批量读取剧集目录，并生成带词级时间码、说话人和声音事件的转写结果。源视频不会被修改。

## 准备

1. 将 `.env.example` 复制为项目根目录的 `.env`，填写 `ELEVENLABS_API_KEY`。
2. 把一批剧集放在同一个目录中，可按剧名继续嵌套分集文件夹。

## 先扫描并预估费用

```bash
python3 -m processor.batch_transcribe "/path/to/dramas" --estimate-only
```

## 批量转写

```bash
python3 -m processor.batch_transcribe "/path/to/dramas" --workers 3
```

默认只处理每部剧前 10 个免费章节。免费集数不同时可显式调整：

```bash
python3 -m processor.batch_transcribe "/path/to/dramas" --free-episodes 12
```

目录第一层视为剧名，系统分别对每部剧自然排序（`EP2` 会排在 `EP10` 前），超过免费章节上限的文件不会上传，也不会产生模型费用。最终选择记录在 `edit/free_episode_selection.json`。

指定语言、说话人数和角色名词表：

```bash
python3 -m processor.batch_transcribe "/path/to/dramas" \
  --language eng \
  --num-speakers 8 \
  --keyterms "/path/to/character_names.txt"
```

结果写入剧集目录下的 `edit/`：

- `transcripts/*.json`：Scribe 原始词级数据与源文件指纹
- `takes_packed.md`：供剧情分析模型读取的压缩文本
- `transcript_manifest.json`：文件与短句统计
- `transcription_report.json`：批任务运行报告
- `free_episode_selection.json`：实际处理的免费章节与排除数量

相同源文件会命中缓存；只有文件内容或修改时间变化时才重新计费。使用 `--force` 可显式重跑。
# Evidence-first semantic analysis

`semantic_analysis.py` implements the three analysis tiers without demo data:

- **Coarse**: FFmpeg keyframes, Faster-Whisper word/segment timestamps,
  PaddleOCR timestamps, then an evidence-citing episode summary and cast
  candidates.
- **Detail**: consumes successful coarse envelopes and asks the configured
  semantic service for complete dialogue attribution, aliases, cross-episode
  relationships, per-episode plot and emotion curves.
- **Precision**: densely samples only a caller-selected interval and sends the
  actual JPEG frames plus overlapping transcript to the configured multimodal
  service for shot semantics, audio/visual rhythm, continuity and explainable
  highlight scores.

Every semantic claim must contain `evidence`, `timecode` and `confidence`.
Claims with missing/out-of-range evidence are automatically marked
`unverified`. Consumers must not describe `unverified` dialogue, actions or
shots as observed facts.

Install worker-only dependencies:

```powershell
python -m pip install -r processor/requirements-analysis.txt
```

Required configuration:

```text
LUMINA_ASR_BACKEND=faster-whisper
LUMINA_WHISPER_MODEL=small             # or an approved local model path
LUMINA_WHISPER_DEVICE=cpu
LUMINA_WHISPER_COMPUTE_TYPE=int8
LUMINA_OCR_BACKEND=paddleocr
LUMINA_OCR_LANGUAGE=en
LUMINA_SEMANTIC_ENDPOINT=https://your-provider.example/analyze
LUMINA_SEMANTIC_API_KEY=...
LUMINA_SEMANTIC_MODEL=approved-model-id
LUMINA_SEMANTIC_PROVIDER=openai-responses # or openai-chat-completions / generic
LUMINA_COARSE_FRAME_INTERVAL=10
LUMINA_PRECISION_FRAME_INTERVAL=0.5
LUMINA_OCR_WORKERS=2
LUMINA_QWEN_SEGMENT_SECONDS=90
LUMINA_QWEN_SEGMENT_MIN_DURATION=120
LUMINA_QWEN_SEGMENT_WORKERS=2
LUMINA_QWEN_RETRY_DELAY=2
```

Recommended Qwen configuration (Alibaba Cloud Model Studio, Beijing legacy
compatible endpoint):

```text
DASHSCOPE_API_KEY=...
LUMINA_SEMANTIC_PROVIDER=openai-chat-completions
LUMINA_SEMANTIC_ENDPOINT=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
LUMINA_SEMANTIC_MODEL=qwen3-vl-plus
```

For production, replace the endpoint with the workspace-specific compatible
endpoint from Model Studio when available. API keys and endpoints are
region-specific. The worker accepts `DASHSCOPE_API_KEY` directly and never
persists it in PocketBase.

Copy `.env.analysis.example` to the ignored `.env.analysis.local`, fill in the
real key, and run `scripts/start-analysis-worker.ps1`. The script loads that
local file without overriding environment variables already set by the shell.

OpenAI-compatible endpoints are supported through either the Responses API or
Chat Completions wire format; the adapter requests JSON-object output and sends
precision frames as data URLs. A `generic` endpoint receives
`{task, model, input}` and must return a JSON object. It must accept base64 JPEG
frames for precision analysis. Missing
binaries, packages, model names or cloud credentials cause `AnalysisFailed`;
call `failed_envelope(...)` to persist a transparent failed result. The module
never substitutes canned output.

The stable envelope schema is `processor/analysis_schema.json`.

Detail results must include `highlightCandidates[]` (also returned under the
stable alias `precisionCandidates[]`). Each accepted candidate is
the direct handoff contract for a precision job: `episode`, `start`, `end`,
`confidence`, `evidence[]`, `verification`. The processor removes candidates
whose episode is absent, whose interval exceeds that episode's measured
duration, or whose evidence is missing/unverified. The queue maps these fields
to `parameters.interval={start,end}` and retains `episode` on the job.
