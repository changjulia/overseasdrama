import unittest

from processor.whisper_runtime import create_whisper_model


class WhisperRuntimeTests(unittest.TestCase):
    def test_keeps_requested_cuda_runtime_when_available(self):
        calls = []

        def factory(name, **kwargs):
            calls.append((name, kwargs))
            return "gpu-model"

        model, runtime = create_whisper_model(
            factory,
            "small",
            requested_device="cuda",
            requested_compute_type="float16",
            cpu_threads=8,
        )

        self.assertEqual(model, "gpu-model")
        self.assertFalse(runtime.degraded)
        self.assertEqual(calls[0][1]["device"], "cuda")

    def test_falls_back_to_cpu_for_missing_cublas(self):
        calls = []

        def factory(name, **kwargs):
            calls.append((name, kwargs))
            if kwargs["device"] == "cuda":
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            return "cpu-model"

        model, runtime = create_whisper_model(
            factory,
            "small",
            requested_device="cuda",
            requested_compute_type="float16",
            cpu_threads=6,
        )

        self.assertEqual(model, "cpu-model")
        self.assertTrue(runtime.degraded)
        self.assertEqual(runtime.device, "cpu")
        self.assertEqual(runtime.compute_type, "int8")
        self.assertIn("cublas64_12.dll", runtime.fallback_reason)
        self.assertEqual([call[1]["device"] for call in calls], ["cuda", "cpu"])

    def test_does_not_hide_non_runtime_configuration_errors(self):
        def factory(name, **kwargs):
            raise RuntimeError("unknown model size")

        with self.assertRaisesRegex(RuntimeError, "unknown model size"):
            create_whisper_model(
                factory,
                "invalid",
                requested_device="cuda",
                requested_compute_type="float16",
                cpu_threads=4,
            )


if __name__ == "__main__":
    unittest.main()
