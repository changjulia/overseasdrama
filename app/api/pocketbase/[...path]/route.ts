import { getChatGPTUser } from "@/app/chatgpt-auth";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PB_URL = (process.env.POCKETBASE_URL || (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8090" : "")).replace(/\/$/, "");
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
const MAX_NARRATION_UPLOAD_REQUEST_BYTES = 101 * 1024 * 1024;

const READABLE_COLLECTIONS = new Set(["dramas", "drama_episodes", "ad_materials", "analysis_jobs", "hook_assets", "hook_match_jobs", "hook_story_matches", "material_analysis_jobs", "supplemental_highlight_jobs", "entry_precision_jobs"]);
const WRITABLE_COLLECTIONS = new Set(["dramas", "drama_episodes", "ad_materials"]);
const FILE_COLLECTIONS = new Set([
  "dramas", "pbc_lumdramas1",
  "drama_episodes", "pbc_lumepisodes",
  "ad_materials", "pbc_lumadmat001",
  "hook_assets", "pbc_lumhooks001",
  "factory_renders", "pbc_lumrenders1",
]);
const UI_LUMINA_ROUTES: Array<[string, RegExp]> = [
  ["POST", /^\/api\/lumina\/script-hook-candidates\/(?:query|decision)$/],
  ["POST", /^\/api\/lumina\/script-semantics\/(?:read|save|pair|save-pair)$/],
  ["GET", /^\/api\/lumina\/script-hook-candidates\/contexts\/[a-z0-9]{15}$/],
  ["POST", /^\/api\/lumina\/(?:storyline-plans|hook-driven-storyline-plans|story-hook-recommendations|historical-template-recommendations|template-adaptation-plans|hook-matching\/jobs|entry-precision\/jobs|factory\/projects|factory\/episode-splice\/projects)$/],
  ["POST", /^\/api\/lumina\/(?:hooks\/[^/]+\/review|hook-story-matches\/[^/]+\/(?:human-production-approval|soft-override|review)|hook-story-matches\/restore|materials\/[^/]+\/rights|material-analysis\/materials\/[^/]+\/retry|analysis\/dramas\/[^/]+\/(?:start|retry-detail|retry-precision|reanalyze|reproject-precision-assets)|analysis\/jobs\/[^/]+\/(?:pause|resume|retry)|factory\/projects\/[^/]+\/(?:renders|review|export|transition-preview|transition-review|narration-audio))$/],
  ["POST", /^\/api\/lumina\/(?:hook-matching\/jobs\/[^/]+\/retry|supplemental-highlights\/jobs\/[^/]+\/retry|entry-precision\/jobs\/[^/]+\/retry|factory\/renders\/[^/]+\/retry)$/],
  ["DELETE", /^\/api\/lumina\/analysis\/jobs\/[^/]+$/],
  ["DELETE", /^\/api\/lumina\/factory\/projects\/[^/]+\/narration-audio\/[^/]+$/],
  ["GET", /^\/api\/lumina\/(?:factory\/history|factory\/renders\/[^/]+|factory\/projects\/[^/]+\/transition-preview|hook-matching\/jobs\/[^/]+\/status)$/],
];

let pocketBaseAdminToken = "";
let pocketBaseAdminTokenCreatedAt = 0;
let pocketBaseAdminTokenRequest: Promise<string> | null = null;

async function getPocketBaseAdminToken(forceRefresh = false): Promise<string> {
  const identity = process.env.LUMINA_POCKETBASE_SUPERUSER_IDENTITY;
  const password = process.env.LUMINA_POCKETBASE_SUPERUSER_PASSWORD;
  if (!identity || !password || !PB_URL) throw new Error("PocketBase gateway superuser is not configured");
  // Keep the PocketBase JWT only in this server process and refresh it often;
  // browsers never receive either the credentials or the token.
  if (!forceRefresh && pocketBaseAdminToken && Date.now() - pocketBaseAdminTokenCreatedAt < 5 * 60_000) return pocketBaseAdminToken;
  if (!forceRefresh && pocketBaseAdminTokenRequest) return pocketBaseAdminTokenRequest;
  pocketBaseAdminTokenRequest = (async () => {
    const response = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity, password }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("PocketBase gateway superuser authentication failed");
    const payload = await response.json() as { token?: unknown };
    if (typeof payload.token !== "string" || !payload.token) throw new Error("PocketBase gateway superuser token missing");
    pocketBaseAdminToken = payload.token;
    pocketBaseAdminTokenCreatedAt = Date.now();
    return pocketBaseAdminToken;
  })();
  try {
    return await pocketBaseAdminTokenRequest;
  } finally {
    pocketBaseAdminTokenRequest = null;
  }
}

function safePath(parts: string[], method: string): string | null {
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\"))) return null;
  const path = `/${parts.map(encodeURIComponent).join("/")}`;
  if (path.length > 1000) return null;
  const collectionMatch = path.match(/^\/api\/collections\/([^/]+)\/records(?:\/([^/]+))?$/);
  if (collectionMatch) {
    const [, collection, id] = collectionMatch;
    if (!READABLE_COLLECTIONS.has(collection)) return null;
    if (method === "GET") return path;
    if (WRITABLE_COLLECTIONS.has(collection) && ((method === "POST" && !id) || ((method === "PATCH" || method === "DELETE") && Boolean(id)))) return path;
    return null;
  }
  const fileMatch = path.match(/^\/api\/files\/([^/]+)\/[^/]+\/[^/]+$/);
  if ((method === "GET" || method === "HEAD") && fileMatch && FILE_COLLECTIONS.has(fileMatch[1])) return path;
  if (method === "GET" && path === "/api/health") return path;
  return UI_LUMINA_ROUTES.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(path)) ? path : null;
}

