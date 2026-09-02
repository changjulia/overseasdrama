#!/usr/bin/env python3
import argparse
import os
from pathlib import Path

import boto3
from botocore.config import Config


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("download", "upload-tree", "delete", "list", "stat-tree"))
    parser.add_argument("source")
    parser.add_argument("destination", nargs="?", default="")
    parser.add_argument("--env", default="/opt/lingshu_AI/.env.production")
    parser.add_argument("--bucket", default="lumina-prod-1421203394")
    args = parser.parse_args()

    env = read_env(Path(args.env))
    client = boto3.client(
        "s3",
        region_name="ap-singapore",
        endpoint_url="https://cos.ap-singapore.myqcloud.com",
        aws_access_key_id=env["OBJECT_STORAGE_ACCESS_KEY_ID"],
        aws_secret_access_key=env["OBJECT_STORAGE_SECRET_ACCESS_KEY"],
        config=Config(
            s3={"addressing_style": "virtual"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )

    if args.action == "stat-tree":
        count = 0
        total = 0
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=args.bucket, Prefix=args.source):
            for item in page.get("Contents", []):
                count += 1
                total += item["Size"]
        print(f"{count} {total}")
    elif args.action == "list":
        response = client.list_objects_v2(Bucket=args.bucket, Prefix=args.source, MaxKeys=10)
        print(f"{response.get('KeyCount', 0)} objects")
    elif args.action == "download":
        client.download_file(args.bucket, args.source, args.destination)
        print(Path(args.destination).stat().st_size)
    elif args.action == "delete":
        client.delete_object(Bucket=args.bucket, Key=args.source)
        print("deleted")
    else:
        root = Path(args.source)
        count = 0
        total = 0
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            key = "/".join(filter(None, (args.destination.strip("/"), path.relative_to(root).as_posix())))
            client.upload_file(os.fspath(path), args.bucket, key)
            count += 1
            total += path.stat().st_size
        print(f"{count} {total}")


if __name__ == "__main__":
    main()
