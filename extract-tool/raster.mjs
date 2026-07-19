// GENESIS · extract-tool/raster.mjs
//
// Orchestrator for raster (scanned) PDFs:
//   1. Render each PDF page to a canvas (pdfjs-dist)
//   2. OCR the canvas with Tesseract.js (positions + confidence)
//   3. Detect walls with the edge+Hough pipeline (detect.mjs)
//   4. Calibrate from OCR'd dimension strings
//   5. Reuse fuse.mjs to find rectangular rooms and attach labels
//
// Output: same plan JSON shape as the vector path so the 3D viewer
// can loadPlan() the result identically.

import { ocrCanvas, ocrWordsToTextRuns } from './ocr.mjs';
import { detectWalls } from './detect.mjs';
import { calibrate } from './calibrate.mjs';
import {
  findEnvelope, findRectangularRooms, attachLabels, attachHeights,
} from './fuse.mjs';

export async function extractPlanFromRasterCanvas(canvas, { fileName = 'plan' } = {}) {
  const t0 = performance.now();

  // 1. OCR text
  const tOcr = performance.now();
  const words = await ocrCanvas(canvas);
  const textRuns = ocrWordsToTextRuns(words);
  const ocrMs = performance.now() - tOcr;

  // 2. Detect walls + doors + windows (model path or Canny+Hough fallback).
  const tDet = performance.now();
  const det = await detectWalls(canvas);
  const lines = det.lines;

  // 3. If the model is providing openings, use them directly.
  let doors = [], windows = [];
  if (det.source === 'model') {
    try {
      const model = await import('./detect-model.mjs');
      // Re-run segmentation to get openings (we already have it; just refactor)
      // Skip — easier to just emit blank openings since opening-to-wall-host
      // matching is still v0.3 work.
    } catch {}
  }

  // 4. Calibrate
  const cal = calibrate(lines, textRuns);
  const ppf = cal.pixelsPerFoot;

  // 5. Convert pixel → feet (y-down after OCR/edge)
  const H = canvas.height;
  const linesInFt = lines.map(L => ({
    x1: L.x1 / ppf,
    y1: (H - L.y1) / ppf,
    x2: L.x2 / ppf,
    y2: (H - L.y2) / ppf,
  }));

  // 6. Build envelope + rooms (reuse vector path)
  const envelope = findEnvelope(linesInFt);
  const rooms = findRectangularRooms(linesInFt, envelope);

  // 7. Attach labels from OCR text runs
  for (const run of textRuns) {
    const ftX = run.x / ppf;
    const ftY = (H - run.y) / ppf;
    const str = (run.str || '').trim();
    if (!str) continue;
    const room = rooms.find(r =>
      ftX >= r.x && ftX <= r.x + r.w &&
      ftY >= r.z && ftY <= r.z + r.d
    );
    if (room && !room.name) room.name = str;
  }
  rooms.forEach((r, i) => { if (!r.name) r.name = `Room ${i + 1}`; });

  // 8. Heuristic ceiling heights
  for (const room of rooms) {
    const m = (room.name || '').match(/(\d+)['\s]*(?:CLG|CLG\.|CEILING)/i);
    if (m) room.h = parseInt(m[1], 10);
    if (!room.h) room.h = 9;
  }

  const elapsedMs = performance.now() - t0;
  return {
    plan: {
      name: fileName.replace(/\.pdf$/i, ''),
      rooms,
      footprint: envelope,
      doors,
      windows,
      source: 'raster-extract',
      calibration: cal,
      ocr: {
        wordCount: words.length,
        avgConfidence: words.length
          ? words.reduce((s, w) => s + w.confidence, 0) / words.length
          : 0,
      },
    },
    elapsedMs: { total: elapsedMs, ocr: ocrMs, detect: det.elapsedMs ?? 0 },
  };
}
