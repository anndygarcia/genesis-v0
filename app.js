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
const ROOMS = [
  { id: 'living',  name: 'Living Room',  x: 0,   z: 0,   w: 20, d: 18, color: 0xfff3e6, accent: '#d97706' },
  { id: 'kitchen', name: 'Kitchen',      x: 20,  z: 0,   w: 14, d: 18, color: 0xe6f4ff, accent: '#0369a1' },
  { id: 'master',  name: 'Master Bed',   x: 34,  z: 0,   w: 12, d: 18, color: 0xf3e8ff, accent: '#7c3aed' },
  { id: 'bed2',    name: 'Bedroom 2',    x: 0,   z: 18,  w: 14, d: 12, color: 0xf3e8ff, accent: '#7c3aed' },
  { id: 'bed3',    name: 'Bedroom 3',    x: 14,  z: 18,  w: 12, d: 12, color: 0xf3e8ff, accent: '#7c3aed' },
  { id: 'bath',    name: 'Bathroom',     x: 26,  z: 18,  w: 8,  d: 12, color: 0xe0f7fa, accent: '#0891b2' },
];

const FOOTPRINT_W = 46;             // x: 0..46
const FOOTPRINT_D = 30;             // z: 0..30

// Doors: [wallStartX, wallStartZ, width, axis 'x'|'z', facing 'outer'|'inner']
const DOORS = [
  { x: 6,   z: 0,    w: 3, axis: 'z', kind: 'exterior',  label: 'Front Entry' },
  { x: 28,  z: 30,   w: 5, axis: 'z', kind: 'exterior',  label: 'Back Patio', flip: true },
  { x: 40,  z: 9,    w: 3, axis: 'z', kind: 'interior',  label: 'Master Bath', interior: { room: 'master' } },
  { x: 6,   z: 18,   w: 3, axis: 'z', kind: 'interior',  label: 'Bed 2 Entry', interior: { room: 'bed2' } },
  { x: 18,  z: 18,   w: 3, axis: 'z', kind: 'interior',  label: 'Bed 3 Entry', interior: { room: 'bed3' } },
];

// Windows: [x, z, w, axis, kind]
const WINDOWS = [
  { x: 4,   z: 30,   w: 4, axis: 'z', label: 'Living Window' },
  { x: 16,  z: 30,   w: 4, axis: 'z', label: 'Bed 2 Window' },
  { x: 26,  z: 30,   w: 4, axis: 'z', label: 'Bed 3 Window' },
  { x: 39,  z: 30,   w: 4, axis: 'z', label: 'Bath Window' },
  { x: 0,   z: 4,    w: 3, axis: 'x', label: 'Living Side' },
  { x: 0,   z: 12,   w: 3, axis: 'x', label: 'Living Side 2' },
  { x: 14,  z: 0,    w: 3, axis: 'x', label: 'Kitchen Window' },
  { x: 24,  z: 0,    w: 3, axis: 'x', label: 'Kitchen Window 2' },
  { x: 46,  z: 4,    w: 3, axis: 'x', label: 'Master Window' },
  { x: 46,  z: 12,   w: 3, axis: 'x', label: 'Master Window 2' },
];

