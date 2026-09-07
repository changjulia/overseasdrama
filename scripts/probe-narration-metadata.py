"""Repair early evidence metadata by probing source headers, not retranscribing."""
import concurrent.futures,json,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
import imageio_ffmpeg
ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
def probe(path):
    data=json.loads(path.read_text(encoding='utf-8'))
    if data.get('status')!='ready' or data.get('mediaDuration') or data.get('engine')=='historical-cache': return
    source=json.loads((ROOT/'outputs/narration-mvp-20260904'/path.name).read_text(encoding='utf-8'))
    r=subprocess.run([ffmpeg,'-nostdin','-hide_banner','-rw_timeout','15000000','-i',source['url'],'-t','0','-vn','-f','null','-'],capture_output=True,timeout=30)
    m=re.search(rb'Duration: (\d+):(\d+):(\d+\.\d+)',r.stderr)
    if not m: return
    duration=int(m[1])*3600+int(m[2])*60+float(m[3])
    data.update(mediaDuration=duration,duration=duration,coverageEnd=min(180,duration))
    path.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
    print(path.name,duration,flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(probe,(ROOT/'.codex-runtime/narration-intake/boundary-evidence').glob('*.json')))
