from __future__ import annotations

import base64
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import onnxruntime as ort
from fast_plate_ocr.inference import hub as ocr_hub
from open_image_models.detection.core import hub as detection_hub


ROOT = Path(__file__).resolve().parent
WORKSPACE_ROOT = ROOT.parent
FAST_ALPR_FALLBACK_ROOT = WORKSPACE_ROOT / "alpr-extras" / "fast-alpr-master"

if str(FAST_ALPR_FALLBACK_ROOT) not in sys.path and FAST_ALPR_FALLBACK_ROOT.exists():
    sys.path.insert(0, str(FAST_ALPR_FALLBACK_ROOT))

from fast_alpr import ALPR


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class RecognizerConfig:
    models_dir: Path
    detector_model_id: str = "yolo-v9-s-608-license-plate-end2end"
    detector_model_file: str = "yolo-v9-s-608-license-plates-end2end.onnx"
    ocr_model_id: str = "cct-s-v2-global-model"
    ocr_model_file: str = "cct_s_v2_global.onnx"
    ocr_config_file: str = "cct_s_v2_global_plate_config.yaml"
    detector_confidence_threshold: float = 0.25
    min_plate_width: int = 40
    min_plate_height: int = 16
    process_every_n_frames: int = 3
    providers: tuple[str, ...] = ("CPUExecutionProvider",)

    @property
    def detector_cache_dir(self) -> Path:
        return self.models_dir / "open-image-models"

    @property
    def detector_model_dir(self) -> Path:
        return self.detector_cache_dir / self.detector_model_id

    @property
    def detector_model_path(self) -> Path:
        return self.detector_model_dir / self.detector_model_file

    @property
    def ocr_cache_dir(self) -> Path:
        return self.models_dir / "fast-plate-ocr"

    @property
    def ocr_model_dir(self) -> Path:
        return self.ocr_cache_dir / self.ocr_model_id

    @property
    def ocr_model_path(self) -> Path:
        return self.ocr_model_dir / self.ocr_model_file

    @property
    def ocr_config_path(self) -> Path:
        return self.ocr_model_dir / self.ocr_config_file


def load_config() -> RecognizerConfig:
    models_dir = Path(os.environ.get("ALPR_MODELS_DIR", ROOT / "models")).resolve()
    return RecognizerConfig(
        models_dir=models_dir,
        detector_confidence_threshold=_env_float("ALPR_DETECTOR_CONFIDENCE", 0.25),
        min_plate_width=_env_int("ALPR_MIN_PLATE_WIDTH", 40),
        min_plate_height=_env_int("ALPR_MIN_PLATE_HEIGHT", 16),
        process_every_n_frames=max(1, _env_int("ALPR_PROCESS_EVERY_N_FRAMES", 3)),
    )


def mean_confidence(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, (list, tuple)):
        numeric = [float(item) for item in value if item is not None]
        return sum(numeric) / len(numeric) if numeric else 0.0
    return 0.0


def normalize_plate_text(text: str) -> str:
    if not text:
        return ""
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def is_turkish_plate(text: str) -> bool:
    return bool(re.fullmatch(r"^(0[1-9]|[1-7][0-9]|8[01])[A-Z]{1,3}[0-9]{2,4}$", text))


