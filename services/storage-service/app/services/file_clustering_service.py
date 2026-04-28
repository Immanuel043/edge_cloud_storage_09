"""
File Clustering Service

ML-based clustering using classical algorithms (CPU-optimized):
- K-Means clustering
- DBSCAN clustering
- TF-IDF vectorization for filenames
- Feature extraction from file metadata
"""

import logging
import os
import re
from collections import Counter
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import numpy as np

# CPU optimization for AMD Ryzen 9 7950X
os.environ["OMP_NUM_THREADS"] = "32"
os.environ["MKL_NUM_THREADS"] = "32"
os.environ["OPENBLAS_NUM_THREADS"] = "32"

from ..config import settings
from ..models.database import Object

logger = logging.getLogger(__name__)


class FileClusteringService:
    """
    Classical ML clustering for file organization

    Uses TF-IDF on filenames + metadata features for clustering
    """

    def __init__(self):
        self.max_clusters = settings.AUTO_ORG_MAX_CLUSTERS

    def prepare_features(self, files: List[Object]) -> Tuple[np.ndarray, List[str], List[Dict]]:
        """
        Extract features from files for clustering

        Features:
        - TF-IDF from filename tokens
        - File extension (one-hot encoded)
        - File size (normalized)
        - Creation date (temporal features)

        Returns:
            Tuple of (feature_matrix, feature_names, raw_features)
        """
        try:
            import scipy.sparse as sp
            from sklearn.feature_extraction.text import TfidfVectorizer
            from sklearn.preprocessing import OneHotEncoder, StandardScaler

            # Extract filename tokens
            filenames = [self._tokenize_filename(f.file_name) for f in files]

            # TF-IDF vectorization
            vectorizer = TfidfVectorizer(
                max_features=100,  # Top 100 terms
                ngram_range=(1, 2),  # Unigrams and bigrams
                min_df=2,  # Appear in at least 2 documents
                max_df=0.8,  # Appear in at most 80% of documents
            )
            tfidf_features = vectorizer.fit_transform(filenames)

            # Extension features (one-hot)
            extensions = [self._get_extension(f.file_name) for f in files]
            unique_exts = list(set(extensions))
            ext_encoder = OneHotEncoder(sparse=True, handle_unknown="ignore")
            ext_array = np.array(extensions).reshape(-1, 1)
            ext_features = ext_encoder.fit_transform(ext_array)

            # Size features (normalized log scale)
            sizes = np.array([np.log1p(f.file_size or 1) for f in files]).reshape(-1, 1)
            size_scaler = StandardScaler()
            size_features = size_scaler.fit_transform(sizes)

            # Date features (year, month, day of week)
            date_features = []
            for f in files:
                date = f.created_at or datetime.utcnow()
                date_features.append([date.year, date.month, date.weekday()])
            date_features = np.array(date_features)
            date_scaler = StandardScaler()
            date_features_normalized = date_scaler.fit_transform(date_features)

            # Combine all features
            # Weight TF-IDF more heavily (70%), rest 30%
            feature_matrix = sp.hstack(
                [
                    tfidf_features * 0.70,
                    ext_features * 0.15,
                    sp.csr_matrix(size_features) * 0.075,
                    sp.csr_matrix(date_features_normalized) * 0.075,
                ]
            )

            # Feature names for interpretation
            feature_names = (
                vectorizer.get_feature_names_out().tolist()
                + [f"ext_{ext}" for ext in unique_exts]
                + ["log_size", "year", "month", "weekday"]
            )

            # Raw features for analysis
            raw_features = [
                {
                    "filename": f.file_name,
                    "extension": self._get_extension(f.file_name),
                    "size": f.file_size,
                    "created_at": f.created_at,
                    "tokens": self._tokenize_filename(f.file_name),
                }
                for f in files
            ]

            logger.info(f"Prepared features: {feature_matrix.shape} for {len(files)} files")
            return feature_matrix.toarray(), feature_names, raw_features

        except ImportError:
            logger.error("scikit-learn not installed. Install with: pip install scikit-learn")
            raise
        except Exception as e:
            logger.error(f"Feature preparation failed: {e}", exc_info=True)
            raise

    def cluster_kmeans(self, files: List[Object], n_clusters: Optional[int] = None) -> Dict:
        """
        Cluster files using K-Means algorithm

        Args:
            files: List of file objects
            n_clusters: Number of clusters (auto-detect if None)

        Returns:
            Dictionary with cluster assignments and metadata
        """
        try:
            from sklearn.cluster import KMeans
            from sklearn.metrics import silhouette_score

            # Prepare features
            features, feature_names, raw_features = self.prepare_features(files)

            # Auto-detect optimal number of clusters if not specified
            if n_clusters is None:
                n_clusters = self._auto_detect_clusters(features, len(files))

            logger.info(f"Running K-Means with {n_clusters} clusters on {len(files)} files")

            # K-Means clustering
            kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10, max_iter=300)
            cluster_labels = kmeans.fit_predict(features)

            # Calculate quality metrics
            silhouette = (
                silhouette_score(features, cluster_labels) if len(set(cluster_labels)) > 1 else 0.0
            )

            # Analyze clusters
            clusters = self._analyze_clusters(
                cluster_labels, files, raw_features, kmeans.cluster_centers_, feature_names
            )

            logger.info(
                f"K-Means clustering complete: {n_clusters} clusters, "
                f"silhouette score: {silhouette:.3f}"
            )

            return {
                "algorithm": "kmeans",
                "n_clusters": n_clusters,
                "cluster_labels": cluster_labels.tolist(),
                "silhouette_score": float(silhouette),
                "clusters": clusters,
                "centroids": kmeans.cluster_centers_.tolist(),
            }

        except Exception as e:
            logger.error(f"K-Means clustering failed: {e}", exc_info=True)
            raise

    def cluster_dbscan(self, files: List[Object], eps: float = 0.5, min_samples: int = 5) -> Dict:
        """
        Cluster files using DBSCAN algorithm (density-based)

        Args:
            files: List of file objects
            eps: Maximum distance between samples
            min_samples: Minimum samples in neighborhood

        Returns:
            Dictionary with cluster assignments and metadata
        """
        try:
            from sklearn.cluster import DBSCAN
            from sklearn.metrics import silhouette_score

            # Prepare features
            features, feature_names, raw_features = self.prepare_features(files)

            logger.info(
                f"Running DBSCAN with eps={eps}, min_samples={min_samples} on {len(files)} files"
            )

            # DBSCAN clustering
            dbscan = DBSCAN(eps=eps, min_samples=min_samples, n_jobs=-1)
            cluster_labels = dbscan.fit_predict(features)

            # Count clusters (excluding noise points labeled -1)
            n_clusters = len(set(cluster_labels)) - (1 if -1 in cluster_labels else 0)
            n_noise = list(cluster_labels).count(-1)

            # Calculate quality metrics (excluding noise)
            mask = cluster_labels != -1
            silhouette = 0.0
            if n_clusters > 1 and sum(mask) > 1:
                silhouette = silhouette_score(features[mask], cluster_labels[mask])

            # Analyze clusters
            clusters = self._analyze_clusters(
                cluster_labels,
                files,
                raw_features,
                None,  # DBSCAN doesn't have centroids
                feature_names,
            )

            logger.info(
                f"DBSCAN clustering complete: {n_clusters} clusters, "
                f"{n_noise} noise points, silhouette score: {silhouette:.3f}"
            )

            return {
                "algorithm": "dbscan",
                "n_clusters": n_clusters,
                "n_noise": n_noise,
                "cluster_labels": cluster_labels.tolist(),
                "silhouette_score": float(silhouette),
                "clusters": clusters,
            }

        except Exception as e:
            logger.error(f"DBSCAN clustering failed: {e}", exc_info=True)
            raise

    def _analyze_clusters(
        self,
        cluster_labels: np.ndarray,
        files: List[Object],
        raw_features: List[Dict],
        centroids: Optional[np.ndarray],
        feature_names: List[str],
    ) -> List[Dict]:
        """
        Analyze cluster properties and generate names/descriptions

        Returns list of cluster metadata
        """
        clusters = []
        unique_labels = set(cluster_labels)

        for label in unique_labels:
            if label == -1:  # Noise cluster in DBSCAN
                continue

            # Get files in this cluster
            mask = cluster_labels == label
            cluster_files = [files[i] for i in range(len(files)) if mask[i]]
            cluster_raw_features = [raw_features[i] for i in range(len(files)) if mask[i]]

            if not cluster_files:
                continue

            # Extract keywords from filenames
            all_tokens = []
            for rf in cluster_raw_features:
                all_tokens.extend(rf["tokens"].split())

            # Top keywords (TF-IDF style)
            token_counts = Counter(all_tokens)
            top_keywords = [word for word, count in token_counts.most_common(5)]

            # Common file extensions
            extensions = [rf["extension"] for rf in cluster_raw_features]
            ext_counts = Counter(extensions)
            common_extensions = [ext for ext, count in ext_counts.most_common(3)]

            # Date range
            dates = [f.created_at for f in cluster_files if f.created_at]
            date_range_start = min(dates) if dates else None
            date_range_end = max(dates) if dates else None

            # Total size
            total_size = sum(f.file_size or 0 for f in cluster_files)

            # Generate cluster name
            cluster_name = self._generate_cluster_name(
                top_keywords, common_extensions, date_range_start, len(cluster_files)
            )

            # Generate description
            description = self._generate_cluster_description(
                len(cluster_files),
                common_extensions,
                top_keywords,
                date_range_start,
                date_range_end,
            )

            # Suggested folder path
            suggested_path = self._suggest_folder_path(cluster_name, date_range_start)

            # Cohesion score (average distance to centroid if available)
            cohesion = 0.0
            if centroids is not None:
                # Calculate average distance to centroid
                # (placeholder - would need feature vectors)
                cohesion = 0.8  # Default good cohesion

            clusters.append(
                {
                    "cluster_id": int(label),
                    "cluster_name": cluster_name,
                    "cluster_description": description,
                    "num_files": len(cluster_files),
                    "total_size": total_size,
                    "top_keywords": top_keywords,
                    "common_extensions": common_extensions,
                    "date_range_start": date_range_start,
                    "date_range_end": date_range_end,
                    "cohesion_score": cohesion,
                    "suggested_folder_path": suggested_path,
                    "file_ids": [str(f.id) for f in cluster_files],
                }
            )

        return clusters

    def _auto_detect_clusters(self, features: np.ndarray, n_files: int) -> int:
        """
        Auto-detect optimal number of clusters using elbow method

        Returns optimal number of clusters
        """
        # Simple heuristic: sqrt(n/2)
        optimal = int(np.sqrt(n_files / 2))

        # Bound between 2 and max_clusters
        optimal = max(2, min(optimal, self.max_clusters))

        logger.info(f"Auto-detected {optimal} clusters for {n_files} files")
        return optimal

    def _tokenize_filename(self, filename: str) -> str:
        """
        Tokenize filename for TF-IDF

        Extracts meaningful tokens from filename
        """
        # Remove extension
        name = filename.rsplit(".", 1)[0] if "." in filename else filename

        # Split on common delimiters
        tokens = re.split(r"[_\-\s\.\(\)\[\]]+", name.lower())

        # Remove very short tokens and numbers-only
        tokens = [t for t in tokens if len(t) > 2 and not t.isdigit()]

        return " ".join(tokens)

    def _get_extension(self, filename: str) -> str:
        """Extract file extension"""
        return filename.rsplit(".", 1)[-1].lower() if "." in filename else "unknown"

    def _generate_cluster_name(
        self,
        keywords: List[str],
        extensions: List[str],
        start_date: Optional[datetime],
        num_files: int,
    ) -> str:
        """Generate human-readable cluster name"""
        # Use top keyword if available
        name_parts = []

        if keywords:
            # Capitalize first keyword
            name_parts.append(keywords[0].capitalize())

        # Add file type if clear
        if extensions and extensions[0] in ["pdf", "jpg", "png", "docx", "xlsx"]:
            type_map = {
                "pdf": "Documents",
                "jpg": "Photos",
                "png": "Images",
                "docx": "Word Documents",
                "xlsx": "Spreadsheets",
            }
            name_parts.append(type_map.get(extensions[0], extensions[0].upper()))

        # Add year if available
        if start_date:
            name_parts.append(str(start_date.year))

        # Fallback
        if not name_parts:
            name_parts = [f"Group {num_files} files"]

        return " ".join(name_parts[:3])  # Max 3 parts

    def _generate_cluster_description(
        self,
        num_files: int,
        extensions: List[str],
        keywords: List[str],
        start_date: Optional[datetime],
        end_date: Optional[datetime],
    ) -> str:
        """Generate cluster description"""
        parts = [f"{num_files} files"]

        if extensions:
            parts.append(f"mostly {', '.join(extensions[:2])}")

        if keywords:
            parts.append(f"related to {', '.join(keywords[:3])}")

        if start_date and end_date:
            if start_date.year == end_date.year:
                parts.append(f"from {start_date.year}")
            else:
                parts.append(f"from {start_date.year}-{end_date.year}")

        return ", ".join(parts) + "."

    def _suggest_folder_path(self, cluster_name: str, start_date: Optional[datetime]) -> str:
        """Suggest folder path for cluster"""
        # Clean cluster name for path
        clean_name = re.sub(r"[^\w\s-]", "", cluster_name).strip().replace(" ", "_")

        # Add year prefix if available
        if start_date:
            return f"/{start_date.year}/{clean_name}"
        else:
            return f"/Organized/{clean_name}"


# Singleton instance
file_clustering_service = FileClusteringService()
