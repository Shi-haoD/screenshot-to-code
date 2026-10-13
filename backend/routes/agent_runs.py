"""API for browsing recorded agent runs (see ``fs_logging/agent_runs.py``).

The list endpoint reads the SQLite index; the detail endpoint replays the
run's ``events.jsonl`` from disk. Output endpoints serve the snapshotted
final HTML and its captured assets so the viewer can render a run's result
without depending on expiring remote URLs or the live asset store.
"""

import json
import os
import shutil
import sqlite3
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from fs_logging.agent_runs import (
    RUN_ID_PATTERN,
    get_agent_runs_db_path,
    get_agent_runs_directory,
    open_index_db,
)

router = APIRouter()

_RUN_COLUMNS = [
    "run_id",
    "generation_id",
    "variant_index",
    "entry_point",
    "provider",
    "model",
    "api_model_name",
    "stack",
    "input_mode",
    "generation_type",
    "status",
    "error",
    "created_at",
    "completed_at",
    "total_duration_ms",
    "llm_time_ms",
    "tool_time_ms",
    "num_llm_calls",
    "num_tool_calls",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
    "total_cost_usd",
    "has_unpriced_calls",
    "size_bytes",
    "eval_session",
    "eval_set",
    "input_file",
    "input_image_sha256",
]


class AgentRunSummary(BaseModel):
    run_id: str
    generation_id: str
    variant_index: int
    entry_point: str
    provider: Optional[str]
    model: Optional[str]
    api_model_name: Optional[str]
    stack: Optional[str]
    input_mode: Optional[str]
    generation_type: Optional[str]
    status: str
    error: Optional[str]
    created_at: str
    completed_at: Optional[str]
    total_duration_ms: Optional[int]
    llm_time_ms: Optional[int]
    tool_time_ms: Optional[int]
    num_llm_calls: int
    num_tool_calls: int
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    cache_read_tokens: Optional[int]
    cache_write_tokens: Optional[int]
    total_tokens: Optional[int]
    total_cost_usd: Optional[float]
    has_unpriced_calls: bool
    size_bytes: Optional[int]
    eval_session: Optional[str]
    eval_set: Optional[str]
    input_file: Optional[str]
    input_image_sha256: Optional[str]


class AgentRunListResponse(BaseModel):
    runs: list[AgentRunSummary]
    total_size_bytes: int
    runs_directory: str


class AgentRunDetailResponse(BaseModel):
    run: AgentRunSummary
    events: list[dict[str, Any]]


class PruneAgentRunsRequest(BaseModel):
    max_age_days: int = 7


class PruneAgentRunsResponse(BaseModel):
    deleted_count: int
    freed_bytes: int


def _row_to_summary(row: tuple[Any, ...]) -> AgentRunSummary:
    data = dict(zip(_RUN_COLUMNS, row))
    data["has_unpriced_calls"] = bool(data["has_unpriced_calls"])
    return AgentRunSummary(**data)


def _directory_size_bytes(path: str) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
    return total


