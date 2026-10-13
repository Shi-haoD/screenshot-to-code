import json
import sqlite3
from pathlib import Path
from typing import Any, Optional

import pytest

from agent.providers.base import StreamEvent
from costs.pricing import MODEL_PRICING
from costs.token_usage import TokenUsage
from agent.tools.types import ToolCall, ToolExecutionResult
from fs_logging.agent_runs import (
    RUN_ID_PATTERN,
    AgentRunRecorder,
    get_agent_runs_db_path,
    get_agent_runs_directory,
)
from llm import Llm


@pytest.fixture
def logs_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("LOGS_PATH", str(tmp_path))
    return tmp_path


def _make_recorder(enabled: bool = True, **overrides: Any) -> AgentRunRecorder:
    kwargs: dict[str, Any] = dict(
        generation_id="gen_test_00000000",
        variant_index=0,
        entry_point="websocket",
        stack="html_tailwind",
        input_mode="image",
        generation_type="create",
        enabled=enabled,
    )
    kwargs.update(overrides)
    return AgentRunRecorder(**kwargs)


def _read_events(recorder: AgentRunRecorder) -> list[dict[str, Any]]:
    events_path = Path(recorder.run_dir) / "events.jsonl"
    with open(events_path) as f:
        return [json.loads(line) for line in f if line.strip()]


def _db_row(query: str, params: tuple[Any, ...] = ()) -> Optional[tuple[Any, ...]]:
    conn = sqlite3.connect(get_agent_runs_db_path())
    try:
        cursor = conn.execute(query, params)
        return cursor.fetchone()
    finally:
        conn.close()


@pytest.mark.asyncio
async def test_disabled_recorder_writes_nothing(logs_path: Path) -> None:
    recorder = _make_recorder(enabled=False)
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [{"role": "user", "content": "hi"}])
    recorder.record_llm_request("openai", "gpt-5.5", {"input": []})
    recorder.record_llm_response("text", [], TokenUsage(input=10, output=5, total=15))
    await recorder.record_run_end("completed", final_html="<html></html>")

    assert not (logs_path / "run_logs").exists()


def test_run_start_creates_events_and_db_row(logs_path: Path) -> None:
    recorder = _make_recorder()
    assert RUN_ID_PATTERN.match(recorder.run_id)
    recorder.record_run_start(
        Llm.CLAUDE_OPUS_4_8_HIGH, [{"role": "user", "content": "make a page"}]
    )

    events = _read_events(recorder)
    assert [e["type"] for e in events] == ["run_start"]
    assert events[0]["model"] == Llm.CLAUDE_OPUS_4_8_HIGH.value
    assert events[0]["provider"] == "anthropic"
    assert events[0]["prompt_messages"] == [{"role": "user", "content": "make a page"}]

    row = _db_row(
        "SELECT generation_id, variant_index, entry_point, provider, status "
        "FROM runs WHERE run_id = ?",
        (recorder.run_id,),
    )
    assert row == ("gen_test_00000000", 0, "websocket", "anthropic", "running")


