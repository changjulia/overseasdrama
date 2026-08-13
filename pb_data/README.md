# PocketBase 数据快照

仓库保存 `data.seed.db`、上传媒体、海报、缩略图及其属性文件，用于恢复当前业务数据。

`data.seed.db` 已移除超级管理员、用户认证来源、MFA、OTP 和运行时参数。PocketBase 请求日志、API Key 与分析 worker token 不进入 Git 历史。

首次克隆后，在 PocketBase 未运行时将 `data.seed.db` 复制为 `data.db`，再启动 PocketBase 并创建新的超级管理员：

```powershell
Copy-Item pb_data/data.seed.db pb_data/data.db
./pocketbase superuser create <email> <password> --dir=pb_data
```
