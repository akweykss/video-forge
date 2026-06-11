"""Job manifest handler — JSON state machine for tracking each pipeline phase.

The manifest is a JSON file stored alongside the job's workspace, containing
all intermediate paths, OCR results, translations, audio paths, and final
output metadata. Each agent reads/writes to the manifest as the job progresses.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import structlog

logger = structlog.get_logger(__name__)


class JobManifest:
    """JSON-backed state machine for a single translation job.

    The manifest tracks every intermediate artifact produced during
    processing, enabling restartability and debugging.
    """

    def __init__(self, manifest_path: str | Path):
        self.path = Path(manifest_path)
        self._data: dict[str, Any] = {}

    @classmethod
    def create(
        cls,
        job_id: str,
        workspace_dir: str | Path,
        source_url: str,
        source_platform: str = "douyin",
        target_language: str = "pt-BR",
    ) -> JobManifest:
        """Create a new manifest file for a job."""
        workspace = Path(workspace_dir)
        workspace.mkdir(parents=True, exist_ok=True)

        manifest_path = workspace / "manifest.json"
        manifest = cls(manifest_path)

        now = datetime.now(timezone.utc).isoformat()
        manifest._data = {
            "version": "1.0.0",
            "job_id": job_id,
            "source_url": source_url,
            "source_platform": source_platform,
            "target_language": target_language,
            "created_at": now,
            "updated_at": now,
            # Phase 1 — Ingestion
            "ingestion": {
                "status": "pending",
                "video_path": None,
                "audio_path": None,
                "video_info": {},
                "duration_seconds": None,
                "resolution": None,
                "fps": None,
            },
            # Phase 2 — Spatial (OCR)
            "spatial": {
                "status": "pending",
                "frames_dir": None,
                "frame_count": 0,
                "text_regions": [],  # [{bbox, text, confidence, frame_idx, timestamp}]
                "unique_texts": [],  # Deduplicated text blocks
            },
            # Phase 3 — Voice (Transcription + Translation + TTS)
            "voice": {
                "status": "pending",
                "transcription": {
                    "segments": [],  # [{start, end, text, speaker}]
                    "full_text": None,
                    "language_detected": None,
                },
                "translation": {
                    "segments": [],  # [{start, end, original, translated}]
                    "full_text": None,
                    "text_overlays": [],  # Translated OCR texts
                },
                "tts": {
                    "audio_segments": [],  # [{path, start, end, text}]
                    "merged_audio_path": None,
                    "voice_id": None,
                },
            },
            # Phase 4 — Overlay (Remotion)
            "overlay": {
                "status": "pending",
                "overlay_video_path": None,
                "captions_config": [],  # [{text, start_frame, end_frame, style}]
                "text_overlay_config": [],  # [{original, translated, bbox, frames}]
                "remotion_bundle_path": None,
            },
            # Phase 5 — Synthesis (FFmpeg)
            "synthesis": {
                "status": "pending",
                "output_video_path": None,
                "lut_applied": False,
                "motion_interpolation": False,
                "film_grain": False,
                "metadata_purged": False,
                "final_resolution": None,
                "final_duration": None,
                "final_size_bytes": None,
            },
            # Error tracking
            "errors": [],
        }

        manifest.save()
        logger.info("manifest.created", job_id=job_id, path=str(manifest_path))
        return manifest

    @classmethod
    def load(cls, manifest_path: str | Path) -> JobManifest:
        """Load an existing manifest from disk."""
        manifest = cls(manifest_path)
        path = Path(manifest_path)
        if not path.exists():
            raise FileNotFoundError(f"Manifest not found: {manifest_path}")

        with open(path, "r", encoding="utf-8") as f:
            manifest._data = json.load(f)

        logger.debug("manifest.loaded", job_id=manifest.job_id)
        return manifest

    def save(self) -> None:
        """Persist the manifest to disk."""
        self._data["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.path.parent.mkdir(parents=True, exist_ok=True)

        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2, ensure_ascii=False)

        logger.debug("manifest.saved", job_id=self.job_id)

    # ── Property accessors ─────────────────────────────────────────

    @property
    def job_id(self) -> str:
        return self._data["job_id"]

    @property
    def source_url(self) -> str:
        return self._data["source_url"]

    @property
    def target_language(self) -> str:
        return self._data["target_language"]

    @property
    def workspace_dir(self) -> Path:
        return self.path.parent

    # ── Phase getters/setters ──────────────────────────────────────

    def get_phase(self, phase: str) -> dict[str, Any]:
        """Get data for a pipeline phase."""
        if phase not in self._data:
            raise KeyError(f"Unknown phase: {phase}")
        return self._data[phase]

    def update_phase(self, phase: str, updates: dict[str, Any]) -> None:
        """Update fields within a pipeline phase."""
        if phase not in self._data:
            raise KeyError(f"Unknown phase: {phase}")
        self._data[phase].update(updates)
        self.save()

    def set_phase_status(self, phase: str, status: str) -> None:
        """Set the status of a pipeline phase (pending/running/done/error)."""
        self.update_phase(phase, {"status": status})

    # ── Ingestion helpers ──────────────────────────────────────────

    def set_ingestion_result(
        self,
        video_path: str,
        audio_path: Optional[str],
        video_info: dict[str, Any],
        duration: float,
        resolution: str,
        fps: float,
    ) -> None:
        self.update_phase(
            "ingestion",
            {
                "status": "done",
                "video_path": video_path,
                "audio_path": audio_path,
                "video_info": video_info,
                "duration_seconds": duration,
                "resolution": resolution,
                "fps": fps,
            },
        )

    # ── Spatial helpers ────────────────────────────────────────────

    def set_spatial_result(
        self,
        frames_dir: str,
        frame_count: int,
        text_regions: list[dict[str, Any]],
        unique_texts: list[str],
    ) -> None:
        self.update_phase(
            "spatial",
            {
                "status": "done",
                "frames_dir": frames_dir,
                "frame_count": frame_count,
                "text_regions": text_regions,
                "unique_texts": unique_texts,
            },
        )

    # ── Voice helpers ──────────────────────────────────────────────

    def set_transcription(
        self,
        segments: list[dict[str, Any]],
        full_text: str,
        language: str,
    ) -> None:
        self._data["voice"]["transcription"] = {
            "segments": segments,
            "full_text": full_text,
            "language_detected": language,
        }
        self.save()

    def set_translation(
        self,
        segments: list[dict[str, Any]],
        full_text: str,
        text_overlays: Optional[list[dict[str, Any]]] = None,
    ) -> None:
        self._data["voice"]["translation"] = {
            "segments": segments,
            "full_text": full_text,
            "text_overlays": text_overlays or [],
        }
        self.save()

    def set_tts_result(
        self,
        audio_segments: list[dict[str, Any]],
        merged_audio_path: str,
        voice_id: str,
        speed_factor: float = 1.0,
        time_map: Optional[list[dict[str, float]]] = None,
        segment_speeds: Optional[list[dict[str, Any]]] = None,
    ) -> None:
        self._data["voice"]["tts"] = {
            "audio_segments": audio_segments,
            "merged_audio_path": merged_audio_path,
            "voice_id": voice_id,
            "speed_factor": speed_factor,
            "time_map": time_map or [],
            "segment_speeds": segment_speeds or [],
        }
        self.update_phase("voice", {"status": "done"})

    # ── Overlay helpers ────────────────────────────────────────────

    def set_overlay_result(
        self,
        overlay_video_path: Optional[str] = None,
        captions_config: Optional[list[dict[str, Any]]] = None,
        text_overlay_config: Optional[list[dict[str, Any]]] = None,
        ass_subtitle_path: Optional[str] = None,
        sub_blur_region: Optional[dict[str, int]] = None,
    ) -> None:
        self.update_phase(
            "overlay",
            {
                "status": "done",
                "overlay_video_path": overlay_video_path,
                "captions_config": captions_config or [],
                "text_overlay_config": text_overlay_config or [],
                "ass_subtitle_path": ass_subtitle_path,
                "sub_blur_region": sub_blur_region,
            },
        )

    # ── Synthesis helpers ──────────────────────────────────────────

    def set_synthesis_result(
        self,
        output_video_path: str,
        resolution: str,
        duration: float,
        size_bytes: int,
        lut: bool = False,
        minterp: bool = False,
        grain: bool = False,
    ) -> None:
        self.update_phase(
            "synthesis",
            {
                "status": "done",
                "output_video_path": output_video_path,
                "lut_applied": lut,
                "motion_interpolation": minterp,
                "film_grain": grain,
                "metadata_purged": True,
                "final_resolution": resolution,
                "final_duration": duration,
                "final_size_bytes": size_bytes,
            },
        )

    # ── Error tracking ─────────────────────────────────────────────

    def add_error(self, phase: str, error: str, traceback: Optional[str] = None) -> None:
        """Record an error that occurred during processing."""
        self._data["errors"].append(
            {
                "phase": phase,
                "error": error,
                "traceback": traceback,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )
        self.set_phase_status(phase, "error")
        logger.error("manifest.error", job_id=self.job_id, phase=phase, error=error)

    # ── Serialization ──────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        """Return the full manifest as a dict."""
        return self._data.copy()
