"""
Unified dataset adapter for floor-plan segmentation training.

Supports three input modes (set by `--data-mode` on the CLI):

1. `cubi`   — CubiCasa5K SVG dataset with `model.svg` per sample.
              Source: https://github.com/cubicasa/cubicasa5k  (Zenodo mirror).
              This is what Yytsi's release model was trained on. We use it
              for cold-start training or as a fallback for fine-tuning.

2. `garcia` — A user-provided directory of Garcia-style floor plans. Each
              sample is either a `.pdf` (raster-priority, falls back to vector)
              or a `.svg` with `<polygon>` annotations in the CubiCasa
              token format (`Wall`, `Door`, `Window`, ...). For PDFs we
              generate masks from the model output — this requires that the
              user has labeled the plan externally (Labelbox, Roboflow, etc.).

3. `mixed`  — `cubi` train set + `garcia` train set concatenated. Useful for
              warm-starting the model on its original domain while shifting
              towards Garcia-style conventions.

The dataset returns `(image, mask)` tensors with the same shape as Yytsi's
CubiCasaDataset, so the existing `train.py` (resumed from Yytsi's repo) can
consume us transparently.
"""
from __future__ import annotations

import re
import shutil
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Callable, Iterable

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset

from .labels import FLOOR_ID

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


@dataclass
class Sample:
    """A (label_path, mask_source) pair where mask_source says how to derive mask.

    label_path: str — file that we open to derive both the input image and the mask
    mask_source: 'svg' | 'png_pair' | 'pdf'
        - 'svg'      — render SVG to PNG via cairosvg, parse SVG polygons for mask
        - 'png_pair' — the input is a PNG/JPEG; a sibling .png file with `_mask`
                        suffix contains the per-pixel class indices as L-mode
        - 'pdf'      — render PDF page 1 to canvas (raster or vector); mask must
                        come from a sibling .json with polygons
    """
    label_path: Path
    mask_source: str


class _CubicasaPairsBase:
    """Shared logic for finding CubiCasa-style SVGs in a split file."""

    data_dir: Path
    split: str

    def _discover(self) -> list[Sample]:
        path = Path(self.data_dir)
        samples: list[Sample] = []
        if not path.exists():
            return samples
        # CubiCasa5K layout: data_dir/<id>/model.svg  +  data_dir/train.txt
        split_file = path / f"{self.split}.txt"
        if split_file.exists():
            rels = [
                ln.strip().strip("/")
                for ln in split_file.read_text().splitlines()
                if ln.strip()
            ]
            for r in rels:
                p = path / r / "model.svg"
                if p.exists():
                    samples.append(Sample(p, "svg"))
        else:
            # No split file: walk everything.
            for svg in path.rglob("model.svg"):
                samples.append(Sample(svg, "svg"))
        return samples


