#!/bin/bash

# =====================================================
# Edge Cloud Storage System - Complete Setup Script
# =====================================================

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT=$(pwd)
PYTHON_VERSION="3.11"
NODE_VERSION="18"

# Print header
echo -e "${BLUE}=================================================${NC}"
echo -e "${BLUE}    Edge Cloud Storage System Setup Script      ${NC}"
echo -e "${BLUE}=================================================${NC}"
echo ""

# =====================================================
# 1. PREREQUISITES CHECK
# =====================================================

echo -e "${YELLOW}[1/8] Checking prerequisites...${NC}"

# Check Docker
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
elif command -v docker &> /dev/null && docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    echo -e "${RED}✗ Docker Compose is not installed!${NC}"
    echo "  Please install Docker Desktop from: https://www.docker.com/products/docker-desktop"
    exit 1
fi
echo -e "${GREEN}✓ Docker Compose found: $DOCKER_COMPOSE${NC}"

# Check if Docker is running
if ! docker info &> /dev/null; then
    echo -e "${RED}✗ Docker is not running!${NC}"
    echo "  Please start Docker Desktop and run this script again."
    exit 1
fi
echo -e "${GREEN}✓ Docker is running${NC}"

# Check Python
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
else
    echo -e "${RED}✗ Python is not installed. Please install Python ${PYTHON_VERSION}+${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Python found: $PYTHON_CMD${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js is not installed. Please install Node.js ${NODE_VERSION}+${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js found: $(node --version)${NC}"

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm is not installed.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm found: $(npm --version)${NC}"

# =====================================================
# 2. CREATE PROJECT STRUCTURE
# =====================================================

echo ""
echo -e "${YELLOW}[2/8] Creating project structure...${NC}"

# Create main directories
mkdir -p infrastructure/{monitoring,scripts}
mkdir -p services/{storage-service,web-service}/app
mkdir -p frontend/src/{components,hooks,services,pages,utils}

# Create storage directories for storage-service
mkdir -p services/storage-service/storage/{cache,warm,cold,temp,backup}

# Create subdirectories for storage sharding
for dir in cache warm cold temp backup; do
    for i in $(seq 0 15); do  # Creating fewer subdirs for demo (0-f instead of 0-ff)
        mkdir -p services/storage-service/storage/$dir/$(printf "%02x" $i)
    done
    mkdir -p services/storage-service/storage/$dir/objects
done

echo -e "${GREEN}✓ Project structure created${NC}"

# =====================================================
# 3. CREATE ENVIRONMENT CONFIGURATION
# =====================================================

echo ""
echo -e "${YELLOW}[3/8] Creating environment configuration...${NC}"

# Generate secure keys if not exist
if [ ! -f ".env" ]; then
    if command -v openssl &> /dev/null; then
        SECRET_KEY=$(openssl rand -hex 32)
        SESSION_SECRET=$(openssl rand -hex 32)
    else
        SECRET_KEY="change_this_to_a_secure_secret_key_$(date +%s)"
        SESSION_SECRET="change_this_to_a_secure_session_secret_$(date +%s)"
    fi

    cat > .env << EOF
# Generated on $(date)
# Security
SECRET_KEY=${SECRET_KEY}
SESSION_SECRET=${SESSION_SECRET}

# Database
DATABASE_URL=postgresql+asyncpg://edge_admin:secure_password@localhost:5432/edge_cloud
DB_HOST=postgres
DB_PORT=5432
DB_USER=edge_admin
DB_PASSWORD=secure_password
DB_NAME=edge_cloud

# Redis
REDIS_URL=redis://localhost:6379
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_DB=0

# Services URLs
STORAGE_SERVICE_URL=http://localhost:8001
WEB_SERVICE_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3000

# Kafka
KAFKA_BROKERS=localhost:9092

# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200

# ClickHouse
CLICKHOUSE_URL=http://localhost:8123

# Storage Configuration
CHUNK_SIZE=67108864
MAX_FILE_SIZE=21474836480
COMPRESSION_LEVEL=3
CACHE_SIZE_GB=100
BACKUP_ENABLED=true

# Storage Paths
CACHE_PATH=/app/storage/cache
WARM_PATH=/app/storage/warm
COLD_PATH=/app/storage/cold
TEMP_PATH=/app/storage/temp
BACKUP_PATH=/app/storage/backup

# Application Settings
APP_NAME=edge-storage-service
VERSION=1.0.0
ENABLE_HTTPS=false
EOF
    echo -e "${GREEN}✓ Environment configuration created${NC}"