// ------------------------------------------------------------
//   STATS (computed below but written into HUD)
// ------------------------------------------------------------
function computeStats() {
  const totalSqFt = ROOMS.reduce((s, r) => s + r.w * r.d, 0);
  let wallCount = 0;
  // Outer walls: 2 long + 2 short = 4
  wallCount += 4;
  // Interior walls — count shared edges between rooms
  const interiorEdges = new Set();
  for (let i = 0; i < ROOMS.length; i++) {
    for (let j = i + 1; j < ROOMS.length; j++) {
      const a = ROOMS[i], b = ROOMS[j];
      const ax2 = a.x + a.w, az2 = a.z + a.d;
      const bx2 = b.x + b.w, bz2 = b.z + b.d;
      // Vertical shared edge (same x range, adjacent z)
      if (Math.abs(az2 - b.z) < 0.01 || Math.abs(a.z - bz2) < 0.01) {
        const overlapX = Math.min(ax2, bx2) - Math.max(a.x, b.x);
        if (overlapX > 0) interiorEdges.add(`v-${a.id}-${b.id}`);
      }
      // Horizontal shared edge
      if (Math.abs(ax2 - b.x) < 0.01 || Math.abs(a.x - bx2) < 0.01) {
        const overlapZ = Math.min(az2, bz2) - Math.max(a.z, b.z);
        if (overlapZ > 0) interiorEdges.add(`h-${a.id}-${b.id}`);
      }
    }
  }
  wallCount += interiorEdges.size;
  return { totalSqFt, wallCount };
}
const STATS = computeStats();
document.getElementById('stat-rooms').textContent = ROOMS.length;
document.getElementById('stat-sqft').textContent = STATS.totalSqFt.toLocaleString();
document.getElementById('stat-walls').textContent = STATS.wallCount;

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
// High isometric 3/4 view — sees walls + roof + (through windows) room interiors
camera.position.set(34, 28, 38);
camera.lookAt(23, 4, 15);

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
ssaoPass.kernelRadius = 8;
ssaoPass.minDistance = 0.001;
ssaoPass.maxDistance = 0.05;
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
const slabGeo = new THREE.BoxGeometry(FOOTPRINT_W, FLOOR_T, FOOTPRINT_D);
const slab = new THREE.Mesh(slabGeo, slabMat);
slab.position.set(FOOTPRINT_W/2, -FLOOR_T/2, FOOTPRINT_D/2);
slab.receiveShadow = true;
scene.add(slab);

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
function floorForRoom(room) {
  // Highlighting with emissive so colors stay vivid even under AO darkening
  return new THREE.MeshStandardMaterial({
    color: room.color,
    roughness: 0.7,
    metalness: 0.0,
    envMapIntensity: 0.35,
    emissive: room.color,
    emissiveIntensity: 0.18,
  });
}

// Room floor tiles (slightly raised so each room reads as its own)
ROOMS.forEach((room) => {
  const mat = floorForRoom(room);
  const geo = new THREE.BoxGeometry(room.w - 0.05, 0.02, room.d - 0.05);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.position.set(room.x + room.w/2, 0.01, room.z + room.d/2);
  mesh.name = `floor-${room.id}`;
  mesh.userData.kind = 'floor';
  mesh.userData.roomId = room.id;
  INTERACTABLE.push(mesh);
  scene.add(mesh);
});

