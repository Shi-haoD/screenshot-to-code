"""Named eval sets: folders of input images under ``{EVALS_DIR}/sets``.

A set is created by dropping PNGs into ``sets/{name}/inputs/`` — there is no
creation API. ``manifest.json`` (bootstrapped on first listing) carries the
display name, notes, and a per-image sha256 cache keyed by (size, mtime) so
content hashes are computed once. The sha256 of an image's bytes is how UI
generations are matched to matrix rows.
"""

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional, cast

import evals.config as evals_config

# Blocks path traversal while allowing human-friendly names like
# "jun-21-evals" or "Landing Pages v2".
_SET_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]*$")


class InvalidSetNameError(Exception):
    pass


class EvalSetNotFoundError(Exception):
    pass


@dataclass
class EvalSetImage:
    filename: str
    sha256: str
    size_bytes: int
    mtime: float
    tags: list[str]


@dataclass
class EvalSetBrief:
    """One text-eval item: the id plays the role a filename plays for images."""

    id: str
    title: str
    brief: str
    tests: str


@dataclass
class EvalSetInfo:
    name: str
    display_name: str
    created_at: Optional[str]
    notes: str
    image_count: int
    kind: str = "image"  # "image" | "text"


def get_sets_dir() -> str:
    return os.path.join(evals_config.EVALS_DIR, "sets")


def _validate_set_name(set_name: str) -> str:
    if not _SET_NAME_PATTERN.match(set_name):
        raise InvalidSetNameError(f"Invalid eval set name: {set_name!r}")
    return set_name


def _get_set_dir(set_name: str) -> str:
    return os.path.join(get_sets_dir(), _validate_set_name(set_name))


def get_set_inputs_dir(set_name: str) -> str:
    return os.path.join(_get_set_dir(set_name), "inputs")


def _manifest_path(set_name: str) -> str:
    return os.path.join(_get_set_dir(set_name), "manifest.json")


def _briefs_path(set_name: str) -> str:
    return os.path.join(_get_set_dir(set_name), "briefs.json")


_BRIEF_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def get_set_kind(set_name: str) -> str:
    """"text" when the set is a briefs.json collection, else "image"."""
    if os.path.isfile(_briefs_path(set_name)):
        return "text"
    return "image"


