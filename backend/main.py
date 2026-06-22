import cv2
import base64
import tempfile
import os
import queue
import threading
import time
import yt_dlp
import json
import numpy as np
import easyocr
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from ultralytics import YOLO

app = FastAPI(title="Smart Traffic Control API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Models (loaded once) ────────────────────────────────────────────────────
model  = YOLO("yolov8n.pt")
model.fuse()
reader = easyocr.Reader(["en"], gpu=False, verbose=False)

# ── Constants ───────────────────────────────────────────────────────────────
JUNCTION_IDS   = ["A", "B", "C", "D"]
VEHICLE_CLASSES = {2: "Car", 3: "Motorcycle", 5: "Bus", 7: "Truck"}
CLASS_COLORS = {
    "Car":        (59,  130, 246),
    "Motorcycle": (6,   182, 212),
    "Bus":        (34,  197, 94),
    "Truck":      (249, 115, 22),
    "Ambulance":  (239, 68,  68),
}
INFER_SIZE = 416
OUTPUT_W   = 854
JPEG_Q     = 65
TARGET_FPS = 10

# Signal timing bounds (seconds)
MIN_GREEN = 10
MAX_GREEN = 60
BASE_GREEN = 20
YELLOW_TIME = 3

# Vehicle weights for density scoring
VEHICLE_WEIGHTS = {"Car": 1, "Motorcycle": 0.5, "Bus": 2.5, "Truck": 2, "Ambulance": 10}

# ── Global Junction State ────────────────────────────────────────────────────
# Keyed by junction id ("A", "B", "C", "D")
junction_state = {
    jid: {
        "counts":      {"Car": 0, "Motorcycle": 0, "Bus": 0, "Truck": 0, "Ambulance": 0},
        "status":      "IDLE",         # IDLE | DETECTING
        "frame":       None,           # latest base64 JPEG or None
        "frame_num":   0,
        "has_ambulance": False,
    }
    for jid in JUNCTION_IDS
}

# ── Global Signal Controller State ───────────────────────────────────────────
signal_state = {
    "green_junction":    "A",          # which junction is currently GREEN
    "phase":             "green",       # green | yellow
    "countdown":         BASE_GREEN,    # seconds remaining in current phase
    "optimized_times":   {jid: BASE_GREEN for jid in JUNCTION_IDS},   # computed green durations
    "emergency_override": None,         # jid of emergency-active junction or None
    "lights": {jid: "red" for jid in JUNCTION_IDS},   # red | yellow | green
}
signal_state["lights"]["A"] = "green"

state_lock = threading.Lock()

# ── Ambulance detection helpers ─────────────────────────────────────────────

def _has_ambulance_colors(crop: np.ndarray) -> bool:
    """Check for white body + red/blue emergency markings."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    h, w = crop.shape[:2]
    total = h * w
    white = cv2.inRange(hsv, (0, 0, 180), (180, 40, 255))
    white_ratio = cv2.countNonZero(white) / total
    red1 = cv2.inRange(hsv, (0,   120, 70), (10,  255, 255))
    red2 = cv2.inRange(hsv, (160, 120, 70), (180, 255, 255))
    red  = cv2.bitwise_or(red1, red2)
    red_ratio = cv2.countNonZero(red) / total
    blue = cv2.inRange(hsv, (100, 100, 70), (130, 255, 255))
    blue_ratio = cv2.countNonZero(blue) / total
    return white_ratio > 0.35 and (red_ratio > 0.04 or blue_ratio > 0.04)


def _has_ambulance_text(crop: np.ndarray) -> bool:
    """OCR the crop for 'AMBULANCE' or 'AMB' text."""
    h, w = crop.shape[:2]
    if w < 120:
        crop = cv2.resize(crop, (120, int(h * 120 / w)))
    results = reader.readtext(crop, detail=0, paragraph=False)
    joined = " ".join(results).upper()
    return "AMBULANCE" in joined or "AMBUL" in joined or "AMB" in joined


def is_ambulance(crop: np.ndarray) -> bool:
    """Two-stage: color check (fast) → OCR (only if color passes)."""
    if crop.size == 0:
        return False
    if not _has_ambulance_colors(crop):
        return False
    return _has_ambulance_text(crop)


# ── Frame annotation ─────────────────────────────────────────────────────────

def annotate(frame: np.ndarray):
    h, w = frame.shape[:2]
    scale   = INFER_SIZE / max(h, w)
    small   = cv2.resize(frame, (int(w * scale), int(h * scale)))
    results = model(small, verbose=False, imgsz=INFER_SIZE, conf=0.35)[0]

    counts = {v: 0 for v in VEHICLE_CLASSES.values()}
    counts["Ambulance"] = 0

    for box in results.boxes:
        cls_id = int(box.cls[0])
        if cls_id not in VEHICLE_CLASSES:
            continue
        conf = float(box.conf[0])
        x1, y1, x2, y2 = (int(v / scale) for v in box.xyxy[0])
        x1, y1 = max(x1, 0), max(y1, 0)
        x2, y2 = min(x2, w), min(y2, h)

        label = VEHICLE_CLASSES[cls_id]
        if cls_id in (2, 7):
            crop = frame[y1:y2, x1:x2]
            if is_ambulance(crop):
                label = "Ambulance"

        color = CLASS_COLORS[label]
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, f"{label} {conf:.2f}", (x1, max(y1 - 6, 14)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA)
        counts[label] += 1

    if w > OUTPUT_W:
        frame = cv2.resize(frame, (OUTPUT_W, int(h * OUTPUT_W / w)))
    return frame, counts


# ── Adaptive Signal Timing Algorithm ─────────────────────────────────────────

def compute_density_score(jid: str) -> float:
    """Weighted vehicle count for a junction."""
    counts = junction_state[jid]["counts"]
    return sum(VEHICLE_WEIGHTS.get(v, 1) * c for v, c in counts.items())


def compute_optimized_times() -> dict:
    """
    Proportionally allocate green time across all junctions based on density.
    Each junction gets between MIN_GREEN and MAX_GREEN seconds.
    """
    scores = {jid: compute_density_score(jid) for jid in JUNCTION_IDS}
    total  = sum(scores.values())
    times  = {}
    for jid in JUNCTION_IDS:
        if total == 0:
            times[jid] = BASE_GREEN
        else:
            ratio = scores[jid] / total
            # Scale between MIN_GREEN and MAX_GREEN proportionally
            t = MIN_GREEN + ratio * (MAX_GREEN - MIN_GREEN) * len(JUNCTION_IDS)
            times[jid] = round(min(MAX_GREEN, max(MIN_GREEN, t)))
    return times


def emergency_junction() -> str | None:
    """Return the first junction with an active ambulance, or None."""
    for jid in JUNCTION_IDS:
        if junction_state[jid]["has_ambulance"]:
            return jid
    return None


# ── Signal Coordinator Background Thread ─────────────────────────────────────

def signal_coordinator():
    """
    Runs forever in a background thread.
    Manages the traffic light cycle across all 4 junctions.
    """
    idx = 0  # index into JUNCTION_IDS for round-robin

    while True:
        # ---- Compute next green junction ----
        with state_lock:
            emg = emergency_junction()
            opt_times = compute_optimized_times()
            signal_state["optimized_times"] = opt_times

            if emg:
                green_jid = emg
                signal_state["emergency_override"] = emg
                green_duration = MAX_GREEN  # give emergency junction max time
            else:
                signal_state["emergency_override"] = None
                green_jid = JUNCTION_IDS[idx % len(JUNCTION_IDS)]
                green_duration = opt_times[green_jid]

            # Set all lights to red, then green the selected junction
            for jid in JUNCTION_IDS:
                signal_state["lights"][jid] = "red"
            signal_state["lights"][green_jid] = "green"
            signal_state["green_junction"] = green_jid
            signal_state["phase"] = "green"
            signal_state["countdown"] = green_duration

        # ---- Green phase countdown ----
        for remaining in range(green_duration, 0, -1):
            with state_lock:
                signal_state["countdown"] = remaining
                # Re-check for emergency mid-phase
                emg_now = emergency_junction()
                if emg_now and emg_now != green_jid:
                    # Emergency at a different junction — cut phase short
                    break
            time.sleep(1)

        # ---- Yellow phase ----
        with state_lock:
            signal_state["lights"][green_jid] = "yellow"
            signal_state["phase"] = "yellow"
            signal_state["countdown"] = YELLOW_TIME

        for remaining in range(YELLOW_TIME, 0, -1):
            with state_lock:
                signal_state["countdown"] = remaining
            time.sleep(1)

        # ---- Advance to next junction (unless emergency took over) ----
        with state_lock:
            if not signal_state["emergency_override"]:
                idx += 1


# Start coordinator thread on startup
coordinator_thread = threading.Thread(target=signal_coordinator, daemon=True)
coordinator_thread.start()


# ── Producer thread ──────────────────────────────────────────────────────────

def producer(video_path: str, junction_id: str, q: queue.Queue, stop_event: threading.Event):
    cap      = cv2.VideoCapture(video_path)
    fps      = cap.get(cv2.CAP_PROP_FPS) or 25
    interval = max(1, int(fps / TARGET_FPS))
    idx      = 0
    try:
        while cap.isOpened() and not stop_event.is_set():
            ret, frame = cap.read()
            if not ret:
                break
            if idx % interval == 0:
                annotated, counts = annotate(frame)
                _, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
                b64 = base64.b64encode(buf).decode()

                # Update global junction state
                with state_lock:
                    junction_state[junction_id]["counts"]        = counts
                    junction_state[junction_id]["frame"]         = b64
                    junction_state[junction_id]["has_ambulance"] = counts.get("Ambulance", 0) > 0
                    junction_state[junction_id]["frame_num"]    += 1

                q.put({"frame": b64, "counts": counts, "junction_id": junction_id})
            idx += 1
    except Exception as e:
        q.put({"error": str(e)})
    finally:
        cap.release()
        with state_lock:
            junction_state[junction_id]["status"]      = "IDLE"
            junction_state[junction_id]["has_ambulance"] = False
        q.put(None)


def sse_generator(video_path: str, junction_id: str, cleanup: bool = False):
    q    = queue.Queue(maxsize=4)
    stop = threading.Event()

    with state_lock:
        junction_state[junction_id]["status"]    = "DETECTING"
        junction_state[junction_id]["frame_num"] = 0

    t = threading.Thread(target=producer, args=(video_path, junction_id, q, stop), daemon=True)
    t.start()
    try:
        while True:
            item = q.get(timeout=60)
            if item is None:
                yield 'data: {"done":true}\n\n'
                break
            yield f"data: {json.dumps(item)}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
    finally:
        stop.set()
        if cleanup and os.path.exists(video_path):
            os.unlink(video_path)


# ── YouTube helper ───────────────────────────────────────────────────────────

def get_yt_url(url: str) -> str:
    opts = {"format": "best[ext=mp4][height<=720]/best[height<=720]/best",
            "quiet": True, "no_warnings": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if "url" in info:
            return info["url"]
        for fmt in reversed(info.get("formats", [])):
            if fmt.get("url") and fmt.get("vcodec", "none") != "none":
                return fmt["url"]
    raise ValueError("Cannot extract a playable URL.")


SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# ── API Endpoints ─────────────────────────────────────────────────────────────

@app.post("/predict/upload/{junction_id}")
async def predict_upload(junction_id: str, file: UploadFile = File(...)):
    if junction_id not in JUNCTION_IDS:
        return JSONResponse({"error": f"Invalid junction id. Use one of {JUNCTION_IDS}"}, status_code=400)
    suffix = os.path.splitext(file.filename)[1] or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(await file.read())
    tmp.close()
    return StreamingResponse(
        sse_generator(tmp.name, junction_id, cleanup=True),
        media_type="text/event-stream", headers=SSE_HEADERS
    )


@app.post("/predict/youtube/{junction_id}")
async def predict_youtube(junction_id: str, url: str = Form(...)):
    if junction_id not in JUNCTION_IDS:
        return JSONResponse({"error": f"Invalid junction id. Use one of {JUNCTION_IDS}"}, status_code=400)
    def generate():
        try:
            yield from sse_generator(get_yt_url(url), junction_id)
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.get("/api/state")
async def get_state():
    """Return global junction states + signal controller snapshot."""
    with state_lock:
        # Build a safe copy without large frame data (frames are streamed via SSE)
        junctions = {}
        for jid in JUNCTION_IDS:
            s = junction_state[jid]
            junctions[jid] = {
                "counts":        s["counts"],
                "status":        s["status"],
                "has_ambulance": s["has_ambulance"],
                "frame_num":     s["frame_num"],
                "total_vehicles": sum(s["counts"].values()),
            }
        signals = {
            "green_junction":      signal_state["green_junction"],
            "phase":               signal_state["phase"],
            "countdown":           signal_state["countdown"],
            "optimized_times":     signal_state["optimized_times"],
            "emergency_override":  signal_state["emergency_override"],
            "lights":              dict(signal_state["lights"]),
        }
    return {"junctions": junctions, "signals": signals}


@app.post("/api/reset")
async def reset_state():
    """Reset all junction states and signal controller."""
    with state_lock:
        for jid in JUNCTION_IDS:
            junction_state[jid]["counts"]        = {"Car": 0, "Motorcycle": 0, "Bus": 0, "Truck": 0, "Ambulance": 0}
            junction_state[jid]["status"]        = "IDLE"
            junction_state[jid]["frame"]         = None
            junction_state[jid]["frame_num"]     = 0
            junction_state[jid]["has_ambulance"] = False
        signal_state["emergency_override"] = None
        signal_state["optimized_times"]    = {jid: BASE_GREEN for jid in JUNCTION_IDS}
    return {"status": "reset"}
