#!/bin/bash
# Start services in PRODUCTION mode (with Elasticsearch persistence)
# Data will persist across container restarts

echo "🚀 Starting Edge Cloud Storage in PRODUCTION mode"
echo "✅ Elasticsearch data WILL persist across restarts"
echo ""

docker-compose -f docker-compose.yml -f docker-compose.persistent.yml up -d

echo ""
echo "✅ Services started in production mode with persistence"
echo "💾 Elasticsearch data is stored in 'elasticsearch_data' volume"
echo ""
echo "To view volumes: docker volume ls"
echo "To inspect volume: docker volume inspect edge-cloud-network_elasticsearch_data"
