from __future__ import annotations

import argparse
import io
import json
import time
import urllib.request
import uuid
import wave
from pathlib import Path


def post_json(url: str, payload: dict[str, object]) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        return response.read(), dict(response.headers.items())


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run one explicit Ming preview using an authorized reference recording."
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:8773")
    parser.add_argument("--reference", required=True)
    parser.add_argument("--reference-text", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    reference = Path(args.reference).resolve()
    output = Path(args.output).resolve()
    if not reference.is_file():
        raise SystemExit("reference file does not exist")
    if output.exists():
        raise SystemExit("output already exists; refusing to overwrite it")

    profile_id = f"ming_smoke_{uuid.uuid4().hex[:16]}"
    base_url = args.base_url.rstrip("/")
    post_json(
        f"{base_url}/profiles",
        {
            "profileId": profile_id,
            "referenceAudioPath": str(reference),
            "referenceText": args.reference_text,
            "referenceLanguage": "en",
        },
    )
    started = time.monotonic()
    audio, headers = post_json(
        f"{base_url}/synthesize",
        {"profileId": profile_id, "text": args.text, "language": "en"},
    )
    latency_seconds = time.monotonic() - started
    with wave.open(io.BytesIO(audio), "rb") as wav:
        duration_seconds = wav.getnframes() / wav.getframerate()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(audio)
    print(
        json.dumps(
            {
                "output": str(output),
                "bytes": len(audio),
                "durationSeconds": round(duration_seconds, 3),
                "latencySeconds": round(latency_seconds, 3),
                "requestId": headers.get("X-Request-Id"),
                "referencePreparation": headers.get("X-Reference-Preparation"),
            }
        )
    )


if __name__ == "__main__":
    main()