// ------------------------------------------------------------
//   WALL HELPER — PBR + baseboards + crown molding
// ------------------------------------------------------------
// Procedural sheetrock texture (subtle stipple)
function makeSheetrockTexture(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2eee5'; ctx.fillRect(0, 0, size, size);
  // subtle stipple
  for (let i = 0; i < 6000; i++) {
    const v = 220 + Math.random() * 30;
    ctx.fillStyle = `rgba(${v},${v-4},${v-12},0.55)`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.4, 1.4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const sheetrockTex = makeSheetrockTexture();

// Wood-grain texture for trim/baseboards (lighter than floor)
function makeTrimTexture(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4a3a2c'; ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 200; i++) {
    ctx.strokeStyle = `rgba(28, 20, 12, ${0.15 + Math.random() * 0.3})`;
    ctx.lineWidth = 0.5 + Math.random();
    ctx.beginPath();
    ctx.moveTo(0, Math.random() * size);
    ctx.bezierCurveTo(
      size * 0.33, Math.random() * size,
      size * 0.66, Math.random() * size,
      size, Math.random() * size
    );
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const trimTex = makeTrimTexture();
const baseboardMat = new THREE.MeshStandardMaterial({
  map: trimTex,
  color: 0xffffff,
  roughness: 0.55,
  metalness: 0.05,
  envMapIntensity: 0.7,
});
const crownMat = new THREE.MeshStandardMaterial({
  map: trimTex,
  color: 0xffffff,
  roughness: 0.5,
  metalness: 0.08,
  envMapIntensity: 0.8,
});
const wallMat = new THREE.MeshStandardMaterial({
  map: sheetrockTex.clone(),
  color: 0xe6dfd0,                 // warm white sheetrock
  roughness: 0.95,
  metalness: 0.0,
  envMapIntensity: 0.25,
});
const wallMatInterior = new THREE.MeshStandardMaterial({
  map: sheetrockTex.clone(),
  color: 0xf3eadd,                 // slightly cooler interior
  roughness: 0.95,
  metalness: 0.0,
  envMapIntensity: 0.2,
});

// Wall inventory collected for the measurement tool
const WALL_MESHES = [];

function addWall(ax, az, aw, ad, isOuter = null) {
  if (isOuter === null) isOuter = (
    (ax === 0) || (ax + aw === FOOTPRINT_W) ||
    (az === 0) || (az + ad === FOOTPRINT_D)
  );
  const mat = isOuter ? wallMat : wallMatInterior;
  const geo = new THREE.BoxGeometry(aw, WALL_H, ad);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(ax + aw/2, WALL_H/2, az + ad/2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = isOuter ? `wall-outer-${ax}-${az}` : `wall-inner-${ax}-${az}`;
  mesh.userData = {
    kind: 'wall',
    isOuter,
    length: Math.max(aw, ad),
    height: WALL_H,
    area: Math.max(aw, ad) * WALL_H * 2,    // both sides
    ax, az, aw, ad,
  };
  WALL_MESHES.push(mesh);
  INTERACTABLE.push(mesh);
  scene.add(mesh);

  // Baseboard — 4" tall, 0.25" thick, hugging the bottom of the wall
  const BASEB_H = 0.35;
  const BASEB_D = 0.05;
  let baseX, baseZ, baseW, baseD;
  if (aw > ad) {
    // Horizontal wall (runs along X)
    baseX = ax + aw/2; baseZ = az + (ad - BASEB_D)/2;
    baseW = aw; baseD = BASEB_D;
  } else {
    // Vertical wall (runs along Z)
    baseX = ax + (aw - BASEB_D)/2; baseZ = az + ad/2;
    baseW = BASEB_D; baseD = ad;
  }
  const baseboard = new THREE.Mesh(
    new THREE.BoxGeometry(baseW, BASEB_H, baseD),
    baseboardMat
  );
  baseboard.position.set(baseX, BASEB_H/2, baseZ);
  baseboard.castShadow = true;
  baseboard.receiveShadow = true;
  scene.add(baseboard);

  // Crown molding — at the top, slightly inset, 5" tall, 1" deep
  const CROWN_H = 0.45;
  const CROWN_D = 0.1;
  let cX, cZ, cW, cD, cY;
  if (aw > ad) {
    cX = ax + aw/2; cZ = az + (ad - CROWN_D)/2;
    cW = aw; cD = CROWN_D;
    cY = WALL_H - CROWN_H/2;
  } else {
    cX = ax + (aw - CROWN_D)/2; cZ = az + ad/2;
    cW = CROWN_D; cD = ad;
    cY = WALL_H - CROWN_H/2;
  }
  const crown = new THREE.Mesh(
    new THREE.BoxGeometry(cW, CROWN_H, cD),
    crownMat
  );
  crown.position.set(cX, cY, cZ);
  crown.castShadow = true;
  crown.receiveShadow = true;
  scene.add(crown);

  return mesh;
}

// Track all wall meshes added (for measurement + estimator)
const addedWalls = [];

// Outer walls (explicit isOuter=true)
addWall(0,             0,              FOOTPRINT_W, WALL_T, true); // south
addWall(0,             FOOTPRINT_D - WALL_T, FOOTPRINT_W, WALL_T, true); // north
addWall(0,             0,              WALL_T, FOOTPRINT_D, true); // west
addWall(FOOTPRINT_W - WALL_T, 0,       WALL_T, FOOTPRINT_D, true); // east

// Track them
addedWalls.push(...WALL_MESHES.slice());

// Interior walls — re-derive from ROOMS adjacency map (re-using computeStats logic)
const interiorWalls = [];
for (let i = 0; i < ROOMS.length; i++) {
  for (let j = i + 1; j < ROOMS.length; j++) {
    const a = ROOMS[i], b = ROOMS[j];
    const ax2 = a.x + a.w, az2 = a.z + a.d;
    const bx2 = b.x + b.w, bz2 = b.z + b.d;
    let added = false;

    // Vertical shared edge (a.z...az2 abuts b.z...bz2)
    if (Math.abs(az2 - b.z) < 0.01) {
      const overlapX = Math.min(ax2, bx2) - Math.max(a.x, b.x);
      if (overlapX > 0) {
        interiorWalls.push({ ax: Math.max(a.x, b.x), az: az2 - WALL_T/2, aw: overlapX, ad: WALL_T });
        added = true;
      }
    }
    if (Math.abs(a.z - bz2) < 0.01 && !added) {
      const overlapX = Math.min(ax2, bx2) - Math.max(a.x, b.x);
      if (overlapX > 0) {
        interiorWalls.push({ ax: Math.max(a.x, b.x), az: a.z - WALL_T/2, aw: overlapX, ad: WALL_T });
        added = true;
      }
    }
    // Horizontal shared edge
    if (Math.abs(ax2 - b.x) < 0.01 && !added) {
      const overlapZ = Math.min(az2, bz2) - Math.max(a.z, b.z);
      if (overlapZ > 0) {
        interiorWalls.push({ ax: ax2 - WALL_T/2, az: Math.max(a.z, b.z), aw: WALL_T, ad: overlapZ });
        added = true;
      }
    }
    if (Math.abs(a.x - bx2) < 0.01 && !added) {
      const overlapZ = Math.min(az2, bz2) - Math.max(a.z, b.z);
      if (overlapZ > 0) {
        interiorWalls.push({ ax: a.x - WALL_T/2, az: Math.max(a.z, b.z), aw: WALL_T, ad: overlapZ });
      }
    }
  }
}
interiorWalls.forEach(w => addWall(w.ax, w.az, w.aw, w.ad, false));

// ------------------------------------------------------------
//   DOORS
//   Each door = a dark frame cutout + a wood plank
// ------------------------------------------------------------
function addDoor(d) {
  const axis = d.axis;
  const halfW = d.w / 2;
  const xc = d.x;
  const zc = d.z;
  const isFlip = !!d.flip;
  const zPos = (axis === 'z') ? (isFlip ? zc + WALL_T/2 : zc - WALL_T/2) : zc;
  const xPos = (axis === 'x') ? zc : xc - halfW;

  // Frame (slightly darker than wall, so it reads as a hole)
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.7 });
  if (axis === 'z') {
    const fH = new THREE.Mesh(new THREE.BoxGeometry(d.w, 0.2, WALL_T * 1.05), frameMat);
    fH.position.set(xc, 0.1, zPos);
    scene.add(fH);
    const fT = new THREE.Mesh(new THREE.BoxGeometry(d.w, 0.2, WALL_T * 1.05), frameMat);
    fT.position.set(xc, WALL_H - 0.1, zPos);
    scene.add(fT);
  } else {
    const fH = new THREE.Mesh(new THREE.BoxGeometry(WALL_T * 1.05, 0.2, d.w), frameMat);
    fH.position.set(xPos + WALL_T/2, 0.1, xc);
    scene.add(fH);
    const fT = new THREE.Mesh(new THREE.BoxGeometry(WALL_T * 1.05, 0.2, d.w), frameMat);
    fT.position.set(xPos + WALL_T/2, WALL_H - 0.1, xc);
    scene.add(fT);
  }

  // Door leaf (wood plank, slightly ajar for visibility)
  const plank = new THREE.Mesh(
    new THREE.BoxGeometry(d.w - 0.1, WALL_H - 0.5, 0.15),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.7 })
  );
  if (axis === 'z') {
    plank.position.set(xc, (WALL_H - 0.5)/2, zPos + (isFlip ? 0.1 : -0.1));
    plank.rotation.y = THREE.MathUtils.degToRad(20);
  } else {
    plank.position.set(xPos + WALL_T/2 + 0.1, (WALL_H - 0.5)/2, xc);
    plank.rotation.y = -Math.PI/2 + THREE.MathUtils.degToRad(-20);
  }
  plank.castShadow = true;
  plank.userData = { kind: 'door', w: d.w, label: d.label, isExterior: d.kind === 'exterior' };
  plank.name = `door-${d.label.toLowerCase().replace(/\s+/g, '-')}`;
  INTERACTABLE.push(plank);
  scene.add(plank);
}
DOORS.forEach(addDoor);

