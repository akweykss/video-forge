"""Layout Compositor — Final 9:16 video composition with rotating layouts.

Composites the translated video and avatar lip-sync video into a
1080×1920 (9:16) output, cycling through three layout styles every
``layout_duration`` seconds with a 0.5 s crossfade transition.

Layout types
────────────
1. **top_bottom** — Video zoomed on top (50 %), avatar zoomed on bottom (50 %)
2. **bottom_top** — Avatar zoomed on top (50 %), video zoomed on bottom (50 %)
3. **center_blur** — Blurred avatar fills the canvas; original video
   is centred at ~70 % width with a soft shadow border.

Both video and avatar are ZOOM-CROPPED to fill their regions completely
with NO black borders.

The ``enable='between(t,start,end)'`` approach renders all three
layouts simultaneously and switches between them, avoiding concat
demuxer complexity.
"""

from __future__ import annotations

import asyncio
import json
import math
from pathlib import Path
from typing import Callable, Optional

import structlog

logger = structlog.get_logger(__name__)

# ── Canvas constants ──────────────────────────────────────────────────
CANVAS_W = 1080
CANVAS_H = 1920

# Layout proportions — 50/50 split, edge-to-edge, no black borders
HALF_H = CANVAS_H // 2  # 960px each

CENTER_VIDEO_RATIO = 0.70  # video occupies 70 % of canvas width
BLUR_SIGMA = 40

# Crossfade
CROSSFADE_DURATION = 0.5  # seconds

# Layout cycle order
LAYOUT_ORDER = ["top_bottom", "bottom_top", "center_blur"]

# ── Subtitle configuration (easy to adjust!) ─────────────────────────
# These offsets control where the subtitle sits relative to the
# dividing line between the video and avatar.
#   - positive offset = move DOWN from the dividing line
#   - negative offset = move UP from the dividing line
# The user can tweak these numbers to fine-tune positioning.
SUBTITLE_CONFIG = {
    # ── Style (matching original cinema ASS subtitles) ──
    "font_size": 48,
    "font_color": "yellow",        # Cinema standard yellow
    "font_bold": True,
    "border_width": 4,             # Black outline thickness
    "border_color": "black",
    "shadow_x": 0,
    "shadow_y": 2,
    "shadow_color": "black@0.6",   # Semi-transparent shadow
    "box": True,                   # Background box behind text
    "box_color": "black@0.5",      # Semi-transparent black bg
    "box_border_w": 12,            # Padding around text
    # ── Positioning ──
    # Y offset from the dividing line (in pixels)
    # Positive = into the avatar area, negative = into the video area
    "top_bottom_offset": -30,
    "bottom_top_offset": -30,
    "center_blur_offset": 240,   # below the centered video box
}


