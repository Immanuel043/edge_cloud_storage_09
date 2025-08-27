#!/bin/bash
echo "Setting up Edge Cloud Storage System..."

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Detect Docker Compose command
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
elif command -v docker &> /dev/null && docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    echo -e "${RED}Error: Docker Compose is not installed!${NC}"
    echo "Please install Docker Desktop from: https://www.docker.com/products/docker-desktop"
    exit 1
fi

echo -e "${GREEN}Using Docker Compose command: $DOCKER_COMPOSE${NC}"

# Create directory structure
echo -e "${YELLOW}Creating directory structure...${NC}"
mkdir -p services/{storage-service,web-service,metadata-service,analytics-service}
mkdir -p storage/{cache,warm,cold,temp}
mkdir -p frontend/src/{components,hooks,services,pages,utils}
mkdir -p infrastructure/{kubernetes,terraform,monitoring}
mkdir -p scripts

# Create .env file
echo -e "${YELLOW}Creating environment configuration...${NC}"
cat > .env << EOF
# Security
SECRET_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)

# Database
DATABASE_URL=postgresql://edge_admin:secure_password@localhost/edge_cloud
REDIS_URL=redis://localhost:6379

# Services
STORAGE_SERVICE_URL=http://localhost:8000
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
EOF

# Check if Python3 is installed
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Python 3 is not installed. Please install Python 3.11+${NC}"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed. Please install Node.js 18+${NC}"
    exit 1
fi

# Install Python dependencies
echo -e "${YELLOW}Installing Python dependencies...${NC}"
if [ -d "services/storage-service" ]; then
    cd services/storage-service
    
    # Create requirements.txt if it doesn't exist
    if [ ! -f "requirements.txt" ]; then
        echo -e "${YELLOW}Creating requirements.txt...${NC}"
        cat > requirements.txt << 'EOFREQ'
fastapi==0.104.1
uvicorn[standard]==0.24.0
sqlalchemy==2.0.23
asyncpg==0.29.0
alembic==1.12.1
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
elasticsearch[async]==8.11.0
clickhouse-driver==0.2.6
celery==5.3.4
EOFREQ
    fi
    
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    deactivate
    cd ../..
else
    echo -e "${YELLOW}services/storage-service directory not found, skipping Python setup${NC}"
fi

# Install Node.js dependencies
echo -e "${YELLOW}Installing Node.js dependencies...${NC}"
if [ -d "services/web-service" ]; then
    cd services/web-service
    
    # Create package.json if it doesn't exist
    if [ ! -f "package.json" ]; then
        echo -e "${YELLOW}Creating package.json...${NC}"
        cat > package.json << 'EOFPKG'
{
  "name": "edge-cloud-web-service",
  "version": "1.0.0",
  "description": "Web service for Edge Cloud Storage",
  "main": "src/server.js",
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
EOFPKG
    fi
    
    npm install
    cd ../..
else
    echo -e "${YELLOW}services/web-service directory not found, skipping Node.js setup${NC}"
fi

# Install frontend dependencies
echo -e "${YELLOW}Installing frontend dependencies...${NC}"
if [ -d "frontend" ]; then
    cd frontend
    
    # Create package.json if it doesn't exist
    if [ ! -f "package.json" ]; then
        echo -e "${YELLOW}Creating frontend package.json...${NC}"
        cat > package.json << 'EOFFRONTPKG'
{
  "name": "edge-cloud-frontend",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "axios": "^1.6.2",
    "react-dropzone": "^14.2.3",
    "zustand": "^4.4.7",
    "react-router-dom": "^6.20.1",
    "@tanstack/react-query": "^5.12.2",
    "socket.io-client": "^4.6.0",
    "lucide-react": "^0.294.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.43",
    "@types/react-dom": "^18.2.17",
    "@vitejs/plugin-react": "^4.2.0",
    "autoprefixer": "^10.4.16",
    "postcss": "^8.4.32",
    "tailwindcss": "^3.3.6",
    "typescript": "^5.3.3",
    "vite": "^5.0.8"
  }
}
EOFFRONTPKG
    fi
    
    npm install
    cd ..
else
    echo -e "${YELLOW}frontend directory not found, skipping frontend setup${NC}"
fi

# Create docker-compose.yml if it doesn't exist
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${YELLOW}Creating docker-compose.yml...${NC}"
    cat > docker-compose.yml << 'EOFDOCKER'
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: edge_cloud
      POSTGRES_USER: edge_admin
      POSTGRES_PASSWORD: secure_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"

volumes:
  postgres_data:
  redis_data:
EOFDOCKER
fi

# Check if Docker is running
if ! docker info &> /dev/null; then
    echo -e "${RED}Docker is not running!${NC}"
    echo "Please start Docker Desktop and run this script again."
    exit 1
fi

# Start only essential services (PostgreSQL and Redis)
echo -e "${YELLOW}Starting essential services (PostgreSQL and Redis)...${NC}"
$DOCKER_COMPOSE up -d postgres redis

# Wait for PostgreSQL to be ready
echo -e "${YELLOW}Waiting for PostgreSQL to be ready...${NC}"
sleep 10

# Check if services are running
if $DOCKER_COMPOSE ps | grep -q "postgres.*Up"; then
    echo -e "${GREEN}PostgreSQL is running${NC}"
else
    echo -e "${RED}PostgreSQL failed to start${NC}"
fi

if $DOCKER_COMPOSE ps | grep -q "redis.*Up"; then
    echo -e "${GREEN}Redis is running${NC}"
else
    echo -e "${RED}Redis failed to start${NC}"
fi

echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Start the storage service:"
echo "   cd services/storage-service"
echo "   source venv/bin/activate"
echo "   uvicorn app.main:app --reload --port 8000"
echo ""
echo "2. Start the web service:"
echo "   cd services/web-service"
echo "   npm run dev"
echo ""
echo "3. Start the frontend:"
echo "   cd frontend"
echo "   npm run dev"
echo ""
echo "Access the application at:"
echo "- Frontend: http://localhost:5173 (Vite default port)"
echo "- Storage API: http://localhost:8000/docs"
echo "- Web Service: http://localhost:3001"
echo ""
echo "To stop services:"
echo "  $DOCKER_COMPOSE down"
echo ""
echo "To view logs:"
echo "  $DOCKER_COMPOSE logs -f"