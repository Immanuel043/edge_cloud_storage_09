"""
Storage Optimization Worker

Background worker that runs daily to:
- Analyze storage usage patterns for all users
- Generate optimization suggestions
- Update analysis results
"""

import logging
import asyncio
from datetime import datetime
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import uuid4

from ..models.database import User, StorageAnalysis, OptimizationSuggestion
from ..services.storage_analyzer import storage_analyzer
from ..services.storage_optimizer import storage_optimizer
from ..database import async_session
from ..monitoring.metrics import metrics_collector
from ..config import settings

logger = logging.getLogger(__name__)


class StorageOptimizationWorker:
    """
    Background worker for storage optimization analysis

    Features:
    - Daily storage pattern analysis
    - Automatic suggestion generation
    - Configurable analysis interval
    """

    def __init__(self):
        self.worker_task: Optional[asyncio.Task] = None
        self.is_running = False
        self.check_interval = settings.STORAGE_OPT_ANALYSIS_INTERVAL  # Default 24 hours

    async def start(self):
        """Start the background worker"""
        if self.is_running:
            logger.warning("Storage optimization worker already running")
            return

        self.is_running = True
        self.worker_task = asyncio.create_task(self._run_worker())
        logger.info("Storage optimization worker started")

    async def stop(self):
        """Stop the background worker"""
        self.is_running = False
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        logger.info("Storage optimization worker stopped")

    async def _run_worker(self):
        """Main worker loop"""
        while self.is_running:
            try:
                logger.info("Starting storage optimization worker cycle")

                async with async_session() as db:
                    try:
                        # Analyze storage and generate suggestions
                        await self._analyze_all_users(db)

                        await db.commit()
                        logger.info("Storage optimization worker cycle completed")

                    except Exception as e:
                        logger.error(f"Error in storage optimization worker cycle: {e}", exc_info=True)
                        await db.rollback()
                    finally:
                        break  # Exit the async generator

                # Update metrics
                metrics_collector.increment_counter('storage_optimization_worker_cycles_total')

            except Exception as e:
                logger.error(f"Fatal error in storage optimization worker: {e}", exc_info=True)
                metrics_collector.increment_counter('storage_optimization_worker_errors_total')

            # Sleep until next cycle
            if self.is_running:
                await asyncio.sleep(self.check_interval)

    async def _analyze_all_users(self, db: AsyncSession):
        """
        Analyze storage for all active users
        """
        logger.info("Analyzing storage for all active users")

        # Get all active users
        result = await db.execute(
            select(User).where(User.is_active == True)
        )
        users = result.scalars().all()

        analyzed_count = 0
        suggestions_count = 0

        for user in users:
            try:
                # Analyze user storage
                analysis = await storage_analyzer.analyze_user_storage(
                    user_id=user.id,
                    db=db
                )

                if not analysis:
                    logger.warning(f"Failed to analyze storage for user {user.id}")
                    continue

                # Save analysis to database
                db.add(analysis)
                await db.flush()  # Get analysis ID
                analyzed_count += 1

                # Generate optimization suggestions
                suggestions = await storage_optimizer.generate_suggestions(
                    analysis=analysis,
                    db=db
                )

                # Save suggestions to database
                for suggestion in suggestions:
                    db.add(suggestion)
                    suggestions_count += 1

                await db.flush()

                logger.info(
                    f"Analyzed user {user.id}: {analysis.total_files} files, "
                    f"{analysis.total_potential_savings} bytes savings, "
                    f"{len(suggestions)} suggestions"
                )

                # Update metrics
                metrics_collector.increment_counter('storage_analyses_completed_total')
                metrics_collector.increment_counter(
                    'storage_optimization_suggestions_generated_total',
                    len(suggestions)
                )

            except Exception as e:
                logger.error(f"Failed to analyze storage for user {user.id}: {e}", exc_info=True)
                continue

        logger.info(
            f"Storage optimization complete: {analyzed_count} users analyzed, "
            f"{suggestions_count} suggestions generated"
        )

    async def analyze_user(self, user_id, db: AsyncSession):
        """
        Analyze storage for a single user (for manual triggering)

        Args:
            user_id: User ID to analyze
            db: Database session

        Returns:
            Tuple of (StorageAnalysis, List[OptimizationSuggestion])
        """
        logger.info(f"Running storage optimization for user {user_id}")

        try:
            # Analyze user storage
            analysis = await storage_analyzer.analyze_user_storage(
                user_id=user_id,
                db=db
            )

            if not analysis:
                logger.error(f"Failed to analyze storage for user {user_id}")
                return None, []

            # Save analysis
            db.add(analysis)
            await db.flush()

            # Generate suggestions
            suggestions = await storage_optimizer.generate_suggestions(
                analysis=analysis,
                db=db
            )

            # Save suggestions
            for suggestion in suggestions:
                db.add(suggestion)

            await db.commit()

            logger.info(
                f"Storage optimization complete for user {user_id}: "
                f"{len(suggestions)} suggestions generated"
            )

            # Update metrics
            metrics_collector.increment_counter('storage_analyses_completed_total')
            metrics_collector.increment_counter(
                'storage_optimization_suggestions_generated_total',
                len(suggestions)
            )

            return analysis, suggestions

        except Exception as e:
            logger.error(f"Failed to optimize storage for user {user_id}: {e}", exc_info=True)
            await db.rollback()
            return None, []

    async def run_once(self):
        """
        Run the worker once (for manual triggering or testing)
        """
        logger.info("Running storage optimization worker once")

        async for db in get_db_session():
            try:
                await self._analyze_all_users(db)
                await db.commit()
                logger.info("Storage optimization worker run completed")
            except Exception as e:
                logger.error(f"Error in storage optimization worker run: {e}", exc_info=True)
                await db.rollback()
                raise
            finally:
                break


# Singleton instance
storage_optimization_worker = StorageOptimizationWorker()