class LayoutCompositor:
    """Create a 9:16 composite video with rotating layouts.

    Parameters
    ----------
    ffmpeg_path : str
        Path to the ffmpeg binary.  Defaults to the local static binary
        shipped with the project (``bin/ffmpeg``).
    """

    def __init__(self, ffmpeg_path: str = "ffmpeg"):
        # Auto-detect local static binary
        _local_bin = Path(__file__).resolve().parent.parent.parent / "bin" / "ffmpeg"
        if _local_bin.exists():
            self.ffmpeg_path = str(_local_bin)
            logger.info("compositor.using_local_ffmpeg", path=self.ffmpeg_path)
        else:
            self.ffmpeg_path = ffmpeg_path

    # ── Public API ────────────────────────────────────────────────────

    async def compose(
        self,
        video_path: Path,
        avatar_path: Path,
        output_path: Path,
        subtitle_segments: Optional[list[dict]] = None,
        fps: int = 25,
        layout_duration: float = 8.0,
        progress_callback: Optional[Callable] = None,
        subtitle_style: str = "cinema",
    ) -> Path:
        """Composite *video_path* and *avatar_path* into a 9:16 output.

        Parameters
        ----------
        video_path : Path
            Translated source video.
        avatar_path : Path
            Lip-synced avatar video (carries TTS audio track).
        output_path : Path
            Destination for the final 1080×1920 MP4.
        fps : int
            Target frame rate (default 25).
        layout_duration : float
            Seconds each layout is shown before rotating (default 8.0).
        progress_callback : callable, optional
            ``callback(percent: float, message: str)``

        Returns
        -------
        Path
            The *output_path* on success.
        """
        video_path = Path(video_path)
        avatar_path = Path(avatar_path)
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        def _progress(pct: float, msg: str) -> None:
            if progress_callback:
                progress_callback(pct, msg)

        # ── Step 1: Probe inputs ──────────────────────────────────────
        _progress(5, "🔍 Probing input videos…")
        video_w, video_h, video_dur = await self._probe(video_path)
        avatar_w, avatar_h, avatar_dur = await self._probe(avatar_path)

        # Use the shorter duration so we don't go past either clip
        total_duration = min(video_dur, avatar_dur)

        logger.info(
            "compositor.inputs_probed",
            video=f"{video_w}x{video_h} @ {video_dur:.2f}s",
            avatar=f"{avatar_w}x{avatar_h} @ {avatar_dur:.2f}s",
            total_duration=round(total_duration, 2),
        )

        # ── Step 2: Build filter_complex ──────────────────────────────
        _progress(15, "🏗️ Building FFmpeg filter graph…")
        filter_complex = self._build_filter_complex(
            video_w=video_w,
            video_h=video_h,
            avatar_w=avatar_w,
            avatar_h=avatar_h,
            total_duration=total_duration,
            layout_duration=layout_duration,
            fps=fps,
            subtitle_segments=subtitle_segments,
            subtitle_style=subtitle_style,
        )

        logger.info(
            "compositor.filter_graph_built",
            filter_len=len(filter_complex),
        )

        # ── Step 3: Run FFmpeg ────────────────────────────────────────
        _progress(25, "🎬 Rendering composite video…")

        cmd = [
            self.ffmpeg_path, "-y",
            "-i", str(video_path),
            "-i", str(avatar_path),
            "-filter_complex", filter_complex,
            "-map", "[vout]",
            "-map", "1:a",          # audio from avatar (TTS)
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-r", str(fps),
            "-c:a", "aac",
            "-b:a", "192k",
            "-movflags", "+faststart",
            "-t", str(total_duration),
            str(output_path),
        ]

        logger.info("compositor.ffmpeg_start", cmd=" ".join(cmd))

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Stream stderr for progress parsing
        stderr_lines: list[str] = []
        assert proc.stderr is not None
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            decoded = line.decode("utf-8", errors="replace").strip()
            stderr_lines.append(decoded)

            # Parse FFmpeg progress lines  (frame=  123 …)
            if decoded.startswith("frame=") or "time=" in decoded:
                pct = self._parse_progress(decoded, total_duration)
                if pct is not None:
                    # Map 25-95 % range to the render phase
                    mapped = 25 + pct * 0.70
                    _progress(mapped, f"🎬 Rendering… {pct:.0f}%")

        stdout_data = await proc.stdout.read() if proc.stdout else b""
        await proc.wait()

        if proc.returncode != 0:
            stderr_tail = "\n".join(stderr_lines[-30:])
            logger.error(
                "compositor.ffmpeg_failed",
                returncode=proc.returncode,
                stderr=stderr_tail,
            )
            raise RuntimeError(
                f"FFmpeg compositor failed (rc={proc.returncode}): "
                f"{stderr_tail[-500:]}"
            )

        size_mb = output_path.stat().st_size / (1024 * 1024)
        _progress(98, f"✅ Composite rendered ({size_mb:.1f} MB)")

        logger.info(
            "compositor.complete",
            output=str(output_path),
            size_mb=round(size_mb, 2),
            duration=round(total_duration, 2),
        )

        return output_path

    # ── Filter graph builder ──────────────────────────────────────────

    def _build_filter_complex(
        self,
        video_w: int,
        video_h: int,
        avatar_w: int,
        avatar_h: int,
        total_duration: float,
        layout_duration: float,
        fps: int,
        subtitle_segments: Optional[list[dict]] = None,
        subtitle_style: str = "cinema",
    ) -> str:
        """Build the FFmpeg ``-filter_complex`` string.

        Strategy
        --------
        1. ZOOM-CROP both inputs to fill their regions (no black borders).
        2. Render all three layout streams on a 1080×1920 canvas.
        3. Use ``overlay`` with ``enable='between(t,start,end)'`` to
           switch between layouts, with a 0.5 s crossfade at each
           transition handled by blending overlapping alpha ramps.
        """
        filters: list[str] = []

        # ── Video zoom & region height ────────────────────────────────
        # Video is zoomed to 145% of its "fit-to-width" size.
        VIDEO_ZOOM = 1.45

        vid_fit_scale = CANVAS_W / video_w
        vid_region_h = int(video_h * vid_fit_scale * VIDEO_ZOOM)
        vid_region_h = min(vid_region_h, int(CANVAS_H * 0.55))
        vid_region_h = vid_region_h if vid_region_h % 2 == 0 else vid_region_h - 1

        logger.info(
            "compositor.layer_config",
            vid_region_h=vid_region_h,
            video_zoom=VIDEO_ZOOM,
            note="avatar=background, video=overlay on top",
        )

        # ── Avatar full size (1080×1920) ─────────────────────────────
        ava_bg_w, ava_bg_h = _cover_dimensions(avatar_w, avatar_h, CANVAS_W, CANVAS_H)
        filters.append(
            f"[1:v]scale={ava_bg_w}:{ava_bg_h},"
            f"crop={CANVAS_W}:{CANVAS_H}:(iw-{CANVAS_W})/2:0,"
            f"setsar=1,split=2[ava_full_tb][ava_full_bt]"
        )

        # ── Video at 145% zoom ───────────────────────────────────────
        vid_final_w = int(CANVAS_W * VIDEO_ZOOM)
        vid_final_h = int(vid_final_w * video_h / video_w)
        vid_final_w = vid_final_w if vid_final_w % 2 == 0 else vid_final_w + 1
        vid_final_h = vid_final_h if vid_final_h % 2 == 0 else vid_final_h + 1

        filters.append(
            f"[0:v]scale={vid_final_w}:{vid_final_h},"
            f"crop={CANVAS_W}:{vid_region_h}:(iw-{CANVAS_W})/2:(ih-{vid_region_h})/2,"
            f"setsar=1,split=2[vid_overlay_tb][vid_overlay_bt]"
        )

        # ── Video for centre layout — ZOOM STEPS ─────────────────────
        # The centre video grows from 70% to 145% over each segment.
        # We create 4 discrete scale steps.
        ZOOM_STEPS = [0.70, 0.90, 1.15, VIDEO_ZOOM]
        zoom_streams: list[dict] = []  # {label, w, h, cx, cy}

        for zi, zratio in enumerate(ZOOM_STEPS):
            zw = int(CANVAS_W * zratio)
            zh = int(zw * video_h / video_w)
            zw = zw if zw % 2 == 0 else zw + 1
            zh = zh if zh % 2 == 0 else zh + 1
            # Crop to canvas width if larger
            crop_w = min(zw, CANVAS_W)
            crop_h = min(zh, int(CANVAS_H * 0.80))
            crop_w = crop_w if crop_w % 2 == 0 else crop_w - 1
            crop_h = crop_h if crop_h % 2 == 0 else crop_h - 1
            cx = (CANVAS_W - crop_w) // 2
            cy = (CANVAS_H - crop_h) // 2

            label = f"vid_z{zi}"
            filters.append(
                f"[0:v]scale={zw}:{zh},"
                f"crop={crop_w}:{crop_h}:(iw-{crop_w})/2:(ih-{crop_h})/2,"
                f"setsar=1[{label}]"
            )
            zoom_streams.append({
                "label": label, "w": crop_w, "h": crop_h,
                "cx": cx, "cy": cy, "ratio": zratio,
            })

        # ── Avatar blurred background (for centre layout) ────────────
        filters.append(
            f"[1:v]scale={ava_bg_w}:{ava_bg_h},"
            f"crop={CANVAS_W}:{CANVAS_H}:(iw-{CANVAS_W})/2:0,"
            f"gblur=sigma={BLUR_SIGMA},"
            f"setsar=1[ava_blur]"
        )

        # ── Compose layouts ───────────────────────────────────────────
        # Layout 1: top_bottom
        filters.append(
            f"color=c=black:s={CANVAS_W}x{CANVAS_H}:r={fps}[bg_tb]"
        )
        filters.append(
            f"[bg_tb][ava_full_tb]overlay=0:{vid_region_h}:shortest=1[tb_bg]"
        )
        filters.append(
            "[tb_bg][vid_overlay_tb]overlay=0:0:shortest=1[layout_tb]"
        )

        # Layout 2: bottom_top
        vid_bottom_y = CANVAS_H - vid_region_h
        filters.append(
            f"color=c=black:s={CANVAS_W}x{CANVAS_H}:r={fps}[bg_bt]"
        )
        filters.append(
            "[bg_bt][ava_full_bt]overlay=0:0:shortest=1[bt_bg]"
        )
        filters.append(
            f"[bt_bg][vid_overlay_bt]overlay=0:{vid_bottom_y}:shortest=1[layout_bt]"
        )

        # NOTE: layout_cb is NOT pre-composed — we do per-segment zoom overlays below

        # ── Schedule layout switching with enable= ────────────────────
        segments = self._compute_segments(total_duration, layout_duration)

        logger.info(
            "compositor.segments",
            count=len(segments),
            layouts=[s["layout"] for s in segments],
        )

        # Start with a black base
        filters.append(
            f"color=c=black:s={CANVAS_W}x{CANVAS_H}:r={fps},"
            f"trim=duration={total_duration},setpts=PTS-STARTPTS[base]"
        )

        # Build enable expressions for tb and bt layouts
        tb_enables: list[str] = []
        bt_enables: list[str] = []
        cb_segments_list: list[dict] = []  # collect cb segments for zoom

        for seg in segments:
            t0 = f"{seg['start']:.3f}"
            t1 = f"{seg['end']:.3f}"
            expr = f"between(t,{t0},{t1})"
            if seg["layout"] == "top_bottom":
                tb_enables.append(expr)
            elif seg["layout"] == "bottom_top":
                bt_enables.append(expr)
            elif seg["layout"] == "center_blur":
                cb_segments_list.append(seg)

        # Overlay chain: base → tb → bt → (ava_blur bg) → zoom steps
        current = "base"

        if tb_enables:
            enable_expr = "+".join(tb_enables)
            filters.append(
                f"[{current}][layout_tb]overlay=0:0:"
                f"enable='{enable_expr}':shortest=1[after_tb]"
            )
            current = "after_tb"

        if bt_enables:
            enable_expr = "+".join(bt_enables)
            filters.append(
                f"[{current}][layout_bt]overlay=0:0:"
                f"enable='{enable_expr}':shortest=1[after_bt]"
            )
            current = "after_bt"

        # Overlay blurred avatar background during ALL center_blur segments
        if cb_segments_list:
            cb_bg_enables = "+".join(
                f"between(t,{s['start']:.3f},{s['end']:.3f})"
                for s in cb_segments_list
            )
            filters.append(
                f"[{current}][ava_blur]overlay=0:0:"
                f"enable='{cb_bg_enables}':shortest=1[after_blur_bg]"
            )
            current = "after_blur_bg"

            # For each center_blur segment, add 4 zoom-step overlays
            # Each step occupies 1/4 of the segment duration
            num_steps = len(ZOOM_STEPS)
            # Split each zoom stream into N copies (one per cb segment)
            for zi in range(num_steps):
                if len(cb_segments_list) > 1:
                    split_labels = " ".join(
                        f"[vid_z{zi}_c{ci}]"
                        for ci in range(len(cb_segments_list))
                    )
                    filters.append(
                        f"[vid_z{zi}]split={len(cb_segments_list)}{split_labels}"
                    )
                else:
                    # Only one cb segment — just rename
                    filters.append(f"[vid_z{zi}]null[vid_z{zi}_c0]")

            for ci, cb_seg in enumerate(cb_segments_list):
                seg_start = cb_seg["start"]
                seg_end = cb_seg["end"]
                seg_dur = seg_end - seg_start
                step_dur = seg_dur / num_steps

                for zi, zs in enumerate(zoom_streams):
                    step_t0 = seg_start + zi * step_dur
                    step_t1 = seg_start + (zi + 1) * step_dur
                    if zi == num_steps - 1:
                        step_t1 = seg_end  # last step extends to segment end

                    next_label = f"after_z{zi}_c{ci}"
                    filters.append(
                        f"[{current}][vid_z{zi}_c{ci}]overlay="
                        f"{zs['cx']}:{zs['cy']}:"
                        f"enable='between(t,{step_t0:.3f},{step_t1:.3f})':"
                        f"shortest=1[{next_label}]"
                    )
                    current = next_label

        # Final output: add subtitles on top if provided
        if subtitle_segments:
            # Escape text for FFmpeg drawtext
            def _escape_dt(text: str) -> str:
                """Escape special chars for FFmpeg drawtext."""
                return (
                    text.replace("\\", "\\\\")
                    .replace(":", "\\:")
                    .replace("'", "\u2019")  # Replace ASCII apostrophe with Unicode right quote
                    .replace('"', '\\"')
                    .replace("%", "%%")
                    .replace(";", "\\;")
                    .replace("[", "\\[")
                    .replace("]", "\\]")
                    .replace("\n", " ")
                )

            # Calculate Y position for each layout:
            #   top_bottom: dividing line = vid_region_h (video top, avatar bottom)
            #   bottom_top: dividing line = CANVAS_H - vid_region_h (avatar top, video bottom)
            #   center_blur: center of the video box
            sub_y_tb = vid_region_h + SUBTITLE_CONFIG["top_bottom_offset"]
            sub_y_bt = (CANVAS_H - vid_region_h) + SUBTITLE_CONFIG["bottom_top_offset"]
            sub_y_cb = (CANVAS_H // 2) + SUBTITLE_CONFIG["center_blur_offset"]

            font_size = SUBTITLE_CONFIG["font_size"]
            _style_map = {
                "cinema":   ("yellow",   True),
                "classica": ("white",    True),
                "limpa":    ("white",    False),
                "dourada":  ("0xFFC814", False),
            }
            font_color, _style_box = _style_map.get(str(subtitle_style).lower(), ("yellow", True))
            border_w = SUBTITLE_CONFIG["border_width"]
            border_color = SUBTITLE_CONFIG["border_color"]

            # For each subtitle segment, determine which layout is active
            # and use the corresponding Y position.

            # ── Ensure subtitles never overlap (safety clamp) ──────────
            FRAME_GAP = 0.04  # 1 frame at 25fps

            for i in range(len(subtitle_segments) - 1):
                next_start = subtitle_segments[i + 1]["start"]
                max_end = next_start - FRAME_GAP
                if subtitle_segments[i]["end"] > max_end:
                    subtitle_segments[i]["end"] = max_end

            sub_idx = 0
            for seg in subtitle_segments:
                seg_start = seg["start"]
                seg_end = seg["end"]
                if seg_end <= seg_start:
                    continue  # skip zero-duration segments
                escaped = _escape_dt(seg["text"])

                # Use seg_start (not midpoint) for layout detection —
                # instant position change at layout transitions.
                active_layout = None

                # Walk through clean segment boundaries
                clean_t = 0.0
                clean_idx = 0
                while clean_t < total_duration:
                    clean_end = min(clean_t + layout_duration, total_duration)
                    if clean_t <= seg_start < clean_end:
                        active_layout = LAYOUT_ORDER[clean_idx % len(LAYOUT_ORDER)]
                        break
                    clean_t = clean_end
                    clean_idx += 1

                if not active_layout:
                    active_layout = LAYOUT_ORDER[0]  # fallback

                # Render a single drawtext for this subtitle
                if active_layout == "top_bottom":
                    y_pos = sub_y_tb
                elif active_layout == "bottom_top":
                    y_pos = sub_y_bt
                else:  # center_blur
                    y_pos = sub_y_cb

                t0 = f"{seg_start:.3f}"
                t1 = f"{seg_end:.3f}"
                next_label = f"sub_{sub_idx}"

                # Build drawtext with cinema style — Arial Bold for thickness
                font_file = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
                dt_parts = [
                    f"text='{escaped}'",
                    f"fontfile={font_file}",
                    f"fontsize={font_size}",
                    f"fontcolor={font_color}",
                ]
                dt_parts.extend([
                    f"borderw={border_w}",
                    f"bordercolor={border_color}",
                    f"shadowx={SUBTITLE_CONFIG.get('shadow_x', 0)}",
                    f"shadowy={SUBTITLE_CONFIG.get('shadow_y', 2)}",
                    f"shadowcolor={SUBTITLE_CONFIG.get('shadow_color', 'black@0.6')}",
                ])
                if SUBTITLE_CONFIG.get("box") and _style_box:
                    dt_parts.extend([
                        "box=1",
                        f"boxcolor={SUBTITLE_CONFIG.get('box_color', 'black@0.5')}",
                        f"boxborderw={SUBTITLE_CONFIG.get('box_border_w', 12)}",
                    ])
                dt_parts.extend([
                    "x=max(30\\,(w-text_w)/2)",
                    f"y={y_pos}",
                    f"enable='between(t,{t0},{t1})'",
                ])

                dt_str = ":".join(dt_parts)
                filters.append(
                    f"[{current}]drawtext={dt_str}[{next_label}]"
                )
                current = next_label
                sub_idx += 1

            logger.info(
                "compositor.subtitles_added",
                count=len(subtitle_segments),
                drawtext_filters=sub_idx,
                y_positions={"tb": sub_y_tb, "bt": sub_y_bt, "cb": sub_y_cb},
            )

        # Final label
        if current != "vout":
            filters.append(f"[{current}]copy[vout]")

        return ";".join(filters)

    # ── Segment scheduling ────────────────────────────────────────────

    def _compute_segments(
        self,
        total_duration: float,
        layout_duration: float,
    ) -> list[dict]:
        """Return a list of ``{layout, start, end}`` dicts.

        Layouts rotate through :pydata:`LAYOUT_ORDER` every
        *layout_duration* seconds.  Each segment's boundaries include
        a half-crossfade overlap so the ``enable`` expressions produce
        seamless transitions.
        """
        segments: list[dict] = []
        t = 0.0
        idx = 0
        half_xf = CROSSFADE_DURATION / 2.0

        while t < total_duration:
            layout = LAYOUT_ORDER[idx % len(LAYOUT_ORDER)]
            seg_end = min(t + layout_duration, total_duration)

            # Extend by half a crossfade on each side so overlapping
            # enable windows produce a natural blend at transitions.
            adj_start = max(0.0, t - half_xf)
            adj_end = min(total_duration, seg_end + half_xf)

            segments.append({
                "layout": layout,
                "start": round(adj_start, 3),
                "end": round(adj_end, 3),
            })

            t = seg_end
            idx += 1

        return segments

    # ── FFmpeg progress parsing ───────────────────────────────────────

    @staticmethod
    def _parse_progress(line: str, total_duration: float) -> Optional[float]:
        """Extract percentage from an FFmpeg stderr progress line."""
        # Look for  time=HH:MM:SS.xx
        if "time=" not in line:
            return None
        try:
            time_part = line.split("time=")[1].split()[0]
            parts = time_part.split(":")
            if len(parts) == 3:
                secs = (
                    float(parts[0]) * 3600
                    + float(parts[1]) * 60
                    + float(parts[2])
                )
                if total_duration > 0:
                    return min(100.0, (secs / total_duration) * 100.0)
        except (IndexError, ValueError):
            pass
        return None

    # ── Probing helper ────────────────────────────────────────────────

    async def _probe(self, path: Path) -> tuple[int, int, float]:
        """Return ``(width, height, duration)`` for a video file."""
        ffprobe_path = str(
            Path(self.ffmpeg_path).parent / "ffprobe"
        )
        # Fall back to system ffprobe if local one doesn't exist
        if not Path(ffprobe_path).exists():
            ffprobe_path = "ffprobe"

        cmd = [
            ffprobe_path,
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            raise RuntimeError(
                f"ffprobe failed for {path}: "
                f"{stderr.decode('utf-8', errors='replace')[-300:]}"
            )

        info = json.loads(stdout.decode("utf-8", errors="replace"))
        duration = float(info.get("format", {}).get("duration", 0.0))

        width = 0
        height = 0
        for stream in info.get("streams", []):
            if stream.get("codec_type") == "video":
                width = int(stream["width"])
                height = int(stream["height"])
                break

        if width == 0 or height == 0:
            raise ValueError(f"No video stream found in {path}")

        return width, height, duration


# ── Geometry helpers ──────────────────────────────────────────────────


def _fit_dimensions(
    src_w: int,
    src_h: int,
    box_w: int,
    box_h: int,
) -> tuple[int, int]:
    """Scale *src* to fit inside *box* while preserving aspect ratio.

    Returns even-numbered dimensions (required by libx264 / yuv420p).
    """
    scale = min(box_w / src_w, box_h / src_h)
    w = int(src_w * scale)
    h = int(src_h * scale)
    # Ensure even dimensions
    w = w if w % 2 == 0 else w - 1
    h = h if h % 2 == 0 else h - 1
    return max(2, w), max(2, h)


def _cover_dimensions(
    src_w: int,
    src_h: int,
    box_w: int,
    box_h: int,
) -> tuple[int, int]:
    """Scale *src* to *cover* the entire *box* (may crop edges).

    Returns even-numbered dimensions.
    """
    scale = max(box_w / src_w, box_h / src_h)
    w = int(math.ceil(src_w * scale))
    h = int(math.ceil(src_h * scale))
    # Ensure even dimensions
    w = w if w % 2 == 0 else w + 1
    h = h if h % 2 == 0 else h + 1
    return max(2, w), max(2, h)
