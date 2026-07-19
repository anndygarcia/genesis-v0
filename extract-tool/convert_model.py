"""
Convert Yytsi/floorplan-to-3d-walls (PyTorch) → ONNX for browser inference.

Output: ./models/walls.onnx — segmentation model that emits
4-class masks (floor/wall/door/window) at 512x512 input resolution.
"""
import torch
import segmentation_models_pytorch as smp
from safetensors.torch import load_file
import json
import os

MODEL_DIR = os.path.join(os.path.dirname(__file__), 'models')
OUT_PATH = os.path.join(MODEL_DIR, 'walls.onnx')

# 1. Build the same architecture as the trained model
model = smp.Unet(
    encoder_name='resnet34',
    encoder_weights=None,            # we'll load our trained weights
    in_channels=3,
    classes=4,                       # floor / wall / door / window
    activation=None,                 # raw logits
)

# 2. Load the trained weights
weights_path = os.path.join(MODEL_DIR, 'best.safetensors')
state = load_file(weights_path)
# Strip 'model.' prefix if present (training scripts vary)
clean = {k.replace('model.', ''): v for k, v in state.items()}
# Drop non-parameter buffers (epoch, best_miou)
clean = {k: v for k, v in clean.items() if 'num_batches' not in k and 'epoch' not in k and 'best_' not in k}
missing, unexpected = model.load_state_dict(clean, strict=False)
print(f"Loaded. missing={len(missing)} unexpected={len(unexpected)}")
if missing[:5]:
    print("  missing examples:", missing[:5])
if unexpected[:5]:
    print("  unexpected examples:", unexpected[:5])

model.eval()

# 3. Export to ONNX with all weights embedded inline (single file).
# PyTorch's exporter creates an external .data file by default for models
# with weights > 2GB; ours is 98MB but has many small tensors, so we
# force an inline save and then strip the external data file.
dummy = torch.randn(1, 3, 512, 512)
torch.onnx.export(
    model,
    dummy,
    OUT_PATH,
    opset_version=13,
    input_names=['image'],
    output_names=['logits'],
    dynamic_axes={'image': {0: 'batch'}, 'logits': {0: 'batch'}},
    do_constant_folding=True,
)

# The export puts large tensors in an external file. Re-load and
# inline everything so deploys have a single .onnx file.
from onnx import ModelProto, save_model
import onnx.onnx_ml_pb2 as pb
m = ModelProto()
with open(OUT_PATH, 'rb') as f:
    m.ParseFromString(f.read())

data_file = OUT_PATH + '.data'
if os.path.exists(data_file):
    with open(data_file, 'rb') as f:
        full_data = f.read()
    for t in m.graph.initializer:
        if t.data_location == pb.TensorProto.EXTERNAL:
            offset = length = 0
            for entry in t.external_data:
                if entry.key == 'offset':
                    offset = int(entry.value)
                elif entry.key == 'length':
                    length = int(entry.value)
            t.raw_data = full_data[offset:offset + length]
            del t.external_data[:]
            t.data_location = pb.TensorProto.DEFAULT
    save_model(m, OUT_PATH, save_as_external_data=False, all_tensors_to_one_file=True)
    os.remove(data_file)
    print(f"Inlined weights into {OUT_PATH}")

size = os.path.getsize(OUT_PATH) / 1024 / 1024
print(f"Wrote {OUT_PATH} ({size:.1f} MB)")

# 4. Quick sanity check: run the ONNX model and the PyTorch model on the same input
import onnx
import onnxruntime as ort
import numpy as np

sess = ort.InferenceSession(OUT_PATH, providers=['CPUExecutionProvider'])
ort_out = sess.run(None, {'image': dummy.numpy()})[0]
pt_out = model(dummy).detach().numpy()
diff = np.abs(ort_out - pt_out).max()
print(f"PyTorch vs ONNX max abs diff: {diff:.6f}")

# Print input shape expected
print(f"Input: {sess.get_inputs()[0].name}  shape={sess.get_inputs()[0].shape}")
print(f"Output: {sess.get_outputs()[0].name}  shape={sess.get_outputs()[0].shape}")
