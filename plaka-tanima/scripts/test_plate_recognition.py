import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
EXPERIMENTAL_ROOT = ROOT / "alpr-extras"
FAST_ALPR_ROOT = EXPERIMENTAL_ROOT / "fast-alpr-master"
SORT_ROOT = EXPERIMENTAL_ROOT / "sort"
YOLOV11_ROOT = EXPERIMENTAL_ROOT / "automatic-license-plate-recognition-using-yolov11-main"
REAL_ESRGAN_ROOT = EXPERIMENTAL_ROOT / "Real-ESRGAN-master"
NAFNET_ROOT = EXPERIMENTAL_ROOT / "NAFNet-main"
DEFAULT_CUSTOM_PLATE_MODEL = YOLOV11_ROOT / "models" / "custom_license_plate_detector.pt"

for path in (FAST_ALPR_ROOT, ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fast_alpr import ALPR  # noqa: E402
from fast_alpr.base import OcrResult  # noqa: E402
from sort.sort import Sort  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Hybrid ALPR test: YOLOv11/custom plate detector + FastALPR OCR + SORT tracking."
    )
    parser.add_argument("--image", help="Path to a still image to analyze.")
    parser.add_argument("--source", help="Video source: local video path, RTSP URL, or webcam index.")
    parser.add_argument(
        "--detector-backend",
        choices=["yolov11-custom", "fastalpr", "ensemble"],
        default="yolov11-custom",
        help="Plate detection backend.",
    )
    parser.add_argument(
        "--ocr-model",
        default="cct-s-v2-global-model",
        help="FastALPR OCR model name.",
    )
    parser.add_argument(
        "--ocr-backend",
        choices=["fastalpr", "paddleocr", "ensemble"],
        default="paddleocr",
        help="OCR backend to use after plate crops are extracted.",
    )
    parser.add_argument(
        "--fastalpr-detector-model",
        default="yolo-v9-s-608-license-plate-end2end",
        help="FastALPR detector model, used only when --detector-backend fastalpr.",
    )
    parser.add_argument(
        "--custom-plate-model",
        default=str(DEFAULT_CUSTOM_PLATE_MODEL),
        help="Path to the custom YOLOv11 plate detector.",
    )
    parser.add_argument(
        "--output-dir",
        default=str(ROOT / "artifacts" / "plate-tests"),
        help="Directory where annotated outputs and JSON results are written.",
    )
    parser.add_argument(
        "--enhance-backends",
        default="realesrgan",
        help="Comma-separated crop enhancement backends: realesrgan,nafnet",
    )
    parser.add_argument(
        "--realesrgan-model",
        default="realesr-general-x4v3",
        help="Real-ESRGAN model name used when realesrgan enhancement is enabled.",
    )
    parser.add_argument(
        "--realesrgan-outscale",
        type=float,
        default=2.0,
        help="Real-ESRGAN output upscale multiplier for plate crops.",
    )
    parser.add_argument(
        "--nafnet-opt",
        default="",
        help="Path to a NAFNet test yml file. If empty, NAFNet enhancement is skipped.",
    )
    parser.add_argument("--sample-every", type=float, default=0.2, help="Analyze one frame every N seconds.")
    parser.add_argument("--max-frames", type=int, default=0, help="Maximum sampled frames to analyze. Use 0 for unlimited.")
    parser.add_argument("--json-only", action="store_true", help="Print only the structured JSON result.")
    parser.add_argument("--show-live", action="store_true", help="Update a live preview image/window during video analysis.")
    parser.add_argument("--min-detection-confidence", type=float, default=0.35, help="Minimum plate detector confidence.")
    parser.add_argument("--min-plate-width", type=int, default=70, help="Minimum plate width in pixels.")
    parser.add_argument("--min-plate-height", type=int, default=20, help="Minimum plate height in pixels.")
    parser.add_argument("--min-ocr-confidence", type=float, default=0.55, help="Minimum mean OCR confidence.")
    parser.add_argument("--turkey-only", action="store_true", help="Keep only results that look like Turkish plates.")
    parser.add_argument("--sort-max-age", type=int, default=8, help="SORT max_age value.")
    parser.add_argument("--sort-min-hits", type=int, default=1, help="SORT min_hits value.")
    parser.add_argument("--sort-iou-threshold", type=float, default=0.15, help="SORT IOU threshold.")
    return parser.parse_args()


def ensure_output_dir(path: str) -> Path:
    output_dir = Path(path)
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def make_alpr(ocr_model: str, detector_model: str) -> ALPR:
    model_cache_root = ROOT / ".cache" / "open-image-models"
    model_cache_root.mkdir(parents=True, exist_ok=True)
    try:
        import open_image_models.detection.core.hub as detection_hub

        detection_hub.MODEL_CACHE_DIR = model_cache_root
    except Exception:
        pass

    return ALPR(
        detector_model=detector_model,
        detector_conf_thresh=0.25,
        ocr_model=ocr_model,
    )


def make_paddleocr_reader():
    from paddleocr import PaddleOCR

    return PaddleOCR(
        lang="en",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )


def parse_enhance_backends(raw_value: str) -> list[str]:
    return [item.strip().lower() for item in raw_value.split(",") if item.strip()]


def make_runtime_components(args: argparse.Namespace) -> dict:
    components = {
        "alpr": make_alpr(args.ocr_model, args.fastalpr_detector_model),
        "paddleocr": None,
        "enhance_backends": parse_enhance_backends(args.enhance_backends),
        "warnings": set(),
    }
    if args.ocr_backend in {"paddleocr", "ensemble"}:
        components["paddleocr"] = make_paddleocr_reader()
    return components


def runtime_warn(runtime: dict, key: str, message: str) -> None:
    if key in runtime["warnings"]:
        return
    runtime["warnings"].add(key)
    print(message)


def save_temp_crop(temp_dir: Path, image: np.ndarray, suffix: str) -> Path:
    temp_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{time.time_ns()}-{suffix}.png"
    path = temp_dir / filename
    cv2.imwrite(str(path), image)
    return path


