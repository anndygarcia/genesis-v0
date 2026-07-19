# GENESIS · extract-tool

> A PDF→plan JSON pipeline for Genesis that turns an architect's blueprint
> PDF into the same JSON shape the 3D viewer ingests via
> `window.GENESIS.loadPlan(plan)`.

## Why

Architects deliver floor plans as **PDFs** (vector if exported from AutoCAD
or Revit, raster if scanned). Genesis already has a working 3D viewer that
consumes a structured JSON. The pipeline bridges the two.

## Status

- **Vector PDFs** — fully supported (pdfjs-dist → precise line geometry → fuse.mjs rooms).
- **Raster PDFs** — fully supported. Two-stage pipeline:
  1. **Tesseract.js OCR** → text labels + dimension strings
  2. **Yytsi/floorplan-to-3d-walls** UNet (ResNet-34, fine-tuned on
     CubiCasa5K, 0.983 mIoU on validation) → 4-class segmentation mask
     (floor / wall / door / window)
  Both stages feed `fuse.mjs` for the final plan JSON.

## Models

| File | Size | Source | Purpose |
|---|---|---|---|
| `models/walls.onnx` | 98 MB | [Yytsi/floorplan-to-3d-walls](https://huggingface.co/Yytsi/floorplan-to-3d-walls) (MIT) | Wall + door + window segmentation |
| `langs/eng.traineddata` | 23 MB | Tesseract LSTM (Apache) | OCR for raster PDFs |

The wall-detection model is auto-loaded the first time the user
hits "Extract 3D" with a scanned PDF; subsequent runs are cached
in the browser by the HTTP cache. The OCR traineddata file is
loaded from the local `langs/` directory (Node CLI) or from
Tesseract.js's CDN (browser).

To regenerate `walls.onnx` from the source weights (e.g. after a
fine-tune), run `python convert_model.py` — downloads the safetensors
from HuggingFace and emits a single-file 98 MB ONNX.

## Modules

| File | Purpose |
|---|---|
| `vector.mjs` | Walk pdfjs-dist's `constructPath` operator list, emit lines |
| `text.mjs` | Extract positioned text runs from a vector PDF |
| `calibrate.mjs` | Match dimension strings to their dim lines, get `pixelsPerFoot` |
| `fuse.mjs` | Combine lines + text + calibration into a plan JSON |
| `cli.mjs` | CLI: `node cli.mjs <pdf-path> [--page N] [--out plan.json]` |
| `make_pdf.cjs` / `make_garcia.cjs` | Synthetic architect-style PDFs for testing |

## Run it

```bash
npm install                    # pdfjs-dist + pdf-lib
node make_pdf.cjs             # produces /tmp/sample-arch.pdf
node cli.mjs /tmp/sample-arch.pdf
node make_garcia.cjs          # produces /tmp/garcia-test.pdf
node cli.mjs /tmp/garcia-test.pdf --out /tmp/plan.json
```

## Plan JSON shape

Output matches the `state.js` schema:

```json
{
  "name": "garcia-test",
  "rooms": [
    { "id": "room-0-0", "x": 8.0, "z": 42.0, "w": 18.2, "d": 11.0, "area": 200.2, "name": "Covered Porch", "h": 9 }
  ],
  "footprint": { "x": 8.0, "y": 42.0, "w": 80.5, "d": 62.0, "wallH": 10 },
  "source": "extract",
  "calibration": { "pixelsPerFoot": 18, "confidence": 0.85 }
}
```

Feed it back to Genesis with:

```js
window.GENESIS.loadPlan(plan);   // browser-side
```

## What's missing (v0.2+)

- **OCR for raster PDFs** (Tesseract.js worker — already installed)
- **YOLOv8 / Co-DETR detection** for wall/door/window bounding boxes
- **Door + window detection** (currently only outer/inner walls)
- **Polygonal rooms** (currently only axis-aligned rectangles)
- **Ceiling-height parsing** (`"10' CLG"` is partially supported)
- **Multi-floor support** (Garcia has 2 floors; current pipeline emits floor 1 only)

## Performance

Vector pipeline: **~10-50ms per page** on a Mac Mini. Real PDFs with thousands
of lines will be slower; expect 100-500ms for full architect pages.
