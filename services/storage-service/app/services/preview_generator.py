"""
File Preview Generator Service
Generates thumbnails and previews for all major file types
"""
import os
import io
import asyncio
import tempfile
import logging
from typing import Optional, Tuple
from PIL import Image, ImageDraw, ImageFont
import mimetypes

logger = logging.getLogger(__name__)

# Try to import optional dependencies (graceful degradation)
try:
    import fitz  # PyMuPDF for PDF
    HAS_PDF_SUPPORT = True
except ImportError:
    HAS_PDF_SUPPORT = False
    logger.warning("PyMuPDF not installed - PDF previews disabled")

try:
    import cv2  # OpenCV for video
    HAS_VIDEO_SUPPORT = True
except ImportError:
    HAS_VIDEO_SUPPORT = False
    logger.warning("OpenCV not installed - video previews disabled")

# Check for ffmpeg (faster video processing)
try:
    import subprocess
    result = subprocess.run(['ffmpeg', '-version'], capture_output=True, timeout=2)
    HAS_FFMPEG = result.returncode == 0
except Exception:
    HAS_FFMPEG = False
    logger.warning("ffmpeg not found - falling back to OpenCV for video previews")

try:
    from docx import Document  # python-docx
    HAS_DOCX_SUPPORT = True
except ImportError:
    HAS_DOCX_SUPPORT = False
    logger.warning("python-docx not installed - DOCX previews disabled")


# Codecs that are extremely slow to software-decode at high resolutions.
# For these codecs at 4K+, direct ffmpeg frame extraction can exceed 30s.
SLOW_DECODE_CODECS = {'av1', 'hevc', 'h265', 'vp9'}
SLOW_DECODE_4K_WIDTH = 3840  # 4K horizontal resolution threshold


class SlowCodecError(Exception):
    """Raised when video codec + resolution is too slow for direct preview extraction."""
    pass