def run_realesrgan_enhancement(crop: np.ndarray, args: argparse.Namespace, runtime: dict, output_dir: Path) -> np.ndarray:
    if not REAL_ESRGAN_ROOT.exists():
        runtime_warn(runtime, "realesrgan-missing", "[ENHANCE] Real-ESRGAN repo bulunamadi, atlandi.")
        return crop

    temp_root = output_dir / "_enhancers" / "realesrgan"
    input_path = save_temp_crop(temp_root / "input", crop, "realesrgan-in")
    output_folder = temp_root / "output"
    output_folder.mkdir(parents=True, exist_ok=True)
    output_path = output_folder / f"{input_path.stem}_enhanced.png"

    command = [
        sys.executable,
        str(REAL_ESRGAN_ROOT / "inference_realesrgan.py"),
        "-i",
        str(input_path),
        "-o",
        str(output_folder),
        "-n",
        args.realesrgan_model,
        "-s",
        str(args.realesrgan_outscale),
        "--suffix",
        "enhanced",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=str(REAL_ESRGAN_ROOT),
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except Exception as exc:
        runtime_warn(runtime, "realesrgan-exec", f"[ENHANCE] Real-ESRGAN calistirilamadi: {exc}")
        return crop

    if completed.returncode != 0 or not output_path.exists():
        runtime_warn(
            runtime,
            "realesrgan-failed",
            f"[ENHANCE] Real-ESRGAN basarisiz oldu, atlandi. stderr={completed.stderr.strip()[:300]}",
        )
        return crop

    enhanced = cv2.imread(str(output_path))
    return enhanced if enhanced is not None else crop


def run_nafnet_enhancement(crop: np.ndarray, args: argparse.Namespace, runtime: dict, output_dir: Path) -> np.ndarray:
    if not args.nafnet_opt:
        runtime_warn(runtime, "nafnet-opt-missing", "[ENHANCE] NAFNet secili ama --nafnet-opt verilmedi, atlandi.")
        return crop
    nafnet_opt = Path(args.nafnet_opt)
    if not nafnet_opt.exists():
        runtime_warn(runtime, "nafnet-opt-path", f"[ENHANCE] NAFNet opt dosyasi bulunamadi: {nafnet_opt}")
        return crop
    if not NAFNET_ROOT.exists():
        runtime_warn(runtime, "nafnet-missing", "[ENHANCE] NAFNet repo bulunamadi, atlandi.")
        return crop

    temp_root = output_dir / "_enhancers" / "nafnet"
    input_path = save_temp_crop(temp_root / "input", crop, "nafnet-in")
    output_path = temp_root / "output" / f"{input_path.stem}.png"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    command = [
        sys.executable,
        str(NAFNET_ROOT / "basicsr" / "demo.py"),
        "-opt",
        str(nafnet_opt),
        "--input_path",
        str(input_path),
        "--output_path",
        str(output_path),
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=str(NAFNET_ROOT),
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except Exception as exc:
        runtime_warn(runtime, "nafnet-exec", f"[ENHANCE] NAFNet calistirilamadi: {exc}")
        return crop

    if completed.returncode != 0 or not output_path.exists():
        runtime_warn(
            runtime,
            "nafnet-failed",
            f"[ENHANCE] NAFNet basarisiz oldu, atlandi. stderr={completed.stderr.strip()[:300]}",
        )
        return crop

    enhanced = cv2.imread(str(output_path))
    return enhanced if enhanced is not None else crop


def enhance_crop(crop: np.ndarray, args: argparse.Namespace, runtime: dict, output_dir: Path) -> np.ndarray:
    enhanced = crop
    for backend in runtime["enhance_backends"]:
        if backend == "realesrgan":
            enhanced = run_realesrgan_enhancement(enhanced, args, runtime, output_dir)
        elif backend == "nafnet":
            enhanced = run_nafnet_enhancement(enhanced, args, runtime, output_dir)
        else:
            runtime_warn(runtime, f"enhance-{backend}", f"[ENHANCE] Bilinmeyen enhancement backend: {backend}")
    return enhanced


def get_detector_model_path(alpr: ALPR) -> str:
    try:
        return str(alpr.detector.detector.model._model_path)
    except Exception:
        return ""


def get_ocr_model_path(alpr: ALPR) -> str:
    try:
        return str(alpr.ocr.ocr_model.model._model_path)
    except Exception:
        return ""


def log_model_info(runtime: dict, detector_backend: str, custom_plate_model: str, ocr_backend: str) -> None:
    alpr = runtime["alpr"]
    print(f"[ALPR] detector_backend={detector_backend}")
    if detector_backend in {"fastalpr", "ensemble"}:
        print(f"[ALPR] detector_model={getattr(alpr.detector.detector, 'model_name', '-')}")
        print(f"[ALPR] detector_model_path={get_detector_model_path(alpr) or '-'}")
        print(f"[ALPR] detector_img_size={getattr(alpr.detector.detector, 'img_size', '-')}")
        if detector_backend == "ensemble":
            print("[ALPR] detector_model_secondary=custom-yolov11")
            print(f"[ALPR] detector_model_secondary_path={custom_plate_model or '-'}")
    else:
        print("[ALPR] detector_model=custom-yolov11")
        print(f"[ALPR] detector_model_path={custom_plate_model or '-'}")
    print(f"[ALPR] ocr_backend={ocr_backend}")
    if ocr_backend in {"fastalpr", "ensemble"}:
        print(f"[ALPR] ocr_model={getattr(alpr.ocr.ocr_model, 'model_name', '-')}")
        print(f"[ALPR] ocr_model_path={get_ocr_model_path(alpr) or '-'}")
        if ocr_backend == "ensemble":
            print("[ALPR] ocr_model_secondary=paddleocr")
            print("[ALPR] ocr_model_secondary_path=python-package")
    else:
        print("[ALPR] ocr_model=paddleocr")
        print("[ALPR] ocr_model_path=python-package")
    print(f"[ALPR] enhance_backends={','.join(runtime['enhance_backends']) or '-'}")


def make_custom_detector(model_path: str):
    config_root = ROOT / ".cache"
    config_root.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(config_root))
    from ultralytics import YOLO

    return YOLO(model_path)


def confidence_to_mean(confidence: float | list[float] | None) -> float:
    if confidence is None:
        return 0.0
    if isinstance(confidence, list):
        return float(sum(confidence) / len(confidence)) if confidence else 0.0
    return float(confidence)


def normalize_plate_text(text: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def plate_pattern_score(text: str) -> float:
    if not text:
        return 0.0
    score = 0.0
    if re.fullmatch(r"\d{2}[A-Z]{1,3}\d{2,4}", text):
        score += 1.0
    if re.match(r"^\d{2}", text):
        score += 0.2
    if re.search(r"[A-Z]{1,3}", text[2:5] if len(text) >= 5 else text[2:]):
        score += 0.2
    if re.search(r"\d{2,4}$", text):
        score += 0.2
    return score


def is_turkey_plate_like(text: str) -> bool:
    return bool(re.fullmatch(r"\d{2}[A-Z]{1,3}\d{2,4}", text))


def improve_turkey_plate_text(text: str) -> str:
    normalized = normalize_plate_text(text)
    if len(normalized) < 5:
        return normalized

    chars = list(normalized)
    for index in range(min(2, len(chars))):
        if chars[index] == "O":
            chars[index] = "0"
        elif chars[index] == "I":
            chars[index] = "1"
        elif chars[index] == "Z":
            chars[index] = "2"

    letter_run = 0
    for index in range(2, len(chars)):
        char = chars[index]
        if char.isdigit():
            if char == "0":
                chars[index] = "O"
            elif char == "1":
                chars[index] = "I"
            elif char == "2" and index < 5:
                chars[index] = "Z"
        if chars[index].isalpha():
            letter_run += 1
        elif letter_run:
            break

    for index in range(2 + letter_run, len(chars)):
        if chars[index] == "O":
            chars[index] = "0"
        elif chars[index] == "I":
            chars[index] = "1"
        elif chars[index] == "Z":
            chars[index] = "2"
        elif chars[index] == "S":
            chars[index] = "5"
        elif chars[index] == "B":
            chars[index] = "8"

    return "".join(chars)


def force_turkey_plate_shape(text: str) -> str:
    normalized = normalize_plate_text(text)
    if len(normalized) < 5:
        return normalized

    chars = list(normalized)

    for index in range(min(2, len(chars))):
        if chars[index] == "O":
            chars[index] = "0"
        elif chars[index] == "I":
            chars[index] = "1"
        elif chars[index] == "Z":
            chars[index] = "2"
        elif chars[index] == "S":
            chars[index] = "5"
        elif chars[index] == "B":
            chars[index] = "8"

    suffix_digit_count = 0
    for index in range(len(chars) - 1, 1, -1):
        if chars[index].isdigit():
            suffix_digit_count += 1
        else:
            break

    if suffix_digit_count < 2:
        suffix_digit_count = min(4, max(2, len(chars) - 3))

    suffix_start = max(2, len(chars) - suffix_digit_count)
    for index in range(2, suffix_start):
        if chars[index] == "0":
            chars[index] = "O"
        elif chars[index] == "1":
            chars[index] = "I"
        elif chars[index] == "2":
            chars[index] = "Z"
        elif chars[index] == "5":
            chars[index] = "S"
        elif chars[index] == "8":
            chars[index] = "B"

    for index in range(suffix_start, len(chars)):
        if chars[index] == "O":
            chars[index] = "0"
        elif chars[index] == "I":
            chars[index] = "1"
        elif chars[index] == "Z":
            chars[index] = "2"
        elif chars[index] == "S":
            chars[index] = "5"
        elif chars[index] == "B":
            chars[index] = "8"

    return "".join(chars)


def is_valid_plate_detection(
    result: dict,
    min_detection_confidence: float,
    min_plate_width: int,
    min_plate_height: int,
    min_ocr_confidence: float,
    turkey_only: bool,
) -> bool:
    box = result["bounding_box"]
    width = int(box["x2"]) - int(box["x1"])
    height = int(box["y2"]) - int(box["y1"])
    detection_confidence = float(result.get("detection_confidence") or 0.0)
    ocr_confidence_mean = float(result.get("ocr_confidence_mean") or 0.0)
    plate_text = str(result.get("plate_text") or "").strip()
    normalized_text = normalize_plate_text(plate_text)

    if detection_confidence < min_detection_confidence:
        return False
    if width < min_plate_width or height < min_plate_height:
        return False
    if ocr_confidence_mean < min_ocr_confidence:
        return False
    if not plate_text:
        return False
    if turkey_only and not is_turkey_plate_like(normalized_text):
        return False
    return True


def order_quad_points(points: np.ndarray) -> np.ndarray:
    pts = points.astype(np.float32)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = pts[np.argmin(s)]
    ordered[2] = pts[np.argmax(s)]
    ordered[1] = pts[np.argmin(diff)]
    ordered[3] = pts[np.argmax(diff)]
    return ordered


def warp_quad(image: np.ndarray, quad: np.ndarray) -> np.ndarray | None:
    rect = order_quad_points(quad)
    (tl, tr, br, bl) = rect
    width_a = np.linalg.norm(br - bl)
    width_b = np.linalg.norm(tr - tl)
    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_width = int(max(width_a, width_b))
    max_height = int(max(height_a, height_b))
    if max_width < 40 or max_height < 12:
        return None
    dst = np.array(
        [
            [0, 0],
            [max_width - 1, 0],
            [max_width - 1, max_height - 1],
            [0, max_height - 1],
        ],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(image, matrix, (max_width, max_height))


def rectify_plate_crop(cropped_plate: np.ndarray) -> np.ndarray | None:
    if cropped_plate.size == 0:
        return None

    gray = cv2.cvtColor(cropped_plate, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(gray)
    blur = cv2.GaussianBlur(clahe, (5, 5), 0)
    edges = cv2.Canny(blur, 60, 180)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:20]

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < (cropped_plate.shape[0] * cropped_plate.shape[1] * 0.08):
            continue
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.03 * perimeter, True)
        if len(approx) != 4:
            continue
        quad = approx.reshape(4, 2)
        warped = warp_quad(cropped_plate, quad)
        if warped is None:
            continue
        h, w = warped.shape[:2]
        aspect_ratio = w / max(1, h)
        if 1.8 <= aspect_ratio <= 8.5:
            return warped

    _, white_mask = cv2.threshold(blur, 150, 255, cv2.THRESH_BINARY)
    white_mask = cv2.morphologyEx(
        white_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3)),
        iterations=2,
    )
    contours, _ = cv2.findContours(white_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:10]

    for contour in contours:
        rect = cv2.minAreaRect(contour)
        (cx, cy), (w, h), _angle = rect
        if min(w, h) < 20:
            continue
        box = cv2.boxPoints(rect)
        warped = warp_quad(cropped_plate, box)
        if warped is None:
            continue
        h2, w2 = warped.shape[:2]
        aspect_ratio = w2 / max(1, h2)
        if 1.8 <= aspect_ratio <= 8.5:
            return warped

    return None


