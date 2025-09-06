# services/web-service/Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files first (leverages build cache)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy application code (everything since no .dockerignore)
COPY . .

# Create logs directory
RUN mkdir -p logs

# Expose port (optional: if your server listens on 3000)
EXPOSE 3000

# Run application
CMD ["node", "src/server.js"]