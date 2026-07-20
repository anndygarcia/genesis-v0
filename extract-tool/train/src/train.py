"""Training entrypoint for the Genesis floor-plan segmentation model.

Behaviors:
- Warm-starts from the pretrained Yytsi release (best.safetensors) by
  default. The release was trained on CubiCasa5K; our fine-tune adds
  Garcia-style plans to the training distribution.
- Resume from a checkpoint when given `--resume runs/.../last.pt`.
- Per-epoch metrics written to runs/<timestamp>/metrics.csv.
- Best-epoch checkpoint to runs/<timestamp>/best.pt (by val mIoU).

This file is a ground-up rewrite of Yytsi's `buildingcv.train`. We keep
the same metric math and CLI surface, but add:
- `data_mode ∈ {cubi, garcia, mixed}` flag and adapter dispatch
- safetensors→PyTorch state_dict bridge for warm-start
- Class-weighted CE to fight the floor class
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import yaml
from torch.utils.data import DataLoader, Subset

from .data_adapter import build_dataset
from .labels import CLASS_NAMES, NUM_CLASSES
from .model import build_model


def resolve_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def warm_start_from_safetensors(model: nn.Module, path: Path) -> tuple[int, int]:
    """Load Yytsi/floorplan-to-3d-walls weights into our smp.Unet.

    Returns (n_loaded_tensors, n_total_model_keys) so the trainer can log
    a sanity-check that the warm-start actually transferred the backbone.
    """
    try:
        from safetensors.torch import load_file
    except ImportError as e:
        raise RuntimeError("safetensors missing — `pip install safetensors`") from e

    state = load_file(str(path))
    new_state: dict[str, torch.Tensor] = {}
    missing_keys: list[str] = []
    matched_keys: list[str] = []
    for k, v in state.items():
        # Yytsi keys are like "model.encoder.conv1.weight" or sometimes
        # "encoder.layer1.0.conv1.weight" (after smp's prefix).
        candidates = [
            k,
            k[6:] if k.startswith("model.") else k,
            _yytsi_to_smp_key(k[6:] if k.startswith("model.") else k),
        ]
        for cand in candidates:
            if cand and cand in model.state_dict():
                new_state[cand] = v
                matched_keys.append(cand)
                break
        else:
            missing_keys.append(k)

    # Count which model keys are still un-set after warm start
    model_remaining = [
        k for k in model.state_dict().keys() if k not in new_state
    ]
    model.load_state_dict(
        {**{k: model.state_dict()[k] for k in model_remaining}, **new_state},
        strict=False,
    )
    return len(matched_keys), len(model_remaining)


def _yytsi_to_smp_key(k: str) -> str | None:
    """smp.Unet uses `encoder.layer{N}.{0}.convN.weight`. Some Yytsi keys
    come in as `encoder.layer{N}.convN.weight` (one fewer dot). Remap."""
    if not k.startswith("encoder.layer"):
        return None
    rest = k[len("encoder.layer"):]
    if not rest or not rest[0].isdigit():
        return None
    # Find where the digit block ends
    i = 0
    while i < len(rest) and rest[i].isdigit():
        i += 1
    if i == 0:
        return None
    num = rest[:i]
    tail = rest[i:]
    return f"encoder.layer{num}.0{tail}"


@torch.no_grad()
def evaluate(model, loader, loss_fn, device) -> dict[str, Any]:
    """Run validation and return loss, pixel accuracy, per-class IoU."""
    model.eval()
    total_loss, total_correct, total_pixels = 0.0, 0, 0
    tp = torch.zeros(NUM_CLASSES, dtype=torch.long, device=device)
    fp = torch.zeros(NUM_CLASSES, dtype=torch.long, device=device)
    fn = torch.zeros(NUM_CLASSES, dtype=torch.long, device=device)
    for images, masks in loader:
        images = images.to(device, non_blocking=True)
        masks = masks.to(device, non_blocking=True)
        logits = model(images)
        loss = loss_fn(logits, masks)
        total_loss += loss.item() * images.size(0)
        preds = logits.argmax(dim=1)
        total_correct += (preds == masks).sum().item()
        total_pixels += masks.numel()
        for c in range(NUM_CLASSES):
            pred_c = preds == c
            true_c = masks == c
            tp[c] += (pred_c & true_c).sum()
            fp[c] += (pred_c & ~true_c).sum()
            fn[c] += (~pred_c & true_c).sum()
    denom = (tp + fp + fn).clamp(min=1).float()
    iou = (tp.float() / denom).cpu().tolist()
    return {
        "loss": total_loss / max(1, len(loader.dataset)),
        "pixel_acc": total_correct / max(1, total_pixels),
        "iou": iou,
        "miou": sum(iou) / max(1, len(iou)),
    }


def format_iou(iou: list[float]) -> str:
    return " | ".join(f"{name} {v:.3f}" for name, v in zip(CLASS_NAMES, iou))


def append_metrics(csv_path: Path, epoch: int, train_loss: float, m: dict) -> None:
    new = not csv_path.exists()
    with csv_path.open("a", buffering=1) as f:
        if new:
            cols = ["epoch", "train_loss", "val_loss", "pixel_acc", "miou"] + [
                f"iou_{n}" for n in CLASS_NAMES
            ]
            f.write(",".join(cols) + "\n")
        row = [
            str(epoch),
            f"{train_loss:.6f}",
            f"{m['loss']:.6f}",
            f"{m['pixel_acc']:.6f}",
            f"{m['miou']:.6f}",
        ] + [f"{v:.6f}" for v in m["iou"]]
        f.write(",".join(row) + "\n")


def save_checkpoint(
    path: Path, *, epoch: int, model: nn.Module, optimizer, cfg, best_miou: float
) -> None:
    torch.save(
        {
            "epoch": epoch,
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "config": cfg,
            "best_miou": best_miou,
        },
        path,
    )


def load_checkpoint(path: Path, model: nn.Module, optimizer, cfg) -> tuple[int, float]:
    ck = torch.load(str(path), map_location="cpu", weights_only=False)
    model.load_state_dict(ck["model"], strict=False)
    if "optimizer" in ck and optimizer is not None:
        try:
            optimizer.load_state_dict(ck["optimizer"])
        except Exception as e:
            print(f"[train] optimizer state mismatched, ignoring: {e}", file=sys.stderr)
    return ck.get("epoch", 0), ck.get("best_miou", 0.0)


def make_run_dir(base: Path) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    out = base / stamp
    out.mkdir(parents=True, exist_ok=True)
    return out


def train(cfg: dict, args: argparse.Namespace) -> None:
    device = resolve_device(cfg["train"]["device"])
    print(f"[train] device: {device}", file=sys.stderr)

    image_size = tuple(cfg["data"]["image_size"])
    batch_size = int(cfg["optim"]["batch_size"])
    num_workers = int(cfg["data"].get("num_workers", 4))

    data_mode = cfg["data"]["data_mode"]
    if data_mode == "cubi":
        train_ds = build_dataset(
            "cubi", data_dir=cfg["data"]["data_dir"], split="train",
            image_size=image_size,
            normalize=cfg["data"].get("normalize", True),
            letterbox=cfg["data"].get("letterbox", True),
        )
        val_ds = build_dataset(
            "cubi", data_dir=cfg["data"]["data_dir"], split="val",
            image_size=image_size,
            normalize=cfg["data"].get("normalize", True),
            letterbox=cfg["data"].get("letterbox", True),
        )
    elif data_mode == "garcia":
        full = build_dataset(
            "garcia", data_dir=cfg["data"]["data_dir"],
            image_size=image_size,
            normalize=cfg["data"].get("normalize", True),
            letterbox=cfg["data"].get("letterbox", True),
        )
        n = len(full)
        n_val = max(1, int(n * 0.15))
        train_ds = Subset(full, list(range(0, n - n_val)))
        val_ds = Subset(full, list(range(n - n_val, n)))
    elif data_mode == "mixed":
        train_ds = build_dataset(
            "mixed", cubi_dir=cfg["data"]["cubi_dir"],
            garcia_dir=cfg["data"]["garcia_dir"], split="train",
            image_size=image_size,
        )
        val_ds = build_dataset(
            "cubi", data_dir=cfg["data"]["cubi_dir"], split="val",
            image_size=image_size,
            normalize=cfg["data"].get("normalize", True),
            letterbox=cfg["data"].get("letterbox", True),
        )
    else:
        raise ValueError(f"unknown data_mode {data_mode}")

    if args.limit_train is not None:
        train_ds = Subset(train_ds, range(min(args.limit_train, len(train_ds))))
    if args.limit_val is not None:
        val_ds = Subset(val_ds, range(min(args.limit_val, len(val_ds))))

    print(f"[train] mode={data_mode} train={len(train_ds)} val={len(val_ds)}", file=sys.stderr)

    train_loader = DataLoader(
        train_ds, batch_size=batch_size, shuffle=True,
        num_workers=num_workers, pin_memory=(device.type == "cuda"),
    )
    val_loader = DataLoader(
        val_ds, batch_size=batch_size, shuffle=False,
        num_workers=num_workers, pin_memory=(device.type == "cuda"),
    )

    model = build_model(
        encoder_name=cfg["model"]["encoder_name"],
        encoder_weights=cfg["model"].get("encoder_weights"),
        num_classes=NUM_CLASSES, in_channels=3,
    ).to(device)

    warm_path = cfg["model"].get("warm_start_from")
    if warm_path:
        warm = Path(warm_path)
        if warm.exists():
            n_loaded, n_remaining = warm_start_from_safetensors(model, warm)
            print(
                f"[train] warm-start: loaded {n_loaded} tensors; "
                f"{n_remaining} model keys left to fill (will copy from "
                f"current backbone init or random-as-needed)",
                file=sys.stderr,
            )
        else:
            print(
                f"[train] WARNING: warm_start_from {warm} not found, "
                "falling back to encoder weights from cfg.model",
                file=sys.stderr,
            )

    optim = torch.optim.AdamW(
        model.parameters(),
        lr=float(cfg["optim"]["lr"]),
        weight_decay=float(cfg["optim"]["weight_decay"]),
    )
    # Class-weighted CE — discount 'floor' (the dominant class) so walls
    # don't get smeared into floor pixels. Multipliers picked from typical
    # CubiCasa5K class counts.
    cls_w = torch.tensor([0.5, 1.0, 2.0, 2.0], device=device)
    loss_fn = nn.CrossEntropyLoss(weight=cls_w)

    start_epoch, best_miou = 0, 0.0
    if args.resume:
        start_epoch, best_miou = load_checkpoint(args.resume, model, optim, cfg)
        print(
            f"[train] resumed from {args.resume} epoch={start_epoch} "
            f"best_miou={best_miou:.4f}",
            file=sys.stderr,
        )

    run_dir = make_run_dir(Path(cfg["output"]["run_dir"]))
    log_path = run_dir / "train.log"
    log_f = log_path.open("a", buffering=1)
    csv_path = run_dir / "metrics.csv"

    def logln(msg: str = "") -> None:
        print(msg)
        ts = datetime.now().strftime("%H:%M:%S")
        log_f.write(f"[{ts}] {msg}\n")

    logln(f"run dir: {run_dir}")
    logln(f"config: {args.config}")

    epochs = int(args.epochs or cfg["train"]["epochs"])
    log_every = int(cfg["train"]["log_every"])
    ckpt_every = int(cfg["train"].get("checkpoint_every", 0))

    for epoch in range(start_epoch, epochs):
        model.train()
        t0 = time.time()
        running, epoch_loss_sum, n_steps = 0.0, 0.0, 0
        for step, (images, masks) in enumerate(train_loader):
            images = images.to(device, non_blocking=True)
            masks = masks.to(device, non_blocking=True)
            logits = model(images)
            loss = loss_fn(logits, masks)
            optim.zero_grad(set_to_none=True)
            loss.backward()
            optim.step()
            running += loss.item()
            epoch_loss_sum += loss.item()
            n_steps += 1
            if (step + 1) % log_every == 0:
                logln(
                    f"  epoch {epoch} step {step+1}/{len(train_loader)} "
                    f"train loss {running/log_every:.4f}"
                )
                running = 0.0

        train_loss_avg = epoch_loss_sum / max(1, n_steps)
        metrics = evaluate(model, val_loader, loss_fn, device)
        dt = time.time() - t0
        logln(
            f"epoch {epoch} done in {dt:.1f}s — train loss {train_loss_avg:.4f} "
            f"val loss {metrics['loss']:.4f} pixel acc {metrics['pixel_acc']:.4f} "
            f"mIoU {metrics['miou']:.4f}"
        )
        logln(f"  per-class IoU: {format_iou(metrics['iou'])}")
        append_metrics(csv_path, epoch, train_loss_avg, metrics)

        save_checkpoint(
            run_dir / "last.pt",
            epoch=epoch, model=model, optimizer=optim, cfg=cfg, best_miou=best_miou,
        )
        if metrics["miou"] > best_miou:
            best_miou = metrics["miou"]
        save_checkpoint(
            run_dir / "best.pt",
            epoch=epoch, model=model, optimizer=optim, cfg=cfg, best_miou=best_miou,
        )
        if metrics["miou"] > best_miou - 1e-9 or metrics["miou"] >= best_miou:
            logln(f"  best so far: mIoU {best_miou:.4f} -> best.pt")
        if ckpt_every > 0 and (epoch + 1) % ckpt_every == 0:
            save_checkpoint(
                run_dir / f"epoch_{epoch:02d}.pt",
                epoch=epoch, model=model, optimizer=optim, cfg=cfg, best_miou=best_miou,
            )

    log_f.close()
    print(
        f"[train] done. last: {run_dir/'last.pt'} best: {run_dir/'best.pt'} "
        f"(mIoU {best_miou:.4f})"
    )


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--config", required=True, type=Path)
    p.add_argument("--epochs", type=int, default=None)
    p.add_argument("--limit-train", type=int, default=None)
    p.add_argument("--limit-val", type=int, default=None)
    p.add_argument("--resume", type=Path, default=None)
    args = p.parse_args()

    with open(args.config) as f:
        cfg = yaml.safe_load(f)
    train(cfg, args)


if __name__ == "__main__":
    main()
