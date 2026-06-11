"""SQLite database models for the VideoForge Translation Pipeline.

Uses aiosqlite for async database operations. Stores job state, metadata,
and links to manifest files for each translation job.
"""

from __future__ import annotations

import enum
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import aiosqlite
import structlog

logger = structlog.get_logger(__name__)


class JobStatus(str, enum.Enum):
    """State machine for job processing status."""

    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    DOWNLOADING = "downloading"
    PROCESSING_OCR = "processing_ocr"
    PROCESSING_AUDIO = "processing_audio"
    PROCESSING_OVERLAY = "processing_overlay"
    PROCESSING_SYNTHESIS = "processing_synthesis"
    DONE = "done"
    ERROR = "error"

    @classmethod
    def valid_transitions(cls) -> dict[JobStatus, list[JobStatus]]:
        """Define valid state transitions to enforce correct flow."""
        # All processing/retry targets
        _all_phases = [
            cls.APPROVED, cls.DOWNLOADING,
            cls.PROCESSING_OCR, cls.PROCESSING_AUDIO,
            cls.PROCESSING_OVERLAY, cls.PROCESSING_SYNTHESIS,
            cls.DONE, cls.ERROR,
        ]
        return {
            cls.PENDING_REVIEW: [cls.APPROVED, cls.ERROR],
            cls.APPROVED: _all_phases,
            cls.DOWNLOADING: _all_phases,
            cls.PROCESSING_OCR: _all_phases,
            cls.PROCESSING_AUDIO: _all_phases,
            cls.PROCESSING_OVERLAY: _all_phases,
            cls.PROCESSING_SYNTHESIS: _all_phases,
            cls.DONE: _all_phases,
            cls.ERROR: _all_phases,
        }

    def can_transition_to(self, target: JobStatus) -> bool:
        transitions = self.valid_transitions()
        return target in transitions.get(self, [])


class Job:
    """Represents a translation job in the system."""

    def __init__(
        self,
        id: str,
        source_url: str,
        source_platform: str,
        target_language: str,
        status: JobStatus,
        created_at: str,
        updated_at: str,
        error_message: Optional[str] = None,
        manifest_path: Optional[str] = None,
        source_video_path: Optional[str] = None,
        output_video_path: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ):
        self.id = id
        self.source_url = source_url
        self.source_platform = source_platform
        self.target_language = target_language
        self.status = JobStatus(status) if isinstance(status, str) else status
        self.created_at = created_at
        self.updated_at = updated_at
        self.error_message = error_message
        self.manifest_path = manifest_path
        self.source_video_path = source_video_path
        self.output_video_path = output_video_path
        self.metadata = metadata or {}

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_url": self.source_url,
            "source_platform": self.source_platform,
            "target_language": self.target_language,
            "status": self.status.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "error_message": self.error_message,
            "manifest_path": self.manifest_path,
            "source_video_path": self.source_video_path,
            "output_video_path": self.output_video_path,
            "metadata": self.metadata,
        }

    @classmethod
    def from_row(cls, row: aiosqlite.Row) -> Job:
        data = dict(row)
        if data.get("metadata"):
            data["metadata"] = json.loads(data["metadata"])
        return cls(**data)


