"""
Video Optimization Service

Handles:
- Moov atom detection in MP4/MOV files
- Faststart remux for streaming optimization
- Video metadata inspection
"""

import asyncio
import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)


class VideoOptimizer:
    """Service for video file optimization and metadata inspection"""

    def __init__(self):
        self.has_ffmpeg = self._check_ffmpeg_available()
        self.has_ffprobe = self._check_ffprobe_available()

        if not self.has_ffmpeg:
            logger.warning("ffmpeg not available - video optimization disabled")
        if not self.has_ffprobe:
            logger.warning("ffprobe not available - moov detection limited")

    def _check_ffmpeg_available(self) -> bool:
        """Check if ffmpeg is installed"""
        try:
            result = subprocess.run(
                ['ffmpeg', '-version'],
                capture_output=True,
                timeout=5,
                check=False
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    def _check_ffprobe_available(self) -> bool:
        """Check if ffprobe is installed"""
        try:
            result = subprocess.run(
                ['ffprobe', '-version'],
                capture_output=True,
                timeout=5,
                check=False
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    async def detect_moov_location(self, file_path: str) -> Dict[str, any]:
        """
        Detect moov atom location in MP4/MOV file

        Returns:
            {
                'has_moov': bool,
                'moov_location': 'start' | 'end' | 'unknown',
                'needs_faststart': bool,
                'file_size': int,
                'duration': float,
                'format': str
            }
        """
        if not self.has_ffprobe:
            # Fallback: assume moov at end for MOV files
            file_size = os.path.getsize(file_path)
            ext = Path(file_path).suffix.lower()
            return {
                'has_moov': True,
                'moov_location': 'end' if ext == '.mov' else 'unknown',
                'needs_faststart': ext == '.mov',
                'file_size': file_size,
                'duration': 0.0,
                'format': ext
            }

        try:
            # Use ffprobe to get detailed format information
            cmd = [
                'ffprobe',
                '-v', 'error',
                '-show_format',
                '-show_streams',
                '-print_format', 'json',
                file_path
            ]

            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await result.communicate()

            if result.returncode != 0:
                logger.warning(f"ffprobe failed for {file_path}: {stderr.decode()}")
                return self._fallback_detection(file_path)

            probe_data = json.loads(stdout.decode())
            format_info = probe_data.get('format', {})

            # Check if video can be played without full download
            # This is a heuristic: if ffprobe can read format quickly, moov is at start
            file_size = int(format_info.get('size', 0))
            duration = float(format_info.get('duration', 0.0))
            format_name = format_info.get('format_name', '')

            # Check for faststart flag in format tags
            tags = format_info.get('tags', {})
            is_faststart = 'compatible_brands' in tags or 'major_brand' in tags

            # Heuristic: Check if we can determine moov location
            # If ffprobe succeeds quickly and we have duration, moov is accessible
            moov_location = 'start' if is_faststart else 'unknown'

            # For MOV files without faststart, assume moov at end
            if format_name in ['mov,mp4,m4a,3gp,3g2,mj2'] and not is_faststart:
                moov_location = 'end'

            return {
                'has_moov': True,
                'moov_location': moov_location,
                'needs_faststart': moov_location != 'start',
                'file_size': file_size,
                'duration': duration,
                'format': format_name
            }

        except Exception as e:
            logger.error(f"Error detecting moov location: {e}")
            return self._fallback_detection(file_path)

    def _fallback_detection(self, file_path: str) -> Dict[str, any]:
        """Fallback moov detection based on file extension"""
        file_size = os.path.getsize(file_path)
        ext = Path(file_path).suffix.lower()

        # Heuristic: MOV files typically have moov at end
        # MP4 files from modern sources typically have moov at start
        needs_faststart = ext in ['.mov', '.qt']

        return {
            'has_moov': True,
            'moov_location': 'end' if needs_faststart else 'unknown',
            'needs_faststart': needs_faststart,
            'file_size': file_size,
            'duration': 0.0,
            'format': ext
        }

    async def apply_faststart(
        self,
        input_path: str,
        output_path: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        """
        Apply faststart optimization to video file

        Uses ffmpeg to move moov atom to beginning without re-encoding

        Args:
            input_path: Path to input video file
            output_path: Path for optimized output (if None, creates temp file)

        Returns:
            (success: bool, output_path: str)
        """
        if not self.has_ffmpeg:
            logger.error("ffmpeg not available - cannot apply faststart")
            return False, None

        try:
            # Create temp file if output not specified
            if output_path is None:
                temp_fd, output_path = tempfile.mkstemp(
                    suffix=Path(input_path).suffix,
                    prefix='faststart_'
                )
                os.close(temp_fd)

            logger.info(f"Applying faststart to {input_path}")

            # Run ffmpeg with faststart flag
            cmd = [
                'ffmpeg',
                '-i', input_path,
                '-c', 'copy',  # Copy streams without re-encoding
                '-movflags', '+faststart',  # Move moov atom to start
                '-y',  # Overwrite output
                '-loglevel', 'error',
                output_path
            ]

            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await result.communicate()

            if result.returncode != 0:
                error_msg = stderr.decode()
                logger.error(f"ffmpeg faststart failed: {error_msg}")

                # Clean up failed output
                if os.path.exists(output_path):
                    os.remove(output_path)

                return False, None

            # Verify output file was created
            if not os.path.exists(output_path):
                logger.error("ffmpeg completed but output file not found")
                return False, None

            output_size = os.path.getsize(output_path)
            input_size = os.path.getsize(input_path)

            logger.info(
                f"Faststart completed: {input_size} -> {output_size} bytes "
                f"({output_size/input_size*100:.1f}% of original)"
            )

            return True, output_path

        except Exception as e:
            logger.error(f"Error applying faststart: {e}")

            # Clean up on error
            if output_path and os.path.exists(output_path):
                try:
                    os.remove(output_path)
                except:
                    pass

            return False, None

    async def optimize_video_for_streaming(
        self,
        file_path: str,
        replace_original: bool = True
    ) -> Dict[str, any]:
        """
        Complete video optimization workflow

        1. Detect moov location
        2. Apply faststart if needed
        3. Replace original or keep both

        Returns:
            {
                'success': bool,
                'optimized': bool,
                'original_path': str,
                'optimized_path': str,
                'metadata': dict
            }
        """
        try:
            # Step 1: Detect current state
            metadata = await self.detect_moov_location(file_path)

            if not metadata['needs_faststart']:
                logger.info(f"Video already optimized: {file_path}")
                return {
                    'success': True,
                    'optimized': False,
                    'original_path': file_path,
                    'optimized_path': file_path,
                    'metadata': metadata
                }

            # Step 2: Apply faststart
            logger.info(f"Optimizing video for streaming: {file_path}")
            success, optimized_path = await self.apply_faststart(file_path)

            if not success:
                return {
                    'success': False,
                    'optimized': False,
                    'original_path': file_path,
                    'optimized_path': None,
                    'metadata': metadata,
                    'error': 'Faststart failed'
                }

            # Step 3: Replace original if requested
            if replace_original:
                # Backup original temporarily
                backup_path = f"{file_path}.backup"
                os.rename(file_path, backup_path)

                try:
                    # Move optimized to original location
                    os.rename(optimized_path, file_path)

                    # Remove backup
                    os.remove(backup_path)

                    logger.info(f"Video optimized and replaced: {file_path}")

                    return {
                        'success': True,
                        'optimized': True,
                        'original_path': file_path,
                        'optimized_path': file_path,
                        'metadata': {**metadata, 'moov_location': 'start', 'needs_faststart': False}
                    }

                except Exception as e:
                    # Restore backup on error
                    logger.error(f"Error replacing original: {e}")
                    if os.path.exists(backup_path):
                        os.rename(backup_path, file_path)
                    if os.path.exists(optimized_path):
                        os.remove(optimized_path)
                    raise

            else:
                return {
                    'success': True,
                    'optimized': True,
                    'original_path': file_path,
                    'optimized_path': optimized_path,
                    'metadata': {**metadata, 'moov_location': 'start', 'needs_faststart': False}
                }

        except Exception as e:
            logger.error(f"Error optimizing video: {e}")
            return {
                'success': False,
                'optimized': False,
                'original_path': file_path,
                'optimized_path': None,
                'error': str(e)
            }


# Global instance
video_optimizer = VideoOptimizer()
