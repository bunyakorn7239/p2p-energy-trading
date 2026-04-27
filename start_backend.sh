#!/usr/bin/env bash
# start_backend.sh — Install dependencies and start the Python backend
# Usage:  bash start_backend.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

echo "================================================"
echo "  P2P Energy Trading — Backend Start Script"
echo "================================================"

# ── 1. Install Python dependencies ─────────────────────────────────────────
echo ""
echo "▶ Installing Python dependencies…"
pip install -r "$BACKEND_DIR/requirements.txt" --quiet

echo "✅ Dependencies installed (pandapower, flask, flask-cors, pandas, numpy)"

# ── 2. Start Flask backend ──────────────────────────────────────────────────
echo ""
echo "▶ Starting Flask backend on http://localhost:5001 …"
echo "   (Port 5001 is used to avoid macOS AirPlay conflict on port 5000)"
echo "   Press Ctrl+C to stop."
echo ""
cd "$BACKEND_DIR" && python server.py