else
    echo -e "${BLUE}ℹ .env file already exists, skipping...${NC}"
fi

# =====================================================
# 4. SETUP STORAGE SERVICE (PYTHON)
# =====================================================

echo ""
echo -e "${YELLOW}[4/8] Setting up Storage Service...${NC}"

cd services/storage-service

# Create requirements.txt
cat > requirements.txt << 'EOF'
fastapi==0.104.1
uvicorn[standard]==0.24.0
sqlalchemy==2.0.23
asyncpg==0.29.0
alembic==1.13.1
redis==5.0.1
aioboto3==12.0.0
zstandard==0.22.0
cryptography==41.0.7
kafka-python==2.0.2
aiofiles==23.2.1
python-multipart==0.0.6
python-jose[cryptography]==3.3.0
passlib[bcrypt]==1.7.4
prometheus-client==0.19.0
prometheus-fastapi-instrumentator==6.1.0
elasticsearch[async]==8.11.0
clickhouse-driver==0.2.6
celery==5.3.4
email-validator==2.1.0
requests==2.31.0
aiokafka==0.10.0
aiocache[redis]==0.12.2
psutil==5.9.6
python-dotenv==1.0.0
pydantic==2.5.0
pydantic-settings==2.1.0
EOF

# Create virtual environment and install dependencies
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    $PYTHON_CMD -m venv venv
fi

echo "Installing Python dependencies..."
source venv/bin/activate || . venv/Scripts/activate 2>/dev/null || true
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# Initialize Alembic
if [ ! -f "alembic.ini" ]; then
    echo "Initializing Alembic for database migrations..."
    alembic init -t async app/alembic
    
    # Update alembic.ini with correct database URL
    sed -i.bak 's|sqlalchemy.url = .*|sqlalchemy.url = postgresql+asyncpg://edge_admin:secure_password@localhost:5432/edge_cloud|' alembic.ini
    rm -f alembic.ini.bak
    
    echo -e "${GREEN}✓ Alembic initialized${NC}"
else
    echo -e "${BLUE}ℹ Alembic already initialized, skipping...${NC}"
fi

# Create Dockerfile if not exists
if [ ! -f "Dockerfile" ]; then
    cat > Dockerfile << 'EOF'
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    postgresql-client \
    netcat-traditional \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy alembic configuration
COPY alembic.ini .

# Copy application
COPY app/ ./app/

# Create storage directories
RUN mkdir -p /app/storage/{cache,warm,cold,temp,backup} && \
    for dir in cache warm cold temp backup; do \
        for i in $(seq 0 255); do \
            mkdir -p /app/storage/$dir/$(printf "%02x" $i); \
        done; \
        mkdir -p /app/storage/$dir/objects; \
    done

# Create entrypoint script
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
echo "Waiting for database to be ready..."\n\
while ! nc -z ${DB_HOST:-postgres} ${DB_PORT:-5432}; do\n\
  sleep 1\n\
done\n\
echo "Database is ready!"\n\
\n\
echo "Running database migrations..."\n\
alembic upgrade head\n\
\n\
echo "Starting application..."\n\
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4\n' > /entrypoint.sh

RUN chmod +x /entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
EOF
    echo -e "${GREEN}✓ Dockerfile created${NC}"
fi

deactivate 2>/dev/null || true
cd ../..

# =====================================================
# 5. SETUP WEB SERVICE (NODE.JS)
# =====================================================

echo ""
echo -e "${YELLOW}[5/8] Setting up Web Service...${NC}"

cd services/web-service

# Create package.json
cat > package.json << 'EOF'
{
  "name": "edge-cloud-web-service",
  "version": "1.0.0",
  "description": "Web service for Edge Cloud Storage",
  "main": "src/server.js",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.6.0",
    "multer": "^1.4.5-lts.1",
    "ioredis": "^5.3.2",
    "kafkajs": "^2.2.4",
    "pg": "^8.11.3",
    "express-session": "^1.17.3",
    "connect-redis": "^7.1.0",
    "bcrypt": "^5.1.1",
    "axios": "^1.6.2",
    "form-data": "^4.0.0",
    "compression": "^1.7.4",
    "helmet": "^7.1.0",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "winston": "^3.11.0",
    "express-rate-limit": "^7.1.5"
  },
  "devDependencies": {
    "nodemon": "^3.0.2",
    "jest": "^29.7.0",
    "supertest": "^6.3.3"
  }
}
EOF

echo "Installing Node.js dependencies..."
npm install --quiet

