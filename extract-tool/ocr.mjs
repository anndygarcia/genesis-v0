// GENESIS · extract-tool/ocr.mjs
//
// Tesseract.js wrapper — runs OCR on a canvas (browser) or image buffer
// (Node), returns position-aware words that the rest of the pipeline
// can use the same way as vector PDF text runs.
//
// Usage:
//   import { ocrCanvas, ocrWordsToTextRuns } from './ocr.mjs';
//   const words = await ocrCanvas(canvas);
//   const textRuns = ocrWordsToTextRuns(words);

// Resolve tesseract.js paths. In Node, point at the locally-installed
// tesseract.js-core so we don't need to download it from a CDN. In the
// browser, fall back to the default CDN behavior.
const TESS_OPTS = (() => {
  if (typeof process !== 'undefined' && process.versions?.node) {
    return { langPath: './langs', corePath: './node_modules/tesseract.js-core' };
  }
  return {};
})();

let workerPromise = null;

export async function ensureOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const w = await createWorker('eng', 1, TESS_OPTS);
      await w.setParameters({
        tessedit_pageseg_mode: '11',  // sparse text — faster on floor plans
        preserve_interword_spaces: '1',
      });
      return w;
    })();
  }
  return workerPromise;
}

export async function ocrCanvas(canvas) {
  const w = await ensureOcrWorker();
  // tesseract.js accepts a canvas in browser, but in Node we need to
  // pass a buffer/image. The node-canvas `toBuffer()` works.
  let input;
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    input = canvas;
  } else if (canvas.toBuffer) {
    // node-canvas
    input = canvas.toBuffer('image/png');
  } else {
    input = canvas;  // browser HTMLCanvasElement
  }
  const { data } = await w.recognize(input);
  return (data.words || []).map(W => ({
    text: W.text,
    bbox: { x0: W.bbox.x0, y0: W.bbox.y0, x1: W.bbox.x1, y1: W.bbox.y1 },
    confidence: W.confidence,
  }));
}

// Tesseract → text-run shape used by calibrate.mjs / fuse.mjs.
export function ocrWordsToTextRuns(words) {
  return words.map(W => ({
    str: W.text,
    x: W.bbox.x0,
    y: W.bbox.y0,
    width: W.bbox.x1 - W.bbox.x0,
    height: W.bbox.y1 - W.bbox.y0,
    fontSize: W.bbox.y1 - W.bbox.y0,
    confidence: W.confidence,
  }));
}
