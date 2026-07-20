"""Export a fine-tuned `best.pt` to a single-file ONNX matching the runtime
contract used by genesis-mind.com's `extract-tool/detect-model.mjs`.

Contract:
- Input name: `image`
- Shape: [batch, 3, 512, 512]
- Type: float32 (ImageNet-normalized; caller pre-normalizes)
- Output name: `logits`
- Shape: [batch, 4, 512, 512]
- Type: float32 (raw logits — caller applies argmax)

The exported file is sized so that it can be hosted on Cloudflare Pages
(<= 25 MB after ONNX compression) — Yytsi's release is 98 MB, our resnet34
warm-started from a fresh init produces a smaller checkpoint.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import torch
from onnx import ModelProto, save_model
import onnx.onnx_ml_pb2 as pb

from .model import build_model
from .labels import NUM_CLASSES


def export(model: torch.nn.Module, out_path: Path, image_size: int = 512) -> None:
    """Move `model` to CPU, eval mode, and export ONNX."""
    model.cpu().eval()
    dummy = torch.zeros(1, 3, image_size, image_size)
    torch.onnx.export(
        model, dummy, str(out_path),
        opset_version=13,
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={"image": {0: "batch"}, "logits": {0: "batch"}},
        do_constant_folding=True,
    )

    # PyTorch's exporter writes an external .data file for large models.
    # Re-load and inline everything so deploys are a single file.
    data_file = Path(str(out_path) + ".data")
    if data_file.exists():
        m = ModelProto()
        with open(out_path, "rb") as f:
            m.ParseFromString(f.read())
        with open(data_file, "rb") as f:
            full_data = f.read()
        for t in m.graph.initializer:
            if t.data_location == pb.TensorProto.EXTERNAL:
                offset, length = 0, 0
                for entry in t.external_data:
                    if entry.key == "offset":
                        offset = int(entry.value)
                    elif entry.key == "length":
                        length = int(entry.value)
                t.raw_data = full_data[offset : offset + length]
                del t.external_data[:]
                t.data_location = pb.TensorProto.DEFAULT
        save_model(m, str(out_path), save_as_external_data=False,
                   all_tensors_to_one_file=True)
        data_file.unlink(missing_ok=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--image-size", type=int, default=512)
    args = ap.parse_args()

    print(f"[export_onnx] loading {args.ckpt}")
    ck = torch.load(str(args.ckpt), map_location="cpu", weights_only=False)
    cfg = ck.get("config", {})
    model = build_model(
        encoder_name=cfg.get("model", {}).get("encoder_name", "resnet34"),
        encoder_weights=None,  # we'll load our own state_dict
        num_classes=NUM_CLASSES,
    )
    model.load_state_dict(ck["model"], strict=False)
    print(f"[export_onnx] exporting {args.out}")
    export(model, args.out, image_size=args.image_size)
    size_mb = args.out.stat().st_size / 1e6
    print(f"[export_onnx] done. {size_mb:.1f} MB at {args.out}")


if __name__ == "__main__":
    main()