def refine_inner_plate_crop(cropped_plate: np.ndarray) -> np.ndarray:
    if cropped_plate.size == 0:
        return cropped_plate

    h, w = cropped_plate.shape[:2]
    hsv = cv2.cvtColor(cropped_plate, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(cropped_plate, cv2.COLOR_BGR2GRAY)

    white_mask = cv2.inRange(hsv, np.array([0, 0, 110]), np.array([180, 90, 255]))
    white_mask = cv2.morphologyEx(
        white_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (11, 5)),
        iterations=2,
    )
    white_mask = cv2.morphologyEx(
        white_mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)),
        iterations=1,
    )

    contours, _ = cv2.findContours(white_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best_rect = None
    best_score = -1.0
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        area = cw * ch
        if area < max(1500, int(w * h * 0.08)):
            continue
        aspect = cw / max(1, ch)
        if aspect < 2.0 or aspect > 8.5:
            continue
        if ch < 20 or cw < 80:
            continue
        roi = gray[y:y + ch, x:x + cw]
        std = float(np.std(roi))
        fill = float(cv2.countNonZero(white_mask[y:y + ch, x:x + cw])) / max(1, area)
        score = min(1.0, area / float(w * h)) + min(1.0, std / 64.0) + fill
        if score > best_score:
            best_score = score
            best_rect = (x, y, cw, ch)

    if best_rect is None:
        return cropped_plate

    x, y, cw, ch = best_rect
    pad_x = int(cw * 0.03)
    pad_y = int(ch * 0.08)
    x1 = max(0, x - pad_x)
    y1 = max(0, y - pad_y)
    x2 = min(w, x + cw + pad_x)
    y2 = min(h, y + ch + pad_y)
    refined = cropped_plate[y1:y2, x1:x2]
    return refined if refined.size else cropped_plate


def extract_plate_line_crops(cropped_plate: np.ndarray) -> list[tuple[str, np.ndarray]]:
    if cropped_plate.size == 0:
        return []

    refined = refine_inner_plate_crop(cropped_plate)
    h, w = refined.shape[:2]
    hsv = cv2.cvtColor(refined, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(refined, cv2.COLOR_BGR2GRAY)

    white_mask = cv2.inRange(hsv, np.array([0, 0, 105]), np.array([180, 95, 255]))
    white_mask = cv2.morphologyEx(
        white_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (15, 5)),
        iterations=2,
    )
    white_mask = cv2.morphologyEx(
        white_mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)),
        iterations=1,
    )

    contours, _ = cv2.findContours(white_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    plate_like_regions: list[tuple[float, tuple[int, int, int, int]]] = []
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        area = cw * ch
        if area < max(1800, int(w * h * 0.05)):
            continue
        if cw < 140 or ch < 26:
            continue
        aspect = cw / max(1, ch)
        if aspect < 2.2 or aspect > 9.5:
            continue

        roi_mask = white_mask[y:y + ch, x:x + cw]
        roi_gray = gray[y:y + ch, x:x + cw]
        fill_ratio = float(cv2.countNonZero(roi_mask)) / max(1, area)
        std = float(np.std(roi_gray))
        if fill_ratio < 0.42 or std < 18:
            continue

        score = fill_ratio + min(1.0, std / 48.0) + min(1.0, area / float(w * h))
        plate_like_regions.append((score, (x, y, cw, ch)))

    plate_like_regions.sort(key=lambda item: item[0], reverse=True)

    crops: list[tuple[str, np.ndarray]] = [("base", refined)]
    seen_boxes: list[tuple[int, int, int, int]] = []
    for index, (_score, (x, y, cw, ch)) in enumerate(plate_like_regions):
        box = (x, y, x + cw, y + ch)
        if any(compute_iou(box, existing) > 0.72 for existing in seen_boxes):
            continue
        seen_boxes.append(box)

        pad_x = int(cw * 0.04)
        pad_y = int(ch * 0.12)
        x1 = max(0, x - pad_x)
        y1 = max(0, y - pad_y)
        x2 = min(w, x + cw + pad_x)
        y2 = min(h, y + ch + pad_y)
        candidate = refined[y1:y2, x1:x2]
        if candidate.size == 0:
            continue
        crops.append((f"line{len(crops)}", candidate))
        if len(crops) >= 4:
            break

    return crops


def build_plate_variants(cropped_plate: np.ndarray) -> list[tuple[str, np.ndarray]]:
    if cropped_plate.size == 0:
        return []

    variants: list[tuple[str, np.ndarray]] = []
    for crop_name, crop_candidate in extract_plate_line_crops(cropped_plate):
        rectified = rectify_plate_crop(crop_candidate)
        working_plate = rectified if rectified is not None else crop_candidate

        target_height = 192
        scale = max(1.0, target_height / max(1, working_plate.shape[0]))
        resized = cv2.resize(working_plate, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
        denoised = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(denoised)
        bilateral = cv2.bilateralFilter(clahe, 9, 60, 60)
        sharpened = cv2.addWeighted(bilateral, 1.9, cv2.GaussianBlur(bilateral, (0, 0), 2), -0.9, 0)
        otsu_threshold = cv2.threshold(sharpened, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
        threshold = cv2.adaptiveThreshold(
            sharpened,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            35,
            3,
        )
        morph_kernel = np.ones((2, 2), np.uint8)
        morph = cv2.morphologyEx(threshold, cv2.MORPH_CLOSE, morph_kernel, iterations=1)

        variants.extend(
            [
                (f"{crop_name}:original", resized),
                (f"{crop_name}:rectified", resized),
                (f"{crop_name}:clahe", cv2.cvtColor(clahe, cv2.COLOR_GRAY2BGR)),
                (f"{crop_name}:sharpened", cv2.cvtColor(sharpened, cv2.COLOR_GRAY2BGR)),
                (f"{crop_name}:threshold", cv2.cvtColor(threshold, cv2.COLOR_GRAY2BGR)),
                (f"{crop_name}:otsu", cv2.cvtColor(otsu_threshold, cv2.COLOR_GRAY2BGR)),
                (f"{crop_name}:morph", cv2.cvtColor(morph, cv2.COLOR_GRAY2BGR)),
            ]
        )

    return variants


def predict_with_paddleocr(paddle_reader, image: np.ndarray) -> OcrResult | None:
    try:
        result = paddle_reader.predict(image)
    except Exception:
        try:
            result = paddle_reader.ocr(image, cls=False)
        except Exception:
            return None

        lines = []
        scores = []
        for block in result or []:
            if not block:
                continue
            for line in block:
                try:
                    text = str(line[1][0]).strip().upper().replace(" ", "")
                    score = float(line[1][1])
                except Exception:
                    continue
                if text:
                    lines.append(text)
                    scores.append(score)
        if not lines:
            return None
        return OcrResult(text="".join(lines), confidence=scores, region=None, region_confidence=None)

    lines = []
    scores = []
    for item in result or []:
        rec_texts = item.get("rec_texts") if isinstance(item, dict) else None
        rec_scores = item.get("rec_scores") if isinstance(item, dict) else None
        if not rec_texts:
            continue
        for index, text in enumerate(rec_texts):
            normalized = str(text).strip().upper().replace(" ", "")
            if not normalized:
                continue
            score = 0.0
            if rec_scores and index < len(rec_scores):
                try:
                    score = float(rec_scores[index])
                except Exception:
                    score = 0.0
            lines.append(normalized)
            scores.append(score)

    if not lines:
        return None
    return OcrResult(text="".join(lines), confidence=scores, region=None, region_confidence=None)


def score_ocr_result(ocr_result: OcrResult | None) -> tuple[str, float, float]:
    if ocr_result is None:
        return "", 0.0, 0.0
    normalized_text = force_turkey_plate_shape(improve_turkey_plate_text(ocr_result.text))
    mean_confidence = confidence_to_mean(ocr_result.confidence)
    region_bonus = 0.3 if (ocr_result.region or "").lower() == "turkey" else 0.0
    turkey_bonus = 1.5 if is_turkey_plate_like(normalized_text) else 0.0
    score = mean_confidence + (plate_pattern_score(normalized_text) * 1.5) + region_bonus + turkey_bonus
    return normalized_text, mean_confidence, score


def choose_best_ocr(args: argparse.Namespace, runtime: dict, cropped_plate: np.ndarray, output_dir: Path) -> tuple[OcrResult | None, str, list[dict], np.ndarray | None]:
    alpr = runtime["alpr"]
    enhanced_crop = enhance_crop(cropped_plate, args, runtime, output_dir)
    candidates = []
    variant_images: dict[str, np.ndarray] = {}
    for variant_name, variant in build_plate_variants(enhanced_crop):
        variant_images[variant_name] = variant
        backend_results: list[tuple[str, OcrResult | None]] = []
        if args.ocr_backend in {"fastalpr", "ensemble"}:
            backend_results.append(("fastalpr", alpr.ocr.predict(variant)))
        if args.ocr_backend in {"paddleocr", "ensemble"} and runtime["paddleocr"] is not None:
            backend_results.append(("paddleocr", predict_with_paddleocr(runtime["paddleocr"], variant)))

        if not backend_results:
            candidates.append(
                {
                    "variant": variant_name,
                    "ocr_backend": "none",
                    "plate_text": "",
                    "normalized_text": "",
                    "confidence": 0.0,
                    "region": None,
                    "region_confidence": None,
                    "score": 0.0,
                }
            )
            continue

        best_backend_name = "none"
        best_backend_result: OcrResult | None = None
        best_backend_score = -1.0
        best_normalized = ""
        best_mean_confidence = 0.0
        for backend_name, backend_result in backend_results:
            normalized_text, mean_confidence, score = score_ocr_result(backend_result)
            if score > best_backend_score:
                best_backend_score = score
                best_backend_name = backend_name
                best_backend_result = backend_result
                best_normalized = normalized_text
                best_mean_confidence = mean_confidence

        if best_backend_result is None:
            candidates.append(
                {
                    "variant": variant_name,
                    "ocr_backend": best_backend_name,
                    "plate_text": "",
                    "normalized_text": "",
                    "confidence": 0.0,
                    "region": None,
                    "region_confidence": None,
                    "score": 0.0,
                }
            )
            continue

        candidates.append(
            {
                "variant": variant_name,
                "ocr_backend": best_backend_name,
                "plate_text": best_backend_result.text,
                "normalized_text": best_normalized,
                "confidence": best_mean_confidence,
                "region": best_backend_result.region,
                "region_confidence": best_backend_result.region_confidence,
                "score": best_backend_score,
                "result": OcrResult(
                    text=best_normalized,
                    confidence=best_backend_result.confidence,
                    region=best_backend_result.region,
                    region_confidence=best_backend_result.region_confidence,
                ),
            }
        )

    best = max(candidates, key=lambda item: item["score"], default=None)
    if not best or "result" not in best:
        return None, "", candidates, None
    return best["result"], best["variant"], candidates, variant_images.get(best["variant"])


def compute_iou(box_a: tuple[int, int, int, int], box_b: tuple[int, int, int, int]) -> float:
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])
    inter_w = max(0, x2 - x1)
    inter_h = max(0, y2 - y1)
    inter_area = inter_w * inter_h
    if inter_area <= 0:
        return 0.0
    area_a = max(0, box_a[2] - box_a[0]) * max(0, box_a[3] - box_a[1])
    area_b = max(0, box_b[2] - box_b[0]) * max(0, box_b[3] - box_b[1])
    return inter_area / float(area_a + area_b - inter_area)


def expand_bbox(x1: int, y1: int, x2: int, y2: int, frame_shape: tuple[int, int, int], pad_ratio: float = 0.12) -> tuple[int, int, int, int]:
    height, width = frame_shape[:2]
    box_w = max(1, x2 - x1)
    box_h = max(1, y2 - y1)
    pad_x = int(box_w * pad_ratio)
    pad_y = int(box_h * pad_ratio)
    return (
        max(0, x1 - pad_x),
        max(0, y1 - pad_y),
        min(width, x2 + pad_x),
        min(height, y2 + pad_y),
    )


def is_reasonable_detection_box(detection: dict, frame_shape: tuple[int, int, int]) -> bool:
    frame_h, frame_w = frame_shape[:2]
    width = max(1, int(detection["x2"]) - int(detection["x1"]))
    height = max(1, int(detection["y2"]) - int(detection["y1"]))
    area_ratio = (width * height) / float(max(1, frame_w * frame_h))
    width_ratio = width / float(max(1, frame_w))
    height_ratio = height / float(max(1, frame_h))
    aspect_ratio = width / float(max(1, height))

    if width_ratio > 0.75:
        return False
    if height_ratio > 0.35:
        return False
    if area_ratio > 0.18:
        return False
    if aspect_ratio < 1.6 or aspect_ratio > 10.0:
        return False
    return True


def filter_reasonable_detections(detections: list[dict], frame_shape: tuple[int, int, int]) -> list[dict]:
    return [detection for detection in detections if is_reasonable_detection_box(detection, frame_shape)]


def split_stacked_plate_detection(detection: dict) -> list[dict]:
    x1 = int(detection["x1"])
    y1 = int(detection["y1"])
    x2 = int(detection["x2"])
    y2 = int(detection["y2"])
    width = max(1, x2 - x1)
    height = max(1, y2 - y1)
    aspect_ratio = width / float(height)

    if aspect_ratio >= 3.8 or height < 110:
        return [detection]

    mid_y = y1 + (height // 2)
    gap = max(4, int(height * 0.04))
    top_detection = dict(detection)
    bottom_detection = dict(detection)
    top_detection["y1"] = y1
    top_detection["y2"] = max(y1 + 1, mid_y - gap)
    top_detection["source"] = f"{detection.get('source', 'unknown')}-split-top"
    bottom_detection["y1"] = min(y2 - 1, mid_y + gap)
    bottom_detection["y2"] = y2
    bottom_detection["source"] = f"{detection.get('source', 'unknown')}-split-bottom"
    top_detection["confidence"] = float(detection.get("confidence", 0.0)) * 0.97
    bottom_detection["confidence"] = float(detection.get("confidence", 0.0)) * 0.97
    return [top_detection, bottom_detection]


def expand_stacked_plate_detections(detections: list[dict]) -> list[dict]:
    expanded: list[dict] = []
    for detection in detections:
        expanded.extend(split_stacked_plate_detection(detection))
    return expanded


def generate_fallback_plate_candidates(frame: np.ndarray) -> list[dict]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(gray)
    blur = cv2.GaussianBlur(clahe, (5, 5), 0)

    # Bright plate-like regions
    bright_mask = cv2.threshold(blur, 150, 255, cv2.THRESH_BINARY)[1]
    bright_mask = cv2.morphologyEx(
        bright_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3)),
        iterations=2,
    )

    # Strong horizontal text/edge structure
    grad_x = cv2.Sobel(blur, cv2.CV_32F, 1, 0, ksize=3)
    grad_x = cv2.convertScaleAbs(grad_x)
    edge_mask = cv2.threshold(grad_x, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    edge_mask = cv2.morphologyEx(
        edge_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (17, 5)),
        iterations=2,
    )

    combined = cv2.bitwise_or(bright_mask, edge_mask)
    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates = []
    frame_h, frame_w = frame.shape[:2]
    min_area = max(1200, int((frame_w * frame_h) * 0.0002))
    top_exclusion = int(frame_h * 0.08)
    bottom_exclusion = int(frame_h * 0.97)

    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        if area < min_area:
            continue
        if y < top_exclusion:
            continue
        if y + h > bottom_exclusion:
            continue
        aspect_ratio = w / max(1, h)
        if aspect_ratio < 1.8 or aspect_ratio > 8.5:
            continue
        if w < 90 or h < 24:
            continue

        roi_mask = combined[y:y + h, x:x + w]
        fill_ratio = float(cv2.countNonZero(roi_mask)) / max(1, area)
        if fill_ratio < 0.2 or fill_ratio > 0.95:
            continue

        roi_gray = gray[y:y + h, x:x + w]
        mean_brightness = float(np.mean(roi_gray))
        if mean_brightness < 70:
            continue
        roi_std = float(np.std(roi_gray))
        if roi_std < 25:
            continue

        rect_score = (
            min(1.0, fill_ratio)
            + min(1.0, aspect_ratio / 4.0)
            + min(1.0, mean_brightness / 255.0)
            + min(1.0, roi_std / 64.0)
        )
        candidates.append(
            {
                "x1": x,
                "y1": y,
                "x2": x + w,
                "y2": y + h,
                "confidence": min(0.45, 0.18 + (rect_score * 0.08)),
                "source": "fallback-contour",
            }
        )

    candidates.sort(key=lambda item: ((item["x2"] - item["x1"]) * (item["y2"] - item["y1"]), item["confidence"]), reverse=True)
    deduped = []
    for candidate in candidates:
        candidate_box = (candidate["x1"], candidate["y1"], candidate["x2"], candidate["y2"])
        if any(compute_iou(candidate_box, (existing["x1"], existing["y1"], existing["x2"], existing["y2"])) > 0.5 for existing in deduped):
            continue
        deduped.append(candidate)
        if len(deduped) >= 8:
            break
    return deduped


