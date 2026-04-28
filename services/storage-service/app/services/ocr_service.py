"""
OCR Service for extracting text from images and PDFs
Supports multiple OCR engines: Tesseract, EasyOCR
"""

import asyncio
import io
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import fitz  # PyMuPDF
import pdfplumber
from PIL import Image
from PyPDF2 import PdfReader

logger = logging.getLogger(__name__)

# Thread pool for CPU-intensive OCR tasks
executor = ThreadPoolExecutor(max_workers=4)


class OCRService:
    """Service for OCR and text extraction from files"""

    def __init__(self):
        self.tesseract_available = False
        self.easyocr_available = False
        self.easyocr_reader = None

        # Try to import OCR libraries
        try:
            import pytesseract

            self.tesseract_available = True
            self.pytesseract = pytesseract
            logger.info("Tesseract OCR initialized")
        except ImportError:
            logger.warning("pytesseract not available")

        try:
            import easyocr

            # Lazy load EasyOCR reader (heavy model)
            self.easyocr_module = easyocr
            self.easyocr_available = True
            logger.info("EasyOCR available (will load on first use)")
        except ImportError:
            logger.warning("EasyOCR not available")

    def _get_easyocr_reader(self):
        """Lazy load EasyOCR reader"""
        if self.easyocr_reader is None and self.easyocr_available:
            logger.info("Loading EasyOCR models...")
            self.easyocr_reader = self.easyocr_module.Reader(["en"], gpu=False)
        return self.easyocr_reader

    async def extract_text_from_image(
        self, image_data: bytes, engine: str = "tesseract", languages: List[str] = ["eng"]
    ) -> Dict:
        """
        Extract text from image using OCR

        Args:
            image_data: Image bytes
            engine: OCR engine ('tesseract' or 'easyocr')
            languages: List of language codes

        Returns:
            Dict with extracted text and metadata
        """
        try:
            # Load image
            image = Image.open(io.BytesIO(image_data))

            # Convert to RGB if necessary
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")

            # Run OCR in thread pool (CPU intensive)
            loop = asyncio.get_event_loop()

            if engine == "easyocr" and self.easyocr_available:
                result = await loop.run_in_executor(executor, self._run_easyocr, image)
            elif self.tesseract_available:
                result = await loop.run_in_executor(executor, self._run_tesseract, image, languages)
            else:
                return {"success": False, "error": "No OCR engine available"}

            return {
                "success": True,
                "text": result["text"],
                "confidence": result.get("confidence", 0),
                "word_count": len(result["text"].split()),
                "engine": engine,
                "languages": languages,
            }

        except Exception as e:
            logger.error(f"OCR failed: {e}", exc_info=True)
            return {"success": False, "error": str(e)}

    def _run_tesseract(self, image: Image.Image, languages: List[str]) -> Dict:
        """Run Tesseract OCR (blocking)"""
        lang_str = "+".join(languages)

        # Extract text
        text = self.pytesseract.image_to_string(image, lang=lang_str)

        # Get confidence data
        try:
            data = self.pytesseract.image_to_data(
                image, lang=lang_str, output_type=self.pytesseract.Output.DICT
            )
            confidences = [int(conf) for conf in data["conf"] if conf != "-1"]
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0
        except:
            avg_confidence = 0

        return {"text": text.strip(), "confidence": avg_confidence}

    def _run_easyocr(self, image: Image.Image) -> Dict:
        """Run EasyOCR (blocking)"""
        reader = self._get_easyocr_reader()

        # Convert PIL image to numpy array
        import numpy as np

        image_np = np.array(image)

        # Run OCR
        results = reader.readtext(image_np)

        # Combine all text
        text_parts = []
        confidences = []

        for bbox, text, confidence in results:
            text_parts.append(text)
            confidences.append(confidence)

        avg_confidence = sum(confidences) / len(confidences) * 100 if confidences else 0

        return {"text": " ".join(text_parts), "confidence": avg_confidence}

    async def extract_text_from_pdf(self, pdf_data: bytes) -> Dict:
        """
        Extract text from PDF (tries multiple methods)

        Args:
            pdf_data: PDF file bytes

        Returns:
            Dict with extracted text and metadata
        """
        try:
            text_results = []

            # Method 1: Try PyMuPDF (fastest for text-based PDFs)
            try:
                doc = fitz.open(stream=pdf_data, filetype="pdf")
                text_parts = []
                for page_num, page in enumerate(doc):
                    page_text = page.get_text()
                    if page_text.strip():
                        text_parts.append(page_text)

                if text_parts:
                    text_results.append(
                        {
                            "method": "pymupdf",
                            "text": "\n\n".join(text_parts),
                            "page_count": len(doc),
                        }
                    )
                doc.close()
            except Exception as e:
                logger.warning(f"PyMuPDF extraction failed: {e}")

            # Method 2: Try pdfplumber
            if not text_results:
                try:
                    with pdfplumber.open(io.BytesIO(pdf_data)) as pdf:
                        text_parts = []
                        for page in pdf.pages:
                            page_text = page.extract_text()
                            if page_text:
                                text_parts.append(page_text)

                        if text_parts:
                            text_results.append(
                                {
                                    "method": "pdfplumber",
                                    "text": "\n\n".join(text_parts),
                                    "page_count": len(pdf.pages),
                                }
                            )
                except Exception as e:
                    logger.warning(f"pdfplumber extraction failed: {e}")

            # Method 3: OCR if no text extracted (scanned PDFs)
            if not text_results or len(text_results[0]["text"]) < 100:
                logger.info("PDF appears to be scanned, attempting OCR...")
                ocr_result = await self._ocr_pdf_pages(pdf_data)
                if ocr_result["success"]:
                    text_results.append(
                        {
                            "method": "ocr",
                            "text": ocr_result["text"],
                            "page_count": ocr_result.get("page_count", 0),
                            "confidence": ocr_result.get("confidence", 0),
                        }
                    )

            if text_results:
                best_result = max(text_results, key=lambda x: len(x["text"]))
                return {
                    "success": True,
                    "text": best_result["text"],
                    "word_count": len(best_result["text"].split()),
                    "page_count": best_result.get("page_count", 0),
                    "method": best_result["method"],
                    "confidence": best_result.get("confidence", 100),
                }
            else:
                return {"success": False, "error": "Could not extract text from PDF"}

        except Exception as e:
            logger.error(f"PDF text extraction failed: {e}", exc_info=True)
            return {"success": False, "error": str(e)}

    async def _ocr_pdf_pages(self, pdf_data: bytes, max_pages: int = 10) -> Dict:
        """
        OCR PDF pages (for scanned PDFs)

        Args:
            pdf_data: PDF bytes
            max_pages: Maximum pages to OCR (to avoid timeout)

        Returns:
            Dict with OCR results
        """
        try:
            doc = fitz.open(stream=pdf_data, filetype="pdf")
            text_parts = []
            confidences = []

            pages_to_process = min(len(doc), max_pages)

            for page_num in range(pages_to_process):
                page = doc[page_num]

                # Render page to image
                pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))  # 2x resolution
                img_data = pix.tobytes("png")

                # OCR the image
                ocr_result = await self.extract_text_from_image(img_data)

                if ocr_result["success"]:
                    text_parts.append(ocr_result["text"])
                    confidences.append(ocr_result.get("confidence", 0))

            doc.close()

            avg_confidence = sum(confidences) / len(confidences) if confidences else 0

            return {
                "success": True,
                "text": "\n\n".join(text_parts),
                "page_count": pages_to_process,
                "confidence": avg_confidence,
            }

        except Exception as e:
            logger.error(f"PDF OCR failed: {e}", exc_info=True)
            return {"success": False, "error": str(e)}

    async def extract_text(self, file_data: bytes, mime_type: str) -> Dict:
        """
        Extract text from file based on mime type

        Args:
            file_data: File bytes
            mime_type: MIME type of file

        Returns:
            Dict with extraction results
        """
        # Image files
        if mime_type.startswith("image/"):
            return await self.extract_text_from_image(file_data)

        # PDF files
        elif mime_type == "application/pdf":
            return await self.extract_text_from_pdf(file_data)

        # Plain text files
        elif mime_type.startswith("text/"):
            try:
                text = file_data.decode("utf-8")
                return {
                    "success": True,
                    "text": text,
                    "word_count": len(text.split()),
                    "method": "direct",
                    "confidence": 100,
                }
            except Exception as e:
                return {"success": False, "error": f"Failed to decode text: {e}"}

        else:
            return {
                "success": False,
                "error": f"Unsupported file type for text extraction: {mime_type}",
            }


# Global OCR service instance
ocr_service = OCRService()
