// GENESIS · extract-tool/cli.mjs
//
// CLI: take a PDF, run vector + OCR pipeline, emit a plan JSON.
//
// Usage:
//   node cli.mjs <pdf-path> [--page N] [--out <json-path>]
//
// For VECTOR PDFs (architect drawings exported from AutoCAD etc.):
//   1. extractVectorLines()    → precise wall geometry
//   2. extractTextRuns()        → labeled text positions
//   3. calibrate()              → pixelsPerFoot
//   4. fuse()                   → plan JSON
//
// For RASTER PDFs (scanned blueprints):
//   1. Render page to canvas    → PNG buffer
//   2. Tesseract.js OCR         → text runs
//   3. (YOLOv8 detection TBD)   → wall geometry
//   4. calibrate()              → pixelsPerFoot
//   5. fuse()                   → plan JSON
//
// v0.1 ships the VECTOR pipeline. RASTER support is stubbed.

import { extractPlanFromPdf } from './fuse.mjs';
import fs from 'node:fs/promises';

async function detectPdfKind(pdfPath) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const ops = await page.getOperatorList();
  // Heuristic: vector if getTextContent returns >5 items AND ops contains constructPath
  const text = await page.getTextContent();
  let hasConstructPath = false;
  for (const fn of ops.fnArray) {
    if (fn === pdfjsLib.OPS.constructPath) { hasConstructPath = true; break; }
  }
  if (text.items.length > 5 && hasConstructPath) return 'vector';
  if (text.items.length > 5) return 'text-raster';   // text is real but no paths? unusual
  return 'raster';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node cli.mjs <pdf-path> [--page N] [--out path.json]');
    process.exit(1);
  }
  const pdfPath = args[0];
  let pageIndex = 0;
  let outPath = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--page') pageIndex = +args[++i];
    else if (args[i] === '--out') outPath = args[++i];
  }

  console.log(`[extract] reading ${pdfPath}`);
  const kind = await detectPdfKind(pdfPath);
  console.log(`[extract] detected kind: ${kind}`);

  if (kind === 'raster') {
    console.error('[extract] RASTER PDFs not yet supported in v0.1.');
    console.error('         OCR + YOLOv8 detection pipeline coming in v0.2.');
    process.exit(2);
  }

  console.log(`[extract] running vector pipeline on page ${pageIndex + 1}...`);
  const t0 = Date.now();
  const result = await extractPlanFromPdf(pdfPath, { pageIndex });
  const dt = Date.now() - t0;
  console.log(`[extract] done in ${dt}ms`);

  console.log(`[extract] calibration: ${result.plan.calibration.pixelsPerFoot.toFixed(2)} pt/ft (conf=${result.plan.calibration.confidence.toFixed(2)})`);
  console.log(`[extract] detected ${result.plan.rooms.length} rooms`);

  const json = JSON.stringify(result.plan, null, 2);
  if (outPath) {
    await fs.writeFile(outPath, json);
    console.log(`[extract] wrote ${outPath} (${json.length} bytes)`);
  } else {
    console.log(json);
  }
}

main().catch(e => {
  console.error('[extract] FAILED:', e.stack || e.message);
  process.exit(1);
});
