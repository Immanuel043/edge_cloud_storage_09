"""
Daily Subscription Reconciliation Job

Run this job daily (ideally at 2 AM server time) to detect and fix
data drift between our database and payment gateways.

Usage:
    # As a cron job:
    0 2 * * * cd /app && python -m app.jobs.daily_reconciliation

    # Manually:
    python -m app.jobs.daily_reconciliation
"""

import asyncio
import logging
import sys
from datetime import datetime
from pathlib import Path

# Add app directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app.database import get_db_async
from app.config import settings
from shared_billing import run_daily_reconciliation

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def main():
    """Run daily reconciliation job."""
    logger.info("=" * 80)
    logger.info("Starting Daily Subscription Reconciliation Job")
    logger.info(f"Timestamp: {datetime.utcnow().isoformat()}")
    logger.info("=" * 80)

    try:
        # Get database session
        async for db in get_db_async():
            try:
                # Run reconciliation
                result = await run_daily_reconciliation(
                    db=db,
                    stripe_api_key=settings.STRIPE_SECRET_KEY,
                    razorpay_key_id=settings.RAZORPAY_KEY_ID,
                    razorpay_key_secret=settings.RAZORPAY_KEY_SECRET
                )

                # Log results
                logger.info("-" * 80)
                logger.info("Reconciliation Results:")
                logger.info(f"  Duration: {result.duration_seconds:.2f} seconds")
                logger.info(f"  Subscriptions Checked: {result.subscriptions_checked}")
                logger.info(f"  Discrepancies Found: {result.discrepancies_found}")
                logger.info(f"  Auto-Fixed: {result.auto_fixed}")
                logger.info(f"  Manual Review Required: {result.manual_review_required}")
                logger.info(f"  Success Rate: {result.success_rate:.2f}%")
                logger.info(f"  Errors: {len(result.errors)}")
                logger.info("-" * 80)

                # Log discrepancies
                if result.discrepancies:
                    logger.warning(f"Found {len(result.discrepancies)} discrepancies:")
                    for i, disc in enumerate(result.discrepancies, 1):
                        logger.warning(
                            f"  {i}. [{disc.severity.upper()}] "
                            f"Subscription {disc.subscription_id}: "
                            f"{disc.discrepancy_type.value} - "
                            f"DB='{disc.db_value}' vs Gateway='{disc.gateway_value}' "
                            f"(Action: {disc.recommended_action.value})"
                        )

                # Log errors
                if result.errors:
                    logger.error(f"Encountered {len(result.errors)} errors:")
                    for i, error in enumerate(result.errors, 1):
                        logger.error(f"  {i}. {error}")

                # Alert if manual review needed
                if result.manual_review_required > 0:
                    logger.warning(
                        f"⚠️  {result.manual_review_required} subscriptions need manual review!"
                    )
                    logger.warning("Check audit logs for details.")

                # Success summary
                if result.discrepancies_found == 0:
                    logger.info("✅ All subscriptions are in sync! No discrepancies found.")
                elif result.auto_fixed == result.discrepancies_found:
                    logger.info("✅ All discrepancies were automatically fixed.")
                else:
                    logger.info(
                        f"⚠️  Fixed {result.auto_fixed}/{result.discrepancies_found} "
                        f"discrepancies automatically."
                    )

                # Exit code
                if result.errors:
                    logger.error("❌ Job completed with errors")
                    sys.exit(1)
                elif result.manual_review_required > 0:
                    logger.warning("⚠️  Job completed but manual review required")
                    sys.exit(2)
                else:
                    logger.info("✅ Job completed successfully")
                    sys.exit(0)

            finally:
                # Session cleanup handled by context manager
                pass

    except Exception as e:
        logger.error(f"Fatal error running reconciliation: {e}", exc_info=True)
        sys.exit(1)

    logger.info("=" * 80)
    logger.info("Daily Reconciliation Job Complete")
    logger.info("=" * 80)


if __name__ == "__main__":
    asyncio.run(main())
