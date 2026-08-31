# npm 依赖安全审计

## 审计结论

- 审计日期：2026-08-30
- 初始结果：21 个漏洞（1 low、4 moderate、16 high）。
- 处理后全量结果：6 个漏洞（4 moderate、2 high）。
- 处理后生产依赖结果：`npm audit --omit=dev` 为 0 个漏洞。
- 本次未使用 `npm audit fix --force`，也未升级到 vinext 1.0 beta 或降级 drizzle-kit。

## 已处理项

| 依赖链 | 类型 | 处理 | 验证 |
| --- | --- | --- | --- |
| `next` / `postcss` / `sharp` | 生产运行时 | Next 16.2.6 升级到 16.3.3 | 生产依赖 audit 为 0；构建通过 |
| `react-server-dom-webpack` | 服务器构建/运行时 | React/RSC 统一升级到 19.2.8 | 构建通过 |
| `@cloudflare/vite-plugin` / `miniflare` / `undici` / `ws` / `sharp` | 开发、预览和 Cloudflare 工具链 | plugin 升级到 1.54.2，wrangler 升级到 4.127.1 | audit 不再报告该链；构建通过 |
| `vite` / `esbuild` | 开发和构建工具 | Vite 升级到 8.2.2 | audit 不再报告顶层 Vite 链；构建通过 |
| `@babel/core`、`brace-expansion`、`fast-uri`、`js-yaml`、`nanoid` | 开发工具的间接依赖 | 执行非强制 `npm audit fix` 更新 lockfile 内可兼容版本 | audit 不再报告 |

## 剩余风险

### drizzle-kit 开发 CLI（4 moderate）

链路为 `drizzle-kit -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils -> esbuild@0.18.20`。公告影响 esbuild 开发服务器；本项目仅将 drizzle-kit 用于 `db:generate` 开发脚本，不在生产应用运行时加载。npm 提供的自动方案是降级到 drizzle-kit 0.18.1，属于破坏性变更，不采用。

临时管控：

- 不对外网暴露 drizzle/esbuild 开发服务。
- CI/生产安装使用 `npm ci --omit=dev`。
- drizzle-kit 发布移除旧 loader 的兼容版本后再升级。

### vinext 图像尺寸解析链（2 high）

链路为 `vinext@0.0.50 -> image-size@2.0.2`。公告影响恶意 ICNS/JXL/HEIF 的解析，可导致无限循环。npm 只提供升级到 `vinext@1.0.0-beta.8` 的破坏性方案。当前应用构建链依赖 vinext 0.x，未在本次安全收口中跨越 beta major。

临时管控：

- 不允许未信任的 ICNS/JXL/HEIF 文件进入构建输入。
- 业务上传视频/图片必须在 worker 端按允许的媒体类型和尺寸校验，不把用户输入作为 vinext 构建资产。
- 单独建立 vinext 1.0 升级分支，完成全量构建与界面回归后才合入。

## 可重复验证

```bash
npm audit --omit=dev
npm audit
npm run build
node --test tests/*.test.mjs
```

2026-08-30 实际结果：生产 audit 0；全量 audit 6；vinext production build 通过；Node 契约测试 32/32 通过。
