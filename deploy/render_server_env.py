#!/usr/bin/env python3
import secrets
from pathlib import Path


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    return values


local = read_env(Path("/tmp/lumina-env.local"))
analysis = read_env(Path("/tmp/lumina-env.analysis"))
cos = read_env(Path("/opt/lingshu_AI/.env.production"))

semantic_key = analysis.get("LUMINA_SEMANTIC_API_KEY") or analysis.get("DASHSCOPE_API_KEY", "")
worker_token = secrets.token_urlsafe(48)

values = {
    "DOMAIN": "lumina.43-156-182-61.sslip.io",
    "ACME_EMAIL": "ops@lingshu.site",
    "LUMINA_WEB_PORT": "3200",
    "LUMINA_POCKETBASE_PORT": "8190",
    "LUMINA_WORKER_TOKEN": worker_token,
    "EXTERNAL_OPEN_API_BASE_URL": local.get("EXTERNAL_OPEN_API_BASE_URL", ""),
    "EXTERNAL_OPEN_API_KEY": local.get("EXTERNAL_OPEN_API_KEY", ""),
    "LUMINA_SEMANTIC_PROVIDER": analysis.get("LUMINA_SEMANTIC_PROVIDER", "openai-chat-completions"),
    "LUMINA_SEMANTIC_ENDPOINT": analysis.get("LUMINA_SEMANTIC_ENDPOINT", ""),
    "LUMINA_SEMANTIC_API_KEY": semantic_key,
    "DASHSCOPE_API_KEY": analysis.get("DASHSCOPE_API_KEY", ""),
    "OPENAI_API_KEY": analysis.get("OPENAI_API_KEY", ""),
    "LUMINA_SEMANTIC_MODEL": analysis.get("LUMINA_SEMANTIC_MODEL", "qwen3-vl-plus"),
    "LUMINA_WHISPER_MODEL": analysis.get("LUMINA_WHISPER_MODEL", "small"),
    "LUMINA_WHISPER_DEVICE": "cpu",
    "LUMINA_WHISPER_COMPUTE_TYPE": "int8",
    "LUMINA_WHISPER_CPU_THREADS": "2",
    "LUMINA_OCR_LANGUAGE": analysis.get("LUMINA_OCR_LANGUAGE", "en"),
    "LUMINA_OCR_WORKERS": "1",
    "LUMINA_QWEN_SEGMENT_WORKERS": "1",
    "COS_BUCKET": "lumina-prod-1421203394",
    "COS_REGION": "ap-singapore",
    "COS_ENDPOINT": "https://cos.ap-singapore.myqcloud.com",
    "COS_ACCESS_KEY_ID": cos["OBJECT_STORAGE_ACCESS_KEY_ID"],
    "COS_SECRET_ACCESS_KEY": cos["OBJECT_STORAGE_SECRET_ACCESS_KEY"],
}

target = Path("/opt/lumina/.env.production")
target.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")
target.chmod(0o600)
print("environment-ready")
