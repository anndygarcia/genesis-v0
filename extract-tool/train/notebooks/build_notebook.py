"""Build the Colab notebook as a single .ipynb JSON.

Run from anywhere: `python notebooks/build_notebook.py`.
Outputs `notebooks/genesis_walls_finetune.ipynb`.
"""
from __future__ import annotations

import argparse
import json
import textwrap
from pathlib import Path

NB_FORMAT = 4
NB_MIME = "1.3.0"
PY_LANG = "python"


def md(src: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": textwrap.dedent(src).strip("\n").split("\n")}


def code(src: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": textwrap.dedent(src).strip("\n").split("\n"),
    }


CELLS = [
    md("""
    # Genesis — Floor-plan segmentation fine-tune

    This notebook does three things, end-to-end:

    1. Download the pre-trained Yytsi wall-segmentation model (~100 MB).
    2. Fine-tune it on either:
       - **CubiCasa5K** (cold-start — useful if you have NO Garcia plans)
       - **your labeled Garcia plans** (warm-start — recommended)
       - **a mix of both**
    3. Export the result as a single-file ONNX ready for deployment.

    ## How to use

    1. Open this notebook in [Google Colab](https://colab.research.google.com).
       - Runtime → Change runtime type → Hardware accelerator → **GPU**
         (an A100 is recommended; an L4 is fine).
    2. Add a cell at the top to upload your data if not on Drive:
       - For Garcia mode: zip your `garcia_plans/` dir and the cell will
         extract it.
       - For CubiCasa mode: download Zenodo's `cubicasa5k.zip` and place
         it in the runtime's `data/cubicasa5k_svg/`.
    3. Pick a config (top of Cell 6) — recommended: `garcia_finetune`.
    4. Hit **Runtime → Run all**. A100 run for 10 epochs on Garcia will
       finish in ~45-60 minutes.
    5. The notebook writes `best.pt`, `last.pt`, and `walls.onnx` to
       `extract-tool/train/runs/<your-run>/`. Download `walls.onnx`
       (or sync to Drive) and run `train/deploy_to_genesis.sh` from
       your Mac mini to ship the new model to the live site.

    ## What this notebook does NOT do

    - It does NOT touch your Colab account or any cloud project; it's
      standalone Python that runs in the runtime.
    - It does NOT upload your plans anywhere — all data stays in the
      ephemeral Colab VM (or whatever storage you mount).
    - It does NOT deploy to the live site automatically. The deploy
      step runs from your Mac mini, where the `gh` CLI is authenticated.
    """),

    md("""
    ## 1. Environment setup

    Installs all dependencies, sets up the GPU, and prepares the data dir.
    Runtime: ~3 minutes.
    """),

    code("""
        # Detect GPU
        import torch, subprocess, sys
        print("Python:", sys.version)
        print("PyTorch:", torch.__version__)
        print("CUDA available:", torch.cuda.is_available())
        if torch.cuda.is_available():
            print("GPU:", torch.cuda.get_device_name(0))
            print("VRAM:", torch.cuda.get_device_properties(0).total_memory / 1e9, "GB")
    """),

    code("""
        # Install dependencies. Colab already has torch + cuda — install only
        # the ones that are missing or out-of-date.
        %pip install --quiet --upgrade "segmentation_models_pytorch>=0.3.3" "safetensors>=0.4" "huggingface_hub>=0.24" pdf2image
        !apt-get install -y --no-install-recommends poppler-utils >/dev/null 2>&1 || true
    """),

    code("""
        # Clone the Genesis repo so we can import the training module.
        # Use a fresh /content/genesis-v0/ each time so resuming picks up
        # changes correctly. If already cloned, just pull.
        import os, subprocess
        TARGET = "/content/genesis-v0"
        if os.path.isdir(TARGET):
            %cd $TARGET && !git pull --quiet
        else:
            !git clone --depth 1 https://github.com/anndygarcia/genesis-v0.git $TARGET
            %cd $TARGET
        print("Repo:", subprocess.check_output(["git", "rev-parse", "--short", "HEAD"]).decode().strip())
    """),

    md("""
    ## 2. Data setup

    Pick **one** of the options below and run that cell.

    Option A is the typical workflow: you have a few Garcia PDFs and you
    want to teach the model what they look like.

    Option B is for when you have no Garcia data yet — fine-tune on a
    CubiCasa5K subset to refresh the baseline.
    """),

    md("""
    ### Option A — Garcia mode (recommended)

    Upload your `garcia_plans/` directory (see `train/src/data_adapter.py`).
    Expected layout:

    ```
    garcia_plans/
        100_kitchen/
            plan.pdf
            polygons.svg
        101_bedroom/
            plan.png
            plan_mask.png
        ...
    ```
    """),

    code("""
        import shutil, os
        os.makedirs("extract-tool/train/data/garcia_plans", exist_ok=True)
        # Either: upload via Colab file picker (Files panel on the left)
        # Or: zip and place at /content/garcia_plans.zip and run below.
        # The simplest path for first-time users:
        #
        #   1. zip your garcia_plans/ dir into garcia_plans.zip
        #   2. drag-drop the zip into the Files panel
        #   3. run this cell to unzip
        #
        ZIP = "/content/garcia_plans.zip"
        if os.path.isfile(ZIP):
            shutil.unpack_archive(ZIP, "extract-tool/train/data/garcia_plans")
            print("Unpacked", ZIP, "-> extract-tool/train/data/garcia_plans")
        else:
            print("No zip at /content/garcia_plans.zip — drop your file into the Files panel and re-run.")
    """),

    md("""
    ### Option B — CubiCasa5K mode

    Downloads the original CubiCasa5K SVG source from Zenodo and unzips
    it. ~5 GB, takes ~10 min on a Colab A100 VM (~minute on Google's
    internal network).

    Skip this cell if you've already done it once.
    """),

    code("""
        import os, urllib.request, subprocess, shutil
        URL = "https://zenodo.org/record/2613548/files/cubicasa5k.zip?download=1"
        TARGET = "extract-tool/train/data/cubicasa5k_svg"
        if os.path.isdir(TARGET) and len(os.listdir(TARGET)) > 100:
            print("Already have CubiCasa5K at", TARGET)
        else:
            os.makedirs(os.path.dirname(TARGET), exist_ok=True)
            print("Downloading ~5 GB from Zenodo …")
            urllib.request.urlretrieve(URL, "/content/cubicasa5k.zip")
            print("Unzipping …")
            subprocess.run(["unzip", "-q", "/content/cubicasa5k.zip", "-d", "extract-tool/train/data/"],
                           check=True)
            # unzip creates extract-tool/train/data/cubicasa5k/model.svg structure
            # but the original repo zip nests under data/. We'll auto-detect.
            for cand in ["extract-tool/train/data/cubicasa5k", "extract-tool/train/data/cubicasa_5k"]:
                if os.path.isdir(cand):
                    print("Found at", cand)
                    break
            os.remove("/content/cubicasa5k.zip")
    """),

    md("""
    ## 3. Download pre-trained Yytsi weights

    Used for warm-start. ~100 MB, downloads in ~10 s on Colab.
    """),

    code("""
        import os, urllib.request, ssl
        os.makedirs("extract-tool/train/weights", exist_ok=True)
        OUT = "extract-tool/train/weights/best.safetensors"
        if os.path.isfile(OUT) and os.path.getsize(OUT) > 80_000_000:
            print("Already have weights at", OUT, f"({os.path.getsize(OUT)/1e6:.1f} MB)")
        else:
            URL = "https://huggingface.co/Yytsi/floorplan-to-3d-walls/resolve/main/best.safetensors"
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(URL, context=ctx) as r, open(OUT, "wb") as f:
                total = int(r.headers.get("Content-Length", 0))
                chunk = 1 << 20
                read = 0
                while True:
                    buf = r.read(chunk)
                    if not buf:
                        break
                    f.write(buf)
                    read += len(buf)
                    pct = (read / total * 100) if total else 0
                    print(f"\\r{read/1e6:6.1f} / {total/1e6:6.1f} MB  ({pct:5.1f}%)", end="")
                print(f"\\nDownloaded {OUT} ({read/1e6:.1f} MB)")
    """),

    md("""
    ## 4. Pick the config and start training

    The recommended config is `garcia_finetune` (warm-start from Yytsi,
    fine-tune on your Garcia drawings at lr 1e-4). The other configs:
    - `cubi_subset.yaml` — cold-start / continued-training on CubiCasa5K
    - `mixed.yaml` — CubiCasa + Garcia combined (use when Garcia < 50 plans)

    **No code changes needed** — just hit Run all.
    """),

    code("""
        CONFIG = "extract-tool/train/configs/garcia_finetune.yaml"
        # CONFIG = "extract-tool/train/configs/cubi_subset.yaml"   # alternative
        # CONFIG = "extract-tool/train/configs/mixed.yaml"          # alternative

        # Recommended: 10 epochs from warm-start.
        # Increase if you have more plans or want higher accuracy.
        EPOCHS = 10

        # Reduce for sanity runs (e.g. confirm the data loads).
        LIMIT_TRAIN = None   # e.g. 32 for a 5-min smoke test

        print("Config:", CONFIG)
        print("Epochs:", EPOCHS)
        print("Limit train:", LIMIT_TRAIN)
    """),

    code("""
        # The trainer auto-resumes from runs/<latest>/last.pt if present.
        # Pick the most recent run-dir so we resume, not restart.
        import os
        from pathlib import Path
        RUNS = Path("extract-tool/train/runs")
        if RUNS.exists():
            candidates = sorted([d for d in RUNS.iterdir() if d.is_dir()], key=lambda d: d.stat().st_mtime)
            last_pt = None
            for d in reversed(candidates):
                p = d / "last.pt"
                if p.exists():
                    last_pt = p
                    break
        else:
            last_pt = None
        print("Last checkpoint:", last_pt)
        RESUME = str(last_pt) if last_pt else None
    """),

    code("""
        # Run the trainer. This is the long-running cell — could take
        # 10 minutes (smoke test) to 12 hours (full CubiCasa).
        import os
        os.environ["CUDA_LAUNCH_BLOCKING"] = "0"  # don't slow down training
        !cd /content/genesis-v0/extract-tool/train && python -m src.train \\\\
            --config {CONFIG} \\\\
            --epochs {EPOCHS} \\\\
            {("--limit-train " + str(LIMIT_TRAIN)) if LIMIT_TRAIN else ""} \\\\
            {("--resume " + RESUME) if RESUME else ""}
    """),

    md("""
    ## 5. Evaluate the fine-tuned model

    Computes per-class IoU and mIoU against the held-out validation split.
    Use this after training to confirm the new weights are better than the
    released ones (or at least not worse).
    """),

    code("""
        import yaml, glob, os
        from pathlib import Path
        # Find best.pt
        runs = sorted(Path("extract-tool/train/runs").iterdir(), key=lambda d: d.stat().st_mtime)
        RUN_DIR = runs[-1] if runs else None
        if RUN_DIR is None:
            raise SystemExit("No runs/ directory — did you run the training cell?")
        BEST_PT = RUN_DIR / "best.pt"
        print("Best checkpoint:", BEST_PT, f"({os.path.getsize(BEST_PT)/1e6:.1f} MB)")

        # Run eval on the same dataset the training config uses.
        cfg = yaml.safe_load(open(CONFIG).read())
        mode = cfg["data"]["data_mode"]
        if mode == "garcia":
            cmd = f"python evaluate.py --ckpt {BEST_PT} --data-mode garcia --data-dir {cfg['data']['data_dir']}"
        elif mode == "cubi":
            cmd = f"python evaluate.py --ckpt {BEST_PT} --data-mode cubi --data-dir {cfg['data']['data_dir']} --split val"
        else:
            cmd = f"python evaluate.py --ckpt {BEST_PT} --data-mode cubi --data-dir {cfg['data']['cubi_dir']} --split val"
        print("Eval command:", cmd)
        !cd /content/genesis-v0/extract-tool/train && {cmd}
    """),

    md("""
    ## 6. Export to ONNX

    Produces a single-file `walls.onnx` matching the contract that
    genesis-mind.com's `extract-tool/detect-model.mjs` expects:

    - Input: `image`, shape `[batch, 3, 512, 512]`, float32 (ImageNet-normalized)
    - Output: `logits`, shape `[batch, 4, 512, 512]`, float32

    The onnx file size depends on checkpoint; expect ~100 MB.
    """),

    code("""
        from pathlib import Path
        OUT_ONNX = RUN_DIR / "walls.onnx"
        print("Exporting to:", OUT_ONNX)
        !cd /content/genesis-v0/extract-tool/train && python -m src.export_onnx \\
            --ckpt {BEST_PT} \\
            --out {OUT_ONNX} \\
            --image-size 512
        print()
        print("Final ONNX:")
        !ls -lh {OUT_ONNX}
    """),

    md("""
    ## 7. Download the ONNX to your Mac

    The cleanest path: zip the `runs/<your-run>/` directory, drop it
    into Google Drive (or anywhere you can fetch it from), then on your
    Mac mini run `train/deploy_to_genesis.sh` to push it to GitHub
    Releases and update the live site.
    """),

    code("""
        import shutil
        ARCHIVE = f"/content/{RUN_DIR.name}.zip"
        shutil.make_archive(ARCHIVE[:-4], "zip", root_dir=str(RUN_DIR.parent),
                            base_dir=RUN_DIR.name)
        print(f"Archive: {ARCHIVE}  ({os.path.getsize(ARCHIVE)/1e6:.1f} MB)")
        print()
        print("Next steps:")
        print("  1. Download the archive: clicking the Files icon at left, find")
        print(f"     {RUN_DIR.name}.zip, download it (colab VM may take 2 min)")
        print("  2. Unzip it on your Mac mini:")
        print(f"     unzip ~/Downloads/{RUN_DIR.name}.zip -d ~/genesis-v0/extract-tool/train/")
        print("  3. Push the new weights:")
        print("     cd ~/genesis-v0 && bash extract-tool/train/deploy_to_genesis.sh \\")
        print(f"       ~/genesis-v0/extract-tool/train/runs/{RUN_DIR.name}/walls.onnx")
        print()
        print("The deploy script will:")
        print("   - verify the ONNX is well-formed")
        print("   - upload it as a GitHub Release asset")
        print("   - update extract-tool/detect-model.mjs MODEL_URL_DEFAULT")
        print("   - git commit + push (CF Pages auto-deploys in ~30s)")
        print()
        print("Or, on Mac, you can also just run:")
        print("   cp /path/to/{RUN_DIR.name}/walls.onnx ~/genesis-v0/extract-tool/models/")
        print("   # then update MODEL_URL_DEFAULT manually if you want self-hosted")
    """),

    md("""
    ## (Optional) 8. Save the trained weights to your own HuggingFace account

    If you want a private copy of the fine-tuned weights on HF:
    """),

    code("""
        # You need a free HuggingFace token (https://huggingface.co/settings/tokens).
        # In Colab: paste it into the Secrets panel as HF_TOKEN, then:
        from huggingface_hub import HfApi, login
        import os
        tok = os.environ.get("HF_TOKEN") or "YOUR_HF_TOKEN_HERE"
        login(token=tok)
        api = HfApi()
        # Change "your-hf-org/genesis-walls" to whatever namespace you want.
        REPO_ID = "your-hf-org/genesis-walls-garcia"
        api.create_repo(REPO_ID, exist_ok=True, private=True)
        api.upload_folder(
            folder_path=str(RUN_DIR),
            repo_id=REPO_ID,
            commit_message=f"fine-tune {RUN_DIR.name}",
        )
        print(f"Uploaded to https://huggingface.co/{REPO_ID}")
    """),
]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "genesis_walls_finetune.ipynb")
    args = p.parse_args()

    nb = {
        "cells": CELLS,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.11"},
            "accelerator": "GPU",
        },
        "nbformat": NB_FORMAT,
        "nbformat_minor": 5,
    }
    args.out.write_text(json.dumps(nb, indent=1, ensure_ascii=False))
    print(f"wrote {args.out} ({len(CELLS)} cells, {args.out.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
