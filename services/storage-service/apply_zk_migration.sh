#!/bin/bash
# Script to apply Zero-Knowledge Encryption database migration
# Run this from the storage-service directory

set -e  # Exit on error

echo "========================================="
echo "Zero-Knowledge Encryption Migration"
echo "========================================="
echo ""

# Check if running in Docker or locally
if [ -f "/.dockerenv" ]; then
    echo "Running inside Docker container..."
    LOCATION="docker"
else
    echo "Running locally..."
    LOCATION="local"
fi

echo ""
echo "Step 1: Checking database connection..."
python -c "from app.database import engine; import asyncio; asyncio.run(engine.connect())" 2>/dev/null && echo "✓ Database connection OK" || (echo "✗ Database connection failed" && exit 1)

echo ""
echo "Step 2: Checking current migration version..."
alembic current

echo ""
echo "Step 3: Reviewing pending migrations..."
alembic history --verbose | grep -A 5 "20251101_0000"

echo ""
echo "Step 4: Applying Zero-Knowledge Encryption migration..."
alembic upgrade head

echo ""
echo "Step 5: Verifying migration..."
alembic current

echo ""
echo "========================================="
echo "Migration completed successfully!"
echo "========================================="
echo ""
echo "New tables added:"
echo "  - subscription_tiers"
echo "  - user_subscriptions"
echo "  - hardware_keys"
echo "  - social_recovery_contacts"
echo "  - recovery_attempts"
echo "  - zk_enrollment_history"
echo ""
echo "User table extended with ZK fields:"
echo "  - zk_enabled, encrypted_master_key, kdf_salt, etc."
echo ""
echo "Object table extended with encryption fields:"
echo "  - is_encrypted, encrypted_file_key, file_key_iv, etc."
echo ""
echo "Next steps:"
echo "  1. Start the ZK encryption service"
echo "  2. Update the frontend for ZK support"
echo "  3. Test ZK registration and upload workflows"
echo ""
