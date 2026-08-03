from __future__ import annotations

import json
import os
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2

from recognizer import PlateRecognizer


HOST = os.environ.get("ALPR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ALPR_PORT", "53871"))
ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts" / "debug-captures"
RECOGNIZER = None
RECOGNIZER_ERROR = None


def get_recognizer() -> PlateRecognizer:
    global RECOGNIZER, RECOGNIZER_ERROR
    if RECOGNIZER is not None:
        return RECOGNIZER
    if RECOGNIZER_ERROR is not None:
        raise RuntimeError(RECOGNIZER_ERROR)
    try:
        print("ALPR recognizer is initializing...", flush=True)
        RECOGNIZER = PlateRecognizer()
        print("ALPR recognizer initialized.", flush=True)
        return RECOGNIZER
    except Exception as exc:
        RECOGNIZER_ERROR = str(exc)
        print(f"ALPR recognizer initialization failed: {RECOGNIZER_ERROR}", flush=True)
        raise


class AlprHandler(BaseHTTPRequestHandler):
    server_version = "AlprService/1.0"

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length) if content_length > 0 else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _save_debug_image(self, payload: dict) -> str:
        recognizer = get_recognizer()
        image = recognizer.load_image(
            image_base64=payload.get("imageBase64"),
            image_path=payload.get("imagePath"),
        )
        debug_name = str(payload.get("debugName") or "capture").strip() or "capture"
        safe_name = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in debug_name)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        output_path = ARTIFACTS_DIR / f"{timestamp}-{safe_name}.jpg"
        if not cv2.imwrite(str(output_path), image):
            raise RuntimeError(f"Debug image could not be written: {output_path}")
        return str(output_path)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            try:
                recognizer = get_recognizer()
                self._send_json(HTTPStatus.OK, recognizer.health())
            except Exception as exc:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {
                        "status": "starting-error",
                        "error": str(exc),
                    },
                )
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self._read_json()
        except json.JSONDecodeError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"Invalid JSON: {exc.msg}"})
            return

        try:
            if self.path == "/recognize":
                debug_image_path = None
                if payload.get("debugSave"):
                    debug_image_path = self._save_debug_image(payload)
                recognizer = get_recognizer()
                result = recognizer.recognize(
                    image_base64=payload.get("imageBase64"),
                    image_path=payload.get("imagePath"),
                    frame_index=payload.get("frameIndex"),
                    process_every_n_frames=payload.get("processEveryNFrames"),
                    min_detection_confidence=payload.get("minDetectionConfidence"),
                    min_ocr_confidence=payload.get("minOcrConfidence"),
                    turkey_only=bool(payload.get("turkeyOnly")),
                    source=payload.get("source"),
                )
                if debug_image_path:
                    result["debugImagePath"] = debug_image_path
                self._send_json(HTTPStatus.OK, result)
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        except (FileNotFoundError, ValueError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:  # pragma: no cover
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), AlprHandler)
    print(f"ALPR service listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
