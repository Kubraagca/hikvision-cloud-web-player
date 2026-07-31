# Reference

This page shows the public API of FastALPR.

## At a Glance

- Use `ALPR.predict()` to get structured ALPR results
- Use `ALPR.draw_predictions()` to get an annotated image and the same ALPR results
- `BoundingBox` and `DetectionResult` come from `open-image-models`

## Imports

```python
from fast_alpr import ALPR, ALPRResult, DrawPredictionsResult, OcrResult
```

## Common Inputs

- A NumPy image in BGR format
- A string path to an image file

## Common Returns

- `ALPR.predict(...)` returns `list[ALPRResult]`
- `ALPR.draw_predictions(...)` returns `DrawPredictionsResult`

`ALPRResult` contains:

- `detection`: box, label, and detection confidence
- `ocr`: recognized text and OCR confidence, or `None`

`DrawPredictionsResult` contains:

- `image`: the image with boxes and text drawn on it
- `results`: the same ALPR results used for drawing

## Available Models

See the available detection models in [open-image-models](https://ankandrew.github.io/open-image-models/0.4/reference/#open_image_models.detection.core.hub.PlateDetectorModel)
and OCR models in [fast-plate-ocr](https://ankandrew.github.io/fast-plate-ocr/1.0/inference/model_zoo/).

## Main Class

::: fast_alpr.alpr.ALPR
    options:
      show_root_heading: true
      show_root_toc_entry: false

## Result Types

::: fast_alpr.alpr.ALPRResult
    options:
      show_root_heading: true
      show_root_toc_entry: false

::: fast_alpr.alpr.DrawPredictionsResult
    options:
      show_root_heading: true
      show_root_toc_entry: false

::: fast_alpr.base.OcrResult
    options:
      show_root_heading: true
      show_root_toc_entry: false

## Interfaces

::: fast_alpr.base.BaseDetector
    options:
      show_root_heading: true
      show_root_toc_entry: false

::: fast_alpr.base.BaseOCR
    options:
      show_root_heading: true
      show_root_toc_entry: false

## External Types

See [`BoundingBox`][open_image_models.detection.core.base.BoundingBox]
and [`DetectionResult`][open_image_models.detection.core.base.DetectionResult].
