#!/usr/bin/env python3
"""
Fresh Database Initialization Script
Creates all tables from SQLAlchemy models without using Alembic migrations.

Usage:
    python -m app.scripts.init_database

This script will:
1. Drop all existing tables (if FORCE_RECREATE=true)
2. Create all tables from SQLAlchemy models
3. Create all indexes
4. Set up initial data (if needed)

Perfect for production deployments where you want a clean slate.
"""

import asyncio
import sys
import os
from sqlalchemy import text, inspect
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.schema import CreateTable

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings
from app.models.database import Base
from app.database import engine


async def check_database_exists():
    """Check if database is accessible"""
    try:
        async with engine.connect() as conn:
            result = await conn.execute(text("SELECT 1"))
            return True
    except Exception as e:
        print(f"❌ Database connection failed: {e}")
        return False


async def get_existing_tables():
    """Get list of existing tables in database"""
    async with engine.connect() as conn:
        result = await conn.execute(text("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_type = 'BASE TABLE'
            ORDER BY table_name
        """))
        return [row[0] for row in result]


async def drop_all_tables(force: bool = False):
    """Drop all existing tables"""
    if not force:
        print("⚠️  Skipping table drop (set FORCE_RECREATE=true to drop)")
        return

    print("🗑️  Dropping all existing tables...")

    async with engine.begin() as conn:
        # Drop all tables with CASCADE
        await conn.execute(text("""
            DO $$
            DECLARE
                r RECORD;
            BEGIN
                FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
                LOOP
                    EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
                END LOOP;
            END $$;
        """))

        # Drop all sequences
        await conn.execute(text("""
            DO $$
            DECLARE
                r RECORD;
            BEGIN
                FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public')
                LOOP
                    EXECUTE 'DROP SEQUENCE IF EXISTS ' || quote_ident(r.sequence_name) || ' CASCADE';
                END LOOP;
            END $$;
        """))

        # Drop all custom types/enums
        await conn.execute(text("""
            DO $$
            DECLARE
                r RECORD;
            BEGIN
                FOR r IN (SELECT typname FROM pg_type WHERE typtype = 'e' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public'))
                LOOP
                    EXECUTE 'DROP TYPE IF EXISTS ' || quote_ident(r.typname) || ' CASCADE';
                END LOOP;
            END $$;
        """))

    print("✅ All tables dropped successfully")


async def create_all_tables():
    """Create all tables from SQLAlchemy models"""
    print("📋 Creating all tables from SQLAlchemy models...")

    # Get all table names from models
    table_names = [table.name for table in Base.metadata.sorted_tables]
    print(f"   Found {len(table_names)} tables in models")

    # Create all tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    print(f"✅ Created {len(table_names)} tables successfully")

    # Print created tables
    print("\n📊 Created tables:")
    for i, table_name in enumerate(table_names, 1):
        print(f"   {i:2d}. {table_name}")


async def verify_schema():
    """Verify that all tables were created correctly"""
    print("\n🔍 Verifying schema...")

    # Get expected tables from models
    expected_tables = set(table.name for table in Base.metadata.sorted_tables)

    # Get actual tables from database
    actual_tables = set(await get_existing_tables())

    # Check for missing tables
    missing_tables = expected_tables - actual_tables
    if missing_tables:
        print(f"⚠️  Missing tables: {', '.join(missing_tables)}")
        return False

    # Check for extra tables (not in models)
    extra_tables = actual_tables - expected_tables - {'alembic_version'}  # Exclude alembic table
    if extra_tables:
        print(f"ℹ️  Extra tables (not in models): {', '.join(extra_tables)}")

    print(f"✅ Schema verified: {len(expected_tables)} tables match models")
    return True


async def create_initial_data():
    """Create any initial/seed data if needed"""
    print("\n🌱 Creating initial data...")

    async with engine.begin() as conn:
        # Check if we need to create any seed data
        # For example, default admin user, system settings, etc.

        # You can add seed data here if needed
        # Example:
        # await conn.execute(text("""
        #     INSERT INTO users (id, email, username, password_hash, plan_type)
        #     VALUES (gen_random_uuid(), 'admin@example.com', 'admin', 'hashed_password', 'admin')
        #     ON CONFLICT DO NOTHING
        # """))

        pass

    print("✅ Initial data created (if any)")


async def setup_alembic_version():
    """Set up Alembic version table to mark as 'current' without running migrations"""
    print("\n📌 Setting up Alembic version tracking...")

    async with engine.begin() as conn:
        # Create alembic_version table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS alembic_version (
                version_num VARCHAR(32) NOT NULL,
                CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
            )
        """))

        # Mark as 'fresh_install' or use a special version
        await conn.execute(text("""
            INSERT INTO alembic_version (version_num)
            VALUES ('fresh_install_v1')
            ON CONFLICT (version_num) DO UPDATE SET version_num = 'fresh_install_v1'
        """))

    print("✅ Alembic version set to 'fresh_install_v1'")


async def main():
    """Main initialization flow"""
    print("=" * 70)
    print("🚀 Fresh Database Initialization Script")
    print("=" * 70)
    print()

    # Configuration
    force_recreate = os.getenv('FORCE_RECREATE', 'false').lower() == 'true'
    skip_seed = os.getenv('SKIP_SEED', 'false').lower() == 'true'

    print(f"📝 Configuration:")
    print(f"   Database URL: {settings.DATABASE_URL.split('@')[1] if '@' in settings.DATABASE_URL else 'configured'}")
    print(f"   Force recreate: {force_recreate}")
    print(f"   Skip seed data: {skip_seed}")
    print()

    # Step 1: Check database connection
    print("🔌 Checking database connection...")
    if not await check_database_exists():
        print("❌ Cannot connect to database. Exiting.")
        sys.exit(1)
    print("✅ Database connection successful")
    print()

    # Step 2: Show existing tables
    existing = await get_existing_tables()
    if existing:
        print(f"📊 Found {len(existing)} existing tables:")
        for table in existing[:10]:  # Show first 10
            print(f"   - {table}")
        if len(existing) > 10:
            print(f"   ... and {len(existing) - 10} more")
        print()

    # Step 3: Drop tables if requested
    if force_recreate:
        # Skip confirmation in non-interactive mode (Docker)
        if sys.stdin.isatty():
            confirm = input("⚠️  Are you sure you want to DROP ALL TABLES? Type 'yes' to confirm: ")
            if confirm.lower() != 'yes':
                print("❌ Aborted by user")
                sys.exit(0)
        else:
            print("⚠️  FORCE_RECREATE=true detected - proceeding with table drop (non-interactive mode)")

        await drop_all_tables(force=True)
        print()

    # Step 4: Create all tables
    await create_all_tables()
    print()

    # Step 5: Verify schema
    if not await verify_schema():
        print("⚠️  Schema verification failed!")
        sys.exit(1)

    # Step 6: Create initial data
    if not skip_seed:
        await create_initial_data()

    # Step 7: Setup Alembic version
    await setup_alembic_version()

    print()
    print("=" * 70)
    print("✅ Database initialization completed successfully!")
    print("=" * 70)
    print()
    print("📋 Summary:")
    print(f"   - Tables created: {len(Base.metadata.sorted_tables)}")
    print(f"   - Schema verified: ✅")
    print(f"   - Ready for production: ✅")
    print()


if __name__ == "__main__":
    asyncio.run(main())
