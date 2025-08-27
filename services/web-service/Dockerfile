# services/web-service/Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY src/ ./src/
COPY public/ ./public/

# Create directories
RUN mkdir -p logs

# Run application
CMD ["node", "src/server.js"]