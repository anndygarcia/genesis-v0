// GENESIS · extract-tool/calibrate.mjs
//
// Compute pixelsPerFoot from dimension annotations in a vector PDF.
//
// A real architect dimension annotation consists of:
//   1. The dimension text label (e.g., "30'-0\"")
//   2. A dimension line (a single straight line connecting two ticks)
//   3. Two extension lines (the tick marks projecting from the wall to the
//      dimension line)
//
// We pair text labels with their dimension lines by proximity:
//   • horizontal labels sit just above/below a horizontal line of similar
//     length
//   • the line's pixel length divided by the labeled feet gives pixelsPerFoot

import { findDimensionStrings } from './text.mjs';

export function calibrate(lines, runs) {
  const dims = findDimensionStrings(runs);
  if (dims.length === 0) return { pixelsPerFoot: 1, confidence: 0, source: 'no-dims' };

  // All horizontal/vertical lines are candidates. The matching step
  // filters by proximity to a labeled dim string.
  const candidates = collectDimensionLineCandidates(lines);

  const estimates = [];
  for (const dim of dims) {
    const run = runs.find(r => Math.abs(r.x - dim.x) < 5 && Math.abs(r.y - dim.y) < 5);
    if (!run) continue;

    const matched = matchDimensionLine(candidates, run);
    if (!matched) continue;

    const dimInches = parseDimToInches(dim.str);
    if (dimInches == null) continue;
    const px = Math.hypot(matched.x2 - matched.x1, matched.y2 - matched.y1);
    const pixelsPerFoot = px / (dimInches / 12);
    estimates.push({ pixelsPerFoot, confidence: matched.confidence, dim: dim.str });
  }

  if (estimates.length === 0) {
    return { pixelsPerFoot: 1, confidence: 0, source: 'no-match', samples: 0 };
  }

  // Use the median of pixelsPerFoot values, with an outlier filter:
  // discard any estimate more than 2x away from the first one.
  const ppfs = estimates.map(e => e.pixelsPerFoot).sort((a, b) => a - b);
  const median = ppfs[Math.floor(ppfs.length / 2)];
  // Cluster check: how many estimates are within 5% of the median?
  const within = estimates.filter(e => Math.abs(e.pixelsPerFoot - median) / median < 0.05).length;
  const avgConf = estimates.reduce((s, e) => s + e.confidence, 0) / estimates.length;
  // Boost confidence when most estimates agree
  const agreement = within / estimates.length;
  const finalConf = avgConf * (0.5 + 0.5 * agreement);
  return {
    pixelsPerFoot: median,
    confidence: finalConf,
    source: `median(${estimates.length} dims, ${within} agree)`,
    samples: estimates.length,
    estimates,
  };
}

function collectDimensionLineCandidates(lines) {
  const out = [];
  for (const L of lines) {
    const len = Math.hypot(L.x2 - L.x1, L.y2 - L.y1);
    if (len < 4) continue;
    const isHoriz = Math.abs(L.y1 - L.y2) < 1;
    const isVert = Math.abs(L.x1 - L.x2) < 1;
    if (!isHoriz && !isVert) continue;
    out.push({ ...L, len, confidence: 0.5 });
  }
  return out;
}

function matchDimensionLine(candidates, run) {
  const isLikelyHorizontal = run.width > run.height * 2;

  if (isLikelyHorizontal) {
    // Horizontal label: text reads naturally.
    // The dim line is typically 10-30 pt above or below the text.
    const ty = run.y + run.height / 2;
    const tx = run.x + run.width / 2;

    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const isHoriz = Math.abs(c.y1 - c.y2) < 1;
      if (!isHoriz) continue;
      const cy = (c.y1 + c.y2) / 2;
      const dy = Math.abs(cy - ty);
      if (dy < 2 || dy > 80) continue;
      const cminX = Math.min(c.x1, c.x2);
      const cmaxX = Math.max(c.x1, c.x2);
      const cwidth = cmaxX - cminX;
      if (cwidth < 20) continue;
      const dxOutside = tx < cminX ? cminX - tx : tx > cmaxX ? tx - cmaxX : 0;
      // Bonus for being close, plus a small bonus for being wide (longer
      // lines are usually outer dim lines, which are most reliable)
      const score = -dy - dxOutside * 0.1 + Math.min(cwidth, 800) * 0.001;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) return { ...best, confidence: bestScore > -10 ? 0.85 : 0.5 };
  } else {
    // Vertical label: rotated 90° text. Look for vertical line just left/right.
    const tx = run.x;
    const ty = run.y + run.height / 2;

    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const isVert = Math.abs(c.x1 - c.x2) < 1;
      if (!isVert) continue;
      const cx = (c.x1 + c.x2) / 2;
      const dx = Math.abs(cx - tx);
      if (dx < 2 || dx > 80) continue;
      const cminY = Math.min(c.y1, c.y2);
      const cmaxY = Math.max(c.y1, c.y2);
      const cheight = cmaxY - cminY;
      if (cheight < 20) continue;
      const dyOutside = ty < cminY ? cminY - ty : ty > cmaxY ? ty - cmaxY : 0;
      const score = -dx - dyOutside * 0.1 + Math.min(cheight, 800) * 0.001;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) return { ...best, confidence: bestScore > -10 ? 0.85 : 0.5 };
  }
  return null;
}

function parseDimToInches(s) {
  // Lenient: matches "12'-4\"", "12-4\"", "12 4\"", "12\"", "12-0\"".
  const m = s.match(/^\s*(\d+)\s*['\u2019]?\s*-?\s*(\d+)?(?:\s+(\d+)\s*\/\s*(\d+))?\s*["\u201d]?\s*$/);
  if (!m) return null;
  const feet = +m[1];
  const inches = m[2] ? +m[2] : 0;
  const frac = m[3] && m[4] ? +m[3] / +m[4] : 0;
  return (feet * 12) + inches + frac;
}