@pytest.mark.asyncio
async def test_full_run_records_events_costs_and_totals(logs_path: Path) -> None:
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [{"role": "user", "content": "go"}])

    # Step 1: thinking + assistant deltas, one tool call
    recorder.record_llm_request("openai", "gpt-5.5", {"input": ["go"]})
    recorder.record_stream_event(
        StreamEvent(type="thinking_delta", text="hmm "), "thinking-0-abc"
    )
    recorder.record_stream_event(
        StreamEvent(type="thinking_delta", text="ok"), "thinking-0-abc"
    )
    recorder.record_stream_event(
        StreamEvent(
            type="tool_call_delta",
            tool_call_id="call_1",
            tool_name="create_file",
            tool_arguments='{"path": "index.html"',
        ),
        "call_1",
    )
    recorder.record_stream_event(
        StreamEvent(
            type="tool_call_delta",
            tool_call_id="call_1",
            tool_name="create_file",
            tool_arguments='{"path": "index.html", "content": "<html>"}',
        ),
        "call_1",
    )
    usage_1 = TokenUsage(input=1000, output=500, cache_read=200, total=1700)
    tool_call = ToolCall(
        id="call_1",
        name="create_file",
        arguments={"path": "index.html", "content": "<html>"},
    )
    recorder.record_llm_response("", [tool_call], usage_1)

    recorder.record_tool_start("call_1", tool_call)
    recorder.record_tool_end(
        "call_1",
        tool_call,
        ToolExecutionResult(
            ok=True,
            result={"path": "index.html"},
            summary={"path": "index.html"},
            updated_content="<html></html>",
        ),
    )
    recorder.record_set_code(14, "tool_result")

    # Step 2: final assistant turn, no tools
    recorder.record_llm_request("openai", "gpt-5.5", {"input": ["continue"]})
    recorder.record_stream_event(
        StreamEvent(type="assistant_delta", text="done"), "assistant-0-def"
    )
    usage_2 = TokenUsage(input=2000, output=100, total=2100)
    recorder.record_llm_response("done", [], usage_2)

    await recorder.record_run_end("completed", final_html="<html>final</html>")

    events = _read_events(recorder)
    assert [e["type"] for e in events] == [
        "run_start",
        "llm_call_start",
        "stream_delta",
        "stream_delta",
        "stream_delta",
        "stream_delta",
        "llm_call_end",
        "tool_call_start",
        "tool_call_end",
        "set_code",
        "llm_call_start",
        "stream_delta",
        "llm_call_end",
        "run_end",
    ]
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))

    # Cumulative tool-arg snapshots are recorded as incremental suffixes.
    tool_deltas = [
        e for e in events if e["type"] == "stream_delta" and e["kind"] == "tool_call"
    ]
    assert tool_deltas[0]["args_delta"] == '{"path": "index.html"'
    assert tool_deltas[1]["args_delta"] == ', "content": "<html>"}'

    llm_end_1 = events[6]
    assert llm_end_1["thinking_text"] == "hmm ok"
    assert llm_end_1["thinking_ms"] >= 0
    assert llm_end_1["tool_calls"] == [
        {
            "id": "call_1",
            "name": "create_file",
            "arguments": {"path": "index.html", "content": "<html>"},
        }
    ]
    pricing = MODEL_PRICING["gpt-5.5"]
    assert llm_end_1["cost_usd"] == pytest.approx(usage_1.cost(pricing))

    tool_end = events[8]
    assert tool_end["ok"] is True
    assert tool_end["result"] == {"path": "index.html"}
    assert tool_end["updated_content_len"] == len("<html></html>")
    assert tool_end["duration_ms"] >= 0

    run_end = events[-1]
    expected_total = usage_1.cost(pricing) + usage_2.cost(pricing)
    assert run_end["status"] == "completed"
    assert run_end["num_llm_calls"] == 2
    assert run_end["num_tool_calls"] == 1
    assert run_end["usage"]["input"] == 3000
    assert run_end["usage"]["total"] == 3800
    assert run_end["total_cost_usd"] == pytest.approx(expected_total)
    assert run_end["has_unpriced_calls"] is False
    assert run_end["final_html_len"] == len("<html>final</html>")

    row = _db_row(
        "SELECT status, num_llm_calls, num_tool_calls, input_tokens, total_tokens, "
        "total_cost_usd, has_unpriced_calls, total_duration_ms, llm_time_ms, "
        "tool_time_ms, api_model_name FROM runs WHERE run_id = ?",
        (recorder.run_id,),
    )
    assert row is not None
    assert row[0] == "completed"
    assert row[1] == 2
    assert row[2] == 1
    assert row[3] == 3000
    assert row[4] == 3800
    assert row[5] == pytest.approx(expected_total)
    assert row[6] == 0
    assert row[7] >= 0 and row[8] >= 0 and row[9] >= 0
    assert row[10] == "gpt-5.5"

    call_rows = []
    conn = sqlite3.connect(get_agent_runs_db_path())
    try:
        call_rows = conn.execute(
            "SELECT step, input_tokens, cost_usd FROM llm_calls "
            "WHERE run_id = ? ORDER BY step",
            (recorder.run_id,),
        ).fetchall()
    finally:
        conn.close()
    assert len(call_rows) == 2
    assert call_rows[0][1] == 1000
    assert call_rows[0][2] == pytest.approx(usage_1.cost(pricing))

    run_json = json.loads((Path(recorder.run_dir) / "run.json").read_text())
    assert run_json["final_html"] == "<html>final</html>"
    assert len(run_json["llm_calls"]) == 2
    assert len(run_json["tool_calls"]) == 1
    assert (Path(recorder.run_dir) / "final.html").read_text() == "<html>final</html>"


