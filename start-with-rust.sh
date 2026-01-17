#!/bin/bash
# Complete startup script with Rust data plane

set -e

echo "============================================"
echo "Starting Edge Cloud Storage with Rust"
echo "============================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Rust service is built
if [ ! -f "services/rust-data-plane/target/release/edge-storage-dataplane" ]; then
    echo -e "${YELLOW}⚠️  Rust service not built. Building now...${NC}"
    cd services/rust-data-plane
    cargo build --release
    cd ../..
fi

# Function to start Rust service in background
start_rust() {
    echo -e "${GREEN}[1/3] Starting Rust Data Plane...${NC}"
    cd services/rust-data-plane
    ./start-dev.sh &
    RUST_PID=$!
    cd ../..
    echo "Rust service PID: $RUST_PID"

    # Wait for socket to be created
    echo "Waiting for Rust service to initialize..."
    for i in {1..30}; do
        if [ -S "/tmp/edge-storage-dataplane.sock" ]; then
            echo -e "${GREEN}✅ Rust service is ready!${NC}"
            echo ""
            break
        fi
        sleep 1
    done

    if [ ! -S "/tmp/edge-storage-dataplane.sock" ]; then
        echo "⚠️  Warning: Socket not found. Rust service may not be ready."
    fi
}

# Function to start infrastructure
start_infrastructure() {
    echo -e "${GREEN}[2/3] Starting Infrastructure (Docker)...${NC}"
    cd infrastructure
    docker-compose up -d
    cd ..
    echo -e "${GREEN}✅ Infrastructure started!${NC}"
    echo ""
}

# Function to start frontend
start_frontend() {
    echo -e "${GREEN}[3/3] Starting Frontend...${NC}"
    cd frontend-clean
    npm run dev &
    FRONTEND_PID=$!
    cd ..
    echo "Frontend PID: $FRONTEND_PID"
    echo -e "${GREEN}✅ Frontend started!${NC}"
    echo ""
}

# Trap Ctrl+C to cleanup
cleanup() {
    echo ""
    echo "Shutting down services..."

    # Kill Rust service
    if [ ! -z "$RUST_PID" ]; then
        kill $RUST_PID 2>/dev/null || true
    fi

    # Kill frontend
    if [ ! -z "$FRONTEND_PID" ]; then
        kill $FRONTEND_PID 2>/dev/null || true
    fi

    # Stop Docker
    cd infrastructure
    docker-compose down
    cd ..

    echo "All services stopped."
    exit 0
}

trap cleanup INT TERM

# Start all services
start_rust
start_infrastructure
start_frontend

echo "============================================"
echo "🚀 All Services Running!"
echo "============================================"
echo ""
echo "Services:"
echo "  - Rust Data Plane: /tmp/edge-storage-dataplane.sock"
echo "  - FastAPI Backend: http://localhost:8001"
echo "  - Frontend: http://localhost:5173 (check terminal for actual port)"
echo ""
echo "Environment:"
echo "  - RUST_DATAPLANE_ENABLED=true"
echo "  - Fallback to Python if Rust unavailable"
echo ""
echo "To test:"
echo "  1. Open http://localhost:5173 in your browser"
echo "  2. Login/Register"
echo "  3. Upload a file"
echo "  4. Check terminal logs for 'Rust' processing messages"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait indefinitely
wait
