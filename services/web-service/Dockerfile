# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for TypeScript)
RUN npm ci

# Copy source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Production stage
FROM node:18-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Create logs directory
RUN mkdir -p logs

EXPOSE 3000

# Run compiled JavaScript
CMD ["node", "dist/server.js"]
