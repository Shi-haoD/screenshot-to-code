"""Eval sessions: a work period pinned to one eval set.

Exactly one session is active at a time; starting a new one supersedes the
old (sessions are never "ended"). Eval runs launched while a session is
active attach to it via the agent-run recorder, which makes the session
matrix (images x models) a plain query over the runs index. Sessions never
gate the UI generation path — they are pure metadata.

Stored in the agent-runs SQLite index (see ``fs_logging/agent_runs.py`` for
the schema). Timestamps use the same local-ISO format as ``runs.created_at``
so SQL string comparison against run timestamps is valid.
"""

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from fs_logging.agent_runs import open_index_db


@dataclass
class EvalSession:
    session_id: str
    name: str
    eval_set: str
    created_at: str
    is_active: bool


class SessionSetMismatchError(Exception):
    def __init__(self, active_session: EvalSession, requested_set: str) -> None:
        self.active_session = active_session
        self.requested_set = requested_set
        super().__init__(
            f"Active session {active_session.name!r} is pinned to set "
            f"{active_session.eval_set!r}, not {requested_set!r}"
        )


_SESSION_COLUMNS = "session_id, name, eval_set, created_at, is_active"


def _row_to_session(row: tuple[str, str, str, str, int]) -> EvalSession:
    return EvalSession(
        session_id=row[0],
        name=row[1],
        eval_set=row[2],
        created_at=row[3],
        is_active=bool(row[4]),
    )


def default_session_name() -> str:
    now = datetime.now()
    # %-d is not portable; strip the leading zero manually.
    return f"{now.strftime('%b')} {now.day} session"


def _activate_in_transaction(conn: sqlite3.Connection, session_id: str) -> None:
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE eval_sessions SET is_active = 0 WHERE is_active = 1")
    conn.execute(
        "UPDATE eval_sessions SET is_active = 1 WHERE session_id = ?",
        (session_id,),
    )
    conn.commit()


def create_session(eval_set: str, name: Optional[str] = None) -> EvalSession:
    session = EvalSession(
        session_id=(
            f"sess_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
        ),
        name=name or default_session_name(),
        eval_set=eval_set,
        created_at=datetime.now().isoformat(timespec="seconds"),
        is_active=True,
    )
    conn = open_index_db()
    try:
        conn.execute(
            "INSERT INTO eval_sessions "
            f"({_SESSION_COLUMNS}) VALUES (?, ?, ?, ?, 0)",
            (
                session.session_id,
                session.name,
                session.eval_set,
                session.created_at,
            ),
        )
        conn.commit()
        try:
            _activate_in_transaction(conn, session.session_id)
        except sqlite3.IntegrityError:
            # Concurrent activation raced the partial unique index; retry once.
            _activate_in_transaction(conn, session.session_id)
    finally:
        conn.close()
    return session


def list_sessions() -> list[EvalSession]:
    conn = open_index_db()
    try:
        rows = conn.execute(
            f"SELECT {_SESSION_COLUMNS} FROM eval_sessions "
            "ORDER BY created_at DESC, session_id DESC"
        ).fetchall()
    finally:
        conn.close()
    return [_row_to_session(row) for row in rows]


def get_session(session_id: str) -> Optional[EvalSession]:
    conn = open_index_db()
    try:
        row = conn.execute(
            f"SELECT {_SESSION_COLUMNS} FROM eval_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
    finally:
        conn.close()
    return _row_to_session(row) if row else None


def get_active_session() -> Optional[EvalSession]:
    conn = open_index_db()
    try:
        row = conn.execute(
            f"SELECT {_SESSION_COLUMNS} FROM eval_sessions WHERE is_active = 1"
        ).fetchone()
    finally:
        conn.close()
    return _row_to_session(row) if row else None


def activate_session(session_id: str) -> Optional[EvalSession]:
    conn = open_index_db()
    try:
        try:
            _activate_in_transaction(conn, session_id)
        except sqlite3.IntegrityError:
            _activate_in_transaction(conn, session_id)
    finally:
        conn.close()
    return get_session(session_id)


def resolve_session_for_run(set_name: str) -> EvalSession:
    """The session eval runs should attach to for this set.

    Active session on the same set wins; a mismatched active session is an
    error (the caller must explicitly start a new session); no session at
    all auto-creates one so a bare "/run_evals with a set" just works.
    """
    active = get_active_session()
    if active is None:
        return create_session(set_name)
    if active.eval_set != set_name:
        raise SessionSetMismatchError(active, set_name)
    return active


@dataclass
class SessionModelMeta:
    position: Optional[int]
    notes: str


def get_model_meta(session_id: str) -> dict[str, SessionModelMeta]:
    conn = open_index_db()
    try:
        rows = conn.execute(
            "SELECT model, position, notes FROM eval_session_models "
            "WHERE session_id = ?",
            (session_id,),
        ).fetchall()
    finally:
        conn.close()
    return {
        row[0]: SessionModelMeta(position=row[1], notes=row[2] or "")
        for row in rows
    }


def set_model_order(session_id: str, models: list[str]) -> None:
    """Persist the column order; models not listed keep their notes."""
    conn = open_index_db()
    try:
        for position, model in enumerate(models):
            conn.execute(
                "INSERT INTO eval_session_models (session_id, model, position) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT(session_id, model) DO UPDATE SET position = ?",
                (session_id, model, position, position),
            )
        conn.commit()
    finally:
        conn.close()


def set_model_notes(session_id: str, model: str, notes: str) -> None:
    conn = open_index_db()
    try:
        conn.execute(
            "INSERT INTO eval_session_models (session_id, model, notes) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(session_id, model) DO UPDATE SET notes = ?",
            (session_id, model, notes, notes),
        )
        conn.commit()
    finally:
        conn.close()


def completed_eval_inputs(session_id: str, model: str, stack: str) -> set[str]:
    """Input filenames already completed in this session for (model, stack)."""
    conn = open_index_db()
    try:
        rows = conn.execute(
            "SELECT DISTINCT input_file FROM runs "
            "WHERE eval_session = ? AND model = ? AND stack = ? "
            "AND status = 'completed' AND input_file IS NOT NULL",
            (session_id, model, stack),
        ).fetchall()
    finally:
        conn.close()
    return {row[0] for row in rows}
