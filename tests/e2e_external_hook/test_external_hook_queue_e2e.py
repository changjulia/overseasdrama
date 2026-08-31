"""PocketBase + real worker/FFmpeg E2E for external-hook production.

All state is created below a TemporaryDirectory.  In particular this suite
never reads or writes the repository's pb_data directory, port 8090, or the
normal public/renders directory.  The media is synthetic and proves plumbing,
boundary/QC/hash gates, and queue state transitions; it does not replace a
human semantic/business acceptance pass with licensed production footage.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import requests

from processor.factory_render import RenderConstraints, render_factory_project
from processor.job_worker import process_available


ROOT = Path(__file__).resolve().parents[2]
POCKETBASE = ROOT / "tools" / "pocketbase" / "pocketbase"
FFMPEG = ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg"
FFPROBE = next(
    (item for item in (ROOT / "node_modules" / "@ffprobe-installer").glob("**/ffprobe") if item.is_file()),
    ROOT / "node_modules" / "@ffprobe-installer" / "missing-ffprobe",
)
WORKER_TOKEN = "isolated-external-hook-worker-token"
ADMIN_EMAIL = "external-hook-e2e@example.test"
ADMIN_PASSWORD = "external-hook-e2e-password-123"
CONSTRAINTS = RenderConstraints(
    dimensions={"9:16": (180, 320)},
    episode_splice_duration=(1, 900),
    external_hook_duration=(1, 900),
)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class ExternalHookQueueE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        missing = [str(item) for item in (POCKETBASE, FFMPEG, FFPROBE) if not item.is_file()]
        if missing:
            raise unittest.SkipTest(f"project-pinned runtimes missing: {missing}")
        cls.temp = tempfile.TemporaryDirectory(prefix="lumina-external-hook-e2e-")
        cls.sandbox = Path(cls.temp.name)
        cls.data = cls.sandbox / "pb_data"
        cls.outputs = cls.sandbox / "renders"
        cls.data.mkdir()
        cls.outputs.mkdir()
        cls.port = _free_port()
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        common = [
            str(POCKETBASE), "--dir", str(cls.data),
            "--hooksDir", str(ROOT / "pb_hooks"),
            "--migrationsDir", str(ROOT / "pb_migrations"),
        ]
        subprocess.run(common + ["migrate", "up"], cwd=ROOT, check=True, capture_output=True, text=True)
        subprocess.run(common + ["superuser", "upsert", ADMIN_EMAIL, ADMIN_PASSWORD], cwd=ROOT, check=True, capture_output=True, text=True)
        env = {
            **os.environ,
            "LUMINA_WORKER_TOKEN": WORKER_TOKEN,
            "LUMINA_UI_MODE": "local-loopback",
            "LUMINA_POCKETBASE_WORKER_BASE_URL": cls.base_url,
            "LUMINA_FFPROBE_PATH": str(FFPROBE),
            "LUMINA_SHA256_PATH": "/usr/bin/shasum",
        }
        cls.server_log = (cls.sandbox / "pocketbase.log").open("w", encoding="utf-8")
        cls.server = subprocess.Popen(
            common + ["serve", "--dev", f"--http=127.0.0.1:{cls.port}"],
            cwd=ROOT, env=env, stdout=cls.server_log, stderr=subprocess.STDOUT, text=True,
        )
        for _ in range(100):
            try:
                if requests.get(f"{cls.base_url}/api/health", timeout=0.2).ok:
                    break
            except requests.RequestException:
                pass
            time.sleep(0.1)
        else:
            cls._stop_server()
            raise RuntimeError("isolated PocketBase did not become healthy")
        response = requests.post(
            f"{cls.base_url}/api/collections/_superusers/auth-with-password",
            json={"identity": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=10,
        )
        response.raise_for_status()
        cls.admin_headers = {"Authorization": f"Bearer {response.json()['token']}"}

    @classmethod
    def _stop_server(cls) -> None:
        if getattr(cls, "server", None) is not None:
            cls.server.terminate()
            try:
                cls.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.server.kill()
                cls.server.wait(timeout=5)
        if getattr(cls, "server_log", None) is not None:
            cls.server_log.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._stop_server()
        cls.temp.cleanup()

    def _create_video(self, name: str, color: str, seconds: float, frequency: int) -> Path:
        target = self.sandbox / name
        subprocess.run([
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c={color}:s=160x90:r=12:d={seconds}",
            "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration={seconds}",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(target),
        ], check=True, capture_output=True)
        return target

    def _create_narration(self, name: str, seconds: float = 60.0) -> Path:
        target = self.sandbox / name
        subprocess.run([
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"sine=frequency=330:sample_rate=48000:duration={seconds}",
            "-c:a", "pcm_s16le", str(target),
        ], check=True, capture_output=True)
        return target

    def _create_record(self, collection: str, data: dict[str, object], video: Path | None = None) -> dict[str, object]:
        files = {"video": (video.name, video.open("rb"), "video/mp4")} if video else None
        try:
            response = requests.post(
                f"{self.base_url}/api/collections/{collection}/records",
                headers=self.admin_headers, data={key: json.dumps(value) if isinstance(value, (dict, list, bool)) else str(value) for key, value in data.items()},
                files=files, timeout=120,
            )
        finally:
            if files:
                files["video"][1].close()
        response.raise_for_status()
        return response.json()

    def _ui_post(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        response = requests.post(
            f"{self.base_url}{path}",
            json=payload,
            headers={"x-lumina-ui": "local"},
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _pinned_executable(name: str) -> str:
        return str(FFMPEG if name == "ffmpeg" else FFPROBE)

    def test_external_hook_project_claim_render_review_and_export(self) -> None:
        hook_video = self._create_video("synthetic-hook.mp4", "red", 6, 440)
        episode_videos = [
            self._create_video("synthetic-episode-1.mp4", "blue", 100, 550),
            self._create_video("synthetic-episode-2.mp4", "green", 100, 660),
            self._create_video("synthetic-episode-3.mp4", "purple", 100, 770),
        ]
        drama = self._create_record("dramas", {
            "external_id": "isolated-external-e2e", "title": "Synthetic Queue Drama", "cn": "合成队列验收剧",
            "genre": "acceptance", "language": "英语", "total_episodes": 3, "free_episodes": 3,
            "copyright_status": "synthetic-test-only", "parse_state": "ready", "parse_config": {}, "analysis": {},
        })
        episodes = []
        for number, video in enumerate(episode_videos, 1):
            episodes.append(self._create_record("drama_episodes", {
                "drama": drama["id"], "episode_number": number, "original_name": video.name,
                "mime_type": "video/mp4", "byte_size": video.stat().st_size, "duration_seconds": 100,
                "analysis_status": "succeeded", "analysis_result": {"synthetic": True},
            }, video))
        material = self._create_record("ad_materials", {
            "title": "Synthetic External Hook", "type": "ad", "source": "isolated-e2e", "language": "英语",
            "original_name": hook_video.name, "mime_type": "video/mp4", "byte_size": hook_video.stat().st_size,
            "duration_seconds": 6, "analysis_status": "succeeded", "analysis_progress": 100,
            "analysis_result": {"synthetic": True}, "review_status": "approved",
        }, hook_video)
        verified = {"status": "verified", "source": "human_review", "evidence": [{"source": "synthetic_e2e"}]}
        hook = self._create_record("hook_assets", {
            "source_class": "external_material", "material": material["id"], "title": "Approved synthetic external hook",
            "start_seconds": 0, "end_seconds": 6, "boundary_status": "verified", "safe_start": verified,
            "safe_end": verified, "narrative_promise": "Will the protagonist escape?", "evidence": [{"source": "synthetic_e2e"}],
            "rights_status": "synthetic-test-only", "review_status": "approved", "hook_source_status": "已确认外搭",
            "hook_assembly_type": "跨剧外搭",
        })
        # The approved match anchors only the first highlight.  The production
        # timeline then continues through two full episodes, which specifically
        # exercises the queue claim's sequential episode expansion.
        segments = [{
            "episode": 1, "start": 0, "end": 100, "purpose": "story",
            "safeStart": {"status": "verified", "source": "approved_highlight_start"},
            "safeEnd": {"status": "verified", "source": "episode_end"},
            "evidence": [{"source": "synthetic_e2e", "episode": 1}],
        }]
        match = self._create_record("hook_story_matches", {
            "hook": hook["id"], "drama": drama["id"], "topics": ["escape"], "episode_scope": [1, 2, 3],
            "story_arc": {"synthetic": True}, "segments": segments, "match_score": 90,
            "story_score": 90, "promise_fulfillment_score": 90, "causal_completeness_score": 90,
            "dimension_scores": {}, "evidence": [{"source": "synthetic_e2e"}], "risks": [], "status": "approved",
            "analysis_version": "synthetic-e2e", "match_context": {"matchStrategy": "hook_to_story"},
            "production_gate": {"passed": True}, "calibration": {"calibratedProbability": .9, "evidenceCoverage": .9, "boundaryReliability": .9},
            "completeness": {"score": .9, "causalCoverage": .9},
        })
        timeline = [{"episode": number, "startSeconds": 0, "endSeconds": 100} for number in range(1, 4)]
        transition = {
            "type": "continuous_narration", "gapDiagnosis": ["causal"], "start": 0, "end": 60,
            "script": "他必须在真相曝光前找到逃生的证据。故事从这场追逐开始，并继续交代人物关系和因果。",
            "language": "zh-CN", "evidence": [{"source": "synthetic-test"}],
            "renderConfig": {"subtitleFormat": "ass"}, "reviewStatus": "draft", "reviewerNote": "",
            "version": 1, "bodyAssemblyMode": "sequential_from_highlight",
            "voice": {"mode": "pending"},
        }
        project = self._ui_post("/api/lumina/factory/projects", {
            "title": "External hook isolated queue E2E", "drama_id": drama["id"], "hook_id": hook["id"],
            "story_match_id": match["id"], "selected_episodes": [1, 2, 3], "topics": ["escape"],
            "transition": transition,
            "timeline": timeline, "quality_report": {}, "ratio": "9:16", "language": "英语",
        })
        narration = self._create_narration("synthetic-narration.wav")
        narration_sha256 = hashlib.sha256(narration.read_bytes()).hexdigest()
        with narration.open("rb") as stream:
            upload_response = requests.post(
                f"{self.base_url}/api/lumina/factory/projects/{project['id']}/narration-audio",
                headers={"x-lumina-ui": "local"},
                data={"durationSeconds": "60", "sha256": narration_sha256},
                files={"audio": (narration.name, stream, "audio/wav")},
                timeout=120,
            )
        if not upload_response.ok:
            self.server_log.flush()
            server_tail = (self.sandbox / "pocketbase.log").read_text(encoding="utf-8")[-4000:]
            self.fail(f"narration upload failed: {upload_response.status_code} {upload_response.text}\n{server_tail}")
        audio_asset = upload_response.json()
        self.assertEqual(audio_asset["sha256"], narration_sha256)
        self.assertEqual(audio_asset["projectId"], project["id"])
        transition["voice"] = {
            "mode": "manual_audio", "assetId": audio_asset["assetId"],
            "audioUrl": audio_asset["audioUrl"], "sha256": audio_asset["sha256"],
            "byteSize": audio_asset["byteSize"], "mimeType": audio_asset["mimeType"],
            "durationSeconds": audio_asset["durationSeconds"],
        }
        project = self._ui_post("/api/lumina/factory/projects", {
            "id": project["id"], "title": "External hook isolated queue E2E",
            "drama_id": drama["id"], "hook_id": hook["id"], "story_match_id": match["id"],
            "selected_episodes": [1, 2, 3], "topics": ["escape"], "transition": transition,
            "timeline": timeline, "quality_report": {}, "ratio": "9:16", "language": "英语",
        })
        def compact_transition_preview(response: dict[str, object], base_url: str, workspace: Path, on_progress=None):
            return render_factory_project(response, base_url, workspace, self.outputs, on_progress, constraints=CONSTRAINTS)

        transition_preview_job = self._ui_post(f"/api/lumina/factory/projects/{project['id']}/transition-preview", {})
        with patch.dict(os.environ, {"LUMINA_FACTORY_RENDER_DIR": str(self.outputs)}), \
             patch("processor.job_worker.execute_factory_render_job", side_effect=compact_transition_preview), \
             patch("processor.factory_render._executable", self._pinned_executable):
            preview_processed = process_available(
                self.base_url, WORKER_TOKEN, "external-hook-transition-review-worker",
                queue="material", job_id=str(transition_preview_job["id"]),
            )
        self.assertTrue(preview_processed)
        preview_response = requests.get(
            f"{self.base_url}/api/lumina/factory/projects/{project['id']}/transition-preview",
            headers={"x-lumina-ui": "local"}, timeout=10,
        )
        preview_response.raise_for_status()
        transition_preview = preview_response.json()
        self.assertEqual(transition_preview["status"], "succeeded", transition_preview.get("error"))
        self.assertTrue(transition_preview["previewUrl"])
        self.assertTrue(transition_preview["previewHash"])
        preview_render_response = requests.get(
            f"{self.base_url}/api/lumina/factory/renders/{transition_preview['renderId']}",
            headers={"x-lumina-ui": "local"}, timeout=10,
        )
        preview_render_response.raise_for_status()
        preview_validation = preview_render_response.json()["validation"]
        expected_lineage = {
            "audioAssetId": audio_asset["assetId"],
            "audioSha256": narration_sha256,
            "transitionVersion": 1,
        }
        self.assertEqual(
            {key: preview_validation[key] for key in expected_lineage},
            expected_lineage,
        )
        transition_review = self._ui_post(f"/api/lumina/factory/projects/{project['id']}/transition-review", {
            "decision": "approved", "note": "真实审核片技术验收通过",
            "preview_version": transition_preview["previewVersion"], "preview_hash": transition_preview["previewHash"],
        })
        self.assertEqual(transition_review["reviewStatus"], "approved")
        render = self._ui_post(f"/api/lumina/factory/projects/{project['id']}/renders", {
            "render_config": {"format": "MP4", "resolution": "180x320", "ratio": "9:16"},
        })

        def compact_render(response: dict[str, object], base_url: str, workspace: Path, on_progress=None):
            return render_factory_project(response, base_url, workspace, self.outputs, on_progress, constraints=CONSTRAINTS)

        with patch.dict(os.environ, {"LUMINA_FACTORY_RENDER_DIR": str(self.outputs)}), \
             patch("processor.job_worker.execute_factory_render_job", side_effect=compact_render), \
             patch("processor.factory_render._executable", self._pinned_executable):
            processed = process_available(self.base_url, WORKER_TOKEN, "external-hook-e2e-worker", queue="material", job_id=str(render["id"]))
        self.assertTrue(processed)
        status = requests.get(
            f"{self.base_url}/api/lumina/factory/renders/{render['id']}",
            headers={"x-lumina-ui": "local"}, timeout=10,
        )
        status.raise_for_status()
        rendered = status.json()
        self.assertEqual(rendered["status"], "succeeded", rendered.get("error"))
        self.assertTrue(rendered["validation"]["passed"])
        self.assertEqual(
            {key: rendered["validation"][key] for key in expected_lineage},
            expected_lineage,
        )
        self.assertEqual(
            {key: rendered["validation"][key] for key in expected_lineage},
            {key: preview_validation[key] for key in expected_lineage},
        )
        output = Path(rendered["validation"]["file"])
        self.assertTrue(output.is_file())
        record_response = requests.get(
            f"{self.base_url}/api/collections/factory_renders/records/{render['id']}",
            headers=self.admin_headers, timeout=10,
        )
        record_response.raise_for_status()
        render_record = record_response.json()
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        self.assertEqual(digest, render_record["output_sha256"])
        review = self._ui_post(f"/api/lumina/factory/projects/{project['id']}/review", {
            "render_id": render["id"], "decision": "approved", "note": "Synthetic queue render visually reviewed for transport/QC gates",
        })
        self.assertEqual(review["status"], "approved")
        exported = self._ui_post(f"/api/lumina/factory/projects/{project['id']}/export", {
            "render_id": render["id"], "file_name": "external-hook-e2e.mp4",
        })
        self.assertEqual(exported["fileName"], "external-hook-e2e.mp4")
        self.assertEqual(exported["outputSha256"], digest)
        self.assertEqual([item["kind"] for item in render_record["boundary_ledger"]], ["hook", "episode", "episode", "episode"])
        self.assertFalse(list(self.outputs.glob("*.partial")))


if __name__ == "__main__":
    unittest.main()
