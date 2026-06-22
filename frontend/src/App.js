import { useState, useRef, useCallback, useEffect } from "react";
import "./App.css";

const API = "http://localhost:8000";
const DEFAULT_COUNTS = { Car: 0, Motorcycle: 0, Bus: 0, Truck: 0, Ambulance: 0 };
const CLASS_COLORS = {
  Car: "#3b82f6",
  Motorcycle: "#06b6d4",
  Bus: "#22c55e",
  Truck: "#f97316",
  Ambulance: "#ef4444",
};
const JUNCTION_LABELS = {
  A: { name: "Junction A", laptop: "Laptop 1", color: "#6366f1" },
  B: { name: "Junction B", laptop: "Laptop 2", color: "#22c55e" },
  C: { name: "Junction C", laptop: "Laptop 3", color: "#f59e0b" },
  D: { name: "Junction D", laptop: "Laptop 4", color: "#ef4444" },
};
const JUNCTION_IDS = ["A", "B", "C", "D"];

// ── Traffic Light Component ───────────────────────────────────────────────────
function TrafficLight({ color, size = "md", countdown, phase }) {
  const s = size === "sm" ? 10 : size === "lg" ? 22 : 14;
  return (
    <div className={`traffic-light traffic-light--${size}`}>
      <div
        className={`tl-bulb ${color === "red" ? "tl-active-red" : ""}`}
        style={{ width: s, height: s }}
      />
      <div
        className={`tl-bulb ${color === "yellow" ? "tl-active-yellow" : ""}`}
        style={{ width: s, height: s }}
      />
      <div
        className={`tl-bulb ${color === "green" ? "tl-active-green" : ""}`}
        style={{ width: s, height: s }}
      />
      {countdown != null && (
        <div className="tl-countdown">{countdown}s</div>
      )}
    </div>
  );
}

// ── Junction Badge ────────────────────────────────────────────────────────────
function JunctionBadge({ jid, status, selected, onClick, signals }) {
  const meta = JUNCTION_LABELS[jid];
  const light = signals?.lights?.[jid] || "red";
  return (
    <button
      className={`junction-badge ${selected ? "junction-badge--active" : ""}`}
      style={{ "--jcolor": meta.color }}
      onClick={onClick}
    >
      <div className="jb-avatar" style={{ background: meta.color }}>
        {jid}
      </div>
      <div className="jb-info">
        <div className="jb-name">{meta.name}</div>
        <div className="jb-laptop">{meta.laptop}</div>
      </div>
      <div className="jb-right">
        <TrafficLight color={light} size="sm" />
        <span className={`status-badge status-badge--${status.toLowerCase()}`}>
          {status}
        </span>
      </div>
    </button>
  );
}

