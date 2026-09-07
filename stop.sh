#!/bin/bash
pkill -f "node server.js" && echo "stopped" || echo "nothing running"
