// =============================================================
//   GENESIS · v0
//   Procedural 3D home — Three.js single-file demo
//   6 rooms, 24 walls, gable roof, orbit + walk cameras
// =============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';

// Genesis state — single source of truth for house geometry.
// This module holds room/wall/door/window data + derivation helpers.
// `state.house.plan` is the canonical plan; `state.house.walls` the wall list,
// `state.stats` the derived counters. Everything below reads from these.
import { state, loadPlan, getRoom, getWall, getOpening, describe } from './state.js';
import { createTracer } from './tracer.js';
// Load the extract-tool browser module lazily — only when the user
// actually clicks the Extract 3D button. Avoids slowing down the
// initial page load.
async function loadExtractModule() {
  return import('./extract-tool/extract-browser.mjs');
}

// Async extraction: upload to backend pipeline, poll for status,
// return the final plan. Falls back to in-browser if the backend
// rejects / times out. Used by the upload UI when the backend
// is reachable; the in-browser path remains as a fallback.
async function runExtractAsync(file, dropText) {
  const t0 = performance.now();
  // 1. POST to /api/extract (CF Pages Function proxies to Railway)
  if (dropText) dropText.textContent = `Uploading ${file.name}…`;
  const fd = new FormData();
  fd.append('pdf', file, file.name);
  const uploadRes = await fetch('/api/extract', { method: 'POST', body: fd });
  if (!uploadRes.ok) {
    throw new Error(`upload failed: HTTP ${uploadRes.status}`);
  }
  const { job_id } = await uploadRes.json();
  if (dropText) dropText.textContent = `Job ${job_id.slice(0, 8)} queued — extracting on the server…`;

  // 2. Poll status every 2s
  const POLL_MS = 2000;
  const MAX_MS = 600_000;  // 10-minute ceiling
  let elapsed = 0;
  while (elapsed < MAX_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));
    elapsed = performance.now() - t0;
    const pollRes = await fetch(`/api/extract?id=${job_id}`);
    if (!pollRes.ok) {
      throw new Error(`poll failed: HTTP ${pollRes.status}`);
    }
    const status = await pollRes.json();
    if (status.status === 'complete') {
      if (dropText) dropText.textContent = `✓ Extracted in ${(elapsed / 1000).toFixed(1)}s — fetching plan…`;
      const planRes = await fetch(`/api/extract?plan=1&id=${job_id}`);
      if (!planRes.ok) throw new Error(`plan fetch failed: HTTP ${planRes.status}`);
      return await planRes.json();
    }
    if (status.status === 'failed') {
      throw new Error(`pipeline failed: ${status.error || 'unknown'}`);
    }
    // Still queued or running — show progress
    const dot = '.'.repeat((Math.floor(elapsed / 2000) % 3) + 1);
    if (dropText) dropText.textContent =
      `${status.status} ${dot} (${(elapsed / 1000).toFixed(0)}s)`;
  }
  throw new Error(`pipeline timed out after ${(elapsed / 1000).toFixed(0)}s`);
}

// Apply a finalized plan to the 3D viewer. Used by both the async
// and local pipelines.
function applyPlan(plan, file) {
  const dropText = document.getElementById('drop-text');
  const overlay = document.getElementById('drop-overlay');
  try {
    window.GENESIS.loadPlan(plan);
  } catch (e) {
    console.error('loadPlan failed', e);
    if (dropText) dropText.textContent = `Load failed: ${e.message}`;
    setTimeout(() => overlay?.classList.add('hidden'), 1800);
    return;
  }
  document.getElementById('demo-title').textContent =
    `${plan.name || file.name} · Plan #${plan.planNumber || 1} (server-extracted)`;
  const clearBtn = document.getElementById('btn-clear-plan');
  if (clearBtn) clearBtn.classList.remove('hidden');
  setTimeout(() => overlay?.classList.add('hidden'), 900);
}

// Try-sample-plan button. Bundles a small raster PDF as base64 so the
// user can verify the extract pipeline without finding a file. The PDF
// decodes to a 6-room plan; the Yytsi model detects ~3 rooms + 2 doors
// + 1 window correctly.
// Try-garcia-plan — runs the extract pipeline on the Garcia
// Residence.pdf served from /api/garcia-pdf (CF Pages Function
// proxying the GH raw URL). Useful for live model validation
// against a real 2-story American architectural plan.
async function runGarciaDemo() {
  console.log('[demo] runGarciaDemo: starting');
  const dropText = document.getElementById('drop-text');
  if (dropText) dropText.textContent = 'Loading Garcia Residence.pdf…';
  let buf;
  try {
    const res = await fetch('/api/garcia-pdf');
    if (!res.ok) throw new Error(`Garcia PDF HTTP ${res.status}`);
    buf = await res.arrayBuffer();
    console.log('[demo] Garcia bytes:', buf.byteLength);
  } catch (e) {
    console.error('[demo] Garcia fetch failed:', e.message);
    if (dropText) dropText.textContent = `Garcia load failed: ${e.message}`;
    return;
  }
  if (dropText) dropText.textContent =
    `Garcia loaded (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB) — extracting…`;
  const file = new File([buf], 'Garcia Residence.pdf', { type: 'application/pdf' });
  await runExtract(file);
}
window.runGarciaDemo = runGarciaDemo;

async function runExtractDemo() {
  console.log('[demo] runExtractDemo: starting');
  let fixture;
  try {
    fixture = await import('./extract-tool/test-fixtures/raster-sample.b64.js');
    console.log('[demo] fixture loaded');
  } catch (e) {
    console.warn('[demo] raster-sample.b64.js missing — falling back to sample-plan.json', e);
    const r = await fetch('assets/sample-plan.json');
    const plan = await r.json();
    window.GENESIS.loadPlan(plan);
    return;
  }
  const bytes = fixture.rasterSamplePdfBytes();
  console.log('[demo] bytes:', bytes.length);
  // Wrap in a File and dispatch through the existing pipeline.
  const file = new File([bytes], 'sample-house.pdf', { type: 'application/pdf' });
  console.log('[demo] calling runExtract()');
  await runExtract(file);
  console.log('[demo] complete');
}
// Expose for console/devtools access and integration testing.
window.runExtractDemo = runExtractDemo;

// Open the Extract 3D pipeline: take a PDF (vector OR raster), produce
// a plan JSON, and load it into the 3D viewer. The browser side of
// the pipeline runs entirely client-side — no server roundtrip.
//
// Pipeline:
//   1. PDF.js loads the file
//   2. detectPdfKind() decides vector vs raster
//   3a. Vector path: walk constructPath ops + text runs + calibrate
//   3b. Raster path: render page to canvas + tesseract.js OCR + edge
//       detection (or YOLO when available) + calibrate
//   4. fuse.mjs groups walls into rooms, attaches labels
//   5. window.GENESIS.loadPlan(plan) rebuilds the 3D scene
async function openExtract() {
  // Pick a file via a hidden <input> rather than relying on the existing
  // pdf-input (which only does 2D overlay).
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,application/pdf';
  input.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    await runExtract(file);
  }, { once: true });
  input.click();
}

async function runExtract(file) {
  const overlay = document.getElementById('drop-overlay');
  const dropText = document.getElementById('drop-text');
  overlay?.classList.remove('hidden');
  if (dropText) dropText.textContent = `Extracting 3D from ${file.name}…`;

  // Async pipeline preferred when available — uploads to backend,
  // polls for status, doesn't block the UI for 30+ seconds.
  if (window.location.hostname !== 'localhost' && !window.location.search.includes('nobackend')) {
    try {
      const result = await runExtractAsync(file, dropText);
      applyPlan(result, file);
      return;
    } catch (e) {
      console.warn('[extract] async pipeline unavailable, falling back to in-browser:', e.message);
      if (dropText) dropText.textContent = `Async pipeline failed (${e.message}); running locally…`;
    }
  }

  // Local fallback: in-browser pipeline (works without backend,
  // but blocks the UI for 10-30s on multi-page PDFs).
  const t0 = performance.now();
  try {
    // Load pipeline modules lazily (only when the user actually uses it).
    // pdfjs 3.11 only ships pdf.js (UMD) on jsdelivr's flat tree — the
    // .mjs path doesn't exist for that version. Pin to 4.x which
    // delivers a proper ESM build, and pull both the lib + worker from
    // the same CDN.
    const [
      browserModule,
      pdfjsModule,
    ] = await Promise.all([
      loadExtractModule(),
      import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs'),
    ]);
    const pdfjsLib = pdfjsModule;
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';

    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const kind = await browserModule.detectPdfKind(page, pdfjsLib);
    if (dropText) dropText.textContent = `Extracting 3D — ${kind} PDF detected…`;

    let result;
    if (kind === 'vector') {
      result = await browserModule.extractPlanFromPdfPage(pdfjsLib, page, { fileName: file.name });
    } else {
      // Render page to canvas at 2×, then run OCR + detect
      const targetWidthPx = Math.min(2200, window.devicePixelRatio > 1 ? 1800 : 1500);
      const viewport = page.getViewport({ scale: 1 });
      const scale = targetWidthPx / viewport.width;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      result = await browserModule.extractPlanFromRasterCanvas(canvas, { fileName: file.name });
    }

    const plan = result.plan;
    const dt = performance.now() - t0;
    if (dropText) dropText.textContent =
      `✓ ${plan.rooms.length} rooms extracted in ${(dt / 1000).toFixed(1)}s (${kind})`;
    applyPlan(plan, file);
  } catch (err) {
    console.error('Extract failed', err);
    if (dropText) dropText.textContent = `Extract failed: ${err.message}`;
    setTimeout(() => overlay?.classList.add('hidden'), 2200);
  }
}

// Genesis v0.5 — PBR materials, HDR env, shadows + SSAO, procedural trim,
// measurement tool, estimator, GLB export.

// ------------------------------------------------------------
//   FLOOR PLAN DATA
//   Units: feet. Origin (0,0) = SW corner of the home.
// ------------------------------------------------------------
const WALL_H = 9;                   // ceiling height (ft)
const WALL_T = 0.5;                 // wall thickness (ft)  — 6" nominal
const FLOOR_T = 0.4;                // slab thickness
const ROOF_PITCH = 6;               // gable rise (ft) over half-span

// Rooms are axis-aligned rectangles defined by [x, z, w, d] in feet
// Centered around a 40×46 ft footprint
// Same shape as before — see ./state.js for the canonical DEMO_PLAN.
// To swap a new home in: `loadPlan(newPlan)` then re-render via `GENESIS.rebuild()`.
const ROOMS = state.house.plan.rooms;
const DOORS = state.house.plan.doors;
const WINDOWS = state.house.plan.windows;

const FOOTPRINT_W = 46;             // x: 0..46
const FOOTPRINT_D = 30;             // z: 0..30

// Doors: [wallStartX, wallStartZ, width, axis 'x'|'z', facing 'outer'|'inner']
// Note: ROOMS/DOORS/WINDOWS data is canonical in state.js. The constants
// below (const ROOMS = state.house.plan.rooms; etc.) read from there.
// The legacy ROOMS/DOORS/WINDOWS hard-coded arrays were deleted with
// the v1.0 data-driven refactor; the buildHouse() function creates the
// 3D meshes from the plan data.

// (Old hard-coded DOORS array removed — see state.js:DEMO_PLAN.doors)

// (Old hard-coded WINDOWS array removed — see state.js:DEMO_PLAN.windows)

// ------------------------------------------------------------
//   STATS (computed below but written into HUD)
// ------------------------------------------------------------
// HUD initial values — pulled from state.stats (the canonical, derived counter).
// state.stats is recomputed by loadPlan() and stays in sync across plan changes.
document.getElementById('stat-rooms').textContent = state.stats.roomCount;
document.getElementById('stat-sqft').textContent  = state.stats.floorAreaSqFt.toLocaleString();
document.getElementById('stat-walls').textContent = state.stats.interiorWalls + state.stats.exteriorWalls;
// Legacy alias — `STATS` is referenced deeper in this file as `STATS.totalSqFt`.
const STATS = { totalSqFt: state.stats.floorAreaSqFt, wallCount: state.stats.interiorWalls + state.stats.exteriorWalls };

// ------------------------------------------------------------
//   THREE.JS SETUP
// ------------------------------------------------------------
const canvas = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101722);
scene.fog = new THREE.Fog(0x101722, 60, 180);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
// High isometric: distance ~50 (was 35) so the whole 46×30 house fits in view.
camera.position.set(50, 42, 58);
camera.lookAt(23, 4, 15);

