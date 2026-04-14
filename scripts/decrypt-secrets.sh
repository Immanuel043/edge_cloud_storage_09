#!/bin/bash
set -eu

# ============================================
# Decrypt SOPS-encrypted secrets and merge with config
# ============================================
# Prerequisites:
#   brew install sops age   # macOS
#   apt install sops age    # Linux
#
# Your age private key must be at one of:
#   macOS: ~/Library/Application Support/sops/age/keys.txt
#   Linux: ~/.config/sops/age/keys.txt
#
# Generate with: age-keygen -o keys.txt
# Share your PUBLIC key with the team to be added to .sops.yaml
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")/infrastructure"

# Check prerequisites
if ! command -v sops &>/dev/null; then
    echo "Error: sops is not installed."
    echo "  brew install sops age   # macOS"
    echo "  apt install sops age    # Linux"
    exit 1
fi

if ! command -v age &>/dev/null; then
    echo "Error: age is not installed."
    echo "  brew install age   # macOS"
    echo "  apt install age    # Linux"
    exit 1
fi

if [ ! -f "$INFRA_DIR/secrets.enc.env" ]; then
    echo "Error: $INFRA_DIR/secrets.enc.env not found."
    echo "This file should be in the repository (it's safely encrypted)."
    exit 1
fi

if [ ! -f "$INFRA_DIR/.env.config" ]; then
    echo "Error: $INFRA_DIR/.env.config not found."
    exit 1
fi

echo "Decrypting secrets..."
DECRYPTED=$(sops -d "$INFRA_DIR/secrets.enc.env" 2>&1) || {
    echo "Error: Failed to decrypt secrets."
    echo "Make sure your age key is installed. See script header for details."
    echo "$DECRYPTED"
    exit 1
}

# Merge: .env.config (non-secrets) + decrypted secrets → .env
# Config comes first, secrets override via Docker Compose env precedence
{
    cat "$INFRA_DIR/.env.config"
    echo ""
    echo "# ===== Decrypted Secrets (do NOT commit this file) ====="
    echo "$DECRYPTED" | grep -v '^#' | grep -v '^$'
} > "$INFRA_DIR/.env"

echo "Secrets decrypted and merged into infrastructure/.env"
echo "Run 'docker compose config' to verify."
