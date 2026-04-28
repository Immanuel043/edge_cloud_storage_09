# services/storage-service/app/monitoring/metrics.py
import asyncio
from datetime import datetime

import psutil
from prometheus_client import Counter, Gauge, Histogram, Info
from prometheus_fastapi_instrumentator import Instrumentator

# Business Metrics
upload_initiated = Counter(
    "storage_upload_initiated_total",
    "Total number of uploads initiated",
    ["plan_type", "storage_strategy"],
)

upload_completed = Counter(
    "storage_upload_completed_total",
    "Total number of uploads completed",
    ["plan_type", "storage_strategy", "status"],
)

upload_duration = Histogram(
    "storage_upload_duration_seconds",
    "Upload duration in seconds",
    ["storage_strategy"],
    buckets=(0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300),
)

active_uploads = Gauge("storage_active_uploads", "Number of currently active uploads")

storage_used_bytes = Gauge(
    "storage_used_bytes_total", "Total storage used in bytes", ["storage_tier"]
)

chunk_processing_duration = Histogram(
    "storage_chunk_processing_seconds",
    "Time to process a single chunk",
    buckets=(0.01, 0.05, 0.1, 0.5, 1, 2, 5),
)

# System Metrics
system_info = Info("storage_system", "System information")
cpu_usage = Gauge("storage_cpu_usage_percent", "CPU usage percentage")
memory_usage = Gauge("storage_memory_usage_bytes", "Memory usage in bytes")
disk_io_read = Counter("storage_disk_read_bytes_total", "Total disk read bytes")
disk_io_write = Counter("storage_disk_write_bytes_total", "Total disk write bytes")
db_connections_active = Gauge("storage_db_connections_active", "Active database connections")
redis_connections = Gauge("storage_redis_connections", "Active Redis connections")

# Error tracking
errors_total = Counter("storage_errors_total", "Total number of errors", ["error_type", "endpoint"])

# Virus scanner outcomes. `outcome` is one of clean|infected|bypassed.
# `plan_tier` is free|paid so we can alert on paid-tier bypasses specifically.
virus_scan_outcomes = Counter(
    "storage_virus_scan_outcomes_total",
    "Virus scan outcomes by result and plan tier",
    ["outcome", "plan_tier"],
)

# How often paid-tier files got quarantined because ClamAV was unavailable.
# Alert on any non-zero rate of this.
virus_scan_quarantine_on_bypass = Counter(
    "storage_virus_scan_quarantine_on_bypass_total",
    "Paid-tier files quarantined because the virus scanner was unavailable",
    ["plan_tier"],
)

# URL Upload Metrics
url_upload_initiated = Counter(
    "storage_url_upload_initiated_total", "Total number of URL uploads initiated", ["plan_type"]
)

url_upload_completed = Counter(
    "storage_url_upload_completed_total",
    "Total number of URL uploads completed",
    ["plan_type", "status"],
)

url_upload_failed = Counter(
    "storage_url_upload_failed_total",
    "Total number of URL uploads failed",
    ["plan_type", "failure_reason"],
)

url_upload_duration = Histogram(
    "storage_url_upload_duration_seconds",
    "URL upload duration in seconds",
    buckets=(1, 5, 10, 30, 60, 120, 300, 600),
)

url_download_bytes = Counter(
    "storage_url_download_bytes_total", "Total bytes downloaded from URLs", ["plan_type"]
)

url_upload_active = Gauge("storage_url_upload_active", "Number of currently active URL uploads")

# Folder Upload Metrics
folder_upload_initiated = Counter(
    "storage_folder_upload_initiated_total",
    "Total number of folder uploads initiated",
    ["plan_type"],
)

folder_upload_completed = Counter(
    "storage_folder_upload_completed_total",
    "Total number of folder uploads completed",
    ["plan_type", "status"],
)

folder_files_uploaded = Counter(
    "storage_folder_files_uploaded_total", "Total files uploaded in folder uploads", ["plan_type"]
)

folder_upload_active = Gauge(
    "storage_folder_upload_active", "Number of currently active folder upload sessions"
)

# ML Features - Quota Prediction Metrics
quota_prediction_worker_cycles_total = Counter(
    "storage_quota_prediction_worker_cycles_total",
    "Total number of quota prediction worker cycles completed",
)

quota_prediction_worker_errors_total = Counter(
    "storage_quota_prediction_worker_errors_total", "Total number of quota prediction worker errors"
)

