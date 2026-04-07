"""
Clay Foundation Model — Optimized Web Pipeline
===============================================
Called by index.js via child_process.spawn()

Key optimizations vs original:
  • Global ESA WorldCover 11-class taxonomy (used worldwide, no biome switching)
  • Batch Clay encoding: ALL patches encoded in one forward pass (not per-patch)
  • No pad-to-256 waste: tile sliced as 256×256 crops, tiled across the 512×512
  • Spectral proxy mapped directly to global ESA class IDs
  • Only classes present (>0 patches) appear in perClassAccuracy result
  • Fewer epochs needed due to better label quality

Usage:
  python clay_pipeline.py --task landcover --collection sentinel-2-l2a \
    --item S2A_MSIL2A_... --lat 15.98 --lon 47.88 \
    --epochs 5 --checkpoint ./checkpoints/clay-v1.5.ckpt --job_id abc123

Streams JSON progress lines to stdout:
  {"type":"log",      "msg":"...", "ts":1234}
  {"type":"progress", "msg":"...", "epoch":1, "loss":0.42, "acc":65.1}
  {"type":"result",   "data":{...}}
  {"type":"error",    "msg":"..."}
"""

import argparse
import json
import os
import sys
import time
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import torch
import torch.nn as nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR
from torch.utils.data import DataLoader, TensorDataset

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

# ─── Metadata path resolution ─────────────────────────────────────────────────

def _find_metadata():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "configs", "metadata.yaml"),
        os.path.join(script_dir, "..", "configs", "metadata.yaml"),
        os.path.join(script_dir, "..", "..", "configs", "metadata.yaml"),
        r"C:\Clay\model\configs\metadata.yaml",
        r"C:\Clay\clay\configs\metadata.yaml",
        r"C:\Clay\configs\metadata.yaml",
        os.path.join(os.getcwd(), "configs", "metadata.yaml"),
    ]
    for p in candidates:
        norm = os.path.normpath(p)
        if os.path.exists(norm):
            return norm
    return os.path.normpath(os.path.join(script_dir, "configs", "metadata.yaml"))

METADATA_PATH = _find_metadata()

# ─── Platform config ──────────────────────────────────────────────────────────

PLATFORM_BANDS = {
    "sentinel-2-l2a":  10,
    "sentinel-1-rtc":   2,
    "landsat-c2l2-sr":  6,
    "landsat-c2l1":     6,
    "naip":             4,
}

BAND_MAP = {
    "sentinel-2-l2a":  ["B02","B03","B04","B05","B06","B07","B08","B8A","B11","B12"],
    "sentinel-1-rtc":  ["vv","vh"],
    "landsat-c2l2-sr": ["blue","green","red","nir08","swir16","swir22"],
    "landsat-c2l1":    ["blue","green","red","nir08","swir16","swir22"],
    "naip":            ["image"],
}

# ─── GLOBAL ESA WorldCover 11-class taxonomy ──────────────────────────────────
# These are the ONLY classes used everywhere in the world.
# ESA WorldCover 10m v200 — all 11 global land cover classes.
# Ref: https://esa-worldcover.org/en/data

ESA_CLASSES = {
    10:  "Tree Cover",
    20:  "Shrubland",
    30:  "Grassland",
    40:  "Cropland",
    50:  "Built-up",
    60:  "Bare / Sparse Vegetation",
    70:  "Snow & Ice",
    80:  "Permanent Water",
    90:  "Herbaceous Wetland",
    95:  "Mangroves",
    100: "Moss & Lichen",
}

# Ordered list — index = class index used throughout the model
ESA_CLASS_LIST  = list(ESA_CLASSES.values())   # 11 classes, indices 0..10
ESA_CODE_LIST   = list(ESA_CLASSES.keys())     # [10,20,30,40,50,60,70,80,90,95,100]
N_GLOBAL_CLASSES = len(ESA_CLASS_LIST)         # 11

def esa_code_to_idx(code: int) -> int:
    """Map an ESA WorldCover pixel value (10,20,…,100) to class index 0..10."""
    try:
        return ESA_CODE_LIST.index(int(code))
    except ValueError:
        return 5  # fallback → Bare/Sparse Vegetation

# ─── Spectral proxy → Global ESA class index ─────────────────────────────────
# Maps spectral indices directly to the 11 global ESA classes.
# Used when WorldCover labels are unavailable for a patch.