// ------------------------------------------------------------
//   WINDOWS
//   Frame + dark glass pane (slightly inset)
// ------------------------------------------------------------
function addWindow(w) {
  // PBR glass — high reflectivity, smooth
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xaad8ff,
    roughness: 0.02,
    metalness: 0.0,
    transparent: true,
    opacity: 0.55,
    transmission: 0.7,           // PBR transmission (requires physical material)
    ior: 1.45,
    envMapIntensity: 1.5,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xe8e2d4,
    roughness: 0.5,
    metalness: 0.05,
  });
  let glass, frame, sill;
  if (w.axis === 'z') {
    glass = new THREE.Mesh(new THREE.BoxGeometry(w.w, 4, 0.05), glassMat);
    glass.position.set(w.x, 5, w.z);
    scene.add(glass);
    frame = new THREE.Mesh(new THREE.BoxGeometry(w.w, 4.2, WALL_T * 1.05), frameMat);
    frame.position.set(w.x, 5, w.z);
    scene.add(frame);
    sill = new THREE.Mesh(new THREE.BoxGeometry(w.w + 0.3, 0.15, 0.6), crownMat);
    sill.position.set(w.x, 2.9, w.z);
    scene.add(sill);
  } else {
    glass = new THREE.Mesh(new THREE.BoxGeometry(0.05, 4, w.w), glassMat);
    glass.position.set(w.z, 5, w.x);
    scene.add(glass);
    frame = new THREE.Mesh(new THREE.BoxGeometry(WALL_T * 1.05, 4.2, w.w), frameMat);
    frame.position.set(w.z, 5, w.x);
    scene.add(frame);
    sill = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, w.w + 0.3), crownMat);
    sill.position.set(w.z, 2.9, w.x);
    scene.add(sill);
  }
  // Make glass clickable (use the glass mesh as the representer)
  glass.userData = { kind: 'window', w: w.w, label: w.label };
  glass.name = `window-${w.label.toLowerCase().replace(/\s+/g, '-')}`;
  INTERACTABLE.push(glass);
}
WINDOWS.forEach(addWindow);

