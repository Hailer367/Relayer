#!/bin/bash
set -e
PORT=${PORT:-8787}
RELAYER_SECRET=${RELAYER_SECRET:-""}
TELLER_URL="https://teller-six.vercel.app"

# install deps if needed
[ -d node_modules ] || npm install --silent

# start Relayer in background (no RELAYER_URL yet — will be tunnel URL)
if [ -n "$RELAYER_SECRET" ]; then export RELAYER_SECRET; fi
export PORT
# use a placeholder RELAYER_URL for now, will be updated if tunnel starts
export RELAYER_URL="http://localhost:$PORT"
nohup node server.js > relayer.log 2>&1 &
PID=$!
echo "Relayer PID $PID on :$PORT (log: relayer.log)"
sleep 1
curl -s http://localhost:$PORT/relay/health | head -c 200; echo " [health check]"

# ---- Cloudflare Tunnel: prints public URL to paste as RELAYER_URL in Vercel ----
if command -v cloudflared >/dev/null 2>&1; then CF="cloudflared"
else CF="npx -y cloudflared@latest"; fi

echo ""
echo "Starting Cloudflare Tunnel (public URL will appear below)..."
echo "Keep this terminal open. Paste the https://*.trycloudflare.com URL as RELAYER_URL in Vercel -> Teller -> Settings -> Environment Variables -> Redeploy"
echo ""

# Run tunnel and parse URL from stderr; --url mode prints trycloudflare URL
# Capture URL: cloudflared logs "https://xxx.trycloudflare.com" to stderr
set +e
$CF tunnel --url http://localhost:$PORT 2>&1 | while IFS= read -r line; do
  echo "$line"
  if echo "$line" | grep -q "https://.*trycloudflare.com"; then
    URL=$(echo "$line" | grep -o "https://[a-z0-9.-]*trycloudflare.com" | head -1)
    if [ -n "$URL" ]; then
      echo ""
      echo "=================================================================="
      echo "  RELAYER PUBLIC URL: $URL"
      echo "  -> Go Vercel -> teller -> Settings -> Env -> RELAYER_URL=$URL -> Save -> Redeploy"
      echo "=================================================================="
      echo ""
    fi
  fi
done
