# ALPR Model Audit

Audit date: 2026-07-30

| File or model | Location | Role | Referenced from | Usage status | Action taken |
| --- | --- | --- | --- | --- | --- |
| `yolo-v9-s-608-license-plates-end2end.onnx` | `alpr-service/models/open-image-models/yolo-v9-s-608-license-plate-end2end/` | Production plate detector ONNX | `alpr-service/recognizer.py`, `alpr-service/app.py`, `lib/alpr-service.js`, `/api/alpr/*` flow | Used | Kept and promoted into fixed project path |
| `cct_s_v2_global.onnx` | `alpr-service/models/fast-plate-ocr/cct-s-v2-global-model/` | Production OCR ONNX | `alpr-service/recognizer.py`, `alpr-service/app.py`, `lib/alpr-service.js`, `/api/alpr/*` flow | Used | Kept and promoted into fixed project path |
| `cct_s_v2_global_plate_config.yaml` | `alpr-service/models/fast-plate-ocr/cct-s-v2-global-model/` | OCR alphabet/config | `alpr-service/recognizer.py` | Used | Kept with OCR model |
| `scripts/test_plate_recognition.py` | `scripts/` | Experimental ALPR script using FastALPR, PaddleOCR, YOLOv11, SORT, Real-ESRGAN, NAFNet | Direct script execution only | Not part of active runtime | Left in place, not deleted |
| `alpr-extras/automatic-license-plate-recognition-using-yolov11-main/models/license_plate_detector.pt` | `alpr-extras/automatic-license-plate-recognition-using-yolov11-main/models/` | Legacy/custom detector model | `scripts/test_plate_recognition.py` | Usage limited to old test flow | Grouped under shared ALPR extras folder, not deleted |
| `alpr-extras/automatic-license-plate-recognition-using-yolov11-main/models/custom_license_plate_detector.pt` | `alpr-extras/automatic-license-plate-recognition-using-yolov11-main/models/` | Legacy/custom detector model | `scripts/test_plate_recognition.py` | Usage limited to old test flow | Grouped under shared ALPR extras folder, not deleted |
| `alpr-extras/fast-alpr-master/` | `alpr-extras/fast-alpr-master/` | Vendored library checkout for prior experiments | `scripts/test_plate_recognition.py` manipulates `sys.path` | Usage limited to old test flow | Grouped under shared ALPR extras folder, not deleted |
| `alpr-extras/PaddleOCR-main/` | `alpr-extras/PaddleOCR-main/` | OCR experiment dependency | `scripts/test_plate_recognition.py` via `PaddleOCR` | Usage limited to old test flow | Grouped under shared ALPR extras folder, not deleted |
| `alpr-extras/sort/` | `alpr-extras/sort/` | Tracking helper for experimental video flow | `scripts/test_plate_recognition.py` | Usage limited to old test flow | Grouped under shared ALPR extras folder, not deleted |
| `alpr-extras/Real-ESRGAN-master/` | `alpr-extras/Real-ESRGAN-master/` | Optional crop enhancer for experiments | `scripts/test_plate_recognition.py` subprocess calls | Usage limited to old test flow | Grouped under shared ALPR extras folder, not deleted |
| `alpr-extras/NAFNet-main/` | `alpr-extras/NAFNet-main/` | Optional crop enhancer for experiments | `scripts/test_plate_recognition.py` subprocess calls | Usage limited to old test flow | Grouped under shared ALPR extras folder, not deleted |
| `C:\Users\Kubra\.cache\open-image-models\yolo-v9-s-608-license-plate-end2end\yolo-v9-s-608-license-plates-end2end.onnx` | User cache | External source copy for detector | Resolved by FastALPR during prior local tests | No longer required at runtime after copy | Verified hash, copied into project, external path removed from runtime dependency |
| `C:\Users\Kubra\.cache\fast-plate-ocr\cct-s-v2-global-model\cct_s_v2_global.onnx` | User cache | External source copy for OCR | Resolved by FastALPR during prior local tests | No longer required at runtime after copy | Verified and copied into project |
| `C:\Users\Kubra\.cache\fast-plate-ocr\cct-s-v2-global-model\cct_s_v2_global_plate_config.yaml` | User cache | External OCR config | Resolved by FastALPR during prior local tests | No longer required at runtime after copy | Verified and copied into project |

## Notes

- No Hikvision SDK, ISAPI, Hik-Connect, live stream, or provisioning files were removed.
- No ALPR model or dependency was deleted from the repository because older experimental assets still have references in `scripts/test_plate_recognition.py`.
- The active ALPR runtime now uses only CPU-oriented ONNX Runtime providers and fixed relative model paths under `alpr-service/models/`.