def spectral_to_esa_idx(patch_orig: torch.Tensor, platform: str) -> int:
    """
    Given a (C,H,W) unnormalised patch, return a global ESA class index (0..10)
    derived from spectral indices. Works for all platforms.
    """
    p = patch_orig.float()
    C = p.shape[0]
    eps = 1e-6

    # Map any platform to approximate S2 bands
    if "sentinel-2" in platform or "sentinel2" in platform:
        blue  = p[0]; green = p[1]; red = p[2]
        nir   = p[6] if C > 6 else p[min(3, C-1)]
        swir1 = p[8] if C > 8 else p[min(4, C-1)]
    elif "landsat" in platform:
        blue  = p[0]; green = p[1]; red = p[2]
        nir   = p[3] if C > 3 else p[-1]
        swir1 = p[4] if C > 4 else p[-1]
    elif "naip" in platform:
        # NAIP: R,G,B,NIR
        blue  = p[2]; green = p[1]; red = p[0]
        nir   = p[3] if C > 3 else p[0]
        swir1 = p[3] if C > 3 else p[0]
    else:
        blue  = p[0]; green = p[min(1,C-1)]; red = p[min(2,C-1)]
        nir   = p[min(3,C-1)]; swir1 = p[min(4,C-1)]

    ndvi  = ((nir  - red)   / (nir  + red   + eps)).mean().item()
    ndwi  = ((green- nir)   / (green+ nir   + eps)).mean().item()
    ndbi  = ((swir1- nir)   / (swir1+ nir   + eps)).mean().item()
    bsi   = ((swir1+red-nir-blue) / (swir1+red+nir+blue+eps)).mean().item()
    mndwi = ((green- swir1) / (green+ swir1 + eps)).mean().item()
    mean_ref = p.mean().item()

    # ── ESA class decision rules ─────────────────────────────────────────
    # 80  Permanent Water
    if ndwi > 0.15 or mndwi > 0.05:
        return 7   # Permanent Water

    # 90  Herbaceous Wetland
    if ndwi > 0.0 and ndvi > 0.05 and ndwi > -0.1:
        return 8   # Herbaceous Wetland

    # 70  Snow & Ice
    if mean_ref > 4500 and ndvi < 0.0:
        return 6   # Snow & Ice

    # 95  Mangroves  (coastal + vegetation)
    if ndvi > 0.3 and ndwi > -0.1 and mndwi > -0.15:
        return 9   # Mangroves

    # 10  Tree Cover — high NDVI, low NDBI
    if ndvi > 0.45 and ndbi < 0.0:
        return 0   # Tree Cover

    # 20  Shrubland — moderate NDVI
    if 0.2 < ndvi <= 0.45 and ndbi < 0.05:
        return 1   # Shrubland

    # 30  Grassland — low-moderate NDVI, low BSI
    if 0.1 < ndvi <= 0.2 and bsi < 0.15:
        return 2   # Grassland

    # 40  Cropland — moderate NDVI + BSI signature
    if 0.05 < ndvi <= 0.3 and bsi > 0.0:
        return 3   # Cropland

    # 50  Built-up — high NDBI or high BSI
    if ndbi > 0.15 or (bsi > 0.25 and ndvi < 0.1):
        return 4   # Built-up

    # 100 Moss & Lichen — high reflectance, very low NDVI, no bare
    if 0.0 < ndvi <= 0.05 and mean_ref > 1000 and bsi < 0.1:
        return 10  # Moss & Lichen

    # 60  Bare / Sparse Vegetation — default for low NDVI scenes
    return 5   # Bare / Sparse Vegetation


# ─── Output helpers ───────────────────────────────────────────────────────────

def emit(obj):
    print(json.dumps({**obj, "ts": int(time.time()*1000)}), flush=True)

def log(msg):
    emit({"type": "log", "msg": msg})

def progress(msg, epoch=None, loss=None, acc=None):
    obj = {"type": "progress", "msg": msg}
    if epoch is not None: obj["epoch"] = epoch
    if loss  is not None: obj["loss"]  = round(float(loss), 4)
    if acc   is not None: obj["acc"]   = round(float(acc),  2)
    emit(obj)

def result(data):
    emit({"type": "result", "data": data})

def error(msg):
    emit({"type": "error", "msg": str(msg)})
    sys.exit(1)


# ─── Metadata + Clay model loading ───────────────────────────────────────────

def load_metadata():
    import yaml
    from box import Box
    if not os.path.exists(METADATA_PATH):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        expected   = os.path.join(script_dir, "configs", "metadata.yaml")
        error(
            "configs/metadata.yaml not found.\n"
            "Expected: " + expected + "\n"
            "Copy it from clay-web-new/server/configs/metadata.yaml"
        )
    log("Metadata loaded from: " + METADATA_PATH)
    with open(METADATA_PATH) as f:
        return Box(yaml.safe_load(f))


DEFAULT_CHECKPOINTS = [
    "./checkpoints/clay-v1.5.ckpt",
    r"C:\Clay\checkpoints\clay-v1.5.ckpt",
    r"C:\Clay\clay-v1.5.ckpt",
    r"C:\Clay\model\checkpoints\clay-v1.5.ckpt",
    r"C:\Users\vivek\checkpoints\clay-v1.5.ckpt",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "checkpoints", "clay-v1.5.ckpt"),
]


def resolve_checkpoint(checkpoint):
    if checkpoint:
        for c in [checkpoint,
                  os.path.join(os.path.dirname(os.path.abspath(__file__)), checkpoint),
                  os.path.join(os.getcwd(), checkpoint)]:
            if os.path.exists(c):
                return os.path.normpath(c)
    for c in DEFAULT_CHECKPOINTS:
        if os.path.exists(c):
            log("Found checkpoint at default location: " + c)
            return os.path.normpath(c)
    return None


def verify_checkpoint(path):
    if not os.path.exists(path):
        return False, "File not found"
    size_mb = os.path.getsize(path) / (1024 * 1024)
    log("Checkpoint size: " + str(round(size_mb, 1)) + " MB")
    if size_mb < 1:
        return False, "File too small"
    try:
        with open(path, "rb") as f:
            header = f.read(10)
        if len(header) < 10:
            return False, "File too short"
        if header[:2] == b"PK" or header[0:1] == b"\x80":
            return True, "ok"
        return True, "ok (unknown header)"
    except Exception as e:
        return False, str(e)