// ── Signal Card (All Signals view) ───────────────────────────────────────────
function SignalCard({ jid, jState, signals, liveFrames }) {
  const meta = JUNCTION_LABELS[jid];
  const light = signals?.lights?.[jid] || "red";
  const isGreen = light === "green";
  const isEmergency = signals?.emergency_override === jid;
  const optTime = signals?.optimized_times?.[jid] ?? "—";
  const frame = liveFrames[jid];

  return (
    <div className={`signal-card ${isEmergency ? "signal-card--emergency" : ""}`}>
      <div className="sc-header">
        <div className="sc-avatar" style={{ background: meta.color }}>{jid}</div>
        <div className="sc-title">
          <div className="sc-name">{meta.name}</div>
          <div className="sc-laptop">{meta.laptop}</div>
        </div>
        <TrafficLight
          color={light}
          size="lg"
          countdown={isGreen ? signals?.countdown : null}
        />
      </div>

      <div className="sc-frame">
        {frame ? (
          <img src={`data:image/jpeg;base64,${frame}`} alt={`Junction ${jid}`} />
        ) : (
          <div className="sc-placeholder">
            <span>🎥</span>
            <p>{jState?.status === "DETECTING" ? "Initializing…" : "No Feed"}</p>
          </div>
        )}
        {isEmergency && (
          <div className="sc-emergency-badge">🚨 AMBULANCE PRIORITY</div>
        )}
      </div>

      <div className="sc-stats">
        <div className="sc-stat">
          <span className="sc-stat-label">Total</span>
          <span className="sc-stat-value">{jState?.total_vehicles ?? 0}</span>
        </div>
        <div className="sc-stat">
          <span className="sc-stat-label">Cars</span>
          <span className="sc-stat-value">{jState?.counts?.Car ?? 0}</span>
        </div>
        <div className="sc-stat">
          <span className="sc-stat-label">Buses</span>
          <span className="sc-stat-value">{jState?.counts?.Bus ?? 0}</span>
        </div>
        <div className="sc-stat">
          <span className="sc-stat-label">Trucks</span>
          <span className="sc-stat-value">{jState?.counts?.Truck ?? 0}</span>
        </div>
      </div>

      <div className="sc-timing">
        <div className="sc-timing-row">
          <span>Signal</span>
          <span className={`sc-light-label sc-light-label--${light}`}>{light.toUpperCase()}</span>
        </div>
        <div className="sc-timing-row">
          <span>Optimized Green</span>
          <span>{optTime}s</span>
        </div>
        {isGreen && (
          <div className="sc-timing-row">
            <span>Countdown</span>
            <span className="sc-countdown">{signals?.countdown}s</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [dashTab, setDashTab]     = useState("live");       // "live" | "all"
  const [inputTab, setInputTab]   = useState("upload");     // "upload" | "youtube"
  const [activeJunction, setActiveJunction] = useState("A");
  const [file, setFile]           = useState(null);
  const [ytUrl, setYtUrl]         = useState("");
  const [dragging, setDragging]   = useState(false);
  const [error, setError]         = useState(null);

  // Per-junction live state
  const [junctionData, setJunctionData] = useState(
    Object.fromEntries(JUNCTION_IDS.map((jid) => [jid, { counts: { ...DEFAULT_COUNTS }, running: false, frameNum: 0, hasFrame: false }]))
  );

  // Global signal state from backend polling
  const [signals, setSignals]     = useState(null);
  const [apiJunctions, setApiJunctions] = useState(null);

  // Live frames keyed by junction id (only for "All Signals" overlay)
  const [liveFrames, setLiveFrames] = useState({});

  // Refs per junction for SSE and rAF
  const readerRefs   = useRef({});
  const imgRefs      = useRef({});
  const pendingFrames = useRef({});
  const rafIds        = useRef({});
  const fileInputRef  = useRef(null);

  // ── Poll /api/state every second ──────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`${API}/api/state`);
        const data = await res.json();
        setSignals(data.signals);
        setApiJunctions(data.junctions);
      } catch (_) {}
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // ── rAF loop per junction ──────────────────────────────────────────────────
  const startRaf = useCallback((jid) => {
    const loop = () => {
      const pf = pendingFrames.current[jid];
      const imgEl = imgRefs.current[jid];
      if (pf && imgEl) {
        imgEl.src = pf;
        // Also update liveFrames for All Signals card
        setLiveFrames((prev) => ({ ...prev, [jid]: pf.replace("data:image/jpeg;base64,", "") }));
        pendingFrames.current[jid] = null;
        setJunctionData((prev) => ({ ...prev, [jid]: { ...prev[jid], hasFrame: true } }));
      }
      rafIds.current[jid] = requestAnimationFrame(loop);
    };
    rafIds.current[jid] = requestAnimationFrame(loop);
  }, []);

  const stopRaf = useCallback((jid) => {
    if (rafIds.current[jid]) cancelAnimationFrame(rafIds.current[jid]);
  }, []);

  const stopJunction = useCallback((jid) => {
    readerRefs.current[jid]?.cancel();
    stopRaf(jid);
    setJunctionData((prev) => ({ ...prev, [jid]: { ...prev[jid], running: false } }));
  }, [stopRaf]);

  const startStream = useCallback(async (response, jid) => {
    setJunctionData((prev) => ({
      ...prev,
      [jid]: { counts: { ...DEFAULT_COUNTS }, running: true, frameNum: 0, hasFrame: false },
    }));
    setError(null);
    pendingFrames.current[jid] = null;
    startRaf(jid);

    try {
      const reader = response.body.getReader();
      readerRefs.current[jid] = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let frameCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(part.slice(6));
            if (data.error) { setError(data.error); break; }
            if (data.done)  { break; }
            pendingFrames.current[jid] = `data:image/jpeg;base64,${data.frame}`;
            frameCount++;
            setJunctionData((prev) => ({
              ...prev,
              [jid]: {
                ...prev[jid],
                counts:   data.counts,
                frameNum: frameCount,
              },
            }));
          } catch (_) {}
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      stopRaf(jid);
      setJunctionData((prev) => ({ ...prev, [jid]: { ...prev[jid], running: false } }));
    }
  }, [startRaf, stopRaf]);

  const handleUpload = async () => {
    if (!file) return;
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API}/predict/upload/${activeJunction}`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      startStream(res, activeJunction);
    } catch (e) { setError(e.message); }
  };

  const handleYoutube = async () => {
    if (!ytUrl) return;
    setError(null);
    try {
      const form = new FormData();
      form.append("url", ytUrl);
      const res = await fetch(`${API}/predict/youtube/${activeJunction}`, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error ${res.status}`);
      }
      startStream(res, activeJunction);
    } catch (e) { setError(e.message); }
  };

  const handleReset = async () => {
    JUNCTION_IDS.forEach((jid) => stopJunction(jid));
    setLiveFrames({});
    try { await fetch(`${API}/api/reset`, { method: "POST" }); } catch (_) {}
    setJunctionData(
      Object.fromEntries(JUNCTION_IDS.map((jid) => [jid, { counts: { ...DEFAULT_COUNTS }, running: false, frameNum: 0, hasFrame: false }]))
    );
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  };

  const jd     = junctionData[activeJunction];
  const total  = Object.values(jd.counts).reduce((a, b) => a + b, 0);
  const anyEmergency = signals?.emergency_override != null;
  const currentLight = signals?.lights?.[activeJunction] || "red";
  const jStatus = apiJunctions?.[activeJunction]?.status || "IDLE";

  return (
    <div className="app">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="header">
        <div className="header-brand">
          <div className="header-icon">🚦</div>
          <div>
            <div className="header-title">Smart Traffic Control System</div>
            <div className="header-sub">AI-powered signal optimization · 4 junctions</div>
          </div>
        </div>
        <nav className="header-nav">
          <button
            className={`nav-btn ${dashTab === "live" ? "nav-btn--active" : ""}`}
            onClick={() => setDashTab("live")}
          >
            📡 Live Detection
          </button>
          <button
            className={`nav-btn ${dashTab === "all" ? "nav-btn--active" : ""}`}
            onClick={() => setDashTab("all")}
          >
            🚦 All Signals
          </button>
          <button className="nav-btn nav-btn--reset" onClick={handleReset}>
            ↺ Reset
          </button>
        </nav>
      </header>

      {/* ── Emergency Banner ───────────────────────────────── */}
      {anyEmergency && (
        <div className="emergency-banner">
          🚨 EMERGENCY OVERRIDE — Ambulance detected at Junction {signals.emergency_override}. Signal priority activated.
        </div>
      )}

      {/* ── All Signals View ──────────────────────────────── */}
      {dashTab === "all" && (
        <main className="all-signals-grid">
          {JUNCTION_IDS.map((jid) => (
            <SignalCard
              key={jid}
              jid={jid}
              jState={apiJunctions?.[jid]}
              signals={signals}
              liveFrames={liveFrames}
            />
          ))}
          {/* ── Coordinator Summary ── */}
          <div className="coordinator-card">
            <h3>🧠 Signal Coordinator</h3>
            <div className="coord-row">
              <span>Active Green</span>
              <span className="coord-val">Junction {signals?.green_junction ?? "—"}</span>
            </div>
            <div className="coord-row">
              <span>Phase</span>
              <span className={`coord-phase coord-phase--${signals?.phase}`}>
                {signals?.phase?.toUpperCase() ?? "—"}
              </span>
            </div>
            <div className="coord-row">
              <span>Countdown</span>
              <span className="coord-val">{signals?.countdown ?? "—"}s</span>
            </div>
            {signals?.emergency_override && (
              <div className="coord-row coord-row--emergency">
                <span>🚨 Emergency</span>
                <span>Junction {signals.emergency_override}</span>
              </div>
            )}
            <div className="coord-divider" />
            <div className="coord-subtitle">Optimized Green Times</div>
            {JUNCTION_IDS.map((jid) => (
              <div className="coord-row" key={jid}>
                <span>Junction {jid}</span>
                <div className="coord-bar-wrap">
                  <div
                    className="coord-bar"
                    style={{
                      width: `${Math.round(((signals?.optimized_times?.[jid] ?? 20) / 60) * 100)}%`,
                      background: JUNCTION_LABELS[jid].color,
                    }}
                  />
                  <span className="coord-bar-label">{signals?.optimized_times?.[jid] ?? "—"}s</span>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      {/* ── Live Detection View ───────────────────────────── */}
      {dashTab === "live" && (
        <main className="live-layout">
          {/* Sidebar */}
          <aside className="sidebar">
            <div className="sidebar-title">JUNCTIONS</div>
            {JUNCTION_IDS.map((jid) => (
              <JunctionBadge
                key={jid}
                jid={jid}
                status={apiJunctions?.[jid]?.status || "IDLE"}
                selected={activeJunction === jid}
                onClick={() => setActiveJunction(jid)}
                signals={signals}
              />
            ))}
          </aside>

          {/* Main Panel */}
          <section className="live-main">
            {/* Junction Header */}
            <div className="junction-header">
              <div
                className="jh-avatar"
                style={{ background: JUNCTION_LABELS[activeJunction].color }}
              >
                {activeJunction}
              </div>
              <div>
                <div className="jh-title">Junction {activeJunction}</div>
                <div className="jh-sub">{JUNCTION_LABELS[activeJunction].laptop}</div>
              </div>
              <div className="jh-controls">
                <div className="tabs">
                  <button className={inputTab === "upload" ? "active" : ""} onClick={() => setInputTab("upload")}>
                    📁 Upload Video
                  </button>
                  <button className={inputTab === "youtube" ? "active" : ""} onClick={() => setInputTab("youtube")}>
                    ▶️ YouTube
                  </button>
                </div>
              </div>
            </div>

            {/* Input Area */}
            <div className="input-area">
              {inputTab === "upload" ? (
                <>
                  <div
                    className={`drop-zone ${dragging ? "dragging" : ""}`}
                    onClick={() => fileInputRef.current.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                  >
                    <input ref={fileInputRef} type="file" accept="video/*" onChange={(e) => setFile(e.target.files[0])} />
                    <div className="icon">🎬</div>
                    <div>Drop a video file here or click to browse</div>
                    <div style={{ fontSize: "0.8rem", marginTop: 6, color: "#666" }}>MP4, AVI, MOV, MKV</div>
                  </div>
                  {file && (
                    <div className="selected-file">
                      <span>📄 {file.name}</span>
                      <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                    </div>
                  )}
                  <div className="controls">
                    <button className="btn" onClick={handleUpload} disabled={!file || jd.running}>
                      {jd.running ? "Processing…" : "▶ Start Detection"}
                    </button>
                    {jd.running && (
                      <button className="btn btn-stop" onClick={() => stopJunction(activeJunction)}>
                        ⏹ Stop
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="yt-input">
                  <input
                    type="text"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={ytUrl}
                    onChange={(e) => setYtUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleYoutube()}
                  />
                  <button className="btn" onClick={handleYoutube} disabled={!ytUrl || jd.running}>
                    {jd.running ? "Processing…" : "▶ Detect"}
                  </button>
                  {jd.running && (
                    <button className="btn btn-stop" onClick={() => stopJunction(activeJunction)}>
                      ⏹ Stop
                    </button>
                  )}
                </div>
              )}
              {error && <div className="error-msg">❌ {error}</div>}
            </div>

            {/* Results */}
            <div className="results">
              {/* Video Panel */}
              <div className="video-panel">
                <img
                  ref={(el) => (imgRefs.current[activeJunction] = el)}
                  alt="detection"
                  style={{ width: "100%", display: jd.hasFrame ? "block" : "none" }}
                />
                {!jd.hasFrame && (
                  <div className="placeholder">
                    <div className="big-icon">🎥</div>
                    <div>{jd.running ? "Initializing detection…" : "Annotated frames will appear here"}</div>
                  </div>
                )}
                {jd.running && jd.hasFrame  && <div className="status-bar"><div className="dot" /> Frame {jd.frameNum}</div>}
                {jd.running && !jd.hasFrame && <div className="status-bar"><div className="dot" /> Loading video…</div>}
                {!jd.running && jd.frameNum > 0 && <div className="status-bar">✅ Done — {jd.frameNum} frames processed</div>}
              </div>

              {/* Stats Panel */}
              <div className="stats-panel">
                {/* Traffic Light */}
                <div className="signal-status-card">
                  <div className="ssc-title">Signal Status</div>
                  <div className="ssc-body">
                    <TrafficLight
                      color={currentLight}
                      size="lg"
                      countdown={currentLight === "green" ? signals?.countdown : null}
                    />
                    <div className="ssc-info">
                      <div className={`ssc-light-label ssc-light-label--${currentLight}`}>
                        {currentLight.toUpperCase()}
                      </div>
                      {signals?.optimized_times?.[activeJunction] && (
                        <div className="ssc-opt">
                          Optimized: {signals.optimized_times[activeJunction]}s
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Total */}
                <div className="total-card">
                  <div className="total-num">{total}</div>
                  <div className="total-label">Total Vehicles Detected</div>
                </div>

                {/* By Type */}
                <div className="count-card">
                  <h3>BY TYPE</h3>
                  {Object.entries(jd.counts).map(([label, count]) => (
                    <div className="count-item" key={label}>
                      <div className="count-label">
                        <div className="color-dot" style={{ background: CLASS_COLORS[label] }} />
                        {label}
                      </div>
                      <div className="count-value">{count}</div>
                    </div>
                  ))}
                </div>

                {/* Signal Timing */}
                <div className="timing-card">
                  <h3>SIGNAL TIMING</h3>
                  {signals ? (
                    JUNCTION_IDS.map((jid) => (
                      <div className="timing-row" key={jid}>
                        <div className="timing-label">
                          <div
                            className="timing-dot"
                            style={{ background: JUNCTION_LABELS[jid].color }}
                          />
                          Jnc {jid}
                        </div>
                        <div className="timing-bar-wrap">
                          <div
                            className="timing-bar"
                            style={{
                              width: `${Math.round(((signals.optimized_times?.[jid] ?? 20) / 60) * 100)}%`,
                              background: JUNCTION_LABELS[jid].color,
                            }}
                          />
                        </div>
                        <div className="timing-value">{signals.optimized_times?.[jid] ?? "—"}s</div>
                      </div>
                    ))
                  ) : (
                    <div className="timing-placeholder">Process videos to see optimized timings</div>
                  )}
                </div>
              </div>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}