class CubicasaAdapter(_CubicasaPairsBase, Dataset):
    """Adapter wrapping the original CubiCasa5K layout (model.svg + split.txt)."""

    def __init__(
        self,
        data_dir: str | Path,
        split: str = "train",
        size: tuple[int, int] = (512, 512),
        normalize: bool = True,
        letterbox: bool = True,
    ):
        self.data_dir = Path(data_dir)
        self.split = split
        self.size = size
        self.normalize = normalize
        self.letterbox = letterbox
        self._mean = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
        self._std = torch.tensor(IMAGENET_STD).view(3, 1, 1)
        self.samples = self._discover()
        self._bad: set[int] = set()

    def __len__(self) -> int:
        return len(self.samples)

    def _read_svg_dims(self, svg_path: Path) -> tuple[float, float]:
        root = ET.parse(str(svg_path)).getroot()
        vb = (root.attrib.get("viewBox") or "").split()
        try:
            w = float(root.attrib.get("width") or (vb[2] if len(vb) == 4 else 0))
            h = float(root.attrib.get("height") or (vb[3] if len(vb) == 4 else 0))
        except (ValueError, IndexError):
            w = h = 0.0
        if w <= 0 or h <= 0:
            raise ValueError(f"no SVG dims in {svg_path}")
        return w, h

    def _load(self, idx: int):
        sample = self.samples[idx]
        svg_path = sample.label_path
        H, W = self.size
        import cairosvg
        from .svg_to_mask import svg_to_mask

        if self.letterbox:
            svg_w, svg_h = self._read_svg_dims(svg_path)
            scale = min(W / svg_w, H / svg_h)
            inner_w = max(1, int(round(svg_w * scale)))
            inner_h = max(1, int(round(svg_h * scale)))
        else:
            inner_w, inner_h = W, H

        png_bytes = BytesIO(
            cairosvg.svg2png(url=str(svg_path), output_width=inner_w, output_height=inner_h)
        ).getvalue()
        img = np.array(Image.open(BytesIO(png_bytes)).convert("RGB"))
        mask = svg_to_mask(svg_path, size=(inner_h, inner_w), svg_size=(svg_w, svg_h) if self.letterbox else None)

        image_t = torch.from_numpy(img).permute(2, 0, 1).contiguous().float().div_(255.0)
        if self.normalize:
            image_t = (image_t - self._mean) / self._std
        mask_t = torch.from_numpy(mask).long()

        if self.letterbox and (inner_h, inner_w) != (H, W):
            top = (H - inner_h) // 2
            left = (W - inner_w) // 2
            canvas_img = torch.zeros(3, H, W) if not self.normalize else torch.zeros(3, H, W)
            canvas_mask = torch.full((H, W), FLOOR_ID, dtype=torch.long)
            canvas_img[:, top : top + inner_h, left : left + inner_w] = image_t
            canvas_mask[top : top + inner_h, left : left + inner_w] = mask_t
            return canvas_img, canvas_mask
        return image_t, mask_t

    def __getitem__(self, idx: int):
        n = len(self.samples)
        for offset in range(n):
            i = (idx + offset) % n
            try:
                return self._load(i)
            except Exception as e:
                if i not in self._bad:
                    self._bad.add(i)
                    print(
                        f"[CubicasaAdapter] skipping bad {self.samples[i].label_path}: {e}",
                        file=sys.stderr,
                    )
                continue
        raise RuntimeError("every sample failed to load")


