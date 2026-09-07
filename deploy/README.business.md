# Lumina 业务运维服务器

目标：腾讯云轻量应用服务器 `43.134.182.192`（新加坡，2 核 / 2 GB / 50 GB）。
站点：<https://lumina.43-134-182-192.sslip.io/>。
安装目录：`/opt/lumina`；实际 Compose 文件：`/opt/lumina/compose.business.yml`。

## 服务与持久化

- Caddy：80/443、自动 HTTPS、会话登录保护。
- Auth：站内登录、注册及成员管理，数据库位于 `deploy/runtime/auth/accounts.sqlite`；不开放公网端口。
- Web：仅本机 `127.0.0.1:3200`；`VINEXT_TRUSTED_HOSTS` 用于反向代理下的同源校验。
- PocketBase：仅本机 `127.0.0.1:8190`；数据库位于 `deploy/runtime/pb_data`。
- Worker：单进程顺序消费任务，避免 2 GB 机器并发运行重型 OCR。CPU 密集型分析和长视频渲染仍受硬件限制。
- Media：内部短时签名链接服务；必须经 Caddy 登录保护访问，不暴露端口。
- COS：复用私有桶 `lumina-prod-1421203394`，地域 `ap-singapore`。原始文件沿用 PocketBase 对象路径；成片放在 `renders/`。

成片通过 `/renders/<文件名>` 获取 15 分钟有效的 COS 链接。Worker 在上传并核对文件大小后移除本地成片，避免持续占用服务器磁盘。未配置 COS 时仍保留原有本地输出行为。

## 管理

```bash
cd /opt/lumina
sudo docker compose --env-file .env.business -f compose.business.yml ps
sudo docker compose --env-file .env.business -f compose.business.yml logs --tail 100 worker
sudo docker compose --env-file .env.business -f compose.business.yml up -d
```

`.env.business` 权限为 600，包含数据库访问和 COS 配置。不要提交、公开或复制到前端。
更新配置时，将仓库的 `deploy/compose.business.yml` 复制到服务器安装目录根部，以保持相对路径正确。

数据库设置 `GOMEMLIMIT=384MiB`、容器内存 640 MB 并允许交换空间，避免导入大量历史记录后触发默认 Go 堆上限导致重启。

## 账号使用

访问 `/login` 登录，访问 `/register` 自助注册，访问 `/account` 修改密码或管理成员。
首次管理员沿用原网站 `lumina` 账号及原密码；首次启动使用一次性 `deploy/runtime/auth/bootstrap.json` 初始化并立即删除该文件。
新注册账号固定为未启用的成员，管理员审核启用后才能访问工作区。没有公开的管理员注册入口。
管理员可创建账号、变更角色、停用账号和重置密码；系统保留至少一名启用的管理员。
密码使用带随机盐的 scrypt，服务端仅存会话令牌摘要。Cookie 为 HttpOnly、Secure、SameSite=Lax；普通会话 12 小时，保持登录为 7 天。
退出登录、停用、重置密码会撤销相关会话。所有修改请求校验同源，登录和注册设有频率限制。
团队成员共享现有工作区业务数据，浏览器草稿依旧保留在当前浏览器。账号数据库必须与业务数据库一起备份。

## 数据迁移说明

数据库使用在线 SQLite 备份导入；原机数据未修改。迁移时未完成的素材分析任务保留记录并停止自动重试，用户可在新站点手动重试，避免两台机器重复调用模型。已失败的旧任务同样不自动重跑。

浏览器自动缓存按网站域名隔离：新站点内刷新或离开页面再返回可保留脚本；`localhost:3001` 的旧浏览器缓存不会自动出现在新域名。数据库中的业务记录独立持久化。

部署核对时，20 条成功渲染记录引用 17 个独立成片文件，其中 12 个文件本地存在并迁移；另 5 个“叙事进场字幕验收版”文件在部署前已缺失。其旧记录保留，未冒充文件已恢复。

## 备份与恢复

COS 与数据库均为持久化数据。更新容器不要执行 `down -v` 或删除 `deploy/runtime/pb_data`。备份数据库必须使用 SQLite 在线备份或先停止 PocketBase，不能直接复制正在写入的数据库主文件而忽略 WAL。

COS 存储不替代数据库备份。现有桶也不应清空：它包含此次部署复用的原片对象。

## 小内存实例配置（2026-09-04）

- PocketBase 容器仍为 640 MiB，Go 软内存目标 192 MiB、GOGC=50；数据读连接最多 2，辅助库最多 2。
- 在启用 `LUMINA_DB_MAX_CONNECTIONS` 时，启动钩子设置 SQLite 全进程软堆限制 64 MiB、硬堆限制 256 MiB。超过硬限额时查询可能报内存错误，不应通过取消保护来掩盖大查询。
- Caddy 到 PocketBase 使用 HTTP/1.1，最多 1 个连接；请求等待可用连接，避免多个浏览器标签页同时展开大型记录。COS 视频仍然直传，登录路由不受此连接池影响。
- 任务轮询使用 `/api/lumina/task-summaries/{collection}`，SQL 只选择列表需要的字段，不加载 result、logs 或完整关联分析 JSON；日志仍按需读取。
- 当前部署只运行一个 `processor.job_worker`，解析、匹配和渲染在同一任务循环中串行执行，内部数值计算线程和 CPU 已受限。增加 Worker 副本前必须重新做容量验证。
- 调试期间的 GODEBUG=gctrace=1 已从正式 compose 移除。不要将 COS 当作 RAM 或数据库备份的替代品。

## 2026-09-07 恢复部署

原安装目录、业务数据库、账号数据库和 Docker 数据卷在本次部署前已不存在，服务器保留了旧版镜像。此次从本地一致性快照恢复 1,937 条素材、1,059 条钩子资产、10 集剧集，以及 125 条成功的素材分析结果。旧成员账号无备份，只恢复此前保存的初始管理员；其他成员需要重新注册并由管理员启用。

服务器已有 Nginx 占用 80/443，原 IP 站点配置保持不变。短剧域名单独使用 `/etc/nginx/conf.d/lumina.conf`，转发至 Caddy 的回环端口 3280/32443。实际 `/opt/lumina/compose.business.yml` 因此将 Caddy 端口绑定为 `127.0.0.1:3280:80` 和 `127.0.0.1:32443:443`；更新时须保留此服务器适配，不能直接用默认公网端口配置覆盖。

Caddy 通过 HTTP-01 管理域名证书；Nginx 复用该证书并校验上游 TLS（校验深度 3）。`lumina-cert-reload.timer` 每天重新加载 Nginx，以读取 Caddy 续期后的证书。Web 健康检查使用 `/favicon.svg`，避免未登录首页跳转被误判为不健康。

迁移时未完成和已失败任务暂停自动重试，用户可在站点中手动重试。初始快照保存在私有 COS 的 `releases/20260907/business-data.tar.gz`，恢复后的账号与业务库备份位于 `deploy/backups/release-20260907/`。素材校验清单见 `deploy/releases/20260907/assets-manifest.json`。
