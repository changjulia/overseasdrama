"""Local GPU ASR only; no paid API. Resumable evidence files for narration intake."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import re
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tmp/narration-mvp-deps'))
VERSION = 'local-boundary-asr-v1'
DLL_HANDLES = []
for folder in (ROOT/'tmp/narration-cuda-deps/nvidia').glob('*/bin'):
    os.environ['PATH'] = str(folder) + os.pathsep + os.environ.get('PATH','')
    if hasattr(os,'add_dll_directory'): DLL_HANDLES.append(os.add_dll_directory(str(folder)))

def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temp.replace(path)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=900)
    parser.add_argument('--device', choices=['cpu','cuda'], default='cuda')
    parser.add_argument('--only-failed', action='store_true')
    args = parser.parse_args()
    directory = ROOT / '.codex-runtime/narration-intake/boundary-evidence'
    directory.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'outputs/narration-mvp-20260904'
    manifest = json.loads((ROOT / '.codex-runtime/narration-intake/all-applied.json').read_text(encoding='utf-8'))
    selected = manifest['results'][:args.limit]
    if args.only_failed:
        selected=[item for item in selected if (directory/(item['key']+'.json')).exists() and json.loads((directory/(item['key']+'.json')).read_text(encoding='utf-8')).get('status')=='failed']
    ffmpeg = os.getenv('FFMPEG_BINARY')
    if not ffmpeg:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    # Historical cache is read-only; all business updates go through the API.
    connection = sqlite3.connect((ROOT / 'pb_data/data.db').as_uri() + '?mode=ro', uri=True)
    cached = {url: json.loads(raw or '{}').get('evidence', {}).get('transcript', [])
              for url, raw in connection.execute('select source_url,analysis_result from ad_materials')}
    connection.close()
    model = None
    def prepare(item):
        row = json.loads((source / (item['key'] + '.json')).read_text(encoding='utf-8'))
        fingerprint = hashlib.sha256((VERSION + row['url']).encode()).hexdigest()
        output = directory / (item['key'] + '.json')
        if output.exists():
            previous = json.loads(output.read_text(encoding='utf-8'))
            if previous.get('fingerprint') == fingerprint and previous.get('status') == 'ready': return item, None, None
        duration = float(row.get('duration') or 180)
        coverage = min(180.0, duration)
        segments = cached.get(row['url'], [])
        usable = [dict(start=float(s['start']), end=float(s['end']), text=str(s['text']).strip()) for s in segments if isinstance(s,dict) and 'end' in s and 'start' in s and 'text' in s and float(s['end']) <= coverage and str(s['text']).strip()]
        base = dict(version=VERSION, fingerprint=fingerprint, key=item['key'], duration=duration, coverageEnd=coverage)
        if usable and max(float(s.get('end',0)) for s in segments) >= coverage-1:
            save(output, dict(base, status='ready', segments=usable, engine='historical-cache')); return item,None,None
        audio = directory / (item['key'] + '.wav')
        try:
            result = subprocess.run([ffmpeg,'-nostdin','-y','-hide_banner','-loglevel','info','-rw_timeout','20000000','-i',row['url'],'-t',str(coverage),'-vn','-ac','1','-ar','16000',str(audio)], capture_output=True, timeout=100)
            if result.returncode or not audio.exists() or audio.stat().st_size < 1024: raise RuntimeError('media unavailable or empty audio')
            match=re.search(rb'Duration: (\d+):(\d+):(\d+\.\d+)',result.stderr)
            if match:
                base['duration']=int(match[1])*3600+int(match[2])*60+float(match[3])
                base['mediaDuration']=base['duration']
            with wave.open(str(audio),'rb') as wav: base['coverageEnd']=min(coverage,wav.getnframes()/wav.getframerate())
            return item, audio, base
        except Exception as exc:
            save(output,dict(base,status='failed',error=type(exc).__name__+': '+str(exc)[:120])); return item,None,None
    # Four bounded prefetches; only one GPU inference at a time.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        pending = {}; cursor=0; done=0
        while cursor<len(selected) or pending:
            while cursor<len(selected) and len(pending)<8:
                future=pool.submit(prepare,selected[cursor]); pending[future]=selected[cursor]; cursor+=1
            ready,_=concurrent.futures.wait(pending,return_when=concurrent.futures.FIRST_COMPLETED)
            for future in ready:
                item=pending.pop(future)
                try:
                    item,audio,base=future.result()
                    if audio:
                        if model is None:
                            from faster_whisper import WhisperModel, BatchedInferencePipeline
                            model_path=Path.home()/'.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120'
                            model=WhisperModel(str(model_path),device=args.device,compute_type='float16' if args.device=='cuda' else 'int8',cpu_threads=4)
                            if args.device=='cuda': model=BatchedInferencePipeline(model=model)
                        options={'batch_size':8,'without_timestamps':False} if args.device=='cuda' else {}
                        chunks,info=model.transcribe(str(audio),beam_size=1,vad_filter=True,condition_on_previous_text=False,**options)
                        segments=[dict(start=round(s.start,3),end=round(s.end,3),text=s.text.strip()) for s in chunks if s.text.strip() and s.end<=base['coverageEnd']+.05]
                        save(directory/(item['key']+'.json'),dict(base,status='ready' if segments else 'failed',segments=segments,engine='faster-whisper-small-local-'+args.device,language=info.language))
                        # Only this worker's generated, explicit audio file is removed.
                        audio.unlink()
                except Exception as exc:
                    save(directory/(item['key']+'.json'),dict(status='failed',key=item['key'],error=type(exc).__name__+': '+str(exc)[:180]))
                    # A broken local runtime should not repeat across 900 records.
                    if any(marker in str(exc).lower() for marker in ('cublas','cudnn','cuda','dll')): raise
                done+=1
                print(f'local evidence {done}/{len(selected)} {item["key"]}',flush=True)

if __name__=='__main__': main()
