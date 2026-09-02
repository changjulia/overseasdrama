import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";

const RENDER_DIR = path.resolve(
  process.env.LUMINA_FACTORY_RENDER_DIR || path.join(process.cwd(), "public", "renders"),
);

type RouteContext = {
  params: Promise<{ file: string }> | { file: string };
};

async function renderFile(context: RouteContext) {
  const { file } = await context.params;
  const decoded = decodeURIComponent(file);
  if (decoded !== path.basename(decoded) || !decoded.toLowerCase().endsWith(".mp4")) {
    return null;
  }
  const absolute = path.resolve(RENDER_DIR, decoded);
  if (path.dirname(absolute) !== RENDER_DIR) return null;
  try {
    const metadata = await stat(absolute);
    return metadata.isFile() ? { absolute, size: metadata.size } : null;
  } catch {
    return null;
  }
}

function baseHeaders(size: number) {
  return {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Type": "video/mp4",
    "Content-Length": String(size),
  };
}

export async function HEAD(_request: NextRequest, context: RouteContext) {
  const file = await renderFile(context);
  if (!file) return new Response(null, { status: 404 });
  return new Response(null, { status: 200, headers: baseHeaders(file.size) });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const file = await renderFile(context);
  if (!file) return new Response("Not found", { status: 404 });

  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${file.size}` },
      });
    }
    const start = match[1] ? Number(match[1]) : 0;
    const requestedEnd = match[2] ? Number(match[2]) : file.size - 1;
    const end = Math.min(requestedEnd, file.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${file.size}` },
      });
    }
    const length = end - start + 1;
    const stream = Readable.toWeb(createReadStream(file.absolute, { start, end }));
    return new Response(stream as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders(length),
        "Content-Range": `bytes ${start}-${end}/${file.size}`,
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(file.absolute));
  return new Response(stream as ReadableStream, {
    status: 200,
    headers: baseHeaders(file.size),
  });
}
