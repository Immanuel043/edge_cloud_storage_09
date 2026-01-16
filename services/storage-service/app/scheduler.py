#!/usr/bin/env python3
"""
Billing Notification Scheduler

Production-ready scheduler that runs billing notification jobs.
"""
import asyncio
import logging
import signal
import sys
from datetime import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)

# Global flag for graceful shutdown
shutdown_flag = False


def signal_handler(signum, frame):
    """Handle shutdown signals gracefully"""
    global shutdown_flag
    logger.info(f"Received signal {signum}, initiating graceful shutdown...")
    shutdown_flag = True


async def main():
    """Main scheduler loop"""
    from app.jobs.billing_notifications import process_billing_notifications

    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    logger.info("=" * 80)
    logger.info("🚀 Billing Notification Scheduler Starting")
    logger.info("=" * 80)
    logger.info("Service: Normal Storage")
    logger.info("Check Interval: 1 hour")
    logger.info("=" * 80)

    iteration = 0

    while not shutdown_flag:
        iteration += 1
        start_time = datetime.now()

        try:
            logger.info(f"\n{'='*80}")
            logger.info(f"📋 Starting notification check #{iteration} at {start_time}")
            logger.info(f"{'='*80}")

            # Process notifications
            result = await process_billing_notifications()

            end_time = datetime.now()
            duration = (end_time - start_time).total_seconds()

            logger.info(f"\n{'='*80}")
            logger.info(f"✅ Notification check #{iteration} completed")
            logger.info(f"Duration: {duration:.2f} seconds")
            logger.info(f"Results: {result}")
            logger.info(f"{'='*80}\n")

        except Exception as e:
            logger.error(f"❌ Error in notification check #{iteration}: {e}", exc_info=True)
            # Sleep for 5 minutes before retrying on error
            logger.info("Sleeping for 5 minutes before retry...")
            await asyncio.sleep(300)
            continue

        if shutdown_flag:
            break

        # Sleep for 1 hour (3600 seconds)
        logger.info("😴 Sleeping for 1 hour until next check...")
        logger.info(f"Next check scheduled for: {datetime.now()}")

        # Sleep in small increments to allow quick shutdown
        for i in range(360):  # 360 * 10 seconds = 3600 seconds (1 hour)
            if shutdown_flag:
                break
            await asyncio.sleep(10)

    logger.info("\n" + "="*80)
    logger.info("👋 Billing Notification Scheduler Shutting Down")
    logger.info(f"Total iterations completed: {iteration}")
    logger.info("="*80)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Scheduler interrupted by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Fatal error in scheduler: {e}", exc_info=True)
        sys.exit(1)