def list_set_briefs(set_name: str) -> list[EvalSetBrief]:
    path = _briefs_path(set_name)
    if not os.path.isfile(path):
        raise EvalSetNotFoundError(f"Text eval set not found: {set_name}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            loaded = cast(dict[str, Any], json.load(f))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvalSetNotFoundError(f"Unreadable briefs.json for {set_name}: {exc}")
    briefs: list[EvalSetBrief] = []
    raw_briefs = loaded.get("briefs")
    entries = (
        cast(list[object], raw_briefs) if isinstance(raw_briefs, list) else []
    )
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        record = cast(dict[str, Any], entry)
        brief_id = str(record.get("id") or "")
        brief = str(record.get("brief") or "")
        if not _BRIEF_ID_PATTERN.match(brief_id) or not brief:
            raise InvalidSetNameError(
                f"Invalid brief entry in {set_name}: id={brief_id!r}"
            )
        briefs.append(
            EvalSetBrief(
                id=brief_id,
                title=str(record.get("title") or brief_id),
                brief=brief,
                tests=str(record.get("tests") or ""),
            )
        )
    return briefs


def _load_manifest(set_name: str) -> dict[str, Any]:
    try:
        with open(_manifest_path(set_name), "r", encoding="utf-8") as f:
            loaded = cast(Any, json.load(f))
            if isinstance(loaded, dict):
                return cast(dict[str, Any], loaded)
            return {}
    except (OSError, json.JSONDecodeError):
        return {}


def _tags_of(entry: Optional[dict[str, Any]]) -> list[str]:
    if not entry:
        return []
    raw = entry.get("tags")
    if not isinstance(raw, list):
        return []
    return [tag for tag in cast(list[object], raw) if isinstance(tag, str)]


def _save_manifest(set_name: str, manifest: dict[str, Any]) -> None:
    try:
        with open(_manifest_path(set_name), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
    except OSError as exc:
        # The manifest is a cache/metadata sidecar; failing to persist it
        # must not fail set operations.
        print(f"[EVAL SETS] Failed to write manifest for {set_name}: {exc}")


def _sha256_of_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def list_set_images(set_name: str) -> list[EvalSetImage]:
    """PNGs of the set, hashes served from the manifest cache when fresh."""
    inputs_dir = get_set_inputs_dir(set_name)
    if not os.path.isdir(inputs_dir):
        raise EvalSetNotFoundError(f"Eval set not found: {set_name}")

    manifest = _load_manifest(set_name)
    raw_images = manifest.get("images")
    cached_images: dict[str, Any] = (
        cast(dict[str, Any], raw_images) if isinstance(raw_images, dict) else {}
    )
    manifest_changed = not manifest

    filenames = sorted(
        entry
        for entry in os.listdir(inputs_dir)
        if entry.lower().endswith(".png")
        and os.path.isfile(os.path.join(inputs_dir, entry))
    )

    images: list[EvalSetImage] = []
    fresh_entries: dict[str, Any] = {}
    for filename in filenames:
        path = os.path.join(inputs_dir, filename)
        stat = os.stat(path)
        raw_cached = cached_images.get(filename)
        cached: Optional[dict[str, Any]] = (
            cast(dict[str, Any], raw_cached)
            if isinstance(raw_cached, dict)
            else None
        )
        tags = _tags_of(cached)
        if (
            cached is not None
            and cached.get("size") == stat.st_size
            and cached.get("mtime") == stat.st_mtime
            and isinstance(cached.get("sha256"), str)
        ):
            sha256 = str(cached["sha256"])
        else:
            sha256 = _sha256_of_file(path)
            manifest_changed = True
        fresh_entries[filename] = {
            "sha256": sha256,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "tags": tags,
        }
        images.append(
            EvalSetImage(
                filename=filename,
                sha256=sha256,
                size_bytes=stat.st_size,
                mtime=stat.st_mtime,
                tags=tags,
            )
        )

    if set(fresh_entries) != set(cached_images):
        manifest_changed = True
    if manifest_changed:
        manifest.setdefault("display_name", set_name)
        manifest.setdefault(
            "created_at", datetime.now().isoformat(timespec="seconds")
        )
        manifest.setdefault("notes", "")
        manifest["images"] = fresh_entries
        _save_manifest(set_name, manifest)

    return images


def get_set(set_name: str) -> EvalSetInfo:
    if get_set_kind(set_name) == "text":
        briefs = list_set_briefs(set_name)
        with open(_briefs_path(set_name), "r", encoding="utf-8") as f:
            meta = cast(dict[str, Any], json.load(f))
        return EvalSetInfo(
            name=set_name,
            display_name=str(meta.get("display_name") or set_name),
            created_at=(
                str(meta["created_at"]) if meta.get("created_at") else None
            ),
            notes=str(meta.get("notes") or ""),
            image_count=len(briefs),
            kind="text",
        )
    images = list_set_images(set_name)
    manifest = _load_manifest(set_name)
    return EvalSetInfo(
        name=set_name,
        display_name=str(manifest.get("display_name") or set_name),
        created_at=(
            str(manifest["created_at"]) if manifest.get("created_at") else None
        ),
        notes=str(manifest.get("notes") or ""),
        image_count=len(images),
        kind="image",
    )


def list_sets() -> list[EvalSetInfo]:
    sets_dir = get_sets_dir()
    if not os.path.isdir(sets_dir):
        return []
    infos: list[EvalSetInfo] = []
    for entry in sorted(os.listdir(sets_dir)):
        if not _SET_NAME_PATTERN.match(entry):
            continue
        set_dir = os.path.join(sets_dir, entry)
        if not (
            os.path.isdir(os.path.join(set_dir, "inputs"))
            or os.path.isfile(os.path.join(set_dir, "briefs.json"))
        ):
            continue
        infos.append(get_set(entry))
    return infos


def resolve_set_image_path(set_name: str, filename: str) -> str:
    """Absolute path of a set image; raises on traversal or missing file."""
    inputs_dir = get_set_inputs_dir(set_name)
    if not os.path.isdir(inputs_dir):
        raise EvalSetNotFoundError(f"Eval set not found: {set_name}")
    safe_name = os.path.basename(filename)
    if not safe_name.lower().endswith(".png"):
        raise InvalidSetNameError(f"Not a set image: {filename!r}")
    path = os.path.realpath(os.path.join(inputs_dir, safe_name))
    if not path.startswith(os.path.realpath(inputs_dir) + os.sep):
        raise InvalidSetNameError(f"Invalid image path: {filename!r}")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    return path
