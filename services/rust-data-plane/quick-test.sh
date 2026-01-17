#!/bin/bash
# Quick test to verify Rust service is working

set -e

echo "🧪 Quick Rust Data Plane Test"
echo "=============================="
echo ""

# Check if service is running
SOCKET_PATH="/tmp/edge-storage-dataplane.sock"

if [ ! -S "$SOCKET_PATH" ]; then
    echo "❌ Error: Rust service is not running!"
    echo ""
    echo "Start the service first:"
    echo "  cd services/rust-data-plane"
    echo "  ./start-dev.sh"
    echo ""
    exit 1
fi

echo "✅ Socket found: $SOCKET_PATH"
echo ""

# Try to connect
echo "🔌 Testing connection..."

# Create a simple test using Python (more reliable than curl for UDS)
python3 << 'PYTHON_TEST'
import socket
import sys

try:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(2.0)
    sock.connect("/tmp/edge-storage-dataplane.sock")

    # Send minimal HTTP request
    request = b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n"
    sock.sendall(request)

    # Read response
    response = sock.recv(4096).decode('utf-8', errors='ignore')

    if "healthy" in response or "200" in response:
        print("✅ Service is responding!")
        print("")
        print("Response preview:")
        print(response[:200])
        sys.exit(0)
    else:
        print("⚠️  Unexpected response:")
        print(response)
        sys.exit(1)

except Exception as e:
    print(f"❌ Connection failed: {e}")
    print("")
    print("Make sure the Rust service is running:")
    print("  cd services/rust-data-plane")
    print("  ./start-dev.sh")
    sys.exit(1)
finally:
    try:
        sock.close()
    except:
        pass
PYTHON_TEST

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Rust service is working!"
    echo ""
    echo "Next steps:"
    echo "  1. Run full test suite:"
    echo "     cd services/storage-service"
    echo "     python test_rust_client.py"
    echo ""
    echo "  2. Or integrate with FastAPI (see RUST_DEV_TESTING_GUIDE.md)"
else
    echo ""
    echo "❌ Test failed. Check the logs in the terminal running ./start-dev.sh"
fi
