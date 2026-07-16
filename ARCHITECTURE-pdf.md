# Genesis · PDF-to-3D pipeline

> Companion to `ARCHITECTURE.md`. Describes how a real PDF (or PNG,
> JPEG, sketch) becomes a `loadPlan(plan)`-able plan JSON.
>
> **Status: design.** Implementation timeline in the table at the
> bottom of this file.

## Why this is hard — and why it's tractable

A 2D architectural plan is a drawing language, not a photograph:

- **Walls** are double-parallel lines (or two parallel fills + one midpoint line)
- **Doors** are quarter-arcs hinged at one wall endpoint + a perpendicular line
- **Windows** are two parallel short lines crossing inside a wall
- **Rooms** are the *complements* of walls: connected polygons on a planar graph
- **Labels** are sticky text on the room face
- **Dimensions** are dimension strings + extension lines along a wall

So the parsing problem can be modeled as **planar geometry analysis with OCR
on top**, not pure vision. We can do this without the giant labeled dataset
Hover relies on.

## Reference: what Hover does

| Hover's stage | What it is | Cost | Time |
|---|---|---|---|
| Photo ingest | 1–4 JPGs at <10MB | free | <1s |
| EXIF + resize | 1024px max edge | free | <1s |
| COLMAP SfM | multi-view 3D reconstruction | $0.15/req | 30–60s |
| Mesh cleanup | neural network, no public model | (covered above) | |
| **Output** | textured GLB, no semantic labels | free | <1s |

The output is a mesh of all visible geometry, with materials baked from the
photo. It's beautiful but **doesn't** carry room labels, door positions,
wall dimensions, etc. — it's a presentation tool, not a working drawing.

## The path we take: PDF → planar graph → `loadPlan(plan)`

