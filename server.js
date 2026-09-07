import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8787;

// Hardcoded endpoints — Relayer only serves Teller
const TELLER_URL = "https://teller-six.vercel.app";
const RELAYER_URL = process.env.RELAYER_URL || `http://localhost:${PORT}`;
// Optional shared secret between Teller and Relayer (set same value in both envs)
const RELAYER_SECRET = process.env.RELAYER_SECRET || "";

// Security headers + limits
app.disable("x-powered-by");
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Referrer-Policy","no-referrer");
  next();
});
app.use(cors({ origin: [TELLER_URL, "http://localhost:3000", "http://localhost:3001"], credentials: false }));
app.use(express.json({ limit: "16kb" }));
// simple in-memory rate limit: 120 req / min per IP
const hits = new Map();
setInterval(()=> hits.clear(), 60_000);
app.use((req,res,next)=>{
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const n = (hits.get(ip)||0)+1; hits.set(ip,n);
  if (n > 120) return res.status(429).json({error:"rate limited"});
  next();
});

// ---- in-memory ephemeral store ----
const store = new Map();
const TTL_MS = 120_000;
const MAX_DEVICES = 5000;
const MAX_DEVICEID_LEN = 128;
const MAX_ARR = 20;
const MAX_STR = 64;

// purge stale every 30s
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of store) {
    if (now - new Date(v.lastSeen).getTime() > TTL_MS) store.delete(k);
  }
}, 30_000);

function isOnline(lastSeen){ return Date.now() - new Date(lastSeen).getTime() < 90_000; }

function sanitizeStr(s, fallback="unknown", max=MAX_STR){
  if (typeof s !== "string") return fallback;
  s = s.trim().slice(0, max).replace(/[\x00-\x1f]/g,"");
  return s || fallback;
}
function sanitizeArr(a){
  if (!Array.isArray(a)) throw new Error("installed/missing must be arrays");
  if (a.length > MAX_ARR) throw new Error(`array too large (max ${MAX_ARR})`);
  return a.map(v=> {
    if (typeof v !== "string") throw new Error("array items must be strings");
    const s=v.trim().slice(0,80).replace(/[\x00-\x1f]/g,"");
    if (!s) throw new Error("empty array item");
    return s;
  });
}

function validateDeviceId(id){
  if (typeof id !== "string") throw new Error("deviceId must be string");
  if (id.length < 4 || id.length > MAX_DEVICEID_LEN) throw new Error(`deviceId length 4-${MAX_DEVICEID_LEN}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("deviceId invalid chars (a-z 0-9 . _ -)");
}

function checkSecret(req){
  if (!RELAYER_SECRET) return; // open if not set (dev)
  const got = req.get("x-relayer-secret") || req.get("authorization")?.replace(/^Bearer\s+/,"");
  if (got !== RELAYER_SECRET) {
    const e=new Error("unauthorized (bad relayer secret)");
    e.status=401; throw e;
  }
}

function upsert(body, ip, ua){
  const now = new Date().toISOString();
  let { deviceId, model, androidVersion, appVersion, installed, missing, monitorRunning, batteryOptimized } = body || {};
  validateDeviceId(deviceId);
  if (installed !== undefined) installed = sanitizeArr(installed);
  else installed = [];
  if (missing !== undefined) missing = sanitizeArr(missing);
  else missing = [];
  model = sanitizeStr(model, "unknown", 48);
  androidVersion = sanitizeStr(androidVersion, "?", 32);
  appVersion = sanitizeStr(appVersion, "0.2.1-poss", 32);
  monitorRunning = !!monitorRunning;
  batteryOptimized = !!batteryOptimized;

  if (!store.has(deviceId) && store.size >= MAX_DEVICES) throw new Error("store full");

  const existing = store.get(deviceId);
  const dev = existing
    ? { ...existing, model, androidVersion, appVersion, installed, missing, monitorRunning, batteryOptimized, ip, userAgent: ua?.slice(0,128), lastSeen: now, heartbeatCount: (existing.heartbeatCount||0)+1 }
    : { deviceId, model, androidVersion, appVersion, installed, missing, monitorRunning, batteryOptimized, ip, userAgent: ua?.slice(0,128), firstSeen: now, lastSeen: now, heartbeatCount: 1 };
  store.set(deviceId, dev);
  return dev;
}

// errors
app.use((err,req,res,next)=>{
  if (err.type==="entity.too.large") return res.status(413).json({error:"payload too large"});
  if (err instanceof SyntaxError) return res.status(400).json({error:"invalid json"});
  next(err);
});

// ---- API ----
app.post("/relay/register", (req,res) => {
  try{
    checkSecret(req);
    const dev = upsert(req.body, req.ip, req.get("user-agent"));
    console.log(`[register] ${dev.deviceId.slice(0,12)} ${dev.model} total=${store.size}`);
    res.json({ ok:true, device: dev, via:"relayer", relayerUrl: RELAYER_URL, tellerUrl: TELLER_URL });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
app.post("/relay/heartbeat", (req,res) => {
  try{
    checkSecret(req);
    const dev = upsert(req.body, req.ip, req.get("user-agent"));
    res.json({ ok:true, device: dev, via:"relayer" });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
app.get("/relay/devices", (req,res) => {
  try{
    checkSecret(req);
    const devices = Array.from(store.values()).sort((a,b)=> new Date(b.lastSeen).getTime()-new Date(a.lastSeen).getTime());
    res.json({ devices, count: devices.length, ephemeral: true, ttlMs: TTL_MS });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
app.get("/relay/health", (req,res)=> res.json({ ok:true, count: store.size, tellerUrl: TELLER_URL, relayerUrl: RELAYER_URL, uptime: process.uptime(), maxDevices: MAX_DEVICES, ttlMs: TTL_MS }));
app.get("/", (req,res)=> res.json({ name:"Relayer", tellerUrl: TELLER_URL, relayerUrl: RELAYER_URL, endpoints: ["/relay/register","/relay/heartbeat","/relay/devices","/relay/health"] }));
app.use((req,res)=> res.status(404).json({error:"not found"}));

app.listen(PORT, ()=> console.log(`Relayer fortified :${PORT}  TELLER=${TELLER_URL}  RELAYER=${RELAYER_URL}  secret=${RELAYER_SECRET?"set":"none"}`));