// ------------------------------------------------------------
//   CEILING (flat — gable is added below)
// ------------------------------------------------------------
const ceiling = new THREE.Mesh(
  new THREE.BoxGeometry(FOOTPRINT_W, 0.1, FOOTPRINT_D),
  new THREE.MeshStandardMaterial({ color: 0xf2eee5, roughness: 0.9 })
);
ceiling.position.set(FOOTPRINT_W/2, WALL_H + 0.05, FOOTPRINT_D/2);
ceiling.castShadow = true;
ceiling.receiveShadow = true;
scene.add(ceiling);

// ------------------------------------------------------------
//   ROOF — gable
// ------------------------------------------------------------
// Procedural asphalt shingle texture
function makeShingleTexture(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  // dark base
  ctx.fillStyle = '#3d2a1c'; ctx.fillRect(0, 0, size, size);
  // overlapping shingles (rows offset)
  const rows = 16;
  const shingleH = size / rows;
  for (let r = 0; r < rows; r++) {
    const yOff = r * shingleH;
    const xStagger = (r % 2) * (size / 2);
    for (let x = -size/2; x < size + size/2; x += size / 4) {
      // 4 shingles per row, half-width each so they overlap
      const baseX = x + xStagger;
      // gradient shingle (lighter at top, darker at bottom)
      const grad = ctx.createLinearGradient(0, yOff, 0, yOff + shingleH);
      grad.addColorStop(0, `rgba(${90 + Math.random()*30}, ${56 + Math.random()*20}, ${32 + Math.random()*15}, 0.95)`);
      grad.addColorStop(1, `rgba(${30 + Math.random()*15}, ${18 + Math.random()*10}, ${10 + Math.random()*8}, 0.95)`);
      ctx.fillStyle = grad;
      ctx.fillRect(baseX, yOff, size / 4 + 4, shingleH + 0.5);
      // shadow line at bottom
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(baseX, yOff + shingleH - 1, size / 4 + 4, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 4);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const shingleTex = makeShingleTexture();

function makeGable() {
  const halfSpan = FOOTPRINT_W / 2;
  const ridgeY = WALL_H + ROOF_PITCH;

  // Build the two slope planes as a single BufferGeometry for clean shadows
  const verts = new Float32Array([
    // West slope (x: 0..halfSpan)
    0,           WALL_H, 0,
    halfSpan,    ridgeY,  0,
    halfSpan,    ridgeY,  FOOTPRINT_D,
    0,           WALL_H, FOOTPRINT_D,
    // East slope (x: halfSpan..FOOTPRINT_W)
    halfSpan,    ridgeY,  0,
    FOOTPRINT_W, WALL_H, 0,
    FOOTPRINT_W, WALL_H, FOOTPRINT_D,
    halfSpan,    ridgeY,  FOOTPRINT_D,
  ]);
  const idx = [
    0,1,2, 0,2,3,        // west slope (normal facing up-out)
    4,5,6, 4,6,7,        // east slope
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Double-sided so we can also see the roof from inside if camera enters
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      map: shingleTex,
      color: 0x6b4632,
      roughness: 0.85,
      metalness: 0.0,
      envMapIntensity: 0.5,
      side: THREE.DoubleSide,
      transparent: false,
    })
  );
}
const roof = makeGable();
roof.castShadow = true;
roof.receiveShadow = true;
roof.name = 'roof';
roof.userData = {
  kind: 'roof',
  area: 2 * FOOTPRINT_D * Math.sqrt(Math.pow(FOOTPRINT_W/2, 2) + Math.pow(ROOF_PITCH, 2)),
  pitchRise: ROOF_PITCH,
  pitchRun: FOOTPRINT_W / 2,
};
INTERACTABLE.push(roof);
scene.add(roof);

// Gable ends (triangle facias): same sheetrock PBR
const gableMat = new THREE.MeshStandardMaterial({
  map: sheetrockTex.clone(),
  color: 0xebe0d0,
  roughness: 0.95,
  metalness: 0.0,
  envMapIntensity: 0.3,
});
{
  // South gable
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, WALL_H, 0,
    FOOTPRINT_W, WALL_H, 0,
    FOOTPRINT_W/2, WALL_H + ROOF_PITCH, 0,
  ]), 3));
  sGeo.setIndex([0,1,2]);
  sGeo.computeVertexNormals();
  const s = new THREE.Mesh(sGeo, gableMat);
  s.position.z = 0;
  scene.add(s);

  // North gable
  const nGeo = new THREE.BufferGeometry();
  nGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, WALL_H, 0,
    FOOTPRINT_W/2, WALL_H + ROOF_PITCH, 0,
    FOOTPRINT_W, WALL_H, 0,
  ]), 3));
  nGeo.setIndex([0,1,2]);
  nGeo.computeVertexNormals();
  const n = new THREE.Mesh(nGeo, gableMat);
  n.position.z = FOOTPRINT_D;
  scene.add(n);
}

