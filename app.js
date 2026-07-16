// =============================================================
//   GENESIS · v0
//   Procedural 3D home — Three.js single-file demo
//   6 rooms, 24 walls, gable roof, orbit + walk cameras
// =============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

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
scene.add(sun);

const fillLight = new THREE.DirectionalLight(0x88aaff, 0.35);
fillLight.position.set(-30, 20, -10);
scene.add(fillLight);

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
const slabMat = new THREE.MeshStandardMaterial({ color: 0xc9c4ba, roughness: 0.85, metalness: 0.0 });
const slabGeo = new THREE.BoxGeometry(FOOTPRINT_W, FLOOR_T, FOOTPRINT_D);
const slab = new THREE.Mesh(slabGeo, slabMat);
slab.position.set(FOOTPRINT_W/2, -FLOOR_T/2, FOOTPRINT_D/2);
slab.receiveShadow = true;
scene.add(slab);

// Room floor tiles (slightly raised so each room reads as its own)
ROOMS.forEach((room) => {
  const mat = new THREE.MeshStandardMaterial({
    color: room.color, roughness: 0.85, metalness: 0.0
  });
  const geo = new THREE.BoxGeometry(room.w - 0.05, 0.02, room.d - 0.05);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(room.x + room.w/2, 0.01, room.z + room.d/2);
  mesh.receiveShadow = true;
  scene.add(mesh);
});

// ------------------------------------------------------------
//   WALL HELPER
// ------------------------------------------------------------
const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2eee5, roughness: 0.85, metalness: 0.0 });
const wallMatInterior = new THREE.MeshStandardMaterial({ color: 0xece4d3, roughness: 0.85, metalness: 0.0 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.5, metalness: 0.0 });

function addWall(ax, az, aw, ad) {  // axis-aligned wall as a 0.5ft thick box
  const isOuter = (
    (ax === 0) || (ax + aw === FOOTPRINT_W) ||
    (az === 0) || (az + ad === FOOTPRINT_D)
  );
  const mat = isOuter ? wallMat : wallMatInterior;
  const geo = new THREE.BoxGeometry(aw, WALL_H, ad);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(ax + aw/2, WALL_H/2, az + ad/2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Trim along the top
  const trimGeo = new THREE.BoxGeometry(aw, 0.15, ad);
  const trim = new THREE.Mesh(trimGeo, trimMat);
  trim.position.set(ax + aw/2, WALL_H - 0.075, az + ad/2);
  scene.add(trim);

  return mesh;
}

// Outer walls
addWall(0,             0,              FOOTPRINT_W, WALL_T); // south
addWall(0,             FOOTPRINT_D - WALL_T, FOOTPRINT_W, WALL_T); // north
addWall(0,             0,              WALL_T, FOOTPRINT_D); // west
addWall(FOOTPRINT_W - WALL_T, 0,       WALL_T, FOOTPRINT_D); // east

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
interiorWalls.forEach(w => addWall(w.ax, w.az, w.aw, w.ad));

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
  scene.add(plank);
}
DOORS.forEach(addDoor);

// ------------------------------------------------------------
//   WINDOWS
//   Frame + dark glass pane (slightly inset)
// ------------------------------------------------------------
function addWindow(w) {
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x88c4ff,
    roughness: 0.05,
    metalness: 0.6,
    transparent: true,
    opacity: 0.6,
  });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.4 });
  if (w.axis === 'z') {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(w.w, 4, 0.05), glassMat);
    glass.position.set(w.x, 5, w.z);
    scene.add(glass);
    const f = new THREE.Mesh(new THREE.BoxGeometry(w.w, 4.2, WALL_T * 1.05), frameMat);
    f.position.set(w.x, 5, w.z);
    scene.add(f);
    // sill
    const sill = new THREE.Mesh(new THREE.BoxGeometry(w.w + 0.3, 0.15, 0.6), trimMat);
    sill.position.set(w.x, 2.9, w.z);
    scene.add(sill);
  } else {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.05, 4, w.w), glassMat);
    glass.position.set(w.z, 5, w.x);
    scene.add(glass);
    const f = new THREE.Mesh(new THREE.BoxGeometry(WALL_T * 1.05, 4.2, w.w), frameMat);
    f.position.set(w.z, 5, w.x);
    scene.add(f);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, w.w + 0.3), trimMat);
    sill.position.set(w.z, 2.9, w.x);
    scene.add(sill);
  }
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
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x4a4035, roughness: 0.6 })
  );
}
const roof = makeGable();
roof.castShadow = true;
roof.receiveShadow = true;
scene.add(roof);

// Roof trim along the gable ends (triangular fronts)
const gableMat = new THREE.MeshStandardMaterial({ color: 0xebe0d0, roughness: 0.9 });
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
  obj.position.set(room.x + room.w/2, WALL_H + 0.4, room.z + room.d/2);
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
  // Re-aim at the house
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
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

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

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

// Expose for debugging
window.GENESIS = { scene, camera, orbit, ROOMS, DOORS, WINDOWS, STATS };
