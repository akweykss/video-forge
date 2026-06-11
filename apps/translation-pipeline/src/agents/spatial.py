"""Phase 2: Spatial Agent — Fast subtitle region detection.

Extracts a small number of sample frames (5), runs OCR only on the
bottom 40% of each frame to find subtitle text, determines the
subtitle bounding box, and outputs coordinates for blur overlay.

Optimized for speed: ~10 seconds instead of ~2 minutes.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
import structlog

from ..db.models import Database, JobStatus
from ..utils.manifest import JobManifest

logger = structlog.get_logger(__name__)

# How many frames to sample for subtitle detection
_SAMPLE_FRAMES = 5


class SpatialAgent:
    """Detects subtitle region in video using minimal frame sampling."""

    def __init__(
        self,
        db: Database,
        workspace_dir: str | Path,
        ocr_lang: str = "ch",
        sample_fps: float = 0.5,  # kept for compat, ignored
        confidence_threshold: float = 0.5,
    ):
        self.db = db
        self.workspace_dir = Path(workspace_dir)
        self.ocr_lang = ocr_lang
        self.confidence_threshold = confidence_threshold
        self._ocr = None

    def _get_ocr(self):
        """Lazy-initialize EasyOCR engine."""
        if self._ocr is None:
            try:
                import easyocr
                lang_map = {"ch": ["ch_sim", "en"], "en": ["en"]}
                langs = lang_map.get(self.ocr_lang, ["ch_sim", "en"])
                self._ocr = easyocr.Reader(langs, gpu=False, verbose=False)
                self._ocr_type = "easyocr"
                logger.info("spatial.ocr_initialized", engine="easyocr", langs=langs)
            except ImportError:
                try:
                    from paddleocr import PaddleOCR
                    self._ocr = PaddleOCR(
                        use_angle_cls=True, lang=self.ocr_lang,
                        show_log=False, use_gpu=False,
                    )
                    self._ocr_type = "paddleocr"
                    logger.info("spatial.ocr_initialized", engine="paddleocr")
                except ImportError:
                    self._ocr = None
                    self._ocr_type = "none"
                    logger.warning("spatial.no_ocr_engine")
        return self._ocr

    async def process(self, job_id: str) -> Optional[JobManifest]:
        """Detect subtitle region using 5 sample frames.

        Flow:
        1. Extract 5 evenly-spaced frames from the video
        2. Run OCR only on bottom 40% of each frame
        3. Find the most common subtitle Y position
        4. Output blur region coordinates
        5. Transition to PROCESSING_AUDIO
        """
        job = await self.db.get_job(job_id)
        if not job:
            logger.error("spatial.job_not_found", job_id=job_id)
            return None

        if job.status != JobStatus.PROCESSING_OCR:
            logger.error(
                "spatial.invalid_status",
                job_id=job_id,
                status=job.status.value,
            )
            return None

        try:
            from ..server_progress import update_progress as _p
            def _progress(pct, msg):
                _p(job_id, "processing_ocr", pct, msg)

            manifest = JobManifest.load(job.manifest_path)
            manifest.set_phase_status("spatial", "running")

            ingestion = manifest.get_phase("ingestion")
            video_path = ingestion["video_path"]
            duration = ingestion.get("duration_seconds", 0)

            # Set up frames directory
            frames_dir = self.workspace_dir / "frames" / job_id
            frames_dir.mkdir(parents=True, exist_ok=True)

            # Step 1: Extract only 5 sample frames
            _progress(22, f"🎞️ Extraindo {_SAMPLE_FRAMES} frames de amostra...")
            frame_paths = await asyncio.get_event_loop().run_in_executor(
                None,
                self._extract_sample_frames,
                video_path,
                frames_dir,
                duration,
            )
            _progress(28, f"✅ {len(frame_paths)} frames extraídos!")

            # Step 2: Run OCR on bottom region of each frame
            _progress(30, f"👁️ Detectando legendas em {len(frame_paths)} frames...")
            text_regions = await asyncio.get_event_loop().run_in_executor(
                None,
                self._detect_subtitle_region,
                frame_paths,
            )

            # Step 3: Deduplicate texts
            unique_texts = self._deduplicate_texts(text_regions)

            _progress(40, f"✅ OCR completo — {len(unique_texts)} textos detectados")
            logger.info(
                "spatial.ocr_complete",
                job_id=job_id,
                total_detections=len(text_regions),
                unique_texts=len(unique_texts),
                sample_frames=len(frame_paths),
            )

            # Update manifest
            manifest.set_spatial_result(
                frames_dir=str(frames_dir),
                frame_count=len(frame_paths),
                text_regions=text_regions,
                unique_texts=unique_texts,
            )

            # Transition to audio processing
            await self.db.update_job_status(job_id, JobStatus.PROCESSING_AUDIO)

            return manifest

        except Exception as e:
            error_msg = f"Spatial processing failed: {str(e)}"
            logger.exception("spatial.error", job_id=job_id, error=error_msg)
            await self.db.update_job_status(
                job_id, JobStatus.ERROR, error_message=error_msg
            )
            return None

    def _extract_sample_frames(
        self,
        video_path: str,
        output_dir: Path,
        duration: float,
    ) -> list[dict[str, Any]]:
        """Extract exactly N evenly-spaced frames from the video.

        For a 2-min video this extracts 5 frames instead of 60+.
        """
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        actual_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if total_frames <= 0:
            total_frames = int(duration * actual_fps)

        # Pick N evenly spaced frame indices (skip first/last 10%)
        start_frame = int(total_frames * 0.1)
        end_frame = int(total_frames * 0.9)
        step = max(1, (end_frame - start_frame) // _SAMPLE_FRAMES)

        target_indices = [
            start_frame + i * step
            for i in range(_SAMPLE_FRAMES)
            if start_frame + i * step < end_frame
        ]

        frames: list[dict[str, Any]] = []
        frame_idx = 0
        target_set = set(target_indices)

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx in target_set:
                timestamp = frame_idx / actual_fps
                frame_filename = f"frame_{frame_idx:06d}.png"
                frame_path = output_dir / frame_filename
                cv2.imwrite(str(frame_path), frame)
                frames.append({
                    "path": str(frame_path),
                    "frame_idx": frame_idx,
                    "timestamp": round(timestamp, 3),
                    "height": frame.shape[0],
                    "width": frame.shape[1],
                })

                if len(frames) >= _SAMPLE_FRAMES:
                    break

            frame_idx += 1

        cap.release()

        logger.info(
            "spatial.sample_frames_extracted",
            total_frames=total_frames,
            sampled=len(frames),
            indices=target_indices[:5],
        )
        return frames

    def _detect_subtitle_region(
        self,
        frame_data: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Run OCR only on bottom 40% of each frame to find subtitles.

        Subtitles in Douyin/TikTok videos are always in the lower portion.
        By cropping to bottom 40%, we:
        - Run OCR on a smaller image = faster
        - Avoid false positives from watermarks/logos at top
        """
        ocr = self._get_ocr()
        if ocr is None:
            logger.warning("spatial.skipping_ocr", reason="no OCR engine")
            return []

        all_regions: list[dict[str, Any]] = []

        for frame_info in frame_data:
            frame_path = frame_info["path"]
            full_height = frame_info.get("height", 1080)

            try:
                # Read frame and crop to bottom 40%
                img = cv2.imread(frame_path)
                if img is None:
                    continue

                h, w = img.shape[:2]
                crop_y = int(h * 0.6)  # Start at 60% from top
                bottom_crop = img[crop_y:h, 0:w]

                if self._ocr_type == "easyocr":
                    results = ocr.readtext(bottom_crop)
                    for (bbox_raw, text, confidence) in results:
                        if confidence < self.confidence_threshold:
                            continue
                        xs = [p[0] for p in bbox_raw]
                        ys = [p[1] for p in bbox_raw]
                        # Offset Y back to full-frame coordinates
                        simple_bbox = {
                            "x": int(min(xs)),
                            "y": int(min(ys)) + crop_y,
                            "w": int(max(xs) - min(xs)),
                            "h": int(max(ys) - min(ys)),
                            "polygon": [[int(p[0]), int(p[1]) + crop_y] for p in bbox_raw],
                        }
                        all_regions.append({
                            "bbox": simple_bbox,
                            "text": text,
                            "confidence": round(float(confidence), 4),
                            "frame_idx": frame_info["frame_idx"],
                            "timestamp": frame_info["timestamp"],
                            "frame_path": frame_path,
                        })

                else:  # paddleocr
                    result = ocr.ocr(bottom_crop, cls=True)
                    if not result or not result[0]:
                        continue
                    for line in result[0]:
                        bbox = line[0]
                        text = line[1][0]
                        confidence = float(line[1][1])
                        if confidence < self.confidence_threshold:
                            continue
                        xs = [p[0] for p in bbox]
                        ys = [p[1] for p in bbox]
                        simple_bbox = {
                            "x": int(min(xs)),
                            "y": int(min(ys)) + crop_y,
                            "w": int(max(xs) - min(xs)),
                            "h": int(max(ys) - min(ys)),
                            "polygon": [[int(p[0]), int(p[1]) + crop_y] for p in bbox],
                        }
                        all_regions.append({
                            "bbox": simple_bbox,
                            "text": text,
                            "confidence": round(confidence, 4),
                            "frame_idx": frame_info["frame_idx"],
                            "timestamp": frame_info["timestamp"],
                            "frame_path": frame_path,
                        })

            except Exception as e:
                logger.warning(
                    "spatial.ocr_frame_error",
                    frame=frame_path,
                    error=str(e),
                )
                continue

        logger.info(
            "spatial.subtitle_detection_done",
            detections=len(all_regions),
            frames_analyzed=len(frame_data),
        )
        return all_regions

    def _deduplicate_texts(
        self,
        text_regions: list[dict[str, Any]],
        similarity_threshold: float = 0.8,
    ) -> list[str]:
        """Deduplicate detected texts across frames."""
        if not text_regions:
            return []

        text_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for region in text_regions:
            text_groups[region["text"]].append(region)

        # Keep texts that appear in 2+ frames or are long enough
        unique_texts: list[str] = []
        for text, occurrences in text_groups.items():
            if len(occurrences) >= 2 or len(text) >= 4:
                unique_texts.append(text)

        unique_texts.sort(
            key=lambda t: len(text_groups[t]),
            reverse=True,
        )

        return unique_texts
