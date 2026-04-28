# services/storage-service/app/services/access_predictor.py

"""
Access Pattern Predictor

Uses Markov chains and basic ML to predict which files a user will access next.
Enables predictive prefetching from cold storage to warm storage.
"""

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


class AccessPredictor:
    """
    Predicts next file access based on historical patterns

    Algorithms:
    1. Markov Chain - Based on file access sequences
    2. Time Pattern - Files accessed at similar times
    3. Collaborative Filtering - Similar users' patterns
    """

    def __init__(self):
        self.min_confidence = 0.3  # Minimum prediction confidence (30%)
        self.max_predictions = 5  # Max files to predict per user
        self.sequence_lookback_days = 30  # How far back to analyze

    async def record_file_access(
        self,
        db: AsyncSession,
        user_id: str,
        file_id: str,
        access_type: str = "view",
        session_id: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ):
        """
        Record a file access event

        This builds the training data for predictions
        """
        try:
            await db.execute(
                text("""
                INSERT INTO file_access_log
                    (user_id, file_id, access_type, session_id, access_duration_ms, accessed_at)
                VALUES
                    (:user_id, :file_id, :access_type, :session_id, :duration_ms, NOW())
            """),
                {
                    "user_id": user_id,
                    "file_id": file_id,
                    "access_type": access_type,
                    "session_id": session_id,
                    "duration_ms": duration_ms,
                },
            )

            # Update access sequences (Markov chain)
            await self._update_access_sequence(db, user_id, file_id, session_id)

            await db.commit()

        except Exception as e:
            logger.error(f"Failed to record file access: {e}")
            await db.rollback()

    async def _update_access_sequence(
        self, db: AsyncSession, user_id: str, current_file_id: str, session_id: Optional[str]
    ):
        """
        Update Markov chain sequences

        Records: "user accessed file A, then accessed file B"
        """
        if not session_id:
            return

        # Get previous file in this session
        result = await db.execute(
            text("""
            SELECT file_id
            FROM file_access_log
            WHERE user_id = :user_id
              AND session_id = :session_id
              AND file_id != :current_file
            ORDER BY accessed_at DESC
            LIMIT 1
        """),
            {"user_id": user_id, "session_id": session_id, "current_file": current_file_id},
        )

        previous_file = result.scalar_one_or_none()

        if not previous_file:
            return

        # Insert or update sequence
        await db.execute(
            text("""
            INSERT INTO file_access_sequences
                (user_id, file_from, file_to, sequence_count, last_seen)
            VALUES
                (:user_id, :file_from, :file_to, 1, NOW())
            ON CONFLICT (user_id, file_from, file_to)
            DO UPDATE SET
                sequence_count = file_access_sequences.sequence_count + 1,
                last_seen = NOW()
        """),
            {"user_id": user_id, "file_from": previous_file, "file_to": current_file_id},
        )

    async def predict_next_files(
        self,
        db: AsyncSession,
        user_id: str,
        current_file_id: Optional[str] = None,
        method: str = "markov",
    ) -> List[Dict]:
        """
        Predict which files user will access next

        Args:
            db: Database session
            user_id: User ID
            current_file_id: Currently accessed file (optional)
            method: Prediction method ('markov', 'time_pattern', 'hybrid')

        Returns:
            List of predicted files with confidence scores
        """
        if method == "markov":
            return await self._predict_markov(db, user_id, current_file_id)
        elif method == "time_pattern":
            return await self._predict_time_pattern(db, user_id)
        elif method == "hybrid":
            # Combine multiple methods
            markov_preds = await self._predict_markov(db, user_id, current_file_id)
            time_preds = await self._predict_time_pattern(db, user_id)
            return self._combine_predictions(markov_preds, time_preds)
        else:
            return []

    async def _predict_markov(
        self, db: AsyncSession, user_id: str, current_file_id: Optional[str]
    ) -> List[Dict]:
        """
        Predict using Markov chain (what file is usually accessed after current file)
        """
        if not current_file_id:
            # No current file - predict most frequently accessed files
            result = await db.execute(
                text("""
                SELECT
                    file_id,
                    COUNT(*) as access_count
                FROM file_access_log
                WHERE user_id = :user_id
                  AND accessed_at > NOW() - INTERVAL '30 days'
                GROUP BY file_id
                ORDER BY access_count DESC
                LIMIT :max_predictions
            """),
                {"user_id": user_id, "max_predictions": self.max_predictions},
            )

            predictions = [
                {
                    "file_id": str(row.file_id),
                    "confidence": min(0.9, row.access_count / 100.0),
                    "method": "frequency",
                    "reason": f"Accessed {row.access_count} times in last 30 days",
                }
                for row in result.fetchall()
            ]

            return predictions

        # Predict based on access sequences
        result = await db.execute(
            text("""
            SELECT
                fas.file_to,
                fas.sequence_count,
                fas.probability,
                o.file_name
            FROM file_access_sequences fas
            JOIN objects o ON o.id = fas.file_to
            WHERE fas.user_id = :user_id
              AND fas.file_from = :current_file
              AND fas.probability >= :min_confidence
            ORDER BY fas.probability DESC
            LIMIT :max_predictions
        """),
            {
                "user_id": user_id,
                "current_file": current_file_id,
                "min_confidence": self.min_confidence,
                "max_predictions": self.max_predictions,
            },
        )

        predictions = [
            {
                "file_id": str(row.file_to),
                "file_name": row.file_name,
                "confidence": float(row.probability or 0),
                "method": "markov",
                "reason": f"Accessed after current file {row.sequence_count} times",
            }
            for row in result.fetchall()
        ]

        return predictions

    async def _predict_time_pattern(self, db: AsyncSession, user_id: str) -> List[Dict]:
        """
        Predict based on time patterns (files accessed at similar time of day/week)
        """
        # Get current hour and day of week
        result = await db.execute(
            text("""
            WITH current_time AS (
                SELECT
                    EXTRACT(HOUR FROM NOW()) as current_hour,
                    EXTRACT(DOW FROM NOW()) as current_dow
            ),
            similar_access AS (
                SELECT
                    fal.file_id,
                    COUNT(*) as pattern_count,
                    o.file_name
                FROM file_access_log fal
                JOIN objects o ON o.id = fal.file_id
                CROSS JOIN current_time ct
                WHERE fal.user_id = :user_id
                  AND fal.accessed_at > NOW() - INTERVAL '90 days'
                  AND EXTRACT(HOUR FROM fal.accessed_at) BETWEEN ct.current_hour - 1 AND ct.current_hour + 1
                  AND EXTRACT(DOW FROM fal.accessed_at) = ct.current_dow
                GROUP BY fal.file_id, o.file_name
                ORDER BY pattern_count DESC
                LIMIT :max_predictions
            )
            SELECT
                file_id,
                file_name,
                pattern_count,
                pattern_count::float / GREATEST(1, (
                    SELECT COUNT(*)
                    FROM file_access_log fal2
                    WHERE fal2.user_id = :user_id
                )) as confidence
            FROM similar_access
        """),
            {"user_id": user_id, "max_predictions": self.max_predictions},
        )

        predictions = [
            {
                "file_id": str(row.file_id),
                "file_name": row.file_name,
                "confidence": float(row.confidence),
                "method": "time_pattern",
                "reason": f"Accessed {row.pattern_count} times at similar time",
            }
            for row in result.fetchall()
            if row.confidence >= self.min_confidence
        ]

        return predictions

    def _combine_predictions(self, markov_preds: List[Dict], time_preds: List[Dict]) -> List[Dict]:
        """
        Combine predictions from multiple methods

        Uses weighted average of confidence scores
        """
        combined = defaultdict(lambda: {"confidence": 0, "methods": []})

        # Weight Markov predictions higher (0.7)
        for pred in markov_preds:
            file_id = pred["file_id"]
            combined[file_id]["file_id"] = file_id
            combined[file_id]["file_name"] = pred.get("file_name", "")
            combined[file_id]["confidence"] += pred["confidence"] * 0.7
            combined[file_id]["methods"].append("markov")

        # Time pattern predictions (0.3)
        for pred in time_preds:
            file_id = pred["file_id"]
            combined[file_id]["file_id"] = file_id
            combined[file_id]["file_name"] = pred.get("file_name", "")
            combined[file_id]["confidence"] += pred["confidence"] * 0.3
            combined[file_id]["methods"].append("time_pattern")

        # Sort by confidence and return top predictions
        result = sorted(combined.values(), key=lambda x: x["confidence"], reverse=True)[
            : self.max_predictions
        ]

        for pred in result:
            pred["method"] = "hybrid"
            pred["reason"] = f"Combined from {', '.join(pred['methods'])}"

        return result

    async def update_probabilities(self, db: AsyncSession):
        """
        Recalculate Markov chain probabilities

        Should be run periodically (e.g., hourly)
        """
        try:
            logger.info("Updating access sequence probabilities...")

            await db.execute(text("""
                SELECT update_access_sequence_probabilities()
            """))

            await db.commit()

            logger.info("Access sequence probabilities updated successfully")

        except Exception as e:
            logger.error(f"Failed to update probabilities: {e}")
            await db.rollback()


# Singleton instance
access_predictor = AccessPredictor()
