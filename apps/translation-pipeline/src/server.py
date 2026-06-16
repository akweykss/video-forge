"""FastAPI server for the VideoForge Translation Pipeline.

Main entry point with ALL REST API endpoints for managing
translation jobs through the complete pipeline.

Run with: uvicorn src.server:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import structlog
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, HttpUrl

from .agents.ingestion import IngestionAgent
from .agents.overlay import OverlayAgent
from .agents.synthesis import SynthesisAgent
from .agents.voice import VoiceAgent
from .db.models import Database, JobStatus
from .utils.manifest import JobManifest

# SpatialAgent usa cv2/paddleocr — import condicional para não travar o boot
try:
    from .agents.spatial import SpatialAgent
    _SPATIAL_AVAILABLE = True
except Exception:
    SpatialAgent = None  # type: ignore[assignment,misc]
    _SPATIAL_AVAILABLE = False

# ── Load environment variables ─────────────────────────────────────
load_dotenv()

# ── Configure structured logging ──────────────────────────────────
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.dev.set_exc_info,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.dev.ConsoleRenderer(colors=True),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(
        structlog.get_config().get("min_level", 0)  # type: ignore
    ),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger(__name__)

# ── Configuration ──────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
import os as _os_env
WORKSPACE_DIR = Path(_os_env.environ.get("FOLD_WORKSPACE_DIR", str(BASE_DIR / "workspace")))
DB_PATH = Path(_os_env.environ.get("FOLD_DB_PATH", str(BASE_DIR / "data" / "pipeline.db")))
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
COOKIES_PATH = os.getenv("DOUYIN_COOKIES_PATH", "")
LUT_PATH = Path(__file__).parent / "utils" / "luts" / "gradient.cube"

# ── Global instances ───────────────────────────────────────────────
db = Database(DB_PATH)


def _get_agents() -> dict[str, Any]:
    """Create agent instances with current config."""
    return {
        "ingestion": IngestionAgent(
            db=db,
            workspace_dir=WORKSPACE_DIR,
            cookies_path=COOKIES_PATH if COOKIES_PATH else None,
        ),
        "spatial": SpatialAgent(
            db=db,
            workspace_dir=WORKSPACE_DIR,
        ),
        "voice": VoiceAgent(
            db=db,
            workspace_dir=WORKSPACE_DIR,
        ),
        "overlay": OverlayAgent(
            db=db,
            workspace_dir=WORKSPACE_DIR,
        ),
        "synthesis": SynthesisAgent(
            db=db,
            workspace_dir=WORKSPACE_DIR,
            lut_path=str(LUT_PATH),
        ),
    }


# ── Lifespan ───────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown events."""
    # Startup
    logger.info("server.starting", workspace=str(WORKSPACE_DIR), db=str(DB_PATH))
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    for subdir in ("downloads", "frames", "overlays", "outputs"):
        (WORKSPACE_DIR / subdir).mkdir(parents=True, exist_ok=True)

    await db.connect()
    logger.info("server.started", port=8000)

    yield

    # Shutdown
    await db.disconnect()
    logger.info("server.stopped")


