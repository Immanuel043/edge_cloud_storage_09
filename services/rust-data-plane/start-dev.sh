#!/bin/bash
# Development startup script for Rust data plane

set -e

echo "🚀 Starting Rust Data Plane in Development Mode"
echo "================================================"

# Clean up any existing socket
SOCKET_PATH="${SOCKET_PATH:-/tmp/edge-storage-dataplane.sock}"
if [ -S "$SOCKET_PATH" ]; then
    echo "🧹 Removing existing socket: $SOCKET_PATH"
    rm -f "$SOCKET_PATH"
fi

# Create storage directory if it doesn't exist
STORAGE_ROOT="${STORAGE_ROOT:-/tmp/edge-storage}"
if [ ! -d "$STORAGE_ROOT" ]; then
    echo "📁 Creating storage directory: $STORAGE_ROOT"
    mkdir -p "$STORAGE_ROOT"
fi

# Set development environment variables
export RUST_LOG="${RUST_LOG:-info,edge_storage_dataplane=debug}"
export SOCKET_PATH="$SOCKET_PATH"
export STORAGE_ROOT="$STORAGE_ROOT"
export COMPRESSION_LEVEL="${COMPRESSION_LEVEL:-3}"

echo ""
echo "Configuration:"
echo "  - Socket: $SOCKET_PATH"
echo "  - Storage: $STORAGE_ROOT"
echo "  - Compression: $COMPRESSION_LEVEL"
echo "  - Log level: $RUST_LOG"
echo ""

# Build and run
echo "🔨 Building Rust service..."
cargo build --release

echo ""
echo "✅ Build complete. Starting service..."
echo ""

# Run the service
./target/release/edge-storage-dataplane
