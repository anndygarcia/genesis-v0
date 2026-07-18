// Make a synthetic RASTER PDF — text and walls rendered as bitmap.
// We draw onto a canvas, then embed the PNG into a PDF page. This
// mimics what a real scanned blueprint looks like (no vector paths,
// no embedded text).

const { PDFDocument } = require('pdf-lib');
const { createCanvas } = require('canvas');
const fs = require('fs');

(async () => {
  // Build a canvas image that LOOKS like an architect floor plan.
  const W = 1600, H = 1200;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Title block (top-right corner)
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.strokeRect(W - 240, 20, 220, 80);
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = '#000';
  ctx.fillText('Sample Home Plan', W - 230, 50);
  ctx.font = '12px sans-serif';
  ctx.fillText('Plan #1 — 1,236 sq ft', W - 230, 75);

  // Outer walls — 5px thick
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#000';
  ctx.strokeRect(150, 150, 1300, 900);

  // Inner walls
  ctx.lineWidth = 3;
  // Vertical wall — splits house into Living (left) + Master (right)
  ctx.beginPath(); ctx.moveTo(800, 150); ctx.lineTo(800, 1050); ctx.stroke();
  // Horizontal wall — splits into front (north) + back (south)
  ctx.beginPath(); ctx.moveTo(150, 600); ctx.lineTo(800, 600); ctx.stroke();
  // Bedroom wall in master half
  ctx.beginPath(); ctx.moveTo(800, 500); ctx.lineTo(1450, 500); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(1100, 500); ctx.lineTo(1100, 1050); ctx.stroke();

  // Door gaps (just blank rectangles to suggest openings)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(700, 600, 100, 6);
  ctx.fillRect(800, 950, 6, 100);

  // Room labels
  ctx.fillStyle = '#000';
  ctx.font = '20px sans-serif';
  ctx.fillText('Living Room', 350, 380);
  ctx.fillText('Kitchen', 350, 800);
  ctx.fillText('Master Bed', 1050, 350);
  ctx.fillText('Bedroom 2', 1200, 800);
  ctx.fillText('Bathroom', 850, 720);
  ctx.font = '12px sans-serif';
  ctx.fillText('20\' × 16\'', 350, 410);
  ctx.fillText('16\' × 16\'', 350, 830);
  ctx.fillText('12\' × 16\'', 1050, 380);
  ctx.fillText('11\' × 12\'', 1200, 830);

  // Dimension strings (the OCR's calibration source)
  ctx.font = '14px sans-serif';
  ctx.fillText('50\'-0"', 700, 1075);
  ctx.fillText('32\'-0"', 50, 800);
  ctx.fillText('36\'-0"', 1450, 600);

  // Save as PNG
  const png = canvas.toBuffer('image/png');
  console.log('Generated canvas PNG:', png.length, 'bytes');

  // Embed PNG in PDF as a single page
  const pdf = await PDFDocument.create();
  const pngImage = await pdf.embedPng(png);
  const page = pdf.addPage([W, H]);
  page.drawImage(pngImage, { x: 0, y: 0, width: W, height: H });
  const bytes = await pdf.save();
  fs.writeFileSync('/tmp/raster-sample.pdf', bytes);
  console.log('Wrote /tmp/raster-sample.pdf:', bytes.length, 'bytes');
})();