# ── FastAPI app ────────────────────────────────────────────────────
app = FastAPI(
    title="VideoForge Translation Pipeline",
    description="B2B video translation service — Douyin → Portuguese (pt-BR)",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ═══════════════════════════════════════════════════════════════════
# Request / Response Models
# ═══════════════════════════════════════════════════════════════════

class CreateJobRequest(BaseModel):
    """Request body for creating a new translation job."""
    source_url: str = Field(..., description="Video URL (Douyin)")
    source_platform: str = Field(default="douyin", description="Platform: douyin, tiktok, youtube")
    target_language: str = Field(default="pt-BR", description="Target language code")
    metadata: Optional[dict[str, Any]] = Field(default=None, description="Extra metadata")


class ApproveJobRequest(BaseModel):
    """Request body for approving a job."""
    voice_id: Optional[str] = Field(default=None, description="MiniMax voice ID override")
    character_id: Optional[str] = Field(default=None, description="Character ID for lip sync")
    apply_lut: bool = Field(default=True, description="Apply LUT color grade")
    apply_grain: bool = Field(default=True, description="Apply film grain")
    apply_minterp: bool = Field(default=False, description="Apply motion interpolation (slow)")
    grain_intensity: Optional[int] = Field(default=None, description="Film grain strength (0-16)")
    lut_intensity: Optional[int] = Field(default=None, description="LUT color grade intensity (0-100)")


class RetryJobRequest(BaseModel):
    """Request body for retrying a failed job."""
    from_phase: Optional[str] = Field(default=None, description="Phase to retry from")


class JobResponse(BaseModel):
    """Standard job response."""
    id: str
    source_url: str
    source_platform: str
    target_language: str
    status: str
    created_at: str
    updated_at: str
    error_message: Optional[str] = None
    manifest_path: Optional[str] = None
    source_video_path: Optional[str] = None
    output_video_path: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


class StatsResponse(BaseModel):
    """Pipeline statistics response."""
    total_jobs: int
    by_status: dict[str, int]


# ═══════════════════════════════════════════════════════════════════
# Background Task Runner
# ═══════════════════════════════════════════════════════════════════

def _settings_from_metadata(meta: Optional[dict]) -> ApproveJobRequest:
    """Converte o metadata do job (vindo do HUD) em settings do pipeline.

    Aceita os valores canônicos da UI nova (subtle/none/medium/strong) e
    os rótulos antigos em PT (Sutil/Nenhuma/Média/Forte).
    """
    meta = meta or {}
    grain_raw = str(meta.get("grain_level", "subtle") or "subtle").strip().lower()
    grain_map = {
        "nenhuma": 0, "none": 0, "sem": 0, "off": 0,
        "sutil": 6, "subtle": 6,
        "média": 10, "media": 10, "medium": 10,
        "forte": 16, "strong": 16, "heavy": 16,
    }
    grain_intensity = grain_map.get(grain_raw, 8)
    try:
        lut_intensity = int(meta.get("lut_intensity", 100))
    except Exception:
        lut_intensity = 100
    lut_intensity = max(0, min(100, lut_intensity))
    return ApproveJobRequest(
        voice_id=meta.get("voice_id") or None,
        character_id=meta.get("character_id") or None,
        apply_lut=lut_intensity > 0,
        apply_grain=grain_intensity > 0,
        grain_intensity=grain_intensity,
        lut_intensity=lut_intensity,
    )


async def run_pipeline(job_id: str, settings: Optional[ApproveJobRequest] = None):
    """Run the complete translation pipeline for a job in background.

    Executes all phases sequentially: ingestion → spatial → voice → overlay → synthesis
    Emits real-time progress updates for SSE consumers.
    """
    agents = _get_agents()

    # Sem settings explícitas → reconstrói a partir do metadata do job,
    # para voz/grain/LUT valerem também em retry e chamadas diretas
    if settings is None:
        try:
            _job0 = await db.get_job(job_id)
            _m0 = _job0.metadata if isinstance(_job0.metadata, dict) else {}
            if isinstance(_job0.metadata, str):
                import json as _j0
                try:
                    _m0 = _j0.loads(_job0.metadata)
                except Exception:
                    _m0 = {}
            settings = _settings_from_metadata(_m0)
        except Exception:
            settings = None

    try:
        logger.info("pipeline.start", job_id=job_id)

        # Phase 1: Ingestion (download) — 0-20%
        _update_progress(job_id, "downloading", 5, "⬇️ Baixando vídeo do Douyin...")
        manifest = await agents["ingestion"].process(job_id)
        if not manifest:
            return
        _update_progress(job_id, "downloading", 20, "✅ Download completo!")

        # Ensure character_id is in the manifest
        try:
            from .utils.manifest import JobManifest
            _manifest = JobManifest.load((await db.get_job(job_id)).manifest_path)
            if not _manifest._data.get("character_id"):
                _job = await db.get_job(job_id)
                _meta = _job.metadata if isinstance(_job.metadata, dict) else {}
                if isinstance(_job.metadata, str):
                    import json as _jm2
                    try: _meta = _jm2.loads(_job.metadata)
                    except: _meta = {}
                if _meta.get("character_id"):
                    _manifest._data["character_id"] = _meta["character_id"]
                    _manifest.save()
                    logger.info("pipeline.character_id_propagated", job_id=job_id, character_id=_meta["character_id"])
        except Exception as e:
            logger.warning("pipeline.character_id_propagation_failed", error=str(e))

        if settings and settings.character_id:
            try:
                _manifest = JobManifest.load((await db.get_job(job_id)).manifest_path)
                _manifest._data["character_id"] = settings.character_id
                _manifest.save()
                logger.info("pipeline.character_id_from_settings", job_id=job_id, character_id=settings.character_id)
            except Exception:
                pass

        # Phase 2: Spatial (OCR) — 20-40%
        # Skip entirely when remove_watermark is ON — no need to detect or blur
        # the original subtitle region since the watermark API already removed it.
        _job_for_ocr = await db.get_job(job_id)
        _meta_for_ocr = _job_for_ocr.metadata if isinstance(_job_for_ocr.metadata, dict) else {}
        if isinstance(_job_for_ocr.metadata, str):
            import json as _jm_ocr
            try: _meta_for_ocr = _jm_ocr.loads(_job_for_ocr.metadata)
            except: _meta_for_ocr = {}

        _wm_requested = bool(_meta_for_ocr.get("remove_watermark"))
        _wm_removed_ok = bool(getattr(manifest, "_data", {}).get("watermark_removed"))
        if _wm_requested and not _wm_removed_ok:
            # Remoção pedida mas a API falhou → NÃO pula o OCR: cai no
            # caminho do blur para o texto original não ficar exposto
            logger.warning("pipeline.watermark_failed_fallback_blur", job_id=job_id)
            _update_progress(job_id, "processing_ocr", 22, "⚠️ Remoção falhou — aplicando blur sobre o texto original...")
        if _wm_requested and _wm_removed_ok:
            # ── SKIP OCR — watermark already removed by API ──────────
            _update_progress(job_id, "processing_ocr", 22, "⚡ Marca d'água removida — OCR não necessário!")
            logger.info("pipeline.skip_ocr_watermark_removed", job_id=job_id)

            # Write empty spatial data so downstream phases don't break
            from .utils.manifest import JobManifest as _JM
            _skip_manifest = _JM.load((await db.get_job(job_id)).manifest_path)
            _skip_manifest.set_spatial_result(
                frames_dir="",
                frame_count=0,
                text_regions=[],
                unique_texts=[],
            )
            manifest = _skip_manifest
            await db.update_job_status(job_id, JobStatus.PROCESSING_AUDIO)
            _update_progress(job_id, "processing_ocr", 40, "✅ OCR pulado — sem blur necessário!")
        else:
            _update_progress(job_id, "processing_ocr", 22, "👁️ Extraindo frames do vídeo...")
            manifest = await agents["spatial"].process(job_id)
            if not manifest:
                return
            _update_progress(job_id, "processing_ocr", 40, "✅ OCR completo — textos detectados!")


        # Phase 3: Voice (transcribe + translate + TTS) — 40-70%
        _update_progress(job_id, "processing_audio", 42, "🎤 Transcrevendo áudio via AssemblyAI...")
        if settings and settings.voice_id:
            agents["voice"].minimax_voice_id = settings.voice_id
        manifest = await agents["voice"].process(job_id)
        if not manifest:
            return
        _update_progress(job_id, "processing_audio", 70, "✅ Tradução e TTS completos!")

        # Phase 4: Overlay (Remotion) — 70-85%
        _update_progress(job_id, "processing_overlay", 72, "🎬 Renderizando legendas animadas...")
        manifest = await agents["overlay"].process(job_id)
        if not manifest:
            return
        _update_progress(job_id, "processing_overlay", 85, "✅ Overlay renderizado!")

        # Phase 5: Synthesis (FFmpeg) — 85-100%
        _update_progress(job_id, "processing_synthesis", 87, "⚡ Composição final com FFmpeg...")
        if settings:
            agents["synthesis"].apply_lut = settings.apply_lut
            agents["synthesis"].apply_grain = settings.apply_grain
            agents["synthesis"].apply_minterp = settings.apply_minterp
            if getattr(settings, "grain_intensity", None) is not None:
                agents["synthesis"].grain_intensity = settings.grain_intensity
            if getattr(settings, "lut_intensity", None) is not None:
                agents["synthesis"].lut_opacity = max(0.0, min(1.0, settings.lut_intensity / 100.0))
        manifest = await agents["synthesis"].process(job_id)

        if manifest:
            _update_progress(job_id, "done", 100, "🎉 Vídeo traduzido com sucesso!")
            logger.info("pipeline.complete", job_id=job_id)
        else:
            logger.error("pipeline.failed", job_id=job_id)

    except Exception as e:
        _update_progress(job_id, "error", 0, f"❌ Erro: {str(e)[:100]}")
        logger.exception("pipeline.error", job_id=job_id, error=str(e))
        await db.update_job_status(
            job_id, JobStatus.ERROR, error_message=f"Pipeline error: {str(e)}"
        )


async def run_single_phase(job_id: str, phase: str):
    """Run a single pipeline phase (used for retries)."""
    agents = _get_agents()
    agent = agents.get(phase)
    if agent:
        await agent.process(job_id)


async def retry_pipeline(job_id: str):
    """Retry/resume a job from its current phase or the phase that failed.

    Works for both error jobs (detects failed phase) and processing jobs
    (resumes from current status).
    """
    job = await db.get_job(job_id)
    if not job:
        return

    # Reaplica as configurações do job (voz, grain, LUT) ao retomar
    try:
        _mR = job.metadata if isinstance(job.metadata, dict) else {}
        if isinstance(job.metadata, str):
            import json as _jR
            try:
                _mR = _jR.loads(job.metadata)
            except Exception:
                _mR = {}
        _sR = _settings_from_metadata(_mR)
        _agR = _get_agents()
        if _sR.voice_id:
            _agR["voice"].minimax_voice_id = _sR.voice_id
        _agR["synthesis"].apply_lut = _sR.apply_lut
        _agR["synthesis"].apply_grain = _sR.apply_grain
        if _sR.grain_intensity is not None:
            _agR["synthesis"].grain_intensity = _sR.grain_intensity
        if _sR.lut_intensity is not None:
            _agR["synthesis"].lut_opacity = max(0.0, min(1.0, _sR.lut_intensity / 100.0))
    except Exception:
        pass

    # Map current status to phase
    status_to_phase = {
        JobStatus.APPROVED: "ingestion",
        JobStatus.DOWNLOADING: "ingestion",
        JobStatus.PROCESSING_OCR: "spatial",
        JobStatus.PROCESSING_AUDIO: "voice",
        JobStatus.PROCESSING_OVERLAY: "overlay",
        JobStatus.PROCESSING_SYNTHESIS: "synthesis",
    }

    if job.status in status_to_phase:
        # Job is already in a processing state — resume from there
        resume_phase = status_to_phase[job.status]
        logger.info("pipeline.resume", job_id=job_id, phase=resume_phase, status=job.status.value)
    elif job.status == JobStatus.DONE:
        # Done job being reprocessed — start from overlay (most common)
        resume_phase = "overlay"
        await db.update_job_status(job_id, JobStatus.PROCESSING_OVERLAY, error_message=None)
        logger.info("pipeline.reprocess", job_id=job_id, phase=resume_phase)
    elif job.status == JobStatus.ERROR:
        # Error job — detect which phase failed
        error_msg = (job.error_message or "").lower()
        phase_map = [
            ("ingestion", JobStatus.APPROVED, ["ingestion", "download", "yt-dlp", "douyin"]),
            ("spatial", JobStatus.PROCESSING_OCR, ["spatial", "ocr", "paddleocr", "easyocr", "frame"]),
            ("voice", JobStatus.PROCESSING_AUDIO, ["voice", "transcri", "assemblyai", "translate", "tts", "minimax"]),
            ("overlay", JobStatus.PROCESSING_OVERLAY, ["overlay", "remotion", "caption", "render", "subtitle"]),
            ("synthesis", JobStatus.PROCESSING_SYNTHESIS, ["synthesis", "ffmpeg", "lut", "grain", "compose", "merge"]),
        ]

        resume_phase = "ingestion"
        resume_status = JobStatus.APPROVED

        for phase_name, status, keywords in phase_map:
            if any(kw in error_msg for kw in keywords):
                resume_phase = phase_name
                resume_status = status
                break

        await db.update_job_status(job_id, resume_status, error_message=None)
        logger.info("pipeline.retry", job_id=job_id, phase=resume_phase)
    else:
        logger.warning("pipeline.retry.skip", job_id=job_id, status=job.status.value)
        return

    _update_progress(job_id, f"processing_{resume_phase}", 0, f"🔄 Retentando a partir de {resume_phase}...")

    # Run pipeline from the resume point
    agents = _get_agents()
    phases = ["ingestion", "spatial", "voice", "overlay", "synthesis"]
    start_idx = phases.index(resume_phase)

    try:
        manifest = None
        for i in range(start_idx, len(phases)):
            phase = phases[i]
            _update_progress(job_id, f"processing_{phase}", (i * 20), f"🔄 Executando fase: {phase}")
            manifest = await agents[phase].process(job_id)
            if not manifest:
                return

        if manifest:
            _update_progress(job_id, "done", 100, "🎉 Vídeo traduzido com sucesso!")
            logger.info("pipeline.retry.complete", job_id=job_id)

    except Exception as e:
        _update_progress(job_id, "error", 0, f"❌ Erro no retry: {str(e)[:100]}")
        logger.exception("pipeline.retry.error", job_id=job_id, error=str(e))
        await db.update_job_status(
            job_id, JobStatus.ERROR, error_message=f"Retry error: {str(e)}"
        )

# ═══════════════════════════════════════════════════════════════════
# Health & Info Endpoints
# ═══════════════════════════════════════════════════════════════════

@app.get("/", tags=["health"])
async def root():
    """Root endpoint — basic health check."""
    return {
        "service": "VideoForge Translation Pipeline",
        "version": "0.1.0",
        "status": "running",
    }


@app.get("/health", tags=["health"])
async def health_check():
    """Detailed health check with database status."""
    try:
        total = await db.count_jobs()
        return {
            "status": "healthy",
            "database": "connected",
            "total_jobs": total,
            "workspace": str(WORKSPACE_DIR),
        }
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "error": str(e)},
        )