quota_usage_history_recorded_total = Counter(
    "storage_quota_usage_history_recorded_total", "Total number of usage history records created"
)

quota_predictions_generated_total = Counter(
    "storage_quota_predictions_generated_total", "Total number of quota predictions generated"
)

quota_alerts_generated_total = Counter(
    "storage_quota_alerts_generated_total", "Total number of quota alerts generated"
)

quota_alerts_dismissed_total = Counter(
    "storage_quota_alerts_dismissed_total", "Total number of quota alerts dismissed"
)

quota_prediction_cache_hits_total = Counter(
    "storage_quota_prediction_cache_hits_total", "Total number of quota prediction cache hits"
)

quota_prediction_cache_misses_total = Counter(
    "storage_quota_prediction_cache_misses_total", "Total number of quota prediction cache misses"
)

quota_predictions_api_generated_total = Counter(
    "storage_quota_predictions_api_generated_total",
    "Total number of quota predictions generated via API",
)

quota_prediction_worker_manual_triggers_total = Counter(
    "storage_quota_prediction_worker_manual_triggers_total",
    "Total number of manual quota prediction worker triggers",
)

quota_prediction_model_usage = Counter(
    "storage_quota_prediction_model_usage_total",
    "Total predictions by model type",
    ["model_type"],  # prophet, linear_regression, moving_average
)

quota_prediction_confidence = Histogram(
    "storage_quota_prediction_confidence_score",
    "Confidence scores for quota predictions",
    ["prediction_period"],  # 7d, 14d, 30d
    buckets=(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0),
)

quota_prediction_duration_ms = Histogram(
    "storage_quota_prediction_duration_ms",
    "Quota prediction computation duration in milliseconds",
    buckets=(50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000),
)

quota_days_until_full = Gauge(
    "storage_quota_days_until_full", "Predicted days until storage quota is full", ["user_id"]
)

# ML Features - Storage Optimization Metrics
storage_optimization_worker_cycles_total = Counter(
    "storage_optimization_worker_cycles_total",
    "Total number of storage optimization worker cycles completed",
)

storage_optimization_worker_errors_total = Counter(
    "storage_optimization_worker_errors_total", "Total number of storage optimization worker errors"
)

storage_analyses_completed_total = Counter(
    "storage_analyses_completed_total", "Total number of storage analyses completed"
)

storage_analysis_cache_hits_total = Counter(
    "storage_analysis_cache_hits_total", "Total number of storage analysis cache hits"
)

storage_analysis_cache_misses_total = Counter(
    "storage_analysis_cache_misses_total", "Total number of storage analysis cache misses"
)

storage_optimization_suggestions_generated_total = Counter(
    "storage_optimization_suggestions_generated_total",
    "Total number of optimization suggestions generated",
)

storage_optimization_suggestions_dismissed_total = Counter(
    "storage_optimization_suggestions_dismissed_total",
    "Total number of optimization suggestions dismissed",
)

storage_optimization_suggestions_applied_total = Counter(
    "storage_optimization_suggestions_applied_total",
    "Total number of optimization suggestions applied",
)

storage_optimization_manual_triggers_total = Counter(
    "storage_optimization_manual_triggers_total",
    "Total number of manual storage optimization triggers",
)

storage_optimization_worker_manual_triggers_total = Counter(
    "storage_optimization_worker_manual_triggers_total",
    "Total number of manual storage optimization worker triggers",
)

storage_potential_savings_bytes = Gauge(
    "storage_potential_savings_bytes", "Potential storage savings in bytes", ["user_id"]
)

storage_optimization_analysis_duration_ms = Histogram(
    "storage_optimization_analysis_duration_ms",
    "Storage analysis duration in milliseconds",
    buckets=(100, 250, 500, 1000, 2500, 5000, 10000, 30000),
)

# ML Features - Auto-Organization Metrics
organization_sessions_started_total = Counter(
    "organization_sessions_started_total", "Total number of organization sessions started"
)

organization_sessions_completed_total = Counter(
    "organization_sessions_completed_total", "Total number of organization sessions completed"
)

organization_sessions_failed_total = Counter(
    "organization_sessions_failed_total", "Total number of organization sessions failed"
)

organization_clusters_created_total = Counter(
    "organization_clusters_created_total", "Total number of organization clusters created"
)

organization_clusters_applied_total = Counter(
    "organization_clusters_applied_total", "Total number of organization clusters applied"
)

organization_clusters_dismissed_total = Counter(
    "organization_clusters_dismissed_total", "Total number of organization clusters dismissed"
)

