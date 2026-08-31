from __future__ import annotations

import os
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from processor.semantic_analysis import AnalysisFailed


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _origin(value: str) -> tuple[str, str, int | None]:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise AnalysisFailed("narration audio URL is invalid")
    return parsed.scheme.lower(), parsed.hostname.lower(), parsed.port


def download_same_origin_media(
    source: str,
    target: Path,
    *,
    trusted_base_url: str,
    max_bytes: int = 100 * 1024 * 1024,
    timeout_seconds: float = 120,
    max_redirects: int = 2,
) -> int:
    """Download a bounded upload from the renderer's trusted media origin.

    Narration is an uploaded production asset, not a general URL fetch feature.
    Requiring every redirect to remain on the configured PocketBase origin avoids
    turning a render job into an SSRF primitive, including localhost/cloud-metadata
    redirects. The file is only published to ``target`` after a complete download.
    """

    trusted_origin = _origin(trusted_base_url)
    current = source
    opener = urllib.request.build_opener(_NoRedirect())
    deadline = time.monotonic() + timeout_seconds
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".partial", dir=target.parent)
    os.close(temporary_fd)
    temporary = Path(temporary_name)
    try:
        for redirects in range(max_redirects + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AnalysisFailed("narration audio download timed out")
            if _origin(current) != trusted_origin:
                raise AnalysisFailed("narration audio URL must use the trusted media origin")
            request = urllib.request.Request(current, headers={"Accept": "audio/*,application/octet-stream;q=0.8", "User-Agent": "Lumina-Factory-Renderer/1.0"})
            try:
                response = opener.open(request, timeout=remaining)
            except urllib.error.HTTPError as exc:
                if exc.code in {301, 302, 303, 307, 308}:
                    location = exc.headers.get("Location")
                    exc.close()
                    if not location or redirects >= max_redirects:
                        raise AnalysisFailed("narration audio redirect is invalid or excessive") from exc
                    current = urllib.parse.urljoin(current, location)
                    continue
                raise AnalysisFailed(f"narration audio download failed (HTTP {exc.code})") from exc
            except (OSError, urllib.error.URLError) as exc:
                raise AnalysisFailed(f"narration audio download failed: {exc}") from exc
            with response:
                declared = response.headers.get("Content-Length")
                if declared:
                    try:
                        if int(declared) > max_bytes:
                            raise AnalysisFailed("narration audio exceeds the 100 MiB limit")
                    except ValueError as exc:
                        raise AnalysisFailed("narration audio has an invalid Content-Length") from exc
                written = 0
                with temporary.open("wb") as output:
                    while chunk := response.read(1024 * 1024):
                        if time.monotonic() > deadline:
                            raise AnalysisFailed("narration audio download timed out")
                        written += len(chunk)
                        if written > max_bytes:
                            raise AnalysisFailed("narration audio exceeds the 100 MiB limit")
                        output.write(chunk)
                if written == 0:
                    raise AnalysisFailed("narration audio download is empty")
                os.replace(temporary, target)
                return written
        raise AnalysisFailed("narration audio redirect is excessive")
    finally:
        temporary.unlink(missing_ok=True)
