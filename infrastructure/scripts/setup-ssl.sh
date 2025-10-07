#!/bin/bash

# SSL Certificate Setup Script for Edge Cloud Storage
# Supports both self-signed (development) and Let's Encrypt (production) certificates

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
SSL_DIR="$INFRA_DIR/ssl"
CERTBOT_DIR="$INFRA_DIR/certbot"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== SSL Certificate Setup ===${NC}"
echo ""

# Ask for certificate type
echo "Select certificate type:"
echo "1) Self-signed certificate (for development/testing)"
echo "2) Let's Encrypt certificate (for production)"
read -p "Enter choice [1-2]: " CERT_TYPE

case $CERT_TYPE in
    1)
        echo -e "${YELLOW}Setting up self-signed certificate...${NC}"

        # Create SSL directory
        mkdir -p "$SSL_DIR"

        # Generate self-signed certificate
        read -p "Enter domain name (or use 'localhost'): " DOMAIN
        DOMAIN=${DOMAIN:-localhost}

        echo "Generating self-signed certificate for $DOMAIN..."

        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout "$SSL_DIR/privkey.pem" \
            -out "$SSL_DIR/fullchain.pem" \
            -subj "/C=US/ST=State/L=City/O=Organization/CN=$DOMAIN" \
            -addext "subjectAltName=DNS:$DOMAIN,DNS:www.$DOMAIN,DNS:localhost"

        # Create chain.pem (same as fullchain for self-signed)
        cp "$SSL_DIR/fullchain.pem" "$SSL_DIR/chain.pem"

        echo -e "${GREEN}✓ Self-signed certificate created successfully!${NC}"
        echo ""
        echo "Certificate files created at:"
        echo "  - $SSL_DIR/fullchain.pem"
        echo "  - $SSL_DIR/privkey.pem"
        echo "  - $SSL_DIR/chain.pem"
        echo ""
        echo -e "${YELLOW}Note: Browsers will show a security warning for self-signed certificates.${NC}"
        echo "This is normal for development. Click 'Advanced' and 'Proceed' to continue."
        echo ""
        echo "Update your nginx.conf to use:"
        echo "  ssl_certificate /etc/nginx/ssl/fullchain.pem;"
        echo "  ssl_certificate_key /etc/nginx/ssl/privkey.pem;"
        echo "  ssl_trusted_certificate /etc/nginx/ssl/chain.pem;"
        ;;

    2)
        echo -e "${YELLOW}Setting up Let's Encrypt certificate...${NC}"

        # Create certbot directories
        mkdir -p "$CERTBOT_DIR/conf"
        mkdir -p "$CERTBOT_DIR/www"

        read -p "Enter your domain name: " DOMAIN
        read -p "Enter your email address: " EMAIL

        if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
            echo -e "${RED}Error: Domain and email are required for Let's Encrypt${NC}"
            exit 1
        fi

        echo ""
        echo -e "${YELLOW}Important: Before continuing, ensure:${NC}"
        echo "1. Your domain ($DOMAIN) points to this server's IP address"
        echo "2. Port 80 is accessible from the internet"
        echo "3. nginx is running and configured to serve ACME challenges"
        echo ""
        read -p "Press Enter to continue or Ctrl+C to cancel..."

        # Check if running in Docker or standalone
        if command -v docker-compose &> /dev/null; then
            echo "Using Docker Compose to obtain certificate..."

            # Temporary nginx config for ACME challenge
            cat > "$INFRA_DIR/nginx/nginx-acme.conf" << EOF
events {
    worker_connections 1024;
}

http {
    server {
        listen 80;
        server_name $DOMAIN;

        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }

        location / {
            return 200 'ACME challenge server running';
            add_header Content-Type text/plain;
        }
    }
}
EOF

            # Start nginx with ACME config
            docker run --rm -d \
                --name nginx-acme \
                -p 80:80 \
                -v "$CERTBOT_DIR/www:/var/www/certbot:ro" \
                -v "$INFRA_DIR/nginx/nginx-acme.conf:/etc/nginx/nginx.conf:ro" \
                nginx:stable

            echo "Starting ACME challenge server..."
            sleep 3

            # Obtain certificate using certbot
            docker run --rm \
                -v "$CERTBOT_DIR/conf:/etc/letsencrypt" \
                -v "$CERTBOT_DIR/www:/var/www/certbot" \
                certbot/certbot certonly \
                --webroot \
                --webroot-path=/var/www/certbot \
                --email "$EMAIL" \
                --agree-tos \
                --no-eff-email \
                --force-renewal \
                -d "$DOMAIN"

            # Stop ACME server
            docker stop nginx-acme
            rm "$INFRA_DIR/nginx/nginx-acme.conf"

            echo -e "${GREEN}✓ Let's Encrypt certificate obtained successfully!${NC}"
            echo ""
            echo "Certificate files are at:"
            echo "  - $CERTBOT_DIR/conf/live/$DOMAIN/fullchain.pem"
            echo "  - $CERTBOT_DIR/conf/live/$DOMAIN/privkey.pem"
            echo "  - $CERTBOT_DIR/conf/live/$DOMAIN/chain.pem"
            echo ""
            echo "Update your nginx.conf to use:"
            echo "  ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;"
            echo "  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;"
            echo "  ssl_trusted_certificate /etc/letsencrypt/live/$DOMAIN/chain.pem;"

        else
            echo -e "${RED}Error: Docker Compose not found. Install Docker Compose first.${NC}"
            exit 1
        fi
        ;;

    *)
        echo -e "${RED}Invalid choice. Exiting.${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "Next steps:"
echo "1. Update docker-compose.yml to mount the SSL certificates"
echo "2. Update nginx.conf with your domain name and certificate paths"
echo "3. Uncomment the HTTPS redirect in nginx.conf (line 160)"
echo "4. Restart nginx: docker-compose restart nginx"
echo ""
echo "For Let's Encrypt certificates, set up auto-renewal with:"
echo "  docker-compose up -d certbot"
