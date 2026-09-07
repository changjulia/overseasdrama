import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const authPort = Number(process.env.LUMINA_LOCAL_AUTH_PORT || 8077);
const authUrl = `http://127.0.0.1:${authPort}`;
const authDb = resolve(projectRoot, ".codex-runtime", "auth", "accounts.sqlite");
const appOrigin = process.env.LUMINA_LOCAL_APP_ORIGIN || "http://localhost:3000";
const pocketBaseHealthUrl = "http://127.0.0.1:8090/api/health";
mkdirSync(resolve(authDb, ".."), { recursive: true });

async function serviceIsReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForService(label, url, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await serviceIsReady(url)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`${label}启动超时`);
}

let ownsAuth = false;
let authProcess = null;
if (!(await serviceIsReady(`${authUrl}/health`))) {
  ownsAuth = true;
  authProcess = spawn(process.env.PYTHON || "python", [resolve(projectRoot, "deploy", "auth_service.py")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTH_DB: authDb,
      AUTH_HOST: "127.0.0.1",
      AUTH_ORIGIN: appOrigin,
      AUTH_PORT: String(authPort),
      AUTH_SECURE: "0",
      AUTH_ALLOW_FIRST_ADMIN: "1",
      AUTH_BOOTSTRAP: resolve(projectRoot, ".codex-runtime", "auth", "bootstrap.json"),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  authProcess.once("exit", (code) => {
    if (code && code !== 0) console.error(`本地账号服务已退出（${code}）`);
  });
}

let ownsPocketBase = false;
let pocketBaseProcess = null;
if (!(await serviceIsReady(pocketBaseHealthUrl))) {
  ownsPocketBase = true;
  const onWindows = process.platform === "win32";
  pocketBaseProcess = spawn(
    onWindows ? "powershell.exe" : "bash",
    onWindows
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(projectRoot, "scripts", "start-pocketbase.ps1")]
      : [resolve(projectRoot, "scripts", "start-pocketbase.sh")],
    {
      cwd: projectRoot,
      env: { ...process.env, LUMINA_AUTO_START_WORKERS: "0" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  pocketBaseProcess.once("exit", (code) => {
    if (code && code !== 0) console.error(`PocketBase 已退出（${code}）`);
  });
}

function terminate(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

try {
  await Promise.all([
    waitForService("本地账号服务", `${authUrl}/health`, 12_000),
    waitForService("PocketBase", pocketBaseHealthUrl, 30_000),
  ]);
} catch (error) {
  if (ownsAuth) terminate(authProcess);
  if (ownsPocketBase) terminate(pocketBaseProcess);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const appProcess = spawn(process.execPath, [resolve(projectRoot, "node_modules", "vinext", "dist", "cli.js"), "dev"], {
  cwd: projectRoot,
  env: { ...process.env, LUMINA_LOCAL_AUTH_URL: authUrl },
  stdio: "inherit",
  windowsHide: true,
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  terminate(appProcess);
  if (ownsAuth) terminate(authProcess);
  if (ownsPocketBase) terminate(pocketBaseProcess);
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
appProcess.once("exit", (code) => stop(code ?? 1));
