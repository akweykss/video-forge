"""Lip Sync Agent — orchestrates DreamFace lip sync generation.

Given TTS audio + character avatar VIDEO, produces a video of the character
speaking with synchronized lip movements via the official DreamAPI SDK.

Uses `talking_face_from_file` which uploads files directly to DreamFace —
NO public URL or ngrok needed.
"""

import asyncio
import shutil
import logging
from pathlib import Path
from typing import Optional, Callable

import structlog

logger = structlog.get_logger(__name__)


class LipSyncAgent:
    """Generates lip-synced avatar videos via the DreamAPI SDK.

    The user's avatar is a VIDEO of their character. DreamFace replaces
    the lip movements in the video to match the TTS audio.

    Uses the official `dream-api` Python SDK with `talking_face_from_file`
    which handles file upload internally — no public URLs needed.
    """

    def __init__(
        self,
        workspace_dir: Path,
        dreamface_api_key: str,
    ):
        self.workspace = Path(workspace_dir)
        self.api_key = dreamface_api_key

    async def process(
        self,
        job_id: str,
        audio_path: Path,
        avatar_video_path: Path,
        progress_callback: Optional[Callable] = None,
    ) -> Optional[Path]:
        """Generate a lip-synced video from avatar video + TTS audio.

        Uses the DreamAPI SDK `talking_face_from_file` which uploads
        files directly to DreamFace servers — no public URL needed.

        Args:
            job_id: Pipeline job identifier.
            audio_path: Local path to the TTS audio file.
            avatar_video_path: Local path to the character avatar video.
            progress_callback: Optional fn(phase, progress_pct, detail_msg).

        Returns:
            Path to the downloaded lip-synced video, or None on failure.
        """
        from dreamapi import DreamAPI, VideoParam

        # Prepare output directory
        lipsync_dir = self.workspace / "lipsync" / job_id
        lipsync_dir.mkdir(parents=True, exist_ok=True)
        output_path = lipsync_dir / "avatar_lipsync.mp4"
        log_path = lipsync_dir / "dreamapi.log"

        logger.info(
            "lipsync.start",
            job_id=job_id,
            avatar=str(avatar_video_path),
            audio=str(audio_path),
        )

        if progress_callback:
            progress_callback("lipsync", 10, "Enviando arquivos para DreamFace...")

        try:
            # Initialize DreamAPI SDK
            api = DreamAPI(self.api_key, str(log_path))

            # Video params: 0 = auto (keep original), no enhance
            video_param = VideoParam(
                video_bitrate=0,
                video_width=0,
                video_height=0,
                video_enhance=0,
            ).to_dict()

            # Submit lip sync job — uploads files directly
            # This is a blocking call, so run in executor
            loop = asyncio.get_event_loop()

            if progress_callback:
                progress_callback("lipsync", 20, "Enviando vídeo e áudio para DreamFace...")

            task_id = await loop.run_in_executor(
                None,
                api.talking_face_from_file,
                str(avatar_video_path),
                str(audio_path),
                video_param,
            )

            if not task_id:
                logger.error("lipsync.no_task_id", job_id=job_id)
                return None

            logger.info("lipsync.submitted", job_id=job_id, task_id=task_id)

            if progress_callback:
                progress_callback("lipsync", 40, f"Aguardando DreamFace processar (task: {str(task_id)[:12]}...)")

            # Poll for result — blocking, run in executor
            result = await loop.run_in_executor(
                None,
                api.poll_task_result,
                task_id,
            )

            if not result:
                logger.error("lipsync.poll_no_result", job_id=job_id, task_id=task_id)
                return None

            logger.info("lipsync.poll_result", job_id=job_id, result_type=type(result).__name__, result_keys=str(result)[:200] if isinstance(result, dict) else str(result)[:200])

            if progress_callback:
                progress_callback("lipsync", 80, "Baixando vídeo com lip sync...")

            # Extract video URL from result
            # DreamFace returns: {'videos': [{'videoUrl': '...', 'videoType': 'mp4'}], 'task': {...}}
            video_url = None
            if isinstance(result, dict):
                # Primary: result['videos'][0]['videoUrl']
                videos = result.get("videos", [])
                if videos and isinstance(videos, list) and len(videos) > 0:
                    video_url = videos[0].get("videoUrl") or videos[0].get("video_url")

                # Fallback: direct keys
                if not video_url:
                    video_url = (
                        result.get("videoUrl")
                        or result.get("video_url")
                        or result.get("url")
                        or result.get("output_url")
                    )

                # Fallback: nested 'data' structure
                if not video_url and "data" in result:
                    data = result["data"]
                    if isinstance(data, dict):
                        vids = data.get("videos", [])
                        if vids and isinstance(vids, list):
                            video_url = vids[0].get("videoUrl") or vids[0].get("video_url")
                        if not video_url:
                            video_url = data.get("videoUrl") or data.get("video_url")

            elif isinstance(result, str):
                if result.startswith("http"):
                    video_url = result

            if not video_url:
                logger.error(
                    "lipsync.no_video_url",
                    job_id=job_id,
                    result=str(result)[:500],
                )
                return None

            # Download the result video
            import requests
            resp = requests.get(video_url, stream=True, timeout=120)
            resp.raise_for_status()

            with open(output_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)

            size_mb = output_path.stat().st_size / (1024 * 1024)
            logger.info(
                "lipsync.completed",
                job_id=job_id,
                output=str(output_path),
                size_mb=f"{size_mb:.1f}",
            )

            if progress_callback:
                progress_callback("lipsync", 100, "Lip sync concluído!")

            return output_path

        except Exception as e:
            logger.error(
                "lipsync.error",
                job_id=job_id,
                error=str(e),
                error_type=type(e).__name__,
            )
            # Check DreamAPI log for details
            if log_path.exists():
                log_content = log_path.read_text()
                if log_content.strip():
                    logger.error("lipsync.dreamapi_log", log=log_content[-500:])
            raise
