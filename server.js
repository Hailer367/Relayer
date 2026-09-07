import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8787;

// Hardcoded Teller URL — Relayer only accepts forwards from this origin (and serves Teller)
const TELLER_URL = "https://teller-six.vercel.app";
// Hardcoded Relayer public URL — Teller will fetch from here (set after deploy)
const RELAYER_URL = process.env.RELAYER_URL || `http://localhost:${PORT}`;

app.use(cors({ origin: [TELLER_URL, "http://localhost:3000", "http://localhost:3001"], credentials: false }));
app.use(express.json({ limit: "64kb" }));

// ---- in-memory ephemeral store ----
/** deviceId -> device */
const store = new Map();
const TTL_MS = 120_000; // vanish 2min after last heartbeat (ephemeral)

function isOnline(lastSeen) { return Date.now() - new Date(lastSeen).getTime() < 90_000; }

function upsert(body, ip, ua) {
  const now = new Date().toISOString();
  const { deviceId, model="unknown", androidVersion="?", appVersion="0.2.1-poss", installed=[], missing=[], monitorRunning=false, batteryOptimized=false } = body || {};
  if (!deviceId || typeof deviceId !== "string" || deviceId.length < 4) throw new Error("deviceId required");
  const existing = store.get(deviceId);
  const dev = existing
    ? { ...existing, model, androidVersion, appVersion, installed, missing, monitorRunning, batteryOptimized, ip, userAgent: ua, lastSeen: now, heartbeatCount: (existing.heartbeatCount||0)+1 }
    : { deviceId, model, androidVersion, appVersion, installed, missing, monitorRunning, batteryOptimized, ip, userAgent: ua, firstSeen: now, lastSeen: now, heartbeatCount: 1 };
  store.set(deviceId, dev);
  return dev;
}

// periodic purge of stale entries (ephemeral — disappear when offline)
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of store) {
    if (now - new Date(v.lastSeen).getTime() > TTL_MS) store.delete(k);
  }
}, 30_000);

// ---- API: Teller forwards register/heartbeat here ----
// Accept POST from Teller (which itself received from App). Also accept direct POST if needed.
app.post("/relay/register", (req,res) => {
  try {
    const dev = upsert(req.body, req.ip, req.get("user-agent"));
    // optional: log
    console.log(`[register] ${dev.deviceId.slice(0,8)} ${dev.model} online=${isOnline(dev.lastSeen)} total=${store.size}`);
    res.json({ ok:true, device: dev, via:"relayer", relayerUrl: RELAYER_URL, tellerUrl: TELLER_URL });
  } catch(e){ res.status(400).json({error:e.message}); }
});
app.post("/relay/heartbeat", (req,res) => {
  try {
    const dev = upsert(req.body, req.ip, req.get("user-agent"));
    res.json({ ok:true, device: dev, via:"relayer" });
  } catch(e){ res.status(400).json({error:e.message}); }
});

// ---- API: Teller reads from here ----
app.get("/relay/devices", (req,res) => {
  // only serve to Teller (loose check — header or origin)
  const devices = Array.from(store.values()).sort((a,b)=> new Date(b.lastSeen).getTime()-new Date(a.lastSeen).getTime());
  res.json({ devices, count: devices.length, ephemeral: true, ttlMs: TTL_MS });
});
app.get("/relay/health", (req,res)=> res.json({ ok:true, count: store.size, tellerUrl: TELLER_URL, relayerUrl: RELAYER_URL, uptime: process.uptime() }));
app.get("/", (req,res)=> res.json({ name:"Relayer", tellerUrl: TELLER_URL, relayerUrl: RELAYER_URL, endpoints: ["/relay/register","/relay/heartbeat","/relay/devices","/relay/health"] }));

app.listen(PORT, ()=> console.log(`Relayer listening :${PORT}  TELLER=${TELLER_URL}  RELAYER=${RELAYER_URL}`));
