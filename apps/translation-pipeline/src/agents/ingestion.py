"""Phase 1: Ingestion Agent — yt-dlp download + queue management.

Downloads videos from Douyin using yt-dlp, extracts metadata,
creates the job manifest, and transitions the job to the next phase.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable, Optional

import structlog

from ..db.models import Database, JobStatus
from ..utils.ffmpeg import FFmpegWrapper
from ..utils.manifest import JobManifest

logger = structlog.get_logger(__name__)


class IngestionAgent:
    """Handles video ingestion from Douyin via yt-dlp."""

    def __init__(
        self,
        db: Database,
        workspace_dir: str | Path,
        cookies_path: Optional[str | Path] = None,
        yt_dlp_path: str = "yt-dlp",
    ):
        self.db = db
        self.workspace_dir = Path(workspace_dir)
        self.cookies_path = cookies_path
        self.yt_dlp = yt_dlp_path
        self.ffmpeg = FFmpegWrapper()

    async def process(self, job_id: str) -> Optional[JobManifest]:
        """Download video and initialize the job manifest.

        Flow:
        1. Validate job is in APPROVED status
        2. Transition to DOWNLOADING
        3. Run yt-dlp to download the video
        4. Extract audio for transcription
        5. Probe video metadata (duration, resolution, fps)
        6. Create and populate job manifest
        7. Transition to PROCESSING_OCR
        """
        job = await self.db.get_job(job_id)
        if not job:
            logger.error("ingestion.job_not_found", job_id=job_id)
            return None

        if job.status != JobStatus.APPROVED:
            logger.error(
                "ingestion.invalid_status",
                job_id=job_id,
                status=job.status.value,
            )
            return None

        # Transition to downloading
        await self.db.update_job_status(job_id, JobStatus.DOWNLOADING)

        try:
            from ..server_progress import update_progress as _p
            def _progress(pct, msg):
                _p(job_id, "downloading", pct, msg)

            # Set up job workspace
            job_workspace = self.workspace_dir / "downloads" / job_id
            job_workspace.mkdir(parents=True, exist_ok=True)

            # Parse job metadata early for watermark flag
            job_metadata = job.metadata if hasattr(job, "metadata") and job.metadata else {}
            if isinstance(job_metadata, str):
                import json as _json
                try:
                    job_metadata = _json.loads(job_metadata)
                except Exception:
                    job_metadata = {}

            wants_watermark_removal = bool(job_metadata.get("remove_watermark"))

            # Step 1: Download video (any strategy available)
            _progress(5, "⬇️ Baixando vídeo do Douyin...")
            logger.info(
                "ingestion.downloading",
                job_id=job_id,
                url=job.source_url,
                remove_watermark=wants_watermark_removal,
            )
            self._cdn_video_url = None  # captured by _download_via_api if possible
            video_path = await self._download_video(
                url=job.source_url,
                output_dir=job_workspace,
                platform=job.source_platform,
            )
            _progress(12, "✅ Vídeo baixado com sucesso!")

            # Step 2: Watermark removal (runs AFTER any download strategy)
            watermark_removed = False
            if wants_watermark_removal:
                import os as _os
                from .watermark import WatermarkRemover

                dreamface_key = _os.getenv("DREAMFACE_API_KEY", "")
                if not dreamface_key:
                    logger.warning("ingestion.watermark.no_api_key")
                else:
                    # Preferência: CDN URL capturada do api.douyin.wtf (alta qualidade)
                    cdn_url = self._cdn_video_url

                    # Fallback: se api.douyin.wtf falhou, usamos nosso próprio servidor
                    # para servir o vídeo baixado localmente via yt-dlp.
                    # O endpoint /api/translate/serve-source/{job_id} expõe o arquivo.
                    if not cdn_url:
                        _base = _os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
                        if not _base and _os.environ.get("RAILWAY_PUBLIC_DOMAIN"):
                            _base = "https://" + _os.environ["RAILWAY_PUBLIC_DOMAIN"]
                        if _base:
                            cdn_url = f"{_base}/api/translate/serve-source/{job_id}"
                            logger.info(
                                "ingestion.watermark.self_hosted_url",
                                url=cdn_url,
                                note="api.douyin.wtf indisponível — servindo vídeo local como URL pública",
                            )
                        else:
                            logger.warning(
                                "ingestion.watermark.no_cdn_url",
                                note="Sem CDN URL e sem RAILWAY_PUBLIC_DOMAIN — remoção de marca d'água pulada.",
                            )
                    if cdn_url:  # Executa para CDN URL (douyin.wtf) OU URL self-hosted (Railway)
                        try:
                            _progress(13, "🧹 Removendo marca d'água via NewportAI...")
                            remover = WatermarkRemover(api_key=dreamface_key)


                            def _wm_progress(pct, msg):
                                _progress(pct, msg)

                            # Retry up to 3x on transient network errors
                            _WM_MAX_RETRIES = 3
                            _WM_RETRY_DELAY = 5  # seconds between retries
                            clean_url = None
                            for _attempt in range(1, _WM_MAX_RETRIES + 1):
                                try:
                                    if _attempt > 1:
                                        _progress(13, f"🔄 Tentativa {_attempt}/{_WM_MAX_RETRIES} — reconectando à API...")
                                        await asyncio.sleep(_WM_RETRY_DELAY)
                                    clean_url = await remover.remove(
                                        video_url=cdn_url,
                                        progress_callback=_wm_progress,
                                    )
                                    break  # success
                                except Exception as _wm_attempt_err:
                                    logger.warning(
                                        "ingestion.watermark.attempt_failed",
                                        attempt=_attempt,
                                        max=_WM_MAX_RETRIES,
                                        error=str(_wm_attempt_err)[:120],
                                        job_id=job_id,
                                    )
                                    if _attempt == _WM_MAX_RETRIES:
                                        raise  # re-raise after last attempt

                            if clean_url:
                                # Download clean video over original
                                clean_path = job_workspace / "source_clean.mp4"
                                await remover.download(clean_url, clean_path)
                                # Replace source.mp4 with clean version
                                import shutil as _shutil
                                _shutil.move(str(clean_path), str(video_path))
                                watermark_removed = True
                                logger.info(
                                    "ingestion.watermark.complete",
                                    job_id=job_id,
                                    path=str(video_path),
                                )
                                _progress(15, "✅ Marca d'água removida!")
                        except Exception as wm_err:
                            logger.error(
                                "ingestion.watermark.failed",
                                job_id=job_id,
                                error=str(wm_err),
                            )
                            _progress(15, f"⚠️ Falha ao remover marca d'água após {_WM_MAX_RETRIES} tentativas: {str(wm_err)[:80]}")

            # Extract audio for AssemblyAI transcription
            _progress(14, "🎵 Extraindo faixa de áudio...")
            audio_path = job_workspace / "audio.wav"
            await self.ffmpeg.extract_audio(
                input_path=video_path,
                output_path=audio_path,
                sample_rate=16000,
                mono=True,
            )
            _progress(17, "✅ Áudio extraído!")

            # Probe video metadata
            _progress(18, "🔍 Analisando metadados do vídeo...")
            probe_data = await self.ffmpeg.probe(video_path)
            duration = await self.ffmpeg.get_duration(video_path)
            width, height = await self.ffmpeg.get_resolution(video_path)
            fps = await self.ffmpeg.get_fps(video_path)
            _progress(20, f"📊 Vídeo: {width}x{height} @ {fps:.0f}fps — {duration:.1f}s")

            # Create job manifest
            manifest = JobManifest.create(
                job_id=job_id,
                workspace_dir=str(job_workspace),
                source_url=job.source_url,
                source_platform=job.source_platform,
                target_language=job.target_language,
            )

            manifest.set_ingestion_result(
                video_path=str(video_path),
                audio_path=str(audio_path),
                video_info=self._extract_video_info(probe_data),
                duration=duration,
                resolution=f"{width}x{height}",
                fps=fps,
            )

            # Propagate metadata to manifest
            # (job_metadata already parsed above)
            if job_metadata.get("character_id"):
                manifest._data["character_id"] = job_metadata["character_id"]
            if watermark_removed:
                manifest._data["watermark_removed"] = True
                logger.info("ingestion.watermark_flag_saved", job_id=job_id)
            elif wants_watermark_removal:
                # User requested but it failed (no CDN URL or API error)
                # Still skip blur — user expects no watermark treatment
                manifest._data["watermark_removed"] = False
            manifest.save()

            # Update job with paths
            await self.db.update_job_field(
                job_id, "manifest_path", str(manifest.path)
            )
            await self.db.update_job_field(
                job_id, "source_video_path", str(video_path)
            )

            # Transition to OCR phase
            await self.db.update_job_status(job_id, JobStatus.PROCESSING_OCR)

            logger.info(
                "ingestion.complete",
                job_id=job_id,
                video_path=str(video_path),
                duration=duration,
                resolution=f"{width}x{height}",
            )
            return manifest

        except Exception as e:
            error_msg = f"Ingestion failed: {str(e)}"
            logger.exception("ingestion.error", job_id=job_id, error=error_msg)
            await self.db.update_job_status(
                job_id, JobStatus.ERROR, error_message=error_msg
            )
            return None

    async def _download_video(
        self,
        url: str,
        output_dir: Path,
        platform: str = "douyin",
    ) -> Path:
        """Download video using multiple strategies.

        Strategy order:
        1. api.douyin.wtf (Evil0ctal public API) — best quality, no watermark
           Also captures CDN URL in self._cdn_video_url for watermark removal.
        2. Playwright headless browser — intercepts Douyin API response
        3. yt-dlp with browser cookies — fallback
        4. yt-dlp without cookies — last resort
        """
        video_path = output_dir / "source.mp4"

        # Strategy 1: API-based download (fast, reliable, no watermark)
        try:
            result = await self._download_via_api(url, video_path)
            if result:
                return result
        except Exception as e:
            logger.warning("ingestion.api_download_failed", error=str(e)[:200])

        # Strategy 2: Playwright — intercept Douyin API detail response
        if platform == "douyin":
            try:
                result = await self._download_via_playwright(url, video_path)
                if result:
                    return result
            except Exception as e:
                logger.warning("ingestion.playwright_download_failed", error=str(e)[:200])

        # Strategy 3: yt-dlp with cookie strategies
        try:
            result = await self._download_via_ytdlp(url, output_dir, platform)
            if result:
                return result
        except Exception as e:
            logger.warning("ingestion.ytdlp_download_failed", error=str(e)[:200])

        raise RuntimeError(
            "All download strategies failed. "
            "The video may be private, deleted, or region-locked."
        )
    async def _download_via_playwright(self, url: str, output_path: Path) -> Optional[Path]:
        """Download via Playwright — intercept Douyin internal API response.

        Uses a headless Chromium browser to:
        1. Visit douyin.com homepage (generate cookies including ttwid)
        2. Navigate to the video page
        3. Intercept the aweme/detail API response
        4. Extract the best quality video URL
        5. Download the video file
        """
        import asyncio

        def _do_playwright():
            from playwright.sync_api import sync_playwright
            import json as _json
            import httpx as _httpx

            detail_holder = [None]

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                ctx = browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/125.0.0.0 Safari/537.36"
                    ),
                    viewport={"width": 1920, "height": 1080},
                    locale="zh-CN",
                )
                page = ctx.new_page()

                # Visit homepage first to generate cookies (ttwid etc.)
                page.goto(
                    "https://www.douyin.com/",
                    wait_until="domcontentloaded",
                    timeout=15000,
                )
                page.wait_for_timeout(2000)

                # Intercept API responses
                def on_response(response):
                    resp_url = response.url
                    if "aweme" in resp_url and "detail" in resp_url:
                        try:
                            body = response.text()
                            if "play_addr" in body:
                                detail_holder[0] = _json.loads(body)
                        except Exception:
                            pass

                page.on("response", on_response)

                # Navigate to video page
                try:
                    page.goto(url, wait_until="load", timeout=20000)
                except Exception:
                    pass
                page.wait_for_timeout(5000)

                cookies = {c["name"]: c["value"] for c in ctx.cookies()}
                browser.close()

            # Extract video URL from captured API response
            data = detail_holder[0]
            if not data:
                return None

            detail = data.get("aweme_detail", {})
            if not detail:
                return None

            video = detail.get("video", {})

            # Prefer HD from bit_rate list
            all_urls = []
            for br in sorted(
                video.get("bit_rate", []),
                key=lambda x: x.get("bit_rate", 0),
                reverse=True,
            ):
                bu = br.get("play_addr", {}).get("url_list", [])
                all_urls.extend(bu)

            # Fallback to play_addr
            all_urls.extend(video.get("play_addr", {}).get("url_list", []))

            if not all_urls:
                return None

            # Download the video
            with _httpx.Client(
                timeout=120, follow_redirects=True, cookies=cookies
            ) as client:
                resp = client.get(
                    all_urls[0],
                    headers={
                        "Referer": "https://www.douyin.com/",
                        "User-Agent": "Mozilla/5.0",
                    },
                )
                if resp.status_code == 200 and len(resp.content) > 100_000:
                    with open(output_path, "wb") as f:
                        f.write(resp.content)
                    return output_path

            return None

        # Run synchronous Playwright in a thread
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _do_playwright)

        if result and result.exists():
            size_mb = round(result.stat().st_size / (1024 * 1024), 2)
            logger.info(
                "ingestion.playwright.complete",
                path=str(result),
                size_mb=size_mb,
            )
            return result

        logger.warning("ingestion.playwright.no_result")
        return None

    async def _download_via_api(
        self,
        url: str,
        output_path: Path,
    ) -> Optional[Path]:
        """Download via api.douyin.wtf — no watermark, high quality.

        Also captures the CDN video URL in self._cdn_video_url so that the
        watermark removal step can use it regardless of which download strategy
        ultimately succeeds.
        """
        import httpx as _httpx

        # Extract video/aweme ID from URL
        aweme_id = self._extract_aweme_id(url)
        if not aweme_id:
            logger.warning("ingestion.api.no_aweme_id", url=url)
            return None

        logger.info("ingestion.api.fetching", aweme_id=aweme_id)

        # Fetch video metadata from API
        async with _httpx.AsyncClient(timeout=30.0) as client:
            api_url = (
                f"https://api.douyin.wtf/api/douyin/web/fetch_one_video"
                f"?aweme_id={aweme_id}"
            )
            resp = await client.get(api_url)

            if resp.status_code != 200:
                logger.warning("ingestion.api.bad_status", status=resp.status_code)
                return None

            data = resp.json()
            detail = data.get("data", {}).get("aweme_detail", {})
            if not detail:
                logger.warning("ingestion.api.no_detail")
                return None

            # Extract video info
            title = detail.get("desc", "")
            author = detail.get("author", {}).get("nickname", "")
            duration_ms = detail.get("duration", 0)

            logger.info(
                "ingestion.api.metadata",
                title=title[:60],
                author=author,
                duration_s=round(duration_ms / 1000, 1),
            )

            # Get best quality download URL (prefer 1080p no watermark)
            video_data = detail.get("video", {})
            download_url = self._select_best_video_url(video_data)

            if not download_url:
                logger.warning("ingestion.api.no_video_url")
                return None

            # ── Capture CDN URL for watermark removal ─────────────────
            # Store it so the watermark step can use it even if this
            # strategy falls back to playwright/yt-dlp.
            self._cdn_video_url = download_url
            logger.info("ingestion.api.cdn_url_captured", url=download_url[:80])

            # ── Download video ────────────────────────────────────────
            logger.info("ingestion.api.downloading", url=download_url[:80])

            async with client.stream("GET", download_url, headers={
                "Referer": "https://www.douyin.com/",
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/125.0.0.0 Safari/537.36"
                ),
            }) as stream:
                if stream.status_code != 200:
                    logger.warning(
                        "ingestion.api.download_failed",
                        status=stream.status_code,
                    )
                    return None

                downloaded = 0
                with open(output_path, "wb") as f:
                    async for chunk in stream.aiter_bytes(chunk_size=65536):
                        f.write(chunk)
                        downloaded += len(chunk)

                if downloaded < 100_000:  # Less than 100KB is suspicious
                    output_path.unlink(missing_ok=True)
                    logger.warning("ingestion.api.file_too_small", size=downloaded)
                    return None

            size_mb = round(output_path.stat().st_size / (1024 * 1024), 2)
            logger.info(
                "ingestion.api.complete",
                path=str(output_path),
                size_mb=size_mb,
                watermark=False,
            )
            return output_path

    def _extract_aweme_id(self, url: str) -> Optional[str]:
        """Extract aweme/video ID from various Douyin URL formats."""
        import re

        # Direct video URL: douyin.com/video/1234567890
        m = re.search(r'/video/(\d+)', url)
        if m:
            return m.group(1)

        # Short link: v.douyin.com/xxxxx/
        m = re.search(r'v\.douyin\.com/(\w+)', url)
        if m:
            return m.group(1)

        # Aweme ID in query: aweme_id=1234567890
        m = re.search(r'aweme_id=(\d+)', url)
        if m:
            return m.group(1)

        # Pure numeric ID
        m = re.search(r'(\d{15,25})', url)
        if m:
            return m.group(1)

        return None

    def _select_best_video_url(self, video_data: dict) -> Optional[str]:
        """Select the best quality watermark-free video URL.

        Priority: 1080p H.264 > 720p > play_addr > any available
        """
        # Option 1: Check bit_rate list for best quality
        bit_rates = video_data.get("bit_rate", [])
        if bit_rates:
            # Sort by quality (lower number = better) then by bit rate
            quality_order = {1: 0, 10: 1, 20: 2, 30: 3, 40: 4}
            sorted_rates = sorted(
                bit_rates,
                key=lambda x: quality_order.get(x.get("quality_type", 99), 99),
            )
            for br in sorted_rates:
                urls = br.get("play_addr", {}).get("url_list", [])
                if urls:
                    return urls[0]

        # Option 2: Direct play_addr (no watermark)
        play_addr = video_data.get("play_addr", {})
        urls = play_addr.get("url_list", [])
        if urls:
            return urls[0]

        # Option 3: H264 play addr
        play_h264 = video_data.get("play_addr_h264", {})
        urls = play_h264.get("url_list", [])
        if urls:
            return urls[0]

        return None

    async def _download_via_ytdlp(
        self,
        url: str,
        output_dir: Path,
        platform: str = "douyin",
    ) -> Optional[Path]:
        """Fallback: Download via yt-dlp with cookie strategies."""
        output_template = str(output_dir / "source.%(ext)s")

        base_cmd = [
            self.yt_dlp,
            "--no-warnings",
            "--no-playlist",
            "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", output_template,
        ]

        if platform == "douyin":
            base_cmd.extend([
                "--referer", "https://www.douyin.com/",
                "--user-agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            ])

        # Try browser cookies
        cookie_strategies = [
            ("chrome", ["--cookies-from-browser", "chrome"]),
            ("safari", ["--cookies-from-browser", "safari"]),
            ("firefox", ["--cookies-from-browser", "firefox"]),
            ("no_cookies", []),
        ]

        if self.cookies_path and Path(self.cookies_path).exists():
            cookie_strategies.insert(0, ("file", ["--cookies", str(self.cookies_path)]))

        for name, cookie_args in cookie_strategies:
            cmd = base_cmd + cookie_args + [url]
            logger.info("ingestion.ytdlp.attempt", strategy=name)

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode == 0:
                video_files = [
                    f for f in output_dir.glob("source.*")
                    if f.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")
                ]
                if video_files:
                    logger.info("ingestion.ytdlp.ok", strategy=name)
                    return video_files[0]

            logger.warning(
                "ingestion.ytdlp.failed",
                strategy=name,
                error=stderr.decode("utf-8", errors="replace")[-200:],
            )

        return None

    def _extract_video_info(self, probe_data: dict[str, Any]) -> dict[str, Any]:
        """Extract relevant video info from ffprobe output."""
        fmt = probe_data.get("format", {})
        video_stream = {}
        audio_stream = {}

        for stream in probe_data.get("streams", []):
            if stream.get("codec_type") == "video" and not video_stream:
                video_stream = {
                    "codec": stream.get("codec_name"),
                    "width": stream.get("width"),
                    "height": stream.get("height"),
                    "fps": stream.get("r_frame_rate"),
                    "bit_rate": stream.get("bit_rate"),
                    "pix_fmt": stream.get("pix_fmt"),
                }
            elif stream.get("codec_type") == "audio" and not audio_stream:
                audio_stream = {
                    "codec": stream.get("codec_name"),
                    "sample_rate": stream.get("sample_rate"),
                    "channels": stream.get("channels"),
                    "bit_rate": stream.get("bit_rate"),
                }

        return {
            "format": fmt.get("format_name"),
            "duration": fmt.get("duration"),
            "size": fmt.get("size"),
            "bit_rate": fmt.get("bit_rate"),
            "video": video_stream,
            "audio": audio_stream,
        }

    async def get_video_info_preview(self, url: str) -> dict[str, Any]:
        """Get video metadata without downloading (for preview in pending_review).

        Uses yt-dlp --dump-json to fetch metadata only.
        """
        cmd = [
            self.yt_dlp,
            "--no-warnings",
            "--no-playlist",
            "--dump-json",
            url,
        ]

        if self.cookies_path and Path(self.cookies_path).exists():
            cmd.extend(["--cookies", str(self.cookies_path)])

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"yt-dlp metadata fetch failed: {stderr_text[-300:]}")

        info = json.loads(stdout.decode("utf-8"))
        return {
            "title": info.get("title"),
            "description": info.get("description"),
            "duration": info.get("duration"),
            "uploader": info.get("uploader"),
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
            "thumbnail": info.get("thumbnail"),
            "resolution": f"{info.get('width', '?')}x{info.get('height', '?')}",
            "fps": info.get("fps"),
        }