@pytest.mark.asyncio
async def test_unpriced_model_flags_and_null_cost(logs_path: Path) -> None:
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    recorder.record_llm_request("openai", "unknown-model-x", {})
    recorder.record_llm_response("hi", [], TokenUsage(input=10, output=5, total=15))
    await recorder.record_run_end("completed")

    events = _read_events(recorder)
    llm_end = next(e for e in events if e["type"] == "llm_call_end")
    assert llm_end["cost_usd"] is None
    run_end = events[-1]
    assert run_end["total_cost_usd"] is None
    assert run_end["has_unpriced_calls"] is True

    row = _db_row(
        "SELECT total_cost_usd, has_unpriced_calls FROM runs WHERE run_id = ?",
        (recorder.run_id,),
    )
    assert row == (None, 1)


@pytest.mark.asyncio
async def test_gemini_none_usage_is_tolerated(logs_path: Path) -> None:
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GEMINI_3_5_FLASH_HIGH, [])
    recorder.record_llm_request("gemini", "gemini-3.5-flash", {})
    recorder.record_llm_response("hi", [], None)
    await recorder.record_run_end("completed")

    events = _read_events(recorder)
    llm_end = next(e for e in events if e["type"] == "llm_call_end")
    assert llm_end["usage"] is None
    assert llm_end["cost_usd"] is None
    assert events[-1]["has_unpriced_calls"] is True


@pytest.mark.asyncio
async def test_failed_run_and_idempotent_run_end(logs_path: Path) -> None:
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    await recorder.record_run_end("failed", error="boom")
    # A second call (e.g. failure path after cancel) must not double-write.
    await recorder.record_run_end("completed", final_html="<html></html>")

    events = _read_events(recorder)
    assert [e["type"] for e in events] == ["run_start", "run_end"]
    assert events[-1]["status"] == "failed"
    assert events[-1]["error"] == "boom"

    row = _db_row(
        "SELECT status, error FROM runs WHERE run_id = ?", (recorder.run_id,)
    )
    assert row == ("failed", "boom")