class PlateRecognizer:
    def __init__(self, config: RecognizerConfig | None = None) -> None:
        self.config = config or load_config()
        self._validate_model_files()
        detection_hub.MODEL_CACHE_DIR = self.config.detector_cache_dir
        ocr_hub.MODEL_CACHE_DIR = self.config.ocr_cache_dir
        session_options = ort.SessionOptions()
        session_options.log_severity_level = 3
        self.alpr = ALPR(
            detector_model=self.config.detector_model_id,
            detector_conf_thresh=self.config.detector_confidence_threshold,
            detector_providers=list(self.config.providers),
            detector_sess_options=session_options,
            ocr_model=self.config.ocr_model_id,
            ocr_device="cpu",
            ocr_providers=list(self.config.providers),
            ocr_sess_options=session_options,
            ocr_model_path=self.config.ocr_model_path,
            ocr_config_path=self.config.ocr_config_path,
        )

    def _validate_model_files(self) -> None:
        missing = [
            str(path)
            for path in (
                self.config.detector_model_path,
                self.config.ocr_model_path,
                self.config.ocr_config_path,
            )
            if not path.exists()
        ]
        if missing:
            raise FileNotFoundError(f"ALPR model files missing: {', '.join(missing)}")

    def health(self) -> dict[str, Any]:
        detector_session = self.alpr.detector.detector.model
        ocr_session = self.alpr.ocr.ocr_model.model
        return {
            "status": "ok",
            "providers": {
                "detector": detector_session.get_providers(),
                "ocr": ocr_session.get_providers(),
            },
            "models": {
                "detector_model_id": self.config.detector_model_id,
                "detector_model_path": str(self.config.detector_model_path),
                "ocr_model_id": self.config.ocr_model_id,
                "ocr_model_path": str(self.config.ocr_model_path),
                "ocr_config_path": str(self.config.ocr_config_path),
            },
            "process_every_n_frames": self.config.process_every_n_frames,
        }

    def decode_base64_image(self, image_base64: str) -> np.ndarray:
        payload = image_base64.strip()
        if "," in payload:
            payload = payload.split(",", 1)[1]
        binary = base64.b64decode(payload, validate=False)
        array = np.frombuffer(binary, dtype=np.uint8)
        image = cv2.imdecode(array, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Image payload could not be decoded.")
        return image

    def load_image(self, image_base64: str | None = None, image_path: str | None = None) -> np.ndarray:
        if image_base64:
            return self.decode_base64_image(image_base64)
        if image_path:
            image = cv2.imread(image_path)
            if image is None:
                raise FileNotFoundError(f"Image could not be loaded: {image_path}")
            return image
        raise ValueError("imageBase64 or imagePath is required.")

    def should_process_frame(self, frame_index: int | None, process_every_n_frames: int | None) -> tuple[bool, int]:
        effective = max(1, process_every_n_frames or self.config.process_every_n_frames)
        if frame_index is None:
            return True, effective
        return frame_index % effective == 0, effective

    def recognize(
        self,
        *,
        image_base64: str | None = None,
        image_path: str | None = None,
        frame_index: int | None = None,
        process_every_n_frames: int | None = None,
        min_detection_confidence: float | None = None,
        min_ocr_confidence: float | None = None,
        turkey_only: bool = False,
        source: str | None = None,
    ) -> dict[str, Any]:
        should_process, effective_n = self.should_process_frame(frame_index, process_every_n_frames)
        if not should_process:
            return {
                "status": "skipped",
                "frameIndex": frame_index,
                "processEveryNFrames": effective_n,
                "source": source,
                "plates": [],
            }

        image = self.load_image(image_base64=image_base64, image_path=image_path)
        results = self.alpr.predict(image)
        image_height, image_width = image.shape[:2]
        min_det = float(min_detection_confidence or self.config.detector_confidence_threshold)
        min_ocr = float(min_ocr_confidence or 0.0)
        plates: list[dict[str, Any]] = []

        for result in results:
            detection = result.detection
            bbox = detection.bounding_box
            x1 = max(0, int(bbox.x1))
            y1 = max(0, int(bbox.y1))
            x2 = min(image_width - 1, int(bbox.x2))
            y2 = min(image_height - 1, int(bbox.y2))
            width = max(0, x2 - x1)
            height = max(0, y2 - y1)
            if width < self.config.min_plate_width or height < self.config.min_plate_height:
                continue

            detection_confidence = float(detection.confidence)
            if detection_confidence < min_det:
                continue

            raw_text = result.ocr.text if result.ocr else ""
            normalized_text = normalize_plate_text(raw_text)
            ocr_confidence = mean_confidence(result.ocr.confidence if result.ocr else None)
            if normalized_text == "" and min_ocr > 0:
                continue
            if ocr_confidence < min_ocr:
                continue

            turkish_plate = is_turkish_plate(normalized_text)
            if turkey_only and normalized_text and not turkish_plate:
                continue

            plates.append(
                {
                    "text": raw_text,
                    "normalizedText": normalized_text,
                    "detectionConfidence": detection_confidence,
                    "ocrConfidence": ocr_confidence,
                    "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "width": width, "height": height},
                    "region": result.ocr.region if result.ocr else None,
                    "regionConfidence": result.ocr.region_confidence if result.ocr else None,
                    "turkishPlateFormat": turkish_plate,
                }
            )

        return {
            "status": "ok",
            "source": source,
            "frameIndex": frame_index,
            "processEveryNFrames": effective_n,
            "imageSize": {"width": image_width, "height": image_height},
            "plateCount": len(plates),
            "plates": plates,
        }
