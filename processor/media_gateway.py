"""Internal-only redirect service behind the website's authentication gateway."""
from __future__ import annotations

import os
import json
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from processor.object_storage import media_client


def object_key(path: str) -> str | None:
    key = unquote(urlsplit(path).path).lstrip("/")
    parts = key.split("/")
    if len(parts) < 2 or parts[0] not in {"renders", "material-covers", "material-previews", "material-analysis"}:
        return None
    if any(part in {"", ".", ".."} or "\\" in part or any(ord(c) < 32 for c in part) for part in parts):
        return None
    return key


def pocketbase_media_key(path: str) -> str | None:
    """Accept only a single PocketBase collection/record/file object path."""
    key = unquote(urlsplit(path).path).removeprefix("/media/").lstrip("/")
    parts = key.split("/")
    if len(parts) != 3 or parts[0] not in {"pbc_lumepisodes", "pbc_lumadmat001"}:
        return None
    if any(part in {"", ".", ".."} or "\\" in part or any(ord(c) < 32 for c in part) for part in parts):
        return None
    if not parts[-1].lower().endswith((".mp4", ".mov", ".m4v", ".webm")):
        return None
    return "/".join(parts)


class Handler(BaseHTTPRequestHandler):
    def _stream_pocketbase_media(self, key: str, head_only: bool = False):
        try:
            client = media_client()
            kwargs = {"Bucket": os.environ["COS_BUCKET"], "Key": key}
            requested_range = self.headers.get("Range", "").strip()
            if requested_range:
                if not requested_range.startswith("bytes=") or len(requested_range) > 128:
                    self.send_error(416, "Invalid media range")
                    return
                kwargs["Range"] = requested_range
            if head_only:
                result = client.head_object(**kwargs)
                self.send_response(200)
                self.send_header("Content-Type", result.get("ContentType") or "video/mp4")
                self.send_header("Content-Length", str(result.get("ContentLength", 0)))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "private, no-store")
                self.end_headers()
                return
            result = client.get_object(**kwargs)
            metadata = result.get("ResponseMetadata", {}).get("HTTPStatusCode", 200)
            self.send_response(206 if requested_range else metadata)
            self.send_header("Content-Type", result.get("ContentType") or "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "private, no-store")
            for header, field in (("Content-Length", "ContentLength"), ("Content-Range", "ContentRange"), ("ETag", "ETag"), ("Last-Modified", "LastModified")):
                value = result.get(field)
                if value is not None:
                    self.send_header(header, str(value))
            self.end_headers()
            body = result["Body"]
            while chunk := body.read(256 * 1024):
                self.wfile.write(chunk)
        except Exception:
            self.send_error(503, "Media storage unavailable")

    def do_POST(self):
        # Called only by PocketBase after its file/record permission checks.
        secret = os.environ.get("LUMINA_WORKER_TOKEN", "")
        if self.path != "/sign" or not secret or not hmac.compare_digest(self.headers.get("X-Media-Token", ""), secret):
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                raise ValueError("Invalid request size")
            key = json.loads(self.rfile.read(size)).get("key", "")
            parts = key.split("/")
            if len(parts) != 3 or parts[0] not in {"pbc_lumepisodes", "pbc_lumadmat001"}:
                raise ValueError("Invalid media key")
            if any(not part or part in {".", ".."} or "\\" in part or any(ord(c) < 32 for c in part) for part in parts):
                raise ValueError("Invalid media path")
            if not parts[-1].lower().endswith((".mp4", ".mov", ".m4v", ".webm")):
                raise ValueError("Not a video")
            url = media_client().generate_presigned_url("get_object", Params={"Bucket": os.environ["COS_BUCKET"], "Key": key}, ExpiresIn=900)
        except (ValueError, TypeError, AttributeError):
            self.send_error(400)
            return
        except Exception:
            self.send_error(503)
            return
        body = json.dumps({"url": url}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        media_key = pocketbase_media_key(self.path)
        if media_key is not None:
            return self._stream_pocketbase_media(media_key)
        if self.path == "/health":
            self.send_response(204)
            self.end_headers()
            return
        key = object_key(self.path)
        if key is None:
            self.send_error(404)
            return
        try:
            url = media_client().generate_presigned_url(
                "head_object" if self.command == "HEAD" else "get_object",
                Params={"Bucket": os.environ["COS_BUCKET"], "Key": key}, ExpiresIn=900,
            )
        except Exception:
            self.send_error(503, "Media storage unavailable")
            return
        self.send_response(302)
        self.send_header("Location", url)
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        media_key = pocketbase_media_key(self.path)
        if media_key is not None:
            return self._stream_pocketbase_media(media_key, head_only=True)
        return self.do_GET()

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
