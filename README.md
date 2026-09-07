# Relayer — ephemeral temp DB for Teller

Flow: `App (Uncry) -> https://teller-six.vercel.app/api/devices/* -> Relayer (/relay/*) -> in-memory TTL 120s -> Teller GET /relay/devices`

Hardcoded TELLER_URL = https://teller-six.vercel.app. Relayer only serves that origin.

## One-command run (linux server, keep running until you close)

```bash
git clone https://github.com/Hailer367/Relayer.git
cd Relayer
./start.sh
# prints RELAYER PUBLIC URL: https://xxx.trycloudflare.com
# Paste that URL as RELAYER_URL in Vercel -> teller -> Settings -> Environment Variables -> Redeploy
```

`./start.sh` does:
1. `npm install` if needed, starts `node server.js` on :8787 (nohup, log relayer.log)
2. starts `cloudflared tunnel --url http://localhost:8787` and prints the public https URL every time

Keep the terminal open (tunnel dies when you close it). Re-run gives a new URL — update Vercel env each time.

With secret (optional, both sides must match):
```bash
RELAYER_SECRET=uncry-relayer-2025 ./start.sh
# same secret in Vercel env RELAYER_SECRET
```

Other:
```bash
./tunnel.sh      # just the tunnel for already-running Relayer
./stop.sh        # pkill Relayer
tail -f relayer.log
curl http://localhost:8787/relay/health
```

Endpoints: POST /relay/register, POST /relay/heartbeat, GET /relay/devices, GET /relay/health
Ephemeral: appear when online (heartbeat 60s), vanish 120s after last heartbeat. Max 5000 devices, rate limit 120/min/IP, 16kb payload.
