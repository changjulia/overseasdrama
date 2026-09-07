import cv2
import json
import math
from pathlib import Path
import numpy as np
import os

ROOT = Path(os.environ.get("QA_ROOT", Path(__file__).parent / "A类候选" / "本轮10条"))
OUT = ROOT / "qa"
OUT.mkdir(parents=True, exist_ok=True)

tiles = []
report = []
for path in sorted(ROOT.glob("*.mp4")):
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    duration = frames / fps if fps else 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    report.append({"file": path.name, "duration": round(duration, 3), "fps": round(fps, 3), "width": width, "height": height, "frames": int(frames)})
    for frac in (0.1, 0.5, 0.9):
        sec = max(0, min(duration - 0.05, duration * frac))
        cap.set(cv2.CAP_PROP_POS_MSEC, sec * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        target_h, target_w = 360, 220
        scale = max(target_w / frame.shape[1], target_h / frame.shape[0])
        resized = cv2.resize(frame, (round(frame.shape[1] * scale), round(frame.shape[0] * scale)))
        y = (resized.shape[0] - target_h) // 2
        x = (resized.shape[1] - target_w) // 2
        tile = resized[y:y+target_h, x:x+target_w].copy()
        cv2.rectangle(tile, (0, 0), (target_w, 42), (0, 0, 0), -1)
        label = f"{path.name[:2]}  {sec:.1f}s"
        cv2.putText(tile, label, (8, 28), cv2.FONT_HERSHEY_SIMPLEX, .72, (255, 255, 255), 2, cv2.LINE_AA)
        tiles.append(tile)
    cap.release()

cols = 6
rows = math.ceil(len(tiles) / cols)
canvas = np.full((rows * 360, cols * 220, 3), 245, dtype=np.uint8)
for i, tile in enumerate(tiles):
    row, col = divmod(i, cols)
    canvas[row*360:(row+1)*360, col*220:(col+1)*220] = tile
ok, encoded = cv2.imencode('.jpg', canvas)
if not ok:
    raise RuntimeError('Failed to encode contact sheet')
encoded.tofile(str(OUT / "contact_sheet.jpg"))
(OUT / "media_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"videos": len(report), "sheet": str(OUT / 'contact_sheet.jpg'), "report": report}, ensure_ascii=False))