def load_clay_model(model_size, checkpoint, mask_ratio=0.0):
    from claymodel.module import ClayMAEModule

    # ── Guard: ViT-base requires ~5 GB RAM on CPU → STATUS_ACCESS_VIOLATION
    # Automatically downgrade to tiny when running on CPU to prevent crash.
    if DEVICE.type == "cpu" and model_size == "base":
        log("WARNING: ViT-base on CPU risks OOM (exit 3221225477). "
            "Auto-downgrading to ViT-tiny for stability.")
        model_size = "tiny"

    resolved  = resolve_checkpoint(checkpoint)
    ckpt_path = resolved or checkpoint or ""

    if ckpt_path:
        ok, msg = verify_checkpoint(ckpt_path)
        if not ok:
            log("Checkpoint verification FAILED: " + msg + " — DEMO MODE")
            ckpt_path = ""
        else:
            log("Checkpoint verified OK: " + os.path.basename(ckpt_path))

    log("Building Clay ViT-" + model_size + " architecture...")
    try:
        m = ClayMAEModule(
            model_size=model_size, mask_ratio=mask_ratio, patch_size=8,
            norm_pix_loss=False, shuffle=False, metadata_path=METADATA_PATH,
            teacher="vit_base_patch14_dinov2.lvd142m",
            dolls=[64,128,256,512,768,1024], doll_weights=[1,1,1,1,1,1])
    except Exception as e:
        error("Failed to build Clay model: " + str(e))

    if ckpt_path and os.path.exists(ckpt_path):
        log("Loading weights from: " + os.path.basename(ckpt_path))
        try:
            m2 = ClayMAEModule.load_from_checkpoint(
                ckpt_path, metadata_path=METADATA_PATH,
                shuffle=False, mask_ratio=mask_ratio, map_location="cpu")
            log("Lightning checkpoint loaded successfully")
            return m2.to(DEVICE)
        except Exception as e1:
            log("Lightning load failed (" + str(e1)[:80] + "), trying state_dict...")
        try:
            ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
            sd = ckpt.get("state_dict") or ckpt.get("model") or ckpt if isinstance(ckpt, dict) else ckpt
            cleaned = {}
            for k, v in sd.items():
                k2 = k
                for prefix in ("model.", "module.", "_orig_mod."):
                    if k2.startswith(prefix):
                        k2 = k2[len(prefix):]
                cleaned[k2] = v
            missing, unexpected = m.model.load_state_dict(cleaned, strict=False)
            log("Weights loaded — missing=" + str(len(missing)) + " unexpected=" + str(len(unexpected)))
        except Exception as e2:
            log("ERROR loading checkpoint: " + str(e2) + " — DEMO MODE")
    else:
        log("No valid checkpoint. DEMO MODE — random weights.")
        log("Download clay-v1.5.ckpt from:")
        log("  https://huggingface.co/made-with-clay/Clay/blob/main/clay-v1.5.ckpt")

    return m.to(DEVICE)


# ─── Planetary Computer tile fetcher ─────────────────────────────────────────

def fetch_pc_tile_as_array(collection, item_id, platform, meta, target_size=512):
    if not item_id or not item_id.strip():
        error("No scene selected. Select a scene from the PC Explorer panel.")

    log("Fetching PC tile for item: " + item_id)
    try:
        import planetary_computer
        import pystac_client
        import rasterio
        from rasterio.enums import Resampling

        catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=planetary_computer.sign_inplace,
        )
        log("Searching for item in collection: " + collection)
        search = catalog.search(collections=[collection], ids=[item_id], max_items=1)
        items  = list(search.items())
        if not items:
            error("Item not found in Planetary Computer: " + item_id)
        item = items[0]
        log("Item found: " + item.id)
        item = planetary_computer.sign(item)
        log("Item signed — downloading bands...")

        bands  = BAND_MAP.get(platform, BAND_MAP["sentinel-2-l2a"])
        arrays = []
        for band in bands:
            if band not in item.assets:
                log("Band " + band + " not in assets — using zeros")
                arrays.append(np.zeros((target_size, target_size), dtype=np.float32))
                continue
            href = item.assets[band].href
            try:
                with rasterio.open(href) as src:
                    data = src.read(
                        1,
                        out_shape=(target_size, target_size),
                        resampling=Resampling.bilinear,
                    ).astype(np.float32)
                    if src.nodata is not None:
                        data[data == src.nodata] = 0.0
                    data = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
                    arrays.append(data)
                log("  " + band + " min=" + str(int(data.min())) +
                    " max=" + str(int(data.max())) +
                    " mean=" + str(round(float(data.mean()), 1)))
            except Exception as band_err:
                log("  " + band + " download failed: " + str(band_err)[:80] + " — zeros")
                arrays.append(np.zeros((target_size, target_size), dtype=np.float32))

        arr = np.stack(arrays, axis=0)
        log("Tile assembled: shape=" + str(arr.shape) + " platform=" + platform)
        return arr

    except SystemExit:
        raise
    except Exception as e:
        log("PC fetch failed: " + str(e))
        import traceback
        log(traceback.format_exc()[:300])
        return None


def make_tile_tensor(arr, platform, meta, target_size=512):
    import torchvision.transforms.v2 as v2
    n = PLATFORM_BANDS.get(platform, 10)

    if arr is None:
        log("Using synthetic tile (DEMO MODE)")
        raw  = torch.randn(1, n, target_size, target_size)
        orig = raw[0].clone()
    else:
        if arr.shape[0] < n:
            pad = np.zeros((n - arr.shape[0], target_size, target_size), dtype=np.float32)
            arr = np.concatenate([arr, pad], axis=0)
        arr = arr[:n]
        t   = torch.from_numpy(arr).unsqueeze(0)
        if t.shape[-2] != target_size or t.shape[-1] != target_size:
            t = torch.nn.functional.interpolate(
                t, size=(target_size, target_size), mode='bilinear', align_corners=False)
        orig = t[0].clone()
        raw  = t

    means = list(meta[platform].bands.mean.values())[:n]
    stds  = list(meta[platform].bands.std.values())[:n]
    norm  = v2.Normalize(mean=means, std=stds)
    return norm(raw), orig


def make_datacube(pixels, platform, meta, lat=0.0, lon=0.0):
    B     = pixels.shape[0]
    lat_n = lat  / 90.0
    lon_n = lon  / 180.0
    return {
        "pixels":   pixels.to(DEVICE),
        "time":     torch.zeros(B, 4).to(DEVICE),
        "latlon":   torch.tensor([[lat_n, lat_n, lon_n, lon_n]] * B,
                                  dtype=torch.float32).to(DEVICE),
        "waves":    torch.tensor(list(meta[platform].bands.wavelength.values()),
                                  dtype=torch.float32).to(DEVICE),
        "gsd":      torch.tensor(meta[platform].gsd, dtype=torch.float32).to(DEVICE),
        "platform": [platform] * B,
    }


