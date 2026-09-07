#!/bin/bash
# Simple keep-alive run for linux server: git clone && ./start.sh
PORT=${PORT:-8787}
RELAYER_URL=${RELAYER_URL:-"http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):8787"}
RELAYER_SECRET=${RELAYER_SECRET:-""}
echo "Starting Relayer on :$PORT  TELLER=https://teller-six.vercel.app  RELAYER=$RELAYER_URL  secret=${RELAYER_SECRET:+set}"
if [ -n "$RELAYER_SECRET" ]; then export RELAYER_SECRET; fi
export PORT RELAYER_URL
# install if needed
[ -d node_modules ] || npm install --silent
# keep running until you Ctrl+C or kill; logs to relayer.log
nohup node server.js > relayer.log 2>&1 &
echo "PID $!  logs: tail -f relayer.log  |  curl http://localhost:$PORT/relay/health"
