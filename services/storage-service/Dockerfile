# services/storage-service/Dockerfile

# ── Stage 1: Build Rust cdylib for byte processing (CDC, SHA-256, bloom) ──
FROM rust:1.83-slim AS rust-builder
WORKDIR /build
COPY services/edge-byte-processor/Cargo.toml services/edge-byte-processor/Cargo.lock* ./
COPY services/edge-byte-processor/src ./src
RUN cargo build --release

# ── Stage 2: Python application ──
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (curl, procps, OpenCV, OCR, video codecs)
RUN apt-get update && apt-get install -y \
    curl \
    procps \
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

# Copy and install shared-billing package to permanent location
COPY services/shared-billing /app/shared-billing
RUN pip install --no-cache-dir -e /app/shared-billing

# Copy alembic configuration FILE (not directory)
COPY services/storage-service/alembic.ini .

# Copy application (this already includes app/alembic/ directory)
COPY services/storage-service/app/ ./app/

# Copy operational scripts (e.g. rescan_quarantined). Importable as `scripts.*`
# from the WORKDIR (/app), invoked via `python -m scripts.<name>`.
COPY services/storage-service/scripts/ ./scripts/

# Copy Rust cdylib from builder stage (replaces C rolling hash).
# Two locations on purpose:
#  - /app/app/utils/...  the historical path next to byte_processor.py.
#  - /usr/local/lib/edge-byte-processor/...  a stable path that survives the
#    docker-compose.dev.yml bind mount (which overlays the host's app/ on top
#    of /app/app and would otherwise hide the .so). byte_processor.py searches
#    both locations.
COPY --from=rust-builder /build/target/release/libedge_byte_processor.so /app/app/utils/libedge_byte_processor.so
RUN mkdir -p /usr/local/lib/edge-byte-processor && \
    cp /app/app/utils/libedge_byte_processor.so /usr/local/lib/edge-byte-processor/libedge_byte_processor.so

# Create storage directories
RUN mkdir -p /app/storage/{cache,warm,cold,temp,backup} && \
    for dir in cache warm cold temp backup; do \
        for i in $(seq 0 255); do \
            mkdir -p /app/storage/$dir/$(printf "%02x" $i); \
        done; \
        mkdir -p /app/storage/$dir/objects; \
    done

# Copy entrypoint script
COPY services/storage-service/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create dedicated socket directory for rust-dataplane IPC
RUN mkdir -p /run/dataplane

# Create non-root user and set ownership
RUN useradd --create-home --shell /bin/bash appuser && \
    chown -R appuser:appuser /app /entrypoint.sh /run/dataplane

USER appuser

# Expose port
EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]