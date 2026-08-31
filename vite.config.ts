import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.ts";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

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
      host: "127.0.0.1",
      // Vite enables console forwarding automatically when it detects an AI
      // agent. During the initial HMR handshake that forwarder can recursively
      // report its own "send was called before connect" rejection.
      forwardConsole: false,
      proxy: {
        "/pb-local": {
          target: "http://127.0.0.1:8090",
          // Preserve the local UI Origin header. PocketBase's custom routes
          // intentionally reject requests that do not come from the app.
          changeOrigin: false,
          configure: (proxy) => {
            // Native <video>/<img> requests cannot attach application headers.
            // This proxy is bound to the local dev server only; hosted builds
            // never include it and continue through authenticated gateways.
            proxy.on("proxyReq", (proxyRequest) => proxyRequest.setHeader("x-lumina-ui", "local"));
          },
          rewrite: (path) => {
            const rewritten = path
              .replace(/^\/pb-local\/api\/collections\/([^/]+)\/records/, "/api/lumina/local-ui/collections/$1/records")
              .replace(/^\/pb-local\/api\/files\/([^/]+)\//, "/api/lumina/local-ui/files/$1/")
              .replace(/^\/pb-local/, "");
            const target = new URL(rewritten, "http://local-pocketbase");
            // PocketBase applies `fields` to the custom response envelope,
            // not each item. The local adapter already returns public fields.
            target.searchParams.delete("fields");
            return `${target.pathname}${target.search}`;
          },
        },
      },
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
