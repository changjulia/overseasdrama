# 腾讯云新加坡单机部署

本方案面向 Ubuntu 22.04 x86_64 CVM，使用一个自包含的 Docker Compose 栈运行：

- Caddy：公网 80/443、自动 HTTPS、HTTP Basic Auth
- Vinext Web：仅容器网络可见的 3000 端口
- PocketBase 0.39.9：仅容器网络可见的 8090 端口
- Python Worker：FFmpeg、Faster-Whisper、PaddleOCR、语义分析

PocketBase 数据保存在宿主机 `deploy/runtime/pb_data`，删除或更新容器不会删除业务数据。

## 1. 腾讯云准备

1. 购买新加坡地域 Ubuntu 22.04 CVM，建议至少 8 核、16 GB、200 GB SSD。
2. 绑定公网 IP。
3. 安全组入站只开放：
   - TCP 22：仅你的固定出口 IP
   - TCP 80：`0.0.0.0/0`
   - TCP 443：`0.0.0.0/0`
   - UDP 443：`0.0.0.0/0`（HTTP/3，可选）
4. 不开放 3000 和 8090。
5. 把域名 A 记录解析到 CVM 公网 IP。

## 2. 安装 Docker

在服务器安装 Docker Engine 与 Compose 插件，并启用开机启动：

```bash
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

重新登录 SSH 后确认：

```bash
docker version
docker compose version
```

## 3. 上传项目与 PocketBase 数据

把完整仓库上传或克隆到服务器，例如 `/opt/lumina`。然后创建持久化目录：

```bash
cd /opt/lumina
mkdir -p deploy/runtime/pb_data deploy/backups
```

停止本地 PocketBase 后，将本机真实数据目录中的全部内容上传到：

```text
/opt/lumina/deploy/runtime/pb_data/
```

当前开发机真实数据源是：

```text
D:\LuminaData\external-hook-runtime\pb_data
```

至少确认服务器存在：

```text
deploy/runtime/pb_data/data.db
deploy/runtime/pb_data/storage/
```

如果 `storage/` 不存在，以实际 PocketBase 数据目录内容为准，不要自行创建空目录覆盖已有文件。

## 4. 配置生产密钥

```bash
cp .env.production.example .env.production
```

生成站点登录密码哈希：

```bash
docker run --rm caddy:2.10-alpine caddy hash-password --plaintext '你的强密码'
```

将输出完整复制到 `.env.production` 的 `BASIC_AUTH_HASH`，并使用单引号包裹。填写域名、邮箱、外部 API、语义模型密钥和随机 Worker Token。

生产文件不得提交 Git：

```text
.env.production
```

先执行强制预检。它会拒绝空值、示例密钥、过短 Worker Token、无效密码哈希、缺失的 PocketBase 数据和不可用的 Docker Compose：

```bash
python3 deploy/preflight.py
```

预检通过后再构建和启动：

```bash
docker compose --env-file .env.production -f docker-compose.tencent.yml build
docker compose --env-file .env.production -f docker-compose.tencent.yml up -d
docker compose --env-file .env.production -f docker-compose.tencent.yml ps
```

`caddy`、`web`、`pocketbase`、`worker`、`interactive-worker` 五个服务必须全部为运行或健康状态。

查看日志：

```bash
docker compose --env-file .env.production -f docker-compose.tencent.yml logs -f --tail=200
```

Caddy 会在域名解析生效且 80/443 可访问后自动申请 HTTPS 证书。访问：

```text
https://你的域名
```

## 6. 上线验证

```bash
curl -I "https://你的域名"
docker compose --env-file .env.production -f docker-compose.tencent.yml exec pocketbase curl -fsS http://127.0.0.1:8090/api/health
docker compose --env-file .env.production -f docker-compose.tencent.yml logs --tail=100 worker
docker compose --env-file .env.production -f docker-compose.tencent.yml logs --tail=100 interactive-worker
```

浏览器检查：

1. 登录保护正常出现。
2. 灵感大屏素材总数不是 0。
3. 视频可播放，并支持 Range 请求。
4. 剧库与任务中心能读取数据。
5. 上传一个小测试视频，确认 `/pb` 反向代理和 4 GB 请求限制正常。
6. 创建一个分析任务，确认 Worker 能领取、续租并回写结果。

## 7. 日常更新

更新代码后：

```bash
git pull --ff-only
python3 deploy/preflight.py
docker compose --env-file .env.production -f docker-compose.tencent.yml build web worker interactive-worker pocketbase
docker compose --env-file .env.production -f docker-compose.tencent.yml up -d
docker compose --env-file .env.production -f docker-compose.tencent.yml ps
```

不要使用 `docker compose down -v`，它会删除 Caddy 和 Worker 命名卷。

## 8. 备份与恢复

创建一致性备份时，脚本会短暂停止 PocketBase 和两个 Worker：

```bash
bash deploy/backup-pocketbase.sh
```

备份位于 `deploy/backups/`，同时生成 SHA-256 文件。建议再同步到腾讯云 COS，并设置云硬盘自动快照。

恢复会替换当前 PocketBase 数据，必须先确认备份路径：

```bash
bash deploy/restore-pocketbase.sh /absolute/path/to/pocketbase-YYYYMMDDTHHMMSSZ.tar.gz
```

恢复前应额外创建当前数据备份，并安排维护窗口。

## 9. 扩容路线

单机稳定后再逐步拆分：

1. 视频文件迁移腾讯云 COS，新加坡地域。
2. Worker 迁到独立 CPU/GPU CVM。
3. PocketBase 数据盘启用高频快照，并增加异地备份。
4. 接入正式账号系统后，移除 Caddy Basic Auth。