def generate_turkey_plate_candidates(frame: np.ndarray) -> list[dict]:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    frame_h, frame_w = frame.shape[:2]

    white_mask = cv2.inRange(hsv, np.array([0, 0, 120]), np.array([180, 80, 255]))
    white_mask = cv2.morphologyEx(
        white_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (11, 5)),
        iterations=2,
    )

    blue_mask = cv2.inRange(hsv, np.array([90, 60, 40]), np.array([135, 255, 255]))
    blue_mask = cv2.morphologyEx(
        blue_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 9)),
        iterations=1,
    )

    contours, _ = cv2.findContours(white_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    min_area = max(1800, int((frame_w * frame_h) * 0.00035))

    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        if area < min_area:
            continue
        if w < 120 or h < 28:
            continue
        aspect_ratio = w / max(1, h)
        if aspect_ratio < 2.0 or aspect_ratio > 7.5:
            continue
        if y < int(frame_h * 0.08) or y + h > int(frame_h * 0.97):
            continue

        roi_white = white_mask[y:y + h, x:x + w]
        white_ratio = float(cv2.countNonZero(roi_white)) / max(1, area)
        if white_ratio < 0.45:
            continue

        roi_gray = gray[y:y + h, x:x + w]
        roi_std = float(np.std(roi_gray))
        if roi_std < 28:
            continue

        blue_band_w = max(8, int(w * 0.22))
        blue_roi = blue_mask[y:y + h, x:x + blue_band_w]
        blue_ratio = float(cv2.countNonZero(blue_roi)) / max(1, blue_roi.shape[0] * blue_roi.shape[1])

        confidence = 0.20 + min(0.12, white_ratio * 0.1) + min(0.08, roi_std / 255.0)
        if blue_ratio > 0.08:
            confidence += 0.08

        candidates.append(
            {
                "x1": x,
                "y1": y,
                "x2": x + w,
                "y2": y + h,
                "confidence": min(0.55, confidence),
                "source": "fallback-turkey-plate",
            }
        )

    candidates.sort(key=lambda item: ((item["x2"] - item["x1"]) * (item["y2"] - item["y1"]), item["confidence"]), reverse=True)
    deduped = []
    for candidate in candidates:
        candidate_box = (candidate["x1"], candidate["y1"], candidate["x2"], candidate["y2"])
        if any(compute_iou(candidate_box, (existing["x1"], existing["y1"], existing["x2"], existing["y2"])) > 0.45 for existing in deduped):
            continue
        deduped.append(candidate)
        if len(deduped) >= 8:
            break
    return deduped


def detect_with_fastalpr(alpr: ALPR, frame: np.ndarray) -> list[dict]:
    detections = []
    for detection in alpr.detector.predict(frame):
        bbox = detection.bounding_box
        detections.append(
            {
                "x1": max(int(bbox.x1), 0),
                "y1": max(int(bbox.y1), 0),
                "x2": min(int(bbox.x2), frame.shape[1]),
                "y2": min(int(bbox.y2), frame.shape[0]),
                "confidence": float(detection.confidence),
                "source": "fastalpr-detector",
            }
        )
    return detections


def detect_with_custom_yolo(detector, frame: np.ndarray) -> list[dict]:
    result = detector(frame, verbose=False)[0]
    detections = []
    for detection in result.boxes.data.tolist():
        x1, y1, x2, y2, confidence, _class_id = detection
        detections.append(
            {
                "x1": max(int(x1), 0),
                "y1": max(int(y1), 0),
                "x2": min(int(x2), frame.shape[1]),
                "y2": min(int(y2), frame.shape[0]),
                "confidence": float(confidence),
                "source": "yolov11-custom",
            }
        )
    return detections


def attach_track_ids(detections: list[dict], tracker: Sort) -> list[dict]:
    if not detections:
        tracker.update(np.empty((0, 5)))
        return detections

    dets = np.array([[d["x1"], d["y1"], d["x2"], d["y2"], d["confidence"]] for d in detections], dtype=float)
    tracks = tracker.update(dets)
    assigned = []

    for detection in detections:
        det_box = (detection["x1"], detection["y1"], detection["x2"], detection["y2"])
        best_track_id = None
        best_iou = 0.0
        for track in tracks:
            track_box = (int(track[0]), int(track[1]), int(track[2]), int(track[3]))
            iou = compute_iou(det_box, track_box)
            if iou > best_iou:
                best_iou = iou
                best_track_id = int(track[4])
        updated = dict(detection)
        if best_track_id is not None and best_iou >= 0.1:
            updated["track_id"] = best_track_id
        assigned.append(updated)

    return assigned


def merge_detection_lists(*detection_lists: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for detection_list in detection_lists:
        for detection in detection_list:
            current_box = (detection["x1"], detection["y1"], detection["x2"], detection["y2"])
            duplicate = False
            for existing in merged:
                existing_box = (existing["x1"], existing["y1"], existing["x2"], existing["y2"])
                if compute_iou(current_box, existing_box) > 0.5:
                    duplicate = True
                    if float(detection.get("confidence", 0.0)) > float(existing.get("confidence", 0.0)):
                        existing.update(detection)
                    break
            if not duplicate:
                merged.append(dict(detection))
    return merged


def score_crop_quality(plate: dict) -> float:
    box = plate["bounding_box"]
    width = max(1, int(box["x2"]) - int(box["x1"]))
    height = max(1, int(box["y2"]) - int(box["y1"]))
    area_score = min((width * height) / 40000.0, 2.0)
    return (
        area_score
        + float(plate.get("detection_confidence") or 0.0)
        + float(plate.get("ocr_confidence_mean") or 0.0)
        + plate_pattern_score(normalize_plate_text(plate.get("plate_text")))
    )


def extract_plate_results(
    args: argparse.Namespace,
    runtime: dict,
    detector_backend: str,
    frame: np.ndarray,
    output_dir: Path,
    custom_detector=None,
    tracker: Sort | None = None,
) -> tuple[list[dict], np.ndarray]:
    alpr = runtime["alpr"]
    annotated = frame.copy()
    if detector_backend == "ensemble":
        fastalpr_detections = detect_with_fastalpr(alpr, frame)
        custom_detections = detect_with_custom_yolo(custom_detector, frame) if custom_detector is not None else []
        detections = merge_detection_lists(fastalpr_detections, custom_detections)
        detections = attach_track_ids(detections, tracker) if tracker else detections
    elif detector_backend == "yolov11-custom":
        detections = detect_with_custom_yolo(custom_detector, frame)
        detections = attach_track_ids(detections, tracker) if tracker else detections
    else:
        detections = detect_with_fastalpr(alpr, frame)

    detections = expand_stacked_plate_detections(detections)
    detections = filter_reasonable_detections(detections, frame.shape)

    if not detections:
        detections = generate_turkey_plate_candidates(frame)
        detections = expand_stacked_plate_detections(detections)
        detections = filter_reasonable_detections(detections, frame.shape)
    if not detections:
        detections = generate_fallback_plate_candidates(frame)
        detections = expand_stacked_plate_detections(detections)
        detections = filter_reasonable_detections(detections, frame.shape)

    payload = []
    for detection in detections:
        x1, y1, x2, y2 = expand_bbox(
            detection["x1"],
            detection["y1"],
            detection["x2"],
            detection["y2"],
            frame.shape,
        )
        cropped_plate = frame[y1:y2, x1:x2]
        ocr_result, selected_variant, candidates, selected_preview = choose_best_ocr(args, runtime, cropped_plate, output_dir)

        plate_text = ocr_result.text if ocr_result else ""
        mean_confidence = confidence_to_mean(ocr_result.confidence if ocr_result else None)
        region = ocr_result.region if ocr_result else None
        region_confidence = ocr_result.region_confidence if ocr_result else None
        track_id = detection.get("track_id")

        label_parts = []
        if track_id is not None:
            label_parts.append(f"#{track_id}")
        if plate_text:
            label_parts.append(plate_text)
            label_parts.append(f"{mean_confidence * 100:.0f}%")

        cv2.rectangle(annotated, (x1, y1), (x2, y2), (36, 255, 12), 2)
        if label_parts:
            cv2.putText(
                annotated,
                " ".join(label_parts),
                (x1, max(20, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 255, 0),
                2,
            )

        payload.append(
            {
                "track_id": track_id,
                "plate_text": plate_text,
                "ocr_confidence": ocr_result.confidence if ocr_result else None,
                "ocr_confidence_mean": mean_confidence,
                "region": region,
                "region_confidence": region_confidence,
                "detection_confidence": float(detection["confidence"]),
                "detection_source": detection.get("source", detector_backend),
                "bounding_box": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "selected_variant": selected_variant,
                "ocr_backend_selected": next((item.get("ocr_backend") for item in candidates if item["variant"] == selected_variant), args.ocr_backend),
                "selected_preview": selected_preview,
                "ocr_candidates": [
                    {
                        "variant": item["variant"],
                        "ocr_backend": item.get("ocr_backend"),
                        "plate_text": item["plate_text"],
                        "normalized_text": item["normalized_text"],
                        "confidence": item["confidence"],
                        "region": item["region"],
                        "region_confidence": item["region_confidence"],
                        "score": item["score"],
                    }
                    for item in candidates
                ],
            }
        )

    return payload, annotated


def draw_live_overlay(annotated: np.ndarray, raw_plates: list[dict], valid_plates: list[dict], frame_index: int) -> np.ndarray:
    preview = annotated.copy()

    for plate in raw_plates:
        box = plate["bounding_box"]
        x1, y1, x2, y2 = box["x1"], box["y1"], box["x2"], box["y2"]
        is_valid = plate in valid_plates
        color = (0, 255, 0) if is_valid else (0, 0, 255)
        thickness = 3 if is_valid else 2
        cv2.rectangle(preview, (x1, y1), (x2, y2), color, thickness)

        plate_text = str(plate.get("plate_text") or "").strip()
        detection_confidence = float(plate.get("detection_confidence") or 0.0)
        ocr_confidence = float(plate.get("ocr_confidence_mean") or 0.0)
        track_id = plate.get("track_id")
        status = "VALID" if is_valid else "RAW"
        label = f"{status}"
        if track_id is not None:
            label += f" #{track_id}"
        if plate_text:
            label += f" {plate_text}"
        label += f" d={detection_confidence:.2f} o={ocr_confidence:.2f}"

        cv2.putText(
            preview,
            label,
            (x1, max(25, y1 - 10)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.75,
            color,
            2,
        )

    cv2.putText(
        preview,
        f"Frame {frame_index}  raw={len(raw_plates)} valid={len(valid_plates)}  q/ESC ile cikis",
        (20, 35),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.9,
        (0, 255, 255),
        2,
    )

    best_plate = None
    best_score = -1.0
    for plate in raw_plates:
        score = float(plate.get("ocr_confidence_mean") or 0.0) + float(plate.get("detection_confidence") or 0.0)
        if score > best_score and plate.get("selected_preview") is not None:
            best_score = score
            best_plate = plate

    if best_plate is not None:
        crop = best_plate["selected_preview"]
        crop_h, crop_w = crop.shape[:2]
        target_w = min(420, crop_w)
        scale = target_w / max(1, crop_w)
        crop = cv2.resize(crop, (int(crop_w * scale), int(crop_h * scale)), interpolation=cv2.INTER_NEAREST)
        crop_h, crop_w = crop.shape[:2]

        x_start = max(10, preview.shape[1] - crop_w - 20)
        y_start = 55
        y_end = min(preview.shape[0], y_start + crop_h)
        x_end = min(preview.shape[1], x_start + crop_w)
        crop = crop[: y_end - y_start, : x_end - x_start]
        cv2.rectangle(preview, (x_start - 4, y_start - 28), (x_end + 4, y_end + 4), (255, 255, 255), 2)
        preview[y_start:y_end, x_start:x_end] = crop
        label = f"BEST CROP {best_plate.get('selected_variant') or '-'} {best_plate.get('plate_text') or ''}"
        cv2.putText(preview, label, (x_start, y_start - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

    return preview


def save_review_example(review_dir: Path, frame_index: int, frame: np.ndarray, plate: dict) -> None:
    bbox = plate["bounding_box"]
    x1, y1, x2, y2 = bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]
    cropped = frame[y1:y2, x1:x2]
    base_name = f"frame-{frame_index:06d}-{x1}-{y1}-{x2}-{y2}"
    cv2.imwrite(str(review_dir / f"{base_name}-crop.jpg"), cropped)
    serializable_plate = {key: value for key, value in plate.items() if key != "selected_preview"}
    (review_dir / f"{base_name}.json").write_text(json.dumps(serializable_plate, indent=2, ensure_ascii=False), encoding="utf-8")


def serialize_plate(plate: dict) -> dict:
    return {key: value for key, value in plate.items() if key != "selected_preview"}


def update_track_summary(track_dir: Path, frame_index: int, frame: np.ndarray, plate: dict, track_summaries: dict) -> None:
    track_id = plate.get("track_id") or 0
    summary = track_summaries.setdefault(
        track_id,
        {
            "track_id": track_id,
            "frames_seen": 0,
            "text_counter": Counter(),
            "weighted_scores": {},
            "best_crop_quality": -1.0,
            "best_crop_path": "",
            "best_detection": None,
        },
    )

    summary["frames_seen"] += 1
    normalized_text = normalize_plate_text(plate.get("plate_text"))
    if normalized_text:
        recency_bonus = min(frame_index / 1000.0, 1.0) * 0.2
        vote_score = (
            float(plate.get("ocr_confidence_mean") or 0.0)
            + float(plate.get("detection_confidence") or 0.0)
            + (plate_pattern_score(normalized_text) * 1.5)
            + recency_bonus
        )
        summary["text_counter"][normalized_text] += 1
        summary["weighted_scores"][normalized_text] = summary["weighted_scores"].get(normalized_text, 0.0) + vote_score

    quality = score_crop_quality(plate)
    if quality > summary["best_crop_quality"]:
        bbox = plate["bounding_box"]
        cropped = frame[bbox["y1"]:bbox["y2"], bbox["x1"]:bbox["x2"]]
        crop_name = f"track-{track_id:03d}-best.jpg"
        crop_path = track_dir / crop_name
        cv2.imwrite(str(crop_path), cropped)
        summary["best_crop_quality"] = quality
        summary["best_crop_path"] = str(crop_path)
        summary["best_detection"] = {
            "frame_index": frame_index,
            "plate_text": plate.get("plate_text") or "",
            "ocr_confidence_mean": plate.get("ocr_confidence_mean"),
            "detection_confidence": plate.get("detection_confidence"),
            "bounding_box": plate["bounding_box"],
            "selected_variant": plate.get("selected_variant"),
        }
        selected_preview = plate.get("selected_preview")
        if selected_preview is not None:
            preview_name = f"track-{track_id:03d}-best-enhanced.jpg"
            preview_path = track_dir / preview_name
            cv2.imwrite(str(preview_path), selected_preview)


def summarize_tracks(track_summaries: dict) -> list[dict]:
    results = []
    for track_id, summary in sorted(track_summaries.items(), key=lambda item: item[0]):
        text_counter = summary["text_counter"]
        weighted_scores = summary["weighted_scores"]
        ranked = sorted(
            text_counter,
            key=lambda item: (text_counter[item], weighted_scores.get(item, 0.0), plate_pattern_score(item)),
            reverse=True,
        )
        best_plate = ranked[0] if ranked else ""
        results.append(
            {
                "track_id": track_id,
                "best_plate": best_plate,
                "frames_seen": summary["frames_seen"],
                "best_crop_path": summary["best_crop_path"],
                "best_detection": summary["best_detection"],
                "candidates": [
                    {
                        "plate_text": item,
                        "count": text_counter[item],
                        "weighted_score": round(weighted_scores.get(item, 0.0), 4),
                    }
                    for item in ranked
                ],
            }
        )
    return results


def summarize_video_results(
    video_results: list[dict],
    track_summaries: dict,
    min_detection_confidence: float,
    min_plate_width: int,
    min_plate_height: int,
    min_ocr_confidence: float,
    turkey_only: bool,
) -> dict:
    text_counter = Counter()
    weighted_scores = {}

    for frame in video_results:
        for plate in frame["plates"]:
            if not is_valid_plate_detection(
                plate,
                min_detection_confidence,
                min_plate_width,
                min_plate_height,
                min_ocr_confidence,
                turkey_only,
            ):
                continue
            text = normalize_plate_text(plate["plate_text"])
            if not text:
                continue
            score = (
                float(plate.get("ocr_confidence_mean") or 0.0)
                + float(plate.get("detection_confidence") or 0.0)
                + plate_pattern_score(text)
            )
            text_counter[text] += 1
            weighted_scores[text] = weighted_scores.get(text, 0.0) + score

    ranked = sorted(
        text_counter,
        key=lambda item: (text_counter[item], weighted_scores.get(item, 0.0), plate_pattern_score(item)),
        reverse=True,
    )
    return {
        "best_plate": ranked[0] if ranked else "",
        "candidates": [
            {
                "plate_text": item,
                "count": text_counter[item],
                "weighted_score": round(weighted_scores.get(item, 0.0), 4),
            }
            for item in ranked
        ],
        "tracks": summarize_tracks(track_summaries),
    }


def analyze_image(args: argparse.Namespace, output_dir: Path) -> int:
    runtime = make_runtime_components(args)
    log_model_info(runtime, args.detector_backend, args.custom_plate_model, args.ocr_backend)
    frame = cv2.imread(args.image)
    if frame is None:
        raise ValueError(f"Failed to load image from path: {args.image}")

    custom_detector = make_custom_detector(args.custom_plate_model) if args.detector_backend == "yolov11-custom" else None
    tracker = Sort(max_age=args.sort_max_age, min_hits=args.sort_min_hits, iou_threshold=args.sort_iou_threshold)
    result_payload, annotated = extract_plate_results(args, runtime, args.detector_backend, frame, output_dir, custom_detector, tracker)
    serializable_payload = [serialize_plate(plate) for plate in result_payload]

    image_name = Path(args.image).stem
    annotated_path = output_dir / f"{image_name}-annotated.jpg"
    json_path = output_dir / f"{image_name}-results.json"
    cv2.imwrite(str(annotated_path), annotated)
    json_path.write_text(json.dumps(serializable_payload, indent=2, ensure_ascii=False), encoding="utf-8")

    if args.json_only:
        print(json.dumps(serializable_payload, ensure_ascii=False))
    else:
        print(f"Annotated image saved to: {annotated_path}")
        print(f"Structured results saved to: {json_path}")
        print(json.dumps(serializable_payload, indent=2, ensure_ascii=False))
    return 0


def open_capture(source: str) -> cv2.VideoCapture:
    if source.isdigit():
        return cv2.VideoCapture(int(source))
    return cv2.VideoCapture(source)


def open_capture_with_retry(source: str, retries: int = 3, delay_seconds: float = 2.0) -> cv2.VideoCapture | None:
    for attempt in range(1, retries + 1):
        print(f"[RTSP] opening source attempt={attempt}/{retries} source=\"{source}\"")
        capture = open_capture(source)
        if capture.isOpened():
            print(f"[RTSP] source opened on attempt={attempt}")
            return capture
        capture.release()
        if attempt < retries:
            print(f"[RTSP] source open failed, retrying after {delay_seconds:.1f}s")
            time.sleep(delay_seconds)
    print(f"[RTSP] source could not be opened after {retries} attempts")
    return None


def show_preview_window(
    preview_state: dict,
    preview: np.ndarray,
    frame_index: int,
    fps: float,
) -> tuple[bool, bool]:
    if preview_state["backend"] == "cv2":
        try:
            cv2.imshow("ALPR Live Preview", preview)
            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord("q")):
                return False, True
            return True, False
        except cv2.error:
            preview_state["backend"] = "matplotlib"

    if preview_state["backend"] == "matplotlib":
        try:
            if preview_state.get("plt") is None:
                import matplotlib.pyplot as plt

                plt.ion()
                figure, axis = plt.subplots(num="ALPR Live Preview")
                image_artist = axis.imshow(cv2.cvtColor(preview, cv2.COLOR_BGR2RGB))
                axis.set_title("ALPR Live Preview")
                axis.axis("off")
                preview_state["plt"] = plt
                preview_state["figure"] = figure
                preview_state["axis"] = axis
                preview_state["image_artist"] = image_artist
            else:
                preview_state["image_artist"].set_data(cv2.cvtColor(preview, cv2.COLOR_BGR2RGB))

            preview_state["axis"].set_xlabel(f"Frame {frame_index}")
            preview_state["figure"].canvas.draw_idle()
            preview_state["plt"].pause(max(0.001, min(0.05, 1.0 / max(fps, 1.0))))
            if not preview_state["plt"].fignum_exists(preview_state["figure"].number):
                return False, True
            return True, False
        except Exception:
            return False, False

    return False, False


def analyze_video(args: argparse.Namespace, output_dir: Path) -> int:
    capture = open_capture_with_retry(args.source)
    if capture is None:
        print(f"Video source could not be opened: {args.source}", file=sys.stderr)
        return 1

    fps = capture.get(cv2.CAP_PROP_FPS)
    if not fps or fps <= 0:
        fps = 25.0
    frame_interval = max(1, int(round(args.sample_every * fps)))

    runtime = make_runtime_components(args)
    log_model_info(runtime, args.detector_backend, args.custom_plate_model, args.ocr_backend)
    custom_detector = make_custom_detector(args.custom_plate_model) if args.detector_backend == "yolov11-custom" else None
    tracker = Sort(max_age=args.sort_max_age, min_hits=args.sort_min_hits, iou_threshold=args.sort_iou_threshold)

    processed = 0
    frame_index = 0
    video_results = []
    track_summaries = {}
    review_dir = output_dir / "review"
    track_dir = output_dir / "tracks"
    review_dir.mkdir(parents=True, exist_ok=True)
    track_dir.mkdir(parents=True, exist_ok=True)
    live_preview_path = output_dir / "live-preview.jpg"
    live_preview_supported = args.show_live
    preview_state = {"backend": "cv2", "plt": None, "figure": None, "axis": None, "image_artist": None}

    unlimited_frames = args.max_frames <= 0

    while unlimited_frames or processed < args.max_frames:
        ok, frame = capture.read()
        if not ok:
            print(f"[RTSP] frame read failed at frame_index={frame_index}, reconnecting")
            capture.release()
            capture = open_capture_with_retry(args.source, retries=2, delay_seconds=1.5)
            if capture is None:
                print("[RTSP] reconnect failed, stopping")
                break
            ok, frame = capture.read()
            if not ok:
                print("[RTSP] reconnect succeeded but first frame could not be read")
                break

        if processed == 0:
            print(f"[RTSP] first frame received shape={frame.shape[1]}x{frame.shape[0]}")

        if frame_index % frame_interval != 0:
            frame_index += 1
            continue

        result_payload, annotated = extract_plate_results(args, runtime, args.detector_backend, frame, output_dir, custom_detector, tracker)
        output_image = output_dir / f"frame-{frame_index:06d}.jpg"
        cv2.imwrite(str(output_image), annotated)

        filtered_payload = []
        for plate in result_payload:
            if not plate["plate_text"] or float(plate.get("ocr_confidence_mean") or 0.0) < 0.75:
                save_review_example(review_dir, frame_index, frame, plate)

            if is_valid_plate_detection(
                plate,
                args.min_detection_confidence,
                args.min_plate_width,
                args.min_plate_height,
                args.min_ocr_confidence,
                args.turkey_only,
            ):
                filtered_payload.append(plate)
                update_track_summary(track_dir, frame_index, frame, plate, track_summaries)

        print(f"[ALPR] frame={frame_index} raw_boxes={len(result_payload)} valid_boxes={len(filtered_payload)}")

        frame_result = {
            "frame_index": frame_index,
            "plates": [serialize_plate(plate) for plate in filtered_payload],
            "raw_plates": [serialize_plate(plate) for plate in result_payload],
            "annotated_image": str(output_image),
        }
        video_results.append(frame_result)

        preview = draw_live_overlay(annotated, result_payload, filtered_payload, frame_index)

        if args.show_live and live_preview_supported:
            shown, should_stop = show_preview_window(preview_state, preview, frame_index, fps)
            if should_stop:
                break
            if not shown:
                live_preview_supported = False
                cv2.imwrite(str(live_preview_path), preview)
                print(
                    f"Canli pencere acilamadi. Onizleme dosyasi guncelleniyor: {live_preview_path}",
                    file=sys.stderr,
                )

        if args.show_live and not live_preview_supported:
            cv2.imwrite(str(live_preview_path), preview)

        if not args.json_only:
            print(f"Frame {frame_index}: {json.dumps([serialize_plate(plate) for plate in filtered_payload], ensure_ascii=False)}")

        processed += 1
        frame_index += 1

    capture.release()
    if args.show_live and preview_state["backend"] == "cv2":
        cv2.destroyAllWindows()
    if args.show_live and preview_state.get("plt") is not None:
        try:
            preview_state["plt"].ioff()
            preview_state["plt"].close(preview_state["figure"])
        except Exception:
            pass

    summary = summarize_video_results(
        video_results,
        track_summaries,
        args.min_detection_confidence,
        args.min_plate_width,
        args.min_plate_height,
        args.min_ocr_confidence,
        args.turkey_only,
    )
    payload = {
        "summary": summary,
        "frames": video_results,
        "detector_backend": args.detector_backend,
        "ocr_model": args.ocr_model,
    }

    json_path = output_dir / "video-results.json"
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    if args.json_only:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(f"Best plate candidate: {summary['best_plate'] or '-'}")
        print(f"Video results saved to: {json_path}")
        print(f"Track summaries: {len(summary['tracks'])}")
        print(f"Sampled frame count: {processed}")
    return 0


def main() -> int:
    args = parse_args()
    output_dir = ensure_output_dir(args.output_dir)

    if args.image:
        return analyze_image(args, output_dir)
    if args.source:
        return analyze_video(args, output_dir)

    print("Use either --image or --source.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