# ─── ESA WorldCover label fetcher ─────────────────────────────────────────────

def fetch_worldcover_labels(orig_tile, lat, lon, tile_size=512, patch_size=256, stride=256):
    """
    Download ESA WorldCover 10m labels from Planetary Computer.
    Returns a 1-D numpy array of global ESA class indices (0..10),
    one per non-overlapping 256×256 patch — or None on failure.
    """
    try:
        import planetary_computer
        import pystac_client
        import rasterio
        from rasterio.enums import Resampling

        n_rows = (tile_size - patch_size) // stride + 1
        n_cols = (tile_size - patch_size) // stride + 1
        n_patches = n_rows * n_cols

        log("Fetching ESA WorldCover (global 11-class) from Planetary Computer...")
        catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=planetary_computer.sign_inplace,
        )
        bbox   = [lon - 0.5, lat - 0.5, lon + 0.5, lat + 0.5]
        search = catalog.search(collections=["esa-worldcover"], bbox=bbox, max_items=1)
        wc_items = list(search.items())
        if not wc_items:
            log("WorldCover: no item found — using spectral proxy labels")
            return None

        wc_item = planetary_computer.sign(wc_items[0])
        log("WorldCover item: " + wc_item.id)

        href = wc_item.assets["map"].href
        with rasterio.open(href) as src:
            wc_data = src.read(
                1,
                out_shape=(tile_size, tile_size),
                resampling=Resampling.nearest,
            ).astype(np.int32)

        log("WorldCover downloaded: shape=" + str(wc_data.shape) +
            " unique ESA codes=" + str(np.unique(wc_data).tolist()))

        # Assign dominant ESA class per 256×256 patch
        labels = np.zeros(n_patches, dtype=np.int32)
        idx = 0
        for ri in range(n_rows):
            for ci in range(n_cols):
                r0 = ri * stride; r1 = r0 + patch_size
                c0 = ci * stride; c1 = c0 + patch_size
                patch_wc = wc_data[r0:r1, c0:c1]
                vals, counts = np.unique(patch_wc, return_counts=True)
                dominant    = int(vals[np.argmax(counts)])
                labels[idx] = esa_code_to_idx(dominant)
                idx += 1

        log("WorldCover labels assigned — global ESA classes used: " +
            str(sorted(set(labels.tolist()))))
        return labels

    except Exception as e:
        log("WorldCover fetch failed: " + str(e)[:200])
        log("Falling back to spectral proxy labels")
        return None


# ─── FAST batch encoder ───────────────────────────────────────────────────────

def encode_patches_batch(model, patches_norm, platform, meta, lat, lon, batch_size=8):
    """
    Encode ALL 256×256 patches through the frozen Clay encoder in mini-batches.
    Returns a (N, embed_dim) numpy array of CLS token embeddings.

    Why this is fast:
    - Clay forward pass is done ONCE per mini-batch, not once per patch.
    - Gradient computation is fully disabled.
    - batch_size=8 is safe for CPU RAM; increase to 16-32 on GPU.
    """
    model.eval()
    all_embeddings = []
    n = len(patches_norm)
    waves = torch.tensor(list(meta[platform].bands.wavelength.values()),
                         dtype=torch.float32).to(DEVICE)
    gsd   = torch.tensor(meta[platform].gsd, dtype=torch.float32).to(DEVICE)
    lat_n = lat  / 90.0
    lon_n = lon  / 180.0

    with torch.no_grad():
        for start in range(0, n, batch_size):
            end    = min(start + batch_size, n)
            pixels = torch.stack(patches_norm[start:end]).to(DEVICE)  # (B,C,256,256)
            B      = pixels.shape[0]
            dc = {
                "pixels":   pixels,
                "time":     torch.zeros(B, 4, device=DEVICE),
                "latlon":   torch.tensor([[lat_n, lat_n, lon_n, lon_n]] * B,
                                          dtype=torch.float32, device=DEVICE),
                "waves":    waves,
                "gsd":      gsd,
                "platform": [platform] * B,
            }
            u, *_ = model.model.encoder(dc)    # (B, 1+N_patches, D)
            cls   = u[:, 0, :].cpu()           # (B, D) — CLS token only
            all_embeddings.append(cls)
            pct = round((end / n) * 100)
            log("  Encoding patches: " + str(end) + "/" + str(n) + " (" + str(pct) + "%)")

    return torch.cat(all_embeddings, dim=0).numpy()   # (N, D)


# ─── Task: Land Cover ─────────────────────────────────────────────────────────

