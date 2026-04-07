#!/usr/bin/env bash
set -e

echo ""
echo "  ████████████████████████████████████████"
echo "  ██  CLAY Foundation Model Web Platform  ██"
echo "  ████████████████████████████████████████"
echo ""

# Check Node
if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "  ✓ Node $(node -v)"

# Install deps if needed
if [ ! -d "server/node_modules" ]; then
  echo "  Installing server dependencies..."
  (cd server && npm install --silent)
fi

if [ ! -d "client/node_modules" ]; then
  echo "  Installing client dependencies..."
  (cd client && npm install --silent)
fi

echo ""
echo "  Starting services..."
echo "  API  →  http://localhost:3001"
echo "  App  →  http://localhost:5173"
echo ""

# Start server in background
node server/index.js &
SERVER_PID=$!

# Start client dev server
(cd client && npx vite --host 0.0.0.0)

# Cleanup
kill $SERVER_PID 2>/dev/null || true