// Fit camera distance to the plan's bounding box so any size home —
// from a 30'-square cottage to a 100'-wide mansion — frames correctly.
// Called from rebuildSceneFromPlan() after a new plan loads.
function fitCameraToPlan(plan) {
  if (!plan || !plan.footprint) return;
  const fp = plan.footprint;
  const cx = fp.w / 2;
  const cz = fp.d / 2;
  const maxDim = Math.max(fp.w, fp.d);
  // Distance to fit: 1.6× the longest side at the camera's 50° FOV.
  // Adds headroom for 2-story buildings (assumed ~12 ft max h).
  const dist = Math.max(45, maxDim * 1.6);
  const target = new THREE.Vector3(cx, 4, cz);
  camera.position.set(cx + dist * 0.55, dist * 0.62, cz + dist * 0.65);
  camera.lookAt(target);
  // orbit controls module declared further down — check window.GENESIS too
  const orb = window.GENESIS?.orbit;
  if (orb && typeof orb.update === 'function') orb.update();
  if (renderer) renderer.render(scene, camera);
}

// =============================================================
//   HOUSE GROUP — every mesh that's rebuildable (walls, floors,
//   doors, windows, foundation, porch, patio, roof, labels) is
//   added to this group instead of `scene` directly. Swapping a
//   plan is then: dispose the group + build a new one.
//   Static scenery (ground, sky, lights, post-processing) stays
//   on `scene`.
// =============================================================
const houseGroup = new THREE.Group();
houseGroup.name = 'house';
scene.add(houseGroup);

// =============================================================
//   SCENE REBUILD — tear down and rebuild the house around
//   the current state.house.plan. Called once at startup (the
//   demo plan) and every time a new plan is loaded via
//   GENESIS.loadPlan(plan) or a JSON drag-and-drop.
// =============================================================

/**
 * Dispose the contents of `houseGroup` (every child mesh, every
 * material, every geometry) and reset the interaction registries.
 * Safe to call when the group is empty.
 */
function disposeHouse() {
  // Recursively dispose every descendant of houseGroup
  houseGroup.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      // CSS2DObject has userData with the room id; its `.element`
      // is a DOM node we leave to CSS2DRenderer to manage.
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => m.dispose());
    }
  });
  // Remove children
  while (houseGroup.children.length) {
    houseGroup.remove(houseGroup.children[0]);
  }
  // Reset registries so measurement / estimator don't keep pointing at dead meshes
  INTERACTABLE.length = 0;
  WALL_MESHES.length = 0;
}

/**
 * Build a scene from a plan. Mutates state.house.plan (the caller
 * passes a validated plan), and rebuilds every dynamic mesh inside
 * houseGroup. Synchronous. Safe to call repeatedly.
 *
 * @param {object} plan validated plan (state.house.plan)
 * @returns {object} summary of what was built
 */
// Build house from a plan. v1.4+ supports multiple floors (plan.floors[])
// where each floor becomes its own sub-group at y=elevation. The topmost
// floor receives the roof; lower floors get a deck (no roof).
//
// Backwards-compat: if plan.floors is absent, treat all rooms as a
// single ground floor (current behavior).
function buildHouse(plan) {
  disposeHouse();
  if (!plan || !Array.isArray(plan.rooms)) return { ok: false, error: 'plan missing rooms' };

  // Normalize floors: if plan has no floors[] entry, use ground floor
  // containing every room (so existing callers keep working).
  const floors = (plan.floors && plan.floors.length)
    ? plan.floors
    : [{ name: 'Ground', rooms: plan.rooms.map(r => r.id), elevation: 0 }];

  // Build a room-id → room lookup
  const roomById = {};
  for (const r of plan.rooms) roomById[r.id] = r;

  // For each floor:
  //   1. Pick rooms belonging to that floor
  //   2. Compute a footprint from those rooms' extents
  //   3. Build a sub-group at y=elevation
  //   4. Add floor meshes, walls, doors, windows to the sub-group
  //   5. Topmost floor also gets the roof
  const fp = plan.footprint || { w: 46, d: 30 };
  const WALL_T_LOCAL = 0.5;

  for (let floorIdx = 0; floorIdx < floors.length; floorIdx++) {
    const f = floors[floorIdx];
    const elevation = Number(f.elevation) || 0;
    const floorRooms = f.rooms.map(rid => roomById[rid]).filter(Boolean);
    if (!floorRooms.length) continue;

    // Create a sub-group for this floor
    const floorGroup = new THREE.Group();
    floorGroup.name = `floor-${floorIdx}`;
    floorGroup.position.set(0, elevation, 0);
    floorGroup.userData = {
      kind: 'floor-group',
      floorName: f.name,
      floorIndex: floorIdx,
      elevation,
      roomIds: floorRooms.map(r => r.id),
    };
    houseGroup.add(floorGroup);

    // Compute this floor's footprint from its rooms.
    // For the ground floor, prefer plan.footprint (the architectural outer
    // rectangle); for upper floors, derive from the rooms.
    let floorFp;
    if (floorIdx === 0 && plan.footprint) {
      floorFp = plan.footprint;
    } else {
      let fxMax = 0, fzMax = 0;
      for (const r of floorRooms) {
        if (r.x + r.w > fxMax) fxMax = r.x + r.w;
        if (r.z + r.d > fzMax) fzMax = r.z + r.d;
      }
      floorFp = { w: fxMax, d: fzMax };
    }

    // ---- Per-floor slab (the deck you walk on) ----
    if (floorIdx === 0) {
      // Ground slab is the foundation concrete
      const slabGeo = new THREE.BoxGeometry(floorFp.w, 0.4, floorFp.d);
      const slab = new THREE.Mesh(slabGeo, slabMat);
      slab.position.set(floorFp.w / 2, elevation + 0.2, floorFp.d / 2);
      slab.castShadow = true;
      slab.receiveShadow = true;
      slab.userData = { kind: 'slab', footprint: floorFp };
      floorGroup.add(slab);
    } else {
      // Upper floors: deck (thin board-like panel)
      const deckGeo = new THREE.BoxGeometry(floorFp.w, 0.4, floorFp.d);
      const deckMat = new THREE.MeshStandardMaterial({
        map: floorForRoom(floorRooms[0]).map,
        color: 0x8d6e63,
        roughness: 0.85,
        metalness: 0,
        side: THREE.FrontSide,
      });
      const deck = new THREE.Mesh(deckGeo, deckMat);
      deck.position.set(floorFp.w / 2, elevation + 0.2, floorFp.d / 2);
      deck.castShadow = true;
      deck.receiveShadow = true;
      deck.userData = { kind: 'floor-deck', floorIndex: floorIdx, footprint: floorFp };
      floorGroup.add(deck);
    }

    // ---- Per-room floor tiles (skip stair rooms — they get stairs) ----
    floorRooms.forEach(room => {
      if (room.kind === 'stairs') {
        // Stairs: build parametric staircase that connects this floor
        // up to the next-floor elevation.
        const stair = buildStairs(room, elevation);
        floorGroup.add(stair);
        // Label still appears for navigation (already added below)
        return;
      }
      const flGeo = new THREE.BoxGeometry(room.w, 0.05, room.d);
      const flMat = floorForRoom(room);
      const fl = new THREE.Mesh(flGeo, flMat);
      fl.position.set(room.x + room.w / 2, elevation + 0.45, room.z + room.d / 2);
      fl.userData = { kind: 'floor', roomId: room.id, floorIndex: floorIdx };
      floorGroup.add(fl);
    });

    // ---- Outer walls (per-floor) ----
    // Each room can declare which of its sides have NO wall via
    //   noWalls: ['n','s','e','w']
    // where the side names are the room's own sides (so a room at
    // z=0 with noWalls: ['n'] means no wall on its northern edge).
    // The perimeter wall on a side of the building is built only
    // when at least one room on that perimeter side does NOT close it
    // (i.e. is open: true or noWalls includes that side).
    const closes = (side) => floorRooms.some(r =>
      side === 'n' ? (r.z === 0 && !r.open && !r.noWalls.includes('n')) :
      side === 's' ? (r.z + r.d === floorFp.d && !r.open && !r.noWalls.includes('s')) :
      side === 'w' ? (r.x === 0 && !r.open && !r.noWalls.includes('w')) :
      /* side === 'e' */   (r.x + r.w === floorFp.w && !r.open && !r.noWalls.includes('e'))
    );
    if (closes('n')) { const m = addOuterWallOnGroup(plan, 0, 0, floorFp.w, WALL_T_LOCAL, 's', elevation); if (m) floorGroup.add(m); }
    if (closes('s')) { const m = addOuterWallOnGroup(plan, 0, floorFp.d - WALL_T_LOCAL, floorFp.w, WALL_T_LOCAL, 'n', elevation); if (m) floorGroup.add(m); }
    if (closes('w')) { const m = addOuterWallOnGroup(plan, 0, 0, WALL_T_LOCAL, floorFp.d, 'w', elevation); if (m) floorGroup.add(m); }
    if (closes('e')) { const m = addOuterWallOnGroup(plan, floorFp.w - WALL_T_LOCAL, 0, WALL_T_LOCAL, floorFp.d, 'e', elevation); if (m) floorGroup.add(m); }

    // ---- Interior walls (from canonical derivation, filtered to this floor) ----
    for (const w of state.house.interiorWalls) {
      if (!w.rooms || !w.rooms.some(rid => floorRooms.some(r => r.id === rid))) continue;
      const wallMesh = addInnerWallOnGroup(w, elevation);
      if (wallMesh) floorGroup.add(wallMesh);
    }

    // ---- Doors & Windows — only on this floor's openings ----
    const floorDoors = plan.doors.filter(d => floorRooms.some(r => r.id === d.host) || (floorIdx === 0 && !d.host));
    const floorWindows = plan.windows.filter(w => floorRooms.some(r => r.id === w.host) || (floorIdx === 0 && !w.host));
    floorDoors.forEach(d => {
      const hostWall = findHostWall(d);
      const wallH = hostWall?.height || 9;
      const doorMesh = addDoorOnGroup(d, wallH + elevation);
      if (doorMesh) floorGroup.add(doorMesh);
    });
    floorWindows.forEach(w => {
      const hostWall = findHostWall(w);
      const wallH = hostWall?.height || 9;
      const winMesh = addWindowOnGroup(w, wallH + elevation);
      if (winMesh) floorGroup.add(winMesh);
    });

    // ---- Roof on TOPMOST floor only ----
    if (floorIdx === floors.length - 1) {
      const roof = buildRoof(plan, elevation, floorRooms);
      floorGroup.add(roof);
    }

    // ---- Labels for this floor's rooms ----
    floorRooms.forEach(room => {
      const obj = makeLabel(room);
      // Position the label at floor's elevation level
      obj.position.set(room.x + room.w / 2, elevation + 0.1, room.z + room.d / 2);
      floorGroup.add(obj);
    });
  }

  // ---- Foundation assets (porch / patio / driveway / sidewalk) ----
  // These belong to the ground floor in the rendering order and stay on
  // the global houseGroup so they share elevation=0 alignment.
  rebuildFoundationAssets(plan);

  return {
    ok: true,
    floorCount: floors.length,
    floorNames: floors.map((f, i) => `${i}:${f.name}`),
    roomCount: plan.rooms.length,
    roofOverFloor: floors.length - 1,
  };
}

// ----- Internal helpers (small shims that wrap the existing constructors) -----
//
// v1.4 update: helpers now take an `elevation` (the y offset for the
// floor they sit on) and return the mesh. Caller decides which
// sub-group receives it. Default elevation = 0 keeps backwards compat
// for any code that calls without the extra arg.

function addOuterWallOnGroup(plan, x, z, w, d, side, elevation = 0) {
  const mat = wallMat;
  // Outer wall height computed from three sources (highest wins):
  //   1. plan.wallOverrides?.[side]   — explicit caller override
  //   2. max h of any room on the inside of that wall side
  //   3. plan.footprint.wallH         — global default (typically 9 or 10)
  const hPlan = plan?.footprint?.wallH || 9;
  const overrides = plan?.wallOverrides || {};
  let ht = hPlan;
  if (overrides[side] && Number(overrides[side]) > ht) ht = Number(overrides[side]);
  if (Array.isArray(plan?.rooms)) {
    const D = plan.footprint?.d || 0, W = plan.footprint?.w || 0;
    for (const r of plan.rooms) {
      const rh = r.h || 9;
      if (
        (r.z === 0 && side === 's' && rh > ht) ||
        (r.z + r.d === D && side === 'n' && rh > ht) ||
        (r.x === 0 && side === 'w' && rh > ht) ||
        (r.x + r.w === W && side === 'e' && rh > ht)
      ) ht = rh;
    }
  }
  const geo = new THREE.BoxGeometry(w, ht, d);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x + w / 2, elevation + ht / 2, z + d / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `wall-outer-${side}`;
  mesh.userData = {
    kind: 'wall', isOuter: true,
    length: Math.max(w, d),
    height: ht, area: Math.max(w, d) * ht * 2,
    ax: x, az: z, aw: w, ad: d, side,
    elevation,
    rooms: [],
  };
  WALL_MESHES.push(mesh);
  INTERACTABLE.push(mesh);
  return mesh;
}

