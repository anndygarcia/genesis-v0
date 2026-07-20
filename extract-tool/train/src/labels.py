"""Class taxonomy for floor-plan segmentation.

Mirrors Yytsi's `buildingcv.labels`. Four classes:
- floor (id 0) — default fill for anything not painted by other classes
- wall (id 1) — solid walls
- door  (id 2) — openings in walls; paint order: AFTER wall, so doors overwrite
- window(id 3) — wall openings with glass; paint order: AFTER door
"""

CLASS_NAMES: tuple[str, ...] = ("floor", "wall", "door", "window")
CLASS_TO_ID: dict[str, int] = {n: i for i, n in enumerate(CLASS_NAMES)}
NUM_CLASSES: int = len(CLASS_NAMES)
FLOOR_ID: int = CLASS_TO_ID["floor"]

# Order in which non-floor polygons are painted onto the mask.
# Later paint overwrites earlier (so doors overwrite walls where they
# intersect — which is correct: a door IS an opening in a wall).
PAINT_ORDER: tuple[str, ...] = ("wall", "door", "window")

# RGB triple for visualization only.
CLASS_COLORS: dict[str, tuple[int, int, int]] = {
    "floor": (240, 240, 235),
    "wall": (40, 40, 45),
    "door": (230, 120, 50),
    "window": (60, 150, 220),
}
