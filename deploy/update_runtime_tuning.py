#!/usr/bin/env python3
from pathlib import Path


path = Path("/opt/lumina/.env.production")
updates = {
    "LUMINA_WHISPER_MODEL": "base",
    "LUMINA_MATERIAL_FRAME_INTERVAL": "10",
    "LUMINA_MATERIAL_MAX_OCR_FRAMES": "24",
    "LUMINA_MATERIAL_MAX_SEMANTIC_FRAMES": "12",
}
lines = path.read_text(encoding="utf-8").splitlines()
seen = set()
result = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in updates:
        result.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        result.append(line)
for key, value in updates.items():
    if key not in seen:
        result.append(f"{key}={value}")
path.write_text("\n".join(result) + "\n", encoding="utf-8")
path.chmod(0o600)
print("runtime-tuning-ready")
