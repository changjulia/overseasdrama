"""Run as root on the business server with private JSON configuration paths."""
import json
import os
from pathlib import Path
import urllib.request


root = Path('/opt/lumina')
storage_file = Path('/home/ubuntu/cos-env.json')
storage_file.chmod(0o600)
storage = json.loads(storage_file.read_text())
secrets = json.loads(Path('/home/ubuntu/lumina-runtime-secrets.json').read_text())['env']
env_path = root / '.env.business'
lines = [line for line in env_path.read_text().splitlines() if line.split('=', 1)[0] not in storage]
env_path.write_text('\n'.join(lines) + '\n' + ''.join(k + "='" + v + "'\n" for k, v in storage.items()))
env_path.chmod(0o600)


def request(path, data, token=None, method='POST'):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = token
    req = urllib.request.Request('http://127.0.0.1:8190' + path, json.dumps(data).encode(), headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as response:
        content = response.read()
        return json.loads(content) if content else {}


token = request('/api/collections/_superusers/auth-with-password', {
    'identity': secrets['LUMINA_POCKETBASE_SUPERUSER_IDENTITY'],
    'password': secrets['LUMINA_POCKETBASE_SUPERUSER_PASSWORD'],
})['token']
request('/api/settings', {'s3': {
    'enabled': True, 'bucket': storage['COS_BUCKET'], 'region': storage['COS_REGION'],
    'endpoint': storage['COS_ENDPOINT'], 'accessKey': storage['COS_ACCESS_KEY_ID'],
    'secret': storage['COS_SECRET_ACCESS_KEY'], 'forcePathStyle': False,
}}, token, 'PATCH')
request('/api/settings/test/s3', {'filesystem': 'storage'}, token)
print('Private COS storage configured and write/read test passed')