// ------------------------------------------------------------
//   FURNITURE (lightweight proxies — read "this is a room")
// ------------------------------------------------------------
const matCouch = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.8 });
const matBed = new THREE.MeshStandardMaterial({ color: 0x9b8f8a, roughness: 0.85 });
const matFridge = new THREE.MeshStandardMaterial({ color: 0xdde0e3, roughness: 0.4, metalness: 0.4 });
const matTable = new THREE.MeshStandardMaterial({ color: 0xa87f4a, roughness: 0.7 });
const matToilet = new THREE.MeshStandardMaterial({ color: 0xf6f4ee, roughness: 0.3 });
const matRug = new THREE.MeshStandardMaterial({ color: 0xa14b30, roughness: 0.95 });

function addBox(parent, w, h, d, mat, pos) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(pos[0], pos[1], pos[2]);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

// Living
const living = new THREE.Group();
addBox(living, 8, 1.5, 3, matCouch, [10, 0.75, 6]);
addBox(living, 5, 1, 4, matRug, [9, 0.51, 9]);  // rug under the couch
addBox(living, 4, 0.8, 2, matTable, [10, 0.4, 11]);
scene.add(living);

// Kitchen
const kitchen = new THREE.Group();
addBox(kitchen, 0.8, 3.2, 12, matTable, [27, 1.6, 9]);   // island
addBox(kitchen, 5, 3, 2.2, matFridge, [22, 1.5, 14]);
addBox(kitchen, 8, 2, 1.8, new THREE.MeshStandardMaterial({ color: 0x6b5340, roughness: 0.7 }), [27, 1, 1]);
scene.add(kitchen);