```
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 0: file ingest  (browser-only, <2s)                              │
│                                                                         │
│   • User drops PDF / PNG / JPEG onto canvas                             │
│   • PDF.js extracts first (or selected) page → render to <canvas> 200dpi│
│   • Store pixels as a base64 data URL in a /functions/api/parse-blob    │
│     multipart/form-data POST                                            │
│                                                                         │
│   Output: { kind: 'pdf'|'png'|'jpeg', pages: [b64, ...], size: {w,h} } │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: detection  (server, GPU; <1s/page on T4)                      │
│                                                                         │
│   Two parallel inferences:                                              │
│   • YOLO11 fine-tuned on FloorplanCAD (~700 plans, BSD-licensed)         │
│     5 classes: wall_segment, door, window, fixture, label              │
│     Output: { walls: [[x1,y1,x2,y2]...], symbols: [{type, x,y, w, h}] }│
│   • PaddleOCR (or TrOCR for handwritten)                                │
│     Output: { tokens: [{text, bbox, confidence}] }                     │
│                                                                         │
│   Models:                                                               │
│   • YOLO11n: ~8MB, 2.5ms/image inference on GPU                         │
│   • PaddleOCR mobile: 12MB, 100ms/image                                 │
│                                                                         │
│   Total model footprint: <30MB RAM during inference                      │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: vectorization  (CPU, <0.5s/page)                              │
│                                                                         │
│   Two candidate approaches; recommended for v2.1:                       │
│                                                                         │
│   A. Use YOLO'd wall-segments directly (works on raster PDFs)           │
│   B. Pre-emptively run cv2.LineSegmentDetector + HoughP on the image    │
│      and merge with YOLO'd segments for redundancy                      │
│                                                                         │
│   Output: wall_segs = [{ start:[x,y], end:[x,y], thickness_px:number,  │
│                          kind:'exterior'|'interior', source:'yolo'|'ld'│
│                       }, ...]                                          │
│                                                                         │
│   Doors/windows are YOLO-symbol bbox centers, snapped to nearest wall   │
│   in a 30px radius. Width is set by the bbox or by the door/window      │
│   standards default (3 ft exterior door, 2'6" interior, 3 ft window).  │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 3: planar graph + room segmentation  (CPU, <0.5s/page)            │
│                                                                         │
│   1. Build graph:                                                       │
│      • node = wall_endpoint, deduplicated within 8px                   │
│      • edge = wall_segment                                              │
│                                                                         │
│   2. Closed-polygon extraction:                                         │
│      • From any node, BFS along walls to find smallest cycle           │
│      • Repeat until all polygon closure candidates exhausted           │
│      • Result: a list of node-sequences that form closed loops         │
│                                                                         │
│   3. Polygon merge (doors cut walls in half):                          │
│      • Where a door arc terminates a wall, the wall becomes two edges   │
│      • After processing all doors, re-run closed-polygon extraction    │
│                                                                         │
│   4. Token-to-polygon matching:                                         │
│      • For each OCR token, find the centroid of each polygon            │
│      • Assign token to the polygon whose centroid is closest to the     │
│        token's bbox center, provided it's INSIDE the polygon            │
│                                                                         │
│   Output: rooms = [{ id, name (from OCR or 'Room N'), polygon,         │
│                       centroid, bbox, confidence }]                     │
│                                                                         │
│   Plus: doors[], windows[] (from stage 2)                                │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 4: dimensioning + scale calibration  (CPU, <0.2s/page)           │
│                                                                         │
│   1. Find dimension strings in OCR tokens (regex: `\\d+['-]?\\s*-?\\s*\\d*/?\\d*"`)
│       yields "12' 0\"", "13'-6\"", etc.  →  normalized to inches/feet    │
│   2. Find dimension extension lines (parallel to walls, slightly offset)│
│   3. Calibrate: the first matched dimension sets the pixel→feet ratio  │
│      by comparing it against the closest wall length                  │
│   4. Apply scale ratio to all room coordinates                         │
│   5. Translate to origin (0,0) at the SW corner                        │
│                                                                         │
│   Output: a fully-scaled plan JSON matching the `state.house.plan`     │
│           schema (see ARCHITECTURE.md)                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                              loadPlan(plan)
                              buildSceneFromPlan(plan)
                              done. 3–6 seconds total.
```

## Why this is faster than Hover

| | Hover | Genesis PDF path |
|---|---|---|
| GPU work | SfM multi-view | YOLO11 only |
| Inference time | 30–60s (multi-view) | ~2s (single image) |
| Output type | Mesh (no semantics) | Plan JSON (semantic) |
| Render in browser | Re-process GLB | `loadPlan` + Three.js in 16ms |
| Cost / parse | $0.15–0.50 | $0.02–0.05 |

We give up fidelity to photo-specific details (real roof shingles,
colored paint textures baked from photos) but gain semantic understanding
that's MORE useful for actual building work (rooms, walls, doors as
first-class objects you can click, measure, and quote).

## Honest assessment of what's hard

1. **Wall thickness vs dimension ambiguity.** Some plans draw walls as
   double lines; some as filled rectangles. We can normalize but it
   costs accuracy in some cases. We fall back to a default 0.5 ft
   thickness and let the user override.

2. **Multi-page plans.** A real house plan is 3–8 pages (floor plan,
   elevation, site plan, sections). v2.1 only handles the FIRST page as
   the floor plan. Multi-page is a v2.3 item.

3. **Hand-drawn sketches.** "Hover but for sketch" needs much harder
   CV. The current path handles prints well, sketches at 60% accuracy.
   Worth solving as v2.4.

4. **Multi-floor.** v2.1 is a single-floor plan. Multi-floor needs an
   explicit "elevator/stairs" detector + a floor ordinal on each room.

## Compute posture

- **v2.0 (no ML, just user-traced polygons)**: zero backend. Run entirely
  in the browser via `paper.js` stroke capture + a polygon Vectorizer.
  Deploys as static files. No GPU needed. **Free.**
- **v2.1–v2.3 (ML pipeline)**: one Python FastAPI on Modal.com or
  Replicate. Cold start ~10s, warm inference ~2s. Cost: $0.02–0.05/parse.
  Alternative: GPU function on Cloudflare (currently in beta, free during
  preview if you get in).

## Datasets to know about

| Dataset | Size | License | Use |
|---|---|---|---|
| FloorplanCAD | ~700 plans | BSD-2 | YOLO fine-tune for walls/symbols |
| CubiCasa | ~30,000 plans | Non-commercial | Wall + room polygon GT |
| RPLAN | ~80,000 plans | Free for research | Wall + room polygon GT |
| zillow-floorplans | ~800 plans | Public scrape | Background diversity |
| Structured3D | 3,500 scenes | Research only | Photorealistic + plan |

For **commercial** deployment of v2.x, only CubiCasa's commercial API
tier and FloorplanCAD are usable without lawyers. Plan accordingly.

## What I'll build first: the v2.0 (no-ML) path

The fastest path to a working PDF-to-plan flow **without GPU, without
training, without lawsuits**:

1. **User opens the PDF / image in the viewer** (already done — pdf.js
   is loaded).
2. **User clicks wall corners** to trace a wall. The viewer shows
   snap-to-axis guides and angle hints. Edges are stored in memory.
3. **User clicks a room name input** while inside a closed poly → the
   viewer creates a new room from the trace.
4. **When done, viewer calls `GENESIS.loadPlan(plan)`** — the rest
   already works.

This is **v0.6 → v2.0 UX**. It's not Hover — but it's the right
foundation. v2.1+ automates (1)–(3) using YOLO. We can ship v2.0 today
without any GPU.

The amount of code: ~300 lines of `paper.js`-style stroke capture +
polygon emission, plus a small UI overlay. Weekend project at most.

## Reference implementation (target for v2.1)

```python
# api/parse-blob.py — server-side handler
import fastapi, modal
from ultralytics import YOLO  # YOLO11
from paddleocr import PaddleOCR

app = fastapi.FastAPI()
yolo = YOLO("floorplan-best.pt")  # fine-tuned on FloorplanCAD
ocr = PaddleOCR(use_angle_cls=True, lang='en')

@app.post("/parse-blob")
async def parse_blob(b64: str = Body(...)):
    img = decode(b64)              # 4-channel RGB + alpha PNG
    walls = yolo(img, classes=0)   # 0 = wall_segment
    symbols = yolo(img, classes=[1,2,3])  # door, window, fixture
    text = ocr.ocr(img)             # dict of {tokens: [...]}
    plan_json = vectorize(walls, symbols, text)  # stages 2–4
    return plan_json
```

The returned JSON shape matches `state.js`'s expected plan schema.
Frontend `handleUploadedFile` just calls `GENESIS.loadPlan(plan)`.
