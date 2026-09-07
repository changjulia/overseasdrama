#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/lumina
backup=/opt/lumina/deploy/backups/accounts-before-20260904
mkdir -p "$backup"
cp compose.business.yml "$backup/compose.business.yml"
cp deploy/Caddyfile.business "$backup/Caddyfile.business"
docker tag lumina-production-web:latest lumina-production-web:before-accounts-20260904
rollback() {
  cp "$backup/compose.business.yml" compose.business.yml
  cp "$backup/Caddyfile.business" deploy/Caddyfile.business
  docker tag lumina-production-web:before-accounts-20260904 lumina-production-web:latest
  docker compose --env-file .env.business -f compose.business.yml up -d web caddy
  docker exec -i lumina-business-caddy-1 caddy reload --config /dev/stdin --adapter caddyfile < deploy/Caddyfile.business
  echo 'Account deployment failed; previous gateway restored'
}
trap rollback ERR
tar -xzf /home/ubuntu/accounts-update.tar.gz -C /opt/lumina
chmod 700 deploy/runtime/auth
chmod 600 deploy/runtime/auth/bootstrap.json
cp deploy/compose.business.yml compose.business.yml
docker compose --env-file .env.business -f compose.business.yml config -q
docker build -t lumina-business-auth:latest -f Dockerfile.auth .
docker build -t lumina-production-web:accounts -f Dockerfile.web .
docker compose --env-file .env.business -f compose.business.yml up -d auth
docker compose --env-file .env.business -f compose.business.yml run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile
docker exec lumina-business-auth-1 python -c "import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:8080/health').status == 200"
docker tag lumina-production-web:accounts lumina-production-web:latest
docker compose --env-file .env.business -f compose.business.yml up -d web caddy
docker exec -i lumina-business-caddy-1 caddy reload --config /dev/stdin --adapter caddyfile < deploy/Caddyfile.business
trap - ERR
rm -f /home/ubuntu/accounts-update.tar.gz
echo 'ACCOUNTS_DEPLOYMENT_COMPLETE'