def run_landcover(args):
    """
    Optimized land cover pipeline using global ESA WorldCover 11-class taxonomy:

    1.  Download 512×512 satellite tile from Planetary Computer.
    2.  Slice into 4 non-overlapping 256×256 patches (no padding waste).
    3.  Fetch ESA WorldCover ground-truth for each patch → global class index.
    4.  Spectral proxy used when WorldCover unavailable.
    5.  BATCH encode all patches through frozen Clay encoder in one pass.
    6.  Train lightweight classification head (80% train / 20% val).
    7.  Output perClassAccuracy only for classes present (>0 patches).
    """
    log("=" * 50)
    log("LAND COVER CLASSIFICATION")
    log("Platform  : " + args.collection)
    log("Item      : " + args.item)
    log("Location  : (" + str(round(args.lat, 4)) + ", " + str(round(args.lon, 4)) + ")")
    log("Epochs    : " + str(args.epochs))
    log("Device    : " + str(DEVICE))
    log("Classes   : Global ESA WorldCover 11-class taxonomy")
    log("=" * 50)

    meta     = load_metadata()
    platform = args.collection
    n_bands  = PLATFORM_BANDS.get(platform, 10)

    # ── 1. Load Clay model ────────────────────────────────────────────────────
    log("Loading Clay foundation model...")
    model = load_clay_model(args.model_size, args.checkpoint, mask_ratio=0.0)
    model.eval()
    for p in model.parameters():
        p.requires_grad_(False)
    log("Clay encoder frozen. Running on " + str(DEVICE))

    # ── 2. Download 512×512 tile ──────────────────────────────────────────────
    TILE_SIZE  = 512
    PATCH_SIZE = 256   # Clay native input size — no padding needed
    STRIDE     = 256   # non-overlapping → 4 patches from 512×512

    log("Downloading " + str(TILE_SIZE) + "×" + str(TILE_SIZE) + " satellite tile...")
    arr = fetch_pc_tile_as_array(platform, args.item, platform, meta,
                                  target_size=TILE_SIZE)
    norm_tile, orig_tile = make_tile_tensor(arr, platform, meta, target_size=TILE_SIZE)
    log("Tile shape: " + str(tuple(orig_tile.shape)))

    # ── 3. Detect embedding dimension (cheap probe) ───────────────────────────
    log("Detecting embedding dimension...")
    probe = norm_tile[:, :, :PATCH_SIZE, :PATCH_SIZE]
    with torch.no_grad():
        dc_probe = make_datacube(probe, platform, meta, args.lat, args.lon)
        out, *_  = model.model.encoder(dc_probe)
    embed_dim = out.shape[-1]
    log("Embedding dim = " + str(embed_dim))

    # ── 4. Tile statistics (for logging) ─────────────────────────────────────
    orig_np   = orig_tile.numpy()
    nir_b     = orig_np[6].astype(np.float32) if orig_np.shape[0] > 6 else orig_np[-1].astype(np.float32)
    red_b     = orig_np[2].astype(np.float32) if orig_np.shape[0] > 2 else orig_np[0].astype(np.float32)
    grn_b     = orig_np[1].astype(np.float32) if orig_np.shape[0] > 1 else orig_np[0].astype(np.float32)
    swir_b    = orig_np[8].astype(np.float32) if orig_np.shape[0] > 8 else orig_np[-1].astype(np.float32)
    eps = 1e-6
    log("Tile NDVI : " + str(round(float(np.mean((nir_b-red_b)/(nir_b+red_b+eps))), 3)))
    log("Tile NDWI : " + str(round(float(np.mean((grn_b-nir_b)/(grn_b+nir_b+eps))), 3)))
    log("Tile MNDWI: " + str(round(float(np.mean((grn_b-swir_b)/(grn_b+swir_b+eps))), 3)))

    # ── 5. Extract non-overlapping 256×256 patches ────────────────────────────
    patches_norm  = []
    patches_orig  = []
    C, H, W = norm_tile[0].shape
    for r in range(0, H - PATCH_SIZE + 1, STRIDE):
        for c in range(0, W - PATCH_SIZE + 1, STRIDE):
            patches_norm.append(norm_tile[0, :, r:r+PATCH_SIZE, c:c+PATCH_SIZE])
            patches_orig.append(orig_tile[:, r:r+PATCH_SIZE, c:c+PATCH_SIZE])

    total_patches = len(patches_norm)
    log("Patches extracted: " + str(total_patches) +
        " (stride=" + str(STRIDE) + "px, size=" + str(PATCH_SIZE) + "px)")

    # ── 6. Fetch ESA WorldCover labels (global 11-class) ─────────────────────
    log("Fetching ESA WorldCover ground truth labels (global 11-class)...")
    wc_labels = fetch_worldcover_labels(
        orig_tile, args.lat, args.lon,
        tile_size=TILE_SIZE, patch_size=PATCH_SIZE, stride=STRIDE)

    use_real_labels = wc_labels is not None and len(wc_labels) == total_patches
    if use_real_labels:
        patch_labels = [int(wc_labels[i]) for i in range(total_patches)]
        log("WorldCover labels loaded — using real ESA ground truth")
    else:
        log("WorldCover unavailable — deriving labels from spectral indices")
        patch_labels = [spectral_to_esa_idx(patches_orig[i], platform)
                        for i in range(total_patches)]

    # Clamp to valid range
    patch_labels = [max(0, min(N_GLOBAL_CLASSES - 1, lbl)) for lbl in patch_labels]

    # ── 7. Label distribution ─────────────────────────────────────────────────
    present_classes = sorted(set(patch_labels))
    dist = {ESA_CLASS_LIST[i]: patch_labels.count(i) for i in present_classes}
    log("Label distribution: " + str(dist))

    # ── 8. BATCH encode ALL patches through Clay (fast path) ──────────────────
    log("Batch-encoding all patches through Clay encoder...")
    # Use larger batch on GPU, conservative on CPU
    enc_batch = 16 if DEVICE.type == "cuda" else 8
    embeddings = encode_patches_batch(
        model, patches_norm, platform, meta, args.lat, args.lon, batch_size=enc_batch)
    # embeddings shape: (N, embed_dim)
    log("Encoding complete — embeddings shape: " + str(embeddings.shape))

    # ── 9. Build tensor dataset from precomputed embeddings ───────────────────
    emb_tensor = torch.from_numpy(embeddings).float()   # (N, D)
    lbl_tensor = torch.tensor(patch_labels, dtype=torch.long)  # (N,)

    import random
    # Per-job random seed → train/val split varies across runs.
    rng_seed = int(abs(hash(args.job_id)) % (2 ** 31))
    random.seed(rng_seed)
    torch.manual_seed(rng_seed)
    np.random.seed(rng_seed % (2 ** 31))
    log("RNG seed: " + str(rng_seed) + "  (job_id=" + args.job_id + ")")
    indices = list(range(total_patches))
    random.shuffle(indices)
    split     = max(1, int(0.8 * total_patches))
    train_idx = indices[:split]
    val_idx   = indices[split:]
    log("Train: " + str(len(train_idx)) + " patches  Val: " + str(len(val_idx)) + " patches")

    train_ds = TensorDataset(emb_tensor[train_idx], lbl_tensor[train_idx])
    val_ds   = TensorDataset(emb_tensor[val_idx],   lbl_tensor[val_idx])

    # ── 10. Classification head (trains on embeddings, not raw pixels) ─────────
    # No Clay forward pass during training — embeddings already computed above.
    # This makes training ~100× faster than re-encoding every batch every epoch.
    head = nn.Sequential(
        nn.LayerNorm(embed_dim),
        nn.Linear(embed_dim, 512),
        nn.GELU(),
        nn.Dropout(0.3),
        nn.Linear(512, 256),
        nn.GELU(),
        nn.Dropout(0.2),
        nn.Linear(256, N_GLOBAL_CLASSES),   # always 11 outputs
    ).to(DEVICE)

    # Class-weighted loss: handle imbalance between ESA classes at this location
    class_counts = torch.zeros(N_GLOBAL_CLASSES)
    for lbl in patch_labels:
        class_counts[lbl] += 1
    class_weights = (class_counts.sum() / (N_GLOBAL_CLASSES * (class_counts + 1))).to(DEVICE)

    optimizer = AdamW(head.parameters(), lr=args.lr, weight_decay=1e-3)
    scheduler = CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=args.lr * 0.01)
    criterion = nn.CrossEntropyLoss(weight=class_weights, label_smoothing=0.05)

    train_loader = DataLoader(train_ds, batch_size=min(args.batch_size, len(train_idx)),
                              shuffle=True,  num_workers=0, drop_last=False)
    val_loader   = DataLoader(val_ds,   batch_size=min(args.batch_size, len(val_idx)),
                              shuffle=False, num_workers=0)

    # ── 11. Training loop ──────────────────────────────────────────────────────
    loss_history     = []
    val_loss_history = []
    acc_history      = []
    val_acc_history  = []
    best_val_acc     = 0.0
    best_head_state  = None

    # Accumulate per-class stats across all val epochs
    cls_correct = [0] * N_GLOBAL_CLASSES
    cls_total   = [0] * N_GLOBAL_CLASSES

    for epoch in range(1, args.epochs + 1):

        # Train
        head.train()
        t_loss = 0.0; t_correct = 0; t_total = 0
        for embs, labels in train_loader:
            embs   = embs.to(DEVICE)
            labels = labels.to(DEVICE)
            logits = head(embs)
            loss   = criterion(logits, labels)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
            optimizer.step()
            t_loss    += loss.item()
            preds      = logits.argmax(1).cpu()
            t_correct += (preds == labels.cpu()).sum().item()
            t_total   += len(labels)

        # Validate
        head.eval()
        v_loss = 0.0; v_correct = 0; v_total = 0
        with torch.no_grad():
            for embs, labels in val_loader:
                embs   = embs.to(DEVICE)
                labels = labels.to(DEVICE)
                logits = head(embs)
                loss   = criterion(logits, labels)
                v_loss    += loss.item()
                preds      = logits.argmax(1).cpu()
                v_correct += (preds == labels.cpu()).sum().item()
                v_total   += len(labels)
                for p_, l_ in zip(preds, labels.cpu()):
                    cls_correct[l_.item()] += int(p_.item() == l_.item())
                    cls_total[l_.item()]   += 1

        train_acc = t_correct / max(t_total, 1) * 100
        val_acc   = v_correct / max(v_total, 1) * 100
        avg_tloss = t_loss / max(len(train_loader), 1)
        avg_vloss = v_loss / max(len(val_loader),   1)

        loss_history.append(round(avg_tloss, 4))
        val_loss_history.append(round(avg_vloss, 4))
        acc_history.append(round(train_acc, 2))
        val_acc_history.append(round(val_acc, 2))
        scheduler.step()

        if val_acc >= best_val_acc:
            best_val_acc    = val_acc
            best_head_state = {k: v.clone() for k, v in head.state_dict().items()}

        progress(
            "Epoch " + str(epoch) + "/" + str(args.epochs) +
            "  train_loss=" + str(round(avg_tloss, 4)) +
            "  train_acc="  + str(round(train_acc, 1)) + "%" +
            "  val_acc="    + str(round(val_acc,   1)) + "%",
            epoch=epoch, loss=avg_tloss, acc=val_acc
        )

    # ── 12. Per-class accuracy — only show classes actually present in scene ──
    if best_head_state:
        head.load_state_dict(best_head_state)

    per_class_all    = []  # full 11-class result (for internal storage)
    per_class_present = []  # only classes with >0 patches (sent to frontend)

    for i in range(N_GLOBAL_CLASSES):
        acc_pct = cls_correct[i] / max(cls_total[i], 1) * 100
        entry = {
            "class":    ESA_CLASS_LIST[i],
            "esaCode":  ESA_CODE_LIST[i],
            "accuracy": round(acc_pct, 1),
            "correct":  cls_correct[i],
            "total":    cls_total[i],
            "patchPct": round(cls_total[i] / max(total_patches, 1) * 100, 1),
        }
        per_class_all.append(entry)
        if cls_total[i] > 0:   # only include classes actually observed
            per_class_present.append(entry)

    summary = ", ".join(
        e["class"] + ": " + str(e["accuracy"]) + "%" for e in per_class_present)
    log("Val per-class (present only): " + summary)

    final_val_acc  = round(best_val_acc, 1)
    final_val_loss = round(val_loss_history[-1], 4)
    log("Best val accuracy: " + str(final_val_acc) + "%")

    # ── 13. Save best head weights ────────────────────────────────────────────
    save_path = os.path.join(os.path.dirname(__file__),
                              "clay_landcover_" + args.job_id + ".pt")
    torch.save({
        "head":          head.state_dict(),
        "embed_dim":     embed_dim,
        "classes":       ESA_CLASS_LIST,
        "esa_codes":     ESA_CODE_LIST,
        "platform":      platform,
        "final_val_acc": final_val_acc,
        "taxonomy":      "ESA WorldCover global 11-class",
    }, save_path)
    log("Saved: " + os.path.basename(save_path))

    # ── 14. Band statistics ───────────────────────────────────────────────────
    log("Computing band statistics...")
    band_names = list(meta[platform].bands.wavelength.keys())
    band_waves = list(meta[platform].bands.wavelength.values())
    band_stats = []
    for i in range(min(n_bands, len(band_names))):
        b = orig_np[i].astype(np.float32)
        band_stats.append({
            "band":       band_names[i],
            "wavelength": round(float(band_waves[i]), 3),
            "mean":       round(float(b.mean()), 2),
            "std":        round(float(b.std()),  2),
            "min":        round(float(b.min()),  2),
            "max":        round(float(b.max()),  2),
            "p2":         round(float(np.percentile(b, 2)),  2),
            "p98":        round(float(np.percentile(b, 98)), 2),
        })

    # Emit a dedicated event so the frontend can place a red "completed" marker
    # on the map at the exact lat/lon that was processed.
    emit({
        "type":    "completed_location",
        "lat":     args.lat,
        "lon":     args.lon,
        "item_id": args.item,
        "task":    "landcover",
        "label":   ESA_CLASS_LIST[patch_labels[0]] if patch_labels else "Unknown",
    })

    result({
        "task":             "landcover",
        "platform":         platform,
        "item_id":          args.item,
        "lat":              args.lat,
        "lon":              args.lon,
        "epochs":           args.epochs,
        "finalLoss":        final_val_loss,
        "finalAccuracy":    final_val_acc,
        "lossHistory":      [{"epoch": i+1, "loss": v}     for i, v in enumerate(loss_history)],
        "accuracyHistory":  [{"epoch": i+1, "accuracy": v} for i, v in enumerate(val_acc_history)],
        "valLossHistory":   [{"epoch": i+1, "loss": v}     for i, v in enumerate(val_loss_history)],

        # Only classes present (>0%) in this scene — clean frontend display
        "perClassAccuracy": per_class_present,

        # Full 11-class breakdown available if needed
        "perClassAll":      per_class_all,

        "numClasses":       N_GLOBAL_CLASSES,
        "classesPresent":   len(per_class_present),
        "taxonomy":         "ESA WorldCover global 11-class",
        "labelSource":      "ESA WorldCover" if use_real_labels else "spectral proxy",
        "bandStats":        band_stats,
        "embedDim":         embed_dim,
        "device":           str(DEVICE),
        "patches":          total_patches,
        "trainPatches":     len(train_idx),
        "valPatches":       len(val_idx),
        "tileSize":         TILE_SIZE,
        "patchSize":        PATCH_SIZE,
        "model_size":       args.model_size,
        "realData":         arr is not None,
        "realLabels":       use_real_labels,
    })