function addInnerWallOnGroup(w, elevation = 0) {
  // w is { id, length, axis, side, x, z, rooms, height }
  const mat = wallMatInterior;
  const wThick = 0.5;
  const wHt = w.height || 9;
  let geo, posX, posZ;
  if (w.axis === 'x') {
    geo = new THREE.BoxGeometry(w.length, wHt, wThick);
    posX = w.x + w.length / 2;
    posZ = w.z + wThick / 2;
  } else {
    geo = new THREE.BoxGeometry(wThick, wHt, w.length);
    posX = w.x + wThick / 2;
    posZ = w.z + w.length / 2;
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(posX, elevation + wHt / 2, posZ);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = w.id;
  mesh.userData = {
    kind: 'wall', isOuter: false,
    length: w.length, height: wHt, area: w.length * wHt * 2,
    rooms: w.rooms,
    id: w.id, axis: w.axis,
  };
  WALL_MESHES.push(mesh);
  INTERACTABLE.push(mesh);
  return mesh;
}

// door / window helpers — minimal placeholders for v0.10.
// v0.11 will port the full addDoor / addWindow visuals onto the plan-driven path.
// Find the host wall for a door or window by matching its position
// against the derived walls. Door/window coordinates are {x,z,w,axis}
// in same coordinates as walls. Used so the door position lines up
// with the actual wall height (a 22ft two-story vs a 9ft bedroom).
function findHostWall(opening) {
  // Wall geometry: a wall with axis='z' runs ALONG the z axis (so w.length is
  // measured in z; w.x is its x-position; w.z is its starting z). An
  // opening with axis='z' lives on a wall that runs along z — so the
  // opening's x should match the wall's x, and the opening's z lies
  // inside [w.z, w.z + w.length]. Same logic mirrored for axis='x'.
  const all = [
    ...(state.house.walls || []),            // outer walls
    ...(state.house.interiorWalls || []),    // interior walls
  ];
  for (const w of all) {
    if (w.axis !== opening.axis) continue;
    if (opening.axis === 'z') {
      if (Math.abs(w.x - opening.x) < 0.5 &&
          opening.z >= w.z - 0.5 && opening.z <= w.z + w.length + 0.5) {
        return w;
      }
    } else {  // axis === 'x'
      if (Math.abs(w.z - opening.z) < 0.5 &&
          opening.x >= w.x - 0.5 && opening.x <= w.x + w.length + 0.5) {
        return w;
      }
    }
  }
  return null;
}

function addDoorOnGroup(d, h, elevation = 0) {
  // Create a simple black-plane proxy for now. The full addDoor has many
  // sub-meshes (frame, plank, etc.); porting those is the next slice.
  // h is the wall height; door is 8ft tall starting from the floor.
  const doorH = 8;
  const proxy = new THREE.Mesh(
    new THREE.PlaneGeometry(d.w, doorH),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, metalness: 0.0, side: THREE.DoubleSide })
  );
  if (d.axis === 'z') {
    proxy.position.set(d.x + d.w / 2, elevation + doorH / 2, d.z);
    proxy.rotation.y = Math.PI / 2;
  } else {
    proxy.position.set(d.x, elevation + doorH / 2, d.z + d.w / 2);
  }
  proxy.userData = { kind: 'door', id: d.id, label: d.label, elevation };
  proxy.name = `door-${d.id}`;
  INTERACTABLE.push(proxy);
  return proxy;
}

function addWindowOnGroup(wd, h, elevation = 0) {
  // Window is 3ft tall, sits at 4ft sill height (architectural convention).
  const winH = 3;
  const sillH = 4;
  const proxy = new THREE.Mesh(
    new THREE.PlaneGeometry(wd.w, winH),
    new THREE.MeshPhysicalMaterial({
      color: 0x9ed5ff, roughness: 0.05, metalness: 0.1,
      transmission: 0.7, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide,
    }),
  );
  if (wd.axis === 'z') {
    proxy.position.set(wd.x + wd.w / 2, elevation + sillH + winH / 2, wd.z);
    proxy.rotation.y = Math.PI / 2;
  } else {
    proxy.position.set(wd.x, elevation + sillH + winH / 2, wd.z + wd.w / 2);
  }
  proxy.userData = { kind: 'window', id: wd.id, label: wd.label, elevation };
  proxy.name = `window-${wd.id}`;
  INTERACTABLE.push(proxy);
  return proxy;
}

// Foundation assets — for v0.10 we rebuild a tiny version (foundation
// strip + porch + driveway) from the plan, sized to the new footprint.
// v0.11 ports the full procedural asset library (ASSET_PLACEMENTS rules).
function rebuildFoundationAssets(plan) {
  const fp = plan.footprint;
  // Simple foundation strip
  const foundationGeo = new THREE.BoxGeometry(fp.w + 1, 1.0, fp.d + 1);
  const foundation = new THREE.Mesh(foundationGeo, new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.95 }));
  foundation.position.set(fp.w / 2, -0.4, fp.d / 2);
  foundation.userData = { kind: 'foundation' };
  houseGroup.add(foundation);
}

// The original init code below used to construct everything inline at
// module-eval. Now `buildHouse()` does it from a plan. To keep visual
// continuity with the v0.10 look, the original detailed constructors
// still fire below; the FIRST rebuild call replaces them with the
// plan-driven version. After that, the originals remain inert
// (their meshes were never added to the scene — see substitution above).
//
// We delegate the first build to the canonical `buildHouse(state.house.plan)`
// call below the post-processing + UI section.

// 2D label renderer (for room labels in 3D)
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(1, 1); // will be resized
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.left = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
canvas.parentElement.appendChild(labelRenderer.domElement);

// ------------------------------------------------------------
//   INTERACTABLES — meshes the user can click for measurement
// ------------------------------------------------------------
const INTERACTABLE = [];
const WALL_MESHES = [];

// ------------------------------------------------------------
//   LIGHTING
// ------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0xc9d8ff, 0x202830, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff4d6, 1.6);
sun.position.set(30, 50, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 80;
sun.shadow.camera.top = 50;
sun.shadow.camera.bottom = -10;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 200;
sun.shadow.bias = -0.0005;
sun.shadow.radius = 4;                    // soft shadows
scene.add(sun);

const fillLight = new THREE.DirectionalLight(0x88aaff, 0.35);
fillLight.position.set(-30, 20, -10);
scene.add(fillLight);

// ------------------------------------------------------------
//   HDR ENVIRONMENT — RoomEnvironment via PMREMGenerator
//   This is a real PBR environment, NOT a flat color. It drives
//   reflections, indirect light, and adds realism to every material.
// ------------------------------------------------------------
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envRT = pmrem.fromScene(new RoomEnvironment(renderer), 0.04);
scene.environment = envRT.texture;
// Note: NOT setting scene.background — we keep the dark sky for the demo look

// ------------------------------------------------------------
//   POST-PROCESSING — SSAO for ambient occlusion + outline for
//   measurement hover/select highlights
// ------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.setSize(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const ssaoPass = new SSAOPass(scene, camera, canvas.parentElement.clientWidth, canvas.parentElement.clientHeight);
ssaoPass.kernelRadius = 16;       // wider sampling
ssaoPass.minDistance = 0.001;
ssaoPass.maxDistance = 0.1;       // wider falloff so corners darken visibly
ssaoPass.output = SSAOPass.OUTPUT.Default;
composer.addPass(ssaoPass);

const outlinePass = new OutlinePass(
  new THREE.Vector2(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight),
  scene, camera
);
outlinePass.edgeStrength = 6;
outlinePass.edgeThickness = 1.5;
outlinePass.edgeGlow = 0.4;
outlinePass.visibleEdgeColor.set('#00d4ff');  // cyan accent matching brand
outlinePass.hiddenEdgeColor.set('#003344');
composer.addPass(outlinePass);

const outputPass = new OutputPass();
composer.addPass(outputPass);

// ------------------------------------------------------------
//   GROUND
// ------------------------------------------------------------
const groundY = -FLOOR_T;
const groundGeo = new THREE.PlaneGeometry(400, 400);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x0d1219, roughness: 0.95, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.set(20, groundY - 0.01, 15);
ground.receiveShadow = true;
scene.add(ground);

// Subtle grass texture proxy: dark with a tiny noise overlay (procedural)
{
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a2a18'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = ['#2a3a25','#1e2d1c','#243620'][i%3];
    ctx.fillRect(Math.random()*256, Math.random()*256, 1+Math.random()*1.5, 1+Math.random()*1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 40);
  ground.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 1.0, metalness: 0.0 });
}

