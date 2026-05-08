"""
Quota Prediction Service

ML-based quota prediction using time-series forecasting optimized for CPU.
Supports multiple algorithms with automatic fallback:
- Prophet (Facebook's time-series library)
- Linear Regression (scikit-learn)
- Moving Average (simple but reliable)
- Exponential Smoothing (statsmodels)

Optimized for AMD Ryzen 9 7950X (16C/32T) with 128GB RAM.
"""

import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models.database import QuotaPrediction, StorageUsageHistory, User

logger = logging.getLogger(__name__)

# Configure for multi-core CPU
import os

os.environ["OMP_NUM_THREADS"] = "32"
os.environ["MKL_NUM_THREADS"] = "32"


class QuotaPredictorService:
    """
    ML-based quota prediction service

    Features:
    - Multi-algorithm approach (Prophet, Linear Regression, Moving Average)
    - Automatic fallback if insufficient data
    - Confidence scoring
    - CPU-optimized for batch processing
    """

    MIN_DATA_POINTS = 7  # Minimum days of history needed
    CONFIDENCE_THRESHOLD = 0.7  # Minimum confidence for predictions

    def __init__(self):
        self.models_available = self._check_available_models()

    def _check_available_models(self) -> Dict[str, bool]:
        """Check which ML libraries are available"""
        models = {
            "prophet": False,
            "linear_regression": False,
            "moving_average": True,  # Always available (numpy only)
        }

        try:
            # Prophet's plot module logs `Importing plotly failed` at ERROR
            # when plotly is missing. We don't use Prophet's plotting helpers,
            # so demote that one logger before the import.
            logging.getLogger("prophet.plot").setLevel(logging.CRITICAL)
            from prophet import Prophet

            Prophet()  # Verify CmdStan backend is installed, not just the Python package
            models["prophet"] = True
            logger.info("Prophet library available")
        except (ImportError, AttributeError, Exception) as e:
            logger.warning(f"Prophet not available (will use fallback methods): {e}")

        try:
            from sklearn.linear_model import LinearRegression

            models["linear_regression"] = True
            logger.info("sklearn available")
        except ImportError:
            logger.warning("sklearn not available")

        return models

    async def predict_user_quota(
        self, user_id: str, db: AsyncSession, force_model: Optional[str] = None
    ) -> Optional[Dict]:
        """
        Predict quota usage for a single user

        Args:
            user_id: User ID
            db: Database session
            force_model: Force specific model ('prophet', 'linear_regression', 'moving_average')

        Returns:
            Dict with predictions or None if insufficient data
        """
        # Get user info
        user_result = await db.execute(select(User).where(User.id == user_id))
        user = user_result.scalar_one_or_none()
        if not user:
            logger.error(f"User {user_id} not found")
            return None

        # Get usage history
        history_result = await db.execute(
            select(StorageUsageHistory)
            .where(StorageUsageHistory.user_id == user_id)
            .order_by(StorageUsageHistory.date)
        )
        history = history_result.scalars().all()

        if len(history) < self.MIN_DATA_POINTS:
            logger.info(
                f"Insufficient data for user {user_id}: "
                f"{len(history)} points (need {self.MIN_DATA_POINTS})"
            )
            return None

        # Convert to DataFrame
        df = pd.DataFrame([{"date": h.date, "storage_used": h.storage_used} for h in history])

        # Ensure date is datetime
        df["date"] = pd.to_datetime(df["date"])
        df = df.sort_values("date")

        # Try models in order of preference
        model_order = ["prophet", "linear_regression", "moving_average"]
        if force_model:
            model_order = [force_model] + [m for m in model_order if m != force_model]

        for model_type in model_order:
            if not self.models_available.get(model_type, False):
                continue

            try:
                prediction = await self._predict_with_model(df, user.storage_quota, model_type)
                if prediction:
                    prediction["user_id"] = str(user_id)
                    prediction["quota_bytes"] = user.storage_quota
                    prediction["current_usage_bytes"] = int(df["storage_used"].iloc[-1])
                    return prediction
            except Exception as e:
                logger.error(f"Model {model_type} failed for user {user_id}: {e}")
                continue

        logger.error(f"All models failed for user {user_id}")
        return None

    async def _predict_with_model(
        self, df: pd.DataFrame, quota: int, model_type: str
    ) -> Optional[Dict]:
        """
        Make prediction using specified model

        Args:
            df: DataFrame with 'date' and 'storage_used' columns
            quota: User's storage quota in bytes
            model_type: Model to use

        Returns:
            Dict with predictions or None on failure
        """
        if model_type == "prophet":
            return await self._predict_prophet(df, quota)
        elif model_type == "linear_regression":
            return self._predict_linear_regression(df, quota)
        elif model_type == "moving_average":
            return self._predict_moving_average(df, quota)
        else:
            logger.error(f"Unknown model type: {model_type}")
            return None

    async def _predict_prophet(self, df: pd.DataFrame, quota: int) -> Optional[Dict]:
        """Predict using Facebook Prophet (best for seasonal patterns)"""
        try:
            from prophet import Prophet

            # Prepare data for Prophet (needs 'ds' and 'y' columns)
            prophet_df = pd.DataFrame({"ds": df["date"], "y": df["storage_used"]})

            # Initialize and fit model
            model = Prophet(
                daily_seasonality=False,
                weekly_seasonality=True if len(df) >= 14 else False,
                yearly_seasonality=False,
                interval_width=0.80,  # 80% confidence intervals
            )

            # Suppress Prophet logging
            import logging as prophet_logging

            prophet_logging.getLogger("prophet").setLevel(prophet_logging.ERROR)

            model.fit(prophet_df)

            # Make predictions for 7, 14, 30 days
            future = model.make_future_dataframe(periods=30, freq="D")
            forecast = model.predict(future)

            # Extract predictions
            last_idx = len(prophet_df)
            pred_7d = forecast.iloc[last_idx + 6]["yhat"]
            pred_14d = forecast.iloc[last_idx + 13]["yhat"]
            pred_30d = forecast.iloc[last_idx + 29]["yhat"]

            # Calculate confidence (based on prediction intervals)
            conf_7d = self._calculate_confidence(
                forecast.iloc[last_idx + 6], prophet_df["y"].values
            )
            conf_14d = self._calculate_confidence(
                forecast.iloc[last_idx + 13], prophet_df["y"].values
            )
            conf_30d = self._calculate_confidence(
                forecast.iloc[last_idx + 29], prophet_df["y"].values
            )

            # Calculate days until quota exceeded
            days_until_full = self._calculate_days_until_full(forecast[last_idx:], quota)

            return {
                "predicted_7d": max(0, int(pred_7d)),
                "predicted_14d": max(0, int(pred_14d)),
                "predicted_30d": max(0, int(pred_30d)),
                "confidence_7d": conf_7d,
                "confidence_14d": conf_14d,
                "confidence_30d": conf_30d,
                "days_until_full": days_until_full,
                "model_type": "prophet",
            }

        except Exception as e:
            logger.error(f"Prophet prediction failed: {e}")
            return None

    def _predict_linear_regression(self, df: pd.DataFrame, quota: int) -> Optional[Dict]:
        """Predict using Linear Regression (good for linear growth)"""
        try:
            from sklearn.linear_model import LinearRegression
            from sklearn.metrics import r2_score

            # Prepare data
            X = np.arange(len(df)).reshape(-1, 1)  # Days as feature
            y = df["storage_used"].values

            # Fit model
            model = LinearRegression()
            model.fit(X, y)

            # Make predictions
            future_X_7d = np.array([[len(df) + 6]])
            future_X_14d = np.array([[len(df) + 13]])
            future_X_30d = np.array([[len(df) + 29]])

            pred_7d = model.predict(future_X_7d)[0]
            pred_14d = model.predict(future_X_14d)[0]
            pred_30d = model.predict(future_X_30d)[0]

            # Calculate confidence (R² score)
            r2 = r2_score(y, model.predict(X))
            base_confidence = max(0.0, min(1.0, r2))

            # Decrease confidence for longer predictions
            conf_7d = base_confidence * 0.95
            conf_14d = base_confidence * 0.85
            conf_30d = base_confidence * 0.75

            # Calculate days until quota exceeded
            if model.coef_[0] > 0:  # Growth trend
                current_usage = y[-1]
                days_until_full = int((quota - current_usage) / model.coef_[0])
                days_until_full = max(0, days_until_full)
            else:
                days_until_full = None  # No growth or declining

            return {
                "predicted_7d": max(0, int(pred_7d)),
                "predicted_14d": max(0, int(pred_14d)),
                "predicted_30d": max(0, int(pred_30d)),
                "confidence_7d": conf_7d,
                "confidence_14d": conf_14d,
                "confidence_30d": conf_30d,
                "days_until_full": days_until_full,
                "model_type": "linear_regression",
            }

        except Exception as e:
            logger.error(f"Linear regression prediction failed: {e}")
            return None

    def _predict_moving_average(self, df: pd.DataFrame, quota: int) -> Dict:
        """
        Predict using Moving Average (simple but reliable fallback)

        This always succeeds and provides conservative estimates.
        """
        # Calculate growth rate from moving average
        window = min(7, len(df))  # Use last 7 days or all available
        recent_data = df["storage_used"].values[-window:]

        # Calculate daily growth
        if len(recent_data) > 1:
            growth_per_day = (recent_data[-1] - recent_data[0]) / (len(recent_data) - 1)
        else:
            growth_per_day = 0

        current_usage = recent_data[-1]

        # Make predictions
        pred_7d = current_usage + (growth_per_day * 7)
        pred_14d = current_usage + (growth_per_day * 14)
        pred_30d = current_usage + (growth_per_day * 30)

        # Calculate confidence (based on variance)
        if len(recent_data) > 1:
            variance = np.var(recent_data)
            # Lower variance = higher confidence
            normalized_variance = variance / (current_usage + 1)
            base_confidence = max(0.3, min(0.8, 1.0 - normalized_variance))
        else:
            base_confidence = 0.5

        conf_7d = base_confidence * 0.9
        conf_14d = base_confidence * 0.75
        conf_30d = base_confidence * 0.6

        # Calculate days until quota exceeded
        if growth_per_day > 0:
            days_until_full = int((quota - current_usage) / growth_per_day)
            days_until_full = max(0, days_until_full)
        else:
            days_until_full = None

        return {
            "predicted_7d": max(0, int(pred_7d)),
            "predicted_14d": max(0, int(pred_14d)),
            "predicted_30d": max(0, int(pred_30d)),
            "confidence_7d": conf_7d,
            "confidence_14d": conf_14d,
            "confidence_30d": conf_30d,
            "days_until_full": days_until_full,
            "model_type": "moving_average",
        }

    def _calculate_confidence(self, forecast_row: pd.Series, historical_data: np.ndarray) -> float:
        """
        Calculate confidence score based on prediction intervals

        Args:
            forecast_row: Row from Prophet forecast with yhat_lower, yhat_upper
            historical_data: Historical actual values

        Returns:
            Confidence score (0.0 to 1.0)
        """
        # Width of prediction interval
        interval_width = forecast_row["yhat_upper"] - forecast_row["yhat_lower"]

        # Normalize by mean of historical data
        historical_mean = np.mean(historical_data)
        if historical_mean > 0:
            normalized_width = interval_width / historical_mean
        else:
            normalized_width = 1.0

        # Convert to confidence (narrower interval = higher confidence)
        confidence = max(0.0, min(1.0, 1.0 - (normalized_width / 2.0)))

        return confidence

    def _calculate_days_until_full(self, forecast: pd.DataFrame, quota: int) -> Optional[int]:
        """
        Calculate days until quota is exceeded

        Args:
            forecast: Prophet forecast DataFrame
            quota: Storage quota in bytes

        Returns:
            Days until full, or None if won't exceed
        """
        # Find first day where yhat exceeds quota
        for idx, row in forecast.iterrows():
            if row["yhat"] >= quota:
                # Calculate relative day
                first_date = forecast.iloc[0]["ds"]
                exceed_date = row["ds"]
                days = (exceed_date - first_date).days
                return max(0, days)

        # Won't exceed in forecast period
        return None

    async def batch_predict_all_users(
        self, db: AsyncSession, limit: Optional[int] = None
    ) -> List[Dict]:
        """
        Batch predict for all users (optimized for multi-core CPU)

        Args:
            db: Database session
            limit: Optional limit on number of users

        Returns:
            List of prediction results
        """
        # Get all active users
        query = select(User).where(User.is_active == True)
        if limit:
            query = query.limit(limit)

        result = await db.execute(query)
        users = result.scalars().all()

        logger.info(f"Batch predicting quota for {len(users)} users")

        predictions = []
        for user in users:
            try:
                prediction = await self.predict_user_quota(str(user.id), db)
                if prediction:
                    predictions.append(prediction)
            except Exception as e:
                logger.error(f"Failed to predict for user {user.id}: {e}")
                continue

        logger.info(f"Successfully generated {len(predictions)} predictions")
        return predictions


# Singleton instance
quota_predictor = QuotaPredictorService()
