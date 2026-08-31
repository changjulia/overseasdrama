"""Real PocketBase + worker queue E2E for the episode-splice delivery path."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from processor.job_worker import process_available


ROOT = Path(__file__).resolve().parents[2]
PB = ROOT / "tools" / "pocketbase" / "pocketbase"
FFMPEG = ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg"
FFPROBE = next(
    (p for p in sorted((ROOT / "node_modules" / "@ffprobe-installer").glob("*/ffprobe")) if p.is_file()),
    ROOT / "node_modules" / "@ffprobe-installer" / "missing-ffprobe",
)


def request_json(base: str, path: str, *, method: str = "GET", payload: Any = None, token: str = "") -> tuple[int, Any]:
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"content-type": "application/json", "x-lumina-ui": "local"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(base + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        message = exc.read().decode(errors="replace")
        exc.close()
        raise AssertionError(f"{method} {path} -> {exc.code}: {message}") from exc


def upload_record(base: str, collection: str, fields: dict[str, str], file_field: str, media: Path, token: str) -> dict[str, Any]:
    boundary = "----lumina-" + uuid.uuid4().hex
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode(),))
    chunks.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{media.name}\"\r\nContent-Type: video/mp4\r\n\r\n".encode()
    )
    chunks.append(media.read_bytes())
    chunks.append(f"\r\n--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"{base}/api/collections/{collection}/records",
        data=b"".join(chunks), method="POST",
        headers={"authorization": f"Bearer {token}", "content-type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.loads(response.read())


class EpisodeSpliceQueueE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        missing = [str(path) for path in (PB, FFMPEG, FFPROBE) if not path.is_file()]
        if missing:
            raise unittest.SkipTest(f"missing project-pinned runtime: {missing}")
        cls.temp = tempfile.TemporaryDirectory(prefix="episode-splice-queue-e2e-")
        cls.root = Path(cls.temp.name)
        cls.data = cls.root / "pb_data"
        cls.public = cls.root / "public"
        cls.renders = cls.public / "renders"
        cls.media = cls.root / "media"
        cls.media.mkdir(parents=True)
        cls.public.mkdir()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            cls.port = probe.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.worker_token = "e2e-worker-" + uuid.uuid4().hex
        cls.admin_email = "episode-e2e@example.test"
        cls.admin_password = "Episode-E2E-Password-123!"
        common = [
            str(PB), "--dir", str(cls.data), "--hooksDir", str(ROOT / "pb_hooks"),
            "--migrationsDir", str(ROOT / "pb_migrations"), "--publicDir", str(cls.public),
            "--hooksWatch=false",
        ]
        subprocess.run(common + ["superuser", "upsert", cls.admin_email, cls.admin_password], check=True, capture_output=True, text=True)
        env = os.environ.copy()
        env["LUMINA_WORKER_TOKEN"] = cls.worker_token
        env["LUMINA_UI_MODE"] = "local-loopback"
        cls.server_log = (cls.root / "pocketbase.log").open("w+")
        cls.server = subprocess.Popen(
            common + ["serve", "--http", f"127.0.0.1:{cls.port}"],
            cwd=ROOT, env=env, stdout=cls.server_log, stderr=subprocess.STDOUT, text=True,
        )
        for _ in range(100):
            if cls.server.poll() is not None:
                cls.server_log.seek(0)
                raise RuntimeError(cls.server_log.read())
            try:
                request_json(cls.base, "/api/health")
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("isolated PocketBase did not become healthy")
        _, auth = request_json(cls.base, "/api/collections/_superusers/auth-with-password", method="POST", payload={"identity": cls.admin_email, "password": cls.admin_password})
        cls.admin_token = auth["token"]

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "server"):
            cls.server.terminate()
            try:
                cls.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.server.kill()
        if hasattr(cls, "server_log"):
            cls.server_log.close()
        if hasattr(cls, "temp"):
            cls.temp.cleanup()

    def make_episode(self, number: int) -> Path:
        target = self.media / f"episode-{number}.mp4"
        colors = ("0x174B7A", "0x287A52", "0x7A3E68")
        command = [
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c={colors[number-1]}:s=160x90:r=1:d=101",
            "-f", "lavfi", "-i", f"sine=frequency={440 + number * 110}:sample_rate=48000:duration=101",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "32k", "-shortest", str(target),
        ]
        subprocess.run(command, check=True, capture_output=True)
        return target

    def test_full_queue_review_and_export(self) -> None:
        unauthenticated = urllib.request.Request(
            self.base + "/api/lumina/factory/history"
        )
        with self.assertRaises(urllib.error.HTTPError) as denied:
            urllib.request.urlopen(unauthenticated, timeout=10)
        self.assertEqual(denied.exception.code, 403)
        denied.exception.close()

        _, drama = request_json(self.base, "/api/collections/dramas/records", method="POST", token=self.admin_token, payload={
            "external_id": "episode-splice-e2e", "title": "隔离正片验收剧", "cn": "隔离正片验收剧",
            "genre": "测试", "language": "英语", "total_episodes": 3, "free_episodes": 3,
            "copyright_status": "synthetic-test-only", "parse_state": "ready",
        })
        episodes = []
        for number in (1, 2, 3):
            source = self.make_episode(number)
            episodes.append(upload_record(self.base, "drama_episodes", {
                "drama": drama["id"], "episode_number": str(number), "original_name": source.name,
                "mime_type": "video/mp4", "byte_size": str(source.stat().st_size),
                "duration_seconds": "101", "analysis_status": "succeeded",
            }, "video", source, self.admin_token))
        _, highlight = request_json(self.base, "/api/collections/hook_assets/records", method="POST", token=self.admin_token, payload={
            "source_class": "episode_highlight", "drama": drama["id"], "episode": episodes[0]["id"],
            "highlight_id": "approved-e2e-highlight", "title": "合成首集高光", "start_seconds": 1,
            "end_seconds": 12, "boundary_status": "verified", "safe_start": {"status": "verified", "source": "precision_boundary"},
            "safe_end": {"status": "verified", "source": "precision_boundary"}, "review_status": "approved",
        })
        timeline = [
            {"episode": 1, "startSeconds": 1, "endSeconds": 101, "safeStart": {"status": "verified", "source": "selected_highlight_start"}, "safeEnd": {"status": "verified", "source": "episode_end"}},
            {"episode": 2, "startSeconds": 0, "endSeconds": 101, "safeStart": {"status": "verified", "source": "episode_start"}, "safeEnd": {"status": "verified", "source": "episode_end"}},
            {"episode": 3, "startSeconds": 0, "endSeconds": 101, "safeStart": {"status": "verified", "source": "episode_start"}, "safeEnd": {"status": "verified", "source": "episode_end"}},
        ]
        _, project = request_json(self.base, "/api/lumina/factory/episode-splice/projects", method="POST", payload={
            "title": "正片队列 E2E", "drama_id": drama["id"], "selected_episodes": [1, 2, 3],
            "timeline": timeline, "ratio": "9:16", "language": "英语",
        })
        self.assertEqual(project["status"], "ready")
        self.assertEqual(project["duration_seconds"], 302)
        _, persisted = request_json(self.base, f"/api/collections/factory_projects/records/{project['id']}", token=self.admin_token)
        canonical = persisted["timeline"]
        self.assertEqual(canonical[0]["safeStart"]["highlightAssetId"], highlight["id"])
        self.assertEqual(canonical[1]["safeStart"]["source"], "episode_start")
        _, transition_preview_job = request_json(
            self.base,
            f"/api/lumina/factory/projects/{project['id']}/transition-preview",
            method="POST",
            payload={},
        )
        previous_render_dir = os.environ.get("LUMINA_FACTORY_RENDER_DIR")
        os.environ["LUMINA_FACTORY_RENDER_DIR"] = str(self.renders)
        try:
            preview_processed = process_available(
                self.base, self.worker_token, "episode-splice-transition-review-worker",
                queue="material", job_id=transition_preview_job["id"],
            )
        finally:
            if previous_render_dir is None:
                os.environ.pop("LUMINA_FACTORY_RENDER_DIR", None)
            else:
                os.environ["LUMINA_FACTORY_RENDER_DIR"] = previous_render_dir
        self.assertTrue(preview_processed)
        _, transition_preview = request_json(
            self.base, f"/api/lumina/factory/projects/{project['id']}/transition-preview"
        )
        self.assertEqual(transition_preview["status"], "succeeded", transition_preview.get("error"))
        self.assertTrue(transition_preview["previewUrl"])
        self.assertTrue(transition_preview["previewHash"])
        _, transition_review = request_json(
            self.base,
            f"/api/lumina/factory/projects/{project['id']}/transition-review",
            method="POST",
            payload={"decision": "approved", "note": "真实审核片技术验收通过", "preview_version": transition_preview["previewVersion"], "preview_hash": transition_preview["previewHash"]},
        )
        self.assertEqual(transition_review["reviewStatus"], "approved")
        _, decoy_render = request_json(self.base, f"/api/lumina/factory/projects/{project['id']}/renders", method="POST", payload={})
        request_json(
            self.base,
            f"/api/collections/factory_projects/records/{project['id']}",
            method="PATCH",
            token=self.admin_token,
            payload={"status": "ready"},
        )
        _, render = request_json(self.base, f"/api/lumina/factory/projects/{project['id']}/renders", method="POST", payload={})
        previous_render_dir = os.environ.get("LUMINA_FACTORY_RENDER_DIR")
        os.environ["LUMINA_FACTORY_RENDER_DIR"] = str(self.renders)
        try:
            processed = process_available(self.base, self.worker_token, "episode-splice-e2e-worker", queue="material", job_id=render["id"])
        finally:
            if previous_render_dir is None:
                os.environ.pop("LUMINA_FACTORY_RENDER_DIR", None)
            else:
                os.environ["LUMINA_FACTORY_RENDER_DIR"] = previous_render_dir
        self.assertTrue(processed)
        _, untouched_decoy = request_json(self.base, f"/api/lumina/factory/renders/{decoy_render['id']}")
        self.assertEqual(untouched_decoy["status"], "queued")
        _, completed = request_json(self.base, f"/api/lumina/factory/renders/{render['id']}")
        self.assertEqual(completed["status"], "succeeded", completed.get("error"))
        self.assertTrue(completed["validation"]["passed"])
        self.assertTrue(completed["preview_url"].startswith("/renders/"))
        output = Path(completed["validation"]["file"])
        self.assertTrue(output.is_file())
        persisted_output_hash = persisted_hash(self.base, render["id"], self.admin_token)
        self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), persisted_output_hash)
        with urllib.request.urlopen(self.base + completed["preview_url"], timeout=30) as preview:
            self.assertGreater(int(preview.headers.get("content-length", "0")), 0)
        with self.assertRaisesRegex(AssertionError, "Export requires an approved human review for this exact render"):
            request_json(self.base, f"/api/lumina/factory/projects/{project['id']}/export", method="POST", payload={"render_id": render["id"]})
        _, review = request_json(self.base, f"/api/lumina/factory/projects/{project['id']}/review", method="POST", payload={"decision": "approved", "note": "隔离合成素材技术验收通过", "render_id": render["id"]})
        self.assertEqual(review["status"], "approved")
        _, exported = request_json(self.base, f"/api/lumina/factory/projects/{project['id']}/export", method="POST", payload={"render_id": render["id"], "file_name": "episode-splice-e2e.mp4"})
        self.assertEqual(exported["fileName"], "episode-splice-e2e.mp4")
        self.assertEqual(exported["outputSha256"], persisted_output_hash)


def persisted_hash(base: str, render_id: str, token: str) -> str:
    _, record = request_json(base, f"/api/collections/factory_renders/records/{render_id}", token=token)
    return record["output_sha256"]


if __name__ == "__main__":
    unittest.main()
