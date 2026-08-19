"""Whisper runtime selection with a deterministic CUDA-to-CPU fallback.

This module deliberately has no dependency on the material result contract.  It
can therefore be integrated into the analysis pipeline without coupling runtime
availability to classification or label projection.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


_CUDA_FAILURE_MARKERS = (
    "cublas",
    "cudnn",
    "cuda",
    "driver version is insufficient",
    "no cuda-capable device",
    "not found or cannot be loaded",
)


@dataclass(frozen=True)
class WhisperRuntime:
    device: str
    compute_type: str
    requested_device: str
    requested_compute_type: str
    fallback_reason: str = ""

    @property
    def degraded(self) -> bool:
        return self.device != self.requested_device


def _is_cuda_runtime_failure(exc: BaseException) -> bool:
    message = str(exc).lower()
    return any(marker in message for marker in _CUDA_FAILURE_MARKERS)


def create_whisper_model(
    model_factory: Callable[..., Any],
    model_name: str,
    *,
    requested_device: str,
    requested_compute_type: str,
    cpu_threads: int,
    num_workers: int = 1,
) -> tuple[Any, WhisperRuntime]:
    """Create a Whisper model and fall back only for CUDA runtime failures.

    Model/configuration errors are re-raised so a bad deployment is not silently
    reported as a successful but slower analysis.
    """

    device = (requested_device or "cpu").strip().lower()
    compute_type = (requested_compute_type or ("float16" if device == "cuda" else "int8")).strip().lower()
    requested = WhisperRuntime(device, compute_type, device, compute_type)
    kwargs = {
        "device": device,
        "compute_type": compute_type,
        "cpu_threads": max(1, int(cpu_threads)),
        "num_workers": max(1, int(num_workers)),
    }
    try:
        return model_factory(model_name, **kwargs), requested
    except (OSError, RuntimeError) as exc:
        if device != "cuda" or not _is_cuda_runtime_failure(exc):
            raise
        fallback = WhisperRuntime(
            device="cpu",
            compute_type="int8",
            requested_device=device,
            requested_compute_type=compute_type,
            fallback_reason=f"CUDA unavailable; using CPU int8: {exc}",
        )
        kwargs.update(device="cpu", compute_type="int8")
        return model_factory(model_name, **kwargs), fallback

