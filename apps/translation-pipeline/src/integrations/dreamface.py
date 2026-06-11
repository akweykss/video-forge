"""DreamFace (NewportAI) Lip Sync API client.

Provides async methods to generate lip-synced avatar videos from
a character image + TTS audio via the DreamFace API.
"""

import asyncio
import time
from pathlib import Path
from typing import Optional

import httpx
import structlog

logger = structlog.get_logger(__name__)

# ── Constants ────────────────────────────────────────────────────────
BASE_URL = "https://api.newportai.com"
LIPSYNC_IMAGE_ENDPOINT = f"{BASE_URL}/api/v1/lipsync-image"
LIPSYNC_VIDEO_ENDPOINT = f"{BASE_URL}/api/v1/lipsync-video"
JOBS_ENDPOINT = f"{BASE_URL}/api/v1/jobs"

POLL_INTERVAL_SECS = 5
MAX_POLL_TIMEOUT_SECS = 600  # 10 minutes


class DreamFaceError(Exception):
    """Raised when the DreamFace API returns an error."""

    def __init__(self, message: str, status_code: int = 0, response: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.response = response or {}


class DreamFaceClient:
    """Async client for the DreamFace / NewportAI lip-sync API.

    Usage::

        client = DreamFaceClient(api_key="sk-...")
        task_id = await client.lipsync_image(
            image_url="https://example.com/avatar.png",
            audio_url="https://example.com/narration.mp3",
        )
        result = await client.wait_for_job(task_id)
        local_path = await client.download_result(result["video_url"], Path("output.mp4"))
    """

    def __init__(self, api_key: str, timeout: float = 60.0):
        self.api_key = api_key
        self._timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    # ── Public API ────────────────────────────────────────────────────

    async def lipsync_image(
        self,
        image_url: str,
        audio_url: str,
        video_width: int = 1080,
        video_height: int = 1920,
        video_enhance: int = 1,
        webhook: Optional[str] = None,
    ) -> str:
        """Create a lip-synced video from a still image + audio.

        Args:
            image_url: Public URL of the character image.
            audio_url: Public URL of the TTS audio file.
            video_width: Output video width (default 1080 for 9:16).
            video_height: Output video height (default 1920 for 9:16).
            video_enhance: Whether to enhance quality (0 or 1).
            webhook: Optional callback URL for async notification.

        Returns:
            The task/request ID for polling.
        """
        payload: dict = {
            "formState": {
                "image": image_url,
                "audio": audio_url,
            },
            "videoParams": {
                "video_width": video_width,
                "video_height": video_height,
                "video_enhance": video_enhance,
            },
        }
        if webhook:
            payload["webhook"] = webhook

        logger.info(
            "dreamface.lipsync_image.start",
            image_url=image_url[:80],
            audio_url=audio_url[:80],
            resolution=f"{video_width}x{video_height}",
        )

        data = await self._post(LIPSYNC_IMAGE_ENDPOINT, payload)
        task_id = data.get("requestId") or data.get("taskId") or data.get("id", "")
        if not task_id:
            raise DreamFaceError(
                f"No task ID in response: {data}", response=data
            )

        logger.info("dreamface.lipsync_image.submitted", task_id=task_id)
        return task_id

    async def lipsync_video(
        self,
        video_url: str,
        audio_url: str,
        webhook: Optional[str] = None,
    ) -> str:
        """Replace audio in an existing video with lip-synced version.

        Args:
            video_url: Public URL of the source video with face.
            audio_url: Public URL of the new audio.
            webhook: Optional callback URL.

        Returns:
            The task/request ID for polling.
        """
        payload: dict = {
            "formState": {
                "video": video_url,
                "audio": audio_url,
            },
        }
        if webhook:
            payload["webhook"] = webhook

        logger.info(
            "dreamface.lipsync_video.start",
            video_url=video_url[:80],
            audio_url=audio_url[:80],
        )

        data = await self._post(LIPSYNC_VIDEO_ENDPOINT, payload)
        task_id = data.get("requestId") or data.get("taskId") or data.get("id", "")
        if not task_id:
            raise DreamFaceError(
                f"No task ID in response: {data}", response=data
            )

        logger.info("dreamface.lipsync_video.submitted", task_id=task_id)
        return task_id

    async def get_job(self, request_id: str) -> dict:
        """Check the status of a lip-sync job.

        Returns:
            Dict with at least: status, and when done: video_url / output_url.
        """
        url = f"{JOBS_ENDPOINT}/{request_id}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(url, headers=self._headers)

        if resp.status_code == 404:
            return {"status": "not_found", "request_id": request_id}

        if resp.status_code != 200:
            raise DreamFaceError(
                f"Job poll failed: HTTP {resp.status_code}",
                status_code=resp.status_code,
                response=resp.json() if resp.content else {},
            )

        return resp.json()

    async def wait_for_job(
        self,
        request_id: str,
        timeout: float = MAX_POLL_TIMEOUT_SECS,
        poll_interval: float = POLL_INTERVAL_SECS,
        progress_callback: Optional[callable] = None,
    ) -> dict:
        """Poll until job completes or fails.

        Args:
            request_id: The task ID returned by lipsync_image/video.
            timeout: Max seconds to wait.
            poll_interval: Seconds between polls.
            progress_callback: Optional fn(status_dict) called each poll.

        Returns:
            The final job result dict with video URL.

        Raises:
            DreamFaceError: If job fails or times out.
        """
        start = time.monotonic()
        attempt = 0

        while True:
            elapsed = time.monotonic() - start
            if elapsed > timeout:
                raise DreamFaceError(
                    f"Job {request_id} timed out after {timeout}s"
                )

            attempt += 1
            result = await self.get_job(request_id)
            status = (
                result.get("status", "")
                .lower()
                .replace(" ", "_")
            )

            if progress_callback:
                try:
                    progress_callback(result)
                except Exception:
                    pass

            logger.debug(
                "dreamface.poll",
                request_id=request_id,
                status=status,
                attempt=attempt,
                elapsed=f"{elapsed:.0f}s",
            )

            # Terminal states
            if status in ("completed", "done", "success", "finished"):
                video_url = (
                    result.get("video_url")
                    or result.get("output_url")
                    or result.get("result", {}).get("video_url")
                    or result.get("result", {}).get("url")
                )
                if video_url:
                    result["video_url"] = video_url
                logger.info(
                    "dreamface.job_completed",
                    request_id=request_id,
                    video_url=str(video_url)[:80] if video_url else "N/A",
                    elapsed=f"{elapsed:.0f}s",
                )
                return result

            if status in ("failed", "error", "cancelled"):
                error_msg = result.get("error", result.get("message", "Unknown error"))
                raise DreamFaceError(
                    f"Job {request_id} failed: {error_msg}",
                    response=result,
                )

            # Still processing
            await asyncio.sleep(poll_interval)

    async def download_result(
        self,
        video_url: str,
        output_path: Path,
    ) -> Path:
        """Download the generated lip-sync video.

        Args:
            video_url: The URL of the generated video.
            output_path: Local path to save the video.

        Returns:
            The local Path where the video was saved.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)

        logger.info(
            "dreamface.download.start",
            url=video_url[:80],
            output=str(output_path),
        )

        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            resp = await client.get(video_url)
            resp.raise_for_status()
            output_path.write_bytes(resp.content)

        size_mb = output_path.stat().st_size / (1024 * 1024)
        logger.info(
            "dreamface.download.done",
            output=str(output_path),
            size_mb=f"{size_mb:.1f}",
        )
        return output_path

    # ── Private helpers ───────────────────────────────────────────────

    async def _post(self, url: str, payload: dict) -> dict:
        """Send a POST request and return parsed JSON."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(url, json=payload, headers=self._headers)

        if resp.status_code not in (200, 201, 202):
            body = resp.json() if resp.content else {}
            raise DreamFaceError(
                f"API error: HTTP {resp.status_code} — {body}",
                status_code=resp.status_code,
                response=body,
            )

        return resp.json()
