# services/storage-service/Dockerfile
FROM python:3.11-slim

#curl installation
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install system dependencies (including OpenCV, OCR, and video codec dependencies)
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    libpq-dev \
    postgresql-client \
    netcat-traditional \
    libgl1 \
    libglib2.0-0 \
    ffmpeg \
    libavcodec-dev \
    libavformat-dev \
    libswscale-dev \
    tesseract-ocr \
    tesseract-ocr-eng \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY services/storage-service/requirements.txt .

# Install Python dependencies with extended timeout and retries for large packages
RUN pip install --no-cache-dir --timeout=300 --retries=10 -r requirements.txt

# Copy and install shared-billing package
COPY services/shared-billing /tmp/shared-billing
RUN pip install --no-cache-dir -e /tmp/shared-billing

# Copy alembic configuration FILE (not directory)
COPY services/storage-service/alembic.ini .

# Copy application (this already includes app/alembic/ directory)
COPY services/storage-service/app/ ./app/
# REMOVED: COPY alembic/ ./alembic/  <-- This line was causing the error

# Create storage directories
RUN mkdir -p /app/storage/{cache,warm,cold,temp,backup} && \
    for dir in cache warm cold temp backup; do \
        for i in $(seq 0 255); do \
            mkdir -p /app/storage/$dir/$(printf "%02x" $i); \
        done; \
        mkdir -p /app/storage/$dir/objects; \
    done

# Create entrypoint script with support for fresh DB init
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
echo "Waiting for database to be ready..."\n\
while ! nc -z ${DB_HOST:-postgres} ${DB_PORT:-5432}; do\n\
  sleep 1\n\
done\n\
echo "Database is ready!"\n\
\n\
# Check if we should use fresh DB init or migrations\n\
if [ "${USE_FRESH_DB_INIT:-false}" = "true" ]; then\n\
  echo "🚀 Initializing database from scratch (fresh install)..."\n\
  python -m app.scripts.init_database\n\
else\n\
  echo "Running database migrations..."\n\
  alembic upgrade head\n\
fi\n\
\n\
echo "Starting application..."\n\
exec uvicorn app.main:app --host 0.0.0.0 --port 8000\n' > /entrypoint.sh

RUN chmod +x /entrypoint.sh

# Expose port
EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]