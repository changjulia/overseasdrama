#!/usr/bin/env python3
import json
from pathlib import Path

from tencentcloud.common import credential
from tencentcloud.sts.v20180813 import models, sts_client


values = {}
for raw_line in Path("/opt/lingshu_AI/.env.production").read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if line and not line.startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")

cred = credential.Credential(
    values["OBJECT_STORAGE_ACCESS_KEY_ID"],
    values["OBJECT_STORAGE_SECRET_ACCESS_KEY"],
)
client = sts_client.StsClient(cred, "ap-singapore")
response = client.GetCallerIdentity(models.GetCallerIdentityRequest())
data = json.loads(response.to_json_string())
print(json.dumps({key: data.get(key) for key in ("AccountId", "PrincipalId", "Type")}, ensure_ascii=False))
