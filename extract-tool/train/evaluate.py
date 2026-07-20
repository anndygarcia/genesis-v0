"""Stand-alone evaluation script.

Use this in Colab or locally to compute per-class IoU + mIoU on a
held-out set, without re-running the trainer.

Examples:
    python evaluate.py --ckpt runs/garcia/<timestamp>/best.pt \
                       --data-mode cubi --data-dir data/cubicasa5k_svg \
                       --split val
    python evaluate.py --ckpt runs/garcia/<timestamp>/best.pt \
                       --data-mode garcia --data-dir data/garcia_plans
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
import yaml

# Make `python -m train.src.train`-style imports work without packaging.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from train.src.data_adapter import build_dataset  # noqa: E402
from train.src.labels import CLASS_NAMES, NUM_CLASSES  # noqa: E402
from train.src.model import build_model  # noqa: E402
from train.src.train import evaluate  # noqa: E402


def resolve_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True, type=Path)
    ap.add_argument("--data-mode", required=True, choices=["cubi", "garcia", "mixed"])
    ap.add_argument("--data-dir", type=Path)
    ap.add_argument("--cubi-dir", type=Path)
    ap.add_argument("--garcia-dir", type=Path)
    ap.add_argument("--split", default="val")
    ap.add_argument("--image-size", type=int, default=512)
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    device = resolve_device(args.device)
    print(f"[eval] device: {device}")

    if args.data_mode == "cubi":
        ds = build_dataset("cubi", data_dir=str(args.data_dir), split=args.split,
                            image_size=(args.image_size, args.image_size))
    elif args.data_mode == "garcia":
        ds = build_dataset("garcia", data_dir=str(args.data_dir),
                            image_size=(args.image_size, args.image_size))
    else:
        ds = build_dataset("mixed", cubi_dir=str(args.cubi_dir),
                            garcia_dir=str(args.garcia_dir), split=args.split,
                            image_size=(args.image_size, args.image_size))

    print(f"[eval] dataset: {len(ds)} samples (mode={args.data_mode})")
    loader = torch.utils.data.DataLoader(
        ds, batch_size=args.batch_size, shuffle=False, num_workers=2,
        pin_memory=(device.type == "cuda"),
    )

    ck = torch.load(str(args.ckpt), map_location="cpu", weights_only=False)
    cfg = ck.get("config", {})
    model = build_model(
        encoder_name=cfg.get("model", {}).get("encoder_name", "resnet34"),
        encoder_weights=None,
    )
    model.load_state_dict(ck["model"], strict=False)
    model = model.to(device).eval()

    loss_fn = torch.nn.CrossEntropyLoss()
    m = evaluate(model, loader, loss_fn, device)
    print()
    print(f"[eval] loss:    {m['loss']:.4f}")
    print(f"[eval] pix_acc: {m['pixel_acc']:.4f}")
    print(f"[eval] mIoU:    {m['miou']:.4f}")
    for name, iou in zip(CLASS_NAMES, m["iou"]):
        print(f"  {name:6s}: {iou:.4f}")


if __name__ == "__main__":
    main()
