# Genesis — Floor-plan segmentation fine-tuning

This directory contains the fine-tune + ONNX export pipeline for the
genesis-mind.com `extract-tool/` wall-detection model. The flow is:

```
   ┌──────────────────────────────────┐
   │  1.  Generate / collect labels   │
   │      (CubiCasa5K, OR your own)   │
   └──────────────┬───────────────────┘
                  ▼
   ┌──────────────────────────────────┐
   │  2.  Open notebooks/             │
   │      genesis_walls_finetune.ipynb│  ──── in Google Colab
   │      in Google Colab             │      (free GPU)
   └──────────────┬───────────────────┘
                  │
                  │   runs/<timestamp>/
                  │     best.pt      ◄── checkpoint
                  │     walls.onnx   ◄── exported model
                  ▼
   ┌──────────────────────────────────┐
   │  3.  deploy_to_genesis.sh        │  ──── on your Mac mini
   │      (uploads + updates live)    │
   └──────────────────────────────────┘
```

## TL;DR — what to do today

1. **Open the notebook in Colab**: `https://colab.research.google.com/github/anndygarcia/genesis-v0/blob/main/extract-tool/train/notebooks/genesis_walls_finetune.ipynb`
2. **Set runtime → GPU** (A100 / L4)
3. **Pick a config** (Garcia recommended — fastest path)
4. **Run all cells**
5. **Download** `runs/<timestamp>/walls.onnx` when training finishes
6. **Run** `bash deploy_to_genesis.sh /path/to/walls.onnx` on your Mac mini

That's it. CF Pages auto-deploys the URL change, so the live site picks
up the new model within 30 seconds of step 6.

## Files

| Path | Purpose |
|---|---|
| `src/model.py` | smp.Unet wrapper (ResNet-34 / ImageNet weights) |
| `src/labels.py` | 4-class taxonomy (floor / wall / door / window) |
| `src/svg_to_mask.py` | SVG polygons → 4-class int mask |
| `src/data_adapter.py` | CubiCasa + Garcia + mixed dataset adapters |
| `src/train.py` | Trainer (AdamW, class-weighted CE, per-class IoU) |
| `src/export_onnx.py` | `best.pt` → single-file `walls.onnx` |
| `evaluate.py` | Stand-alone eval (IoU + mIoU on a held-out set) |
| `configs/garcia_finetune.yaml` | Recommended: warm-start from Yytsi, fine-tune |
| `configs/cubi_subset.yaml` | CubiCasa-only training (no Garcia data needed) |
| `configs/mixed.yaml` | CubiCasa + Garcia combined |
| `notebooks/genesis_walls_finetune.ipynb` | The Colab notebook |
| `notebooks/build_notebook.py` | Regenerates the notebook from sources |
| `deploy_to_genesis.sh` | Mac-side: pushes walls.onnx to GitHub Releases |
| `requirements.txt` | Pinned Python deps |

## Time estimates (Colab A100)

| Config | Train time | Memory | Disk |
|---|---|---|---|
| `garcia_finetune` (10 ep, ~100 plans) | 45-60 min | ~12 GB VRAM | ~1 GB (data + ONNX) |
| `cubi_subset` (5 ep on full CubiCasa) | ~5 hours | ~12 GB VRAM | ~5 GB (data) |
| `mixed` (10 ep, half Garcia half CubiCasa) | 90 min | ~12 GB VRAM | ~5.5 GB |

If you only have Colab's free T4 tier: multiply the above by ~3-5×.

## When fine-tuning helps (vs not)

The base Yytsi model was trained on **CubiCasa5K (5,000 Finnish plans)**.
Fine-tuning helps when:

- ✅ Your plans are stylistically different from CubiCasa5K — e.g.
  American architectural conventions (mostly true for Garcia drawings)
- ✅ Your plans use non-standard symbols (icons, dimensions, etc.)
- ✅ You have any labeled data at all (10+ plans minimum, 50+ ideal)

Fine-tuning does **not** help when:

- ❌ Your plans are typical AutoCAD exports in Finnish style (the base
  model already covers this)
- ❌ You don't have any labeled plans yet — labeling 50 plans takes
  ~2 hours in Labelbox; get the labels first
- ❌ The base model already detects walls correctly and you only want
  minor accuracy tweaks — fine-tuning rarely beats 2-3% mIoU on
  in-distribution data without extensive effort

## How to label Garcia plans

Two practical paths:

### Path A — Use CubiCasa polygons overlay (cheap)

If your Garcia PDFs come with dimension lines and door symbols in
standard CAD conventions, the `GarciaPairAdapter` could potentially
auto-derive the polygons from the SVG layers that AutoCAD/PDF exports.
We'd need to add a parser for that — say the word and I'll write it.

### Path B — Manual labels in Roboflow (free tier)

1. Sign up at https://roboflow.com (free for 1000 images).
2. Create a project "walls-doors-windows".
3. Upload each Garcia PDF as PNG (we provide a `pdf2png` helper).
4. Annotate walls, doors, windows.
5. Export → segmentation mask format.
6. Drop the masks into `data/garcia_plans/<plan_id>/plan.png + plan_mask.png`.
7. Run the notebook.

This is the most accurate path. Typical time: 5-10 min per plan with
the bulk-select polygon tool.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'train'` | Notebook uses wrong cwd | Use `cd extract-tool/train && python -m src.train` (not `python -m train.src.train`) |
| `pytorch.cuda.OutOfMemoryError` | Batch too big | Lower `batch_size` in config (8 → 4) |
| `RuntimeError: Caught runtime error in DataLoader worker` | Bad SVG file | Move that sample out, retrain |
| `epochs 0 of 30, val loss NaN` | Learning rate too high | Drop lr 10× in config |
| `mIoU not improving` | Mis-labeled masks | Visually inspect a few; usually wrong classes |
| ONNX file > 100 MB | Cold-start from ImageNet only | Check warm-start actually loaded (look for `loaded N tensors` line) |
| `gh: not authenticated` | gh CLI not logged in | On Mac mini: `gh auth login --web` |

## File outputs (what you should expect)

After a successful Garcia fine-tune on Colab:

```
runs/
└── 2026-07-20_14-30-00/
    ├── train.log          # Tee'd console output, per-step losses
    ├── metrics.csv        # epoch, train_loss, val_loss, pixel_acc, miou, iou_floor, iou_wall, iou_door, iou_window
    ├── best.pt            # the model weights to use
    ├── last.pt            # most recent weights (for resume)
    └── walls.onnx         # exported inference model
```

Typical values for the metrics.csv after 10 epochs:
- val_loss  ≈ 0.18
- pixel_acc ≈ 0.985
- miou      ≈ 0.78  (mixed, in-distribution)
- iou_wall  ≈ 0.85-0.92
- iou_door  ≈ 0.65-0.78  (still the hardest class)
- iou_window≈ 0.72-0.85

## What's NOT in this directory

- Door/window detection as a separate model — Co-DETR is overkill for
  this; we get doors/windows from the same wall-segmentation output.
  If you want to specialize later, add a second adapter under
  `src/data_adapter.py` and a new config.
- Polygon room support — that lives in `fuse.mjs` (raster→polygon
  conversion) and doesn't need a separate model.

## License

MIT, matches the rest of the Genesis stack. The base Yytsi weights are
also MIT. CubiCasa5K is CC BY 4.0.
