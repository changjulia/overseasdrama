"""Private COS storage for generated media; credentials stay on the server."""
from __future__ import annotations

import mimetypes
import os
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def media_client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3", region_name=os.environ["COS_REGION"],
        endpoint_url=os.environ["COS_ENDPOINT"],
        aws_access_key_id=os.environ["COS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["COS_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"},
                      request_checksum_calculation="when_required",
                      response_checksum_validation="when_required",
                      retries={"max_attempts": 5, "mode": "standard"}),
    )


def publish_render(path: Path) -> bool:
    """Verify durable upload before the worker removes its temporary output."""
    bucket = os.environ.get("COS_BUCKET")
    if not bucket:
        return False
    client = media_client()
    key = f"renders/{path.name}"
    client.upload_file(str(path), bucket, key, ExtraArgs={"ContentType": mimetypes.guess_type(path.name)[0] or "application/octet-stream"})
    if client.head_object(Bucket=bucket, Key=key)["ContentLength"] != path.stat().st_size:
        raise RuntimeError("COS render upload size verification failed")
    return True