// Master
const master = new THREE.Group();
addBox(master, 6, 2, 7, matBed, [40, 1, 9]);
addBox(master, 2, 1.5, 2, matTable, [44, 0.75, 14]);
scene.add(master);

// Bed 2 / 3
const bed2 = new THREE.Group();
addBox(bed2, 5, 2, 6, matBed, [7, 1, 24]);
scene.add(bed2);

const bed3 = new THREE.Group();
addBox(bed3, 5, 2, 6, matBed, [20, 1, 24]);
scene.add(bed3);

// Bathroom
const bath = new THREE.Group();
addBox(bath, 1.5, 1, 2, matToilet, [29, 0.5, 26]);
addBox(bath, 4, 1.8, 2, matTable, [29, 0.9, 22]);
scene.add(bath);

// ------------------------------------------------------------
//   ROOM LABELS — CSS2D  (visible only in orbit mode)
// ------------------------------------------------------------
function makeLabel(room) {
  const el = document.createElement('div');
  el.className = 'room-label';
  el.innerHTML = `<span class="rl-name">${room.name}</span><span class="rl-area">${room.w * room.d} sq ft</span>`;
  const obj = new CSS2DObject(el);
  // Place the label at the floor level (y=0.1) so it always floats just above the room
  // and is clearly visible from any orbit angle (including looking down at the roof)
  obj.position.set(room.x + room.w/2, 0.1, room.z + room.d/2);
  obj.userData.roomId = room.id;
  return obj;
}
const labels = ROOMS.map(makeLabel);
labels.forEach(l => scene.add(l));