@pytest.mark.asyncio
async def test_asset_snapshot_copies_local_and_rewrites(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    local_asset_dir = logs_path / "local_assets"
    local_asset_dir.mkdir()
    (local_asset_dir / "crop_abc.png").write_bytes(b"png-bytes")
    monkeypatch.setattr(
        "fs_logging.agent_runs.LOCAL_ASSET_DIR", str(local_asset_dir)
    )

    html = (
        '<html><img src="http://127.0.0.1:7001/local-assets/crop_abc.png">'
        '<img src="/local-assets/missing.png">'
        '<div style="background: url(/local-assets/crop_abc.png)"></div></html>'
    )
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    await recorder.record_run_end("completed", final_html=html)

    run_dir = Path(recorder.run_dir)
    assert (run_dir / "final.html").read_text() == html
    assert (run_dir / "assets" / "crop_abc.png").read_bytes() == b"png-bytes"

    rewritten = (run_dir / "final_selfcontained.html").read_text()
    assert "assets/crop_abc.png" in rewritten
    assert "http://127.0.0.1:7001/local-assets/" not in rewritten
    assert "url(assets/crop_abc.png)" in rewritten

    manifest = json.loads((run_dir / "assets_manifest.json").read_text())
    statuses = {entry["url"]: entry["status"] for entry in manifest}
    assert statuses["http://127.0.0.1:7001/local-assets/crop_abc.png"] == "copied"
    assert statuses["/local-assets/missing.png"] == "missing"


@pytest.mark.asyncio
async def test_asset_snapshot_downloads_remote_images(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FakeResponse:
        content = b"remote-image-bytes"
        headers = {"content-type": "image/png"}

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.requested: list[str] = []

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def get(self, url: str) -> FakeResponse:
            self.requested.append(url)
            if "broken" in url:
                raise RuntimeError("download failed")
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    html = (
        '<html><img src="https://replicate.delivery/xyz/generated">'
        '<img src="https://example.com/broken.png"></html>'
    )
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    await recorder.record_run_end("completed", final_html=html)

    run_dir = Path(recorder.run_dir)
    manifest = json.loads((run_dir / "assets_manifest.json").read_text())
    by_url = {entry["url"]: entry for entry in manifest}
    ok_entry = by_url["https://replicate.delivery/xyz/generated"]
    assert ok_entry["status"] == "downloaded"
    saved = run_dir / ok_entry["file"]
    assert saved.read_bytes() == b"remote-image-bytes"
    assert by_url["https://example.com/broken.png"]["status"] == "failed"

    rewritten = (run_dir / "final_selfcontained.html").read_text()
    assert "https://replicate.delivery/xyz/generated" not in rewritten
    # Failed downloads keep their original URL.
    assert "https://example.com/broken.png" in rewritten


@pytest.mark.asyncio
async def test_asset_snapshot_catches_urls_in_js_strings(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FakeResponse:
        content = b"js-loaded-image"
        headers = {"content-type": "image/jpeg"}

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def get(self, url: str) -> FakeResponse:
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    # Image loaded programmatically — no src= attribute anywhere.
    html = (
        "<html><script>loadPhoto(el, "
        "'https://replicate.delivery/abc/output_1.jpeg');</script></html>"
    )
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    await recorder.record_run_end("completed", final_html=html)

    run_dir = Path(recorder.run_dir)
    manifest = json.loads((run_dir / "assets_manifest.json").read_text())
    assert manifest[0]["status"] == "downloaded"
    rewritten = (run_dir / "final_selfcontained.html").read_text()
    assert "replicate.delivery" not in rewritten
    assert "assets/" in rewritten


class _ToolThenDoneSession:
    """One create_file tool turn, then a final assistant turn."""

    def __init__(self, cost_usd: Optional[float] = None) -> None:
        self.turns = 0
        self.closed = False
        self.cost_usd = cost_usd

    def total_cost_usd(self) -> Optional[float]:
        return self.cost_usd

    async def stream_turn(self, on_event: Any) -> Any:
        from agent.providers.base import ProviderTurn, StreamEvent

        self.turns += 1
        if self.turns == 1:
            await on_event(StreamEvent(type="thinking_delta", text="planning"))
            return ProviderTurn(
                assistant_text="",
                tool_calls=[
                    ToolCall(
                        id="call_1",
                        name="create_file",
                        arguments={
                            "path": "index.html",
                            "content": "<html>from tool</html>",
                        },
                    )
                ],
            )
        return ProviderTurn(assistant_text="done", tool_calls=[])

    async def append_tool_results(self, turn: Any, executed_tool_calls: Any) -> None:
        return None

    async def close(self) -> None:
        self.closed = True


class _ExplodingSession:
    async def stream_turn(self, on_event: Any) -> Any:
        raise RuntimeError("provider exploded")

    async def append_tool_results(self, turn: Any, executed_tool_calls: Any) -> None:
        return None

    async def close(self) -> None:
        return None


def _make_engine(recorder: AgentRunRecorder) -> Any:
    from agent.engine import AgentEngine

    async def send_message(
        message_type: str,
        value: Optional[str],
        variant_index: int,
        data: Optional[dict[str, Any]],
        event_id: Optional[str],
    ) -> None:
        return None

    return AgentEngine(
        send_message=send_message,
        variant_index=0,
        openai_api_key="key",
        openai_base_url=None,
        anthropic_api_key=None,
        gemini_api_key=None,
        replicate_api_key=None,
        should_generate_images=False,
        recorder=recorder,
    )


@pytest.mark.asyncio
async def test_engine_records_full_run(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _ToolThenDoneSession()
    monkeypatch.setattr(
        "agent.engine.create_provider_session", lambda **kwargs: session
    )

    recorder = _make_recorder()
    engine = _make_engine(recorder)
    result = await engine.run(
        Llm.GPT_5_5_HIGH, [{"role": "user", "content": "build it"}]  # type: ignore[list-item]
    )

    assert result == "<html>from tool</html>"
    events = _read_events(recorder)
    types = [e["type"] for e in events]
    assert types[0] == "run_start"
    assert "stream_delta" in types
    assert "tool_call_start" in types and "tool_call_end" in types
    assert types[-1] == "run_end"
    assert events[-1]["status"] == "completed"
    assert events[-1]["num_tool_calls"] == 1

    tool_end = next(e for e in events if e["type"] == "tool_call_end")
    assert tool_end["name"] == "create_file"
    assert tool_end["ok"] is True

    row = _db_row("SELECT status FROM runs WHERE run_id = ?", (recorder.run_id,))
    assert row == ("completed",)
    assert (Path(recorder.run_dir) / "final.html").read_text() == (
        "<html>from tool</html>"
    )


@pytest.mark.asyncio
async def test_engine_aborts_over_budget_run(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent.engine import BudgetExceededError

    session = _ToolThenDoneSession(cost_usd=5.0)
    monkeypatch.setattr(
        "agent.engine.create_provider_session", lambda **kwargs: session
    )

    recorder = _make_recorder()
    engine = _make_engine(recorder)
    with pytest.raises(BudgetExceededError) as excinfo:
        await engine.run(Llm.GPT_5_5_HIGH, [])

    # User-facing message must not leak cost figures.
    assert "$" not in str(excinfo.value)
    events = _read_events(recorder)
    assert events[-1]["status"] == "failed"
    # Only the first turn ran; its tools were never executed.
    assert session.turns == 1


@pytest.mark.asyncio
async def test_engine_allows_final_turn_over_budget(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A run finishing naturally is returned even when over budget: aborting
    # after the final turn would waste tokens already paid for.
    session = _ToolThenDoneSession(cost_usd=0.5)
    monkeypatch.setattr(
        "agent.engine.create_provider_session", lambda **kwargs: session
    )
    recorder = _make_recorder()
    engine = _make_engine(recorder)

    async def creep_cost(*args: Any, **kwargs: Any) -> Any:
        # Cost crosses the ceiling only on the final (no-tool) turn.
        result = await _ToolThenDoneSession.stream_turn(session, *args, **kwargs)
        if session.turns == 2:
            session.cost_usd = 5.0
        return result

    monkeypatch.setattr(session, "stream_turn", creep_cost)
    result = await engine.run(Llm.GPT_5_5_HIGH, [])
    assert result == "<html>from tool</html>"


@pytest.mark.asyncio
async def test_eval_runner_does_not_retry_budget_abort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent.engine import BudgetExceededError
    from evals.runner import generate_code_and_time

    calls = {"count": 0}

    async def always_over_budget(**kwargs: Any) -> str:
        calls["count"] += 1
        raise BudgetExceededError()

    monkeypatch.setattr(
        "evals.runner.generate_code_for_image", always_over_budget
    )
    (
        filename,
        attempt,
        content,
        duration,
        error,
        retries_used,
    ) = await generate_code_and_time(
        image_url="data:image/png;base64,eA==",
        stack="html_tailwind",
        model=Llm.GPT_5_5_HIGH,
        original_input_filename="x.png",
        attempt_idx=0,
    )
    assert isinstance(error, BudgetExceededError)
    assert content is None
    assert retries_used == 0
    assert calls["count"] == 1  # no retries


@pytest.mark.asyncio
async def test_engine_fails_empty_output_runs(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent.engine import EmptyOutputError
    from agent.providers.base import ProviderTurn

    class _NoOutputSession:
        def total_cost_usd(self) -> Optional[float]:
            return None

        async def stream_turn(self, on_event: Any) -> Any:
            # The observed gemini-3.6-flash failure mode: a final turn with
            # no tool calls and no text at all.
            return ProviderTurn(assistant_text="", tool_calls=[])

        async def append_tool_results(self, turn: Any, executed: Any) -> None:
            return None

        async def close(self) -> None:
            return None

    monkeypatch.setattr(
        "agent.engine.create_provider_session", lambda **kwargs: _NoOutputSession()
    )
    recorder = _make_recorder()
    engine = _make_engine(recorder)
    with pytest.raises(EmptyOutputError):
        await engine.run(Llm.GPT_5_5_HIGH, [])

    events = _read_events(recorder)
    assert events[-1]["status"] == "failed"
    assert "without producing" in events[-1]["error"]


@pytest.mark.asyncio
async def test_engine_records_failed_run_and_reraises(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "agent.engine.create_provider_session",
        lambda **kwargs: _ExplodingSession(),
    )

    recorder = _make_recorder()
    engine = _make_engine(recorder)
    with pytest.raises(RuntimeError, match="provider exploded"):
        await engine.run(Llm.GPT_5_5_HIGH, [])

    events = _read_events(recorder)
    assert events[-1]["type"] == "run_end"
    assert events[-1]["status"] == "failed"
    assert "provider exploded" in events[-1]["error"]

    row = _db_row(
        "SELECT status, error FROM runs WHERE run_id = ?", (recorder.run_id,)
    )
    assert row is not None
    assert row[0] == "failed"
    assert "provider exploded" in row[1]


async def _record_minimal_run(**overrides: Any) -> AgentRunRecorder:
    recorder = _make_recorder(**overrides)
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [{"role": "user", "content": "go"}])
    recorder.record_llm_request("openai", "gpt-5.5", {"input": ["go"]})
    recorder.record_llm_response(
        "done", [], TokenUsage(input=100, output=50, total=150)
    )
    await recorder.record_run_end("completed", final_html="<html>out</html>")
    return recorder


@pytest.mark.asyncio
async def test_list_and_detail_routes(logs_path: Path) -> None:
    from routes.agent_runs import get_agent_run, list_agent_runs

    recorder_a = await _record_minimal_run(variant_index=0)
    recorder_b = await _record_minimal_run(
        variant_index=1, generation_id="gen_test_11111111"
    )

    listing = await list_agent_runs()
    assert {r.run_id for r in listing.runs} == {recorder_a.run_id, recorder_b.run_id}
    assert listing.total_size_bytes > 0
    by_id = {r.run_id: r for r in listing.runs}
    assert by_id[recorder_a.run_id].generation_id == "gen_test_00000000"
    assert by_id[recorder_a.run_id].status == "completed"
    assert by_id[recorder_a.run_id].num_llm_calls == 1
    assert by_id[recorder_a.run_id].total_cost_usd is not None

    detail = await get_agent_run(recorder_a.run_id)
    types = [e["type"] for e in detail.events]
    assert "run_start" in types and "llm_call_end" in types and "run_end" in types
    assert "stream_delta" not in types

    recorder_c = _make_recorder()
    recorder_c.record_run_start(Llm.GPT_5_5_HIGH, [])
    recorder_c.record_llm_request("openai", "gpt-5.5", {})
    recorder_c.record_stream_event(
        StreamEvent(type="assistant_delta", text="hi"), "a-1"
    )
    recorder_c.record_llm_response("hi", [], None)
    await recorder_c.record_run_end("completed")
    detail_with_deltas = await get_agent_run(
        recorder_c.run_id, include_stream_deltas=True
    )
    assert "stream_delta" in [e["type"] for e in detail_with_deltas.events]


@pytest.mark.asyncio
async def test_detail_route_rejects_bad_ids(logs_path: Path) -> None:
    from fastapi import HTTPException

    from routes.agent_runs import get_agent_run, list_agent_runs

    listing = await list_agent_runs()
    assert listing.runs == []

    with pytest.raises(HTTPException) as excinfo:
        await get_agent_run("../secrets")
    assert excinfo.value.status_code == 400

    await _record_minimal_run()
    with pytest.raises(HTTPException) as excinfo:
        await get_agent_run("run_20260101_000000_deadbeef")
    assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_output_and_asset_routes(logs_path: Path) -> None:
    from fastapi import HTTPException

    from routes.agent_runs import get_agent_run_asset, get_agent_run_output

    recorder = await _record_minimal_run()
    (Path(recorder.run_dir) / "assets").mkdir(exist_ok=True)
    (Path(recorder.run_dir) / "assets" / "pic.png").write_bytes(b"img")

    response = await get_agent_run_output(recorder.run_id)
    assert bytes(response.body).decode() == "<html>out</html>"

    asset_response = await get_agent_run_asset(recorder.run_id, "pic.png")
    assert asset_response.path == str(Path(recorder.run_dir) / "assets" / "pic.png")

    with pytest.raises(HTTPException) as excinfo:
        await get_agent_run_asset(recorder.run_id, "nope.png")
    assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_prune_removes_old_runs_and_keeps_index(logs_path: Path) -> None:
    import os

    from routes.agent_runs import (
        PruneAgentRunsRequest,
        list_agent_runs,
        prune_agent_runs,
    )

    old_recorder = await _record_minimal_run()
    fresh_recorder = await _record_minimal_run(generation_id="gen_test_22222222")

    ninety_days_ago = 90 * 24 * 3600
    old_time = __import__("time").time() - ninety_days_ago
    os.utime(old_recorder.run_dir, (old_time, old_time))

    result = await prune_agent_runs(PruneAgentRunsRequest(max_age_days=7))
    assert result.deleted_count == 1
    assert result.freed_bytes > 0
    assert not Path(old_recorder.run_dir).exists()
    assert Path(fresh_recorder.run_dir).exists()
    assert Path(get_agent_runs_db_path()).exists()

    listing = await list_agent_runs()
    assert [r.run_id for r in listing.runs] == [fresh_recorder.run_id]

    # Orphan rows (directory removed out-of-band) get cleaned up too.
    import shutil as _shutil

    _shutil.rmtree(fresh_recorder.run_dir)
    await prune_agent_runs(PruneAgentRunsRequest(max_age_days=7))
    listing = await list_agent_runs()
    assert listing.runs == []


@pytest.mark.asyncio
async def test_prompt_reports_prune_skips_agent_runs(logs_path: Path) -> None:
    import os

    from routes.prompt_reports import (
        PrunePromptReportsRequest,
        prune_prompt_reports,
    )

    recorder = await _record_minimal_run()

    ninety_days_ago = 90 * 24 * 3600
    old_time = __import__("time").time() - ninety_days_ago
    agent_runs_dir = Path(get_agent_runs_directory())
    os.utime(agent_runs_dir, (old_time, old_time))
    os.utime(recorder.run_dir, (old_time, old_time))

    result = await prune_prompt_reports(PrunePromptReportsRequest(max_age_days=7))
    assert result.deleted_count == 0
    assert Path(recorder.run_dir).exists()
    assert Path(get_agent_runs_db_path()).exists()


@pytest.mark.asyncio
async def test_tool_replicate_outputs_saved_when_logging(
    logs_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FakeResponse:
        content = b"replicate-image-bytes"
        headers = {"content-type": "image/png"}

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def get(self, url: str) -> FakeResponse:
            if "broken" in url:
                raise RuntimeError("download failed")
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    tool_call = ToolCall(id="call_img", name="generate_images", arguments={})
    recorder.record_tool_start("call_img", tool_call)
    recorder.record_tool_end(
        "call_img",
        tool_call,
        ToolExecutionResult(
            ok=True,
            result={
                "images": {
                    "a prompt": "https://replicate.delivery/xyz/one.png",
                    "another": "https://replicate.delivery/broken/two.png",
                }
            },
            summary={},
        ),
    )
    await recorder.record_run_end("completed")

    run_dir = Path(recorder.run_dir)
    saved = list((run_dir / "tool_assets").glob("*.png"))
    assert len(saved) == 1
    assert saved[0].read_bytes() == b"replicate-image-bytes"

    run_json = json.loads((run_dir / "run.json").read_text())
    statuses = {e["url"]: e["status"] for e in run_json["tool_assets"]}
    assert statuses["https://replicate.delivery/xyz/one.png"] == "saved"
    assert statuses["https://replicate.delivery/broken/two.png"] == "failed"


@pytest.mark.asyncio
async def test_tool_asset_downloads_disabled_without_logging(
    logs_path: Path,
) -> None:
    recorder = _make_recorder(enabled=False)
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    tool_call = ToolCall(id="call_img", name="generate_images", arguments={})
    recorder.record_tool_end(
        "call_img",
        tool_call,
        ToolExecutionResult(
            ok=True,
            result={"images": {"p": "https://replicate.delivery/xyz/one.png"}},
            summary={},
        ),
    )
    await recorder.record_run_end("completed")
    assert not (logs_path / "run_logs").exists()


def test_tool_asset_scheduling_without_event_loop_is_safe(
    logs_path: Path,
) -> None:
    # Sync context (no running loop): scheduling must skip, not raise.
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    tool_call = ToolCall(id="call_img", name="generate_images", arguments={})
    recorder.record_tool_end(
        "call_img",
        tool_call,
        ToolExecutionResult(
            ok=True,
            result={"images": {"p": "https://replicate.delivery/xyz/one.png"}},
            summary={},
        ),
    )


def test_recorder_survives_internal_errors(logs_path: Path) -> None:
    recorder = _make_recorder()
    recorder.record_run_start(Llm.GPT_5_5_HIGH, [])
    # Unserializable-ish payloads and bad state must not raise.
    recorder.record_llm_request("openai", "gpt-5.5", {"obj": object()})
    recorder.record_llm_response("x", [], TokenUsage())


def test_agent_runs_directory_under_logs_path(logs_path: Path) -> None:
    assert get_agent_runs_directory() == str(logs_path / "run_logs" / "agent_runs")
