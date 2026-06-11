"""Phase 4: Overlay Agent — ASS subtitle generator for translated captions.

Generates .ass (Advanced SubStation Alpha) subtitles from the translation
segments and calculates the blur region for hiding original Chinese subtitles.
Replaces the previous Remotion-based approach with a pure FFmpeg solution.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Optional

import structlog

from ..db.models import Database, JobStatus
from ..utils.ffmpeg import FFmpegWrapper
from ..utils.manifest import JobManifest

logger = structlog.get_logger(__name__)


class OverlayAgent:
    """Generates subtitle files and calculates blur regions for synthesis."""

    def __init__(
        self,
        db: Database,
        workspace_dir: str | Path,
        **kwargs,  # Accept extra kwargs for backward compat
    ):
        self.db = db
        self.workspace_dir = Path(workspace_dir)
        self.ffmpeg = FFmpegWrapper()

    async def process(self, job_id: str) -> Optional[JobManifest]:
        """Generate .ass subtitles and calculate blur region.

        Flow:
        1. Validate job is in PROCESSING_OVERLAY status
        2. Load manifest to get translation segments and OCR data
        3. Generate .ass subtitle file with cinema-style formatting
        4. Calculate subtitle blur region from OCR bounding boxes
        5. Save results to manifest
        6. Transition to PROCESSING_SYNTHESIS
        """
        job = await self.db.get_job(job_id)
        if not job:
            logger.error("overlay.job_not_found", job_id=job_id)
            return None

        if job.status != JobStatus.PROCESSING_OVERLAY:
            logger.error(
                "overlay.invalid_status",
                job_id=job_id,
                status=job.status.value,
            )
            return None

        try:
            from ..server_progress import update_progress as _p
            def _progress(pct, msg):
                _p(job_id, "processing_overlay", pct, msg)

            manifest = JobManifest.load(job.manifest_path)
            manifest.set_phase_status("overlay", "running")

            ingestion = manifest.get_phase("ingestion")
            voice = manifest.get_phase("voice")
            spatial = manifest.get_phase("spatial")

            resolution = ingestion.get("resolution", "1920x1080")
            width, height = self._parse_resolution(resolution)
            fps = ingestion.get("fps", 30.0)

            # Set up overlay workspace
            overlay_dir = self.workspace_dir / "overlays" / job_id
            overlay_dir.mkdir(parents=True, exist_ok=True)

            # Check if watermark removal was requested — if so, skip blur entirely
            import json as _jm_ov
            _job_meta_ov = job.metadata if isinstance(job.metadata, dict) else {}
            if isinstance(job.metadata, str):
                try: _job_meta_ov = _jm_ov.loads(job.metadata)
                except: _job_meta_ov = {}
            _skip_blur = bool(_job_meta_ov.get("remove_watermark"))

            # Step 1: Calculate subtitle blur region from OCR
            if _skip_blur:
                sub_blur_region = None
                _progress(72, "⚡ Marca d'água removida — sem blur necessário!")
                logger.info("overlay.skip_blur", job_id=job_id, reason="remove_watermark")
            else:
                _progress(72, "🔍 Calculando região de legendas originais...")
                text_regions = spatial.get("text_regions", [])
                sub_blur_region = self._calculate_blur_region(text_regions, width, height)
                logger.info(
                    "overlay.blur_region",
                    job_id=job_id,
                    region=sub_blur_region,
                )

            # Step 2: Generate .ass subtitle file
            _progress(75, "📝 Gerando legendas traduzidas (.ass)...")
            translation_segments = voice.get("translation", {}).get("segments", [])

            ass_path = overlay_dir / "subtitles.ass"

            if _skip_blur:
                # Watermark removed — no blur region. Place subtitle slightly
                # below the vertical center (~58% from top for portrait video).
                sub_y = int(height * 0.58)
                sub_h = int(height * 0.12)  # ~12% height band
            else:
                sub_y = sub_blur_region.get("y", int(height * 0.85)) if sub_blur_region else int(height * 0.85)
                sub_h = sub_blur_region.get("h", height - sub_y) if sub_blur_region else (height - sub_y)

            self.ffmpeg.generate_ass_subtitles(
                segments=translation_segments,
                output_path=ass_path,
                video_width=width,
                video_height=height,
                sub_blur_y=sub_y,
                sub_blur_h=sub_h,
            )

            _progress(80, f"✅ {len(translation_segments)} legendas geradas!")
            logger.info(
                "overlay.subtitles_generated",
                job_id=job_id,
                segments=len(translation_segments),
                ass_path=str(ass_path),
            )

            # Step 3: Build captions config for metadata
            captions_config = self._build_captions_config(
                segments=translation_segments,
                fps=fps,
            )

            # Update manifest with new overlay data
            manifest.set_overlay_result(
                overlay_video_path=None,
                ass_subtitle_path=str(ass_path),
                sub_blur_region=sub_blur_region,
                captions_config=captions_config,
                text_overlay_config=[],
            )

            # Transition to synthesis
            await self.db.update_job_status(job_id, JobStatus.PROCESSING_SYNTHESIS)

            _progress(85, "✅ Overlay pronto — iniciando síntese!")
            logger.info(
                "overlay.complete",
                job_id=job_id,
                ass_path=str(ass_path),
                blur_region=sub_blur_region,
            )
            return manifest

        except Exception as e:
            error_msg = f"Overlay processing failed: {str(e)}"
            logger.exception("overlay.error", job_id=job_id, error=error_msg)
            await self.db.update_job_status(
                job_id, JobStatus.ERROR, error_message=error_msg
            )
            return None

    def _calculate_blur_region(
        self,
        text_regions: list[dict[str, Any]],
        video_width: int,
        video_height: int,
    ) -> Optional[dict[str, int]]:
        """Calculate the region to blur for hiding original subtitles.

        Finds OCR text regions in the bottom 40% of the video and calculates
        a bounding box that covers all of them.
        """
        if not text_regions:
            # Default: blur bottom 15% of video
            blur_y = int(video_height * 0.85)
            return {"y": blur_y, "h": video_height - blur_y}

        # Filter regions in the bottom 40% of the video
        threshold_y = video_height * 0.60
        bottom_regions = [
            r for r in text_regions
            if r.get("bbox", {}).get("y", 0) > threshold_y
        ]

        if not bottom_regions:
            # No text in bottom region — still blur bottom 12% as safety
            blur_y = int(video_height * 0.88)
            return {"y": blur_y, "h": video_height - blur_y}

        # Find the topmost point of bottom text regions
        min_y = min(r["bbox"]["y"] for r in bottom_regions)
        # Add 15px padding above
        blur_y = max(0, min_y - 15)

        return {"y": blur_y, "h": video_height - blur_y}

    def _build_captions_config(
        self,
        segments: list[dict[str, Any]],
        fps: float,
    ) -> list[dict[str, Any]]:
        """Convert translation segments into caption configs for metadata."""
        captions = []
        for i, seg in enumerate(segments):
            start_frame = int(seg.get("start", 0) * fps)
            end_frame = int(seg.get("end", 0) * fps)
            text = seg.get("translated", seg.get("text", ""))

            if not text or end_frame <= start_frame:
                continue

            captions.append({
                "id": f"caption_{i:04d}",
                "text": text,
                "startFrame": start_frame,
                "endFrame": end_frame,
            })

        return captions

    def _parse_resolution(self, resolution: str) -> tuple[int, int]:
        """Parse resolution string like '1920x1080' into (width, height)."""
        try:
            parts = resolution.split("x")
            return int(parts[0]), int(parts[1])
        except (ValueError, IndexError):
            return 1920, 1080