organization_files_moved_total = Counter(
    "organization_files_moved_total", "Total number of files moved by organization"
)

organization_rules_created_total = Counter(
    "organization_rules_created_total", "Total number of organization rules created"
)

organization_rules_applied_total = Counter(
    "organization_rules_applied_total", "Total number of organization rules applied"
)

organization_rules_updated_total = Counter(
    "organization_rules_updated_total", "Total number of organization rules updated"
)

organization_rules_deleted_total = Counter(
    "organization_rules_deleted_total", "Total number of organization rules deleted"
)

organization_clustering_duration_ms = Histogram(
    "organization_clustering_duration_ms",
    "Clustering duration in milliseconds",
    buckets=(100, 500, 1000, 2000, 5000, 10000, 30000, 60000),
)

organization_silhouette_score = Histogram(
    "organization_silhouette_score",
    "Silhouette score for clustering quality",
    ["algorithm"],  # kmeans, dbscan
    buckets=(0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0),
)

organization_cluster_size = Histogram(
    "organization_cluster_size",
    "Number of files per cluster",
    buckets=(1, 5, 10, 20, 50, 100, 200, 500, 1000),
)

# ML Features - Content Recommendations Metrics
recommendation_cache_hits_total = Counter(
    "recommendation_cache_hits_total", "Total number of recommendation cache hits"
)

recommendation_cache_misses_total = Counter(
    "recommendation_cache_misses_total", "Total number of recommendation cache misses"
)

recommendations_generated_total = Counter(
    "recommendations_generated_total",
    "Total number of recommendations generated",
    ["algorithm"],  # hybrid, content, collaborative, trending
)

recommendations_dismissed_total = Counter(
    "recommendations_dismissed_total", "Total number of recommendations dismissed"
)

recommendation_feedback_submitted_total = Counter(
    "recommendation_feedback_submitted_total",
    "Total number of recommendation feedback submissions",
    ["feedback_type"],  # positive, negative, irrelevant
)

recommendation_feedback_errors_total = Counter(
    "recommendation_feedback_errors_total", "Total number of recommendation feedback errors"
)

recommendation_generation_errors_total = Counter(
    "recommendation_generation_errors_total", "Total number of recommendation generation errors"
)

user_interactions_tracked_total = Counter(
    "user_interactions_tracked_total",
    "Total number of user interactions tracked",
    ["interaction_type"],  # view, download, share, favorite, tag
)

user_interaction_tracking_errors_total = Counter(
    "user_interaction_tracking_errors_total", "Total number of user interaction tracking errors"
)

content_similarity_computations_total = Counter(
    "content_similarity_computations_total", "Total number of content similarity computations"
)

content_similarity_batch_computations_total = Counter(
    "content_similarity_batch_computations_total",
    "Total number of batch content similarity computations",
)

content_similarity_cache_hits_total = Counter(
    "content_similarity_cache_hits_total", "Total number of content similarity cache hits"
)

content_similarity_cache_misses_total = Counter(
    "content_similarity_cache_misses_total", "Total number of content similarity cache misses"
)

content_similarity_errors_total = Counter(
    "content_similarity_errors_total", "Total number of content similarity errors"
)

content_similarity_batch_errors_total = Counter(
    "content_similarity_batch_errors_total", "Total number of batch content similarity errors"
)

collaborative_user_recommendations_generated_total = Counter(
    "collaborative_user_recommendations_generated_total",
    "Total number of user-based collaborative recommendations generated",
)

collaborative_item_recommendations_generated_total = Counter(
    "collaborative_item_recommendations_generated_total",
    "Total number of item-based collaborative recommendations generated",
)

collaborative_filtering_errors_total = Counter(
    "collaborative_filtering_errors_total", "Total number of collaborative filtering errors"
)

trending_files_computed_total = Counter(
    "trending_files_computed_total", "Total number of trending files computations"
)

trending_computation_errors_total = Counter(
    "trending_computation_errors_total", "Total number of trending computation errors"
)

batch_recommendation_jobs_completed_total = Counter(
    "batch_recommendation_jobs_completed_total",
    "Total number of batch recommendation jobs completed",
)

batch_recommendation_jobs_failed_total = Counter(
    "batch_recommendation_jobs_failed_total", "Total number of batch recommendation jobs failed"
)

recommendation_generation_duration_ms = Histogram(
    "recommendation_generation_duration_ms",
    "Recommendation generation duration in milliseconds",
    buckets=(50, 100, 250, 500, 1000, 2500, 5000, 10000),
)