def _fetch_run(run_id: str) -> AgentRunSummary:
    if not RUN_ID_PATTERN.match(run_id):
        raise HTTPException(status_code=400, detail="Invalid run id")
    if not os.path.isfile(get_agent_runs_db_path()):
        raise HTTPException(status_code=404, detail="No runs recorded")
    conn = open_index_db()
    try:
        row = conn.execute(
            f"SELECT {', '.join(_RUN_COLUMNS)} FROM runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _row_to_summary(row)


@router.get("/agent-runs", response_model=AgentRunListResponse)
async def list_agent_runs(limit: int = 200) -> AgentRunListResponse:
    runs_directory = get_agent_runs_directory()
    if not os.path.isfile(get_agent_runs_db_path()):
        return AgentRunListResponse(
            runs=[], total_size_bytes=0, runs_directory=runs_directory
        )

    conn = open_index_db()
    try:
        rows = conn.execute(
            f"SELECT {', '.join(_RUN_COLUMNS)} FROM runs "
            "ORDER BY created_at DESC, run_id DESC LIMIT ?",
            (max(1, min(limit, 1000)),),
        ).fetchall()
    finally:
        conn.close()

    return AgentRunListResponse(
        runs=[_row_to_summary(row) for row in rows],
        total_size_bytes=_directory_size_bytes(runs_directory),
        runs_directory=runs_directory,
    )


@router.get("/agent-runs/{run_id}", response_model=AgentRunDetailResponse)
async def get_agent_run(
    run_id: str, include_stream_deltas: bool = False
) -> AgentRunDetailResponse:
    run = _fetch_run(run_id)
    events: list[dict[str, Any]] = []
    events_path = os.path.join(get_agent_runs_directory(), run_id, "events.jsonl")
    if os.path.isfile(events_path):
        with open(events_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    # A crashed writer can leave a torn final line.
                    continue
                if not include_stream_deltas and event.get("type") == "stream_delta":
                    continue
                events.append(event)
    return AgentRunDetailResponse(run=run, events=events)


@router.get("/agent-runs/{run_id}/output")
async def get_agent_run_output(run_id: str) -> HTMLResponse:
    _fetch_run(run_id)
    run_dir = os.path.join(get_agent_runs_directory(), run_id)
    for candidate in ("final_selfcontained.html", "final.html"):
        path = os.path.join(run_dir, candidate)
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                return HTMLResponse(content=f.read())
    raise HTTPException(status_code=404, detail="Run has no captured output")


@router.get("/agent-runs/{run_id}/assets/{filename}")
async def get_agent_run_asset(run_id: str, filename: str) -> FileResponse:
    _fetch_run(run_id)
    assets_dir = os.path.join(get_agent_runs_directory(), run_id, "assets")
    # basename() strips any traversal components before the containment check.
    safe_name = os.path.basename(filename)
    path = os.path.realpath(os.path.join(assets_dir, safe_name))
    if not path.startswith(os.path.realpath(assets_dir) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid asset path")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(path)


@router.post("/agent-runs/prune", response_model=PruneAgentRunsResponse)
async def prune_agent_runs(request: PruneAgentRunsRequest) -> PruneAgentRunsResponse:
    if request.max_age_days < 1:
        raise HTTPException(status_code=400, detail="max_age_days must be >= 1")

    runs_directory = get_agent_runs_directory()
    if not os.path.isdir(runs_directory):
        return PruneAgentRunsResponse(deleted_count=0, freed_bytes=0)

    cutoff_timestamp = (
        datetime.now() - timedelta(days=request.max_age_days)
    ).timestamp()

    deleted_count = 0
    freed_bytes = 0
    deleted_run_ids: list[str] = []

    for entry in os.scandir(runs_directory):
        if not entry.is_dir() or not RUN_ID_PATTERN.match(entry.name):
            continue
        if entry.stat().st_mtime >= cutoff_timestamp:
            continue
        freed_bytes += _directory_size_bytes(entry.path)
        shutil.rmtree(entry.path, ignore_errors=True)
        deleted_run_ids.append(entry.name)
        deleted_count += 1

    if os.path.isfile(get_agent_runs_db_path()):
        conn = open_index_db()
        try:
            for run_id in deleted_run_ids:
                conn.execute("DELETE FROM runs WHERE run_id = ?", (run_id,))
            # Rows whose directories vanished out-of-band are orphans too.
            for (run_id, run_dir) in conn.execute(
                "SELECT run_id, run_dir FROM runs"
            ).fetchall():
                if not os.path.isdir(run_dir):
                    conn.execute("DELETE FROM runs WHERE run_id = ?", (run_id,))
            conn.commit()
        except sqlite3.Error as e:
            print(f"[AGENT RUN] Prune index cleanup failed: {e}")
        finally:
            conn.close()

    return PruneAgentRunsResponse(deleted_count=deleted_count, freed_bytes=freed_bytes)
