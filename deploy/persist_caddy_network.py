#!/usr/bin/env python3
from pathlib import Path


path = Path("/opt/lingshu_AI/docker-compose.yml")
text = path.read_text(encoding="utf-8")
if "name: lumina-production_lumina" not in text:
    text = text.replace(
        "    depends_on:\n      app:\n        condition: service_healthy\n\nvolumes:",
        "    depends_on:\n      app:\n        condition: service_healthy\n    networks:\n      - default\n      - lumina\n\nnetworks:\n  lumina:\n    external: true\n    name: lumina-production_lumina\n\nvolumes:",
    )
    if "name: lumina-production_lumina" not in text:
        raise RuntimeError("Expected Caddy compose anchor was not found")
    path.write_text(text, encoding="utf-8")
print("caddy-network-persistent")