// ------------------------------------------------------------
//   SLAB / FLOOR
// ------------------------------------------------------------
// Procedural concrete texture: noise-based so it doesn't look like a flat color
function makeConcreteTexture(size = 512) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  // base
  ctx.fillStyle = '#b8b3a8'; ctx.fillRect(0, 0, size, size);
  // stains / variation
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = Math.random() * 1.4;
    const a = Math.random() * 0.18;
    ctx.fillStyle = `rgba(${80 + Math.random()*60},${76 + Math.random()*50},${60 + Math.random()*40},${a})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  }
  // hairline crack-like lines
  ctx.strokeStyle = 'rgba(40,38,32,0.18)';
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 80; i++) {
    ctx.beginPath();
    ctx.moveTo(Math.random()*size, Math.random()*size);
    ctx.lineTo(Math.random()*size, Math.random()*size);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const concreteTex = makeConcreteTexture(512);
const slabMat = new THREE.MeshStandardMaterial({
  map: concreteTex,
  roughness: 0.92,
  metalness: 0.02,
  envMapIntensity: 0.4,
});
// Procedural wood-floor texture (planks)
function makeWoodTexture(w = 256, h = 256) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#a87742'; ctx.fillRect(0, 0, w, h);
  const plank = 32;
  for (let py = 0; py < h; py += plank) {
    for (let px = 0; px < w; px += plank) {
      const xOff = (py / plank) % 2 ? plank/2 : 0;  // stagger
      ctx.fillStyle = `rgba(${130 + Math.random()*40}, ${88 + Math.random()*30}, ${50 + Math.random()*20}, 0.6)`;
      ctx.fillRect(px + xOff, py, plank - 1, plank - 1);
      // grain
      ctx.strokeStyle = `rgba(60, 38, 18, 0.18)`;
      for (let g = 0; g < 5; g++) {
        ctx.beginPath();
        ctx.moveTo(px + xOff, py + Math.random() * plank);
        ctx.lineTo(px + xOff + plank, py + Math.random() * plank);
        ctx.stroke();
      }
      // seam
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath(); ctx.moveTo(px + xOff + plank, py);
      ctx.lineTo(px + xOff + plank, py + plank); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px + xOff, py + plank);
      ctx.lineTo(px + xOff + plank, py + plank); ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const woodTex = makeWoodTexture();

// Procedural tile texture (12" squares)
function makeTileTexture(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8e4dc'; ctx.fillRect(0, 0, size, size);
  const tile = 64;
  for (let py = 0; py < size; py += tile) {
    for (let px = 0; px < size; px += tile) {
      ctx.fillStyle = `rgba(${200 + Math.random()*30},${194 + Math.random()*30},${180 + Math.random()*30},0.9)`;
      ctx.fillRect(px + 2, py + 2, tile - 4, tile - 4);
      ctx.strokeStyle = 'rgba(120,110,90,0.45)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 2, py + 2, tile - 4, tile - 4);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const tileTex = makeTileTexture();

// Procedural carpet (soft, low-frequency)
function makeCarpetTexture(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c2a787'; ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 8000; i++) {
    ctx.fillStyle = `rgba(${180 + Math.random()*30},${150 + Math.random()*30},${110 + Math.random()*30},0.7)`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const carpetTex = makeCarpetTexture();

// ---------------------------------------------------------------
// Stairs — generate a parametric straight-flight staircase. Each
// stair "room" in the plan (`rooms[].kind === 'stairs'`) becomes
// a series of step meshes rising from elevation=elevation to
// elevation+room.toElevation. The stair volume also gets side
// stringers + simple post-and-rail handrails.
//
// Parameters (in room):
//   kind:        'stairs'
//   riserFt:     height of one step (default 0.625 ft = 7.5 in, IRC)
//   treadFt:     depth of one step (default 0.917 ft = 11 in, IRC)
//   toElevation: where the stair stops (e.g. 10 for floor-2 deck)
//   direction:   'x+' | 'x-' | 'z+' | 'z-' (which way the steps run)
//
// Returns a THREE.Group containing all steps + stringers.
// ---------------------------------------------------------------
function buildStairs(room, elevation = 0) {
  const riserFt = Number(room.riserFt) || 0.625;          // 7.5"
  const treadFt = Number(room.treadFt) || 0.917;          // 11"
  const toElev = Number(room.toElevation) || elevation + 10;
  const direction = room.direction || 'z+';
  const totalRise = Math.max(0.01, toElev - elevation);
  const nRisers = Math.max(1, Math.ceil(totalRise / riserFt));
  const actualRiser = totalRise / nRisers;
  const nTreads = nRisers;                  // standard: n-1 treads between n risers, plus a landing
  const runFt = nTreads * treadFt;
  // Direction vectors
  const isAlong = direction[0] === 'z';
  const lengthFt = isAlong ? room.d : room.w;
  const widthFt = isAlong ? room.w : room.d;
  const sign = direction.endsWith('+') ? 1 : -1;

  const grp = new THREE.Group();
  grp.name = room.id;
  grp.userData = {
    kind: 'stairs',
    roomId: room.id,
    nRisers, nTreads,
    toElevation: toElev,
    riserFt: actualRiser,
    treadFt,
    direction,
  };

  const stepMat = new THREE.MeshStandardMaterial({
    map: woodTex.clone(),
    color: 0x8d6e63,
    roughness: 0.78,
    metalness: 0,
  });
  const stringerMat = new THREE.MeshStandardMaterial({
    color: 0x5d4037,
    roughness: 0.6,
    metalness: 0,
    envMapIntensity: 0.4,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x4a4a4a,
    roughness: 0.4,
    metalness: 0.6,
  });

  // Scale the stair to fit the room footprint if smaller than ideal.
  // Otherwise it just stays within the room. We never scale UP past 1.0
  // because steps should be standard residential.
  const scaleFactor = Math.min(1.0, lengthFt / runFt);

  // Body of stair: place steps on a line along (lengthFt * direction)
  for (let i = 0; i < nTreads; i++) {
    const offset = i * treadFt * scaleFactor;
    const stepX = (isAlong ? offset : 0) * sign;
    const stepZ = (isAlong ? 0 : offset) * sign;
    const stepWidth = (isAlong ? widthFt : widthFt) - 0.2; // slight margin
    const stepDepth = treadFt * scaleFactor;
    const stepRise = actualRiser;
    const treadGeo = new THREE.BoxGeometry(
      isAlong ? stepDepth : stepWidth,
      stepRise,
      isAlong ? stepWidth : stepDepth,
    );
    const tread = new THREE.Mesh(treadGeo, stepMat);
    tread.position.set(
      room.x + (isAlong ? room.w / 2 : stepWidth / 2 + 0.1) + stepX,
      elevation + actualRiser * i + actualRiser / 2,
      room.z + (isAlong ? stepWidth / 2 + 0.1 : room.d / 2) + stepZ,
    );
    tread.castShadow = true;
    tread.receiveShadow = true;
    tread.userData = {
      kind: 'stair-tread', roomId: room.id, stepIndex: i,
    };
    INTERACTABLE.push(tread);
    grp.add(tread);
  }

  // Stringers — diagonal sloped panels under the stair, on both sides
  for (const side of [-1, 1]) {
    const stringerGeo = new THREE.BoxGeometry(0.2, 0.2, runFt + 1);
    const stringer = new THREE.Mesh(stringerGeo, stringerMat);
    // Position each stringer along the long axis
    stringer.position.set(
      isAlong ? room.x + room.w / 2 : room.x + (room.w / 2 + 0.2 * side),
      elevation + totalRise / 2,
      isAlong ? room.z + (room.d / 2 + 0.2 * side) : room.z + room.d / 2,
    );
    if (isAlong) stringer.rotation.x = -Math.atan2(actualRiser, treadFt * scaleFactor) * sign;
    else         stringer.rotation.z = Math.atan2(actualRiser, treadFt * scaleFactor) * sign;
    stringer.castShadow = true;
    stringer.receiveShadow = true;
    stringer.userData = { kind: 'stair-stringer', roomId: room.id };
    grp.add(stringer);
  }

  // Landings — small flat tile at top + bottom
  const landMat = new THREE.MeshStandardMaterial({
    map: woodTex.clone(),
    color: 0x8d6e63,
    roughness: 0.7,
  });
  // Bottom landing (already covered by floor, but a thicker slab helps visually)
  const land0 = new THREE.Mesh(
    new THREE.BoxGeometry(
      isAlong ? 1 : widthFt,
      0.1,
      isAlong ? widthFt : 1,
    ),
    landMat,
  );
  land0.position.set(
    room.x + (isAlong ? room.w / 2 : room.w / 2),
    elevation + 0.05,
    room.z + (isAlong ? room.d / 2 : room.d / 2),
  );
  land0.receiveShadow = true;
  grp.add(land0);
  // Top landing (the deck edge)
  const landTop = land0.clone();
  landTop.position.set(
    room.x + (isAlong ? room.w / 2 : room.w / 2),
    elevation + totalRise + 0.05,
    room.z + (isAlong ? room.d / 2 : room.d / 2),
  );
  landTop.receiveShadow = true;
  grp.add(landTop);

  // Handrails — simple post-and-rail on both sides
  const railHeight = 3.0;          // ft, above the stair
  const postSpacing = 5;           // ft, one post every N steps
  const bottomY = elevation;
  for (const side of [-1, 1]) {
    // Posts
    for (let p = 0; p <= nTreads; p += postSpacing) {
      const offX = (isAlong ? p * treadFt * scaleFactor : 0) * sign;
      const offZ = (isAlong ? 0 : p * treadFt * scaleFactor) * sign;
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, railHeight, 0.15),
        railMat,
      );
      post.position.set(
        room.x + (isAlong ? room.w / 2 : widthFt / 2 + 0.5) + offX + (isAlong ? 0 : side * 0.6),
        bottomY + railHeight / 2,
        room.z + (isAlong ? widthFt / 2 + 0.5 : room.d / 2) + offZ + (isAlong ? side * 0.6 : 0),
      );
      post.castShadow = true;
      grp.add(post);
    }
    // Rail (a sloped box from bottom to top)
    const railGeo = new THREE.BoxGeometry(
      isAlong ? runFt + 1 : 0.15,
      0.1,
      isAlong ? 0.15 : runFt + 1,
    );
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.set(
      room.x + (isAlong ? room.w / 2 : widthFt / 2 + 0.5) + (runFt * sign) / 2,
      bottomY + totalRise + railHeight,
      room.z + (isAlong ? widthFt / 2 + 0.5 : room.d / 2) + (isAlong ? side * 0.6 : (runFt * sign) / 2),
    );
    if (isAlong) rail.rotation.x = -Math.atan2(actualRiser, treadFt * scaleFactor) * sign;
    else         rail.rotation.z = Math.atan2(actualRiser, treadFt * scaleFactor) * sign;
    rail.castShadow = true;
    grp.add(rail);
  }

  return grp;
}

// Per-room floor material — keep the colors VIBRANT (the room-color tiles
// are the strongest visual identity of this demo), but use PBR so reflections
// from the HDR envmap show through, and SSAO darkens the corners.
// Per-room floor material — TEXTURE + COLOR
// Patterns: living = wood, kitchen/bath = tile, bedrooms = carpet
// Each texture is grayscale so that multiplying by `room.color`
// preserves the room's distinctive accent color.
function floorForRoom(room) {
  const map = woodTex.clone();
  let roughness = 0.7, metalness = 0.0, envI = 0.4, repeat;

  if (room.id === 'master' || room.id === 'bed2' || room.id === 'bed3') {
    map.image = carpetTex.image;       // share source canvas
    roughness = 0.96;
    envI = 0.25;
    repeat = [4, 4];
  } else if (room.id === 'kitchen') {
    map.image = tileTex.image;
    roughness = 0.55;
    metalness = 0.05;
    envI = 0.7;
    repeat = [3, 3];
  } else if (room.id === 'bath') {
    map.image = tileTex.image;
    roughness = 0.5;
    metalness = 0.05;
    envI = 0.6;
    repeat = [2, 2];
  } else {
    repeat = [Math.max(1, Math.round(room.w / 6)), Math.max(1, Math.round(room.d / 6))];
  }

  map.needsUpdate = true;
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(repeat[0], repeat[1]);

  return new THREE.MeshStandardMaterial({
    map,
    color: room.color,
    roughness,
    metalness,
    envMapIntensity: envI,
  });
}

// Procedural sheetrock texture (cross-hatched so it reads as wall, not as
// solid plastic) — used for the wallMat / wallMatInterior materials.
function makeSheetrockTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  // base
  ctx.fillStyle = '#e6dfd0'; ctx.fillRect(0, 0, size, size);
  // subtle paper grain
  for (let i = 0; i < 1200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = Math.random() * 0.08;
    ctx.fillStyle = `rgba(${150 + Math.random()*40},${130 + Math.random()*40},${110 + Math.random()*40},${a})`;
    ctx.beginPath();
    ctx.arc(x, y, Math.random() * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Wall materials — shared between outer / interior walls. Both are
// sheetrock; differentiation comes from UV tiling and a tiny color shift.
const sheetrockTex = makeSheetrockTexture();
// Procedural shingle texture (3-tab asphalt, dark, matte). Used as the
// gable roof material so the roof reads as architectural, not as a flat
// shaded plane. Wraps symmetrically (RepeatWrapping) over both slopes.
function makeShingleTexture(w = 512, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  // base (medium brown weatherwood — visible against dark navy bg)
  ctx.fillStyle = '#6b4a30'; ctx.fillRect(0, 0, w, h);
  // horizontal shingle pattern — bands of slightly different brown
  const band = 18;
  for (let y = 0; y < h; y += band) {
    const r = 40 + Math.random() * 25;
    const g = 28 + Math.random() * 14;
    const b = 18 + Math.random() * 10;
    ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
    ctx.fillRect(0, y, w, band - 2);
    // slight offset horizontal stamp
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, y + band - 2, w, 1);
    // random granules
    for (let i = 0; i < 80; i++) {
      ctx.fillStyle = `rgba(${20 + Math.random()*40},${15 + Math.random()*30},${10 + Math.random()*20},${Math.random()*0.5})`;
      ctx.fillRect(Math.random() * w, y + Math.random() * band, 2, 1);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}
const shingleTex = makeShingleTexture();
// Room label helper — CSS2DObject that floats above the room at floor level.
// Each label is registered in the module-level `roomLabels` array so callers
// (e.g. the show-label default toggle) can iterate without traversing.
// v0.11 will replace the markup with richer HTML (icons, hover details).
const roomLabels = [];
function makeLabel(room) {
  const el = document.createElement('div');
  el.className = 'room-label';
  el.innerHTML = `<span class="rl-name">${room.name}</span><span class="rl-area">${room.w * room.d} sq ft</span>`;
  const obj = new CSS2DObject(el);
  obj.position.set(room.x + room.w / 2, 0.1, room.z + room.d / 2);
  obj.userData.roomId = room.id;
  roomLabels.push(obj);
  return obj;
}

const wallMat = new THREE.MeshStandardMaterial({
  map: sheetrockTex.clone(),
  color: 0xe6dfd0,
  roughness: 0.95,
  metalness: 0.0,
  envMapIntensity: 0.25,
});
const wallMatInterior = new THREE.MeshStandardMaterial({
  map: sheetrockTex.clone(),
  color: 0xf3eadd,
  roughness: 0.95,
  metalness: 0.0,
  envMapIntensity: 0.2,
});

//   ───────────────────────────────────────────────────────────────
//   The big inline construction block that used to live here
//   (slab → floors → walls → foundation assets → doors → windows
//   → ceiling → gable roof → room-box furniture → labels)
//   was deleted. With state.js + buildHouse(plan) in place,
//   the scene is built from data. The original ~740 lines were
//   preserved at /tmp/app_old_block.bak during this refactor in
//   case v0.11 wants to port any specific detail (e.g. the full
//   ASSET_PLACEMENTS rules, the textured gable roof) onto the
//   plan-driven path.
//   ───────────────────────────────────────────────────────────────

// Roof — built once per plan inside buildHouse(). The actual meshes go
// under houseGroup; we keep two module-level references that the rest of
// the codebase reads:
//   • roofArea       — total roof surface area (sq ft), updated by buildHouse
//   • roofPitchRise  — gable pitch in feet (rise over half-span)
// computeEstimate() reads roofArea to price shingles; buildOpenings
// reads it for the quantity-takeoff panel.
//
// v1.3: now treats rooms listed in plan.roofOpenRooms as holes
// (no roof geometry above their footprint). The roof becomes a
// mosaic of planar slabs that wraps the rest of the footprint.
// The volume above an open room stays open — visible from outside.
// In the Garcia residence, the dining + foyer are open rooms
// (22ft ceilings) so the roof skips a rectangle above them,
// creating a visible atrium / two-story volume.
let roofArea = 0;
let roofPitchRise = ROOF_PITCH;
function buildRoof(plan, elevation = 0, floorRooms = null) {
  const fp = plan.footprint || { w: 46, d: 30 };
  const w = fp.w, d = fp.d;
  const halfSpan = w / 2;
  const ridgeY = ROOF_PITCH;     // additional rise above wall top
  // Wall-top for this floor = max ceiling height of its rooms (default 9).
  // v2.x will allow per-segment per-side heights.
  let floorWallH = WALL_H;
  if (Array.isArray(floorRooms) && floorRooms.length) {
    for (const r of floorRooms) if ((r.h || 0) > floorWallH) floorWallH = r.h;
    // But don't take 22ft opening ceilings into account — only capped at 11
    // so the roof stays sensible.
    if (floorWallH > 11) floorWallH = 10;
  }
  const wallTop = floorWallH + elevation;  // walls stop at this y (this floor)

  // Build the set of "open rectangles" that the roof should NOT cover.
  // A room is "open" (no roof above it) when ANY of these is true:
  //   • it's listed in plan.roofOpenRooms (explicit two-story volumes)
  //   • its h is 0 or absent               (outdoor patios, courtyards)
  const openSet = new Set(Array.isArray(plan.roofOpenRooms) ? plan.roofOpenRooms : []);
  const openRects = (plan.rooms || [])
    .filter(r => openSet.has(r.id) || (!r.h || r.h <= 0))
    .map(r => ({ x: r.x, z: r.z, w: r.w, d: r.d, id: r.id }));

  // Slab the roof footprint into rectangles that exclude open
  // rectangles. Each covered rectangle becomes a 2-slope gable
  // "panel" of width (W2), pitch ROOF_PITCH. For v1.3 we keep
  // the simple shared-ridge geometry per panel.
  // v1.4 will fold these into a single indexed mesh with proper UV
  // joins.
  const panels = splitFootprintByOpenRects(0, 0, w, d, openRects);

  const slopeMat = new THREE.MeshStandardMaterial({
    map: shingleTex,
    color: 0x9e6b3f,
    roughness: 0.78,
    metalness: 0,
    envMapIntensity: 0.7,
    side: THREE.DoubleSide,
  });
  const gableMat = new THREE.MeshStandardMaterial({
    map: sheetrockTex.clone(),
    color: 0xebe0d0,
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0.3,
  });

  const group = new THREE.Group();
  let totalArea = 0;
  for (const p of panels) {
    const W2 = p.w, D2 = p.d;
    const hs = W2 / 2;
    const verts = new Float32Array([
      // WEST slope (rising)
      0,        wallTop, 0,
      hs,       wallTop + ridgeY, 0,
      hs,       wallTop + ridgeY, D2,
      0,        wallTop, D2,
      // EAST slope (descending)
      hs,       wallTop + ridgeY, 0,
      W2,       wallTop, 0,
      W2,       wallTop, D2,
      hs,       wallTop + ridgeY, D2,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex([0,1,2, 0,2,3, 4,5,6, 4,6,7]);
    geo.computeVertexNormals();
    const slopes = new THREE.Mesh(geo, slopeMat);
    slopes.position.set(p.x, 0, p.z);
    slopes.castShadow = true;
    slopes.receiveShadow = true;
    group.add(slopes);

    // Each panel's south + north gable triangles (skip if the panel
    // is on the building's south or north edge — those gables are
    // already on the perimeter).
    if (p.z !== 0) {
      const a = new Float32Array([0, wallTop, 0, W2, wallTop, 0, hs, wallTop + ridgeY, 0]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(a, 3));
      g.setIndex([0, 1, 2, 0, 2, 1]);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, gableMat);
      m.position.set(p.x, 0, p.z);
      group.add(m);
    }
    if (p.z + p.d !== d) {
      const a = new Float32Array([0, wallTop, D2, W2, wallTop, D2, hs, wallTop + ridgeY, D2]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(a, 3));
      g.setIndex([0, 1, 2, 0, 2, 1]);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, gableMat);
      m.position.set(p.x, 0, p.z);
      group.add(m);
    }
    totalArea += 2 * D2 * Math.sqrt(hs * hs + ridgeY * ridgeY);
  }

  group.name = 'roof';
  group.userData = {
    kind: 'roof',
    area: totalArea,
    pitchRise: ridgeY,
    pitchRun: halfSpan,
    panelCount: panels.length,
    openRectCount: openRects.length,
  };
  roofArea = totalArea;
  roofPitchRise = ridgeY;
  return group;
}

// Subdivide the footprint rectangle into a list of "covered" panels
// that don't overlap any of the openRect rectangles. The algorithm
// finds all OPEN strips along Z (and X for any leftover holes, not
// yet implemented for v1.3) and produces a flat list of rectangular
// panels.
//   1. Collect all open rows: sort unique [z, z+d] intervals from
//      every openRect.
//   2. Walk the Z-axis from z0..z0+D, skipping band ranges that fall
//      inside any open row.
//   3. For each non-open band, split along X for any openRect that
//      falls inside that band (a single split per band suffices
//      because Garcia has only one open column on the north strip).
//
// Backwards-compat: when openRects is empty, returns a single full
// panel covering [x0..W, z0..D].
function splitFootprintByOpenRects(x0, z0, W, D, openRects) {
  if (!openRects.length) return [{ x: x0, z: z0, w: W, d: D }];

  // 1) Gather all z-rows from openRects (sorted unique)
  const zRows = new Set([z0, z0 + D]);     // start/end of footprint
  for (const o of openRects) {
    if (o.z > z0)         zRows.add(o.z);             // start of open
    if (o.z + o.d < z0 + D) zRows.add(o.z + o.d);     // end of open
  }
  const zSorted = [...zRows].sort((a, b) => a - b);

  const panels = [];
  // 2) Walk consecutive Z-band pairs (always produces a covered strip)
  for (let i = 0; i + 1 < zSorted.length; i++) {
    const zLo = zSorted[i];
    const zHi = zSorted[i + 1];
    if (zHi <= zLo) continue;
    // Sample midband Z to decide whether this band is covered or not
    const midZ = (zLo + zHi) / 2;
    const hereOpens = openRects.filter(o => midZ > o.z && midZ < o.z + o.d);
    if (!hereOpens.length) {
      panels.push({ x: x0, z: zLo, w: W, d: zHi - zLo });
      continue;
    }
    // 3) Subdivide the band along X — emit covered segments between
    // consecutive x-cuts (where the midpoint isn't inside an open).
    const xCuts = new Set([x0, x0 + W]);
    for (const o of hereOpens) {
      xCuts.add(Math.max(x0, o.x));
      xCuts.add(Math.min(x0 + W, o.x + o.w));
    }
    const xSorted = [...xCuts].sort((a, b) => a - b);
    for (let j = 0; j + 1 < xSorted.length; j++) {
      const xLo = xSorted[j];
      const xHi = xSorted[j + 1];
      if (xHi <= xLo) continue;
      const midX = (xLo + xHi) / 2;
      const inside = hereOpens.some(o => midX > o.x && midX < o.x + o.w);
      if (!inside) {
        panels.push({ x: xLo, z: zLo, w: xHi - xLo, d: zHi - zLo });
      }
    }
  }
  return panels;
}

// Placeholder for legacy reference in computeEstimate() (foundation/porch/
// patio/driveway/sidewalk areas). v0.10 only models the foundation strip.
// v0.11 will port the full ASSET_PLACEMENTS rules back as configurable
// settings the user can edit per plan.
const ASSET_PLACEMENTS = [];

// Build the initial scene from the demo plan. This single call sets up
// every dynamic mesh inside houseGroup. Future loadPlan(plan) swaps it
// out via GENESIS.loadPlan() (which calls this same function internally).
buildHouse(state.house.plan);

// ------------------------------------------------------------
//   CONTROLS — orbit vs. walk
// ------------------------------------------------------------
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(23, 6, 15);  // slightly above foundation so the whole house sits in front of the camera
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 6;
orbit.maxDistance = 90;
orbit.maxPolarAngle = Math.PI / 2 - 0.02;

// Walk-mode state
const walkState = {
  active: false,
  pos: new THREE.Vector3(0, 5.5, 5), // eye height start near front entry
  vel: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  keys: {},
  lookSens: 0.0025,
  moveSpeed: 12,  // ft / s
};

const keysW = ['w','a','s','d','W','A','S','D','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
window.addEventListener('keydown', e => {
  if (!walkState.active) return;
  walkState.keys[e.key] = true;
  if (e.key === 'Escape') exitWalk();
});
window.addEventListener('keyup', e => {
  walkState.keys[e.key] = false;
});

canvas.addEventListener('click', () => {
  if (walkState.active) canvas.requestPointerLock();
});

// Pointer-lock look
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  walkState.yaw   -= e.movementX * walkState.lookSens;
  walkState.pitch -= e.movementY * walkState.lookSens;
  walkState.pitch = Math.max(-Math.PI/2 + 0.05, Math.min(Math.PI/2 - 0.05, walkState.pitch));
});

// Entry position near front door
walkState.pos.set(6, 5.5, 7);

// Mode buttons
const btnOrbit = document.getElementById('btn-orbit');
const btnWalk = document.getElementById('btn-walk');
const btnReset = document.getElementById('btn-reset');
const helpOrbit = document.getElementById('viewer-help');
const helpWalk = document.getElementById('viewer-help-walk');

function enterOrbit() {
  walkState.active = false;
  document.exitPointerLock();
  orbit.enabled = true;
  // Re-aim at the house — high 3/4 isometric (back to v0.1 view, but
  // farther out so the whole 46×30 house fits in the viewport).
  orbit.target.set(23, 6, 15);
  camera.position.set(50, 42, 58);
  btnOrbit.classList.add('active'); btnWalk.classList.remove('active');
  helpOrbit.classList.remove('hidden'); helpWalk.classList.add('hidden');
}
function enterWalk() {
  orbit.enabled = false;
  walkState.active = true;
  walkState.pos.set(6, 5.5, 7); // near front entry
  walkState.yaw = Math.PI;       // facing north (into the house)
  walkState.pitch = -0.05;
  btnWalk.classList.add('active'); btnOrbit.classList.remove('active');
  helpOrbit.classList.add('hidden'); helpWalk.classList.remove('hidden');
}
function exitWalk() { enterOrbit(); }
btnOrbit.addEventListener('click', enterOrbit);
btnWalk.addEventListener('click', enterWalk);
btnReset.addEventListener('click', () => {
  if (walkState.active) enterWalk();
  else enterOrbit();
});

// Show room labels by default
roomLabels.forEach(l => l.visible = true);

// ------------------------------------------------------------
//   ROOM INFO PANEL — populate
// ------------------------------------------------------------
const roomsList = document.getElementById('rooms-list');
ROOMS.sort((a, b) => (b.w * b.d) - (a.w * a.d)).forEach(room => {
  const li = document.createElement('li');
  li.className = 'room-row';
  li.innerHTML = `
    <span class="rr-swatch" style="background:${room.color === 0xfff3e6 ? '#fff3e6' :
      room.color === 0xe6f4ff ? '#e6f4ff' :
      room.color === 0xf3e8ff ? '#f3e8ff' :
      '#e0f7fa'}"></span>
    <div class="rr-text">
      <strong>${room.name}</strong>
      <span>${room.w}' × ${room.d}' · ${(room.w * room.d).toLocaleString()} sq ft</span>
    </div>
  `;
  li.addEventListener('mouseenter', () => { walkState.pos.set(room.x + room.w/2, 5.5, room.z + room.d/2); });
  roomsList.appendChild(li);
});

const openingsList = document.getElementById('openings-list');
function buildOpeningsList(plan) {
  if (!openingsList) return;
  const doors = plan.doors.map(d => ({ ...d, kind: d.kind || 'exterior' }));
  const windows = plan.windows.map(w => ({ ...w, kind: 'window' }));
  openingsList.innerHTML = [...doors, ...windows].map(o => {
    const isDoor = o.kind === 'exterior' || o.kind === 'interior';
    return `
    <li class="op-row">
      <span class="op-icon">${isDoor ? '🚪' : '🪟'}</span>
      <div class="op-text">
        <strong>${o.label}</strong>
        <span>${o.w}' wide · ${isDoor ? o.kind : 'window'}</span>
      </div>
    </li>`;
  }).join('');
}
buildOpeningsList(state.house.plan);

// ------------------------------------------------------------
//   RESIZE
// ------------------------------------------------------------
function resize() {
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  ssaoPass.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

// ------------------------------------------------------------
//   MEASUREMENT TOOL + ESTIMATOR + GLB EXPORT
// ------------------------------------------------------------
// Click any wall, floor, roof, door, or window to see live measurements.
// The element gets a cyan outline (OutlinePass), and a small panel
// at top-right of the viewer shows the read-out.

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoverTarget = null;
let selectedTarget = null;
const measurePanel = document.getElementById('measure-panel');
const measureTitle = document.getElementById('measure-title');
const measureStats = document.getElementById('measure-stats');
const measureHint = document.getElementById('measure-hint');

function setPointerFromEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
}

function describeTarget(mesh) {
  const u = mesh.userData;
  if (!u || !u.kind) return null;

  if (u.kind === 'wall') {
    const rows = [
      ['Length',  `${u.length.toFixed(1)} ft`],
      ['Height',  `${u.height.toFixed(1)} ft`],
      ['Both sides area', `${u.area.toFixed(0)} sq ft`],
    ];
    if (u.isOuter) {
      rows.push(['Siding', `~${u.area.toFixed(0)} sq ft (HardiePlank installed)`]);
      rows.push(['Sheathing', `~${(u.length * u.height).toFixed(0)} sq ft OSB (4×8 sheets: ${Math.ceil((u.length * u.height) / 32)})`]);
    } else {
      rows.push(['Drywall', `~${(u.area * 0.95).toFixed(0)} sq ft (2 sides)`]);
      if (u.rooms) {
        const roomNames = u.rooms.map(id => ROOMS.find(r => r.id === id)?.name).filter(Boolean);
        rows.push(['Divides', roomNames.join(' · ')]);
      }
    }
    return {
      title: u.isOuter ? 'Exterior Wall' : 'Interior Wall',
      rows,
    };
  }
  if (u.kind === 'floor') {
    const room = ROOMS.find(r => r.id === u.roomId);
    return {
      title: `Floor — ${room?.name || 'Room'}`,
      rows: [
        ['Dimensions', `${room?.w}' × ${room?.d}'`],
        ['Area', `${(room?.w * room?.d).toFixed(0)} sq ft`],
        ['Flooring', `${room?.id === 'kitchen' || room?.id === 'bath' ? 'Tile' : room?.id?.startsWith('bed') || room?.id === 'master' ? 'Carpet' : 'Wood'}`],
      ],
    };
  }
  if (u.kind === 'roof') {
    const pitch = u.pitchRise / u.pitchRun;
    const pitchRatio = `${u.pitchRise}\"/${u.pitchRun * 12}\"  (~${(pitch * 12).toFixed(1)}:12)`;
    return {
      title: 'Roof',
      rows: [
        ['Total area', `${u.area.toFixed(0)} sq ft`],
        ['Pitch', pitchRatio],
        ['Squares (10×10)', `${(u.area / 100).toFixed(1)}`],
        ['Shingles (bundles)', `${Math.ceil(u.area / 33.33)}`],
      ],
    };
  }
  if (u.kind === 'door') {
    return {
      title: `Door — ${u.label}`,
      rows: [
        ['Width',  `${u.w}' (${(u.w * 12).toFixed(0)}")`],
        ['Height', '7\' 0" (typical interior)'],
        ['Type',   u.kind === 'exterior' ? 'Exterior' : 'Interior'],
        ['Frame',  `~${(u.w * 2 + 14).toFixed(1)} ft lumber`],
      ],
    };
  }
  if (u.kind === 'window') {
    return {
      title: `Window — ${u.label}`,
      rows: [
        ['Width',  `${u.w}' (${(u.w * 12).toFixed(0)}")`],
        ['Height', '4\' 0"'],
        ['Glass area', `${(u.w * 4).toFixed(1)} sq ft`],
      ],
    };
  }
  return null;
}

