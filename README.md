# Genesis · v0

Self-contained 3D property reconstruction demo. Single HTML file, Three.js on CDN, no build step.

## What's here

- **Live 3D viewer** — 6-room home, gable roof, 24 walls, doors + windows, furniture proxies
- **Orbit camera** (drag, scroll, right-drag to pan) — default
- **Walk camera** — click "Walk inside", capture mouse, use **WASD** to move, **Esc** to exit
- **Room labels** floating above each room in 3D (CSS2DRenderer)
- **Live stats** — rooms, sq ft, wall count update on load
- **Side panel** — sortable rooms list, openings (doors/windows) inventory

## File layout

```
genesis-v0/
├── index.html      # landing + demo + how + roadmap + CTA + footer
├── app.js          # Three.js scene, geometry, cameras
├── styles.css      # dark-mode SaaS
├── README.md
└── assets/
```

## Run locally

```bash
cd ~/genesis-v0
python3 -m http.server 8765
# → open http://localhost:8765/
```

The page uses Three.js 0.160 from unpkg via an importmap, so it needs to be served over HTTP (not file://).

## Roadmap

| Version | What's coming |
|---|---|
| v0 (today) | Demo: procedural 3D home + viewer |
| v1 | Real PDF / DWG ingestion → wall/door/window detection |
| v2 | Material library + textures |
| v3 | Export to GLB, IFC, PDF |

## Notes

- All numbers are real (sq ft, wall count) — the engine computes them from the floor plan, not faked.
- Procedural plan lives at top of `app.js` (ROOMS array). To add a room, push another `{ id, name, x, z, w, d, color, accent }`.