class GarciaPairAdapter(Dataset):
    """Adapter for user-provided Garcia-style plan directories.

    Each sample is a folder (or a flat layout) with:
        <plan_id>/
            plan.pdf           # the actual blueprint, OR plan.svg
            polygons.svg       # with <polygon id="Wall ..."/> etc. (CubiCasa tokens)
            OR
            plan.png           # when only raster is available
            plan_mask.png      # L-mode, indices 0..3

    Plus a single `manifest.csv` next to the data_dir with one row per
    plan: plan_id, kind, [extra columns ignored].

    Layout:
        garcia_dir/
            manifest.csv
            100_kitchen/
                plan.pdf
                polygons.svg
            101_bedroom/
                plan.png
                plan_mask.png

    PDFs we render at training time (page 1 → PNG) via pdf2image or
    pdf.js in Node. For Colab we use pdf2image.
    """

    def __init__(
        self,
        data_dir: str | Path,
        size: tuple[int, int] = (512, 512),
        normalize: bool = True,
        letterbox: bool = True,
    ):
        self.data_dir = Path(data_dir)
        self.size = size
        self.normalize = normalize
        self.letterbox = letterbox
        self._mean = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
        self._std = torch.tensor(IMAGENET_STD).view(3, 1, 1)
        self.samples = self._discover()
        if not self.samples:
            print(
                f"[GarciaPairAdapter] no plans found under {data_dir}. Expected a "
                f"manifest.csv with one row per plan, OR directories each with "
                f"plan.pdf or plan.png at the top of {data_dir}.",
                file=sys.stderr,
            )

    def _discover(self) -> list[dict]:
        samples: list[dict] = []
        path = self.data_dir
        if not path.exists():
            return samples

        # Layout 1: manifest.csv
        manifest = path / "manifest.csv"
        if manifest.exists():
            import csv
            with manifest.open() as f:
                rdr = csv.DictReader(f)
                for r in rdr:
                    samples.append({"id": r.get("plan_id") or r.get("id"), **r})
            return [
                s for s in samples
                if (self.data_dir / str(s.get("id", ""))).exists()
            ]

        # Layout 2: subdirs containing plan.{pdf|svg|png}
        for sub in sorted(path.iterdir()):
            if not sub.is_dir():
                continue
            pdf = sub / "plan.pdf"
            svg = sub / "plan.svg"
            png = sub / "plan.png"
            poly_svg = sub / "polygons.svg"
            mask_png = sub / "plan_mask.png"
            entry: dict = {"id": sub.name}
            if pdf.exists() and poly_svg.exists():
                entry["input"] = pdf
                entry["mask_source"] = "svg"
                entry["polygons"] = poly_svg
            elif svg.exists():
                entry["input"] = svg
                entry["mask_source"] = "svg_inline"
            elif png.exists() and mask_png.exists():
                entry["input"] = png
                entry["mask_source"] = "png_pair"
                entry["mask"] = mask_png
            else:
                continue
            samples.append(entry)
        return samples

    def __len__(self) -> int:
        return len(self.samples)

    def _render_pdf_first_page(self, pdf_path: Path, w: int, h: int) -> Image.Image:
        # pdf2image requires poppler; on Colab we apt-install it in the
        # notebook. For local runs we fall back to PyMuPDF if available.
        try:
            from pdf2image import convert_from_path
            pages = convert_from_path(str(pdf_path), dpi=200, first_page=1, last_page=1)
            img = pages[0].convert("RGB")
            img.thumbnail((w, h), Image.LANCZOS)
            canvas = Image.new("RGB", (w, h), (255, 255, 255))
            canvas.paste(img, ((w - img.width) // 2, (h - img.height) // 2))
            return canvas
        except Exception:
            pass
        # Fallback: PyMuPDF
        try:
            import fitz  # type: ignore
            doc = fitz.open(str(pdf_path))
            page = doc[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
            from io import BytesIO as _B
            img = Image.open(_B(pix.tobytes("png"))).convert("RGB")
            img.thumbnail((w, h), Image.LANCZOS)
            canvas = Image.new("RGB", (w, h), (255, 255, 255))
            canvas.paste(img, ((w - img.width) // 2, (h - img.height) // 2))
            return canvas
        except Exception as e:
            raise RuntimeError(f"can't render PDF {pdf_path}: {e}")

    def _load(self, idx: int):
        s = self.samples[idx]
        H, W = self.size
        kind = s["mask_source"]
        input_path: Path = Path(s["input"])

        if kind in ("svg", "svg_inline"):
            import cairosvg
            svg = input_path if kind == "svg_inline" else input_path
            # Use full SVG dims for input
            root = ET.parse(str(svg)).getroot()
            vb = (root.attrib.get("viewBox") or "").split()
            svg_w = float(root.attrib.get("width") or vb[2])
            svg_h = float(root.attrib.get("height") or vb[3])
            if self.letterbox:
                scale = min(W / svg_w, H / svg_h)
                inner_w = max(1, int(round(svg_w * scale)))
                inner_h = max(1, int(round(svg_h * scale)))
            else:
                inner_w, inner_h = W, H
            png_bytes = BytesIO(
                cairosvg.svg2png(url=str(svg), output_width=inner_w, output_height=inner_h)
            ).getvalue()
            img = np.array(Image.open(BytesIO(png_bytes)).convert("RGB"))
            # Mask comes from polygon sibling if not inline
            if kind == "svg_inline":
                from .svg_to_mask import svg_to_mask
                mask = svg_to_mask(svg, size=(inner_h, inner_w), svg_size=(svg_w, svg_h))
            else:
                poly = Path(s["polygons"])
                from .svg_to_mask import svg_to_mask
                mask = svg_to_mask(poly, size=(inner_h, inner_w), svg_size=(svg_w, svg_h))

        elif kind == "png_pair":
            img = np.array(Image.open(str(input_path)).convert("RGB"))
            mask = np.array(Image.open(str(Path(s["mask"]))).convert("L"))
            ih, iw = img.shape[:2]
            if (iw, ih) != (W, H):
                # Letterbox pad to target size
                sx, sy = W / iw, H / ih
                scale = min(sx, sy)
                inner_w, inner_h = max(1, int(round(iw * scale))), max(1, int(round(ih * scale)))
                img_img = Image.fromarray(img).resize((inner_w, inner_h), Image.LANCZOS)
                m_img = Image.fromarray(mask).resize((inner_w, inner_h), Image.NEAREST)
                canvas_i = Image.new("RGB", (W, H), (255, 255, 255))
                canvas_m = Image.new("L", (W, H), 0)
                canvas_i.paste(img_img, ((W - inner_w) // 2, (H - inner_h) // 2))
                canvas_m.paste(m_img, ((W - inner_w) // 2, (H - inner_h) // 2))
                img = np.array(canvas_i)
                mask = np.array(canvas_m)
                inner_w, inner_h = W, H
            else:
                inner_w, inner_h = W, H
        elif kind == "pdf":
            img = self._render_pdf_first_page(input_path, W, H)
            img = np.array(img)
            # Mask must come from polygons sidecar
            poly = input_path.parent / "polygons.svg"
            if not poly.exists():
                raise FileNotFoundError(f"PDF mode requires polygons.svg next to {input_path}")
            svg_w, svg_h = self._read_svg_dims_for_pdf(pdf_path=input_path, poly=poly)
            from .svg_to_mask import svg_to_mask
            mask = svg_to_mask(poly, size=(H, W), svg_size=(svg_w, svg_h))
            inner_w, inner_h = W, H
        else:
            raise ValueError(f"unknown mask_source {kind}")

        image_t = torch.from_numpy(img).permute(2, 0, 1).contiguous().float().div_(255.0)
        if self.normalize:
            image_t = (image_t - self._mean) / self._std
        mask_t = torch.from_numpy(mask).long()

        if self.letterbox and (inner_h, inner_w) != (H, W):
            top = (H - inner_h) // 2
            left = (W - inner_w) // 2
            canvas_img = torch.zeros(3, H, W)
            canvas_mask = torch.full((H, W), FLOOR_ID, dtype=torch.long)
            canvas_img[:, top : top + inner_h, left : left + inner_w] = image_t
            canvas_mask[top : top + inner_h, left : left + inner_w] = mask_t
            return canvas_img, canvas_mask
        return image_t, mask_t

    @staticmethod
    def _read_svg_dims_for_pdf(pdf_path: Path, poly: Path) -> tuple[float, float]:
        # Try to read dims from a sibling .meta.json
        meta = pdf_path.parent / "plan.meta.json"
        if meta.exists():
            import json
            d = json.loads(meta.read_text())
            return float(d["width"]), float(d["height"])
        # Fallback: read from polygons.svg
        root = ET.parse(str(poly)).getroot()
        vb = (root.attrib.get("viewBox") or "").split()
        w = float(root.attrib.get("width") or (vb[2] if len(vb) == 4 else 0))
        h = float(root.attrib.get("height") or (vb[3] if len(vb) == 4 else 0))
        return w, h

    def __getitem__(self, idx: int):
        n = len(self.samples)
        for offset in range(n):
            i = (idx + offset) % n
            try:
                return self._load(i)
            except Exception as e:
                print(f"[GarciaPairAdapter] skipping {self.samples[i]}: {e}", file=sys.stderr)
                continue
        raise RuntimeError("every Garcia sample failed")


class ConcatAdapter(Dataset):
    """Concatenate two datasets of the same shape, with offset bookkeeping."""

    def __init__(self, *datasets: Dataset):
        self.datasets = datasets
        self.lengths = [len(d) for d in datasets]
        self._cum = np.cumsum(self.lengths).tolist()

    def __len__(self) -> int:
        return self._cum[-1] if self._cum else 0

    def __getitem__(self, idx: int):
        for d, end in zip(self.datasets, self._cum):
            if idx < end:
                offset = end - len(d)
                return d[idx - offset]
        raise IndexError(idx)


def build_dataset(mode: str, **kwargs) -> Dataset:
    """Factory used by train.py's --data-mode flag."""
    if mode == "cubi":
        return CubicasaAdapter(
            data_dir=kwargs["data_dir"],
            split=kwargs.get("split", "train"),
            size=tuple(kwargs.get("image_size", (512, 512))),
            normalize=kwargs.get("normalize", True),
            letterbox=kwargs.get("letterbox", True),
        )
    if mode == "garcia":
        return GarciaPairAdapter(
            data_dir=kwargs["data_dir"],
            size=tuple(kwargs.get("image_size", (512, 512))),
            normalize=kwargs.get("normalize", True),
            letterbox=kwargs.get("letterbox", True),
        )
    if mode == "mixed":
        return ConcatAdapter(
            CubicasaAdapter(
                data_dir=kwargs["cubi_dir"], split=kwargs.get("split", "train"),
                size=tuple(kwargs.get("image_size", (512, 512))),
            ),
            GarciaPairAdapter(
                data_dir=kwargs["garcia_dir"],
                size=tuple(kwargs.get("image_size", (512, 512))),
            ),
        )
    raise ValueError(f"unknown --data-mode {mode}")
