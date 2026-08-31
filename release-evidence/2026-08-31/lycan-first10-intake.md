# BC-01 真实前 10 集入库证据

- 执行时间：2026-08-31 01:16–01:20 CST
- 业务入口：本机 Chrome 中的 Lumina “数据源管理 → 全集播放地址 → 前10集验收入库”
- 上游查询：`The Rise of the Lycan Queen`，dramawave `3CRScaBEY0`，返回 51 集
- 安全边界：生产代码的 HTTPS/loopback 门禁未修改；本轮使用仅绑定 `127.0.0.1` 且不记录 header/URL 的临时验收桥接，上游明文 HTTP 调用依据用户本地验收授权。
- 剧目记录：`s2mhnmm4t9q9yud`，external id `1652771868`
- 权限标记：`external data · user-authorized internal acceptance first 10 episodes (non-production)`（数据库中为中文等价文案）
- 终态 UI 证据：剧库 1 部；详情页“正片已获取 10 / 51”；EP1–EP10 均有持久化 MP4；EP1 显示“正在播放真实片源”。

| EP | PocketBase record | bytes | duration (s) | SHA-256 |
| ---: | --- | ---: | ---: | --- |
| 1 | `ed6gkt0rs143m9i` | 17,570,317 | 182.950 | `388276dacbc5c600df5597f2b08f820e1bc5319f5c17979b199ad9919c18268e` |
| 2 | `umuu90pueb51pcd` | 13,304,445 | 115.749 | `c26e8d94ab9e02f371a8028fd1a598f44013aaa8f479fd681cf65e76fb82fbf1` |
| 3 | `d1ioorgaznqg6a4` | 15,465,851 | 137.117 | `aeee2cd6dde6e0304d8142a13d7601b556a3efbfe8babdf6d65c4896a6e8701c` |
| 4 | `qwu7arhqdy76fut` | 22,711,239 | 205.075 | `a683338e9ad7533ffe7e7e75fc697e1e65d2ca5556a7fe8d4d7ec0849bde577f` |
| 5 | `d4hl19mhjzv393s` | 9,507,435 | 84.575 | `f5d2345d277887609b925b47b31c81d465f8fbd0a5ef6282d232b95d322480b6` |
| 6 | `wnvskzk29x5eurx` | 11,361,452 | 91.617 | `2a008160dab51f5ccf96e17047565ca435e4d796502f0de8f0d5b0b1c2153e4c` |
| 7 | `4omljqhgogzyr82` | 18,245,210 | 138.950 | `dc13b308381cf72d4018b248b0e54f0d61aa578625372627a9b7f088b14c4977` |
| 8 | `ws2h0xo3vz0ant9` | 7,713,595 | 80.784 | `e80ebc52cef24460d3e92b0c2d2b656787a3918969d5a25ee058ae5d49937cde` |
| 9 | `k92mgyb9cbd625b` | 10,608,719 | 92.534 | `1c6463a7800430316e6a2a2cd67b3d903ffbaebcaf99cc1ada3a06bd74e4826a` |
| 10 | `0bsoznq4udd7aer` | 12,730,127 | 129.367 | `d7bfae702865ddf3fe0118e7e123c475f2b145347ff245eed39f4ee9bd1b748d` |

## 结论边界

BC-01 的“安全查询、前 10 集下载/入库、剧库列表/详情、EP1 播放”已获得真实 UI/API/存储证据。尚未逐集完整人工播放审核，因此 BC-01 整站暂不标记 `quality_passed`。本文档不证明 BC-02 分析、BC-03 内容质量或后续成片链路通过。
