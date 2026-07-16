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
function buildHouse(plan) {
  disposeHouse();
  if (!plan || !Array.isArray(plan.rooms)) return { ok: false, error: 'plan missing rooms' };

  const fp = plan.footprint || { w: 46, d: 30 };
  const WALL_H_LOCAL = 9;
  const WALL_T_LOCAL = 0.5;

  // ----- Slab -----
  const slabGeo = new THREE.BoxGeometry(fp.w, 0.4, fp.d);
  const slab = new THREE.Mesh(slabGeo, slabMat);
  slab.position.set(fp.w / 2, 0.2, fp.d / 2);
  slab.castShadow = true;
  slab.receiveShadow = true;
  slab.userData = { kind: 'slab', footprint: fp };
  houseGroup.add(slab);

  // ----- Per-room floor slabs (color + texture per room) -----
  // Use the existing floorForRoom helper which derives color from room.color
  // and texture from room.id (wood/tile/carpet).
  plan.rooms.forEach(room => {
    const flGeo = new THREE.BoxGeometry(room.w, 0.05, room.d);
    const flMat = floorForRoom(room);
    const fl = new THREE.Mesh(flGeo, flMat);
    fl.position.set(room.x + room.w / 2, 0.45, room.z + room.d / 2);
    fl.userData = { kind: 'floor', roomId: room.id };
    houseGroup.add(fl);
  });

  // ----- Walls -----
  // Outer rectangle (4 walls)
  addOuterWallOnGroup(plan, 0, 0,        fp.w, WALL_T_LOCAL, 's');      // south
  addOuterWallOnGroup(plan, 0, fp.d-WALL_T_LOCAL, fp.w, WALL_T_LOCAL, 'n')   // north
  addOuterWallOnGroup(plan, 0, 0,        WALL_T_LOCAL, fp.d, 'w')      // west
  addOuterWallOnGroup(plan, fp.w-WALL_T_LOCAL, 0, WALL_T_LOCAL, fp.d, 'e')  // east

  // Interior walls from state.house.interiorWalls (canonical derivation)
  for (const w of state.house.interiorWalls) {
    addInnerWallOnGroup(w);
  }

  // ----- Doors -----
  plan.doors.forEach(d => {
    addDoorOnGroup(d, WALL_H_LOCAL);
  });

  // ----- Windows -----
  plan.windows.forEach(w => {
    addWindowOnGroup(w, WALL_H_LOCAL);
  });

  // ----- Roof (gable over whole footprint) -----
  houseGroup.add(buildRoof(plan));

  // The foundation assets (porch/patio/driveway/sidewalk) are still
  // tied to the demo plan's specific positions; they stay under the
  // houseGroup so they get cleared and re-added identically.
  rebuildFoundationAssets(plan);

  // ----- Labels -----
  plan.rooms.forEach(room => {
    const obj = makeLabel(room);
    houseGroup.add(obj);
  });

  return {
    ok: true,
    rooms: plan.rooms.length,
    interiorWalls: state.house.interiorWalls.length,
    exteriorWalls: 4,
    openings: plan.doors.length + plan.windows.length,
  };
}

// ----- Internal helpers (small shims that wrap the existing constructors) -----

function addOuterWallOnGroup(plan, x, z, w, d, side) {
  const mat = wallMat;
  const geo = new THREE.BoxGeometry(w, 9, d);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x + w / 2, 9 / 2, z + d / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `wall-outer-${side}`;
  mesh.userData = {
    kind: 'wall', isOuter: true,
    length: Math.max(w, d),
    height: 9, area: Math.max(w, d) * 9 * 2,
    ax: x, az: z, aw: w, ad: d, side,
    rooms: [],
  };
  WALL_MESHES.push(mesh);
  INTERACTABLE.push(mesh);
  houseGroup.add(mesh);
}

function addInnerWallOnGroup(w) {
  // w is { id, length, axis, side, x, z, rooms }
  const mat = wallMatInterior;
  const wThick = 0.5, wHt = 9;
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
  mesh.position.set(posX, wHt / 2, posZ);
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
  houseGroup.add(mesh);
}