# Create Dockerfile if not exists
if [ ! -f "Dockerfile" ]; then
    cat > Dockerfile << 'EOF'
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY . .

# Create logs directory
RUN mkdir -p logs

EXPOSE 3001

CMD ["node", "src/server.js"]
EOF
    echo -e "${GREEN}✓ Web Service Dockerfile created${NC}"
fi

cd ../..

# =====================================================
# 6. CREATE MONITORING CONFIGURATION
# =====================================================

echo ""
echo -e "${YELLOW}[6/8] Setting up monitoring configuration...${NC}"

# Create Prometheus configuration
mkdir -p infrastructure/monitoring
cat > infrastructure/monitoring/prometheus.yml << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'storage-service'
    static_configs:
      - targets: ['storage-service:8000']
    metrics_path: '/metrics'
    
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
      
  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']
EOF

echo -e "${GREEN}✓ Monitoring configuration created${NC}"

# =====================================================
# 7. DOCKER CLEANUP AND REBUILD
# =====================================================

echo ""
echo -e "${YELLOW}[7/8] Cleaning Docker environment...${NC}"

cd infrastructure

# Stop any running containers
$DOCKER_COMPOSE down 2>/dev/null || true

# Optional: Clean everything (commented out for safety)
# echo "Removing old containers and volumes..."
# docker system prune -f
# docker volume prune -f

echo -e "${GREEN}✓ Docker environment cleaned${NC}"

# =====================================================
# 8. START SERVICES
# =====================================================

echo ""
echo -e "${YELLOW}[8/8] Starting services...${NC}"

# Build services
echo "Building Docker images..."
$DOCKER_COMPOSE build --quiet storage-service 2>/dev/null || $DOCKER_COMPOSE build storage-service

# Start core services
echo "Starting PostgreSQL and Redis..."
$DOCKER_COMPOSE up -d postgres redis

# Wait for services to be ready
echo "Waiting for services to be ready..."
sleep 10

# Check PostgreSQL
if $DOCKER_COMPOSE exec -T postgres pg_isready -U edge_admin &>/dev/null; then
    echo -e "${GREEN}✓ PostgreSQL is ready${NC}"
else
    echo -e "${RED}✗ PostgreSQL is not ready${NC}"
fi

# Check Redis
if $DOCKER_COMPOSE exec -T redis redis-cli ping &>/dev/null; then
    echo -e "${GREEN}✓ Redis is ready${NC}"
else
    echo -e "${RED}✗ Redis is not ready${NC}"
fi

# Start storage service
echo "Starting Storage Service..."
$DOCKER_COMPOSE up -d storage-service

cd ..

# =====================================================
# COMPLETION MESSAGE
# =====================================================

echo ""
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}       Setup Complete! 🎉                       ${NC}"
echo -e "${GREEN}=================================================${NC}"
echo ""
echo -e "${BLUE}Service Status:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cd infrastructure && $DOCKER_COMPOSE ps && cd ..
echo ""
echo -e "${BLUE}Access Points:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📦 Storage API:    http://localhost:8001/docs"
echo "  🌐 Web Service:    http://localhost:3001"
echo "  🎨 Frontend:       http://localhost:3000"
echo "  🗄️ PostgreSQL:     localhost:5432"
echo "  ⚡ Redis:          localhost:6379"
echo ""
echo -e "${BLUE}Useful Commands:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  View logs:           cd infrastructure && $DOCKER_COMPOSE logs -f"
echo "  Stop all services:   cd infrastructure && $DOCKER_COMPOSE down"
echo "  Restart services:    cd infrastructure && $DOCKER_COMPOSE restart"
echo "  Check health:        curl http://localhost:8001/api/v1/health"
echo ""
echo -e "${BLUE}Database Migrations:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Create migration:    cd services/storage-service && alembic revision --autogenerate -m 'description'"
echo "  Apply migrations:    cd services/storage-service && alembic upgrade head"
echo "  Check status:        cd services/storage-service && alembic current"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. Check service health: curl http://localhost:8001/api/v1/health"
echo "2. View API documentation: http://localhost:8001/docs"
echo "3. Monitor logs: cd infrastructure && $DOCKER_COMPOSE logs -f storage-service"
echo ""

# Create a quick health check script
cat > check-health.sh << 'EOF'
#!/bin/bash
echo "Checking service health..."
echo "=========================="
curl -s http://localhost:8001/api/v1/health | python3 -m json.tool
echo ""
echo "=========================="
EOF
chmod +x check-health.sh

echo -e "${GREEN}Health check script created: ./check-health.sh${NC}"
echo ""