class Database:
    """Async SQLite database wrapper for the job queue."""

    _CREATE_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        source_platform TEXT NOT NULL DEFAULT 'douyin',
        target_language TEXT NOT NULL DEFAULT 'pt-BR',
        status TEXT NOT NULL DEFAULT 'pending_review',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_message TEXT,
        manifest_path TEXT,
        source_video_path TEXT,
        output_video_path TEXT,
        metadata TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
    """

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self._db: Optional[aiosqlite.Connection] = None

    async def connect(self) -> None:
        """Initialize database connection and create tables."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(str(self.db_path))
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(self._CREATE_TABLE_SQL)
        await self._db.commit()
        logger.info("database.connected", path=str(self.db_path))

    async def disconnect(self) -> None:
        """Close the database connection."""
        if self._db:
            await self._db.close()
            self._db = None
            logger.info("database.disconnected")

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise RuntimeError("Database not connected. Call connect() first.")
        return self._db

    async def create_job(
        self,
        source_url: str,
        source_platform: str = "douyin",
        target_language: str = "pt-BR",
        metadata: Optional[dict[str, Any]] = None,
    ) -> Job:
        """Create a new translation job."""
        job_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        await self.db.execute(
            """
            INSERT INTO jobs (id, source_url, source_platform, target_language,
                            status, created_at, updated_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                source_url,
                source_platform,
                target_language,
                JobStatus.PENDING_REVIEW.value,
                now,
                now,
                json.dumps(metadata or {}),
            ),
        )
        await self.db.commit()

        job = await self.get_job(job_id)
        assert job is not None
        logger.info("job.created", job_id=job_id, source_url=source_url)
        return job

    async def get_job(self, job_id: str) -> Optional[Job]:
        """Fetch a job by ID."""
        cursor = await self.db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = await cursor.fetchone()
        return Job.from_row(row) if row else None

    async def list_jobs(
        self,
        status: Optional[JobStatus] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Job]:
        """List jobs, optionally filtered by status."""
        if status:
            cursor = await self.db.execute(
                "SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (status.value, limit, offset),
            )
        else:
            cursor = await self.db.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
        rows = await cursor.fetchall()
        return [Job.from_row(row) for row in rows]

    async def update_job_status(
        self,
        job_id: str,
        new_status: JobStatus,
        error_message: Optional[str] = None,
    ) -> Optional[Job]:
        """Transition job to a new status with validation."""
        job = await self.get_job(job_id)
        if not job:
            logger.error("job.not_found", job_id=job_id)
            return None

        if not job.status.can_transition_to(new_status):
            logger.error(
                "job.invalid_transition",
                job_id=job_id,
                current=job.status.value,
                target=new_status.value,
            )
            raise ValueError(
                f"Invalid transition: {job.status.value} → {new_status.value}"
            )

        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """
            UPDATE jobs SET status = ?, updated_at = ?, error_message = ?
            WHERE id = ?
            """,
            (new_status.value, now, error_message, job_id),
        )
        await self.db.commit()

        logger.info(
            "job.status_updated",
            job_id=job_id,
            old_status=job.status.value,
            new_status=new_status.value,
        )
        return await self.get_job(job_id)

    async def update_job_field(
        self, job_id: str, field: str, value: Any
    ) -> Optional[Job]:
        """Update a single field on a job."""
        allowed_fields = {
            "manifest_path",
            "source_video_path",
            "output_video_path",
            "metadata",
            "error_message",
        }
        if field not in allowed_fields:
            raise ValueError(f"Cannot update field: {field}")

        now = datetime.now(timezone.utc).isoformat()
        if field == "metadata" and isinstance(value, dict):
            value = json.dumps(value)

        await self.db.execute(
            f"UPDATE jobs SET {field} = ?, updated_at = ? WHERE id = ?",
            (value, now, job_id),
        )
        await self.db.commit()
        return await self.get_job(job_id)

    async def count_jobs(self, status: Optional[JobStatus] = None) -> int:
        """Count jobs, optionally filtered by status."""
        if status:
            cursor = await self.db.execute(
                "SELECT COUNT(*) FROM jobs WHERE status = ?", (status.value,)
            )
        else:
            cursor = await self.db.execute("SELECT COUNT(*) FROM jobs")
        row = await cursor.fetchone()
        return row[0] if row else 0

    async def delete_job(self, job_id: str) -> bool:
        """Delete a job by ID. Returns True if deleted."""
        cursor = await self.db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        await self.db.commit()
        deleted = cursor.rowcount > 0
        if deleted:
            logger.info("job.deleted", job_id=job_id)
        return deleted
