import vinext from "vinext";
import { defineConfig } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localRenderFiles = () => ({
  name: "lumina-local-render-files",
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string; method?: string }, res: { statusCode: number; setHeader: (name: string, value: string | number) => void; end: (body?: string) => void }, next: () => void) => void) => void } }) {
    attachRenderMiddleware(server);
  },
  configurePreviewServer(server: { middlewares: { use: (fn: (req: { url?: string; method?: string }, res: { statusCode: number; setHeader: (name: string, value: string | number) => void; end: (body?: string) => void }, next: () => void) => void) => void } }) {
    attachRenderMiddleware(server);
  },
});

const attachRenderMiddleware = (server: { middlewares: { use: (fn: (req: { url?: string; method?: string }, res: { statusCode: number; setHeader: (name: string, value: string | number) => void; end: (body?: string) => void }, next: () => void) => void) => void } }) => {
    const renderRoot = resolve(
      process.env.LUMINA_FACTORY_RENDER_DIR ||
        resolve(process.cwd(), "public", "renders"),
    );
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url || "").split("?", 1)[0];
      if (!pathname.startsWith("/renders/")) return next();
      let decoded = "";
      try {
        decoded = decodeURIComponent(pathname.slice("/renders/".length));
      } catch {
        res.statusCode = 400;
        return res.end("Invalid render path");
      }
      const filePath = resolve(renderRoot, decoded);
      if (!filePath.startsWith(`${renderRoot}${sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.statusCode = 404;
        return res.end("Not Found");
      }
      const stat = statSync(filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(decoded)}`);
      if (req.method === "HEAD") return res.end();
      createReadStream(filePath).pipe(res as never);
    });
};

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      // Vite enables console forwarding automatically when it detects an AI
      // agent. During the initial HMR handshake that forwarder can recursively
      // report its own "send was called before connect" rejection.
      forwardConsole: false,
      proxy: {
        "/pb": {
          target: "http://127.0.0.1:8090",
          // Preserve the local UI Origin header. PocketBase's custom routes
          // intentionally reject requests that do not come from the app.
          changeOrigin: false,
          headers: {
            "x-lumina-ui": "local",
          },
          rewrite: (path) => path.replace(/^\/pb/, ""),
        },
      },
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      localRenderFiles(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
