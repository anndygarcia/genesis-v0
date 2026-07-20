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
  matchOpeningsToWalls,
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
  const detMs = performance.now() - tDet;
  // The model returns openings at no extra cost (same mask).
  // When the Canny fallback is in play, openings is undefined and we
  // emit empty arrays — the user gets walls + rooms but no doors/windows.
  const openingsPixel = det.openings || { doors: [], windows: [] };

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

  // 9. Match openings to walls. This produces plan doors + windows in
  // the format the 3D viewer's renderer expects:
  //   { id, x, z, w, axis: 'x'|'z', kind?, label }
  const matched = matchOpeningsToWalls(
    openingsPixel, linesInFt, rooms, ppf, H
  );

  const elapsedMs = performance.now() - t0;
  return {
    plan: {
      name: fileName.replace(/\.pdf$/i, ''),
      rooms,
      footprint: envelope,
      doors: matched.doors,
      windows: matched.windows,
      source: 'raster-extract',
      calibration: cal,
      ocr: {
        wordCount: words.length,
        avgConfidence: words.length
          ? words.reduce((s, w) => s + w.confidence, 0) / words.length
          : 0,
      },
      detection: {
        source: det.source,
        modelOpenings: {
          doorCount: openingsPixel.doors?.length || 0,
          windowCount: openingsPixel.windows?.length || 0,
        },
      },
    },
    elapsedMs: { total: elapsedMs, ocr: ocrMs, detect: detMs },
  };
}
