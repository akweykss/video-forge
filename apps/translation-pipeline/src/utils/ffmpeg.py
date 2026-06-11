"""FFmpeg wrapper functions for the VideoForge Translation Pipeline.

Provides async subprocess wrappers for FFmpeg operations:
- Audio extraction
- Motion interpolation (minterpolate)
- Time stretching
- LUT application
- Film grain overlay
- Metadata purging
- Video composition (merge video + audio + overlay)
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)

# Resolve the default LUT path relative to this file
_DEFAULT_LUT_PATH = Path(__file__).parent / "luts" / "gradient.cube"


class FFmpegError(Exception):
    """Raised when an FFmpeg command fails."""

    def __init__(self, message: str, returncode: int, stderr: str):
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


class FFmpegWrapper:
    """Async wrapper for FFmpeg operations used throughout the pipeline."""

    def __init__(self, ffmpeg_path: str = "ffmpeg", ffprobe_path: str = "ffprobe"):
        # Auto-detect local static binary with full filter support (libass, etc.)
        _local_bin = Path(__file__).resolve().parent.parent.parent / "bin" / "ffmpeg"
        if _local_bin.exists():
            self.ffmpeg = str(_local_bin)
            # Check for local ffprobe too
            _local_probe = _local_bin.parent / "ffprobe"
            self.ffprobe = str(_local_probe) if _local_probe.exists() else ffprobe_path
            logger.info("ffmpeg.using_local_binary", path=self.ffmpeg)
        else:
            self.ffmpeg = ffmpeg_path
            self.ffprobe = ffprobe_path

    async def _run(self, cmd: list[str], description: str = "ffmpeg") -> str:
        """Run an FFmpeg command asynchronously and return stdout."""
        logger.info("ffmpeg.run", description=description, cmd=" ".join(cmd))

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        stdout_str = stdout.decode("utf-8", errors="replace")
        stderr_str = stderr.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            logger.error(
                "ffmpeg.error",
                description=description,
                returncode=proc.returncode,
                stderr=stderr_str[-500:],
            )
            raise FFmpegError(
                f"FFmpeg failed ({description}): {stderr_str[-300:]}",
                returncode=proc.returncode,
                stderr=stderr_str,
            )

        logger.info("ffmpeg.done", description=description)
        return stdout_str

    @staticmethod
    def _escape_filter_path(path: str) -> str:
        """Escape a file path for use inside FFmpeg filter options.

        FFmpeg filter option values treat several characters as special:
        - : (colon) — option separator
        - \\ (backslash) — escape character
        - ' (single quote) — string delimiter
        - ; (semicolon) — filter separator
        - Spaces — need escaping in filter contexts

        We wrap the path in single quotes and escape internal special chars.
        """
        # First escape backslashes, then colons, then single quotes
        escaped = path.replace("\\", "\\\\")
        escaped = escaped.replace(":", "\\:")
        escaped = escaped.replace("'", "'\\''")
        # Wrap in single quotes to handle spaces
        return f"'{escaped}'"

    # ── Probing ────────────────────────────────────────────────────

    async def probe(self, input_path: str | Path) -> dict:
        """Get media file information using ffprobe."""
        import json as json_mod

        cmd = [
            self.ffprobe,
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(input_path),
        ]
        output = await self._run(cmd, description="probe")
        return json_mod.loads(output)

    async def get_duration(self, input_path: str | Path) -> float:
        """Get the duration of a media file in seconds."""
        info = await self.probe(input_path)
        return float(info.get("format", {}).get("duration", 0.0))

    async def get_resolution(self, input_path: str | Path) -> tuple[int, int]:
        """Get width x height of the first video stream."""
        info = await self.probe(input_path)
        for stream in info.get("streams", []):
            if stream.get("codec_type") == "video":
                return int(stream["width"]), int(stream["height"])
        raise ValueError(f"No video stream found in {input_path}")

    async def get_fps(self, input_path: str | Path) -> float:
        """Get frames per second of the first video stream."""
        info = await self.probe(input_path)
        for stream in info.get("streams", []):
            if stream.get("codec_type") == "video":
                r_frame_rate = stream.get("r_frame_rate", "30/1")
                num, den = r_frame_rate.split("/")
                return float(num) / float(den)
        return 30.0

    # ── Extraction ─────────────────────────────────────────────────

    async def extract_audio(
        self,
        input_path: str | Path,
        output_path: str | Path,
        sample_rate: int = 16000,
        mono: bool = True,
    ) -> Path:
        """Extract audio from a video file."""
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        cmd = [
            self.ffmpeg, "-y",
            "-i", str(input_path),
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", str(sample_rate),
        ]
        if mono:
            cmd.extend(["-ac", "1"])
        cmd.append(str(out))

        await self._run(cmd, description="extract_audio")
        return out

    async def extract_frames(
        self,
        input_path: str | Path,
        output_dir: str | Path,
        fps: float = 1.0,
        format: str = "png",
    ) -> Path:
        """Extract frames from a video at the specified FPS."""
        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        cmd = [
            self.ffmpeg, "-y",
            "-i", str(input_path),
            "-vf", f"fps={fps}",
            "-q:v", "2",
            str(out_dir / f"frame_%06d.{format}"),
        ]

        await self._run(cmd, description="extract_frames")
        return out_dir

    # ── Processing filters ─────────────────────────────────────────

    async def apply_motion_interpolation(
        self,
        input_path: str | Path,
        output_path: str | Path,
        target_fps: int = 60,
    ) -> Path:
        """Apply motion interpolation to boost FPS using minterpolate."""
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        vf = (
            f"minterpolate='mi_mode=mci:mc_mode=aobmc:vsbmc=1:fps={target_fps}'"
        )
        cmd = [
            self.ffmpeg, "-y",
            "-i", str(input_path),
            "-vf", vf,
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-c:a", "copy",
            str(out),
        ]

        await self._run(cmd, description="motion_interpolation")
        return out

    async def apply_time_stretch(
        self,
        input_path: str | Path,
        output_path: str | Path,
        factor: float = 1.0,
    ) -> Path:
        """Stretch/compress video timing by a factor."""
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        vf = f"setpts={factor}*PTS"
        af = f"atempo={1.0/factor}" if factor != 1.0 else "anull"

        # atempo only supports 0.5 to 100.0, chain if needed
        if factor != 1.0:
            tempo = 1.0 / factor
            af_parts: list[str] = []
            while tempo > 2.0:
                af_parts.append("atempo=2.0")
                tempo /= 2.0
            while tempo < 0.5:
                af_parts.append("atempo=0.5")
                tempo *= 2.0
            af_parts.append(f"atempo={tempo:.4f}")
            af = ",".join(af_parts)

        cmd = [
            self.ffmpeg, "-y",
            "-i", str(input_path),
            "-vf", vf,
            "-af", af,
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            str(out),
        ]

        await self._run(cmd, description="time_stretch")
        return out

    async def apply_lut(
        self,
        input_path: str | Path,
        output_path: str | Path,
        lut_path: Optional[str | Path] = None,
    ) -> Path:
        """Apply a 3D LUT color grade to the video."""
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        lut = Path(lut_path) if lut_path else _DEFAULT_LUT_PATH
        if not lut.exists():
            raise FileNotFoundError(f"LUT file not found: {lut}")

        # Escape special chars in path for FFmpeg filter syntax
        lut_escaped = str(lut).replace("\\", "/").replace(":", "\\:").replace("'", "'\\''")

        cmd = [
            self.ffmpeg, "-y",
            "-i", str(input_path),
            "-vf", f"lut3d=file='{lut_escaped}'",
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-c:a", "copy",
            str(out),
        ]

        await self._run(cmd, description="apply_lut")
        return out

    async def apply_film_grain(
        self,
        input_path: str | Path,
        output_path: str | Path,
        intensity: int = 25,
    ) -> Path:
        """Add film grain noise to the video."""
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        vf = f"noise=c0s={intensity}:c0f=t+u"
        cmd = [
            self.ffmpeg, "-y",
            "-i", str(input_path),
            "-vf", vf,
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-c:a", "copy",
            str(out),
        ]

        await self._run(cmd, description="film_grain")
        return out

    async def purge_metadata(
        self,
        input_path: str | Path,
        output_path: str | Path,
    ) -> Path:
        """Strip all metadata from the video for clean output."""
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        cmd = [
            self.ffmpeg, "-y",
            "-i", str(input_path),
            "-map_metadata", "-1",
            "-fflags", "+bitexact",
            "-flags:v", "+bitexact",
            "-flags:a", "+bitexact",
            "-c:v", "copy",
            "-c:a", "copy",
            str(out),
        ]

        await self._run(cmd, description="purge_metadata")
        return out

    # ── Composition ────────────────────────────────────────────────

    async def concat_audio_segments(
        self,
        segments: list[dict],
        output_path: str | Path,
    ) -> Path:
        """Concatenate audio segments back-to-back without gaps.

        Uses FFmpeg concat demuxer for seamless joining.
        Each segment: {"path": str, "start": float, "end": float}

        Returns:
            Path to the concatenated audio file.
        """
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        # Write concat list file
        concat_list = out.parent / "concat_list.txt"
        with open(concat_list, "w") as f:
            for seg in segments:
                # Escape single quotes in paths
                safe_path = str(seg["path"]).replace("'", "'\\''")
                f.write(f"file '{safe_path}'\n")

        cmd = [
            self.ffmpeg, "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list),
            "-ac", "2",
            "-ar", "44100",
            "-c:a", "pcm_s16le",
            str(out),
        ]

        await self._run(cmd, description="concat_audio_segments")
        logger.info(
            "ffmpeg.audio_concatenated",
            segments=len(segments),
            output=str(out),
        )
        return out

    async def merge_audio_segments(
        self,
        segments: list[dict],
        output_path: str | Path,
        total_duration: float,
    ) -> Path:
        """Merge multiple audio segments into a single audio track.

        Each segment: {"path": str, "start": float, "end": float}
        """
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        # Build a complex filter to position each segment
        inputs: list[str] = []
        filter_parts: list[str] = []

        for i, seg in enumerate(segments):
            inputs.extend(["-i", str(seg["path"])])
            delay_ms = int(seg["start"] * 1000)
            filter_parts.append(
                f"[{i}]adelay={delay_ms}|{delay_ms},apad[a{i}]"
            )

        # Mix all positioned segments
        mix_inputs = "".join(f"[a{i}]" for i in range(len(segments)))
        filter_parts.append(
            f"{mix_inputs}amix=inputs={len(segments)}:duration=longest[out]"
        )

        filter_complex = ";".join(filter_parts)

        cmd = [
            self.ffmpeg, "-y",
            *inputs,
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-t", str(total_duration),
            "-ac", "2",
            "-ar", "44100",
            str(out),
        ]

        await self._run(cmd, description="merge_audio_segments")
        return out

    async def compose_final(
        self,
        video_path: str | Path,
        audio_path: str | Path,
        output_path: str | Path,
        overlay_path: Optional[str | Path] = None,
    ) -> Path:
        """Compose the final video from source video, new audio, and optional overlay.

        If overlay_path is provided, it's composited on top of the video
        using alpha blending (expects ProRes 4444 with alpha).
        """
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        if overlay_path and Path(overlay_path).exists():
            # Composite overlay (ProRes 4444 alpha) on top of video, then add audio
            cmd = [
                self.ffmpeg, "-y",
                "-i", str(video_path),
                "-i", str(overlay_path),
                "-i", str(audio_path),
                "-filter_complex",
                "[0:v][1:v]overlay=0:0:shortest=1[outv]",
                "-map", "[outv]",
                "-map", "2:a",
                "-c:v", "libx264",
                "-preset", "medium",
                "-crf", "18",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(out),
            ]
        else:
            # Just replace audio on the video
            cmd = [
                self.ffmpeg, "-y",
                "-i", str(video_path),
                "-i", str(audio_path),
                "-map", "0:v",
                "-map", "1:a",
                "-c:v", "copy",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(out),
            ]

        await self._run(cmd, description="compose_final")
        return out

    # ── ASS Subtitle Generation ──────────────────────────────────────

    def generate_ass_subtitles(
        self,
        segments: list[dict],
        output_path: str | Path,
        video_width: int = 1920,
        video_height: int = 1080,
        style: str = "cinema",
        animation: str = "frases",
        sub_blur_y: Optional[int] = None,
        sub_blur_h: Optional[int] = None,
    ) -> Path:
        """Generate a .ass subtitle file with cinema-style yellow subtitles.

        Creates short-form video subtitles:
        - Yellow text (cinema standard)
        - Bold Arial, 92px
        - Max 2 lines, ~22 chars per line
        - Positioned centered ON the blur region
        - Black outline for readability

        Args:
            segments: List of dicts with {start, end, translated} keys.
            output_path: Path for the output .ass file.
            video_width: Video width for subtitle layout.
            video_height: Video height for subtitle layout.
            style: Style preset.
            sub_blur_y: Y position (from top) where blur starts.
            sub_blur_h: Height of the blur region in pixels.

        Returns:
            Path to the generated .ass file.
        """
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        def _secs_to_ass_timecode(seconds: float) -> str:
            """Convert seconds to ASS timecode format: H:MM:SS.CC"""
            h = int(seconds // 3600)
            m = int((seconds % 3600) // 60)
            s = int(seconds % 60)
            cs = int(round((seconds % 1) * 100))
            if cs >= 100:
                cs = 99
            return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

        def _wrap_text(text: str, max_chars: int = 22) -> str:
            """Break long text into max 2 lines using \\N (ASS line break).

            Rules:
            - If text <= max_chars, keep as single line
            - Otherwise, split at word boundary near the middle
            - Max 2 lines, NEVER truncate with '...'
            """
            text = text.strip()
            if len(text) <= max_chars:
                return text

            # Try to split at a natural point near the middle
            mid = len(text) // 2
            best_split = -1
            for offset in range(0, mid):
                for pos in [mid + offset, mid - offset]:
                    if 0 < pos < len(text) and text[pos] == ' ':
                        best_split = pos
                        break
                    if 0 < pos < len(text) and text[pos] in ',;:':
                        best_split = pos + 1
                        break
                if best_split >= 0:
                    break

            if best_split < 0:
                best_split = max_chars

            line1 = text[:best_split].strip()
            line2 = text[best_split:].strip()

            return f"{line1}\\N{line2}"

        # MarginV: distance from bottom edge of video
        # Position subtitles ON the blur region that covers Chinese text
        # Fonte proporcional à largura — nunca encosta nas bordas
        font_size = max(40, int(video_width * 0.052))
        margin_lr = int(video_width * 0.06)
        avg_char_px = font_size * 0.55
        max_line_chars = max(10, int((video_width - 2 * margin_lr) / avg_char_px))
        text_block_h = font_size * 2  # 2 lines of text

        if sub_blur_y and sub_blur_h:
            blur_bottom = sub_blur_y + sub_blur_h
            blur_center_y = sub_blur_y + (sub_blur_h // 2)

            # Try to center text on blur
            margin_v = video_height - blur_center_y - (text_block_h // 2)

            if margin_v < 0:
                # Blur is at the very bottom — align text bottom with blur bottom
                margin_v = video_height - blur_bottom
        elif sub_blur_y:
            # Only blur_y known, align text top with blur top
            margin_v = video_height - sub_blur_y - text_block_h
        else:
            margin_v = 5

        # Clamp MarginV — never negative, max half the screen
        margin_v = max(0, min(margin_v, video_height // 2))
        outline_px = 4
        shadow_px = 0
        # Presets de estilo — cores em ASS &HAABBGGRR (BGR, não RGB)
        SUB_STYLES = {
            "cinema":   {"primary": "&H0000FFFF", "back": "&H96000000", "border_style": 3},  # amarela + caixa
            "classica": {"primary": "&H00FFFFFF", "back": "&H96000000", "border_style": 3},  # branca + caixa
            "limpa":    {"primary": "&H00FFFFFF", "back": "&H00000000", "border_style": 1},  # branca, só contorno
            "dourada":  {"primary": "&H0014C8FF", "back": "&H00000000", "border_style": 1},  # dourada, só contorno
        }
        _st = SUB_STYLES.get(str(style).lower(), SUB_STYLES["cinema"])
        primary_color = _st["primary"]
        outline_color = "&H00000000"   # Black outline
        back_color = _st["back"]
        border_style = _st["border_style"]
        bold = -1  # Bold

        header = (
            "[Script Info]\n"
            "ScriptType: v4.00+\n"
            f"PlayResX: {video_width}\n"
            f"PlayResY: {video_height}\n"
            "WrapStyle: 2\n"  # No auto-wrap, only manual \\N breaks
            "ScaledBorderAndShadow: yes\n"
            "\n"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Cinema,Arial,{font_size},{primary_color},&H000000FF,"
            f"{outline_color},{back_color},{bold},0,0,0,"
            f"100,100,1,0,{border_style},{outline_px},{shadow_px},"
            f"2,{margin_lr},{margin_lr},{margin_v},1\n"
            "\n"
            "[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
            "Effect, Text\n"
        )

        # Calculate absolute position for subtitles on the blur zone
        # blur_y = TOP of detected text region (where Chinese text starts)
        # We place the subtitle CENTER at blur_y so it overlaps the Chinese text
        if sub_blur_y and sub_blur_h:
            pos_x = video_width // 2
            # blur_y = top of detected Chinese text
            # With Alignment=2 (bottom-center), pos_y = bottom edge of text
            # Move down by 2x font_size so the text covers the Chinese text
            pos_y = sub_blur_y + font_size * 2
            # Clamp: o texto nunca sai da área visível do canvas
            _top_min = text_block_h + int(video_height * 0.03)
            _bot_max = video_height - int(video_height * 0.035)
            pos_y = max(_top_min, min(pos_y, _bot_max))
            use_pos = True
            logger.info(
                "ffmpeg.subtitle_position",
                blur_y=sub_blur_y,
                blur_h=sub_blur_h,
                pos_x=pos_x,
                pos_y=pos_y,
                video=f"{video_width}x{video_height}",
            )
        else:
            use_pos = False

        def _word_groups(text: str) -> list[str]:
            """Grupos de 2-3 palavras para a animação estilo TikTok."""
            words = text.split()
            groups: list[str] = []
            cur: list[str] = []
            for w in words:
                cur.append(w)
                if len(cur) >= 3 or (sum(len(x) for x in cur) + len(cur) - 1) >= 16:
                    groups.append(" ".join(cur))
                    cur = []
            if cur:
                groups.append(" ".join(cur))
            return groups

        _anim_words = str(animation).lower() in ("palavras", "palavra", "tiktok", "word", "words")
        _ptag = f"{{\\pos({pos_x},{pos_y})}}" if use_pos else ""

        lines: list[str] = [header]
        for seg in segments:
            start_tc = _secs_to_ass_timecode(float(seg["start"]))
            end_tc = _secs_to_ass_timecode(float(seg["end"]))
            raw_text = str(seg.get("translated", "")).strip()

            if not raw_text:
                continue

            # Animação palavra por palavra: cada grupo de 2-3 palavras
            # aparece no seu tempo, distribuído pela duração da fala
            if _anim_words:
                _s0 = float(seg["start"])
                _s1 = float(seg["end"])
                _groups = _word_groups(raw_text)
                _total = sum(len(g) for g in _groups) or 1
                _t = _s0
                for _g in _groups:
                    _d = (_s1 - _s0) * (len(_g) / _total)
                    _tc0 = _secs_to_ass_timecode(_t)
                    _tc1 = _secs_to_ass_timecode(min(_t + _d, _s1))
                    lines.append(
                        f"Dialogue: 0,{_tc0},{_tc1},Cinema,,0,0,0,,"
                        f"{_ptag}{{\\fad(60,40)}}{_g}\n"
                    )
                    _t += _d
                continue

            # Apply line wrapping (max chars proporcionais, max 2 visual lines)
            wrapped = _wrap_text(raw_text, max_line_chars)

            # Use \pos(x,y) for pixel-perfect placement on blur
            if use_pos:
                pos_tag = f"{{\\pos({pos_x},{pos_y})}}"
                lines.append(
                    f"Dialogue: 0,{start_tc},{end_tc},Cinema,,0,0,0,,{pos_tag}{wrapped}\n"
                )
            else:
                lines.append(
                    f"Dialogue: 0,{start_tc},{end_tc},Cinema,,0,0,0,,{wrapped}\n"
                )

        out.write_text("".join(lines), encoding="utf-8-sig")
        logger.info(
            "ffmpeg.ass_generated",
            output=str(out),
            segments=len(segments),
            margin_v=margin_v,
            font_size=font_size,
        )
        return out

    # ── Single-pass Synthesis Pipeline ─────────────────────────────

    async def full_synthesis_pipeline(
        self,
        video_path: str | Path,
        audio_path: str | Path,
        output_path: str | Path,
        overlay_path: Optional[str | Path] = None,
        ass_subtitle_path: Optional[str | Path] = None,
        speed_factor: float = 1.0,
        apply_hflip: bool = True,
        sub_blur_region: Optional[dict] = None,
        apply_lut_flag: bool = True,
        apply_grain_flag: bool = True,
        apply_minterp_flag: bool = False,
        lut_path: Optional[str | Path] = None,
        grain_intensity: int = 8,
        work_dir: Optional[str | Path] = None,
        progress_callback: Optional[callable] = None,
        segment_speeds: Optional[list[dict]] = None,
        vertical_canvas: bool = False,
    ) -> Path:
        """Run the full synthesis pipeline in a SINGLE FFmpeg pass.

        Uses filter_complex to blur original subtitles with gblur and
        apply all video effects in one encoding pass:

            [0:v] → setpts → hflip → split → crop+gblur → overlay →
                    subtitles (.ass) → lut3d → noise → [vout]

        The blur region is covered with a gaussian blur (sigma=25) instead
        of a black box, producing a natural-looking cover effect.

        The audio from audio_path is muxed directly with AAC encoding.
        All metadata is purged from the output for anti-ContentID purposes.

        Args:
            video_path: Source video file.
            audio_path: Translated audio track to mux in.
            output_path: Final output video path.
            overlay_path: Unused, kept for backward compatibility.
            ass_subtitle_path: Path to .ass subtitle file for burn-in.
            speed_factor: Video speed factor (e.g., 1.05 = 5% faster).
            apply_hflip: Whether to horizontally flip the video.
            sub_blur_region: Dict with {y, h} for subtitle blur box, or None.
            apply_lut_flag: Whether to apply LUT color grading.
            apply_grain_flag: Whether to add film grain noise.
            apply_minterp_flag: Unused, kept for backward compatibility.
            lut_path: Path to .cube LUT file (uses default if None).
            grain_intensity: Noise intensity for film grain (0-100).
            work_dir: Working directory (unused, kept for compat).
            progress_callback: Callable(pct, message) for progress updates.

        Returns:
            Path to the final output video.
        """
        final = Path(output_path)
        final.parent.mkdir(parents=True, exist_ok=True)

        def _progress(pct: float, msg: str):
            if progress_callback:
                progress_callback(pct, msg)

        _progress(87, "🎬 Construindo pipeline de síntese (single-pass)...")

        # ── Helper: create symlinks in /tmp for paths with spaces ──
        # FFmpeg filter parser cannot handle spaces in paths reliably
        import tempfile
        _tmp_links: list[Path] = []

        def _safe_filter_path(original: str | Path) -> str:
            """Return a path usable in FFmpeg filters (no spaces)."""
            p = str(original)
            if " " not in p and ":" not in p:
                return p
            # Create symlink in /tmp with no spaces
            suffix = Path(p).suffix
            tmp = tempfile.NamedTemporaryFile(
                delete=False, suffix=suffix, prefix="ffvf_"
            )
            tmp.close()
            tmp_path = Path(tmp.name)
            tmp_path.unlink()  # remove file, we'll make a symlink
            tmp_path.symlink_to(Path(p).resolve())
            _tmp_links.append(tmp_path)
            return str(tmp_path)

        # ── Check for subtitles filter availability ────────────────
        _subs_applied = False
        has_subtitles_filter = False
        safe_ass = None
        if ass_subtitle_path and Path(ass_subtitle_path).exists():
            try:
                check = await asyncio.create_subprocess_exec(
                    self.ffmpeg, "-filters",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                check_out, _ = await check.communicate()
                has_subtitles_filter = b"subtitles" in check_out
            except Exception:
                has_subtitles_filter = False

            if has_subtitles_filter:
                safe_ass = _safe_filter_path(ass_subtitle_path)
                logger.info(
                    "ffmpeg.filter.subtitles",
                    path=str(ass_subtitle_path),
                    safe=safe_ass,
                )
            else:
                logger.warning(
                    "ffmpeg.subtitles_unavailable",
                    msg="FFmpeg compiled without libass. Subtitles in separate pass.",
                )

        # ── Resolve LUT path ──────────────────────────────────────
        safe_lut = None
        lut_applied = False
        if apply_lut_flag:
            lut = Path(lut_path) if lut_path else _DEFAULT_LUT_PATH
            if lut.exists():
                safe_lut = _safe_filter_path(str(lut))
                lut_applied = True
                logger.info("ffmpeg.filter.lut3d", path=str(lut), safe=safe_lut)
            else:
                logger.warning("ffmpeg.lut_not_found", path=str(lut))

        # ── Build filter graph ────────────────────────────────────
        # Strategy: if blur is needed OR segment_speeds, we MUST use filter_complex
        use_filter_complex = sub_blur_region is not None or (segment_speeds and len(segment_speeds) > 1) or vertical_canvas

        if use_filter_complex:
            filter_graph = self._build_filter_complex(
                sub_blur_region=sub_blur_region,  # pass None explicitly — blur skipped when None
                speed_factor=speed_factor,
                apply_hflip=apply_hflip,
                safe_ass=safe_ass if has_subtitles_filter else None,
                safe_lut=safe_lut,
                apply_grain=apply_grain_flag,
                grain_intensity=grain_intensity,
                segment_speeds=segment_speeds,
                vertical_canvas=vertical_canvas,
            )
            if safe_ass and has_subtitles_filter:
                _subs_applied = True
            logger.info("ffmpeg.filter_complex", graph=filter_graph)
        else:
            # No blur → simple linear -vf chain
            vf_filters: list[str] = []
            if speed_factor != 1.0:
                vf_filters.append(f"setpts={speed_factor}*PTS")
            if apply_hflip:
                vf_filters.append("hflip")
            if safe_ass and has_subtitles_filter:
                vf_filters.append(f"subtitles=filename={safe_ass}")
                _subs_applied = True
            if safe_lut:
                vf_filters.append(f"lut3d=file='{safe_lut}'")
            if apply_grain_flag and grain_intensity > 0:
                vf_filters.append(f"noise=c0s={grain_intensity}:c0f=t+u")
            filter_graph = None  # will use -vf instead
            logger.info(
                "ffmpeg.filter_chain",
                chain=",".join(vf_filters) if vf_filters else "(none)",
            )

        _progress(89, "🔧 Filtros configurados, iniciando encoding...")

        # ── Assemble the FFmpeg command ───────────────────────────
        cmd: list[str] = [
            self.ffmpeg, "-y",
            "-i", str(video_path),   # input 0: source video
            "-i", str(audio_path),   # input 1: translated audio
        ]

        if use_filter_complex:
            cmd.extend(["-filter_complex", filter_graph])
            cmd.extend(["-map", "[vout]", "-map", "1:a:0"])
        else:
            if vf_filters:
                cmd.extend(["-vf", ",".join(vf_filters)])
            cmd.extend(["-map", "0:v:0", "-map", "1:a:0"])

        # Video encoding: libx264 CRF 26 — Android-compatible
        cmd.extend([
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "26",
            "-pix_fmt", "yuv420p",
            "-profile:v", "high",
            "-level", "4.1",
            "-maxrate", "8M",
            "-bufsize", "16M",
        ])

        # Audio encoding
        cmd.extend([
            "-c:a", "aac",
            "-b:a", "192k",
        ])

        # Metadata purge flags (anti-ContentID)
        cmd.extend([
            "-map_metadata", "-1",
            "-fflags", "+bitexact",
            "-flags:v", "+bitexact",
            "-flags:a", "+bitexact",
        ])

        # Fast-start for web streaming
        cmd.extend(["-movflags", "+faststart"])

        # Trim output to audio duration — prevents silence at end
        cmd.extend(["-shortest"])

        # NOTE: Do NOT apply atempo to audio. The translated TTS audio is
        # already at the correct speed. Only the VIDEO is speed-adjusted
        # via setpts in the filter graph. Applying atempo would distort
        # the translated voice.

        cmd.append(str(final))

        _progress(91, "⚡ Encoding single-pass (libx264 CRF 26)...")

        try:
            await self._run(cmd, description="full_synthesis_pipeline")
        except FFmpegError as e:
            logger.error(
                "ffmpeg.synthesis_failed",
                stderr=e.stderr[-500:] if e.stderr else "",
            )
            raise
        finally:
            # Clean up temporary symlinks
            for link in _tmp_links:
                try:
                    link.unlink(missing_ok=True)
                except Exception:
                    pass

        # ── Second pass: burn subtitles if not applied in first pass ──
        if ass_subtitle_path and Path(ass_subtitle_path).exists() and not _subs_applied:
            _progress(95, "📝 Queimando legendas (segunda passada)...")
            try:
                final = await self._burn_subtitles_srt_pass(
                    video_path=final,
                    ass_path=Path(ass_subtitle_path),
                    progress_callback=progress_callback,
                )
            except Exception as e:
                logger.warning(
                    "ffmpeg.subtitle_burn_failed",
                    error=str(e),
                    msg="Continuing without subtitles",
                )

        _progress(99, "✅ Síntese completa — arquivo final gerado!")
        logger.info("ffmpeg.synthesis_complete", output=str(final))
        return final

    @staticmethod
    def _build_filter_complex(
        sub_blur_region: Optional[dict],
        speed_factor: float = 1.0,
        apply_hflip: bool = True,
        safe_ass: Optional[str] = None,
        safe_lut: Optional[str] = None,
        apply_grain: bool = True,
        grain_intensity: int = 8,
        segment_speeds: Optional[list[dict]] = None,
        vertical_canvas: bool = False,
    ) -> str:
        """Build a filter_complex graph string with optional gblur per-segment sync.

        When sub_blur_region is None, Stage 3 (split/crop/gblur/overlay) is
        skipped entirely — the video goes straight from hflip to post-processing.

        When segment_speeds is provided, builds a per-segment speed graph:
            For each segment: [0:v]trim=start:end,setpts=speed*PTS[seg_i]
            [seg_0][seg_1]...[seg_n]concat=n=N:v=1:a=0[synced]
            [synced] → hflip → [optional: split → crop+gblur → overlay] → lut3d → noise → [vout]
        """
        # ── Blur parameters (only when blur is requested) ─────────
        apply_blur = sub_blur_region is not None
        if apply_blur:
            blur_y = sub_blur_region.get("y", 900)
            blur_h = sub_blur_region.get("h", 180)

            # CAP: the blur must only cover the subtitle text, never more
            # than ~180px. OCR sometimes detects oversized regions (300+px).
            MAX_BLUR_H = 180
            if blur_h > MAX_BLUR_H:
                # Keep the BOTTOM edge fixed (that's where the text is),
                # shrink from the top.
                excess = blur_h - MAX_BLUR_H
                blur_y = blur_y + excess
                blur_h = MAX_BLUR_H

            # Tight padding — the blur must stay locked to the subtitle area.
            pad = 5
            crop_y = max(0, blur_y - pad)
            crop_h = blur_h + pad * 2
            overlay_y = crop_y

        parts: list[str] = []

        # ── Stage 1: Speed adjustment ──────────────────────────────────────
        if segment_speeds and len(segment_speeds) > 1:
            # Per-segment speed: trim → setpts(reset + speed) → concat
            for i, seg in enumerate(segment_speeds):
                start = seg["start"]
                end = seg["end"]
                spd = seg.get("speed_factor", 1.0)
                # CRITICAL: After trim, PTS still carries original timestamps.
                # We MUST reset with (PTS-STARTPTS) first, then apply speed.
                # Without this, concat sees discontinuous PTS → video freezes.
                if spd != 1.0:
                    pts_expr = f"(PTS-STARTPTS)*{spd:.4f}"
                else:
                    pts_expr = "PTS-STARTPTS"
                parts.append(
                    f"[0:v]trim=start={start:.3f}:end={end:.3f},"
                    f"setpts={pts_expr}[seg{i}]"
                )

            # Concat all segments
            concat_inputs = "".join(f"[seg{i}]" for i in range(len(segment_speeds)))
            parts.append(
                f"{concat_inputs}concat=n={len(segment_speeds)}:v=1:a=0[synced]"
            )
            pre_input = "[synced]"
        else:
            # Global speed factor
            if speed_factor != 1.0:
                parts.append(f"[0:v]setpts={speed_factor:.4f}*PTS[speed_adj]")
                pre_input = "[speed_adj]"
            else:
                pre_input = "[0:v]"

        # ── Stage 2: hflip ──────────────────────────────────────────
        if apply_hflip:
            parts.append(f"{pre_input}hflip[flipped]")
            post_flip_input = "[flipped]"
        else:
            post_flip_input = pre_input

        # ── Stage 3: split → crop → gblur → overlay (ONLY when blur requested) ─
        if apply_blur:
            parts.append(f"{post_flip_input}split=2[main][blur_src]")
            parts.append(
                f"[blur_src]crop=iw:{crop_h}:0:{crop_y},"
                f"gblur=sigma=60[blurred]"
            )
            parts.append(
                f"[main][blurred]overlay=0:{overlay_y}[post_blur]"
            )
            stage4_input = "[post_blur]"
        else:
            # No blur — pass through directly
            stage4_input = post_flip_input

        # ── Stage 3.5: canvas vertical 9:16 (fundo desfocado do vídeo) ──
        # Blur usa coordenadas do vídeo original (estágio 3); as legendas
        # (.ass) já são geradas no espaço do canvas 1080×1920.
        if vertical_canvas:
            parts.append(f"{stage4_input}split=2[vc_bg][vc_fg]")
            parts.append(
                "[vc_bg]scale=1080:1920:force_original_aspect_ratio=increase,"
                "crop=1080:1920,gblur=sigma=24[vc_bgb]"
            )
            parts.append(
                "[vc_fg]scale=1080:1920:force_original_aspect_ratio=decrease[vc_fgs]"
            )
            parts.append("[vc_bgb][vc_fgs]overlay=(W-w)/2:(H-h)/2[vcanvas]")
            stage4_input = "[vcanvas]"

        # ── Stage 4: post-processing (subtitles, LUT, grain) ───────────
        post_filters: list[str] = []
        if safe_ass:
            post_filters.append(f"subtitles=filename={safe_ass}")
        if safe_lut:
            post_filters.append(f"lut3d=file='{safe_lut}'")
        if apply_grain and grain_intensity > 0:
            post_filters.append(f"noise=c0s={grain_intensity}:c0f=t+u")

        if post_filters:
            post_chain = ",".join(post_filters)
            parts.append(f"{stage4_input}{post_chain}[vout]")
        else:
            parts.append(f"{stage4_input}null[vout]")

        return ";".join(parts)

    async def _burn_subtitles_srt_pass(
        self,
        video_path: Path,
        ass_path: Path,
        progress_callback: Optional[callable] = None,
    ) -> Path:
        """Burn subtitles into video using SRT conversion + drawtext.

        Falls back to this method when FFmpeg is compiled without libass.
        Converts ASS → SRT, then uses ffmpeg with -sub_charenc / srt overlay.
        """
        # Parse the .ass file to extract dialogue lines
        import re

        srt_path = ass_path.with_suffix(".srt")
        events = []

        ass_content = ass_path.read_text(encoding="utf-8-sig")
        for line in ass_content.split("\n"):
            if line.startswith("Dialogue:"):
                # Format: Dialogue: Layer,Start,End,Style,Name,ML,MR,MV,Effect,Text
                parts = line.split(",", 9)
                if len(parts) >= 10:
                    start = parts[1].strip()
                    end = parts[2].strip()
                    text = parts[9].strip().replace("\\N", "\n")
                    events.append((start, end, text))

        if not events:
            logger.warning("ffmpeg.no_subtitle_events", path=str(ass_path))
            return video_path

        # Convert to SRT format
        def _ass_to_srt_time(t: str) -> str:
            """Convert ASS time (H:MM:SS.CC) to SRT time (HH:MM:SS,MMM)."""
            match = re.match(r"(\d+):(\d{2}):(\d{2})\.(\d{2})", t)
            if not match:
                return "00:00:00,000"
            h, m, s, cs = match.groups()
            ms = int(cs) * 10
            return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{ms:03d}"

        srt_lines = []
        for i, (start, end, text) in enumerate(events, 1):
            srt_lines.append(f"{i}")
            srt_lines.append(f"{_ass_to_srt_time(start)} --> {_ass_to_srt_time(end)}")
            srt_lines.append(text)
            srt_lines.append("")

        srt_path.write_text("\n".join(srt_lines), encoding="utf-8")
        logger.info("ffmpeg.srt_generated", path=str(srt_path), events=len(events))

        # Use ffmpeg to overlay SRT as a soft subtitle stream, then hardcode
        # Method: use -vf "srt" overlay which works without libass on some builds
        # Fallback: use PIL to render text frames and overlay
        output_with_subs = video_path.with_name(
            video_path.stem + "_subs" + video_path.suffix
        )

        # Try using the 'drawtext' approach with textfile
        try:
            # Build drawtext filter chain for each subtitle
            # This creates a single drawtext per subtitle with enable condition
            dt_filters = []
            for i, (start, end, text) in enumerate(events):
                # Parse times to seconds
                def _to_secs(t):
                    match = re.match(r"(\d+):(\d{2}):(\d{2})\.(\d{2})", t)
                    if not match:
                        return 0
                    h, m, s, cs = match.groups()
                    return int(h)*3600 + int(m)*60 + int(s) + int(cs)/100

                t_start = _to_secs(start)
                t_end = _to_secs(end)
                # Escape text for drawtext
                safe_text = (
                    text
                    .replace("\\", "\\\\")
                    .replace("'", "\\'")
                    .replace(":", "\\:")
                    .replace("%", "%%")
                    .replace("\n", " ")
                )
                dt_filters.append(
                    f"drawtext=text='{safe_text}'"
                    f":fontsize=20:fontcolor=white"
                    f":borderw=3:bordercolor=black"
                    f":x=(w-tw)/2:y=h-th-140"
                    f":enable='between(t,{t_start:.2f},{t_end:.2f})'"
                )

            if dt_filters:
                vf = ",".join(dt_filters)
                cmd = [
                    self.ffmpeg, "-y",
                    "-i", str(video_path),
                    "-vf", vf,
                    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
                    "-c:a", "copy",
                    str(output_with_subs),
                ]
                await self._run(cmd, description="subtitle_burn_drawtext")
                # Replace original with subtitle version
                video_path.unlink()
                output_with_subs.rename(video_path)
                logger.info("ffmpeg.subtitles_burned_drawtext", output=str(video_path))
                return video_path

        except (FFmpegError, Exception) as e:
            logger.warning(
                "ffmpeg.drawtext_failed",
                error=str(e)[:200],
                msg="drawtext not available, skipping subtitle burn",
            )
            if output_with_subs.exists():
                output_with_subs.unlink()

        return video_path

    async def _burn_subtitles_final(
        self,
        video_path: Path,
        ass_path: Path,
        output_path: Path,
    ) -> Path:
        """Burn .ass subtitles onto a video as a final post-processing step.

        Tries the `ass` filter first (requires libass), then falls back
        to `subtitles` filter, then to drawtext.

        Args:
            video_path: Input video (already rendered).
            ass_path: .ass subtitle file with exact timestamps.
            output_path: Output video with burned subtitles.

        Returns:
            Path to the output video.
        """
        import tempfile

        # Create safe path for FFmpeg (no spaces)
        safe_ass = str(ass_path)
        _tmp_link = None
        if " " in safe_ass or ":" in safe_ass:
            tmp = tempfile.NamedTemporaryFile(
                delete=False, suffix=".ass", prefix="ffvf_"
            )
            tmp.close()
            _tmp_path = Path(tmp.name)
            _tmp_path.unlink()
            _tmp_path.symlink_to(Path(safe_ass).resolve())
            safe_ass = str(_tmp_path)
            _tmp_link = _tmp_path

        try:
            # Try 1: subtitles filter (most compatible)
            cmd = [
                self.ffmpeg, "-y",
                "-i", str(video_path),
                "-vf", f"subtitles=filename='{safe_ass}'",
                "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                str(output_path),
            ]

            try:
                await self._run(cmd, description="subtitle_burn_ass")
                logger.info(
                    "ffmpeg.subtitles_burned_final",
                    method="subtitles_filter",
                    output=str(output_path),
                )
                return output_path
            except FFmpegError:
                logger.warning("ffmpeg.subtitles_filter_failed, trying ass filter")

            # Try 2: ass filter
            cmd[5] = f"ass=filename='{safe_ass}'"
            try:
                await self._run(cmd, description="subtitle_burn_ass2")
                logger.info(
                    "ffmpeg.subtitles_burned_final",
                    method="ass_filter",
                    output=str(output_path),
                )
                return output_path
            except FFmpegError:
                logger.warning("ffmpeg.ass_filter_failed, trying drawtext")

            # Try 3: drawtext fallback
            result = await self._burn_subtitles_srt_pass(
                video_path=video_path,
                ass_path=ass_path,
            )
            # Copy result to output_path if needed
            if result != output_path and result.exists():
                import shutil
                shutil.copy2(str(result), str(output_path))
            return output_path

        finally:
            if _tmp_link:
                try:
                    _tmp_link.unlink(missing_ok=True)
                except Exception:
                    pass
