# Relayer — ephemeral temp DB for Teller

Flow: `App (Uncry) -> https://teller-six.vercel.app/api/devices/* -> Relayer (/relay/*) -> store in-memory (TTL 120s) -> Teller GET /relay/devices`

- Hardcoded TELLER_URL = https://teller-six.vercel.app (only this origin is allowed + served)
- Hardcoded RELAYER_URL = env RELAYER_URL (set to deployed URL, e.g. https://relayer.onrender.com or your VPS)
- No persistence — devices appear when online, vanish ~2min after last heartbeat.

Endpoints:
- POST /relay/register {deviceId, model, androidVersion, appVersion, installed[], missing[], monitorRunning, batteryOptimized}
- POST /relay/heartbeat (same)
- GET /relay/devices -> {devices, count}
- GET /relay/health

Deploy (Render / Railway / Fly / VPS):
  npm install
  RELAYER_URL=https://<your-relayer>.onrender.com PORT=8787 node server.js

Then set Teller env RELAYER_URL to that URL and redeploy Teller.