function showMeasureFor(mesh) {
  const info = describeTarget(mesh);
  if (!info) return;
  measurePanel.classList.add('visible');
  measureTitle.textContent = info.title;
  measureStats.innerHTML = info.rows.map(([k, v]) =>
    `<div class="mp-row"><span>${k}</span><strong>${v}</strong></div>`
  ).join('');
}

function hideMeasure() {
  if (!selectedTarget) {
    measurePanel.classList.remove('visible');
  }
}

// Hover highlighting (works in orbit mode only)
canvas.addEventListener('pointermove', (ev) => {
  if (walkState.active) return;
  setPointerFromEvent(ev);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(INTERACTABLE, true);
  const mesh = hits[0]?.object;
  if (mesh !== hoverTarget) {
    hoverTarget = mesh;
    updateOutline();
  }
});

canvas.addEventListener('click', (ev) => {
  if (walkState.active) return;
  setPointerFromEvent(ev);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(INTERACTABLE, true);
  if (hits.length === 0) {
    selectedTarget = null;
    outlinePass.selectedObjects = [];
    measurePanel.classList.remove('visible');
    return;
  }
  selectedTarget = hits[0].object;
  updateOutline();
  showMeasureFor(selectedTarget);
});

function updateOutline() {
  const targets = [];
  if (selectedTarget) targets.push(selectedTarget);
  else if (hoverTarget) targets.push(hoverTarget);
  outlinePass.selectedObjects = targets;
}

