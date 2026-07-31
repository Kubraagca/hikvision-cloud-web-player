from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SERVICE_DIR = ROOT / "alpr-service"
DEFAULT_IMAGE = Path(r"C:\Users\Kubra\Desktop\plaka-test\test10.jpg")


def wait_for_health(base_url: str, timeout_seconds: float) -> dict:
    deadline = time.time() + timeout_seconds
    last_error = "timeout"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/health", timeout=2) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            time.sleep(0.5)
    raise RuntimeError(f"ALPR health check failed: {last_error}")


def post_json(url: str, payload: dict, timeout: float = 15) -> dict:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default=str(DEFAULT_IMAGE))
    parser.add_argument("--port", type=int, default=53871)
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        raise FileNotFoundError(f"Smoke test image not found: {image_path}")

    env = os.environ.copy()
    env.setdefault("ALPR_HOST", "127.0.0.1")
    env["ALPR_PORT"] = str(args.port)

    process = subprocess.Popen(
        [sys.executable, "app.py"],
        cwd=str(SERVICE_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        base_url = f"http://127.0.0.1:{args.port}"
        health = wait_for_health(base_url, timeout_seconds=20)
        result = post_json(
            f"{base_url}/recognize",
            {
                "imagePath": str(image_path),
                "minDetectionConfidence": 0.2,
                "minOcrConfidence": 0.0,
            },
        )
        print(json.dumps({"health": health, "recognize": result}, ensure_ascii=True, indent=2))
        if result.get("status") != "ok":
            raise RuntimeError("Recognition request did not complete successfully.")
        if result.get("plateCount", 0) < 1:
            raise RuntimeError("Smoke test completed but no plates were detected.")
        return 0
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
