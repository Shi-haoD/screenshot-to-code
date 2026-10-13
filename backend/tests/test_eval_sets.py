import hashlib
import json
import os
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

import evals.config
from evals.sets import (
    EvalSetNotFoundError,
    InvalidSetNameError,
    get_set,
    get_set_inputs_dir,
    list_set_images,
    list_sets,
    resolve_set_image_path,
)
from routes.eval_sets import get_eval_set_image


@pytest.fixture
def evals_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(evals.config, "EVALS_DIR", str(tmp_path))
    return tmp_path


def _make_set(evals_dir: Path, name: str, images: dict[str, bytes]) -> Path:
    inputs = evals_dir / "sets" / name / "inputs"
    inputs.mkdir(parents=True)
    for filename, content in images.items():
        (inputs / filename).write_bytes(content)
    return inputs


def test_list_set_images_bootstraps_manifest_with_hashes(evals_dir: Path) -> None:
    _make_set(evals_dir, "jun-21-evals", {"a.png": b"aaa", "b.png": b"bbb"})

    images = list_set_images("jun-21-evals")
    assert [i.filename for i in images] == ["a.png", "b.png"]
    assert images[0].sha256 == hashlib.sha256(b"aaa").hexdigest()

    manifest_path = evals_dir / "sets" / "jun-21-evals" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["display_name"] == "jun-21-evals"
    assert manifest["images"]["b.png"]["sha256"] == (
        hashlib.sha256(b"bbb").hexdigest()
    )


def test_hash_cache_reused_and_invalidated(evals_dir: Path) -> None:
    inputs = _make_set(evals_dir, "s1", {"a.png": b"original"})
    list_set_images("s1")

    # Tamper with the cached sha; with unchanged size+mtime it must be
    # served from cache (i.e. NOT recomputed).
    manifest_path = evals_dir / "sets" / "s1" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["images"]["a.png"]["sha256"] = "cached-sentinel"
    manifest_path.write_text(json.dumps(manifest))
    assert list_set_images("s1")[0].sha256 == "cached-sentinel"

    # Rewriting the file (new mtime) invalidates the cache entry.
    image_path = inputs / "a.png"
    image_path.write_bytes(b"rewritten")
    os.utime(image_path, (time.time() + 5, time.time() + 5))
    images = list_set_images("s1")
    assert images[0].sha256 == hashlib.sha256(b"rewritten").hexdigest()
    manifest = json.loads(manifest_path.read_text())
    assert manifest["images"]["a.png"]["sha256"] == images[0].sha256


def test_deleted_files_pruned_from_manifest(evals_dir: Path) -> None:
    inputs = _make_set(evals_dir, "s1", {"a.png": b"a", "b.png": b"b"})
    list_set_images("s1")
    (inputs / "b.png").unlink()

    images = list_set_images("s1")
    assert [i.filename for i in images] == ["a.png"]
    manifest = json.loads(
        (evals_dir / "sets" / "s1" / "manifest.json").read_text()
    )
    assert "b.png" not in manifest["images"]


def test_list_sets_and_get_set(evals_dir: Path) -> None:
    _make_set(evals_dir, "alpha", {"a.png": b"a"})
    _make_set(evals_dir, "beta", {"b.png": b"b", "c.png": b"c"})

    sets = list_sets()
    assert [(s.name, s.image_count) for s in sets] == [("alpha", 1), ("beta", 2)]
    assert get_set("beta").image_count == 2
    with pytest.raises(EvalSetNotFoundError):
        get_set("missing")


def test_set_name_validation(evals_dir: Path) -> None:
    for bad_name in ("../etc", "/abs", "", ".hidden"):
        with pytest.raises(InvalidSetNameError):
            get_set_inputs_dir(bad_name)


