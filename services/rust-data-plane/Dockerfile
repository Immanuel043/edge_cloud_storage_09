# Production Dockerfile for Rust Data Plane
FROM rust:1.83-slim as builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy only the necessary files (not target/)
COPY services/rust-data-plane/Cargo.toml services/rust-data-plane/Cargo.lock ./
COPY services/rust-data-plane/src ./src

# Build release binary with optimizations
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*

# Create directories
RUN mkdir -p /tmp/edge-storage

# Copy binary from builder
COPY --from=builder /build/target/release/edge-storage-dataplane /usr/local/bin/edge-storage-dataplane

# Make executable
RUN chmod +x /usr/local/bin/edge-storage-dataplane

# Set environment defaults
ENV SOCKET_PATH=/tmp/edge-storage-dataplane.sock
ENV STORAGE_ROOT=/tmp/edge-storage
ENV COMPRESSION_LEVEL=3
ENV RUST_LOG=info
ENV USE_SCM_RIGHTS=true

CMD ["edge-storage-dataplane"]