function csrfAllowed(request: NextRequest): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  return Boolean(origin && origin === request.nextUrl.origin && (!site || site === "same-origin"));
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ message: "ChatGPT authentication required" }, { status: 401 });
  const token = process.env.LUMINA_UI_GATEWAY_TOKEN;
  if (!token || !PB_URL) return NextResponse.json({ message: "PocketBase UI gateway is not configured" }, { status: 503 });
  if (!csrfAllowed(request)) return NextResponse.json({ message: "Cross-site request rejected" }, { status: 403 });

  const path = safePath((await context.params).path, request.method);
  if (!path) return NextResponse.json({ message: "PocketBase path is not allowed" }, { status: 403 });
  if (request.method === "POST" && /^\/api\/lumina\/factory\/projects\/[^/]+\/narration-audio$/.test(path)) {
    // The current hosted stream adapter can otherwise wait indefinitely when
    // proxying an unbounded chunked multipart body to PocketBase. Browser XHR
    // FormData provides Content-Length at the HTTP edge; fail closed if an
    // intermediary removes it rather than silently accepting a slow stream.
    const declaredLength = request.headers.get("content-length");
    if (declaredLength == null) return NextResponse.json({ message: "Narration audio upload requires Content-Length" }, { status: 411 });
    if (!/^\d+$/.test(declaredLength)) return NextResponse.json({ message: "Invalid Content-Length" }, { status: 400 });
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length <= 0) return NextResponse.json({ message: "Invalid Content-Length" }, { status: 400 });
    if (length > MAX_NARRATION_UPLOAD_REQUEST_BYTES) return NextResponse.json({ message: "Narration audio upload exceeds 100 MiB plus multipart overhead" }, { status: 413 });
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== "authorization" && key.toLowerCase() !== "cookie" && key.toLowerCase() !== "x-lumina-ui" && key.toLowerCase() !== "x-lumina-user-id" && !key.toLowerCase().startsWith("x-forwarded-") && !key.toLowerCase().startsWith("oai-authenticated-")) headers.set(key, value);
  });
  const isCollectionRequest = /^\/api\/collections\/[a-z_]+\/records(?:\/[^/]+)?$/.test(path);
  const needsPocketBaseAdmin = isCollectionRequest || path.startsWith("/api/files/");
  try {
    headers.set("authorization", `Bearer ${needsPocketBaseAdmin ? await getPocketBaseAdminToken() : token}`);
  } catch {
    return NextResponse.json({ message: "PocketBase gateway authentication unavailable" }, { status: 503 });
  }
  headers.set("x-lumina-user-id", user.userId);

  const target = new URL(`${PB_URL}${path}`);
  target.search = request.nextUrl.search;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      cache: "no-store",
      // Required by Node fetch when streaming an incoming request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    // A streamed upload body cannot be replayed safely. Tokens are refreshed
    // every five minutes, so retry only idempotent bodyless reads here.
    if (needsPocketBaseAdmin && upstream.status === 401 && (request.method === "GET" || request.method === "HEAD")) {
      headers.set("authorization", `Bearer ${await getPocketBaseAdminToken(true)}`);
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        cache: "no-store",
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    }
  } catch {
    return NextResponse.json({ message: "PocketBase gateway unavailable" }, { status: 502 });
  }
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== "set-cookie") responseHeaders.set(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
