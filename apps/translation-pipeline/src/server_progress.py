"""Shared progress state for SSE consumers.

This module provides a decoupled way for agents to update progress
without importing the full server module (avoids circular imports).
"""

from typing import Any

# Shared progress state — the server reads this via SSE
_job_progress: dict[str, dict[str, Any]] = {}


def update_progress(job_id: str, phase: str, progress: float, message: str = ""):
    """Update progress state for SSE consumers."""
    _job_progress[job_id] = {
        "phase": phase,
        "progress": progress,
        "message": message,
    }


def get_progress(job_id: str) -> dict[str, Any]:
    """Get current progress for a job."""
    return _job_progress.get(job_id, {})


def get_all_progress() -> dict[str, dict[str, Any]]:
    """Get all progress data."""
    return _job_progress