// ------------------------------------------------------------
//   ESTIMATOR — recompute when the scene loads (could rebuild on edits)
// ------------------------------------------------------------
function computeEstimate() {
  const totalFloorSqFt = ROOMS.reduce((s, r) => s + r.w * r.d, 0);
  const totalWallArea = WALL_MESHES.reduce((s, w) => s + w.userData.area, 0);
  const interiorWallArea = WALL_MESHES
    .filter(w => !w.userData.isOuter)
    .reduce((s, w) => s + w.userData.area, 0);
  const exteriorWallArea = WALL_MESHES
    .filter(w => w.userData.isOuter)
    .reduce((s, w) => s + w.userData.area, 0);
  // roofArea is a module-level let, updated by buildRoof() each rebuild.
  // Falls back to 1.1 × footprint area if for some reason the roof
  // wasn't built (shouldn't happen in normal flow).
  const raftArea = roofArea || (state.house.plan.footprint.w * state.house.plan.footprint.d) * 1.15;

  // Industry rules of thumb:
  //   Drywall: 4x8 sheet = 32 sqft, $15-25/sheet
  //   Paint: ~175 sqft finished wall area per gallon (2 coats)
  //   Framing: 2x4 @ 16" OC, plate + studs ≈ 4.5 BF per sqft interior wall
  //   Shingles: 3 bundles per square (100 sqft), $35-50/bundle
  //   Concrete slab: avg $5/sqft installed in Houston (Tx)
  const drywallSqFt = interiorWallArea;
  const drywallSheets = Math.ceil(drywallSqFt / 32);
  const paintGallons = Math.ceil(drywallSqFt / 175);
  const lumberBF = Math.round(interiorWallArea * 4.5);
  const roofSquares = raftArea / 100;
  const shingleBundles = Math.ceil(roofSquares * 3);

  // New placements (Section 10)
  const foundationArea = ASSET_PLACEMENTS.find(a => a.kind === 'foundation')?.area || 0;
  const porchArea = ASSET_PLACEMENTS.find(a => a.kind === 'porch')?.area || 0;
  const patioArea = ASSET_PLACEMENTS.find(a => a.kind === 'patio')?.area || 0;
  const drivewayArea = ASSET_PLACEMENTS.find(a => a.kind === 'driveway')?.area || 0;
  const sidewalkArea = ASSET_PLACEMENTS.find(a => a.kind === 'sidewalk')?.area || 0;

  // Siding / trim for exterior walls (HardiePlank typical: $5/sqft installed)
  const sidingSqFt = exteriorWallArea;

  // Cost ranges (Texas/Houston 2026 mid-range)
  const cost = {
    drywall:  Math.round(drywallSheets * 22),
    paint:    Math.round(paintGallons * 45),
    lumber:   Math.round(lumberBF * 1.10),
    shingles: Math.round(shingleBundles * 42),
    slab:     Math.round(totalFloorSqFt * 5),
    // Section 10 costs
    siding:   Math.round(sidingSqFt * 5),
    driveway: Math.round(drivewayArea * 6),
    sidewalk: Math.round(sidewalkArea * 7),
    patio:    Math.round(patioArea * 4),
    porch:    Math.round(porchArea * 25),     // porch includes rail/footers
    foundation: Math.round(foundationArea * 8),
  };
  cost.total = Object.values(cost).reduce((s, v) => s + v, 0);

  return {
    totalFloorSqFt,
    totalWallArea,
    interiorWallArea,
    exteriorWallArea,
    roofArea: raftArea,
    sidingSqFt,
    foundationArea,
    porchArea,
    patioArea,
    drivewayArea,
    sidewalkArea,
    drywallSqFt,
    drywallSheets,
    paintGallons,
    lumberBF,
    roofSquares,
    shingleBundles,
    cost,
  };
}
// Recompute whenever the plan changes; cache the value at module init for
// the initial fillEstimate() call.
let ESTIMATE = computeEstimate();
function recomputeEstimate() {
  ESTIMATE = computeEstimate();
  fillEstimate();
}

// Populate the estimator panel — reads from a 1-shot cache. After a plan
// change, call recomputeEstimate() (or rebuildSceneFromPlan()) to refresh.
function fillEstimate() {
  const e = ESTIMATE;
  const $ = id => document.getElementById(id);
  $('est-floor').textContent     = `${e.totalFloorSqFt.toLocaleString()} sq ft`;
  $('est-wall').textContent      = `${e.totalWallArea.toFixed(0)} sq ft`;
  $('est-wall-int').textContent  = `${e.interiorWallArea.toFixed(0)} sq ft`;
  $('est-wall-ext').textContent  = `${e.exteriorWallArea.toFixed(0)} sq ft`;
  $('est-roof').textContent      = `${e.roofArea.toFixed(0)} sq ft`;
  $('est-foundation').textContent = `${e.foundationArea.toFixed(0)} sq ft`;
  $('est-porch').textContent     = `${e.porchArea.toFixed(0)} sq ft`;
  $('est-patio').textContent     = `${e.patioArea.toFixed(0)} sq ft`;
  $('est-driveway').textContent  = `${e.drivewayArea.toFixed(0)} sq ft`;
  $('est-sidewalk').textContent  = `${e.sidewalkArea.toFixed(0)} sq ft`;
  $('est-siding').textContent    = `${e.sidingSqFt.toFixed(0)} sq ft`;
  $('est-drywall-sq').textContent = `${e.drywallSqFt.toFixed(0)} sq ft`;
  $('est-drywall-sh').textContent = `${e.drywallSheets} sheets`;
  $('est-paint').textContent     = `${e.paintGallons} gallons`;
  $('est-lumber').textContent    = `${e.lumberBF.toLocaleString()} BF`;
  $('est-shingles').textContent  = `${e.shingleBundles} bundles`;
  $('est-roof-sq').textContent   = `${e.roofSquares.toFixed(1)} squares`;
  $('cost-drywall').textContent  = `$${e.cost.drywall.toLocaleString()}`;
  $('cost-paint').textContent    = `$${e.cost.paint.toLocaleString()}`;
  $('cost-lumber').textContent   = `$${e.cost.lumber.toLocaleString()}`;
  $('cost-shingles').textContent = `$${e.cost.shingles.toLocaleString()}`;
  $('cost-slab').textContent     = `$${e.cost.slab.toLocaleString()}`;
  $('cost-siding').textContent   = `$${e.cost.siding.toLocaleString()}`;
  $('cost-driveway').textContent = `$${e.cost.driveway.toLocaleString()}`;
  $('cost-sidewalk').textContent = `$${e.cost.sidewalk.toLocaleString()}`;
  $('cost-patio').textContent    = `$${e.cost.patio.toLocaleString()}`;
  $('cost-porch').textContent    = `$${e.cost.porch.toLocaleString()}`;
  $('cost-foundation').textContent = `$${e.cost.foundation.toLocaleString()}`;
  $('cost-total').textContent    = `$${e.cost.total.toLocaleString()}`;
}
fillEstimate();

