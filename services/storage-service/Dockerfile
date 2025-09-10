# services/storage-service/Dockerfile
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

# Copy alembic configuration FILE (not directory)
COPY alembic.ini .

# Copy application (this already includes app/alembic/ directory)
COPY app/ ./app/
# REMOVED: COPY alembic/ ./alembic/  <-- This line was causing the error

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
exec uvicorn app.main:app --host 0.0.0.0 --port 8000\n' > /entrypoint.sh

RUN chmod +x /entrypoint.sh

# Expose port
EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]