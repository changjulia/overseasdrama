# Lumina Scribe 转写模块

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