def _make_text_set(evals_dir: Path, name: str) -> None:
    set_dir = evals_dir / "sets" / name
    set_dir.mkdir(parents=True)
    (set_dir / "briefs.json").write_text(
        json.dumps(
            {
                "display_name": "Briefs",
                "briefs": [
                    {
                        "id": "pdp",
                        "title": "PDP",
                        "brief": "Build a product page.",
                        "tests": "hierarchy",
                    },
                    {"id": "board", "brief": "Build a kanban board."},
                ],
            }
        )
    )


def test_text_set_kind_and_briefs(evals_dir: Path) -> None:
    from evals.sets import get_set_kind, list_set_briefs

    _make_text_set(evals_dir, "briefs-v1")
    _make_set(evals_dir, "imgs", {"a.png": b"a"})

    assert get_set_kind("briefs-v1") == "text"
    assert get_set_kind("imgs") == "image"

    briefs = list_set_briefs("briefs-v1")
    assert [(b.id, b.title) for b in briefs] == [("pdp", "PDP"), ("board", "board")]

    info = get_set("briefs-v1")
    assert info.kind == "text"
    assert info.image_count == 2

    sets = list_sets()
    assert {(s.name, s.kind) for s in sets} == {
        ("briefs-v1", "text"),
        ("imgs", "image"),
    }


def test_text_set_invalid_brief_id_rejected(evals_dir: Path) -> None:
    from evals.sets import list_set_briefs

    set_dir = evals_dir / "sets" / "bad"
    set_dir.mkdir(parents=True)
    (set_dir / "briefs.json").write_text(
        json.dumps({"briefs": [{"id": "../evil", "brief": "x"}]})
    )
    with pytest.raises(InvalidSetNameError):
        list_set_briefs("bad")


@pytest.mark.asyncio
async def test_text_set_runner_flow(
    evals_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from evals.runner import count_pending_eval_tasks, run_image_evals

    _make_text_set(evals_dir, "briefs-v1")

    captured: list[dict[str, object]] = []

    async def fake_text_gen(**kwargs: object) -> str:
        captured.append(kwargs)
        return "<html>text output</html>"

    monkeypatch.setattr("evals.runner.generate_code_for_text", fake_text_gen)

    pending, skipped = count_pending_eval_tasks(
        stack="html_tailwind",
        model="gpt-5.5 (high thinking)",
        diff_mode=True,
        eval_set="briefs-v1",
        skip_input_files={"pdp"},
    )
    assert (pending, skipped) == (1, 1)

    outputs = await run_image_evals(
        stack="html_tailwind",
        model="gpt-5.5 (high thinking)",
        eval_set="briefs-v1",
        eval_session_id="sess_x",
        diff_mode=True,
        skip_input_files={"pdp"},
    )
    assert outputs == ["board_0.html"]
    assert len(captured) == 1
    assert captured[0]["text_prompt"] == "Build a kanban board."
    assert captured[0]["input_file"] == "board"
    assert captured[0]["eval_session_id"] == "sess_x"


@pytest.mark.asyncio
async def test_image_path_resolution_and_route_guards(evals_dir: Path) -> None:
    _make_set(evals_dir, "s1", {"a.png": b"png-bytes"})

    assert resolve_set_image_path("s1", "a.png").endswith("a.png")
    # Traversal components are stripped to a basename.
    assert resolve_set_image_path("s1", "../a.png").endswith("a.png")
    with pytest.raises(InvalidSetNameError):
        resolve_set_image_path("s1", "notes.txt")
    with pytest.raises(FileNotFoundError):
        resolve_set_image_path("s1", "missing.png")

    response = await get_eval_set_image("s1", "a.png")
    assert response.path == str(evals_dir / "sets" / "s1" / "inputs" / "a.png")
    with pytest.raises(HTTPException) as excinfo:
        await get_eval_set_image("s1", "missing.png")
    assert excinfo.value.status_code == 404
    with pytest.raises(HTTPException) as excinfo:
        await get_eval_set_image("nope", "a.png")
    assert excinfo.value.status_code == 404