content_similarity_duration_ms = Histogram(
    "content_similarity_duration_ms",
    "Content similarity computation duration in milliseconds",
    buckets=(50, 100, 250, 500, 1000, 2500, 5000, 10000),
)

content_similarity_batch_duration_ms = Histogram(
    "content_similarity_batch_duration_ms",
    "Batch content similarity computation duration in milliseconds",
    buckets=(1000, 5000, 10000, 30000, 60000, 120000, 300000),
)

collaborative_filtering_duration_ms = Histogram(
    "collaborative_filtering_duration_ms",
    "Collaborative filtering duration in milliseconds",
    buckets=(50, 100, 250, 500, 1000, 2500, 5000, 10000),
)

trending_computation_duration_ms = Histogram(
    "trending_computation_duration_ms",
    "Trending computation duration in milliseconds",
    buckets=(50, 100, 250, 500, 1000, 2500, 5000),
)

recommendation_score_distribution = Histogram(
    "recommendation_score_distribution",
    "Distribution of recommendation scores",
    ["algorithm"],
    buckets=(0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0),
)

file_similarity_score_distribution = Histogram(
    "file_similarity_score_distribution",
    "Distribution of file similarity scores",
    buckets=(0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0),
)


class MetricsCollector:
    def __init__(self):
        self.instrumentator = Instrumentator(
            should_group_status_codes=False,
            should_ignore_untemplated=True,
            should_instrument_requests_inprogress=True,
            excluded_handlers=["/metrics", "/health"],
            inprogress_name="storage_requests_inprogress",
            inprogress_labels=True,
        )
        self._last_disk_io = None

    def instrument_app(self, app):
        """Add automatic instrumentation to FastAPI app"""
        self.instrumentator.instrument(app).expose(app, endpoint="/metrics")

        # Add custom metrics endpoint
        @app.on_event("startup")
        async def startup_metrics():
            asyncio.create_task(self.collect_system_metrics())
            system_info.info(
                {
                    "version": "1.0.0",
                    "python_version": "3.11",
                    "started_at": datetime.utcnow().isoformat(),
                }
            )

    async def collect_system_metrics(self):
        """Collect system metrics every 10 seconds"""
        while True:
            try:
                # CPU and Memory
                cpu_usage.set(psutil.cpu_percent(interval=1))
                memory = psutil.virtual_memory()
                memory_usage.set(memory.used)

                # Disk I/O
                disk_io = psutil.disk_io_counters()
                if self._last_disk_io:
                    disk_io_read.inc(disk_io.read_bytes - self._last_disk_io.read_bytes)
                    disk_io_write.inc(disk_io.write_bytes - self._last_disk_io.write_bytes)
                self._last_disk_io = disk_io

                # Database connections (from your pool)
                from ..database import engine

                db_connections_active.set(engine.pool.size())

                await asyncio.sleep(10)
            except Exception as e:
                print(f"Error collecting metrics: {e}")
                await asyncio.sleep(10)

    def increment_counter(self, metric_name: str, value: float = 1, **labels):
        """Helper method to increment a counter metric"""
        metric_map = {
            # Quota prediction metrics
            "quota_prediction_worker_cycles_total": quota_prediction_worker_cycles_total,
            "quota_prediction_worker_errors_total": quota_prediction_worker_errors_total,
            "quota_usage_history_recorded_total": quota_usage_history_recorded_total,
            "quota_predictions_generated_total": quota_predictions_generated_total,
            "quota_alerts_generated_total": quota_alerts_generated_total,
            "quota_alerts_dismissed_total": quota_alerts_dismissed_total,
            "quota_prediction_cache_hits_total": quota_prediction_cache_hits_total,
            "quota_prediction_cache_misses_total": quota_prediction_cache_misses_total,
            "quota_predictions_api_generated_total": quota_predictions_api_generated_total,
            "quota_prediction_worker_manual_triggers_total": quota_prediction_worker_manual_triggers_total,
            # Storage optimization metrics
            "storage_optimization_worker_cycles_total": storage_optimization_worker_cycles_total,
            "storage_optimization_worker_errors_total": storage_optimization_worker_errors_total,
            "storage_analyses_completed_total": storage_analyses_completed_total,
            "storage_analysis_cache_hits_total": storage_analysis_cache_hits_total,
            "storage_analysis_cache_misses_total": storage_analysis_cache_misses_total,
            "storage_optimization_suggestions_generated_total": storage_optimization_suggestions_generated_total,
            "storage_optimization_suggestions_dismissed_total": storage_optimization_suggestions_dismissed_total,
            "storage_optimization_suggestions_applied_total": storage_optimization_suggestions_applied_total,
            "storage_optimization_manual_triggers_total": storage_optimization_manual_triggers_total,
            "storage_optimization_worker_manual_triggers_total": storage_optimization_worker_manual_triggers_total,
            # Auto-organization metrics
            "organization_sessions_started_total": organization_sessions_started_total,
            "organization_sessions_completed_total": organization_sessions_completed_total,
            "organization_sessions_failed_total": organization_sessions_failed_total,
            "organization_clusters_created_total": organization_clusters_created_total,
            "organization_clusters_applied_total": organization_clusters_applied_total,
            "organization_clusters_dismissed_total": organization_clusters_dismissed_total,
            "organization_files_moved_total": organization_files_moved_total,
            "organization_rules_created_total": organization_rules_created_total,
            "organization_rules_applied_total": organization_rules_applied_total,
            "organization_rules_updated_total": organization_rules_updated_total,
            "organization_rules_deleted_total": organization_rules_deleted_total,
            # Content recommendations metrics
            "recommendation_cache_hits_total": recommendation_cache_hits_total,
            "recommendation_cache_misses_total": recommendation_cache_misses_total,
            "recommendations_generated_total": recommendations_generated_total,
            "recommendations_dismissed_total": recommendations_dismissed_total,
            "recommendation_feedback_submitted_total": recommendation_feedback_submitted_total,
            "recommendation_feedback_errors_total": recommendation_feedback_errors_total,
            "recommendation_generation_errors_total": recommendation_generation_errors_total,
            "user_interactions_tracked_total": user_interactions_tracked_total,
            "user_interaction_tracking_errors_total": user_interaction_tracking_errors_total,
            "content_similarity_computations_total": content_similarity_computations_total,
            "content_similarity_batch_computations_total": content_similarity_batch_computations_total,
            "content_similarity_cache_hits_total": content_similarity_cache_hits_total,
            "content_similarity_cache_misses_total": content_similarity_cache_misses_total,
            "content_similarity_errors_total": content_similarity_errors_total,
            "content_similarity_batch_errors_total": content_similarity_batch_errors_total,
            "collaborative_user_recommendations_generated_total": collaborative_user_recommendations_generated_total,
            "collaborative_item_recommendations_generated_total": collaborative_item_recommendations_generated_total,
            "collaborative_filtering_errors_total": collaborative_filtering_errors_total,
            "trending_files_computed_total": trending_files_computed_total,
            "trending_computation_errors_total": trending_computation_errors_total,
            "batch_recommendation_jobs_completed_total": batch_recommendation_jobs_completed_total,
            "batch_recommendation_jobs_failed_total": batch_recommendation_jobs_failed_total,
        }

        metric = metric_map.get(metric_name)
        if metric:
            if labels:
                metric.labels(**labels).inc(value)
            else:
                metric.inc(value)

    def observe_histogram(self, metric_name: str, value: float, **labels):
        """Helper method to observe a histogram metric"""
        histogram_map = {
            # Quota prediction histograms
            "quota_prediction_duration_ms": quota_prediction_duration_ms,
            "quota_prediction_confidence": quota_prediction_confidence,
            # Storage optimization histograms
            "storage_optimization_analysis_duration_ms": storage_optimization_analysis_duration_ms,
            # Auto-organization histograms
            "organization_clustering_duration_ms": organization_clustering_duration_ms,
            "organization_silhouette_score": organization_silhouette_score,
            "organization_cluster_size": organization_cluster_size,
            # Content recommendations histograms
            "recommendation_generation_duration_ms": recommendation_generation_duration_ms,
            "content_similarity_duration_ms": content_similarity_duration_ms,
            "content_similarity_batch_duration_ms": content_similarity_batch_duration_ms,
            "collaborative_filtering_duration_ms": collaborative_filtering_duration_ms,
            "trending_computation_duration_ms": trending_computation_duration_ms,
            "recommendation_score_distribution": recommendation_score_distribution,
            "file_similarity_score_distribution": file_similarity_score_distribution,
        }

        metric = histogram_map.get(metric_name)
        if metric:
            if labels:
                metric.labels(**labels).observe(value)
            else:
                metric.observe(value)


metrics_collector = MetricsCollector()
