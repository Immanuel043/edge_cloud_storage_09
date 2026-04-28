"""
AI-Powered Tagging Service
Uses image classification and NLP to automatically tag files
"""

import asyncio
import io
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional

from PIL import Image

logger = logging.getLogger(__name__)

# Thread pool for CPU-intensive AI tasks
executor = ThreadPoolExecutor(max_workers=2)


class AITaggingService:
    """Service for AI-powered automatic file tagging"""

    def __init__(self):
        self.clip_available = False
        self.transformers_available = False

        # Try to import AI libraries (optional)
        try:
            from transformers import pipeline

            self.transformers = pipeline
            self.transformers_available = True
            self.image_classifier = None
            self.text_classifier = None
            logger.info("Transformers available for AI tagging")
        except ImportError:
            logger.warning("transformers not available - AI tagging disabled")

    def _get_image_classifier(self):
        """Lazy load image classification model"""
        if self.image_classifier is None and self.transformers_available:
            try:
                logger.info("Loading image classification model...")
                # Using a small, efficient model
                self.image_classifier = self.transformers(
                    "image-classification", model="google/vit-base-patch16-224"
                )
                logger.info("Image classifier loaded")
            except Exception as e:
                logger.error(f"Failed to load image classifier: {e}")
                self.transformers_available = False
        return self.image_classifier

    def _get_text_classifier(self):
        """Lazy load zero-shot text classification model"""
        if self.text_classifier is None and self.transformers_available:
            try:
                logger.info("Loading text classification model...")
                self.text_classifier = self.transformers(
                    "zero-shot-classification", model="facebook/bart-large-mnli"
                )
                logger.info("Text classifier loaded")
            except Exception as e:
                logger.error(f"Failed to load text classifier: {e}")
        return self.text_classifier

    async def generate_tags_for_image(self, image_data: bytes, top_k: int = 5) -> List[Dict]:
        """
        Generate tags for an image using AI classification

        Args:
            image_data: Image bytes
            top_k: Number of top predictions to return

        Returns:
            List of tags with confidence scores
        """
        if not self.transformers_available:
            return self._generate_basic_image_tags(image_data)

        try:
            classifier = self._get_image_classifier()
            if classifier is None:
                return self._generate_basic_image_tags(image_data)

            # Load image
            image = Image.open(io.BytesIO(image_data))
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")

            # Run classification in thread pool
            loop = asyncio.get_event_loop()
            predictions = await loop.run_in_executor(
                executor, lambda: classifier(image, top_k=top_k)
            )

            # Format results
            tags = []
            for pred in predictions:
                # Clean up label (remove numbers, underscores)
                label = pred["label"].replace("_", " ").strip()
                label = " ".join([w for w in label.split() if not w.isdigit()])

                tags.append(
                    {
                        "tag": label.lower(),
                        "confidence": round(pred["score"] * 100, 2),
                        "source": "ai_vision",
                    }
                )

            return tags

        except Exception as e:
            logger.error(f"AI image tagging failed: {e}", exc_info=True)
            return self._generate_basic_image_tags(image_data)

    def _generate_basic_image_tags(self, image_data: bytes) -> List[Dict]:
        """Generate basic tags from image properties (fallback)"""
        try:
            image = Image.open(io.BytesIO(image_data))
            tags = []

            # Tag by format
            if image.format:
                tags.append(
                    {"tag": f"{image.format.lower()}_image", "confidence": 100, "source": "format"}
                )

            # Tag by aspect ratio
            aspect_ratio = image.width / image.height
            if aspect_ratio > 1.5:
                tags.append({"tag": "landscape", "confidence": 90, "source": "dimensions"})
            elif aspect_ratio < 0.7:
                tags.append({"tag": "portrait", "confidence": 90, "source": "dimensions"})
            else:
                tags.append({"tag": "square", "confidence": 90, "source": "dimensions"})

            # Tag by size
            megapixels = (image.width * image.height) / 1000000
            if megapixels > 10:
                tags.append({"tag": "high_resolution", "confidence": 100, "source": "resolution"})
            elif megapixels < 1:
                tags.append({"tag": "low_resolution", "confidence": 100, "source": "resolution"})

            return tags

        except:
            return []

    async def generate_tags_for_document(self, text_content: str, filename: str = "") -> List[Dict]:
        """
        Generate tags for a document using text classification

        Args:
            text_content: Extracted text from document
            filename: Original filename (for additional context)

        Returns:
            List of tags with confidence scores
        """
        tags = []

        # Basic filename-based tags
        tags.extend(self._tags_from_filename(filename))

        # Content-based tags
        if not text_content or len(text_content.strip()) < 10:
            return tags

        # Keyword-based tagging (fast, no AI needed)
        tags.extend(self._tags_from_keywords(text_content))

        # AI-based classification (if available)
        if self.transformers_available:
            ai_tags = await self._classify_document_content(text_content)
            tags.extend(ai_tags)

        # Deduplicate and sort by confidence
        seen = set()
        unique_tags = []
        for tag in sorted(tags, key=lambda x: x["confidence"], reverse=True):
            if tag["tag"] not in seen:
                seen.add(tag["tag"])
                unique_tags.append(tag)

        return unique_tags[:10]  # Top 10 tags

    def _tags_from_filename(self, filename: str) -> List[Dict]:
        """Extract tags from filename"""
        tags = []
        if not filename:
            return tags

        filename_lower = filename.lower()

        # Document type patterns
        patterns = {
            "invoice": ["invoice", "bill", "receipt"],
            "contract": ["contract", "agreement", "terms"],
            "report": ["report", "analysis", "summary"],
            "presentation": ["presentation", "slides", "deck"],
            "resume": ["resume", "cv", "curriculum"],
            "screenshot": ["screenshot", "screen", "capture"],
            "photo": ["photo", "img", "pic", "picture"],
            "document": ["doc", "document"],
        }

        for tag, keywords in patterns.items():
            if any(kw in filename_lower for kw in keywords):
                tags.append({"tag": tag, "confidence": 85, "source": "filename"})

        return tags

    def _tags_from_keywords(self, text: str) -> List[Dict]:
        """Extract tags based on keyword matching"""
        tags = []
        text_lower = text.lower()

        # Business document keywords
        business_patterns = {
            "financial": ["payment", "invoice", "receipt", "transaction", "account", "balance"],
            "legal": ["contract", "agreement", "terms", "conditions", "liability", "clause"],
            "technical": ["system", "software", "code", "technical", "specification", "api"],
            "medical": ["patient", "diagnosis", "treatment", "medical", "health", "doctor"],
            "academic": ["research", "study", "analysis", "thesis", "academic", "university"],
            "marketing": ["campaign", "marketing", "advertisement", "brand", "customer"],
        }

        for tag, keywords in business_patterns.items():
            matches = sum(1 for kw in keywords if kw in text_lower)
            if matches >= 2:  # At least 2 keyword matches
                confidence = min(95, 60 + matches * 10)
                tags.append({"tag": tag, "confidence": confidence, "source": "keywords"})

        return tags

    async def _classify_document_content(self, text: str) -> List[Dict]:
        """Use AI to classify document content"""
        try:
            classifier = self._get_text_classifier()
            if classifier is None:
                return []

            # Truncate text if too long
            text_sample = text[:1000]  # First 1000 chars

            # Define candidate labels
            candidate_labels = [
                "business document",
                "legal document",
                "technical documentation",
                "personal letter",
                "financial report",
                "academic paper",
                "marketing material",
                "medical record",
                "invoice or receipt",
                "contract or agreement",
            ]

            # Run classification
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                executor, lambda: classifier(text_sample, candidate_labels)
            )

            # Format results
            tags = []
            for label, score in zip(result["labels"][:3], result["scores"][:3]):
                if score > 0.3:  # Only high confidence
                    # Simplify label
                    tag = label.replace(" or ", "_").replace(" ", "_")
                    tags.append(
                        {"tag": tag, "confidence": round(score * 100, 2), "source": "ai_nlp"}
                    )

            return tags

        except Exception as e:
            logger.error(f"AI text classification failed: {e}")
            return []

    async def generate_smart_tags(
        self,
        file_data: bytes,
        mime_type: str,
        filename: str,
        extracted_text: Optional[str] = None,
        metadata: Optional[Dict] = None,
    ) -> List[Dict]:
        """
        Generate comprehensive smart tags using all available information

        Args:
            file_data: File bytes
            mime_type: MIME type
            filename: Original filename
            extracted_text: OCR/extracted text (optional)
            metadata: File metadata (optional)

        Returns:
            List of smart tags
        """
        all_tags = []

        # Image tags
        if mime_type.startswith("image/"):
            image_tags = await self.generate_tags_for_image(file_data)
            all_tags.extend(image_tags)

            # Add metadata-based tags
            if metadata:
                all_tags.extend(self._tags_from_image_metadata(metadata))

        # Document tags
        if extracted_text:
            doc_tags = await self.generate_tags_for_document(extracted_text, filename)
            all_tags.extend(doc_tags)

        # Audio/video tags from metadata
        if metadata and metadata.get("type") in ["audio", "video"]:
            all_tags.extend(self._tags_from_media_metadata(metadata))

        # Deduplicate
        seen = set()
        unique_tags = []
        for tag in sorted(all_tags, key=lambda x: x["confidence"], reverse=True):
            if tag["tag"] not in seen:
                seen.add(tag["tag"])
                unique_tags.append(tag)

        return unique_tags[:15]  # Top 15 tags

    def _tags_from_image_metadata(self, metadata: Dict) -> List[Dict]:
        """Generate tags from image EXIF data"""
        tags = []

        if metadata.get("camera_make"):
            tags.append(
                {
                    "tag": f"{metadata['camera_make'].lower()}_photo",
                    "confidence": 90,
                    "source": "exif",
                }
            )

        if metadata.get("gps_latitude") or "GPSInfo" in metadata.get("exif", {}):
            tags.append({"tag": "geotagged", "confidence": 100, "source": "exif"})

        # Time-based tags
        if metadata.get("date_taken"):
            tags.append({"tag": "dated_photo", "confidence": 95, "source": "exif"})

        return tags

    def _tags_from_media_metadata(self, metadata: Dict) -> List[Dict]:
        """Generate tags from audio/video metadata"""
        tags = []

        if metadata.get("genre"):
            tags.append(
                {
                    "tag": f"{metadata['genre'].lower()}_music",
                    "confidence": 95,
                    "source": "metadata",
                }
            )

        if metadata.get("artist"):
            tags.append({"tag": "music", "confidence": 100, "source": "metadata"})

        if metadata.get("type") == "video":
            # Tag by duration
            duration = metadata.get("duration", 0)
            if duration > 600:  # 10 minutes
                tags.append({"tag": "long_video", "confidence": 100, "source": "duration"})
            elif duration < 60:
                tags.append({"tag": "short_video", "confidence": 100, "source": "duration"})

        return tags


# Global AI tagging service instance
ai_tagging_service = AITaggingService()
