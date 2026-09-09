# Relayer — Ephemeral Temp DB for Teller

Relayer is the in-memory database between Uncry (Android) and Teller (Vercel). It holds devices only while they are online — no persistence.

```
Uncry (Android, poss) --POST--> https://teller-six.vercel.app/api/devices/* --forward--> Relayer (/relay/*) --store TTL 120s--> Teller GET /relay/devices --> Dashboard
```

- Hardcoded `TELLER_URL = https://teller-six.vercel.app` (Relayer only serves this origin)
- Ephemeral: device appears when app heartbeats every 60s, vanishes ~120s after last heartbeat (offline)
- No database on disk — restart clears all. For permanent history add a real DB later.

## How to use

### 1. Run on any Linux server (one command, stays alive until you stop it)

```bash
git clone https://github.com/Hailer367/Relayer.git
cd Relayer
./start.sh
```

What it does:
1. `npm install` if needed, starts `node server.js` on `:8787` via `nohup` (log `relayer.log`, PID printed)
2. Starts `cloudflared tunnel --url http://localhost:8787` and prints:

```
==================================================================
  RELAYER PUBLIC URL: https://xxxx-xxxx.trycloudflare.com
  -> Go Vercel -> teller -> Settings -> Env -> RELAYER_URL=https://xxxx-xxxx.trycloudflare.com -> Save -> Redeploy
==================================================================
```

Copy that `https://...trycloudflare.com` URL, paste as `RELAYER_URL` in Vercel → teller project → Settings → Environment Variables → Save → Redeploy. Every restart generates a new URL — repaste it.

Keep that terminal open — closing it kills the tunnel (Relayer stays but becomes unreachable until you re-run).

Check it's alive:
```bash
tail -f relayer.log
curl http://localhost:8787/relay/health
curl http://localhost:8787/relay/devices | jq
```

Stop:
```bash
./stop.sh        # pkill node server.js
```

Other helpers:
```bash
./tunnel.sh      # only the Cloudflare Tunnel for an already-running Relayer
PORT=9000 ./start.sh                     # custom port
RELAYER_SECRET=uncry-relayer-2025 ./start.sh  # enable shared secret (must set same RELAYER_SECRET in Vercel too)
```

### 2. Connect Teller (Vercel)

Teller already proxies to Relayer when `RELAYER_URL` is set (`teller/lib/store.ts` → `getRelayerUrl()`).

In Vercel dashboard:
- `RELAYER_URL` = the `https://...trycloudflare.com` URL from `./start.sh`
- `RELAYER_SECRET` = same value as on Relayer, if you enabled it (else leave empty)
- Redeploy. Test: open `https://teller-six.vercel.app/dashboard` → launch Uncry → row appears in 5s, turns offline 90s after app killed, vanishes 120s later.

If `RELAYER_URL` is empty, Teller falls back to in-memory/KV (devices won't appear reliably on Vercel serverless — use Relayer).

### 3. How Uncry talks to it

You don't call Relayer directly from the app. Uncry (poss, `DeviceRegistrar.kt`) posts to `https://teller-six.vercel.app/api/devices/register` and `/heartbeat` (BuildConfig `TELLER_BASE_URL`). Teller forwards to `RELAYER_URL/relay/*`. No app change needed after setting `RELAYER_URL` on Vercel.

Manual test (bypass app):
```bash
curl -X POST https://teller-six.vercel.app/api/devices/register -H "Content-Type: application/json" \
  -d '{"deviceId":"test-123","model":"Pixel 7","androidVersion":"14","appVersion":"0.2.1-poss","installed":["cn.tydic.ethiopay"],"missing":["prod.cbe.birr"],"monitorRunning":true,"batteryOptimized":false}'

curl https://teller-six.vercel.app/api/devices | jq
# with direct Relayer (if public):
curl http://YOUR_SERVER:8787/relay/devices | jq
```

## API

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/relay/register` | `{deviceId, model, androidVersion, appVersion, installed[], missing[], monitorRunning, batteryOptimized}` | `deviceId` 4-128 chars `[a-zA-Z0-9._-]` |
| POST | `/relay/heartbeat` | same | increments `heartbeatCount` |
| GET | `/relay/devices` | — | `{devices[], count, ephemeral:true, ttlMs:120000}` sorted by `lastSeen` |
| GET | `/relay/health` | — | `{ok, count, uptime, maxDevices:5000, ttlMs}` |
| GET | `/` | — | info |

Validation: arrays capped 20 items, strings 32-64 chars, payload 16kb, rate limit 120/min/IP (429), max 5000 devices (store full 400), `X-Content-Type-Options: nosniff` etc. If `RELAYER_SECRET` env is set, all `/relay/*` require header `x-relayer-secret: <secret>` or `Authorization: Bearer *** (401 otherwise).

## Per-device command isolation

Every device row owns a random `token` minted at register. The device gets it back as top-level `deviceToken` on register/heartbeat and must present it as `x-device-token` on every heartbeat and poll. Without the right token for THAT deviceId the request gets 401: no queue read, no queue drain, no state spoof — device A can never see or consume device B's commands, even knowing B's id. Tokens are stripped from all dashboard-facing reads (`/relay/devices*`, and Teller strips them again before the browser). Uncry persists the token in prefs (`teller_device_token`) and sends it automatically; reinstall = new deviceId = new token. Note: restarting this server wipes all rows, so every device re-registers and gets a fresh token on next heartbeat.

## Deployment notes

- Public IP server: set `RELAYER_URL=http://YOUR_IP:8787` before `./start.sh` and use that IP in Vercel instead of the tunnel URL (no tunnel needed).
- Systemd (optional, survive reboot):
```
[Unit] Description=Relayer
[Service] WorkingDirectory=/home/user/Relayer
Environment=PORT=8787
Environment=RELAYER_URL=https://your-tunnel-or-ip
ExecStart=/usr/bin/node server.js
Restart=always
```
- Logs: `relayer.log` via nohup, `server.js` also logs `[register] <id> <model> total=N`.

## Troubleshooting

- `count` stays 0 on Teller dashboard → `RELAYER_URL` not set or wrong in Vercel, or tunnel closed — re-run `./start.sh` and repaste.
- `401 unauthorized` → `RELAYER_SECRET` mismatch between Relayer and Vercel — set same value both sides or leave both empty.
- `429 rate limited` → device spamming >120/min — wait 60s.
- `413 payload too large` → body >16kb — trim `installed`/`model` fields.
- Devices disappear → expected ephemeral behavior (TTL 120s after last heartbeat). Keep app foreground or service running.

License: internal.
