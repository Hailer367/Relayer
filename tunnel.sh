#!/bin/bash
# Standalone: just print tunnel URL for already-running Relayer
PORT=${PORT:-8787}
if command -v cloudflared >/dev/null 2>&1; then CF="cloudflared"
else CF="npx -y cloudflared@latest"; fi
echo "Tunneling http://localhost:$PORT -> public https://*.trycloudflare.com"
echo "Paste the printed URL as RELAYER_URL in Vercel"
$CF tunnel --url http://localhost:$PORT
