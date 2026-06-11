"""Phase 3: Voice Agent — AssemblyAI transcription + Claude translation + MiniMax TTS.

Transcribes the original audio, translates text (speech + OCR overlays)
to the target language using Claude, then synthesizes Portuguese speech
via MiniMax TTS API.
"""

from __future__ import annotations

import asyncio
import json
import os
import struct
import subprocess
import wave
from pathlib import Path
from typing import Any, Optional

import httpx
import structlog

from ..db.models import Database, JobStatus
from ..utils.ffmpeg import FFmpegWrapper
from ..utils.manifest import JobManifest

logger = structlog.get_logger(__name__)

# ── MiniMax TTS configuration ──────────────────────────────────────
MINIMAX_API_URL = "https://api.minimax.io/v1/t2a_v2"
MINIMAX_MODEL = "speech-2.8-hd"
# MiniMax voice — use female-shaonv (verified working)
MINIMAX_DEFAULT_VOICE_ID = "female-shaonv"


class VoiceAgent:
    """Handles transcription, translation, and TTS synthesis."""

    def __init__(
        self,
        db: Database,
        workspace_dir: str | Path,
        assemblyai_api_key: Optional[str] = None,
        anthropic_api_key: Optional[str] = None,
        minimax_api_key: Optional[str] = None,
        minimax_voice_id: str = MINIMAX_DEFAULT_VOICE_ID,
    ):
        self.db = db
        self.workspace_dir = Path(workspace_dir)
        self.assemblyai_key = assemblyai_api_key or os.getenv("ASSEMBLYAI_API_KEY", "")
        self.anthropic_key = anthropic_api_key or os.getenv("ANTHROPIC_API_KEY", "")
        self.minimax_key = minimax_api_key or os.getenv("MINIMAX_API_KEY", "")
        self.minimax_voice_id = minimax_voice_id
        self.ffmpeg = FFmpegWrapper()

    async def process(self, job_id: str) -> Optional[JobManifest]:
        """Run the complete voice pipeline.

        Flow:
        1. Validate job is in PROCESSING_AUDIO status
        2. Transcribe audio via AssemblyAI
        3. Translate transcription + OCR texts via Claude
        4. Synthesize translated speech via MiniMax TTS
        5. Merge audio segments into a single track
        6. Update manifest and transition to PROCESSING_OVERLAY
        """
        job = await self.db.get_job(job_id)
        if not job:
            logger.error("voice.job_not_found", job_id=job_id)
            return None

        if job.status != JobStatus.PROCESSING_AUDIO:
            logger.error(
                "voice.invalid_status",
                job_id=job_id,
                status=job.status.value,
            )
            return None

        try:
            from ..server_progress import update_progress as _p
            def _progress(pct, msg):
                _p(job_id, "processing_audio", pct, msg)

            manifest = JobManifest.load(job.manifest_path)
            manifest.set_phase_status("voice", "running")

            # Read voice_id from job metadata (set by frontend)
            job_metadata = job.metadata or {}
            voice_id = job_metadata.get("voice_id", "") or self.minimax_voice_id
            logger.info("voice.using_voice", job_id=job_id, voice_id=voice_id)

            ingestion = manifest.get_phase("ingestion")
            spatial = manifest.get_phase("spatial")
            audio_path = ingestion["audio_path"]
            duration = ingestion["duration_seconds"]

            # Set up voice workspace
            voice_dir = self.workspace_dir / "downloads" / job_id / "voice"
            voice_dir.mkdir(parents=True, exist_ok=True)

            # Step 1: Transcribe with AssemblyAI
            _progress(43, "🎤 Enviando áudio para AssemblyAI...")
            logger.info("voice.transcribing", job_id=job_id)
            transcription = await self._transcribe(audio_path)
            _progress(50, f"✅ Transcrição completa — {len(transcription['segments'])} segmentos detectados")
            manifest.set_transcription(
                segments=transcription["segments"],
                full_text=transcription["full_text"],
                language=transcription["language"],
            )

            # Step 2: Translate with Claude
            _progress(52, "🤖 Traduzindo com Claude AI...")
            logger.info("voice.translating", job_id=job_id)
            translation = await self._translate(
                transcription_segments=transcription["segments"],
                full_text=transcription["full_text"],
                ocr_texts=spatial.get("unique_texts", []),
                source_language=transcription["language"],
                target_language=manifest.target_language,
            )
            _progress(58, f"✅ Tradução completa — {len(translation['segments'])} segmentos")

            # Store raw translation for reference
            manifest.set_translation(
                segments=translation["segments"],
                full_text=translation["full_text"],
                text_overlays=translation.get("text_overlays", []),
            )

            # Step 3: Synthesize SINGLE full audio with MiniMax TTS
            # Sending the full text produces much higher quality:
            # natural prosody, emotion, and flow (no choppy cuts).
            _progress(60, "🔊 Sintetizando narração completa com MiniMax TTS...")
            logger.info("voice.synthesizing_full", job_id=job_id)

            full_text = translation["full_text"]
            merged_audio = voice_dir / "merged_audio.wav"
            tts_raw = voice_dir / "tts_full_raw.wav"

            # Generate one single TTS audio
            tts_ok = await self._synthesize_full_audio(
                text=full_text,
                output_path=tts_raw,
                voice_id=voice_id,
            )

            if tts_ok:
                # ── Step 3.5: Reaper-style silence removal ─────────────
                # Uses SilenceRemover with exact Reaper "Auto trim/split"
                # settings: -40dB threshold, 100ms min silence/clip, 3ms
                # pads, fade enabled. Removes ALL internal silence, not
                # just start/end.
                _progress(64, "✂️ Removendo silêncios (Reaper -40dB)...")

                from src.utils.silence_remover import SilenceRemover

                remover = SilenceRemover()  # defaults match Reaper config
                try:
                    sr_result = await remover.remove_silence(tts_raw, merged_audio)
                    time_map = sr_result["time_map"]
                    original_tts_duration = sr_result["original_duration"]
                    total_audio_duration = sr_result["new_duration"]

                    logger.info(
                        "voice.silence_removed",
                        original=round(original_tts_duration, 2),
                        trimmed=round(total_audio_duration, 2),
                        removed=round(original_tts_duration - total_audio_duration, 2),
                        segments=len(time_map),
                    )
                except Exception as sr_err:
                    logger.warning("voice.silence_remover_failed", error=str(sr_err))
                    # Fallback: copy raw TTS as-is
                    import shutil
                    shutil.copy2(str(tts_raw), str(merged_audio))
                    time_map = []
                    ffprobe_bin = str(Path(self.ffmpeg.ffmpeg).parent / "ffprobe")
                    if not Path(ffprobe_bin).exists():
                        ffprobe_bin = "ffprobe"
                    dur_result = subprocess.run(
                        [ffprobe_bin, '-v', 'quiet', '-show_entries',
                         'format=duration', '-of', 'csv=p=0', str(merged_audio)],
                        capture_output=True, text=True
                    )
                    original_tts_duration = float(dur_result.stdout.strip())
                    total_audio_duration = original_tts_duration

                _progress(66, f'✂️ Áudio: {original_tts_duration:.1f}s → {total_audio_duration:.1f}s ({original_tts_duration - total_audio_duration:.1f}s removido)')

                # ── Step 4: Map audio segments → video segments ────────
                # The time_map tells us which parts of the TTS audio were
                # kept. We map those back to the Chinese video timeline.
                # Linear mapping: tts_time → video_time
                if time_map and len(time_map) > 1:
                    audio_to_video = duration / original_tts_duration if original_tts_duration > 0 else 1.0

                    segment_speeds = []
                    for entry in time_map:
                        # Map TTS audio timestamps back to original video
                        vid_start = entry["orig_start"] * audio_to_video
                        vid_end = entry["orig_end"] * audio_to_video
                        vid_dur = vid_end - vid_start

                        # Duration of this segment in the trimmed audio
                        audio_dur = entry["new_end"] - entry["new_start"]

                        # Speed factor: how fast to play this video segment
                        # to match the audio segment duration
                        spd = audio_dur / vid_dur if vid_dur > 0 else 1.0

                        segment_speeds.append({
                            "start": round(vid_start, 3),
                            "end": round(vid_end, 3),
                            "speed_factor": round(spd, 4),
                            "new_start": round(entry["new_start"], 3),
                            "new_end": round(entry["new_end"], 3),
                        })

                    speed_factor = total_audio_duration / duration if duration > 0 else 1.0

                    logger.info(
                        "voice.video_segments_mapped",
                        video_segments=len(segment_speeds),
                        global_speed=round(speed_factor, 4),
                        sample_speeds=[s["speed_factor"] for s in segment_speeds[:5]],
                    )
                else:
                    # No silence found or fallback: use global speed
                    speed_factor = total_audio_duration / duration if duration > 0 else 1.0
                    segment_speeds = []

                _progress(67, f'🎬 {len(segment_speeds)} segmentos de vídeo | Speed: {speed_factor:.2f}x')

                # ── Step 5: Transcribe TTS audio for PRECISE timestamps ──
                # Use AssemblyAI to transcribe the silence-trimmed audio.
                # This gives REAL timestamps per sentence, perfectly synced
                # with the spoken audio (no proportional guessing).
                _progress(68, "📝 Transcrevendo áudio para legendas precisas...")

                try:
                    subtitle_segments = await self._transcribe_for_subtitles(
                        audio_path=str(merged_audio),
                        language=manifest.target_language or "pt",
                    )
                    logger.info(
                        "voice.subtitles_from_transcription",
                        segments=len(subtitle_segments),
                        audio_file=str(merged_audio),
                        audio_duration=round(total_audio_duration, 2),
                    )
                except Exception as sub_err:
                    # Fallback: proportional distribution if transcription fails
                    # ATENÇÃO: este caminho gera legendas APROXIMADAS (desvio
                    # acumulativo) — o sync perfeito depende do AssemblyAI.
                    logger.error(
                        "voice.subtitle_transcription_failed_fallback",
                        error=str(sub_err),
                        msg="LEGENDAS APROXIMADAS — sync degradado",
                    )
                    _progress(68, "⚠️ Transcrição falhou — legendas aproximadas (sync degradado)")
                    raw_sub_segments = [{
                        "start": 0.0,
                        "end": total_audio_duration,
                        "original": "",
                        "translated": full_text,
                    }]
                    subtitle_segments = self._split_into_sentences(
                        raw_sub_segments, max_chars=70
                    )

                _progress(69, f"✅ {len(subtitle_segments)} legendas geradas")

                synced_segments = subtitle_segments
            else:
                # Fallback: create silent audio
                await self._create_silent_audio(merged_audio, duration)
                segment_speeds = []
                synced_segments = []
                speed_factor = 1.0
                time_map = []

            _progress(70, "✅ Áudio traduzido pronto!")
            manifest.set_tts_result(
                audio_segments=[],
                merged_audio_path=str(merged_audio),
                voice_id=voice_id,
                speed_factor=speed_factor,
                time_map=time_map if time_map else [],
                segment_speeds=segment_speeds,
            )

            # Store synced subtitle segments
            manifest.set_translation(
                segments=synced_segments,
                full_text=translation["full_text"],
                text_overlays=translation.get("text_overlays", []),
            )

            # Transition to overlay phase
            await self.db.update_job_status(job_id, JobStatus.PROCESSING_OVERLAY)

            logger.info(
                "voice.complete",
                job_id=job_id,
                subtitle_segments=len(synced_segments),
            )
            return manifest

        except Exception as e:
            error_msg = f"Voice processing failed: {str(e)}"
            logger.exception("voice.error", job_id=job_id, error=error_msg)
            await self.db.update_job_status(
                job_id, JobStatus.ERROR, error_message=error_msg
            )
            return None

    # ── AssemblyAI Transcription ───────────────────────────────────

    async def _transcribe(self, audio_path: str) -> dict[str, Any]:
        """Transcribe audio using AssemblyAI Python SDK."""
        import assemblyai as aai

        aai.settings.api_key = self.assemblyai_key

        config = aai.TranscriptionConfig(
            language_detection=True,
            speaker_labels=True,
            punctuate=True,
            format_text=True,
        )

        # Run in thread pool since the SDK is synchronous
        def _do_transcribe():
            transcriber = aai.Transcriber()
            transcript = transcriber.transcribe(audio_path, config=config)

            if transcript.status == aai.TranscriptStatus.error:
                raise RuntimeError(
                    f"AssemblyAI transcription failed: {transcript.error}"
                )

            segments = []
            if transcript.utterances:
                for utt in transcript.utterances:
                    segments.append({
                        "start": utt.start / 1000.0,  # ms → seconds
                        "end": utt.end / 1000.0,
                        "text": utt.text,
                        "speaker": utt.speaker,
                        "confidence": getattr(utt, "confidence", None),
                    })
            elif transcript.words:
                # Fall back to word-level if no utterances
                current_segment: dict[str, Any] = {
                    "start": 0, "end": 0, "text": "", "speaker": "A"
                }
                for word in transcript.words:
                    if (
                        current_segment["text"]
                        and word.start / 1000.0 - current_segment["end"] > 1.5
                    ):
                        segments.append(current_segment)
                        current_segment = {
                            "start": word.start / 1000.0,
                            "end": word.end / 1000.0,
                            "text": word.text,
                            "speaker": getattr(word, "speaker", "A"),
                        }
                    else:
                        if not current_segment["text"]:
                            current_segment["start"] = word.start / 1000.0
                        current_segment["end"] = word.end / 1000.0
                        current_segment["text"] += (
                            " " + word.text if current_segment["text"] else word.text
                        )
                if current_segment["text"]:
                    segments.append(current_segment)

            detected_lang = "zh"  # Default for Douyin
            if transcript.json_response and "language_code" in transcript.json_response:
                detected_lang = transcript.json_response["language_code"]

            return {
                "segments": segments,
                "full_text": transcript.text or "",
                "language": detected_lang,
            }

        result = await asyncio.get_event_loop().run_in_executor(None, _do_transcribe)
        logger.info(
            "voice.transcription_complete",
            segments=len(result["segments"]),
            language=result["language"],
        )
        return result

    # ── Full Audio TTS ─────────────────────────────────────────────

    async def _synthesize_full_audio(
        self,
        text: str,
        output_path: Path,
        voice_id: Optional[str] = None,
    ) -> bool:
        """Synthesize the complete translated text as ONE audio file.

        This produces dramatically better quality than per-segment TTS:
        - Natural prosody and flow across the entire narration
        - Consistent emotion and pacing
        - No choppy cuts between segments

        MiniMax Speech-02-HD supports up to 200k characters per request.
        """
        if not self.minimax_key:
            logger.warning("voice.minimax_key_missing")
            return False

        if not text or not text.strip():
            logger.warning("voice.empty_text")
            return False

        logger.info("voice.tts_full_start", text_length=len(text))

        async with httpx.AsyncClient(timeout=120.0) as client:
            payload = {
                "model": MINIMAX_MODEL,
                "text": text,
                "voice_setting": {
                    "voice_id": voice_id or self.minimax_voice_id,
                    "speed": 1.05,  # Slightly faster for dynamic narration
                    "vol": 1.0,
                    "pitch": 0,
                },
                "audio_setting": {
                    "sample_rate": 44100,
                    "format": "wav",
                },
            }

            try:
                response = await client.post(
                    MINIMAX_API_URL,
                    headers={
                        "Authorization": f"Bearer {self.minimax_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )

                if response.status_code != 200:
                    logger.error("voice.tts_full_api_error", status=response.status_code)
                    return False

                content_type = response.headers.get("content-type", "")
                if "application/json" in content_type:
                    resp_json = response.json()
                    base_resp = resp_json.get("base_resp", {})
                    if base_resp.get("status_code", 0) != 0:
                        logger.error("voice.tts_full_error", msg=base_resp.get("status_msg"))
                        return False
                    if "data" in resp_json and "audio" in resp_json["data"]:
                        audio_data = bytes.fromhex(resp_json["data"]["audio"])
                    elif "audio" in resp_json:
                        audio_data = bytes.fromhex(resp_json["audio"])
                    else:
                        logger.error("voice.tts_full_no_audio", keys=list(resp_json.keys()))
                        return False
                    output_path.write_bytes(audio_data)
                else:
                    output_path.write_bytes(response.content)

                logger.info(
                    "voice.tts_full_complete",
                    output=str(output_path),
                    size=output_path.stat().st_size,
                )
                return True

            except Exception as e:
                logger.error("voice.tts_full_exception", error=str(e))
                return False

    # ── Subtitle Timestamp Detection ───────────────────────────────

    async def _transcribe_for_subtitles(
        self,
        audio_path: str,
        language: str = "pt",
    ) -> list[dict[str, Any]]:
        """Transcribe the generated PT-BR audio to get precise subtitle timestamps.

        Uses AssemblyAI to detect WHEN each sentence is spoken in the
        generated audio. This gives us perfect subtitle timing that
        matches exactly what the narrator is saying.

        Returns:
            List of subtitle segments with start, end, and translated text.
        """
        import assemblyai as aai

        aai.settings.api_key = self.assemblyai_key

        # Map language codes to AssemblyAI language codes
        lang_map = {
            "pt-BR": "pt", "pt": "pt",
            "en-US": "en", "en": "en",
            "es-ES": "es", "es-MX": "es", "es": "es",
            "fr-FR": "fr", "fr": "fr",
            "de-DE": "de", "de": "de",
            "it-IT": "it", "it": "it",
            "ja-JP": "ja", "ja": "ja",
            "ko-KR": "ko", "ko": "ko",
            "hi-IN": "hi", "hi": "hi",
            "ru-RU": "ru", "ru": "ru",
        }
        aai_lang = lang_map.get(language, "pt")

        config = aai.TranscriptionConfig(
            language_code=aai_lang,
        )

        def _do_transcribe():
            transcriber = aai.Transcriber(config=config)
            transcript = transcriber.transcribe(audio_path)

            if transcript.status == aai.TranscriptStatus.error:
                raise RuntimeError(f"AssemblyAI error: {transcript.error}")

            # Build subtitle segments from sentences
            subtitle_segments = []

            if transcript.sentences():
                for sentence in transcript.sentences():
                    subtitle_segments.append({
                        "start": round(sentence.start / 1000.0, 3),
                        "end": round(sentence.end / 1000.0, 3),
                        "translated": sentence.text,
                    })
            elif transcript.words:
                # Fallback: group words into ~5-7 word chunks
                words = transcript.words
                chunk_size = 6
                for i in range(0, len(words), chunk_size):
                    chunk = words[i:i+chunk_size]
                    text = " ".join(w.text for w in chunk)
                    subtitle_segments.append({
                        "start": round(chunk[0].start / 1000.0, 3),
                        "end": round(chunk[-1].end / 1000.0, 3),
                        "translated": text,
                    })
            else:
                # Last resort: single subtitle
                subtitle_segments.append({
                    "start": 0.0,
                    "end": 999.0,
                    "translated": transcript.text or "",
                })

            return subtitle_segments

        result = await asyncio.get_event_loop().run_in_executor(None, _do_transcribe)
        logger.info(
            "voice.subtitle_detection_complete",
            segments=len(result),
            sample=[s["translated"][:40] for s in result[:3]],
        )
        return result

    # ── Sentence Splitter ──────────────────────────────────────────

    def _split_into_sentences(
        self,
        segments: list[dict[str, Any]],
        max_chars: int = 80,
    ) -> list[dict[str, Any]]:
        """Split long translation segments into individual sentences.

        Each segment's translated text is split at sentence boundaries
        (., !, ?, ;). Timestamps are distributed proportionally by
        character length.

        This ensures:
        - Each TTS call produces a short audio clip (better quality)
        - Each subtitle line corresponds to one sentence
        - Proper synchronization throughout the video

        Args:
            segments: Translation segments with start, end, translated fields.
            max_chars: Max characters per sentence before forced split.

        Returns:
            List of fine-grained segments with proportional timestamps.
        """
        import re
        result: list[dict[str, Any]] = []

        for seg in segments:
            text = seg.get("translated", "").strip()
            original = seg.get("original", "")
            start = float(seg.get("start", 0))
            end = float(seg.get("end", 0))
            total_dur = end - start

            if not text:
                continue

            # If already short enough, keep as-is
            if len(text) <= max_chars:
                result.append({
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "original": original,
                    "translated": text,
                })
                continue

            # Split at sentence boundaries: . ! ? followed by space or end
            sentences = re.split(r'(?<=[.!?])\s+', text)

            # Further split any remaining long sentences
            fine_sentences = []
            for sent in sentences:
                sent = sent.strip()
                if not sent:
                    continue
                if len(sent) <= max_chars:
                    fine_sentences.append(sent)
                else:
                    # Split at comma, semicolon, or force-split
                    sub_parts = re.split(r'(?<=[,;:])\s+', sent)
                    current = ""
                    for part in sub_parts:
                        if current and len(current) + len(part) + 2 > max_chars:
                            fine_sentences.append(current.strip())
                            current = part
                        else:
                            current = f"{current} {part}" if current else part
                    if current.strip():
                        fine_sentences.append(current.strip())

            if not fine_sentences:
                result.append({
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "original": original,
                    "translated": text,
                })
                continue

            # Distribute timestamps proportionally by character length
            total_chars = sum(len(s) for s in fine_sentences)
            current_time = start

            for i, sentence in enumerate(fine_sentences):
                ratio = len(sentence) / total_chars if total_chars > 0 else 1.0 / len(fine_sentences)
                seg_dur = total_dur * ratio
                seg_start = current_time
                seg_end = current_time + seg_dur
                current_time = seg_end

                result.append({
                    "start": round(seg_start, 3),
                    "end": round(seg_end, 3),
                    "original": "",
                    "translated": sentence,
                })

        # Merge very short segments (< 20 chars) with adjacent ones
        # to avoid single-word subtitles that flash too quickly.
        if len(result) > 1:
            merged: list[dict[str, Any]] = []
            skip_next = False
            for i, item in enumerate(result):
                if skip_next:
                    skip_next = False
                    continue
                if len(item["translated"]) < 20:
                    # Try merge forward
                    if (i + 1 < len(result)
                            and len(item["translated"]) + len(result[i+1]["translated"]) + 1 <= max_chars):
                        merged_item = item.copy()
                        merged_item["translated"] = item["translated"] + " " + result[i+1]["translated"]
                        merged_item["end"] = result[i+1]["end"]
                        merged.append(merged_item)
                        skip_next = True
                    # Try merge backward
                    elif (merged
                            and len(merged[-1]["translated"]) + len(item["translated"]) + 1 <= max_chars + 10):
                        merged[-1]["translated"] += " " + item["translated"]
                        merged[-1]["end"] = item["end"]
                    else:
                        merged.append(item.copy())
                else:
                    merged.append(item.copy())
            result = merged

        logger.info(
            "voice.split_sentences",
            input_segments=len(segments),
            output_segments=len(result),
        )
        return result

    # ── Claude Translation ─────────────────────────────────────────

    async def _translate(
        self,
        transcription_segments: list[dict[str, Any]],
        full_text: str,
        ocr_texts: list[str],
        source_language: str,
        target_language: str,
    ) -> dict[str, Any]:
        """Translate transcription and OCR texts using Claude."""
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=self.anthropic_key)

        # If only 1 segment with all text, split into ~5s chunks for better subtitles
        if len(transcription_segments) <= 1 and full_text:
            total_dur = transcription_segments[0]["end"] - transcription_segments[0]["start"] if transcription_segments else 180
            # Split text into roughly equal chunks aiming for ~5 second segments
            num_chunks = max(1, int(total_dur / 5))
            chars_per_chunk = max(1, len(full_text) // num_chunks)
            
            new_segments = []
            words = full_text.split()
            if not words:
                words = list(full_text)  # For Chinese text without spaces, split by character
                # Group characters into chunks
                chunk_size = max(1, len(words) // num_chunks)
                for i in range(0, len(words), chunk_size):
                    chunk_text = "".join(words[i:i+chunk_size])
                    chunk_start = (i / len(words)) * total_dur
                    chunk_end = min(((i + chunk_size) / len(words)) * total_dur, total_dur)
                    new_segments.append({
                        "start": round(chunk_start, 2),
                        "end": round(chunk_end, 2),
                        "text": chunk_text,
                    })
            else:
                chunk_size = max(1, len(words) // num_chunks)
                for i in range(0, len(words), chunk_size):
                    chunk_text = " ".join(words[i:i+chunk_size])
                    chunk_start = (i / len(words)) * total_dur
                    chunk_end = min(((i + chunk_size) / len(words)) * total_dur, total_dur)
                    new_segments.append({
                        "start": round(chunk_start, 2),
                        "end": round(chunk_end, 2),
                        "text": chunk_text,
                    })
            
            transcription_segments = new_segments
            logger.info(
                "voice.auto_segmented",
                original_segments=1,
                new_segments=len(new_segments),
            )

        # Build translation prompt
        segments_json = json.dumps(transcription_segments, ensure_ascii=False, indent=2)
        ocr_json = json.dumps(ocr_texts, ensure_ascii=False) if ocr_texts else "[]"

        # Perfil regional do idioma de destino — a tradução deve soar nativa
        LANG_PROFILES = {
            "pt-br": ("Brazilian Portuguese (português do Brasil)", "Brazilian"),
            "pt":    ("Brazilian Portuguese (português do Brasil)", "Brazilian"),
            "en":    ("American English", "American"),
            "en-us": ("American English", "American"),
            "es":    ("Latin American Spanish (español latinoamericano)", "Latin American"),
            "fr":    ("French from France (français de France)", "French"),
            "de":    ("German from Germany (Deutsch aus Deutschland)", "German"),
            "it":    ("Italian (italiano)", "Italian"),
            "ja":    ("Japanese (日本語)", "Japanese"),
            "ko":    ("Korean (한국어)", "Korean"),
            "hi":    ("Hindi (हिन्दी)", "Indian"),
            "ru":    ("Russian (русский)", "Russian"),
        }
        lang_name, audience = LANG_PROFILES.get(
            str(target_language).strip().lower(), (target_language, target_language)
        )

        system_prompt = f"""You are a native {lang_name} speaker and a professional localizer of short-form social video ({source_language} → {lang_name}).
Your translations must read as if originally written by a native {audience} content creator for Reels/TikTok:
- Use the natural register, rhythm and everyday vocabulary of {lang_name} — never literal or calqued phrasing
- Adapt idioms, slang, humor and cultural references so they land with a {audience} audience
- Localize numbers, units, currency and expressions the way {lang_name} natively writes them
- Preserve emotional tone, emphasis and timing of the original speech

CRITICAL RULES:
- You MUST translate ALL text to {lang_name}. NEVER leave text in the original language.
- Each segment MUST have a "translated" field with the translation in {lang_name}.
- Keep each subtitle segment short (max 2 lines, ~60 chars per line) for readability.
- Respond ONLY with valid JSON, no markdown or extra text."""

        user_prompt = f"""Translate the following video content from {source_language} to {target_language}.

## Speech Segments (with timestamps)
{segments_json}

## On-screen Text Overlays (OCR detected)
{ocr_json}

## Instructions
1. Translate each speech segment to {lang_name}, keeping the same start/end timestamps
2. Translate each OCR text overlay to {lang_name}
3. Keep translations natural and conversational in {lang_name}, as a native speaker would phrase them
4. Adapt idioms, slang and cultural references for a {audience} audience
5. IMPORTANT: Each segment's "translated" field MUST contain {lang_name} text, NOT the original language

Respond with this exact JSON structure:
{{
  "segments": [
    {{"start": 0.0, "end": 2.5, "original": "original text", "translated": "translated text in {lang_name}"}}
  ],
  "full_text": "complete translated text in {lang_name}",
  "text_overlays": [
    {{"original": "original overlay", "translated": "translated overlay in {lang_name}"}}
  ]
}}"""

        response = await client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=8192,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )

        # Parse Claude's response
        response_text = response.content[0].text.strip()

        # Handle potential markdown code block wrapper
        if response_text.startswith("```"):
            lines = response_text.split("\n")
            response_text = "\n".join(lines[1:-1])

        try:
            translation = json.loads(response_text)
        except json.JSONDecodeError:
            logger.warning("voice.translation_parse_error", response=response_text[:200])
            # Fallback: create basic translation structure
            translation = {
                "segments": [
                    {
                        "start": seg["start"],
                        "end": seg["end"],
                        "original": seg["text"],
                        "translated": seg["text"],  # Untranslated fallback
                    }
                    for seg in transcription_segments
                ],
                "full_text": full_text,
                "text_overlays": [
                    {"original": t, "translated": t} for t in ocr_texts
                ],
            }

        logger.info(
            "voice.translation_complete",
            segments=len(translation.get("segments", [])),
            overlays=len(translation.get("text_overlays", [])),
        )
        return translation

    # ── MiniMax TTS Synthesis ──────────────────────────────────────

    async def _synthesize_tts(
        self,
        segments: list[dict[str, Any]],
        output_dir: Path,
        progress_callback: Optional[callable] = None,
        voice_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Synthesize translated speech segments using MiniMax TTS API.

        Endpoint: POST https://api.minimax.io/v1/t2a_v2
        Model: speech-2.8-hd
        Auth: Bearer token
        """
        if not self.minimax_key:
            logger.warning("voice.minimax_key_missing", msg="Skipping TTS")
            return []

        tts_segments: list[dict[str, Any]] = []
        total = len(segments)

        async with httpx.AsyncClient(timeout=60.0) as client:
            for i, segment in enumerate(segments):
                translated_text = segment.get("translated", "")
                if not translated_text or not translated_text.strip():
                    continue

                # Update progress per-segment
                if progress_callback and total > 0:
                    seg_pct = 60 + int((i / total) * 7)  # 60-67%
                    progress_callback(seg_pct, f"🔊 Sintetizando voz segmento {i+1}/{total}...")

                try:
                    audio_path = output_dir / f"tts_segment_{i:04d}.mp3"

                    payload = {
                        "model": MINIMAX_MODEL,
                        "text": translated_text,
                        "voice_setting": {
                            "voice_id": voice_id or self.minimax_voice_id,
                            "speed": 1.0,
                            "vol": 1.0,
                            "pitch": 0,
                        },
                        "audio_setting": {
                            "sample_rate": 44100,
                            "format": "wav",
                        },
                    }

                    response = await client.post(
                        MINIMAX_API_URL,
                        headers={
                            "Authorization": f"Bearer {self.minimax_key}",
                            "Content-Type": "application/json",
                        },
                        json=payload,
                    )

                    if response.status_code != 200:
                        logger.error(
                            "voice.tts_api_error",
                            status=response.status_code,
                            body=response.text[:300],
                            segment_idx=i,
                        )
                        continue

                    # Check if response is JSON (error) or binary (audio)
                    content_type = response.headers.get("content-type", "")
                    if "application/json" in content_type:
                        resp_json = response.json()
                        # Check for API errors
                        base_resp = resp_json.get("base_resp", {})
                        if base_resp.get("status_code", 0) != 0:
                            logger.error(
                                "voice.tts_api_error",
                                status_code=base_resp.get("status_code"),
                                status_msg=base_resp.get("status_msg"),
                                segment_idx=i,
                            )
                            continue
                        # MiniMax returns audio as hex-encoded data
                        if "data" in resp_json and "audio" in resp_json["data"]:
                            audio_data = bytes.fromhex(resp_json["data"]["audio"])
                            audio_path.write_bytes(audio_data)
                        elif "audio" in resp_json:
                            audio_data = bytes.fromhex(resp_json["audio"])
                            audio_path.write_bytes(audio_data)
                        else:
                            logger.error(
                                "voice.tts_unexpected_json",
                                segment_idx=i,
                                keys=list(resp_json.keys()),
                            )
                            continue
                    else:
                        # Binary audio response
                        audio_path.write_bytes(response.content)

                    # Trim silence from start/end for dynamic pacing
                    trimmed_path = output_dir / f"tts_segment_{i:04d}_trimmed.wav"
                    try:
                        trim_proc = await asyncio.create_subprocess_exec(
                            self.ffmpeg.ffmpeg, "-y",
                            "-i", str(audio_path),
                            "-af", (
                                "silenceremove=start_periods=1"
                                ":start_threshold=-35dB"
                                ":start_duration=0.02"
                                ":start_silence=0.02,"
                                "areverse,"
                                "silenceremove=start_periods=1"
                                ":start_threshold=-35dB"
                                ":start_duration=0.02"
                                ":start_silence=0.02,"
                                "areverse"
                            ),
                            "-ar", "44100", "-ac", "2",
                            str(trimmed_path),
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE,
                        )
                        await trim_proc.wait()
                        if trim_proc.returncode == 0 and trimmed_path.exists() and trimmed_path.stat().st_size > 0:
                            audio_path = trimmed_path
                        else:
                            logger.warning("voice.trim_silence_failed", segment=i)
                    except Exception as trim_err:
                        logger.warning("voice.trim_silence_error", segment=i, error=str(trim_err))

                    tts_segments.append({
                        "path": str(audio_path),
                        "start": segment.get("start", 0),
                        "end": segment.get("end", 0),
                        "text": translated_text,
                        "translated": translated_text,
                        "index": i,
                    })

                    logger.debug(
                        "voice.tts_segment_done",
                        segment_idx=i,
                        text_length=len(translated_text),
                        audio_size=audio_path.stat().st_size,
                    )

                    # Rate limiting — be polite to the API
                    await asyncio.sleep(0.3)

                except Exception as e:
                    logger.error(
                        "voice.tts_segment_error",
                        segment_idx=i,
                        error=str(e),
                    )
                    continue

        logger.info(
            "voice.tts_complete",
            total_segments=len(segments),
            synthesized=len(tts_segments),
        )
        return tts_segments

    # ── Utilities ──────────────────────────────────────────────────

    async def _create_silent_audio(
        self, output_path: Path, duration: float, sample_rate: int = 44100
    ) -> None:
        """Create a silent WAV file as fallback."""
        output_path.parent.mkdir(parents=True, exist_ok=True)
        num_samples = int(duration * sample_rate)

        with wave.open(str(output_path), "w") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(b"\x00\x00\x00\x00" * num_samples)

        logger.debug("voice.silent_audio_created", path=str(output_path), duration=duration)
