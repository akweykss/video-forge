"""Watermark Remover Agent — removes video watermarks via NewportAI API.

Uses the same API platform as DreamFace (NewportAI). Submits a video URL
for watermark removal and polls until the clean video is ready.

API: POST https://api.newportai.com/api/async/video_watermark_remover
Poll: POST https://api.newportai.com/api/getAsyncResult  (discovered from official SDK)
"""

import asyncio
import time
from pathlib import Path
from typing import Optional, Callable

import httpx
import structlog

logger = structlog.get_logger(__name__)

# ── Constants ────────────────────────────────────────────────────────
SUBMIT_URL = "https://api.newportai.com/api/async/video_watermark_remover"
POLL_URL   = "https://api.newportai.com/api/getAsyncResult"  # ← correct endpoint per SDK

POLL_INTERVAL_SECS   = 10
MAX_POLL_TIMEOUT_SECS = 1500  # 25 min — vídeos longos demoram mais que 10min


class WatermarkRemoverError(Exception):
    """Raised when watermark removal fails."""

    def __init__(self, message: str, response: dict | None = None):
        super().__init__(message)
        self.response = response or {}


class WatermarkRemover:
    """Async client for NewportAI Video Watermark Remover API.

    Usage::

        remover = WatermarkRemover(api_key="sk-...")
        clean_url = await remover.remove(
            video_url="https://cdn.douyin.com/video.mp4",
            progress_callback=lambda pct, msg: print(f"{pct}% {msg}"),
        )
        local_path = await remover.download(clean_url, Path("clean.mp4"))
    """

    def __init__(self, api_key: str, timeout: float = 60.0):
        self.api_key = api_key
        self._timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    async def remove(
        self,
        video_url: str,
        progress_callback: Optional[Callable] = None,
    ) -> str:
        """Submit video for watermark removal and wait for result.

        Args:
            video_url: Public URL of the video (e.g., Douyin CDN URL).
            progress_callback: Optional fn(pct, message) for progress updates.

        Returns:
            URL of the clean (watermark-free) video.

        Raises:
            WatermarkRemoverError: If submission or processing fails.
        """
        # ── Step 1: Submit ────────────────────────────────────────────
        if progress_callback:
            progress_callback(5, "🧹 Enviando vídeo para remoção de marca d'água...")

        logger.info(
            "watermark.submit",
            video_url=video_url[:100],
        )

        payload = {
            "video": video_url,
            "prompt": "remove watermark",
            "seed": 42,
        }

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                SUBMIT_URL,
                json=payload,
                headers=self._headers,
            )

        if resp.status_code != 200:
            body = resp.json() if resp.content else {}
            raise WatermarkRemoverError(
                f"Submit failed: HTTP {resp.status_code} — {body}",
                response=body,
            )

        data = resp.json()
        if data.get("code") != 0:
            raise WatermarkRemoverError(
                f"Submit error: {data.get('message', 'unknown')}",
                response=data,
            )

        task_id = data.get("data", {}).get("taskId")
        if not task_id:
            raise WatermarkRemoverError(
                f"No taskId in response: {data}",
                response=data,
            )

        logger.info("watermark.submitted", task_id=task_id)

        # ── Step 2: Poll ──────────────────────────────────────────────
        if progress_callback:
            progress_callback(15, f"⏳ Processando remoção (task: {task_id[:12]}...)")

        clean_url = await self._poll_until_done(
            task_id=task_id,
            progress_callback=progress_callback,
        )

        logger.info(
            "watermark.completed",
            task_id=task_id,
            clean_url=clean_url[:100],
        )

        return clean_url

    async def download(
        self,
        video_url: str,
        output_path: Path,
    ) -> Path:
        """Download the watermark-free video to a local path."""
        output_path.parent.mkdir(parents=True, exist_ok=True)

        logger.info(
            "watermark.download.start",
            url=video_url[:100],
            output=str(output_path),
        )

        async with httpx.AsyncClient(
            timeout=120.0, follow_redirects=True
        ) as client:
            resp = await client.get(video_url)
            resp.raise_for_status()
            output_path.write_bytes(resp.content)

        size_mb = output_path.stat().st_size / (1024 * 1024)
        logger.info(
            "watermark.download.done",
            output=str(output_path),
            size_mb=f"{size_mb:.1f}",
        )
        return output_path

    # ── Private ───────────────────────────────────────────────────────

    async def _poll_until_done(
        self,
        task_id: str,
        progress_callback: Optional[Callable] = None,
    ) -> str:
        """Poll the async query endpoint until task completes.

        NewportAI status codes (from official SDK):
            1 = queued
            2 = processing
            3 = completed ✅
            4 = failed ❌
        """
        start = time.monotonic()
        attempt = 0

        while True:
            elapsed = time.monotonic() - start
            if elapsed > MAX_POLL_TIMEOUT_SECS:
                raise WatermarkRemoverError(
                    f"Task {task_id} timed out after {MAX_POLL_TIMEOUT_SECS}s"
                )

            attempt += 1

            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    POLL_URL,
                    json={"taskId": task_id},
                    headers=self._headers,
                )

            if resp.status_code != 200:
                logger.warning(
                    "watermark.poll.http_error",
                    status=resp.status_code,
                    attempt=attempt,
                )
                await asyncio.sleep(POLL_INTERVAL_SECS)
                continue

            data = resp.json()
            if data.get("code") != 0:
                raise WatermarkRemoverError(
                    f"Poll error: {data.get('message', 'unknown')}",
                    response=data,
                )

            task_data = data.get("data", {}).get("task", {})
            status = task_data.get("status")

            logger.info(
                "watermark.poll",
                task_id=task_id,
                status=status,
                attempt=attempt,
                elapsed=f"{elapsed:.0f}s",
            )

            if progress_callback:
                # The API gives no real % — estimate from elapsed time.
                # Typical completion: ~120s. We bias toward that, capping at 92%
                # so the bar never reaches 100% before the download step.
                TYPICAL_SECS = 150.0
                raw_ratio = min(elapsed / TYPICAL_SECS, 1.0)
                # Ease-in-out curve: slow start, fast middle, slow end
                eased = raw_ratio * raw_ratio * (3 - 2 * raw_ratio)
                pct = int(15 + eased * 77)  # 15% → 92% range
                pct = min(pct, 92)

                # Human-readable remaining time
                if elapsed < 30:
                    phase_msg = "Analisando vídeo..."
                elif elapsed < TYPICAL_SECS * 0.7:
                    remaining = max(0, TYPICAL_SECS - elapsed)
                    phase_msg = f"~{int(remaining)}s restantes"
                else:
                    phase_msg = "Finalizando..."

                progress_callback(
                    pct,
                    f"🧹 Removendo marca d'água — {phase_msg}",
                )

            # Status 3 = completed ✅
            if status == 3:
                videos = data.get("data", {}).get("videos", [])
                if videos and len(videos) > 0:
                    video_url = videos[0].get("videoUrl")
                    if video_url:
                        return video_url

                raise WatermarkRemoverError(
                    f"Task completed but no video URL: {data}",
                    response=data,
                )

            # Status 4 = failed ❌
            if status == 4:
                reason = task_data.get("reason", "unknown")
                raise WatermarkRemoverError(
                    f"Task failed (status=4): {reason}",
                    response=data,
                )

            # Status 0 = tarefa criada/aguardando — continua o polling
            # Any other unknown status
            if status is not None and status not in (0, 1, 2, 3, 4):
                raise WatermarkRemoverError(
                    f"Task unexpected status {status}: {data}",
                    response=data,
                )

            await asyncio.sleep(POLL_INTERVAL_SECS)

