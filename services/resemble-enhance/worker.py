#!/usr/bin/env python3
"""Persistent local IPC worker for the official Resemble Enhance inference API."""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def parse_request(line: str) -> dict[str, Any]:
    payload = json.loads(line)
    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
        raise ValueError("request id is required")
    for key in ("inputPath", "outputPath"):
        value = payload.get(key)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError(f"{key} must be an absolute path")
    nfe = payload.get("nfe", 32)
    if not isinstance(nfe, int) or nfe < 1 or nfe > 128:
        raise ValueError("nfe must be an integer between 1 and 128")
    if payload.get("solver", "midpoint") not in ("midpoint", "rk4", "euler"):
        raise ValueError("unsupported solver")
    for key in ("denoiseStrength", "priorTemperature"):
        value = payload.get(key)
        if not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
            raise ValueError(f"{key} must be between 0 and 1")
    return payload


@dataclass
class EnhanceRuntime:
    device: str

    def __post_init__(self) -> None:
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            import torchaudio
            from resemble_enhance.enhancer.inference import enhance, load_enhancer

            if self.device.startswith("cuda") and not torch.cuda.is_available():
                raise RuntimeError(f"CUDA is unavailable for requested device {self.device}")
            self.torch = torch
            self.torchaudio = torchaudio
            self.enhance = enhance
            # The official loader and inference entry point both cache this instance.
            self.model = load_enhancer(None, self.device)

    def run(self, request: dict[str, Any]) -> dict[str, Any]:
        started_at = time.perf_counter()
        input_path = Path(request["inputPath"])
        output_path = Path(request["outputPath"])
        if not input_path.is_file():
            raise ValueError("input audio does not exist")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with contextlib.redirect_stdout(sys.stderr), self.torch.inference_mode():
            waveform, sample_rate = self.torchaudio.load(input_path)
            if waveform.numel() == 0:
                raise ValueError("input audio is empty")
            waveform = waveform.mean(dim=0)
            enhanced, enhanced_sample_rate = self.enhance(
                dwav=waveform,
                sr=sample_rate,
                device=self.device,
                nfe=request["nfe"],
                solver=request["solver"],
                lambd=float(request["denoiseStrength"]),
                tau=float(request["priorTemperature"]),
                run_dir=None,
            )
            enhanced = enhanced.detach().float().cpu().flatten()
            if enhanced.numel() == 0 or not self.torch.isfinite(enhanced).all().item():
                raise ValueError("enhancer produced invalid samples")
            peak = float(enhanced.abs().max().item())
            if not math.isfinite(peak) or peak <= 0:
                raise ValueError("enhancer produced silent or invalid audio")
            self.torchaudio.save(
                output_path,
                enhanced.unsqueeze(0),
                int(enhanced_sample_rate),
                format="wav",
            )

        return {
            "sampleRate": int(enhanced_sample_rate),
            "frames": int(enhanced.numel()),
            "peak": peak,
            "durationMs": round((time.perf_counter() - started_at) * 1000),
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default=os.getenv("RESEMBLE_ENHANCE_DEVICE", "cuda"))
    parser.add_argument("--health", action="store_true")
    args = parser.parse_args()

    try:
        runtime = EnhanceRuntime(args.device)
    except Exception as error:  # startup failure must be visible to the parent process
        emit({"event": "fatal", "error": str(error)})
        return 1

    if args.health:
        emit({"event": "healthy", "device": args.device, "modelLoaded": True})
        return 0

    emit({"event": "ready", "device": args.device, "modelLoaded": True})
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = "unknown"
        try:
            request = parse_request(line)
            request_id = request["id"]
            result = runtime.run(request)
            emit({"event": "result", "id": request_id, "ok": True, **result})
        except Exception as error:
            emit({"event": "result", "id": request_id, "ok": False, "error": str(error)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
