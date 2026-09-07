import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

from processor.media_gateway import Handler


class MediaSigningTest(unittest.TestCase):
    def test_internal_signer_requires_token_and_restricts_object_scope(self):
        client = Mock()
        client.generate_presigned_url.return_value = "https://example.cos.test/video?signature=test"
        with patch.dict(os.environ, {"LUMINA_WORKER_TOKEN": "test-internal-token", "COS_BUCKET": "test-bucket"}), patch("processor.media_gateway.media_client", return_value=client):
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def post(key, token="test-internal-token"):
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/sign", json.dumps({"key": key}).encode(), {"X-Media-Token": token})
                try:
                    response = urllib.request.urlopen(request)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    return response.status, response.read()
            try:
                key = "pbc_lumepisodes/ed6gkt0rs143m9i/ep001_l3c0uq7oty.mp4"
                self.assertEqual(post(key, "")[0], 404)
                for invalid in ["_deploy/private.mp4", "pbc_lumepisodes/../private.mp4", "pbc_lumepisodes/record/video.mp4.attrs"]:
                    self.assertEqual(post(invalid)[0], 400)
                self.assertFalse(client.generate_presigned_url.called)
                status, body = post(key)
                self.assertEqual(status, 200)
                self.assertTrue(json.loads(body)["url"].startswith("https://"))
                client.generate_presigned_url.assert_called_once_with("get_object", Params={"Bucket": "test-bucket", "Key": key}, ExpiresIn=900)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