// door / window helpers — minimal placeholders for v0.10.
// v0.11 will port the full addDoor / addWindow visuals onto the plan-driven path.
function addDoorOnGroup(d, h) {
  // Create a simple black-plane proxy for now. The full addDoor has many
  // sub-meshes (frame, plank, etc.); porting those is the next slice.
  const proxy = new THREE.Mesh(
    new THREE.PlaneGeometry(d.w, h),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, metalness: 0.0, side: THREE.DoubleSide })
  );
  // Position on its host wall (axis z or x; offset along the axis at 'x' or 'z')
  if (d.axis === 'z') {
    proxy.position.set(d.x + d.w / 2, h / 2, d.z);
    proxy.rotation.y = Math.PI / 2;
  } else {
    proxy.position.set(d.x, h / 2, d.z + d.w / 2);
  }
  proxy.userData = { kind: 'door', id: d.id, label: d.label };
  proxy.name = `door-${d.id}`;
  INTERACTABLE.push(proxy);
  houseGroup.add(proxy);
}

function addWindowOnGroup(wd, h) {
  const proxy = new THREE.Mesh(
    new THREE.PlaneGeometry(wd.w, 3),
    new THREE.MeshPhysicalMaterial({
      color: 0x9ed5ff, roughness: 0.05, metalness: 0.1,
      transmission: 0.7, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide,
    })
  );
  if (wd.axis === 'z') {
    proxy.position.set(wd.x + wd.w / 2, 3.5, wd.z);
    proxy.rotation.y = Math.PI / 2;
  } else {
    proxy.position.set(wd.x, 3.5, wd.z + wd.w / 2);
  }
  proxy.userData = { kind: 'window', id: wd.id, label: wd.label };
  proxy.name = `window-${wd.id}`;
  INTERACTABLE.push(proxy);
  houseGroup.add(proxy);
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
let roofArea = 0;
let roofPitchRise = ROOF_PITCH;
function buildRoof(plan) {
  const fp = plan.footprint || { w: 46, d: 30 };
  const w = fp.w, d = fp.d;
  const halfSpan = w / 2;
  const ridgeY = ROOF_PITCH;     // additional rise above wall top
  const wallTop = WALL_H;        // walls stop at this y

  // Two slope planes as a single BufferGeometry (sharing seams).
  const verts = new Float32Array([
    // WEST slope (rising from x=0,wallTop to x=halfSpan,wallTop+pitch)
    0,          wallTop, 0,
    halfSpan,   wallTop + ridgeY, 0,
    halfSpan,   wallTop + ridgeY, d,
    0,          wallTop, d,
    // EAST slope (descending)
    halfSpan,   wallTop + ridgeY, 0,
    w,          wallTop, 0,
    w,          wallTop, d,
    halfSpan,   wallTop + ridgeY, d,
  ]);
  const idx = [0,1,2, 0,2,3,   4,5,6, 4,6,7];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const slopeMat = new THREE.MeshStandardMaterial({
    map: shingleTex,
    color: 0x9e6b3f,            // lighter brown tint applied on top of texture
    roughness: 0.78,
    metalness: 0,
    envMapIntensity: 0.7,
    side: THREE.DoubleSide,
  });
  const slopes = new THREE.Mesh(geo, slopeMat);
  slopes.castShadow = true;
  slopes.receiveShadow = true;

  // Gable ends (south + north triangle facias) — sheetrock
  const gableMat = new THREE.MeshStandardMaterial({
    map: sheetrockTex.clone(),
    color: 0xebe0d0,
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0.3,
  });
  const tri = (zPos) => {
    const a = new Float32Array([
      0, wallTop, zPos,
      w, wallTop, zPos,
      halfSpan, wallTop + ridgeY, zPos,
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    g.setIndex([0, 1, 2, 0, 2, 1]);   // both faces
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, gableMat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const south = tri(0);
  const north = tri(d);

  const group = new THREE.Group();
  group.add(slopes, south, north);
  group.name = 'roof';
  group.userData = {
    kind: 'roof',
    // Two slopes × length × slant length = total roof area.
    area: 2 * d * Math.sqrt(halfSpan * halfSpan + ridgeY * ridgeY),
    pitchRise: ridgeY,
    pitchRun: halfSpan,
  };

  // Update module-level mirrors
  roofArea = group.userData.area;
  roofPitchRise = ridgeY;
  return group;
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
  const statWalls = document.getElementById('stat-walls');
  if (statWalls) statWalls.textContent = state.stats.interiorWalls + state.stats.exteriorWalls;

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
    return result;
  },
  describe,                      // () → human-readable summary of current house
  getRoom, getWall, getOpening,  // id lookups

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