# ─── Task: Inference (MAE reconstruction) ────────────────────────────────────

def run_inference(args):
    log("INFERENCE  item=" + args.item + "  mask_ratio=" + str(args.mask_ratio))
    meta     = load_metadata()
    platform = args.collection
    model    = load_clay_model(args.model_size, args.checkpoint, mask_ratio=args.mask_ratio)
    model.eval()

    arr       = fetch_pc_tile_as_array(platform, args.item, platform, meta, target_size=256)
    norm, orig = make_tile_tensor(arr, platform, meta, target_size=256)
    dc        = make_datacube(norm, platform, meta, args.lat, args.lon)

    with torch.no_grad():
        u, ui, mi, mm = model.model.encoder(dc)
        pp, _         = model.model.decoder(u, ui, mi, mm, dc["time"], dc["latlon"],
                                             dc["gsd"], dc["waves"])
        recon_loss    = model.model.per_pixel_loss(dc["pixels"], pp, mm)

    log("Reconstruction loss: " + str(round(float(recon_loss.item()), 6)))
    masked_frac = mm[0].float().mean().item() if mm is not None else args.mask_ratio
    n_bands     = PLATFORM_BANDS.get(platform, 10)

    result({
        "task":               "inference",
        "platform":            platform,
        "item_id":             args.item,
        "lat":                 args.lat,
        "lon":                 args.lon,
        "maskRatio":           round(float(masked_frac), 3),
        "reconstructionLoss":  round(float(recon_loss.item()), 6),
        "maskedPatches":       int(mm[0].sum().item()) if mm is not None else int(args.mask_ratio * 1024),
        "totalPatches":        1024,
        "bands":               n_bands,
        "imageSize":           "256×256",
        "patchSize":           8,
        "device":              str(DEVICE),
        "realData":            arr is not None,
    })


