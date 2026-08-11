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

默认开发地址为终端输出的 Local URL。

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

## 安全

- `.env`、API Key、缓存和本地视频不会提交到仓库。
- 默认只处理每部剧设定的免费章节。
- 相同源文件会命中转写缓存，避免重复计费。

## 状态

当前为 MVP 开发阶段。Scribe 转写底座和产品前端已完成；画面分析、音画融合、自动 EDL 与 FFmpeg 渲染仍在建设中。