// ------------------------------------------------------------
//   GLB EXPORT — download the whole scene as a .glb
// ------------------------------------------------------------
// GLB export — strips CSS2D labels (they're HTML, not 3D),
// strips the floor tile above y=0.1 (avoid exporting labels stack).
// Kept simple: only export meshes.
document.getElementById('btn-glb').addEventListener('click', () => {
  const exporter = new GLTFExporter();
  const exportScene = new THREE.Scene();
  // Walk scene and clone only Mesh / Group / InstancedMesh children,
  // skipping CSS2DRenderer objects (which are not part of THREE).
  const skip = new Set();
  scene.traverse(o => {
    if (o.isCSS2DObject || (o.userData && o.userData.exportable === false)) skip.add(o);
  });
  scene.children.forEach(child => {
    if (child.isCSS2DObject) return;
    exportScene.add(child.clone(true));
  });

  exporter.parse(
    exportScene,
    (result) => {
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'genesis-home.glb';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    (err) => { console.error('GLB export failed', err); alert('GLB export failed: ' + err.message); },
    { binary: true, embedImages: true }
  );
});

// Estimate CSV download — gives the user a quotable summary
document.getElementById('btn-est-csv').addEventListener('click', () => {
  const e = ESTIMATE;
  const rows = [
    ['Genesis v0.5 — Quantity Takeoff'],
    ['Generated', new Date().toISOString()],
    [],
    ['Material', 'Quantity', 'Unit', 'Cost (USD)'],
    ['Total floor area',       e.totalFloorSqFt, 'sq ft', ''],
    ['Total wall area (both sides)', e.totalWallArea.toFixed(0), 'sq ft', ''],
    ['Interior wall area',     e.interiorWallArea.toFixed(0), 'sq ft', ''],
    ['Roof area',              e.roofArea.toFixed(0), 'sq ft', ''],
    [],
    ['Drywall',                e.drywallSheets, 'sheets (4×8)', `$${e.cost.drywall.toLocaleString()}`],
    ['Paint (2 coats)',        e.paintGallons, 'gallons',       `$${e.cost.paint.toLocaleString()}`],
    ['Framing lumber',         e.lumberBF, 'board feet',        `$${e.cost.lumber.toLocaleString()}`],
    ['Roof squares',           e.roofSquares.toFixed(1), 'squares', ''],
    ['Shingle bundles',        e.shingleBundles, 'bundles', `$${e.cost.shingles.toLocaleString()}`],
    ['Concrete slab',          e.totalFloorSqFt, 'sq ft',   `$${e.cost.slab.toLocaleString()}`],
    [],
    ['TOTAL', '', '', `$${e.cost.total.toLocaleString()}`],
  ];
  const csv = rows.map(r => r.map(v => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'genesis-takeoff.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ------------------------------------------------------------
//   PDF / IMAGE DROP — overlay as 2D texture on the slab
//   First v1.0 milestone: a real user-provided floor plan, rendered
//   as a 2D overlay on the slab. Lights up the upload UX end-to-end.
//
//   Uses pdfjs-dist (Mozilla's pdf.js) from a CDN — loaded only when
//   the user actually clicks the upload button, so it doesn't bloat
//   the initial page load.
// ------------------------------------------------------------
let PLAN_OVERLAY_MESH = null;        // current plane on slab (if any)
let PLAN_TEX = null;                  // current CanvasTexture
let pdfjsLib = null;                  // lazy-loaded

async function ensurePdfJs() {
  if (pdfjsLib) return pdfjsLib;
  // pdfjs-dist prebuilt ESM
  const url = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.mjs';
  const workerUrl = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.mjs';
  pdfjsLib = await import(url);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjsLib;
}

async function rasterizePdf(file) {
  await ensurePdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);                 // first page only
  const targetWidthPx = Math.min(2048, window.devicePixelRatio > 1 ? 1800 : 1500);
  const viewport = page.getViewport({ scale: 1 });
  const scale = targetWidthPx / viewport.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width; canvas.height = vp.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, pageCount: pdf.numPages };
}

async function rasterizeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 2200;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ canvas: c, pageCount: 1 });
    };
    img.onerror = e => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
    img.src = url;
  });
}

function placePlanTexture(canvas) {
  if (PLAN_OVERLAY_MESH) {
    scene.remove(PLAN_OVERLAY_MESH);
    PLAN_OVERLAY_MESH.geometry.dispose();
    if (PLAN_TEX) PLAN_TEX.dispose();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  PLAN_TEX = tex;

  // Match slab footprint (FOOTPRINT_W x FOOTPRINT_D)
  const aspect = canvas.width / canvas.height;
  // Pick a target aspect to fit
  const FOOT_W = FOOTPRINT_W * 0.95;
  const FOOT_D = FOOTPRINT_D * 0.95;
  let planeW = FOOT_W;
  let planeH = FOOT_W / aspect;
  if (planeH > FOOT_D) {
    planeH = FOOT_D;
    planeW = FOOT_D * aspect;
  }

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    opacity: 0.85,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(FOOTPRINT_W / 2, 0.02, FOOTPRINT_D / 2);
  plane.userData.exportable = false;
  PLAN_OVERLAY_MESH = plane;
  scene.add(plane);
  document.getElementById('btn-clear-plan').classList.remove('hidden');
}

function clearPlanTexture() {
  if (PLAN_OVERLAY_MESH) {
    scene.remove(PLAN_OVERLAY_MESH);
    PLAN_OVERLAY_MESH.geometry.dispose();
    PLAN_OVERLAY_MESH = null;
  }
  if (PLAN_TEX) { PLAN_TEX.dispose(); PLAN_TEX = null; }
  document.getElementById('btn-clear-plan').classList.add('hidden');
}

async function handleUploadedFile(file) {
  const overlay = document.getElementById('drop-overlay');
  const dropText = document.getElementById('drop-text');
  overlay.classList.remove('hidden');
  dropText.textContent = `Processing ${file.name} (${(file.size / 1024).toFixed(1)} kB)…`;
  try {
    // NEW: JSON plan — defines a parameterized home (rooms + doors + windows)
    // and rebuilds the entire scene from the data. Bridges the gap between
    // "drop an image" (v0.1) and "real AI blueprint parsing" (v1+).
    if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) {
      const text = await file.text();
      const plan = JSON.parse(text);
      // Real pipeline: validate, derive walls/stats, install into state, rebuild meshes.
      // Geometry rebuild is the only step still stubbed — see `rebuildSceneFromPlan`.
      try {
        loadPlan(plan);
        rebuildSceneFromPlan(plan);
      } catch (e) {
        dropText.textContent = `Failed: ${e.message}`;
        setTimeout(() => overlay.classList.add('hidden'), 1800);
        return;
      }
      dropText.textContent = `✓ ${file.name} loaded (${state.stats.roomCount} rooms)`;
      setTimeout(() => overlay.classList.add('hidden'), 600);
      document.getElementById('demo-title').textContent =
        `${plan.name || file.name} · Plan #${plan.planNumber || 1}`;
      const clearBtn = document.getElementById('btn-clear-plan');
      if (clearBtn) clearBtn.classList.remove('hidden');
      return;
    }

    let res;
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      res = await rasterizePdf(file);
    } else if (file.type.startsWith('image/')) {
      res = await rasterizeImage(file);
    } else {
      throw new Error('Unsupported file type. Use PDF, PNG, JPEG, or JSON plan.');
    }
    placePlanTexture(res.canvas);
    document.getElementById('demo-title').textContent =
      `${file.name} · Plan #1 (${res.pageCount} page${res.pageCount === 1 ? '' : 's'})`;
    dropText.textContent = `✓ ${file.name} loaded`;
    setTimeout(() => overlay.classList.add('hidden'), 600);
  } catch (err) {
    console.error('Plan upload failed', err);
    dropText.textContent = `Failed: ${err.message}`;
    setTimeout(() => overlay.classList.add('hidden'), 1800);
  }
}

// Rebuild the side-panel UI to match the loaded plan.
//
// At v0.9 this updates:
//   - The viewer's header stats (rooms, sq ft, doors, windows)
//   - The ROOMS list in the side panel
//
// The 3D GEOMETRY rebuild (regenerate walls/doors/windows meshes from the
// new plan) is the next step. For now the scene keeps showing the demo
// home; the panels reflect the new plan. Foundation laid; geometry swap
// is the next foundation item.
function rebuildSceneFromPlan(plan) {
  if (!state.house) return;

  // The stats card ("6 rooms · 1236 sq ft · 5 doors · 10 windows") under the canvas
  const stats = document.querySelector('.viewer-stats');
  if (stats) {
    stats.innerHTML = `
      <strong>${state.stats.roomCount}</strong> rooms ·
      <strong>${state.stats.floorAreaSqFt}</strong> sq ft ·
      <strong>${state.house.plan.doors.length}</strong> doors ·
      <strong>${state.house.plan.windows.length}</strong> windows
    `;
  }
  // The big number in the top-left ("6 rooms / 24 walls")
  const statRooms = document.getElementById('stat-rooms');
  if (statRooms) statRooms.textContent = state.stats.roomCount;
  const statSqft = document.getElementById('stat-sqft');
  if (statSqft) statSqft.textContent = state.stats.floorAreaSqFt.toLocaleString();
  const statWalls = document.getElementById('stat-walls');
  if (statWalls) statWalls.textContent = state.stats.interiorWalls + state.stats.exteriorWalls;
  // The plan title above the canvas
  const demoTitle = document.getElementById('demo-title');
  if (demoTitle) demoTitle.textContent = `${state.house.plan.name} · Plan #${state.house.plan.planNumber || 1}`;

  // Side-panel ROOMS list
  const roomsList = document.getElementById('rooms-list');
  if (roomsList) {
    roomsList.innerHTML = state.house.plan.rooms.map(r => `
      <li class="room-row">
        <div class="room-name">${r.name}</div>
        <div class="room-meta">${r.w}' × ${r.d}' · ${r.w * r.d} sq ft</div>
      </li>
    `).join('');
  }

  // Side-panel OPENINGS list (function defined inline above)
  if (typeof buildOpeningsList === 'function') buildOpeningsList(state.house.plan);

  // Quantity-takeoff panel
  if (typeof fillEstimate === 'function') {
    if (typeof recomputeEstimate === 'function') recomputeEstimate();
    else fillEstimate();
  }
}

document.getElementById('btn-upload').addEventListener('click', () => {
  document.getElementById('pdf-input').click();
});
// Try-sample-plan button — auto-runs the raster extract pipeline on a
// tiny bundled fixture so the user can verify v0.4 works without
// finding a PDF. Wired via `id="btn-demo-extract"` in index.html.
document.getElementById('btn-demo-extract')?.addEventListener('click', () => {
  runExtractDemo();
});
document.getElementById('btn-demo-garcia')?.addEventListener('click', () => {
  runGarciaDemo();
});
document.getElementById('btn-extract')?.addEventListener('click', () => {
  openExtract();
});
document.getElementById('pdf-input').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) handleUploadedFile(f);
  e.target.value = ''; // allow re-picking same file
});
document.getElementById('btn-clear-plan').addEventListener('click', () => {
  clearPlanTexture();
  document.getElementById('demo-title').textContent = 'Sample Home · Plan #1';
});

// Drag/drop on the entire viewer
const viewerEl = document.getElementById('three-canvas').parentElement;
viewerEl.addEventListener('dragover', e => { e.preventDefault(); document.getElementById('drop-overlay').classList.remove('hidden'); });
viewerEl.addEventListener('dragleave', e => {
  // Only hide if leaving the viewer entirely
  if (!viewerEl.contains(e.relatedTarget)) {
    document.getElementById('drop-overlay').classList.add('hidden');
  }
});
viewerEl.addEventListener('drop', e => {
  e.preventDefault();
  document.getElementById('drop-overlay').classList.add('hidden');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleUploadedFile(f);
});

// =============================================================
//   TRACE OVERLAY — v2.0 no-ML polygon capture
//
// User uploads an image (PNG/JPG/PDF), clicks corners to define
// rooms, calibrates a known dimension, and exports a plan JSON that
// GENESIS.loadPlan() can render. Uses tracer.js for the data layer.
// =============================================================
const traceOverlay = document.getElementById('trace-overlay');
const traceStageUpload = document.getElementById('trace-stage-upload');
const traceStageDraw = document.getElementById('trace-stage-draw');
const traceFileInput = document.getElementById('trace-file');
const tracePickFile = document.getElementById('trace-pick-file');
const traceCanvas = document.getElementById('trace-canvas');
const traceHelp = document.getElementById('trace-help');
const traceCloseRoomBtn = document.getElementById('trace-close-room');
const traceClearOpenBtn = document.getElementById('trace-clear-open');
const traceCloseBtn = document.getElementById('trace-close');
const traceAbortBtn = document.getElementById('trace-abort');
const traceFinishBtn = document.getElementById('trace-finish');
const traceCalPx = document.getElementById('trace-cal-pixel');
const traceCalFt = document.getElementById('trace-cal-feet');
const traceCalSet = document.getElementById('trace-cal-set');
const tracePlanName = document.getElementById('trace-plan-name');
const traceRoomsList = document.getElementById('trace-rooms-list');

let traceCtx = null;
let tracer = null;
let traceImage = null;

function openTracer() {
  traceOverlay.classList.remove('hidden');
  traceOverlay.setAttribute('aria-hidden', 'false');
  tracer = createTracer();
  traceImage = null;
  traceStageUpload.classList.remove('hidden');
  traceStageDraw.classList.add('hidden');
}
function closeTracer() {
  traceOverlay.classList.add('hidden');
  traceOverlay.setAttribute('aria-hidden', 'true');
  tracer = null;
  traceImage = null;
  traceCtx = null;
}
document.getElementById('btn-trace').addEventListener('click', openTracer);
traceCloseBtn.addEventListener('click', closeTracer);
traceAbortBtn.addEventListener('click', closeTracer);

tracePickFile.addEventListener('click', () => traceFileInput.click());
traceFileInput.addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    await loadTraceImage(f);
  } catch (err) {
    traceHelp.textContent = `Couldn't read that file: ${err.message}`;
  }
  e.target.value = '';
});

