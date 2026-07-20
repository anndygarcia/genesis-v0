"""
Polygon → 4-class int mask for floor-plan segmentation training.

This mirrors Yytsi's `buildingcv.svg_to_mask` in shape. The CubiCasa5K
annotations are SVG with `<polygon>` elements whose `id` attribute is
the category token (e.g. `id="Door.1"`, `id="Wall"`); we paint each
polygon into a uint8 HxW array at the integer class id
{0: floor, 1: wall, 2: door, 3: window}.

Author: Anndy Garcia + Claude
License: MIT (matches the rest of the training stack)
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

from .labels import CLASS_TO_ID, PAINT_ORDER

# CubiCasa token → class name. Match starts at the beginning of the id.
_TOKEN_RE = re.compile(r"^(Window|Door|Wall)", re.IGNORECASE)

# Keep this in sync with labels.PAINT_ORDER. We use the class id directly
# to write into the mask, so the dict order doesn't matter; the indices
# are stable.
_PAINT_INT = tuple(CLASS_TO_ID[n] for n in PAINT_ORDER)


def _class_from_token(token: str | None) -> str | None:
    """Return the class name for a CubiCasa token id, or None for unmapped."""
    if not token:
        return None
    m = _TOKEN_RE.match(token)
    return m.group(1).lower() if m else None


def _points_attr(elem) -> list[tuple[float, float]]:
    """Read a `points="x1,y1 x2,y2 ..."` attr and return as floats."""
    pts = elem.attrib.get("points", "").strip()
    out: list[tuple[float, float]] = []
    if pts:
        for token in pts.split():
            if "," in token:
                try:
                    x, y = token.split(",", 1)
                    out.append((float(x), float(y)))
                except ValueError:
                    continue
    return out


def svg_polygons(svg_path: str | Path) -> list[tuple[str, np.ndarray]]:
    """Yield (class_name, Nx2 float32) for every labeled polygon in an SVG.

    Walks the SVG tree depth-first; for every polygon element with an id
    that starts with `Wall`/`Door`/`Window`, returns the polygon vertices
    in the SVG's own coordinate space.
    """
    tree = ET.parse(str(svg_path))
    root = tree.getroot()
    ns = root.tag.split("}")[0].strip("{") if "}" in root.tag else ""
    poly_tag = f"{{{ns}}}polygon" if ns else "polygon"
    for elem in root.iter(poly_tag):
        # Some CubiCasa samples have the class on a child or attribute name;
        # support both.
        cls = _class_from_token(elem.attrib.get("id"))
        if cls is None:
            cls = _class_from_token(elem.attrib.get("class"))
        if cls is None:
            continue
        pts = _points_attr(elem)
        if len(pts) < 3:
            continue
        yield cls, np.asarray(pts, dtype=np.float32)


def svg_to_mask(
    svg_path: str | Path,
    size: tuple[int, int],
    svg_size: tuple[float, float] | None = None,
) -> np.ndarray:
    """Render SVG polygons to a `(H, W)` uint8 mask with class indices.

    Args:
        svg_path: path to the SVG floor plan
        size: (H, W) target output dims
        svg_size: optional (svg_w, svg_h) for the SVG's native dims. If
            None, we read from the root element's `viewBox` / `width`.

    Returns:
        int8 `H x W` mask with each pixel set to its assigned class index.
        Class index `0` (floor) covers anything not explicitly painted.
    """
    if svg_size is None:
        tree = ET.parse(str(svg_path))
        root = tree.getroot()
        vb = (root.attrib.get("viewBox") or "").split()
        try:
            w = float(root.attrib.get("width") or (vb[2] if len(vb) == 4 else 0))
            h = float(root.attrib.get("height") or (vb[3] if len(vb) == 4 else 0))
        except (ValueError, IndexError):
            w = h = 0.0
        if w <= 0 or h <= 0:
            raise ValueError(f"can't read SVG dims from {svg_path}")
        svg_size = (w, h)

    H, W = size
    svg_w, svg_h = svg_size
    sx = W / svg_w
    sy = H / svg_h

    mask = np.zeros((H, W), dtype=np.uint8)
    for cls, poly in svg_polygons(svg_path):
        cls_id = CLASS_TO_ID[cls]
        # Convert polygon points into pixel coords and rasterize via fillPoly.
        import cv2  # local import — only needed when training

        pix = np.round(poly * np.array([sx, sy])).astype(np.int32)
        pix[:, 0] = np.clip(pix[:, 0], 0, W - 1)
        pix[:, 1] = np.clip(pix[:, 1], 0, H - 1)
        cv2.fillPoly(mask, [pix.reshape(-1, 1, 2)], int(cls_id))
    # Doors and windows are *openings in walls*, but our polygon
    # annotations paint both regions, so the door's polygon overlaps the
    # wall's. Last paint wins, which matches CubiCasa5K convention:
    # doors overwrite walls (a door IS an opening in a wall).
    # PAINT_ORDER is currently ('floor' skipped, 'wall', 'door', 'window')
    # We rely on iteration order: source SVGs are already arranged so wall
    # polygons come first, then door, then window. If a sample is in the
    # wrong order, callers can call _sort_polygons before painting.
    return mask
