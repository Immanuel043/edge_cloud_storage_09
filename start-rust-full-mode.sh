#!/bin/bash
# Start the full Rust data plane system with SCM_RIGHTS (Phase 2)

set -e

echo "=========================================="
echo "Starting Full Rust Mode (Phase 2)"
echo "=========================================="
echo ""

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "1️⃣  Starting Rust server with SCM_RIGHTS support..."
# Kill any existing Rust server
pkill -9 edge-storage-dataplane 2>/dev/null || true
sleep 1

# Start Rust server in background
USE_SCM_RIGHTS=true nohup ./services/rust-data-plane/target/release/edge-storage-dataplane > /tmp/rust-server.log 2>&1 &
RUST_PID=$!

# Wait for server to start
sleep 2

# Check if server is running
if curl --unix-socket /tmp/edge-storage-dataplane.sock http://localhost/health 2>&1 | grep -q "healthy"; then
    echo "   ✅ Rust server started (PID: $RUST_PID)"
    echo "   📋 Logs: tail -f /tmp/rust-server.log"
else
    echo "   ❌ Rust server failed to start!"
    echo "   Check logs: cat /tmp/rust-server.log"
    exit 1
fi
echo ""

echo "2️⃣  Configuration:"
echo "   - Mode: FULL (3-4x faster)"
echo "   - SCM_RIGHTS: Enabled"
echo "   - Socket: /tmp/edge-storage-dataplane.sock"
echo ""

echo "3️⃣  Starting infrastructure with Docker Compose..."
cd infrastructure
docker-compose up -d storage-service
echo ""

echo "=========================================="
echo "✅ Full Rust Mode Started!"
echo "=========================================="
echo ""
echo "Service Status:"
echo "  - Rust Server: Running (PID: $RUST_PID)"
echo "  - FastAPI: Check with 'docker-compose ps'"
echo ""
echo "Quick Test:"
echo "  python3 test_scm_rights_simple.py"
echo ""
echo "View Logs:"
echo "  - Rust: tail -f /tmp/rust-server.log"
echo "  - FastAPI: docker-compose -f infrastructure/docker-compose.yml logs -f storage-service"
echo ""
echo "Stop Services:"
echo "  - Rust: pkill edge-storage-dataplane"
echo "  - Docker: cd infrastructure && docker-compose stop storage-service"
echo ""
