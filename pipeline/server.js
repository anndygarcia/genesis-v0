// Genesis async extraction pipeline server.
//
// API:
//   GET  /health                 — liveness
//   POST /api/extract            — multipart PDF upload, returns { job_id }
//   GET  /api/jobs/:id           — poll status, returns { status, plan?, error? }
//   GET  /api/jobs/:id/plan      — get final JSON plan
//
// Storage: SQLite at $DATA_DIR/jobs.db. PDF buffer stored on disk at
// $DATA_DIR/uploads/{job_id}.pdf. Final plan JSON stored at
// $DATA_DIR/plans/{job_id}.json.

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { v4 as uuid } from 'uuid';
import Database from 'better-sqlite3';
import { extractPdf } from './worker.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/var/data';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '50', 10);

// Ensure dirs
fsSync.mkdirSync(`${DATA_DIR}/uploads`, { recursive: true });
fsSync.mkdirSync(`${DATA_DIR}/plans`, { recursive: true });
fsSync.mkdirSync(`${DATA_DIR}/cache`, { recursive: true });

const db = new Database(`${DATA_DIR}/jobs.db`);
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    filename TEXT,
    file_size INTEGER,
    pages INTEGER,
    error TEXT,
    plan_path TEXT,
    options TEXT
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS job_logs (
    job_id TEXT,
    t INTEGER NOT NULL,
    level TEXT,
    msg TEXT,
    PRIMARY KEY (job_id, t)
  );
`);

const insertJob = db.prepare(`
  INSERT INTO jobs (id, status, created_at, filename, file_size, options)
  VALUES (?, 'queued', ?, ?, ?, ?)
`);
const updateJob = db.prepare(`
  UPDATE jobs SET status = ?, started_at = COALESCE(?, started_at),
    finished_at = ?, pages = ?, error = ?, plan_path = ?
  WHERE id = ?
`);
const insertLog = db.prepare(`
  INSERT INTO job_logs (job_id, t, level, msg) VALUES (?, ?, ?, ?)
`);
const selectJob = db.prepare(`SELECT * FROM jobs WHERE id = ?`);

// Log helper
function log(jobId, level, msg) {
  const t = Date.now();
  try { insertLog.run(jobId, t, level, msg); } catch {}
  console.log(`[${new Date(t).toISOString()}][${level}][${jobId?.slice(0, 8) || 'system'}] ${msg}`);
}

// Worker loop: process at most ONE job at a time (we're CPU-bound).
// This single-worker model is appropriate for the GPU-less Railway
// starter instance; for production we'd run a real job queue
// (BullMQ, RQ, etc.).
let workerBusy = false;
async function workerLoop() {
  while (true) {
    if (workerBusy) {
      await sleep(500);
      continue;
    }
    const next = db.prepare(
      `SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`
    ).get();
    if (!next) {
      await sleep(1000);
      continue;
    }
    workerBusy = true;
    runJob(next.id).catch(e => log(null, 'error', `workerLoop top-level: ${e.message}`))
                   .finally(() => { workerBusy = false; });
  }
}

async function runJob(jobId) {
  const job = selectJob.get(jobId);
  if (!job) return;
  updateJob.run('running', Date.now(), null, null, null, null, jobId);
  log(jobId, 'info', `starting extraction on ${job.filename} (${job.file_size} bytes)`);

  try {
    const pdfPath = `${DATA_DIR}/uploads/${jobId}.pdf`;
    const planPath = `${DATA_DIR}/plans/${jobId}.json`;
    const opts = JSON.parse(job.options || '{}');

    const t0 = Date.now();
    const result = await extractPdf(pdfPath, opts, (stage, msg) => log(jobId, stage, msg));
    const dt = Date.now() - t0;

    fsSync.writeFileSync(planPath, JSON.stringify(result.plan, null, 2));
    updateJob.run(
      'complete', null, Date.now(), result.plan.pages, null, planPath, jobId
    );
    log(jobId, 'info', `complete in ${dt} ms: ${result.plan.rooms?.length || 0} rooms, ${result.plan.doors?.length || 0} doors, ${result.plan.windows?.length || 0} windows`);
  } catch (e) {
    updateJob.run('failed', null, Date.now(), null, e.message, null, jobId);
    log(jobId, 'error', `failed: ${e.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// HTTP server
const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: `${DATA_DIR}/uploads`,
    filename: (req, file, cb) => cb(null, `${uuid()}.pdf`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname?.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error(`expected application/pdf, got ${file.mimetype}`));
    }
  },
});

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post('/api/extract', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  const id = path.basename(req.file.filename, '.pdf');
  const opts = JSON.stringify({
    onnxModelPath: process.env.ONNX_MODEL_PATH || '/app/models/walls-qdq-int8.onnx',
    raster: req.body.raster === 'true',
  });
  insertJob.run(id, Date.now(), req.file.originalname, req.file.size, opts);
  res.status(202).json({
    job_id: id,
    status: 'queued',
    poll_url: `/api/jobs/${id}`,
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = selectJob.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({
    id: job.id,
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    filename: job.filename,
    pages: job.pages,
    error: job.error,
    poll_url: `/api/jobs/${job.id}`,
  });
});

app.get('/api/jobs/:id/plan', (req, res) => {
  const job = selectJob.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.status !== 'complete') return res.status(409).json({ error: `job is ${job.status}` });
  if (!job.plan_path || !fsSync.existsSync(job.plan_path)) {
    return res.status(500).json({ error: 'plan_path missing' });
  }
  const data = JSON.parse(fsSync.readFileSync(job.plan_path, 'utf8'));
  res.json(data);
});

app.get('/api/jobs/:id/logs', (req, res) => {
  const rows = db.prepare(
    `SELECT t, level, msg FROM job_logs WHERE job_id = ? ORDER BY t`
  ).all(req.params.id);
  res.json({ logs: rows });
});

// Worker startup
workerLoop().catch(e => log(null, 'error', `workerLoop fatal: ${e.message}`));

app.listen(PORT, () => {
  log(null, 'info', `Genesis pipeline listening on :${PORT}`);
});