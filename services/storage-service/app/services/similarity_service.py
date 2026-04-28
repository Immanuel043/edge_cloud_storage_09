"""
File Similarity Detection Service
Uses perceptual hashing and other techniques to find similar/duplicate files
"""

import asyncio
import io
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Tuple

import imagehash
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# Thread pool for CPU-intensive operations
executor = ThreadPoolExecutor(max_workers=4)


class SimilarityService:
    """Service for detecting similar files using various algorithms"""

    def __init__(self):
        self.hash_size = 16  # Larger hash for better accuracy

    async def compute_image_hashes(self, image_data: bytes) -> Dict[str, str]:
        """
        Compute multiple perceptual hashes for an image

        Args:
            image_data: Image bytes

        Returns:
            Dict with different hash types
        """
        try:
            loop = asyncio.get_event_loop()
            hashes = await loop.run_in_executor(executor, self._compute_hashes_sync, image_data)
            return {"success": True, **hashes}
        except Exception as e:
            logger.error(f"Hash computation failed: {e}")
            return {"success": False, "error": str(e)}

    def _compute_hashes_sync(self, image_data: bytes) -> Dict[str, str]:
        """Compute hashes (blocking operation)"""
        image = Image.open(io.BytesIO(image_data))

        # Convert to RGB if necessary
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")

        # Compute different hash types
        hashes = {
            "phash": str(imagehash.phash(image, hash_size=self.hash_size)),
            "dhash": str(imagehash.dhash(image, hash_size=self.hash_size)),
            "whash": str(imagehash.whash(image, hash_size=self.hash_size)),
            "average_hash": str(imagehash.average_hash(image, hash_size=self.hash_size)),
            "colorhash": str(imagehash.colorhash(image)),
        }

        return hashes

    async def find_similar_images(
        self, image_data: bytes, all_image_hashes: List[Dict], threshold: int = 10
    ) -> List[Dict]:
        """
        Find similar images using perceptual hashing

        Args:
            image_data: Query image bytes
            all_image_hashes: List of dicts with {id, hashes} for all images
            threshold: Hamming distance threshold (lower = more similar)

        Returns:
            List of similar images with similarity scores
        """
        try:
            # Compute hashes for query image
            query_hashes = await self.compute_image_hashes(image_data)

            if not query_hashes["success"]:
                return []

            # Compare with all stored hashes
            loop = asyncio.get_event_loop()
            similar_files = await loop.run_in_executor(
                executor, self._find_similar_sync, query_hashes, all_image_hashes, threshold
            )

            return similar_files

        except Exception as e:
            logger.error(f"Similarity search failed: {e}")
            return []

    def _find_similar_sync(
        self, query_hashes: Dict, all_hashes: List[Dict], threshold: int
    ) -> List[Dict]:
        """Find similar images (blocking)"""
        similar_files = []

        query_phash = imagehash.hex_to_hash(query_hashes["phash"])
        query_dhash = imagehash.hex_to_hash(query_hashes["dhash"])
        query_whash = imagehash.hex_to_hash(query_hashes["whash"])

        for item in all_hashes:
            try:
                # Skip if no hashes
                if "phash" not in item:
                    continue

                # Compute hamming distances
                phash_dist = query_phash - imagehash.hex_to_hash(item["phash"])
                dhash_dist = query_dhash - imagehash.hex_to_hash(item["dhash"])
                whash_dist = query_whash - imagehash.hex_to_hash(item["whash"])

                # Average distance
                avg_distance = (phash_dist + dhash_dist + whash_dist) / 3

                # If similar enough, add to results
                if avg_distance <= threshold:
                    # Calculate similarity percentage (inverse of distance)
                    max_distance = self.hash_size * self.hash_size  # Maximum possible distance
                    similarity = max(0, 100 - (avg_distance / max_distance * 100))

                    similar_files.append(
                        {
                            "file_id": item["file_id"],
                            "similarity": round(similarity, 2),
                            "distance": round(avg_distance, 2),
                            "phash_distance": phash_dist,
                            "dhash_distance": dhash_dist,
                            "whash_distance": whash_dist,
                        }
                    )

            except Exception as e:
                logger.warning(f"Failed to compare with file {item.get('file_id')}: {e}")
                continue

        # Sort by similarity (highest first)
        similar_files.sort(key=lambda x: x["similarity"], reverse=True)

        return similar_files

    async def compute_ssim(self, image1_data: bytes, image2_data: bytes) -> float:
        """
        Compute Structural Similarity Index (SSIM) between two images
        More accurate but slower than perceptual hashing

        Args:
            image1_data: First image bytes
            image2_data: Second image bytes

        Returns:
            SSIM score (0-1, higher = more similar)
        """
        try:
            from skimage.metrics import structural_similarity as ssim

            loop = asyncio.get_event_loop()
            score = await loop.run_in_executor(
                executor, self._compute_ssim_sync, image1_data, image2_data
            )
            return score

        except ImportError:
            logger.warning("scikit-image not available for SSIM")
            return 0.0
        except Exception as e:
            logger.error(f"SSIM computation failed: {e}")
            return 0.0

    def _compute_ssim_sync(self, image1_data: bytes, image2_data: bytes) -> float:
        """Compute SSIM (blocking)"""
        from skimage.metrics import structural_similarity as ssim

        # Load images
        img1 = Image.open(io.BytesIO(image1_data)).convert("L")  # Grayscale
        img2 = Image.open(io.BytesIO(image2_data)).convert("L")

        # Resize to same dimensions
        target_size = (256, 256)  # Standardize size for comparison
        img1 = img1.resize(target_size)
        img2 = img2.resize(target_size)

        # Convert to numpy arrays
        arr1 = np.array(img1)
        arr2 = np.array(img2)

        # Compute SSIM
        score = ssim(arr1, arr2)

        return float(score)

    async def compute_text_similarity(self, text1: str, text2: str) -> float:
        """
        Compute similarity between two text documents using TF-IDF

        Args:
            text1: First text document
            text2: Second text document

        Returns:
            Cosine similarity score (0-1)
        """
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
            from sklearn.metrics.pairwise import cosine_similarity

            # Create TF-IDF vectors
            vectorizer = TfidfVectorizer()
            tfidf_matrix = vectorizer.fit_transform([text1, text2])

            # Compute cosine similarity
            similarity = cosine_similarity(tfidf_matrix[0:1], tfidf_matrix[1:2])[0][0]

            return float(similarity)

        except ImportError:
            logger.warning("scikit-learn not available for text similarity")
            return 0.0
        except Exception as e:
            logger.error(f"Text similarity computation failed: {e}")
            return 0.0

    async def find_duplicate_images(
        self, all_image_hashes: List[Dict], threshold: int = 5
    ) -> List[List[Dict]]:
        """
        Find groups of duplicate/near-duplicate images

        Args:
            all_image_hashes: List of all image hashes
            threshold: Hamming distance threshold for duplicates

        Returns:
            List of duplicate groups
        """
        try:
            loop = asyncio.get_event_loop()
            duplicate_groups = await loop.run_in_executor(
                executor, self._find_duplicates_sync, all_image_hashes, threshold
            )
            return duplicate_groups

        except Exception as e:
            logger.error(f"Duplicate detection failed: {e}")
            return []

    def _find_duplicates_sync(self, all_hashes: List[Dict], threshold: int) -> List[List[Dict]]:
        """Find duplicate images (blocking)"""
        duplicate_groups = []
        processed = set()

        for i, item1 in enumerate(all_hashes):
            if item1["file_id"] in processed or "phash" not in item1:
                continue

            # Start a new group
            group = [item1]
            hash1 = imagehash.hex_to_hash(item1["phash"])

            # Find all similar images
            for j, item2 in enumerate(all_hashes[i + 1 :], start=i + 1):
                if item2["file_id"] in processed or "phash" not in item2:
                    continue

                hash2 = imagehash.hex_to_hash(item2["phash"])
                distance = hash1 - hash2

                if distance <= threshold:
                    group.append(item2)
                    processed.add(item2["file_id"])

            # Add group if it has duplicates
            if len(group) > 1:
                duplicate_groups.append(
                    [{"file_id": item["file_id"], "phash": item["phash"]} for item in group]
                )

            processed.add(item1["file_id"])

        return duplicate_groups

    def calculate_hash_distance(self, hash1: str, hash2: str) -> int:
        """
        Calculate Hamming distance between two perceptual hashes

        Args:
            hash1: First hash (hex string)
            hash2: Second hash (hex string)

        Returns:
            Hamming distance
        """
        try:
            h1 = imagehash.hex_to_hash(hash1)
            h2 = imagehash.hex_to_hash(hash2)
            return h1 - h2
        except:
            return 999  # Maximum distance if comparison fails


# Global similarity service instance
similarity_service = SimilarityService()
