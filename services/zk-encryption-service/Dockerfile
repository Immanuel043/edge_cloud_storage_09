FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    libpq-dev \
    libssl-dev \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY services/zk-encryption-service/requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy and install shared-billing package
COPY services/shared-billing /tmp/shared-billing
RUN pip install --no-cache-dir -e /tmp/shared-billing

# Copy alembic configuration
COPY services/zk-encryption-service/alembic.ini .

# Copy application code (includes app/alembic/ directory with migrations)
COPY services/zk-encryption-service/app ./app

# Create storage directory
RUN mkdir -p /app/storage

# Create non-root user and set ownership
RUN useradd --create-home --shell /bin/bash appuser && \
    chown -R appuser:appuser /app

USER appuser

# Expose port
EXPOSE 8002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8002/health || exit 1

# Run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002", "--workers", "4"]