@app.get("/stats", response_model=StatsResponse, tags=["info"])
async def get_stats():
    """Get pipeline statistics."""
    total = await db.count_jobs()
    by_status: dict[str, int] = {}
    for status in JobStatus:
        count = await db.count_jobs(status)
        if count > 0:
            by_status[status.value] = count
    return StatsResponse(total_jobs=total, by_status=by_status)


# ═══════════════════════════════════════════════════════════════════
# Job CRUD Endpoints
# ═══════════════════════════════════════════════════════════════════

@app.post("/jobs", response_model=JobResponse, status_code=201, tags=["jobs"])
async def create_job(req: CreateJobRequest):
    """Create a new translation job.

    The job starts in `pending_review` status. Use POST /jobs/{id}/approve
    to start processing.
    """
    job = await db.create_job(
        source_url=req.source_url,
        source_platform=req.source_platform,
        target_language=req.target_language,
        metadata=req.metadata,
    )
    return JobResponse(**job.to_dict())


@app.get("/jobs", response_model=list[JobResponse], tags=["jobs"])
async def list_jobs(
    status: Optional[str] = Query(None, description="Filter by status"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """List all translation jobs with optional status filter."""
    filter_status = None
    if status:
        try:
            filter_status = JobStatus(status)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status: {status}. Valid values: {[s.value for s in JobStatus]}",
            )

    jobs = await db.list_jobs(status=filter_status, limit=limit, offset=offset)
    return [JobResponse(**j.to_dict()) for j in jobs]


@app.get("/jobs/{job_id}", response_model=JobResponse, tags=["jobs"])
async def get_job(job_id: str):
    """Get a specific job by ID."""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobResponse(**job.to_dict())


@app.delete("/jobs/{job_id}", tags=["jobs"])
async def delete_job(job_id: str):
    """Delete a job by ID."""
    deleted = await db.delete_job(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"deleted": True, "job_id": job_id}


# ═══════════════════════════════════════════════════════════════════
# Job Action Endpoints
# ═══════════════════════════════════════════════════════════════════

@app.post("/jobs/{job_id}/approve", response_model=JobResponse, tags=["actions"])
async def approve_job(
    job_id: str,
    req: ApproveJobRequest,
    background_tasks: BackgroundTasks,
):
    """Approve a job and start the translation pipeline.

    Transitions from `pending_review` → `approved` → starts processing.
    The pipeline runs in the background through all 5 phases.
    """
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status != JobStatus.PENDING_REVIEW:
        raise HTTPException(
            status_code=400,
            detail=f"Job must be in pending_review status (current: {job.status.value})",
        )

    # Transition to approved
    updated = await db.update_job_status(job_id, JobStatus.APPROVED)

    # Store approval settings in metadata
    if req.voice_id or not req.apply_lut or not req.apply_grain or req.apply_minterp:
        metadata = updated.metadata.copy() if updated else {}
        metadata["approval_settings"] = req.model_dump()
        await db.update_job_field(job_id, "metadata", metadata)

    # Start pipeline in background
    background_tasks.add_task(run_pipeline, job_id, req)

    job = await db.get_job(job_id)
    return JobResponse(**job.to_dict())


@app.post("/jobs/{job_id}/retry", response_model=JobResponse, tags=["actions"])
async def retry_job(
    job_id: str,
    req: RetryJobRequest,
    background_tasks: BackgroundTasks,
):
    """Retry a failed job from the beginning or a specific phase.

    Only works for jobs in `error` status.
    """
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status != JobStatus.ERROR:
        raise HTTPException(
            status_code=400,
            detail=f"Job must be in error status to retry (current: {job.status.value})",
        )

    # Transition back to approved to restart
    updated = await db.update_job_status(job_id, JobStatus.APPROVED)

    # Start pipeline in background
    background_tasks.add_task(run_pipeline, job_id)

    job = await db.get_job(job_id)
    return JobResponse(**job.to_dict())


async def run_lipsync_only(job_id: str):
    """Re-run ONLY the lip sync + 9:16 layout step for an existing job.

    Uses the already-generated TTS audio from the manifest.
    Does NOT re-download, re-transcribe, or re-generate TTS.
    """
    try:
        job = await db.get_job(job_id)
        if not job or not job.manifest_path:
            logger.error("lipsync_only.no_manifest", job_id=job_id)
            return

        from .utils.manifest import JobManifest
        from .agents.lipsync import LipSyncAgent
        from .agents.compositor import LayoutCompositor

        manifest = JobManifest.load(job.manifest_path)

        # Get paths from manifest
        voice = manifest.get_phase("voice")
        audio_path = voice.get("tts", {}).get("merged_audio_path")
        if not audio_path:
            _update_progress(job_id, "error", 0, "❌ Áudio TTS não encontrado no manifest")
            return

        character_id = manifest._data.get("character_id")
        if not character_id:
            # Try from job metadata
            job_meta = job.metadata if hasattr(job, "metadata") and job.metadata else {}
            if isinstance(job_meta, str):
                import json as _jm
                try:
                    job_meta = _jm.loads(job_meta)
                except Exception:
                    job_meta = {}
            character_id = job_meta.get("character_id")

        if not character_id:
            _update_progress(job_id, "error", 0, "❌ Nenhum personagem selecionado")
            return

        dreamface_key = os.environ.get("DREAMFACE_API_KEY", "")
        if not dreamface_key:
            _update_progress(job_id, "error", 0, "❌ DREAMFACE_API_KEY não configurada")
            return

        # Find character avatar (uses volume-persisted CHARACTERS_DIR)
        char_dir = CHARACTERS_DIR / character_id

        char_meta_path = char_dir / "meta.json"
        if not char_meta_path.exists():
            _update_progress(job_id, "error", 0, f"❌ Personagem {character_id} não encontrado")
            return

        import json as _json_lipsync
        char_meta = _json_lipsync.loads(char_meta_path.read_text())
        avatar_filename = char_meta.get("avatar_filename", "")
        avatar_file = char_dir / avatar_filename
        if not avatar_file.exists():
            _update_progress(job_id, "error", 0, f"❌ Arquivo do avatar não encontrado")
            return

        _update_progress(job_id, "processing_synthesis", 50, "🎭 Gerando lip sync do avatar...")

        # Run lip sync
        lipsync_agent = LipSyncAgent(
            workspace_dir=WORKSPACE_DIR,
            dreamface_api_key=dreamface_key,
        )

        lipsync_result = await lipsync_agent.process(
            job_id=job_id,
            audio_path=Path(audio_path),
            avatar_video_path=avatar_file,
            progress_callback=lambda phase, pct, msg: _update_progress(
                job_id, "processing_synthesis", 50 + pct * 0.3, f"🎭 {msg}"
            ),
        )

        if not lipsync_result or not lipsync_result.exists():
            _update_progress(job_id, "error", 0, "❌ Lip sync não gerou resultado")
            return

        # Get the current output video (the one with subtitles)
        current_output = job.output_video_path
        if not current_output or not Path(current_output).exists():
            # Fallback: find the latest output
            output_dir = WORKSPACE_DIR / "outputs" / job_id
            candidates = sorted(output_dir.glob("translated_*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True) if output_dir.exists() else []
            current_output = str(candidates[0]) if candidates else None

        if not current_output:
            _update_progress(job_id, "error", 0, "❌ Vídeo traduzido original não encontrado")
            return

        _update_progress(job_id, "processing_synthesis", 85, "🎬 Compondo layout 9:16...")

        # Collect subtitle segments from manifest
        sub_segments = []
        try:
            voice_segs = voice.get("translation", {}).get("segments", [])
            if not voice_segs:
                voice_segs = voice.get("transcription", {}).get("segments", [])
            for seg in voice_segs:
                text = seg.get("translated", seg.get("text", "")).strip()
                if text:
                    sub_segments.append({
                        "start": round(float(seg.get("start", 0)), 3),
                        "end": round(float(seg.get("end", 0)), 3),
                        "text": text,
                    })
        except Exception:
            pass

        # Compose 9:16 layout
        compositor = LayoutCompositor(ffmpeg_path="ffmpeg")
        output_dir = WORKSPACE_DIR / "outputs" / job_id
        output_dir.mkdir(parents=True, exist_ok=True)
        composed_path = output_dir / f"translated_{job_id[:8]}_9x16.mp4"

        final_path = await compositor.compose(
            video_path=Path(current_output),
            avatar_path=lipsync_result,
            output_path=composed_path,
            subtitle_segments=sub_segments or None,
            fps=25,
            layout_duration=8.0,
            progress_callback=lambda pct, msg: _update_progress(
                job_id, "processing_synthesis", 85 + pct * 0.14, f"🎬 {msg}"
            ),
        )

        # Update job output path
        await db.update_job_field(job_id, "output_video_path", str(final_path))
        await db.update_job_status(job_id, JobStatus.DONE)
        _update_progress(job_id, "done", 100, "🎉 Lip sync + layout 9:16 concluído!")

        logger.info("lipsync_only.complete", job_id=job_id, output=str(final_path))

    except Exception as e:
        _update_progress(job_id, "error", 0, f"❌ Erro no lip sync: {str(e)[:100]}")
        logger.exception("lipsync_only.error", job_id=job_id, error=str(e))
        await db.update_job_status(
            job_id, JobStatus.ERROR, error_message=f"Lip sync failed: {str(e)}"
        )


@app.post("/jobs/{job_id}/redo-lipsync", response_model=JobResponse, tags=["actions"])
async def redo_lipsync(
    job_id: str,
    background_tasks: BackgroundTasks,
):
    """Re-run ONLY the lip sync + 9:16 layout for an existing job.

    Uses the already-generated TTS audio — does NOT re-download,
    re-transcribe, or re-generate TTS. Saves credits!
    """
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status not in (JobStatus.DONE, JobStatus.ERROR):
        raise HTTPException(
            status_code=400,
            detail=f"Job must be done or error to redo lip sync (current: {job.status.value})",
        )

    # Mark as processing
    await db.update_job_status(job_id, JobStatus.PROCESSING_SYNTHESIS)

    # Run in background
    background_tasks.add_task(run_lipsync_only, job_id)

    job = await db.get_job(job_id)
    return JobResponse(**job.to_dict())


@app.post("/jobs/{job_id}/cancel", response_model=JobResponse, tags=["actions"])
async def cancel_job(job_id: str):
    """Cancel a job by setting it to error state.

    Works for any non-terminal status.
    """
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status in (JobStatus.DONE, JobStatus.ERROR):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel job in {job.status.value} status",
        )

    # Force transition to error (bypass state machine for cancel)
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    await db.db.execute(
        "UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?",
        (JobStatus.ERROR.value, "Cancelled by user", now, job_id),
    )
    await db.db.commit()

    job = await db.get_job(job_id)
    return JobResponse(**job.to_dict())


# ═══════════════════════════════════════════════════════════════════
# Preview Endpoint
# ═══════════════════════════════════════════════════════════════════

@app.get("/jobs/{job_id}/preview", tags=["info"])
async def preview_job(job_id: str):
    """Get video metadata preview for a pending job.

    Fetches video info from the source URL without downloading.
    """
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    agents = _get_agents()
    ingestion: IngestionAgent = agents["ingestion"]

    try:
        preview = await ingestion.get_video_info_preview(job.source_url)
        return {"job_id": job_id, "preview": preview}
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch preview: {str(e)}",
        )


# ═══════════════════════════════════════════════════════════════════
# Manifest & Details Endpoints
# ═══════════════════════════════════════════════════════════════════

@app.get("/jobs/{job_id}/manifest", tags=["info"])
async def get_manifest(job_id: str):
    """Get the full job manifest with all processing details."""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if not job.manifest_path or not Path(job.manifest_path).exists():
        raise HTTPException(
            status_code=404,
            detail="Manifest not yet created (job may not have started processing)",
        )

    manifest = JobManifest.load(job.manifest_path)
    return manifest.to_dict()


@app.get("/jobs/{job_id}/transcription", tags=["info"])
async def get_transcription(job_id: str):
    """Get the transcription data for a job."""
    job = await db.get_job(job_id)
    if not job or not job.manifest_path:
        raise HTTPException(status_code=404, detail="Job or manifest not found")

    manifest = JobManifest.load(job.manifest_path)
    voice = manifest.get_phase("voice")
    return {
        "job_id": job_id,
        "transcription": voice.get("transcription", {}),
        "translation": voice.get("translation", {}),
    }


@app.get("/jobs/{job_id}/ocr", tags=["info"])
async def get_ocr_results(job_id: str):
    """Get OCR detection results for a job."""
    job = await db.get_job(job_id)
    if not job or not job.manifest_path:
        raise HTTPException(status_code=404, detail="Job or manifest not found")

    manifest = JobManifest.load(job.manifest_path)
    spatial = manifest.get_phase("spatial")
    return {
        "job_id": job_id,
        "frame_count": spatial.get("frame_count", 0),
        "text_regions": spatial.get("text_regions", []),
        "unique_texts": spatial.get("unique_texts", []),
    }


# ═══════════════════════════════════════════════════════════════════
# File Download Endpoints
# ═══════════════════════════════════════════════════════════════════

@app.get("/jobs/{job_id}/download", tags=["files"])
async def download_output(job_id: str):
    """Download the final translated video."""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status != JobStatus.DONE:
        raise HTTPException(
            status_code=400,
            detail=f"Job not complete (status: {job.status.value})",
        )

    if not job.output_video_path or not Path(job.output_video_path).exists():
        raise HTTPException(status_code=404, detail="Output video not found")

    return FileResponse(
        path=job.output_video_path,
        filename=f"translated_{job_id[:8]}.mp4",
        media_type="video/mp4",
    )


@app.get("/jobs/{job_id}/source", tags=["files"])
async def download_source(job_id: str):
    """Download the original source video."""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if not job.source_video_path or not Path(job.source_video_path).exists():
        raise HTTPException(status_code=404, detail="Source video not found")

    return FileResponse(
        path=job.source_video_path,
        filename=f"source_{job_id[:8]}.mp4",
        media_type="video/mp4",
    )


# ═══════════════════════════════════════════════════════════════════
# Batch Operations
# ═══════════════════════════════════════════════════════════════════

class BatchCreateRequest(BaseModel):
    """Request for batch job creation."""
    urls: list[str] = Field(..., min_length=1, max_length=50)
    source_platform: str = Field(default="douyin")
    target_language: str = Field(default="pt-BR")


@app.post("/jobs/batch", tags=["batch"])
async def batch_create_jobs(req: BatchCreateRequest):
    """Create multiple jobs at once from a list of URLs."""
    created_jobs = []
    errors = []

    for url in req.urls:
        try:
            job = await db.create_job(
                source_url=url,
                source_platform=req.source_platform,
                target_language=req.target_language,
            )
            created_jobs.append(job.to_dict())
        except Exception as e:
            errors.append({"url": url, "error": str(e)})

    return {
        "created": len(created_jobs),
        "errors": len(errors),
        "jobs": created_jobs,
        "error_details": errors,
    }


class BatchApproveRequest(BaseModel):
    """Request for batch job approval."""
    job_ids: list[str] = Field(..., min_length=1, max_length=50)
    settings: ApproveJobRequest = Field(default_factory=ApproveJobRequest)


@app.post("/jobs/batch/approve", tags=["batch"])
async def batch_approve_jobs(
    req: BatchApproveRequest,
    background_tasks: BackgroundTasks,
):
    """Approve and start processing multiple jobs."""
    approved = []
    errors = []

    for jid in req.job_ids:
        try:
            job = await db.get_job(jid)
            if not job:
                errors.append({"job_id": jid, "error": "Not found"})
                continue
            if job.status != JobStatus.PENDING_REVIEW:
                errors.append({"job_id": jid, "error": f"Invalid status: {job.status.value}"})
                continue

            await db.update_job_status(jid, JobStatus.APPROVED)
            background_tasks.add_task(run_pipeline, jid, req.settings)
            approved.append(jid)
        except Exception as e:
            errors.append({"job_id": jid, "error": str(e)})

    return {
        "approved": len(approved),
        "errors": len(errors),
        "approved_ids": approved,
        "error_details": errors,
    }


# ═══════════════════════════════════════════════════════════════════
# Configuration Endpoint
# ═══════════════════════════════════════════════════════════════════

@app.get("/config", tags=["info"])
async def get_config():
    """Get current pipeline configuration (non-sensitive)."""
    return {
        "workspace_dir": str(WORKSPACE_DIR),
        "db_path": str(DB_PATH),
        "lut_path": str(LUT_PATH),
        "lut_exists": LUT_PATH.exists(),
        "cookies_configured": bool(COOKIES_PATH),
        "api_keys_configured": {
            "assemblyai": bool(os.getenv("ASSEMBLYAI_API_KEY")),
            "anthropic": bool(os.getenv("ANTHROPIC_API_KEY")),
            "minimax": bool(os.getenv("MINIMAX_API_KEY")),
        },
        "supported_platforms": ["douyin", "tiktok", "youtube"],
        "default_target_language": "pt-BR",
        "status_flow": [s.value for s in JobStatus],
    }

# ═══════════════════════════════════════════════════════════════════
# Frontend-compatible Alias Routes
# The web UI calls /api/translate/* but FastAPI serves at /jobs/*
# These aliases bridge the gap when FastAPI is accessed directly
# ═══════════════════════════════════════════════════════════════════

from sse_starlette.sse import EventSourceResponse  # type: ignore

# Track active job progress for SSE — use shared module so agents can update too
from .server_progress import update_progress as _shared_update_progress
from .server_progress import get_all_progress as _get_all_progress
_job_progress = _get_all_progress()  # reference to shared dict


def _update_progress(job_id: str, phase: str, progress: float, message: str = ""):
    """Update progress state for SSE consumers."""
    _shared_update_progress(job_id, phase, progress, message)


@app.post("/api/tts/preview", tags=["frontend"])
async def tts_preview(voice_id: str = Query("female-shaonv"), text: str = Query("Olá! Este é um teste da voz selecionada. O bilionário sofreu um ataque cardíaco.")):
    """Generate a short TTS audio preview for voice selection. Cached on disk forever."""
    import httpx

    # Check disk cache first — never regenerate if already exists
    preview_dir = WORKSPACE_DIR / "tts_previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_path = preview_dir / f"preview_{voice_id}.wav"

    if preview_path.exists() and preview_path.stat().st_size > 0:
        return FileResponse(
            str(preview_path),
            media_type="audio/wav",
            filename=f"preview_{voice_id}.wav",
        )

    minimax_key = os.getenv("MINIMAX_API_KEY", "")
    if not minimax_key:
        raise HTTPException(status_code=500, detail="MINIMAX_API_KEY not configured")

    payload = {
        "model": "speech-2.8-hd",
        "text": text[:200],  # Limit text length for preview
        "voice_setting": {
            "voice_id": voice_id,
            "speed": 1.0,
            "vol": 1.0,
            "pitch": 0,
        },
        "audio_setting": {
            "sample_rate": 44100,
            "format": "wav",
        },
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.minimax.io/v1/t2a_v2",
                headers={
                    "Authorization": f"Bearer {minimax_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )

        data = resp.json()
        base_resp = data.get("base_resp", {})
        if base_resp.get("status_code", 0) != 0:
            raise HTTPException(
                status_code=400,
                detail=f"MiniMax error: {base_resp.get('status_msg', 'Unknown error')}",
            )

        audio_hex = data.get("data", {}).get("audio", "")
        if not audio_hex:
            raise HTTPException(status_code=500, detail="No audio data in response")

        audio_bytes = bytes.fromhex(audio_hex)

        # Save to disk cache and serve
        preview_path.write_bytes(audio_bytes)

        return FileResponse(
            str(preview_path),
            media_type="audio/wav",
            filename=f"preview_{voice_id}.wav",
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"MiniMax API error: {str(e)}")


@app.post("/api/translate/submit", status_code=201, tags=["frontend"])
async def frontend_submit(req: CreateJobRequest):
    """Alias: POST /api/translate/submit → create_job"""
    return await create_job(req)


@app.get("/api/translate/queue", tags=["frontend"])
async def frontend_queue(
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Alias: GET /api/translate/queue → list_jobs with progress data."""
    filter_status = None
    if status:
        try:
            filter_status = JobStatus(status)
        except ValueError:
            pass

    raw_jobs = await db.list_jobs(status=filter_status, limit=limit, offset=offset)
    result = []
    for j in raw_jobs:
        d = j.to_dict()
        # Inject live progress data
        progress_info = _job_progress.get(j.id, {})
        if progress_info:
            d["progress"] = progress_info.get("progress", 0)
            d["lastMessage"] = progress_info.get("message", "")
        result.append(d)
    return result


@app.post("/api/translate/approve/{job_id}", tags=["frontend"])
async def frontend_approve(job_id: str, background_tasks: BackgroundTasks):
    """Alias: POST /api/translate/approve/{job_id} → approve_job"""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # Read character_id from job metadata
    meta = job.metadata if isinstance(job.metadata, dict) else {}
    if isinstance(job.metadata, str):
        import json as _jm
        try:
            meta = _jm.loads(job.metadata)
        except Exception:
            meta = {}
    req = _settings_from_metadata(meta)
    return await approve_job(job_id, req, background_tasks)


@app.delete("/api/translate/jobs/{job_id}", tags=["frontend"])
async def frontend_delete(job_id: str):
    """Alias: DELETE /api/translate/jobs/{job_id} → delete_job"""
    return await delete_job(job_id)


@app.post("/api/translate/retry/{job_id}", tags=["frontend"])
async def frontend_retry(job_id: str, background_tasks: BackgroundTasks):
    """Retry a failed or completed job from the phase where it stopped."""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status not in (JobStatus.ERROR, JobStatus.DONE):
        raise HTTPException(
            status_code=400,
            detail=f"Only error/done jobs can be retried (current: {job.status.value})",
        )

    background_tasks.add_task(retry_pipeline, job_id)
    return {"retrying": True, "job_id": job_id}


@app.post("/api/translate/redo-lipsync/{job_id}", tags=["frontend"])
async def frontend_redo_lipsync(job_id: str, background_tasks: BackgroundTasks):
    """Re-run ONLY the lip sync + 9:16 layout for an existing job.

    Uses the already-generated TTS audio — does NOT re-download,
    re-transcribe, or re-generate TTS. Saves credits!
    """
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status not in (JobStatus.DONE, JobStatus.ERROR):
        raise HTTPException(
            status_code=400,
            detail=f"Job must be done or error to redo lip sync (current: {job.status.value})",
        )

    # Mark as processing
    await db.update_job_status(job_id, JobStatus.PROCESSING_SYNTHESIS)

    background_tasks.add_task(run_lipsync_only, job_id)
    return {"redo_lipsync": True, "job_id": job_id}

@app.post("/api/translate/reprocess/{job_id}", tags=["frontend"])
async def frontend_reprocess(job_id: str, phase: str = "overlay", background_tasks: BackgroundTasks = None):
    """Reprocess a job from a specific phase (overlay, synthesis, etc).

    Useful for re-running synthesis after pipeline code changes.
    """
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    phase_map = {
        "overlay": JobStatus.PROCESSING_OVERLAY,
        "synthesis": JobStatus.PROCESSING_SYNTHESIS,
        "audio": JobStatus.PROCESSING_AUDIO,
        "ocr": JobStatus.PROCESSING_OCR,
    }

    target_status = phase_map.get(phase)
    if not target_status:
        raise HTTPException(status_code=400, detail=f"Unknown phase: {phase}. Use: {list(phase_map.keys())}")

    # Force transition to the target phase
    await db.update_job_status(job_id, target_status)
    background_tasks.add_task(retry_pipeline, job_id)
    return {"reprocessing": True, "job_id": job_id, "from_phase": phase}


@app.get("/api/translate/download/{job_id}", tags=["frontend"])
async def frontend_download(job_id: str):
    """Alias: GET /api/translate/download/{job_id} → download_output"""
    return await download_output(job_id)


@app.get("/api/translate/stream/source/{job_id}", tags=["frontend"])
async def stream_source_video(job_id: str):
    """Stream the original source video for inline playback."""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    source = job.source_video_path
    if not source or not Path(source).exists():
        raise HTTPException(status_code=404, detail="Source video not found")

    return FileResponse(
        path=source,
        media_type="video/mp4",
        filename=f"source_{job_id[:8]}.mp4",
    )


@app.get("/api/translate/stream/output/{job_id}", tags=["frontend"])
async def stream_output_video(job_id: str):
    """Stream the translated output video for inline playback."""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    output = job.output_video_path
    if not output or not Path(output).exists():
        raise HTTPException(status_code=404, detail="Output video not found")

    return FileResponse(
        path=output,
        media_type="video/mp4",
        filename=f"translated_{job_id[:8]}.mp4",
    )


@app.get("/api/translate/download/{job_id}/{file_type}", tags=["frontend"])
async def frontend_download_file(job_id: str, file_type: str):
    """Download intermediate file (srt, audio, overlay)."""
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if not job.manifest_path or not Path(job.manifest_path).exists():
        raise HTTPException(status_code=404, detail="Manifest not found")

    manifest = JobManifest.load(job.manifest_path)
    manifest_data = manifest.to_dict()

    file_map = {
        "srt": manifest_data.get("voice", {}).get("translated_srt_path"),
        "audio": manifest_data.get("voice", {}).get("tts_audio_path"),
        "overlay": manifest_data.get("overlay", {}).get("overlay_path"),
    }

    file_path = file_map.get(file_type)
    if not file_path or not Path(file_path).exists():
        raise HTTPException(status_code=404, detail=f"File type '{file_type}' not found")

    media_types = {
        "srt": "text/plain",
        "audio": "audio/mpeg",
        "overlay": "video/quicktime",
    }

    return FileResponse(
        path=file_path,
        filename=f"{file_type}_{job_id[:8]}.{file_type if file_type != 'audio' else 'mp3'}",
        media_type=media_types.get(file_type, "application/octet-stream"),
    )


@app.get("/api/translate/progress/{job_id}", tags=["frontend"])
async def frontend_progress(job_id: str):
    """SSE endpoint for real-time job progress updates."""

    async def event_generator():
        import json as _json
        last_sent = ""
        while True:
            job = await db.get_job(job_id)
            if not job:
                yield {"event": "error_event", "data": '{"error": "Job not found"}'}
                break

            current_status = job.status.value
            progress_data = _job_progress.get(job_id, {})

            data = _json.dumps({
                "job_id": job_id,
                "status": current_status,
                "phase": progress_data.get("phase", current_status),
                "progress": progress_data.get("progress", 0),
                "message": progress_data.get("message", ""),
            })

            # Always send if data changed
            if data != last_sent:
                yield {"event": "progress", "data": data}
                last_sent = data

            # Terminal states
            if current_status == "done":
                yield {"event": "complete", "data": _json.dumps({"job_id": job_id, "status": "done"})}
                break
            elif current_status == "error":
                yield {
                    "event": "error_event",
                    "data": _json.dumps({
                        "job_id": job_id,
                        "status": "error",
                        "error": job.error_message or "Unknown error",
                    }),
                }
                break

            await asyncio.sleep(1.5)

    return EventSourceResponse(event_generator())


# ═══════════════════════════════════════════════════════════════════
# Character Management Endpoints
# ═══════════════════════════════════════════════════════════════════

import uuid
import json as _json_module
import aiofiles
from fastapi import UploadFile, File, Form

CHARACTERS_DIR = Path(_os_env.environ.get("FOLD_CHARACTERS_DIR", str(BASE_DIR / "data" / "characters")))
CHARACTERS_DIR.mkdir(parents=True, exist_ok=True)  # garante que existe no volume


ALLOWED_CHARACTER_EXTENSIONS = {
    # Video files (avatar for lip sync)
    ".mp4", ".mov", ".webm", ".avi", ".mkv",
    # Image files (fallback for still images)
    ".jpg", ".jpeg", ".png", ".webp", ".gif",
}


@app.post("/api/translate/characters/upload", tags=["characters"])
async def upload_character(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    """Upload a character avatar (video or image) with a name.

    The avatar should be a video of the character for lip sync.
    DreamFace will replace the mouth movements to match the TTS audio.
    Saves to data/characters/{character_id}/.
    """
    # Validate file extension
    ext = Path(file.filename or "unknown.mp4").suffix.lower()
    if ext not in ALLOWED_CHARACTER_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type: {ext}. Allowed: {sorted(ALLOWED_CHARACTER_EXTENSIONS)}",
        )

    # Validate name
    clean_name = name.strip()
    if not clean_name or len(clean_name) > 100:
        raise HTTPException(
            status_code=400,
            detail="Name must be between 1 and 100 characters.",
        )

    character_id = str(uuid.uuid4())
    char_dir = CHARACTERS_DIR / character_id
    char_dir.mkdir(parents=True, exist_ok=True)

    is_video = ext in {".mp4", ".mov", ".webm", ".avi", ".mkv"}
    avatar_filename = f"avatar{ext}"
    avatar_path = char_dir / avatar_filename
    try:
        content = await file.read()
        async with aiofiles.open(str(avatar_path), "wb") as f:
            await f.write(content)
    except Exception as e:
        logger.error("character.upload.write_failed", character_id=character_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")

    # Generate thumbnail for video avatars
    thumbnail_name = "thumbnail.jpg"
    if is_video:
        try:
            thumb_path = char_dir / thumbnail_name
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y", "-ss", "0.5", "-i", str(avatar_path),
                "-frames:v", "1", "-vf", "scale=200:-1", str(thumb_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
        except Exception:
            thumbnail_name = None
    else:
        thumbnail_name = avatar_filename  # use the image itself as thumbnail

    # Save metadata
    from datetime import datetime, timezone

    meta = {
        "id": character_id,
        "name": clean_name,
        "avatar_filename": avatar_filename,
        "is_video": is_video,
        "thumbnail": thumbnail_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    meta_path = char_dir / "meta.json"
    async with aiofiles.open(str(meta_path), "w") as f:
        await f.write(_json_module.dumps(meta, ensure_ascii=False, indent=2))

    logger.info("character.uploaded", character_id=character_id, name=clean_name, is_video=is_video)

    return {
        "id": character_id,
        "name": clean_name,
        "is_video": is_video,
        "image_url": f"/api/translate/characters/{character_id}/image",
        "created_at": meta["created_at"],
    }


@app.get("/api/translate/characters", tags=["characters"])
async def list_characters():
    """List all saved characters with their metadata."""
    characters = []

    if not CHARACTERS_DIR.exists():
        return characters

    for char_dir in sorted(CHARACTERS_DIR.iterdir()):
        if not char_dir.is_dir():
            continue
        meta_path = char_dir / "meta.json"
        if not meta_path.exists():
            continue
        try:
            async with aiofiles.open(str(meta_path), "r") as f:
                raw = await f.read()
            meta = _json_module.loads(raw)
            characters.append({
                "id": meta["id"],
                "name": meta["name"],
                "image_url": f"/api/translate/characters/{meta['id']}/image",
                "created_at": meta.get("created_at", ""),
            })
        except Exception as e:
            logger.warning("character.list.skip", dir=str(char_dir), error=str(e))
            continue

    # Sort by most recent first
    characters.sort(key=lambda c: c.get("created_at", ""), reverse=True)
    return characters


@app.delete("/api/translate/characters/{character_id}", tags=["characters"])
async def delete_character(character_id: str):
    """Delete a character and all its files."""
    char_dir = CHARACTERS_DIR / character_id
    if not char_dir.exists() or not char_dir.is_dir():
        raise HTTPException(status_code=404, detail="Character not found")

    import shutil

    try:
        shutil.rmtree(str(char_dir))
        logger.info("character.deleted", character_id=character_id)
        return {"deleted": True, "character_id": character_id}
    except Exception as e:
        logger.error("character.delete.failed", character_id=character_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to delete character: {str(e)}")


@app.get("/api/translate/characters/{character_id}/image", tags=["characters"])
async def get_character_image(character_id: str):
    """Serve the character thumbnail (for HUD display)."""
    char_dir = CHARACTERS_DIR / character_id
    if not char_dir.exists():
        raise HTTPException(status_code=404, detail="Character not found")

    # Load metadata to find thumbnail
    meta_path = char_dir / "meta.json"
    if meta_path.exists():
        meta = _json_module.loads(meta_path.read_text())
        thumb = meta.get("thumbnail")
        if thumb:
            thumb_path = char_dir / thumb
            if thumb_path.exists():
                media_type = "image/jpeg"
                if thumb_path.suffix.lower() == ".png":
                    media_type = "image/png"
                elif thumb_path.suffix.lower() in (".webp",):
                    media_type = "image/webp"
                return FileResponse(path=str(thumb_path), media_type=media_type)

    # Fallback: try to find any image file
    for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        candidate = char_dir / f"avatar{ext}"
        if candidate.exists():
            return FileResponse(path=str(candidate), media_type=f"image/{ext.strip('.')}")
        candidate = char_dir / f"thumbnail{ext}"
        if candidate.exists():
            return FileResponse(path=str(candidate), media_type=f"image/{ext.strip('.')}")

    raise HTTPException(status_code=404, detail="Character thumbnail not found")


@app.get("/api/translate/lipsync-audio/{job_id}", tags=["characters"])
async def get_lipsync_audio(job_id: str):
    """Serve o áudio TTS final de um job (para o DreamFace baixar via URL)."""
    audio_path = WORKSPACE_DIR / "downloads" / job_id / "voice" / "merged_audio.wav"
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio not found")
    return FileResponse(path=str(audio_path), media_type="audio/wav")


@app.get("/api/translate/serve-source/{job_id}", tags=["diagnostics"])
async def serve_source_video(job_id: str):
    """Serve o vídeo fonte baixado localmente como URL pública.

    Usado pela NewportAI watermark remover quando a api.douyin.wtf está
    indisponível e não há CDN URL. Permite passar o vídeo local como URL
    acessível externamente para a API de remoção de marca d'água.
    """
    download_dir = WORKSPACE_DIR / "downloads" / job_id
    # Procura o arquivo fonte (vários nomes possíveis)
    for candidate in ["source.mp4", "source_clean.mp4", "video.mp4"]:
        p = download_dir / candidate
        if p.exists():
            return FileResponse(path=str(p), media_type="video/mp4",
                                headers={"Content-Disposition": "inline"})
    # Busca qualquer .mp4 no diretório
    if download_dir.exists():
        for f in download_dir.glob("*.mp4"):
            return FileResponse(path=str(f), media_type="video/mp4",
                                headers={"Content-Disposition": "inline"})
    raise HTTPException(status_code=404, detail="Source video not found")


@app.get("/api/translate/dreamface-test", tags=["diagnostics"])
async def dreamface_test():
    """Testa a chave DreamFace API e retorna status — sem consumir créditos."""
    import asyncio as _asyncio
    dreamface_key = os.environ.get("DREAMFACE_API_KEY", "")
    if not dreamface_key:
        return {"ok": False, "error": "DREAMFACE_API_KEY não configurada no Railway"}

    try:
        from dreamapi import DreamAPI
        log_path = WORKSPACE_DIR / "dreamface_test.log"
        loop = _asyncio.get_event_loop()

        def _test_init():
            api = DreamAPI(dreamface_key, str(log_path))
            # Verifica se o SDK inicializa sem erros
            methods = [m for m in dir(api) if not m.startswith("_")]
            return api, methods

        api, methods = await loop.run_in_executor(None, _test_init)
        return {
            "ok": True,
            "key_prefix": dreamface_key[:8] + "...",
            "sdk_version": "0.0.3",
            "methods_available": methods,
            "dreamface_api_key_set": True,
        }
    except ImportError:
        return {"ok": False, "error": "Pacote dream-api não instalado. Adicione dream-api==0.0.3 ao requirements.txt"}
    except Exception as e:
        return {"ok": False, "error": str(e), "error_type": type(e).__name__}


@app.get("/api/translate/characters/{character_id}/avatar", tags=["characters"])
async def get_character_avatar(character_id: str):
    """Serve the full character avatar file (video or image).

    This is the file used by DreamFace for lip sync.
    """
    char_dir = CHARACTERS_DIR / character_id
    if not char_dir.exists():
        raise HTTPException(status_code=404, detail="Character not found")

    meta_path = char_dir / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Character metadata not found")

    meta = _json_module.loads(meta_path.read_text())
    avatar_filename = meta.get("avatar_filename", "")
    avatar_path = char_dir / avatar_filename
    # Prefere a versão 720p compactada (< 50MB) p/ o DreamFace baixar por URL
    _compact = avatar_path.with_name(avatar_path.stem + "_720.mp4") if avatar_path.suffix else None
    if _compact and _compact.exists():
        avatar_path = _compact
    if not avatar_path.exists():
        raise HTTPException(status_code=404, detail="Avatar file not found")

    media_types = {
        ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
        ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".webp": "image/webp", ".gif": "image/gif",
    }

    return FileResponse(
        path=str(avatar_path),
        media_type=media_types.get(avatar_path.suffix.lower(), "application/octet-stream"),
        filename=avatar_path.name,
    )


# ═══════════════════════════════════════════════════════════════════
# Workspace File Serving (for DreamFace API access)
# ═══════════════════════════════════════════════════════════════════

@app.get("/api/translate/files/{job_id}/{filename}", tags=["files"])
async def serve_workspace_file(job_id: str, filename: str):
    """Serve a file from the job workspace.

    Used internally to provide public URLs for the DreamFace API
    to access audio and video files.
    """
    # Security: only serve from known workspace directories
    workspace = BASE_DIR / "workspace"
    allowed_dirs = [
        workspace / job_id,
        workspace / "lipsync" / job_id,
        workspace / "outputs" / job_id,
    ]

    file_path = None
    for d in allowed_dirs:
        candidate = d / filename
        if candidate.exists() and candidate.is_file():
            file_path = candidate
            break

    if not file_path:
        raise HTTPException(status_code=404, detail="File not found")

    # Determine media type
    media_types = {
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac",
        ".ogg": "audio/ogg", ".flac": "audio/flac",
        ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    }

    return FileResponse(
        path=str(file_path),
        media_type=media_types.get(file_path.suffix.lower(), "application/octet-stream"),
        filename=filename,
    )


# ═══════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
