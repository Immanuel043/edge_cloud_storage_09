#!/bin/bash
# Pre-flight Checklist for ZK Backend Testing
# Verifies all dependencies and services are ready

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Service URLs
POSTGRES_HOST="localhost"
POSTGRES_PORT="5432"
REDIS_HOST="localhost"
REDIS_PORT="6379"
STORAGE_SERVICE_URL="http://localhost:8001"
ZK_SERVICE_URL="http://localhost:8002"
NGINX_URL="http://localhost:80"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Pre-Flight Checklist${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check 1: Docker
echo -n "Checking Docker... "
if command -v docker &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Docker not installed${NC}"
    exit 1
fi

# Check 2: Docker Compose
echo -n "Checking Docker Compose... "
if docker compose version &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Docker Compose not available${NC}"
    exit 1
fi

# Check 3: jq (for JSON parsing)
echo -n "Checking jq... "
if command -v jq &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${YELLOW}⚠ jq not installed (recommended for testing)${NC}"
    echo -e "${YELLOW}  Install with: brew install jq (macOS) or apt-get install jq (Linux)${NC}"
fi

# Check 4: curl
echo -n "Checking curl... "
if command -v curl &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ curl not installed${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}Checking Docker Containers...${NC}"
echo ""

# Check PostgreSQL
echo -n "PostgreSQL (port $POSTGRES_PORT)... "
if docker ps | grep -q "edge-postgres"; then
    if nc -z $POSTGRES_HOST $POSTGRES_PORT 2>/dev/null; then
        echo -e "${GREEN}✓ Running${NC}"
    else
        echo -e "${YELLOW}⚠ Container running but port not accessible${NC}"
    fi
else
    echo -e "${RED}✗ Not running${NC}"
    echo -e "${YELLOW}  Start with: cd infrastructure && docker compose up postgres -d${NC}"
fi

# Check Redis
echo -n "Redis (port $REDIS_PORT)... "
if docker ps | grep -q "edge-redis"; then
    if nc -z $REDIS_HOST $REDIS_PORT 2>/dev/null; then
        echo -e "${GREEN}✓ Running${NC}"
    else
        echo -e "${YELLOW}⚠ Container running but port not accessible${NC}"
    fi
else
    echo -e "${RED}✗ Not running${NC}"
    echo -e "${YELLOW}  Start with: cd infrastructure && docker compose up redis -d${NC}"
fi

# Check Storage Service
echo -n "Storage Service (port 8001)... "
if docker ps | grep -q "edge-storage-service"; then
    health_response=$(curl -s -o /dev/null -w "%{http_code}" "$STORAGE_SERVICE_URL/api/v1/health" 2>/dev/null || echo "000")
    if [ "$health_response" = "200" ]; then
        echo -e "${GREEN}✓ Healthy${NC}"
    else
        echo -e "${YELLOW}⚠ Running but not healthy (HTTP $health_response)${NC}"
    fi
else
    echo -e "${RED}✗ Not running${NC}"
    echo -e "${YELLOW}  Start with: cd infrastructure && docker compose up storage-service -d${NC}"
fi

# Check ZK Service
echo -n "ZK Encryption Service (port 8002)... "
if docker ps | grep -q "edge-zk-service"; then
    health_response=$(curl -s "$ZK_SERVICE_URL/health" 2>/dev/null)
    if echo "$health_response" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Healthy${NC}"
    else
        echo -e "${YELLOW}⚠ Running but not healthy${NC}"
        echo -e "${YELLOW}  Response: $health_response${NC}"
    fi
else
    echo -e "${RED}✗ Not running${NC}"
    echo -e "${YELLOW}  Start with: cd infrastructure && docker compose up zk-encryption-service -d${NC}"
fi

# Check Nginx
echo -n "Nginx (port 80)... "
if docker ps | grep -q "edge-nginx"; then
    health_response=$(curl -s -o /dev/null -w "%{http_code}" "$NGINX_URL/health" 2>/dev/null || echo "000")
    if [ "$health_response" = "200" ]; then
        echo -e "${GREEN}✓ Running${NC}"
    else
        echo -e "${YELLOW}⚠ Container running (HTTP $health_response)${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Not running (optional)${NC}"
fi

echo ""
echo -e "${BLUE}Checking Database Migration...${NC}"
echo ""

# Check if migration has been applied
echo -n "Zero-Knowledge migration... "
if docker exec edge-storage-service alembic current 2>/dev/null | grep -q "20251101_0000"; then
    echo -e "${GREEN}✓ Applied${NC}"
else
    echo -e "${RED}✗ Not applied${NC}"
    echo -e "${YELLOW}  Apply with: cd services/storage-service && ./apply_zk_migration.sh${NC}"
    echo -e "${YELLOW}  Or: docker exec edge-storage-service alembic upgrade head${NC}"
fi

echo ""
echo -e "${BLUE}Service Status Summary:${NC}"
echo ""

# Count running services
services_total=4
services_running=0

docker ps | grep -q "edge-postgres" && ((services_running++))
docker ps | grep -q "edge-redis" && ((services_running++))
docker ps | grep -q "edge-storage-service" && ((services_running++))
docker ps | grep -q "edge-zk-service" && ((services_running++))

if [ $services_running -eq $services_total ]; then
    echo -e "${GREEN}All critical services running ($services_running/$services_total)${NC}"
    echo ""
    echo -e "${GREEN}✓ Ready to test!${NC}"
    echo ""
    echo "Run tests with:"
    echo -e "${BLUE}  ./test_zk_backend.sh${NC}"
    echo ""
    exit 0
else
    echo -e "${YELLOW}Some services not running ($services_running/$services_total)${NC}"
    echo ""
    echo -e "${YELLOW}Start all services with:${NC}"
    echo -e "${BLUE}  cd infrastructure${NC}"
    echo -e "${BLUE}  docker compose up --build -d${NC}"
    echo ""
    exit 1
fi
