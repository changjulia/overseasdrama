#!/usr/bin/env python3
from pathlib import Path


path = Path("/opt/lingshu_AI/Caddyfile")
text = path.read_text(encoding="utf-8")
marker = "lumina.43-156-182-61.sslip.io {"
block = """

lumina.43-156-182-61.sslip.io {
    encode zstd gzip

    handle_path /pb/* {
        reverse_proxy lumina-production-pocketbase-1:8090
    }

    handle {
        reverse_proxy lumina-production-web-1:3000
    }
}
"""
if marker not in text:
    path.write_text(text.rstrip() + block, encoding="utf-8")
print("caddy-config-ready")