class PreviewGenerator:
    """Generate previews for various file types"""

    # Preview sizes
    SIZES = {
        'small': (150, 150),
        'medium': (400, 400),
        'large': (800, 800)
    }

    # Supported file types
    IMAGE_TYPES = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'}
    VIDEO_TYPES = {'.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.3g2', '.qt', '.f4v', '.ts', '.mts', '.m2ts'}
    DOCUMENT_TYPES = {'.pdf', '.docx', '.doc', '.txt', '.md', '.xlsx', '.xls', '.pptx'}
    AUDIO_TYPES = {'.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'}
    ARCHIVE_TYPES = {'.zip', '.rar', '.tar', '.gz', '.7z'}
    CODE_TYPES = {'.py', '.js', '.html', '.css', '.json', '.xml', '.sql', '.sh'}

    def __init__(self):
        self.temp_dir = tempfile.gettempdir()

    async def generate_preview(
        self,
        file_path: str,
        mime_type: str,
        size: str = 'medium',
        file_name: str = '',
        allow_slow_decode: bool = False,
    ) -> Tuple[bytes, str]:
        """
        Generate preview for any file type

        Args:
            allow_slow_decode: If True, attempt single-frame extraction even for
                slow codecs (AV1/HEVC) at 4K+, using extended timeout. Set this
                when the file is already local (e.g. optimization pipeline).

        Returns: (preview_bytes, content_type)
        """
        size_tuple = self.SIZES.get(size, self.SIZES['medium'])
        # Strip whitespace from filename to handle edge cases like "file.mp4 "
        # which would cause os.path.splitext to return empty extension
        clean_file_name = file_name.strip() if file_name else ''
        ext = os.path.splitext(clean_file_name.lower())[1] if clean_file_name else ''
        # Ensure mime_type is never None to avoid AttributeError on .startswith()
        safe_mime_type = (mime_type or '').lower()

        try:
            # Image files
            if ext in self.IMAGE_TYPES or safe_mime_type.startswith('image/'):
                return await self._generate_image_preview(file_path, size_tuple)

            # PDF files
            elif ext == '.pdf' or safe_mime_type == 'application/pdf':
                if HAS_PDF_SUPPORT:
                    return await self._generate_pdf_preview(file_path, size_tuple)
                else:
                    return self._generate_placeholder_preview('PDF', size_tuple)

            # Video files
            elif ext in self.VIDEO_TYPES or safe_mime_type.startswith('video/'):
                if HAS_VIDEO_SUPPORT:
                    return await self._generate_video_preview(
                        file_path, size_tuple, allow_slow_decode=allow_slow_decode,
                    )
                else:
                    return self._generate_placeholder_preview('VIDEO', size_tuple)

            # Document files (DOCX, TXT, etc.)
            elif ext in self.DOCUMENT_TYPES:
                if ext == '.docx' and HAS_DOCX_SUPPORT:
                    return await self._generate_docx_preview(file_path, size_tuple)
                elif ext in {'.txt', '.md'}:
                    return await self._generate_text_preview(file_path, size_tuple)
                else:
                    return self._generate_placeholder_preview('DOC', size_tuple)

            # Audio files
            elif ext in self.AUDIO_TYPES or safe_mime_type.startswith('audio/'):
                return self._generate_placeholder_preview('AUDIO', size_tuple, '🎵')

            # Archive files
            elif ext in self.ARCHIVE_TYPES:
                return self._generate_placeholder_preview('ARCHIVE', size_tuple, '📦')

            # Code files
            elif ext in self.CODE_TYPES:
                return await self._generate_text_preview(file_path, size_tuple, is_code=True)

            # Unknown/unsupported
            else:
                return self._generate_placeholder_preview('FILE', size_tuple)

        except SlowCodecError:
            raise  # Let caller decide whether to defer or retry
        except Exception as e:
            logger.error(f"Preview generation failed for {file_name}: {e}", exc_info=True)
            return self._generate_placeholder_preview('ERROR', size_tuple)

    async def _generate_image_preview(
        self,
        file_path: str,
        size: Tuple[int, int]
    ) -> Tuple[bytes, str]:
        """Generate thumbnail for image files"""

        def _resize_image():
            with Image.open(file_path) as img:
                # Convert RGBA to RGB if needed
                if img.mode == 'RGBA':
                    background = Image.new('RGB', img.size, (255, 255, 255))
                    background.paste(img, mask=img.split()[3])
                    img = background
                elif img.mode not in ('RGB', 'L'):
                    img = img.convert('RGB')

                # Resize maintaining aspect ratio
                img.thumbnail(size, Image.Resampling.LANCZOS)

                # Save to bytes
                buffer = io.BytesIO()
                img.save(buffer, format='JPEG', quality=85, optimize=True)
                return buffer.getvalue()

        # Run in thread to avoid blocking
        thumbnail_bytes = await asyncio.to_thread(_resize_image)
        return thumbnail_bytes, 'image/jpeg'

    async def _generate_pdf_preview(
        self,
        file_path: str,
        size: Tuple[int, int]
    ) -> Tuple[bytes, str]:
        """Generate preview of first PDF page"""

        def _render_pdf():
            # Open PDF
            doc = fitz.open(file_path)

            if len(doc) == 0:
                doc.close()
                raise ValueError("PDF has no pages")

            # Get first page
            page = doc[0]

            # Render to image at 2x resolution for quality
            mat = fitz.Matrix(2, 2)
            pix = page.get_pixmap(matrix=mat)

            # Convert to PIL Image
            img_data = pix.tobytes("png")
            img = Image.open(io.BytesIO(img_data))

            # Resize to thumbnail
            img.thumbnail(size, Image.Resampling.LANCZOS)

            # Save as JPEG
            buffer = io.BytesIO()
            img.save(buffer, format='JPEG', quality=85)

            doc.close()
            return buffer.getvalue()

        thumbnail_bytes = await asyncio.to_thread(_render_pdf)
        return thumbnail_bytes, 'image/jpeg'

    async def _probe_video_codec(self, file_path: str) -> Optional[dict]:
        """Quick ffprobe to get codec_name and resolution. 5s timeout."""
        def _probe():
            import subprocess as _sp
            import json as _json
            cmd = [
                'ffprobe', '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=codec_name,width,height',
                '-of', 'json', file_path
            ]
            r = _sp.run(cmd, capture_output=True, timeout=5, check=False)
            if r.returncode == 0:
                data = _json.loads(r.stdout)
                streams = data.get('streams', [])
                if streams:
                    return streams[0]
            return None
        try:
            return await asyncio.to_thread(_probe)
        except Exception:
            return None

    async def _generate_video_preview(
        self,
        file_path: str,
        size: Tuple[int, int],
        allow_slow_decode: bool = False,
    ) -> Tuple[bytes, str]:
        """
        Extract thumbnail from video (frame at 10% duration)

        Uses ffmpeg if available (much faster), falls back to OpenCV.
        For slow-decode codecs (AV1, HEVC, VP9) at 4K+, raises SlowCodecError
        to let the caller defer to the optimization pipeline — unless
        allow_slow_decode is True (optimization pipeline already has file local).
        """
        # Log file info for debugging
        try:
            file_size = os.path.getsize(file_path)
            logger.info(f"📹 Generating video preview: {file_path} ({file_size/1024/1024:.2f}MB)")
        except Exception as e:
            logger.warning(f"Could not get file size: {e}")

        # Probe codec to decide timeout / skip strategy
        probe = await self._probe_video_codec(file_path)
        codec = (probe.get('codec_name', '') if probe else '').lower()
        width = int(probe.get('width', 0) if probe else 0)

        if codec in SLOW_DECODE_CODECS and width >= SLOW_DECODE_4K_WIDTH:
            if not allow_slow_decode:
                raise SlowCodecError(
                    f"{codec.upper()} at {width}px — software decode too slow for direct preview, "
                    f"deferring to optimization pipeline"
                )
            # allow_slow_decode=True: file is local (optimization pipeline),
            # single-frame extraction is feasible with extended timeout
            logger.info(
                f"Slow codec {codec.upper()} at {width}px — "
                f"allow_slow_decode=True, attempting with 120s timeout"
            )

        # Increase timeout for slow codecs
        if codec in SLOW_DECODE_CODECS and width >= SLOW_DECODE_4K_WIDTH:
            ffmpeg_timeout = 120  # 4K+ slow codec with local file
        elif codec in SLOW_DECODE_CODECS:
            ffmpeg_timeout = 90   # sub-4K slow codec
        else:
            ffmpeg_timeout = 30

        # Try ffmpeg first (10-50x faster than OpenCV)
        if HAS_FFMPEG:
            try:
                result = await self._generate_video_preview_ffmpeg(file_path, size, timeout=ffmpeg_timeout)
                logger.info(f"✅ FFmpeg video preview generated successfully")
                return result
            except SlowCodecError:
                raise  # Don't catch SlowCodecError in the ffmpeg fallback
            except Exception as e:
                logger.warning(f"ffmpeg preview failed, falling back to OpenCV: {e}")

        # Fallback to OpenCV
        logger.info(f"🔄 Using OpenCV fallback for video preview")
        return await self._generate_video_preview_opencv(file_path, size)

    async def _generate_video_preview_ffmpeg(
        self,
        file_path: str,
        size: Tuple[int, int],
        timeout: int = 30,
    ) -> Tuple[bytes, str]:
        """
        Fast video frame extraction using ffmpeg

        Uses -ss before -i to enable input seeking (much faster)
        Extracts frame without decoding entire video.
        Timeout is configurable — 30s default, 90s for slow codecs (HEVC/VP9 < 4K).
        """

        def _extract_frame_ffmpeg():
            import subprocess

            # Create temp output file
            output_path = tempfile.mktemp(suffix='.jpg')

            try:
                # CRITICAL FIX: Put -ss BEFORE -i for fast seeking
                # This tells ffmpeg to seek to position BEFORE decoding
                # Reduces 400MB video preview from 176s to 3-5s
                cmd = [
                    'ffmpeg',
                    '-ss', '5',           # Seek to 5 seconds (BEFORE input)
                    '-i', file_path,      # Input file
                    '-frames:v', '1',     # Extract exactly 1 frame
                    '-vf', f'scale={size[0]}:{size[1]}:force_original_aspect_ratio=decrease',  # Scale during decode
                    '-q:v', '5',          # Medium quality (faster than q:v 2)
                    '-f', 'image2',       # Format
                    '-y',                 # Overwrite output
                    '-loglevel', 'error', # Suppress verbose output
                    output_path
                ]

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    timeout=timeout,
                    check=False
                )

                # If failed, check for specific errors
                if result.returncode != 0 or not os.path.exists(output_path):
                    stderr_text = result.stderr.decode() if result.stderr else ""

                    # Detect moov atom error (video metadata issue)
                    if "moov atom not found" in stderr_text.lower():
                        logger.warning(
                            f"Video preview failed: moov atom not found. "
                            f"This usually means the video metadata is at the end of the file. "
                            f"The preview system should have used head+tail download strategy."
                        )
                        raise Exception(f"moov atom not found - video preview requires full metadata")

                    logger.debug(f"First attempt failed, trying start of video: {stderr_text}")
                    cmd[2] = '0.5'  # Try at 0.5 seconds instead
                    result = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)

                # If still failed, try without seeking
                if result.returncode != 0 or not os.path.exists(output_path):
                    stderr_text_2 = result.stderr.decode() if result.stderr else ""
                    logger.info(f"Second attempt failed (at 0.5s): {stderr_text_2[:200]}. Trying first frame extraction...")
                    cmd = [
                        'ffmpeg',
                        '-i', file_path,
                        '-frames:v', '1',
                        '-vf', f'scale={size[0]}:{size[1]}:force_original_aspect_ratio=decrease',
                        '-q:v', '5',
                        '-f', 'image2',
                        '-y',
                        '-loglevel', 'error',
                        output_path
                    ]
                    result = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)

                    # Check if third attempt succeeded
                    if result.returncode != 0 or not os.path.exists(output_path):
                        stderr_text_3 = result.stderr.decode() if result.stderr else ""
                        error_msg = f"FFmpeg failed all attempts. Last error: {stderr_text_3[:300]}"
                        logger.error(error_msg)
                        raise Exception(error_msg)

                # Read extracted frame
                with Image.open(output_path) as img:
                    # Convert to RGB if needed
                    if img.mode != 'RGB':
                        img = img.convert('RGB')

                    # Ensure it fits size (ffmpeg scaling may not be exact)
                    img.thumbnail(size, Image.Resampling.LANCZOS)

                    # Save to bytes
                    buffer = io.BytesIO()
                    img.save(buffer, format='JPEG', quality=85, optimize=True)
                    return buffer.getvalue()

            finally:
                # Cleanup temp file
                if os.path.exists(output_path):
                    try:
                        os.remove(output_path)
                    except:
                        pass

        thumbnail_bytes = await asyncio.to_thread(_extract_frame_ffmpeg)
        return thumbnail_bytes, 'image/jpeg'

    async def _generate_video_preview_opencv(
        self,
        file_path: str,
        size: Tuple[int, int]
    ) -> Tuple[bytes, str]:
        """Extract thumbnail from video using OpenCV (fallback)"""

        def _extract_frame():
            # Try multiple times to read different frames
            cap = cv2.VideoCapture(file_path)

            if not cap.isOpened():
                cap.release()
                raise Exception("Could not open video file - codec not supported")

            # Get total frames
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv2.CAP_PROP_FPS)

            # Try multiple frame positions
            frame_positions = []

            if total_frames > 0 and fps > 0:
                # Try 10%, 5%, 1%, then first frame
                frame_positions = [
                    int(total_frames * 0.1),   # 10% in
                    int(total_frames * 0.05),  # 5% in
                    int(total_frames * 0.01),  # 1% in
                    0,                          # First frame
                    1,                          # Second frame (sometimes first is black)
                    2,                          # Third frame
                ]
            else:
                # If frame count unknown, just try reading sequentially
                frame_positions = [0, 1, 2, 3, 4, 5]

            frame = None
            ret = False

            for pos in frame_positions:
                try:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
                    ret, frame = cap.read()

                    # Check if frame is valid and not completely black
                    if ret and frame is not None:
                        # Check if frame has some content (not just black)
                        mean_brightness = frame.mean()
                        if mean_brightness > 5:  # Not completely black
                            break
                except Exception as e:
                    logger.debug(f"Failed to read frame at position {pos}: {e}")
                    continue

            cap.release()

            if not ret or frame is None:
                raise Exception("Could not read any valid video frame")

            # Convert BGR to RGB
            try:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            except Exception as e:
                # If color conversion fails, try using frame as-is
                logger.warning(f"Color conversion failed: {e}, using original frame")
                frame_rgb = frame

            # Convert to PIL Image
            img = Image.fromarray(frame_rgb)

            # Resize
            img.thumbnail(size, Image.Resampling.LANCZOS)

            # Save as JPEG
            buffer = io.BytesIO()
            img.save(buffer, format='JPEG', quality=85)
            return buffer.getvalue()

        try:
            thumbnail_bytes = await asyncio.to_thread(_extract_frame)
            return thumbnail_bytes, 'image/jpeg'
        except Exception as e:
            logger.error(f"Video preview failed completely: {e}")
            # Return placeholder instead
            return self._generate_placeholder_preview("VIDEO", size, "🎬")

    async def _generate_docx_preview(
        self,
        file_path: str,
        size: Tuple[int, int]
    ) -> Tuple[bytes, str]:
        """Generate preview of DOCX first page"""

        def _render_docx():
            doc = Document(file_path)

            # Extract first 500 chars of text
            text_lines = []
            char_count = 0
            for paragraph in doc.paragraphs[:10]:
                text = paragraph.text.strip()
                if text:
                    text_lines.append(text)
                    char_count += len(text)
                    if char_count > 500:
                        break

            preview_text = '\n'.join(text_lines[:15])

            # Create image with text
            return self._create_text_image(preview_text, size, title="DOCX Preview")

        thumbnail_bytes = await asyncio.to_thread(_render_docx)
        return thumbnail_bytes, 'image/jpeg'

    async def _generate_text_preview(
        self,
        file_path: str,
        size: Tuple[int, int],
        is_code: bool = False
    ) -> Tuple[bytes, str]:
        """Generate preview of text file"""

        def _render_text():
            # Read first 1000 chars
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read(1000)

            title = "Code Preview" if is_code else "Text Preview"
            return self._create_text_image(content, size, title=title)

        thumbnail_bytes = await asyncio.to_thread(_render_text)
        return thumbnail_bytes, 'image/jpeg'

    def _create_text_image(
        self,
        text: str,
        size: Tuple[int, int],
        title: str = "Preview"
    ) -> bytes:
        """Create an image with text content"""

        # Create white background
        img = Image.new('RGB', size, color='white')
        draw = ImageDraw.Draw(img)

        # Try to use a nice font, fallback to default
        try:
            title_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 20)
            text_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 12)
        except:
            title_font = ImageFont.load_default()
            text_font = ImageFont.load_default()

        # Draw title
        draw.text((10, 10), title, fill='black', font=title_font)

        # Draw line separator
        draw.line([(10, 40), (size[0] - 10, 40)], fill='gray', width=2)

        # Draw text content (word wrap)
        y_offset = 50
        max_width = size[0] - 20

        words = text.split()
        lines = []
        current_line = []

        for word in words:
            test_line = ' '.join(current_line + [word])
            bbox = draw.textbbox((0, 0), test_line, font=text_font)
            if bbox[2] <= max_width:
                current_line.append(word)
            else:
                if current_line:
                    lines.append(' '.join(current_line))
                current_line = [word]

        if current_line:
            lines.append(' '.join(current_line))

        # Draw lines
        for line in lines[:20]:  # Max 20 lines
            if y_offset + 15 > size[1] - 10:
                break
            draw.text((10, y_offset), line, fill='black', font=text_font)
            y_offset += 15

        # Save to bytes
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=85)
        return buffer.getvalue()

    def _generate_placeholder_preview(
        self,
        file_type: str,
        size: Tuple[int, int],
        icon: str = '📄'
    ) -> Tuple[bytes, str]:
        """Generate a placeholder preview for unsupported file types"""

        # Create colored background based on type
        colors = {
            'PDF': '#FF6B6B',
            'VIDEO': '#4ECDC4',
            'AUDIO': '#95E1D3',
            'DOC': '#5C7CFA',
            'ARCHIVE': '#FFD93D',
            'FILE': '#A8DADC',
            'ERROR': '#FF6B6B',
            'CODE': '#51CF66'
        }

        bg_color = colors.get(file_type, '#A8DADC')

        # Create image
        img = Image.new('RGB', size, color=bg_color)
        draw = ImageDraw.Draw(img)

        # Try to use a nice font
        try:
            icon_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 80)
            text_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
        except:
            icon_font = ImageFont.load_default()
            text_font = ImageFont.load_default()

        # Draw icon (emoji)
        icon_bbox = draw.textbbox((0, 0), icon, font=icon_font)
        icon_width = icon_bbox[2] - icon_bbox[0]
        icon_x = (size[0] - icon_width) // 2
        icon_y = size[1] // 3
        draw.text((icon_x, icon_y), icon, fill='white', font=icon_font)

        # Draw file type text
        text_bbox = draw.textbbox((0, 0), file_type, font=text_font)
        text_width = text_bbox[2] - text_bbox[0]
        text_x = (size[0] - text_width) // 2
        text_y = size[1] // 2 + 40
        draw.text((text_x, text_y), file_type, fill='white', font=text_font)

        # Save to bytes
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=85)
        return buffer.getvalue(), 'image/jpeg'


# Global preview generator instance
preview_generator = PreviewGenerator()
