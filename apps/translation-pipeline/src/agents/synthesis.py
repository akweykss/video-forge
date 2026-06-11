"""Phase 5: Synthesis Agent — FFmpeg final composition.

Composes the final video by merging the source video, translated audio,
and caption overlay. Applies cinematic post-processing: LUT color grade,
motion interpolation, film grain, and metadata purging.
"""

from __future__ import annotations

import asyncio

import os
from pathlib import Path
from typing import Any, Optional

import structlog

from ..db.models import Database, JobStatus
from ..utils.ffmpeg import FFmpegWrapper
from ..utils.manifest import JobManifest

logger = structlog.get_logger(__name__)


class SynthesisAgent:
    """Handles final video synthesis and post-processing."""

    def __init__(
        self,
        db: Database,
        workspace_dir: str | Path,
        apply_lut: bool = True,
        apply_grain: bool = True,
        apply_minterp: bool = False,
        grain_intensity: int = 8,
        lut_path: Optional[str | Path] = None,
    ):
        self.db = db
        self.workspace_dir = Path(workspace_dir)
        self.apply_lut = apply_lut
        self.apply_grain = apply_grain
        self.apply_minterp = apply_minterp
        self.grain_intensity = grain_intensity
        self.lut_path = lut_path
        self.ffmpeg = FFmpegWrapper()

    async def process(self, job_id: str) -> Optional[JobManifest]:
        """Run the final synthesis pipeline.

        Flow:
        1. Validate job is in PROCESSING_SYNTHESIS status
        2. Load manifest for all intermediate paths
        3. Compose video + translated audio + overlay
        4. Apply post-processing (LUT, grain, minterp)
        5. Purge metadata
        6. Update manifest and transition to DONE
        """
        job = await self.db.get_job(job_id)
        if not job:
            logger.error("synthesis.job_not_found", job_id=job_id)
            return None

        if job.status != JobStatus.PROCESSING_SYNTHESIS:
            logger.error(
                "synthesis.invalid_status",
                job_id=job_id,
                status=job.status.value,
            )
            return None

        try:
            manifest = JobManifest.load(job.manifest_path)
            manifest.set_phase_status("synthesis", "running")

            ingestion = manifest.get_phase("ingestion")
            voice = manifest.get_phase("voice")
            overlay = manifest.get_phase("overlay")

            video_path = ingestion["video_path"]
            audio_path = voice["tts"]["merged_audio_path"]

            # Read new fields from manifest
            speed_factor = voice.get("tts", {}).get("speed_factor", 1.0)
            segment_speeds = voice.get("tts", {}).get("segment_speeds", [])
            ass_subtitle_path = overlay.get("ass_subtitle_path")
            sub_blur_region = overlay.get("sub_blur_region")

            # Skip blur if:
            # 1. Watermark was successfully removed (manifest flag), OR
            # 2. User requested watermark removal (job metadata) — even if it
            #    failed, they don't want the blur overlay.
            _job_meta = job.metadata if isinstance(job.metadata, dict) else {}
            if isinstance(job.metadata, str):
                import json as _jm
                try:
                    _job_meta = _jm.loads(job.metadata)
                except Exception:
                    _job_meta = {}
            _sub_style = str(_job_meta.get("subtitle_style") or "cinema")

            if manifest._data.get("watermark_removed") or _job_meta.get("remove_watermark"):
                sub_blur_region = None
                logger.info(
                    "synthesis.skip_blur",
                    reason="watermark_removed" if manifest._data.get("watermark_removed") else "user_requested",
                )

            # Set up output directory
            output_dir = self.workspace_dir / "outputs" / job_id
            output_dir.mkdir(parents=True, exist_ok=True)

            # Work directory for intermediate files
            work_dir = output_dir / "_work"
            work_dir.mkdir(parents=True, exist_ok=True)

            # Determine output filename
            output_path = output_dir / f"translated_{job_id[:8]}.mp4"

            logger.info(
                "synthesis.starting",
                job_id=job_id,
                video=video_path,
                audio=audio_path,
                speed_factor=speed_factor,
                segment_speeds_count=len(segment_speeds),
                ass_subtitle=ass_subtitle_path,
                sub_blur_region=str(sub_blur_region),
                lut=self.apply_lut,
                grain=self.apply_grain,
            )

            def _synth_progress(pct: float, msg: str):
                from ..server_progress import update_progress
                update_progress(job_id, "processing_synthesis", pct, msg)

            # ── Resolve character/lip sync config early ──────────────
            character_id = manifest._data.get("character_id")

            # Fallback: try job metadata if manifest doesn't have character_id
            if not character_id:
                try:
                    _job = await self.db.get_job(job_id)
                    _meta = _job.metadata if isinstance(_job.metadata, dict) else {}
                    if isinstance(_job.metadata, str):
                        import json as _jmf
                        try: _meta = _jmf.loads(_job.metadata)
                        except: _meta = {}
                    character_id = _meta.get("character_id")
                    if character_id:
                        manifest._data["character_id"] = character_id
                        manifest.save()
                        logger.info("synthesis.character_id_from_job_meta", character_id=character_id)
                except Exception:
                    pass

            dreamface_key = os.environ.get("DREAMFACE_API_KEY", "")
            avatar_file = None
            lipsync_agent = None

            if character_id and dreamface_key:
                from ..agents.lipsync import LipSyncAgent
                from ..agents.compositor import LayoutCompositor

                char_dir = Path(__file__).parent.parent.parent / "data" / "characters" / character_id
                char_meta_path = char_dir / "meta.json"
                if char_meta_path.exists():
                    import json as _json_m
                    char_meta = _json_m.loads(char_meta_path.read_text())
                    avatar_filename = char_meta.get("avatar_filename", "")
                    avatar_file = char_dir / avatar_filename
                    if avatar_file.exists():
                        lipsync_agent = LipSyncAgent(
                            workspace_dir=self.workspace_dir,
                            dreamface_api_key=dreamface_key,
                        )

            logger.info(
                "synthesis.lipsync_check",
                job_id=job_id,
                character_id=character_id or "NONE",
                has_dreamface_key=bool(dreamface_key),
            )

            # ── Start DreamFace in PARALLEL ⚡ ─────────────────────────
            # DreamFace takes ~60s. Start it NOW while we render the video.
            dreamface_task = None
            if lipsync_agent and avatar_file:
                _synth_progress(86, "🎭 Enviando áudio ao DreamFace (paralelo)...")
                logger.info(
                    "synthesis.lipsync_start_parallel",
                    job_id=job_id,
                    character_id=character_id,
                )
                dreamface_task = asyncio.create_task(
                    lipsync_agent.process(
                        job_id=job_id,
                        audio_path=Path(audio_path),
                        avatar_video_path=avatar_file,
                        progress_callback=lambda phase, pct, msg: _synth_progress(
                            86 + pct * 0.04, f"🎭 {msg}"
                        ),
                    )
                )
            else:
                if character_id:
                    logger.warning(
                        "synthesis.lipsync_skipped",
                        reason="avatar_file_not_found_or_lipsync_agent_not_created",
                        character_id=character_id,
                    )
                elif not dreamface_key:
                    logger.warning("synthesis.lipsync_skipped", reason="DREAMFACE_API_KEY_not_set")

            # ── Phase 1: Render video (with or without subtitles) ────
            # When lipsync IS active: subtitles go in the 9:16 compositor later.
            # When lipsync is NOT active: burn subtitles directly here via FFmpeg.
            _burn_subs_now = (lipsync_agent is None)
            _ass_for_ffmpeg = ass_subtitle_path if _burn_subs_now else None

            final_path = await self.ffmpeg.full_synthesis_pipeline(
                video_path=video_path,
                audio_path=audio_path,
                output_path=output_path,
                ass_subtitle_path=_ass_for_ffmpeg,
                speed_factor=speed_factor,
                apply_hflip=True,
                sub_blur_region=sub_blur_region,
                apply_lut_flag=self.apply_lut,
                apply_grain_flag=self.apply_grain,
                lut_path=self.lut_path,
                grain_intensity=self.grain_intensity,
                work_dir=work_dir,
                progress_callback=_synth_progress,
                segment_speeds=segment_speeds,
            )

            # ── Collect subtitle segments from voice phase ─────────────
            # Use the translation segments already generated by the voice
            # agent — no need to re-transcribe with AssemblyAI.
            sub_segments = []
            try:
                voice_segments = voice.get("translation", {}).get("segments", [])
                if not voice_segments:
                    voice_segments = voice.get("transcription", {}).get("segments", [])

                for seg in voice_segments:
                    text = seg.get("translated", seg.get("text", "")).strip()
                    if text:
                        sub_segments.append({
                            "start": round(float(seg.get("start", 0)), 3),
                            "end": round(float(seg.get("end", 0)), 3),
                            "text": text,
                        })

                # Split long segments (max 34 chars — fits 1080px with Arial Bold)
                MAX_2LINES = 34
                final_segments = []
                for seg in sub_segments:
                    txt = seg["text"]
                    if len(txt) <= MAX_2LINES:
                        final_segments.append(seg)
                        continue
                    chunks, remaining = [], txt
                    while remaining:
                        if len(remaining) <= MAX_2LINES:
                            chunks.append(remaining)
                            break
                        sp = MAX_2LINES
                        while sp > 0 and remaining[sp] != ' ':
                            sp -= 1
                        if sp == 0:
                            sp = MAX_2LINES
                        chunks.append(remaining[:sp].strip())
                        remaining = remaining[sp:].strip()
                    dur = seg["end"] - seg["start"]
                    total_c = sum(len(c) for c in chunks)
                    t = seg["start"]
                    for c in chunks:
                        r = len(c) / total_c if total_c > 0 else 1 / len(chunks)
                        cd = dur * r
                        final_segments.append({
                            "start": round(t, 3),
                            "end": round(t + cd, 3),
                            "text": c,
                        })
                        t += cd
                sub_segments = final_segments

                # NOTE: speed_factor adjustment NOT needed here.
                # The rendered video has audio synced — segment_speeds adjust
                # the video to match audio duration. Subtitle timings from
                # TTS are already in the correct output timeline.

                if sub_segments:
                    logger.info(
                        "synthesis.subtitle_segments_ready",
                        count=len(sub_segments),
                        sample=[s["text"][:40] for s in sub_segments[:3]],
                    )
            except Exception as sub_err:
                logger.warning(
                    "synthesis.subtitle_segments_failed",
                    error=str(sub_err),
                )

            # DreamFace falhou/sumiu → queima a legenda no vídeo já renderizado,
            # para o master NUNCA sair sem legenda.
            async def _fallback_burn(src_path: Path) -> Path:
                if not ass_subtitle_path or not Path(ass_subtitle_path).exists():
                    return src_path
                burned = output_dir / f"translated_{job_id[:8]}_subs.mp4"
                cmd = [
                    str(self.ffmpeg.ffmpeg), "-y", "-i", str(src_path),
                    "-vf", f"ass='{str(ass_subtitle_path)}'",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "19",
                    "-c:a", "copy", str(burned),
                ]
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, _stderr = await proc.communicate()
                if proc.returncode == 0 and burned.exists():
                    logger.info("synthesis.fallback_subs_burned", output=str(burned))
                    return burned
                logger.warning(
                    "synthesis.fallback_subs_failed",
                    error=(_stderr or b"")[-300:].decode(errors="ignore"),
                )
                return src_path

            # ── Phase 2: Await DreamFace + Compose 9:16 ─────────────────
            if dreamface_task:
                try:
                    _synth_progress(95, "⏳ Aguardando DreamFace...")
                    lipsync_result = await dreamface_task

                    if lipsync_result and lipsync_result.exists():
                        _synth_progress(97, "🎬 Compondo layout 9:16...")

                        compositor = LayoutCompositor(
                            ffmpeg_path=str(self.ffmpeg.ffmpeg),
                        )
                        composed_path = output_dir / f"translated_{job_id[:8]}_9x16.mp4"
                        final_path = await compositor.compose(
                            video_path=final_path,
                            avatar_path=lipsync_result,
                            output_path=composed_path,
                            subtitle_segments=sub_segments or None,
                            subtitle_style=_sub_style,
                            fps=25,
                            layout_duration=8.0,
                            progress_callback=lambda pct, msg: _synth_progress(
                                97 + pct * 0.02, f"🎬 {msg}"
                            ),
                        )

                        logger.info(
                            "synthesis.lipsync_composed",
                            job_id=job_id,
                            output=str(final_path),
                        )
                    else:
                        logger.warning("synthesis.lipsync_result_missing")
                        _synth_progress(97, "⚠️ Avatar indisponível — queimando legendas no vídeo...")
                        final_path = await _fallback_burn(final_path)

                except Exception as ls_err:
                    logger.warning(
                        "synthesis.lipsync_failed",
                        error=str(ls_err),
                        msg="Video saved without lip sync overlay",
                    )
                    _synth_progress(97, "⚠️ Avatar falhou — queimando legendas no vídeo...")
                    final_path = await _fallback_burn(final_path)

            # Get final video stats
            duration = await self.ffmpeg.get_duration(final_path)
            width, height = await self.ffmpeg.get_resolution(final_path)
            size_bytes = final_path.stat().st_size

            # Update manifest
            manifest.set_synthesis_result(
                output_video_path=str(final_path),
                resolution=f"{width}x{height}",
                duration=duration,
                size_bytes=size_bytes,
                lut=self.apply_lut,
                minterp=self.apply_minterp,
                grain=self.apply_grain,
            )

            # Update job with output path
            await self.db.update_job_field(
                job_id, "output_video_path", str(final_path)
            )

            # Clean up work directory
            try:
                import shutil
                shutil.rmtree(work_dir, ignore_errors=True)
            except Exception:
                pass

            # Transition to DONE
            await self.db.update_job_status(job_id, JobStatus.DONE)

            logger.info(
                "synthesis.complete",
                job_id=job_id,
                output=str(final_path),
                resolution=f"{width}x{height}",
                duration_s=round(duration, 2),
                size_mb=round(size_bytes / (1024 * 1024), 2),
            )
            return manifest

        except Exception as e:
            error_msg = f"Synthesis failed: {str(e)}"
            logger.exception("synthesis.error", job_id=job_id, error=error_msg)
            await self.db.update_job_status(
                job_id, JobStatus.ERROR, error_message=error_msg
            )
            return None
