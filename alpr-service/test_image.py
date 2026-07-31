from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2

from recognizer import PlateRecognizer


ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = Path(r"C:\Users\Kubra\Desktop\plaka-test\test10.jpg")
DEFAULT_OUTPUT = ROOT / "artifacts" / "test-image-output.jpg"
DEFAULT_JSON = ROOT / "artifacts" / "test-image-output.json"


def draw_results(image, plates: list[dict]) -> None:
    for plate in plates:
        bbox = plate["bbox"]
        x1 = int(bbox["x1"])
        y1 = int(bbox["y1"])
        x2 = int(bbox["x2"])
        y2 = int(bbox["y2"])
        text = plate.get("normalizedText") or plate.get("text") or "OKUNAMADI"
        detection_conf = float(plate.get("detectionConfidence") or 0.0)
        ocr_conf = float(plate.get("ocrConfidence") or 0.0)
        label = f"{text} D:{detection_conf:.2f} O:{ocr_conf:.2f}"

        cv2.rectangle(image, (x1, y1), (x2, y2), (0, 255, 0), 3)
        text_y = y1 - 10 if y1 > 30 else y1 + 25
        cv2.putText(
            image,
            label,
            (x1, text_y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 255, 0),
            2,
            cv2.LINE_AA,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Run ALPR image test with project-integrated models.")
    parser.add_argument("--image", default=str(DEFAULT_INPUT), help="Input image path")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Annotated output image path")
    parser.add_argument("--json", default=str(DEFAULT_JSON), help="JSON output path")
    parser.add_argument("--min-detection-confidence", type=float, default=0.2)
    parser.add_argument("--min-ocr-confidence", type=float, default=0.0)
    parser.add_argument("--turkey-only", action="store_true")
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    output_path = Path(args.output)
    json_path = Path(args.json)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)

    image = cv2.imread(str(image_path))
    if image is None:
        raise RuntimeError(f"Image could not be opened: {image_path}")

    recognizer = PlateRecognizer()
    result = recognizer.recognize(
        image_path=str(image_path),
        min_detection_confidence=args.min_detection_confidence,
        min_ocr_confidence=args.min_ocr_confidence,
        turkey_only=args.turkey_only,
        source="test-image",
    )

    annotated = image.copy()
    draw_results(annotated, result["plates"])
    cv2.imwrite(str(output_path), annotated)
    json_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")

    print(json.dumps(result, ensure_ascii=True, indent=2))
    print(f"Annotated image: {output_path}")
    print(f"JSON output: {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
