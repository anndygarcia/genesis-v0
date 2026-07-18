# GENESIS · extract-tool

> A PDF→plan JSON pipeline for Genesis that turns an architect's blueprint
> PDF into the same JSON shape the 3D viewer ingests via
> `window.GENESIS.loadPlan(plan)`.

## Why

Architects deliver floor plans as **PDFs** (vector if exported from AutoCAD
or Revit, raster if scanned). Genesis already has a working 3D viewer that
consumes a structured JSON. The pipeline bridges the two.

## Status (v0.1)

- **Vector PDFs** — fully supported. Tested on synthetic architect-style PDFs.
  Extracts:
  - Outer walls and interior walls (precise line geometry from the PDF)
  - Text labels and dimension annotations (`"30'-0\""`, `"9'-8 1/2"`)
  - pixelsPerFoot from dimension annotations
  - Rectangular room boundaries from the wall network
- **Raster PDFs** — detected and reported as unsupported. OCR + YOLOv8
  detection pipeline is the next slice (v0.2).

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