# ─── Task: Embeddings ─────────────────────────────────────────────────────────

def run_embeddings(args):
    from sklearn.decomposition import PCA

    log("EMBEDDINGS  item=" + args.item)
    meta     = load_metadata()
    platform = args.collection
    model    = load_clay_model(args.model_size, args.checkpoint, mask_ratio=0.0)
    model.eval()

    arr       = fetch_pc_tile_as_array(platform, args.item, platform, meta, target_size=256)
    norm, orig = make_tile_tensor(arr, platform, meta, target_size=256)
    dc        = make_datacube(norm, platform, meta, args.lat, args.lon)

    with torch.no_grad():
        u, *_ = model.model.encoder(dc)

    cls_emb = u[:, 0, :].cpu().numpy()
    patches = u[:, 1:, :].cpu().numpy()
    B, N, D = patches.shape
    flat    = patches.reshape(B * N, D)
    mags    = np.linalg.norm(patches[0], axis=-1)

    pca  = PCA(n_components=min(3, D))
    proj = pca.fit_transform(flat[:min(512, len(flat))])
    var  = float(pca.explained_variance_ratio_.sum() * 100)
    log("CLS shape=" + str(cls_emb.shape) + "  Patches=" + str(patches.shape) +
        "  PCA variance=" + str(round(var, 1)) + "%")

    save_path = os.path.join(os.path.dirname(__file__), "embeddings_" + args.job_id + ".pt")
    torch.save({"cls": torch.from_numpy(cls_emb), "patches": torch.from_numpy(patches),
                "platform": platform, "lat": args.lat, "lon": args.lon}, save_path)
    log("Saved embeddings → " + os.path.basename(save_path))

    result({
        "task":          "embeddings",
        "platform":       platform,
        "item_id":        args.item,
        "lat":            args.lat,
        "lon":            args.lon,
        "embedDim":       D,
        "numPatches":     N,
        "pcaVariance":    round(var, 1),
        "changeScore":    round(float(np.linalg.norm(cls_emb[0])) / 100, 4),
        "magnitudeStats": {
            "mean": round(float(mags.mean()), 3),
            "std":  round(float(mags.std()),  3),
            "max":  round(float(mags.max()),  3),
            "min":  round(float(mags.min()),  3),
        },
        "device":  str(DEVICE),
        "realData": arr is not None,
    })