async function loadTraceImage(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    // Render first page of PDF to image via pdf.js (already lazy-loaded)
    const pdfjs = await loadPdfJsOnce();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2.0 });
    const off = document.createElement('canvas');
    off.width = viewport.width;
    off.height = viewport.height;
    await page.render({ canvasContext: off.getContext('2d'), viewport }).promise;
    traceImage = off;
  } else {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    traceImage = img;
  }
  enterDrawStage();
}

function enterDrawStage() {
  traceStageUpload.classList.add('hidden');
  traceStageDraw.classList.remove('hidden');
  // Size canvas to fit the image at native dimensions, capped at 1200x900
  const maxW = 1200, maxH = 900;
  let w = traceImage.width || traceImage.naturalWidth || traceImage.canvas?.width;
  let h = traceImage.height || traceImage.height || traceImage.canvas?.height;
  const scale = Math.min(1, maxW / w, maxH / h);
  traceCanvas.width = Math.floor(w * scale);
  traceCanvas.height = Math.floor(h * scale);
  traceCtx = traceCanvas.getContext('2d');
  drawTraceOverlay();
  traceHelp.textContent = 'Click to drop wall corners. After 3+ nodes, click Close room.';
}

function drawTraceOverlay() {
  if (!traceCtx) return;
  const { width: w, height: h } = traceCanvas;
  traceCtx.clearRect(0, 0, w, h);
  // Background image
  if (traceImage) {
    traceCtx.drawImage(traceImage, 0, 0, w, h);
  } else {
    traceCtx.fillStyle = '#fff';
    traceCtx.fillRect(0, 0, w, h);
  }
  // Closed rooms — filled polygon + label
  if (tracer) {
    for (const r of tracer.rooms) {
      traceCtx.beginPath();
      r.polygon.forEach((p, i) => i === 0 ? traceCtx.moveTo(p.x, p.y) : traceCtx.lineTo(p.x, p.y));
      traceCtx.closePath();
      traceCtx.fillStyle = 'rgba(0, 200, 255, 0.18)';
      traceCtx.fill();
      traceCtx.strokeStyle = 'rgba(0, 200, 255, 0.95)';
      traceCtx.lineWidth = 2;
      traceCtx.stroke();
      // Label at centroid
      const cen = centroid(r.polygon);
      traceCtx.fillStyle = '#03222e';
      traceCtx.font = 'bold 12px system-ui';
      traceCtx.fillText(r.name, cen.x + 4, cen.y + 4);
    }
    // Open polygon (current)
    const open = tracer.nodes;
    if (open.length > 0) {
      traceCtx.beginPath();
      open.forEach((p, i) => i === 0 ? traceCtx.moveTo(p.x, p.y) : traceCtx.lineTo(p.x, p.y));
      traceCtx.strokeStyle = 'rgba(255, 90, 0, 0.95)';
      traceCtx.lineWidth = 2;
      traceCtx.setLineDash([4, 4]);
      traceCtx.stroke();
      traceCtx.setLineDash([]);
      // Nodes as dots
      for (const p of open) {
        traceCtx.beginPath();
        traceCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        traceCtx.fillStyle = '#ff5a00';
        traceCtx.fill();
      }
    }
  }
}

function centroid(poly) {
  let cx = 0, cz = 0;
  for (const p of poly) { cx += p.x; cz += p.y; }
  return { x: cx / poly.length, y: cz / poly.length };
}

traceCanvas.addEventListener('click', (e) => {
  if (!tracer) return;
  const rect = traceCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (traceCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (traceCanvas.height / rect.height);
  tracer.addNode(x, y);
  drawTraceOverlay();
  traceCloseRoomBtn.disabled = tracer.nodes.length < 3;
});
traceCanvas.addEventListener('mousemove', (e) => {
  if (!tracer || !tracer.nodes.length) return;
  const rect = traceCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (traceCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (traceCanvas.height / rect.height);
  drawTraceOverlay();
  // Draw rubber-band line from last node to cursor
  const last = tracer.nodes[tracer.nodes.length - 1];
  traceCtx.beginPath();
  traceCtx.moveTo(last.x, last.y);
  traceCtx.lineTo(x, y);
  traceCtx.strokeStyle = 'rgba(255, 90, 0, 0.5)';
  traceCtx.lineWidth = 1.5;
  traceCtx.setLineDash([2, 4]);
  traceCtx.stroke();
  traceCtx.setLineDash([]);
});

traceClearOpenBtn.addEventListener('click', () => {
  if (!tracer) return;
  tracer.nodes.length = 0;       // direct clear; keep closed rooms
  tracer.nodes;                  // no-op read for clarity
  drawTraceOverlay();
  traceCloseRoomBtn.disabled = true;
});

traceCloseRoomBtn.addEventListener('click', () => {
  if (!tracer) return;
  const name = (window.prompt && window.prompt('Room name?', `Room ${tracer.rooms.length + 1}`)) || `Room ${tracer.rooms.length + 1}`;
  tracer.closePolygon(name);
  drawTraceOverlay();
  refreshRoomsList();
  traceCloseRoomBtn.disabled = true;
});

traceCalSet.addEventListener('click', () => {
  if (!tracer) return;
  const px = parseFloat(traceCalPx.value);
  const ft = parseFloat(traceCalFt.value);
  if (!(px > 0) || !(ft > 0)) return;
  tracer.setScale(px, ft);
  traceHelp.textContent = `Scale set: ${px}px = ${ft}ft (1ft = ${(px/ft).toFixed(2)}px)`;
});

traceFinishBtn.addEventListener('click', () => {
  if (!tracer) return;
  if (!tracer.rooms.length) {
    traceHelp.textContent = 'Trace at least one room before finishing.';
    return;
  }
  const plan = tracer.exportPlan(tracePlanName.value || 'Traced plan');
  if (!plan) return;
  // Sanity: scale defaults to 1 px/ft when unset, so w/d would be in pixels.
  if (tracer.getScale() === 1) {
    if (!window.confirm('No scale calibration entered. Rooms will be saved at 1 pixel = 1 foot (a likely wrong measurement). Continue?')) {
      return;
    }
  }
  window.GENESIS.loadPlan(plan);
  closeTracer();
});

function refreshRoomsList() {
  if (!tracer) return;
  traceRoomsList.innerHTML = tracer.rooms.map((r, i) =>
    `<li>${escapeHtml(r.name)} — ${r.polygon.length} corners</li>`).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ------------------------------------------------------------
//   RENDER LOOP
// ------------------------------------------------------------
const clock = new THREE.Clock();

// Simple collision: clamp walk pos to stay inside the footprint + inside walls
// Walk-mode collision — check against each wall + outer footprint
const PLAYER_RADIUS = 0.5;
const _tmpV = new THREE.Vector3();

function collide(pos) {
  pos.y = 5.5; // eye height

  // Outer footprint clamp (allow a tiny buffer for the player radius)
  const limit = PLAYER_RADIUS + 0.05;
  pos.x = Math.max(limit, Math.min(FOOTPRINT_W - limit, pos.x));
  pos.z = Math.max(limit, Math.min(FOOTPRINT_D - limit, pos.z));

  // Resolve against interior walls by pushing the player out along the
  // nearest wall normal. Each wall is axis-aligned, so we can compute
  // the closest point on the wall rectangle in xz and check distance.
  // Iterate a few times to handle corners.
  for (let iter = 0; iter < 3; iter++) {
    let pushed = false;
    for (const wall of WALL_MESHES) {
      const ax = wall.userData.ax, az = wall.userData.az;
      const aw = wall.userData.aw, ad = wall.userData.ad;
      // Pad the wall by PLAYER_RADIUS so we can't clip into it
      const minX = ax - PLAYER_RADIUS;
      const maxX = ax + aw + PLAYER_RADIUS;
      const minZ = az - PLAYER_RADIUS;
      const maxZ = az + ad + PLAYER_RADIUS;
      const cx = Math.max(minX, Math.min(maxX, pos.x));
      const cz = Math.max(minZ, Math.min(maxZ, pos.z));
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const distSq = dx*dx + dz*dz;
      if (distSq < PLAYER_RADIUS*PLAYER_RADIUS && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist, nz = dz / dist;
        const pushBy = PLAYER_RADIUS - dist + 0.01;
        pos.x += nx * pushBy;
        pos.z += nz * pushBy;
        pushed = true;
      }
    }
    if (!pushed) break;
  }

  // Foundation: a 2 ft-deep skirt around the slab — clamp pos to the
  // foundation top (y = 0) and onto the slab rectangle only.
  // For now walk-mode keeps the player inside the footprint only;
  // they can't walk on the porch/patio/etc. (would require y-aware collide).
}

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (walkState.active) {
    // Compute movement from keys
    const forward = new THREE.Vector3(
      -Math.sin(walkState.yaw), 0, -Math.cos(walkState.yaw)
    );
    const right = new THREE.Vector3(
      Math.cos(walkState.yaw), 0, -Math.sin(walkState.yaw)
    );
    const move = new THREE.Vector3();
    if (walkState.keys['w'] || walkState.keys['W'] || walkState.keys['ArrowUp']) move.add(forward);
    if (walkState.keys['s'] || walkState.keys['S'] || walkState.keys['ArrowDown']) move.sub(forward);
    if (walkState.keys['a'] || walkState.keys['A'] || walkState.keys['ArrowLeft']) move.sub(right);
    if (walkState.keys['d'] || walkState.keys['D'] || walkState.keys['ArrowRight']) move.add(right);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(walkState.moveSpeed * dt);

    walkState.pos.add(move);
    collide(walkState.pos);

    camera.position.copy(walkState.pos);
    const lookDir = new THREE.Vector3(
      -Math.sin(walkState.yaw) * Math.cos(walkState.pitch),
      Math.sin(walkState.pitch),
      -Math.cos(walkState.yaw) * Math.cos(walkState.pitch),
    );
    camera.lookAt(camera.position.clone().add(lookDir));
  } else {
    orbit.update();
  }

  composer.render();
  labelRenderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

// Public API surface — drive Genesis from console, devtools, future UI.
// Stable names; internals stay private.
window.GENESIS = {
  // ----- state bridge -----
  state,                         // the state module's state object
  loadPlan(plan) {
    // Wrap the state module's loadPlan so callers automatically get a
    // full scene rebuild + side-panel refresh. Returning the same shape
    // (state.house) keeps the API predictable.
    const result = loadPlan(plan);
    buildHouse(state.house.plan);
    rebuildSceneFromPlan(state.house.plan);
    fitCameraToPlan(state.house.plan);    // reframe to the new bounding box
    return result;
  },
  describe,                      // () → human-readable summary of current house
  getRoom, getWall, getOpening,  // id lookups
  fitCameraToPlan,               // re-frame camera to current plan bbox

  // ----- scene handles (legacy; exposed for devtools / 3rd-party scripts) -----
  scene, camera, orbit,
  ROOMS, DOORS, WINDOWS, STATS,  // current plan arrays (live references to state)

  // ----- toggles -----
  composer, ssaoPass, outlinePass,
  togglePost() { this.composer.enabled = !this.composer.enabled; },

  // ----- scene rebuild after a loadPlan(...) -----
  // v0.10+: this becomes a real mesh-rebuild step. For now it refreshes the
  // side-panel UI. The 3D geometry still shows the demo home until the
  // rebuild-meshes work lands.
  rebuildSceneFromPlan(plan) {
    if (typeof rebuildSceneFromPlan === 'function') rebuildSceneFromPlan(plan);
  },
};

// Expose plan fixtures for devtools ("GENESIS.demoPlan()" → reinstalls the demo plan)
window.GENESIS.demoPlan = async () => {
  const mod = await import('./state.js');
  // Reuse the wrapped loadPlan so the demo swap also rebuilds + refreshes UI.
  return window.GENESIS.loadPlan(mod.DEMO_PLAN);
};

// Auto-load a sample plan when the URL has ?load=<planId>.
// Currently supported plan IDs:
//   • garage      — sample-plan.json (demo)
//   • garcia      — Garcia/Caballero Residence (real architect's plans)
// Runs after a short delay so window.GENESIS.loadPlan is fully initialized.
(async () => {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('load');
  if (!wanted) return;
  const map = {
    garage: '/assets/sample-plan.json',
    garcia: '/assets/garcia-residence.json',
  };
  const url = map[wanted];
  if (!url) return;
  await new Promise(r => setTimeout(r, 50));
  try {
    const r = await fetch(url);
    const plan = await r.json();
    window.GENESIS.loadPlan(plan);
    console.log(`[Genesis] Auto-loaded ${wanted} from ${url}`);
  } catch (e) {
    console.error(`[Genesis] Auto-load failed for ${wanted}:`, e);
  }
})();
