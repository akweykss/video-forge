"""Silence removal utility for the VideoForge Translation Pipeline.

Replicates Reaper's 'Auto trim/split items' behavior:
  1. Detect silent regions via FFmpeg's ``silencedetect`` filter.
  2. Compute non-silent segments with configurable leading/trailing pads.
  3. Build a single-pass FFmpeg ``filter_complex`` that trims, fades, and
     concatenates every non-silent segment.
  4. Return a **time_map** that maps original timestamps → new timestamps
     so that subtitles can be re-synchronised after silence removal.
"""

from __future__ import annotations

import asyncio
import re
import tempfile
from pathlib import Path
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)


class SilenceRemoverError(Exception):
    """Raised when silence removal fails."""

    def __init__(self, message: str, returncode: int = -1, stderr: str = ""):
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


class SilenceRemover:
    """Detect and remove silent regions from an audio/video file.

    Mirrors the knobs exposed by Reaper's *Auto trim/split items* action:

    * **threshold_db** – volume floor below which audio counts as silence.
    * **min_silence_ms** – minimum consecutive silence to trigger a cut.
    * **min_clip_ms** – discard non-silent segments shorter than this.
    * **leading_pad_ms / trailing_pad_ms** – breathe room around each segment.
    * **fade_pad** – apply a short fade-in/out at the pad boundaries.
    """

    def __init__(
        self,
        ffmpeg_path: str = "ffmpeg",
        threshold_db: float = -40.0,
        min_silence_ms: int = 100,
        min_clip_ms: int = 100,
        leading_pad_ms: int = 3,
        trailing_pad_ms: int = 3,
        fade_pad: bool = True,
    ):
        # Auto-detect local static binary (same convention as FFmpegWrapper)
        _local_bin = Path(__file__).resolve().parent.parent.parent / "bin" / "ffmpeg"
        if _local_bin.exists():
            self.ffmpeg = str(_local_bin)
            logger.info("silence_remover.using_local_binary", path=self.ffmpeg)
        else:
            self.ffmpeg = ffmpeg_path

        self.threshold_db = threshold_db
        self.min_silence_ms = min_silence_ms
        self.min_clip_ms = min_clip_ms
        self.leading_pad_ms = leading_pad_ms
        self.trailing_pad_ms = trailing_pad_ms
        self.fade_pad = fade_pad

    # ── Public API ────────────────────────────────────────────────

    async def remove_silence(
        self,
        input_path: Path,
        output_path: Path,
    ) -> dict:
        """Detect silence, trim it out, and concatenate remaining segments.

        Args:
            input_path: Source audio or video file.
            output_path: Destination path for the silence-removed file.

        Returns:
            A dict with::

                {
                    "output_path": Path,
                    "time_map": [
                        {"orig_start": float, "orig_end": float,
                         "new_start": float, "new_end": float}, …
                    ],
                    "original_duration": float,
                    "new_duration": float,
                }
        """
        input_path = Path(input_path)
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        if not input_path.exists():
            raise FileNotFoundError(f"Input file not found: {input_path}")

        # Step 1 — get total duration
        original_duration = await self._get_duration(input_path)
        if original_duration <= 0:
            raise SilenceRemoverError("Unable to determine input duration.")

        logger.info(
            "silence_remover.start",
            input=str(input_path),
            duration=f"{original_duration:.3f}s",
            threshold=self.threshold_db,
        )

        # Step 2 — detect silent regions
        silent_regions = self._detect_silence(input_path)

        # Step 3 — invert: compute non-silent segments
        segments = self._invert_silence(silent_regions, original_duration)

        # Edge case: entire file is silence → produce empty output + empty map
        if not segments:
            logger.warning("silence_remover.all_silence", input=str(input_path))
            await self._produce_silent_output(output_path, duration=0.1)
            return {
                "output_path": output_path,
                "time_map": [],
                "original_duration": original_duration,
                "new_duration": 0.0,
            }

        # Edge case: no silence detected → copy input as-is
        if (
            len(segments) == 1
            and abs(segments[0]["start"]) < 0.001
            and abs(segments[0]["end"] - original_duration) < 0.01
        ):
            logger.info("silence_remover.no_silence_detected", input=str(input_path))
            await self._copy_file(input_path, output_path)
            return {
                "output_path": output_path,
                "time_map": [
                    {
                        "orig_start": 0.0,
                        "orig_end": original_duration,
                        "new_start": 0.0,
                        "new_end": original_duration,
                    }
                ],
                "original_duration": original_duration,
                "new_duration": original_duration,
            }

        # Step 4 — filter out segments shorter than min_clip_ms
        min_clip_s = self.min_clip_ms / 1000.0
        segments = [s for s in segments if (s["end"] - s["start"]) >= min_clip_s]

        if not segments:
            logger.warning(
                "silence_remover.no_segments_after_filter",
                min_clip_ms=self.min_clip_ms,
            )
            await self._produce_silent_output(output_path, duration=0.1)
            return {
                "output_path": output_path,
                "time_map": [],
                "original_duration": original_duration,
                "new_duration": 0.0,
            }

        # Step 5 — add leading/trailing pad (clamped to file boundaries)
        lead_s = self.leading_pad_ms / 1000.0
        trail_s = self.trailing_pad_ms / 1000.0
        padded_segments = []
        for seg in segments:
            padded_start = max(0.0, seg["start"] - lead_s)
            padded_end = min(original_duration, seg["end"] + trail_s)
            padded_segments.append({"start": padded_start, "end": padded_end})

        # Merge overlapping/adjacent padded segments
        padded_segments = self._merge_overlapping(padded_segments)

        # Step 6 — build filter_complex, run FFmpeg concat
        fade_ms = int(max(self.leading_pad_ms, self.trailing_pad_ms)) if self.fade_pad else 0
        await self._concat_segments(input_path, output_path, padded_segments, fade_ms)

        # Step 7 — build time_map
        time_map = self._build_time_map(padded_segments)
        new_duration = time_map[-1]["new_end"] if time_map else 0.0

        logger.info(
            "silence_remover.done",
            segments=len(padded_segments),
            original_duration=f"{original_duration:.3f}s",
            new_duration=f"{new_duration:.3f}s",
            removed=f"{original_duration - new_duration:.3f}s",
        )

        return {
            "output_path": output_path,
            "time_map": time_map,
            "original_duration": original_duration,
            "new_duration": new_duration,
        }

    # ── Silence Detection ─────────────────────────────────────────

    def _detect_silence(self, input_path: Path) -> list[dict]:
        """Run ``silencedetect`` synchronously and parse its stderr output.

        Returns a list of ``{"start": float, "end": float, "duration": float}``
        dicts for every detected silent region.
        """
        import subprocess

        min_silence_s = self.min_silence_ms / 1000.0

        cmd = [
            self.ffmpeg,
            "-i", str(input_path),
            "-af", f"silencedetect=noise={self.threshold_db}dB:d={min_silence_s}",
            "-f", "null",
            "-",
        ]

        logger.debug("silence_remover.detect_cmd", cmd=" ".join(cmd))

        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )

        stderr_text = result.stderr.decode("utf-8", errors="replace")
        return self._parse_silencedetect_output(stderr_text)

    @staticmethod
    def _parse_silencedetect_output(stderr: str) -> list[dict]:
        """Parse FFmpeg silencedetect filter output from stderr.

        Expected lines look like::

            [silencedetect @ 0x...] silence_start: 1.234
            [silencedetect @ 0x...] silence_end: 5.678 | silence_duration: 4.444

        Returns:
            List of ``{"start": float, "end": float, "duration": float}``.
        """
        starts: list[float] = []
        regions: list[dict] = []

        # Match silence_start lines
        start_re = re.compile(r"silence_start:\s*([\d.eE+-]+)")
        # Match silence_end lines (also captures duration)
        end_re = re.compile(
            r"silence_end:\s*([\d.eE+-]+)\s*\|\s*silence_duration:\s*([\d.eE+-]+)"
        )

        for line in stderr.splitlines():
            m_start = start_re.search(line)
            if m_start:
                starts.append(float(m_start.group(1)))
                continue

            m_end = end_re.search(line)
            if m_end:
                end_ts = float(m_end.group(1))
                dur = float(m_end.group(2))
                # Pair with the most recent unmatched start
                if starts:
                    start_ts = starts.pop(0)
                else:
                    # Fallback: derive start from end - duration
                    start_ts = max(0.0, end_ts - dur)

                regions.append({
                    "start": start_ts,
                    "end": end_ts,
                    "duration": dur,
                })

        # Handle trailing silence_start with no matching end (silence runs to EOF)
        # We leave it unmatched — the caller uses total duration to cap segments.

        logger.info("silence_remover.detected_regions", count=len(regions))
        return regions

    # ── Segment Computation ───────────────────────────────────────

    @staticmethod
    def _invert_silence(
        silent_regions: list[dict],
        total_duration: float,
    ) -> list[dict]:
        """Convert silent regions into non-silent segments.

        Given silence gaps, compute the complement intervals within
        ``[0, total_duration]``.
        """
        if not silent_regions:
            return [{"start": 0.0, "end": total_duration}]

        # Sort by start time
        regions = sorted(silent_regions, key=lambda r: r["start"])
        segments: list[dict] = []
        cursor = 0.0

        for region in regions:
            if region["start"] > cursor:
                segments.append({"start": cursor, "end": region["start"]})
            cursor = max(cursor, region["end"])

        # Trailing non-silent segment after last silence
        if cursor < total_duration:
            segments.append({"start": cursor, "end": total_duration})

        return segments

    @staticmethod
    def _merge_overlapping(segments: list[dict]) -> list[dict]:
        """Merge overlapping or adjacent segments after padding."""
        if not segments:
            return []

        merged = [segments[0].copy()]
        for seg in segments[1:]:
            if seg["start"] <= merged[-1]["end"]:
                merged[-1]["end"] = max(merged[-1]["end"], seg["end"])
            else:
                merged.append(seg.copy())

        return merged

    @staticmethod
    def _build_time_map(segments: list[dict]) -> list[dict]:
        """Build the time map from original → new timestamps.

        Each entry maps an original segment to its position in the output
        after silence removal. This is the **critical** data structure
        for subtitle re-synchronisation.
        """
        time_map: list[dict] = []
        new_cursor = 0.0

        for seg in segments:
            seg_duration = seg["end"] - seg["start"]
            time_map.append({
                "orig_start": seg["start"],
                "orig_end": seg["end"],
                "new_start": new_cursor,
                "new_end": new_cursor + seg_duration,
            })
            new_cursor += seg_duration

        return time_map

    # ── FFmpeg Filter Construction ────────────────────────────────

    def _build_concat_filter(
        self,
        segments: list[dict],
        fade_ms: int,
    ) -> str:
        """Build an FFmpeg ``filter_complex`` string that trims, optionally
        fades, and concatenates multiple audio segments from a single input.

        Args:
            segments: List of ``{"start": float, "end": float}`` dicts.
            fade_ms: Duration of fade-in/fade-out at segment boundaries (0 = off).

        Returns:
            A complete filter_complex string ready for ``-filter_complex``.
        """
        parts: list[str] = []
        labels: list[str] = []
        fade_s = fade_ms / 1000.0

        for i, seg in enumerate(segments):
            seg_duration = seg["end"] - seg["start"]
            label = f"s{i}"

            # Trim
            trim = (
                f"[0:a]atrim=start={seg['start']:.6f}:end={seg['end']:.6f},"
                f"asetpts=PTS-STARTPTS"
            )

            # Optional fade-in/out
            if fade_ms > 0 and fade_s < seg_duration:
                fade_in = f"afade=t=in:st=0:d={fade_s:.6f}"
                fade_out_start = seg_duration - fade_s
                fade_out = f"afade=t=out:st={fade_out_start:.6f}:d={fade_s:.6f}"
                trim = f"{trim},{fade_in},{fade_out}"

            parts.append(f"{trim}[{label}]")
            labels.append(f"[{label}]")

        # Concatenate all segments
        concat_inputs = "".join(labels)
        parts.append(f"{concat_inputs}concat=n={len(segments)}:v=0:a=1[outa]")

        return ";".join(parts)

    # ── FFmpeg Execution ──────────────────────────────────────────

    async def _concat_segments(
        self,
        input_path: Path,
        output_path: Path,
        segments: list[dict],
        fade_ms: int,
    ) -> None:
        """Use FFmpeg filter_complex to extract and concatenate non-silent segments."""
        filter_complex = self._build_concat_filter(segments, fade_ms)

        cmd = [
            self.ffmpeg, "-y",
            "-i", str(input_path),
            "-filter_complex", filter_complex,
            "-map", "[outa]",
            "-c:a", "pcm_s16le",
            str(output_path),
        ]

        logger.debug(
            "silence_remover.concat_cmd",
            segments=len(segments),
            filter_len=len(filter_complex),
        )

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        stderr_str = stderr.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            logger.error(
                "silence_remover.concat_failed",
                returncode=proc.returncode,
                stderr=stderr_str[-500:],
            )
            raise SilenceRemoverError(
                f"FFmpeg concat failed: {stderr_str[-300:]}",
                returncode=proc.returncode,
                stderr=stderr_str,
            )

        logger.info("silence_remover.concat_done", output=str(output_path))

    async def _get_duration(self, input_path: Path) -> float:
        """Get the duration of a media file via ffprobe/ffmpeg."""
        # Try ffprobe first (same binary directory)
        ffprobe = str(Path(self.ffmpeg).parent / "ffprobe")
        if not Path(ffprobe).exists():
            ffprobe = "ffprobe"

        cmd = [
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(input_path),
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            duration_str = stdout.decode("utf-8", errors="replace").strip()
            return float(duration_str)
        except (ValueError, FileNotFoundError):
            logger.warning(
                "silence_remover.ffprobe_fallback",
                msg="ffprobe unavailable or returned bad data, "
                    "falling back to ffmpeg -i parse",
            )

        # Fallback: parse ffmpeg -i stderr for "Duration: HH:MM:SS.xx"
        cmd_fallback = [self.ffmpeg, "-i", str(input_path)]
        proc = await asyncio.create_subprocess_exec(
            *cmd_fallback,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        stderr_str = stderr.decode("utf-8", errors="replace")

        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+)\.(\d+)", stderr_str)
        if m:
            h, mins, s, cs = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
            return h * 3600 + mins * 60 + s + cs / 100.0

        return 0.0

    async def _produce_silent_output(
        self,
        output_path: Path,
        duration: float = 0.1,
    ) -> None:
        """Generate a tiny silent audio file as a fallback output."""
        cmd = [
            self.ffmpeg, "-y",
            "-f", "lavfi",
            "-i", f"anullsrc=r=44100:cl=mono",
            "-t", str(duration),
            "-c:a", "pcm_s16le",
            str(output_path),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

    async def _copy_file(self, src: Path, dst: Path) -> None:
        """Copy a file using FFmpeg's stream-copy (avoids codec issues)."""
        cmd = [
            self.ffmpeg, "-y",
            "-i", str(src),
            "-c", "copy",
            str(dst),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            stderr_str = stderr.decode("utf-8", errors="replace")
            raise SilenceRemoverError(
                f"FFmpeg copy failed: {stderr_str[-300:]}",
                returncode=proc.returncode,
                stderr=stderr_str,
            )

    # ── Subtitle Remapping Helper ─────────────────────────────────

    @staticmethod
    def remap_timestamp(
        original_ts: float,
        time_map: list[dict],
    ) -> Optional[float]:
        """Map a single original timestamp to the new timeline.

        Uses the time_map produced by :meth:`remove_silence` to translate
        a timestamp from the original file to the silence-removed output.

        Returns:
            The remapped timestamp, or ``None`` if the timestamp falls
            inside a removed (silent) region.
        """
        for entry in time_map:
            if entry["orig_start"] <= original_ts <= entry["orig_end"]:
                offset = original_ts - entry["orig_start"]
                return entry["new_start"] + offset

        return None

    @staticmethod
    def remap_segments(
        segments: list[dict],
        time_map: list[dict],
    ) -> list[dict]:
        """Remap a list of subtitle/segment dicts to the new timeline.

        Each segment must have ``start`` and ``end`` keys (in seconds).
        Segments that fall entirely within a removed region are dropped.
        Segments that partially overlap a kept region are clamped.

        Returns:
            A new list of segment dicts with updated ``start``/``end`` values.
        """
        remapped: list[dict] = []

        for seg in segments:
            new_start = SilenceRemover.remap_timestamp(seg["start"], time_map)
            new_end = SilenceRemover.remap_timestamp(seg["end"], time_map)

            if new_start is None and new_end is None:
                # Entire segment falls in removed silence — skip
                continue

            # If only one endpoint landed in silence, clamp to nearest boundary
            if new_start is None:
                # Find the closest new_start from the time_map
                for entry in time_map:
                    if entry["orig_start"] >= seg["start"]:
                        new_start = entry["new_start"]
                        break
                if new_start is None:
                    continue

            if new_end is None:
                # Find the closest preceding new_end from the time_map
                for entry in reversed(time_map):
                    if entry["orig_end"] <= seg["end"]:
                        new_end = entry["new_end"]
                        break
                if new_end is None:
                    continue

            if new_end <= new_start:
                continue

            new_seg = seg.copy()
            new_seg["start"] = new_start
            new_seg["end"] = new_end
            remapped.append(new_seg)

        return remapped