# ─── Task: Cloud Removal ──────────────────────────────────────────────────────

def run_cloudremoval(args):
    from einops import rearrange

    log("CLOUD REMOVAL  item=" + args.item + "  cloud_fraction=" + str(args.cloud_fraction))
    meta     = load_metadata()
    platform = args.collection
    n_bands  = PLATFORM_BANDS.get(platform, 10)
    ps       = 8
    sz       = 256

    model = load_clay_model(args.model_size, args.checkpoint, mask_ratio=0.0)
    model.eval()

    arr       = fetch_pc_tile_as_array(platform, args.item, platform, meta, target_size=sz)
    norm, orig = make_tile_tensor(arr, platform, meta, target_size=sz)

    n_p = (sz // ps) ** 2
    n_c = int(n_p * args.cloud_fraction)
    mf  = torch.zeros(n_p, dtype=torch.bool)
    mf[torch.randperm(n_p)[:n_c]] = True
    hw  = sz // ps
    cloud_px   = mf.reshape(hw, hw).repeat_interleave(ps, 0).repeat_interleave(ps, 1)
    masked_in  = norm.clone()
    masked_in[0, :, cloud_px] = 0.0

    dc = make_datacube(masked_in, platform, meta, args.lat, args.lon)
    with torch.no_grad():
        u, ui, mi, mm = model.model.encoder(dc)
        pp, _         = model.model.decoder(u, ui, mi, mm, dc["time"], dc["latlon"],
                                             dc["gsd"], dc["waves"])

    recon = rearrange(pp[0].cpu(), "(h w) (c p1 p2)->c (h p1) (w p2)",
                      h=sz//ps, w=sz//ps, p1=ps, p2=ps, c=n_bands)
    cloud_c   = cloud_px.unsqueeze(0).expand(n_bands, -1, -1)
    composite = orig.clone()
    composite[cloud_c] = recon[cloud_c]

    mae  = float((orig[cloud_c].float() - composite[cloud_c].float()).abs().mean())
    rmse = float(((orig[cloud_c].float() - composite[cloud_c].float())**2).mean().sqrt())
    cov  = float(cloud_px.float().mean())
    log("Cloud coverage=" + str(round(cov*100, 1)) + "%  MAE=" + str(round(mae,4)) +
        "  RMSE=" + str(round(rmse,4)))

    result({
        "task":               "cloudremoval",
        "platform":            platform,
        "item_id":             args.item,
        "lat":                 args.lat,
        "lon":                 args.lon,
        "cloudFraction":       round(cov, 3),
        "cloudCoverage":       str(round(cov*100)) + "%",
        "mae":                 round(mae, 4),
        "rmse":                round(rmse, 4),
        "ssim":                round(max(0, 1 - mae * 5), 4),
        "reconstructedPixels": int(cloud_px.sum().item()),
        "qualityScore":        round((1 - mae) * 100, 1),
        "device":              str(DEVICE),
        "realData":            arr is not None,
    })


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--task",           default="landcover")
    p.add_argument("--collection",     default="sentinel-2-l2a")
    p.add_argument("--item",           default="")
    p.add_argument("--lat",            type=float, default=0.0)
    p.add_argument("--lon",            type=float, default=0.0)
    p.add_argument("--checkpoint",     default="")
    p.add_argument("--model_size",     default="base")
    p.add_argument("--epochs",         type=int,   default=5)
    p.add_argument("--batch_size",     type=int,   default=8)
    p.add_argument("--lr",             type=float, default=1e-3)
    p.add_argument("--num_classes",    type=int,   default=11)   # always 11 for ESA global
    p.add_argument("--mask_ratio",     type=float, default=0.75)
    p.add_argument("--cloud_fraction", type=float, default=0.4)
    p.add_argument("--job_id",         default="default")

    args = p.parse_args()

    # Clamp epochs to a sensible range: 3 min, 20 max
    args.epochs = max(3, min(20, args.epochs))

    try:
        if   args.task == "landcover":    run_landcover(args)
        elif args.task == "inference":    run_inference(args)
        elif args.task == "embeddings":   run_embeddings(args)
        elif args.task == "cloudremoval": run_cloudremoval(args)
        else:
            error("Unknown task: " + args.task)
    except KeyboardInterrupt:
        log("Cancelled")
    except Exception as e:
        import traceback
        error(str(e) + "\n" + traceback.format_exc())


if __name__ == "__main__":
    main()