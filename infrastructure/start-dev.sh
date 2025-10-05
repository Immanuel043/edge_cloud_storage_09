#!/bin/bash
# Start services in DEVELOPMENT mode (no Elasticsearch persistence)
# Data will be lost when containers restart

echo "🚀 Starting Edge Cloud Storage in DEVELOPMENT mode"
echo "⚠️  Elasticsearch data will NOT persist across restarts"
echo ""

docker-compose -f docker-compose.yml up -d

echo ""
echo "✅ Services started in development mode"
echo "💡 To start with persistence (production), use: ./start-prod.sh"
