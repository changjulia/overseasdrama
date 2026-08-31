# Worker 队列观测

`scripts/check-worker-queues.sh` 直接以 SQLite `mode=ro&immutable=1` 打开 PocketBase 数据库，只输出聚合数量，不读取或显示 token，不会变更任务状态。在 PocketBase 运行期间使用该方式属于瞬时快照，数字可能在下一次运行时变化。

```bash
bash scripts/check-worker-queues.sh
bash scripts/check-worker-queues.sh --db /absolute/path/to/data.db --json
```

表格中 `ACTIVE` 统一表示分析队列的 `running` 和渲染队列的 `rendering`。`LEASE_EXPIRED` 是活动任务缺失租约或租约已过期，`BACKOFF_DUE` 是失败任务已到可重试时间，`ATTEMPT_EXHAUSTED` 是已用完尝试次数。

退出码：

- `0`：未发现上述三类需处理任务。
- `1`：至少有一个过期租约、到期重试或尝试耗尽任务。
- `2`：参数、SQLite 工具、数据库路径或队列 schema 错误。

该脚本只用于观测，不会自动重试、重排或终止任务。