// ------------------------------------------------------------
//   CONTROLS — orbit vs. walk
// ------------------------------------------------------------
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(23, 4, 15);
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
  // Re-aim at the house — high 3/4 isometric (back to v0.1 view)
  orbit.target.set(23, 4, 15);
  camera.position.set(34, 28, 38);
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
labels.forEach(l => l.visible = true);

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
[...DOORS.map(d => ({...d, kind: d.kind})), ...WINDOWS.map(w => ({...w, kind: 'window'}))].forEach(o => {
  const li = document.createElement('li');
  li.className = 'op-row';
  const isDoor = 'kind' in o && (o.kind === 'exterior' || o.kind === 'interior');
  li.innerHTML = `
    <span class="op-icon">${isDoor ? '🚪' : '🪟'}</span>
    <div class="op-text">
      <strong>${o.label}</strong>
      <span>${o.w}' wide · ${isDoor && o.kind === 'exterior' ? 'exterior' : isDoor ? 'interior' : 'window'}</span>
    </div>
  `;
  openingsList.appendChild(li);
});

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
    return {
      title: u.isOuter ? 'Exterior Wall' : 'Interior Wall',
      rows: [
        ['Length',  `${u.length.toFixed(1)} ft`],
        ['Height',  `${u.height.toFixed(1)} ft`],
        ['Both sides area', `${u.area.toFixed(0)} sq ft`],
        ['Drywall', `~${(u.area * 0.95).toFixed(0)} sq ft (${u.isOuter ? '2 sides incl. exterior wrap' : '2 sides'})`],
      ],
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
  const roofArea = roof.userData.area;

  // Industry rules of thumb:
  //   Drywall: ~$1.50/sqft installed (avg 1/2" board). 4x8 sheet = 32 sqft, $15-25/sheet
  //   Paint: ~350 sqft/gallon per coat (2 coats typical → 175 sqft/gallon finished)
  //   Framing lumber: 2x4 @ 16" OC, plate + studs ≈ 4.5 board feet per sqft wall area
  //   Roofing: 3 bundles per square (100 sqft), $35-50/bundle
  //   Concrete slab: avg $5/sqft installed in Houston
  const drywallSqFt = interiorWallArea;
  const drywallSheets = Math.ceil(drywallSqFt / 32);
  const paintGallons = Math.ceil(drywallSqFt / 175);
  const lumberBF = Math.round(interiorWallArea * 4.5);
  const roofSquares = roofArea / 100;
  const shingleBundles = Math.ceil(roofSquares * 3);

  // Cost ranges (Texas/Houston 2026 mid-range)
  const cost = {
    drywall:  Math.round(drywallSheets * 22),
    paint:    Math.round(paintGallons * 45),
    lumber:   Math.round(lumberBF * 1.10),
    shingles: Math.round(shingleBundles * 42),
    slab:     Math.round(totalFloorSqFt * 5),
  };
  cost.total = cost.drywall + cost.paint + cost.lumber + cost.shingles + cost.slab;

  return {
    totalFloorSqFt,
    totalWallArea,
    interiorWallArea,
    exteriorWallArea,
    roofArea,
    drywallSqFt,
    drywallSheets,
    paintGallons,
    lumberBF,
    roofSquares,
    shingleBundles,
    cost,
  };
}
const ESTIMATE = computeEstimate();

// Populate the estimator panel
function fillEstimate() {
  const e = ESTIMATE;
  const $ = id => document.getElementById(id);
  $('est-floor').textContent     = `${e.totalFloorSqFt.toLocaleString()} sq ft`;
  $('est-wall').textContent      = `${e.totalWallArea.toFixed(0)} sq ft`;
  $('est-wall-int').textContent  = `${e.interiorWallArea.toFixed(0)} sq ft`;
  $('est-roof').textContent      = `${e.roofArea.toFixed(0)} sq ft`;
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
  $('cost-total').textContent    = `$${e.cost.total.toLocaleString()}`;
}
fillEstimate();

// ------------------------------------------------------------
//   GLB EXPORT — download the whole scene as a .glb
// ------------------------------------------------------------
document.getElementById('btn-glb').addEventListener('click', () => {
  const exporter = new GLTFExporter();
  exporter.parse(
    scene,
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

// ------------------------------------------------------------
//   RENDER LOOP
// ------------------------------------------------------------
const clock = new THREE.Clock();

// Simple collision: clamp walk pos to stay inside the footprint + inside walls
function collide(pos) {
  // Hard walls: outside the footprint
  pos.x = Math.max(0.5, Math.min(FOOTPRINT_W - 0.5, pos.x));
  pos.z = Math.max(0.5, Math.min(FOOTPRINT_D - 0.5, pos.z));
  pos.y = 5.5;
  // (Could intersect interior walls here — for v0 we let the user walk freely.)
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

// Debug hook — toggle post-processing on/off from console: GENESIS.togglePost()
window.GENESIS = {
  scene, camera, orbit, ROOMS, DOORS, WINDOWS, STATS,
  composer, ssaoPass, outlinePass,
  togglePost() { this.composer.enabled = !this.composer.enabled; },
};
