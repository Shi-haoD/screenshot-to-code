import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import { BsBoxArrowUpRight, BsGripVertical } from "react-icons/bs";

import { HTTP_BACKEND_URL } from "../../config";
import EvalNavigation from "./EvalNavigation";
import { formatCost, formatMs, formatTimestamp } from "./report-format";

interface EvalSetSummary {
  name: string;
  display_name: string;
  created_at: string | null;
  notes: string;
  image_count: number;
}

interface EvalSession {
  session_id: string;
  name: string;
  eval_set: string;
  created_at: string;
  is_active: boolean;
}

interface MatrixRun {
  run_id: string;
  status: string;
  source: "eval" | "ui";
  total_duration_ms: number | null;
  total_cost_usd: number | null;
  created_at: string;
  is_stale: boolean;
}

interface MatrixCell {
  filename: string;
  model: string;
  runs: MatrixRun[];
}

interface MatrixRow {
  filename: string;
  sha256: string | null;
  image_url: string | null;
  title: string | null;
  brief: string | null;
}

interface SessionMatrix {
  session: EvalSession;
  eval_set: EvalSetSummary | null;
  set_missing: boolean;
  rows: MatrixRow[];
  models: string[];
  model_notes: Record<string, string>;
  cells: MatrixCell[];
  unmatched_run_count: number;
}

function statusDotClass(status: string, isStale: boolean): string {
  if (status === "completed") return "bg-emerald-400";
  if (status === "failed") return "bg-red-400";
  return isStale ? "bg-zinc-500" : "bg-amber-400 animate-pulse";
}

function CellFace({
  runs,
  onOpenRun,
}: {
  runs: MatrixRun[];
  onOpenRun: (runId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const newest = runs[0];
  if (!newest) return null;

  return (
    <div className="flex flex-col gap-1">
      <div
        onClick={() => onOpenRun(newest.run_id)}
        className={`group flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1 transition-colors hover:bg-zinc-800 ${
          newest.status === "failed"
            ? "border-red-900 bg-red-950/30"
            : "border-zinc-700 bg-zinc-950/60"
        } ${newest.is_stale ? "opacity-50" : ""}`}
        title={`${newest.status} · ${formatTimestamp(newest.created_at)}`}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(
            newest.status,
            newest.is_stale
          )}`}
        />
        <span className="font-mono text-[11px] text-zinc-300">
          {formatMs(newest.total_duration_ms)}
        </span>
        <span className="font-mono text-[11px] text-emerald-400">
          {formatCost(newest.total_cost_usd)}
        </span>
        {newest.source === "ui" && (
          <span className="rounded bg-amber-900/60 px-1 text-[10px] font-medium text-amber-200">
            UI
          </span>
        )}
        {runs.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400 hover:text-zinc-100"
            title="Show all attempts"
          >
            ×{runs.length}
          </button>
        )}
        <a
          href={`${HTTP_BACKEND_URL}/agent-runs/${encodeURIComponent(
            newest.run_id
          )}/output`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open captured HTML"
          className="ml-auto shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-200 group-hover:opacity-100"
        >
          <BsBoxArrowUpRight className="text-[10px]" />
        </a>
      </div>
      {expanded &&
        runs.slice(1).map((run) => (
          <div
            key={run.run_id}
            onClick={() => onOpenRun(run.run_id)}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-800 px-1.5 py-0.5 opacity-70 hover:bg-zinc-800"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(
                run.status,
                run.is_stale
              )}`}
            />
            <span className="font-mono text-[10px] text-zinc-400">
              {formatMs(run.total_duration_ms)} ·{" "}
              {formatCost(run.total_cost_usd)}
              {run.source === "ui" ? " · UI" : ""}
            </span>
          </div>
        ))}
    </div>
  );
}

function EvalSessionsPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<EvalSession[]>([]);
  const [sets, setSets] = useState<EvalSetSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [matrix, setMatrix] = useState<SessionMatrix | null>(null);
  const [isLoadingMatrix, setIsLoadingMatrix] = useState(false);
  const [newSessionSet, setNewSessionSet] = useState("");
  const [newSessionName, setNewSessionName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [editingNotesModel, setEditingNotesModel] = useState<string | null>(
    null
  );
  const [notesDraft, setNotesDraft] = useState("");
  const [dragModel, setDragModel] = useState<string | null>(null);
  const [dragOverModel, setDragOverModel] = useState<string | null>(null);

  const cellsByKey = useMemo(() => {
    const map = new Map<string, MatrixCell>();
    for (const cell of matrix?.cells ?? []) {
      map.set(`${cell.filename}|${cell.model}`, cell);
    }
    return map;
  }, [matrix]);

  // Images with outputs float to the top: most models covered first, then
  // most total runs, then filename for a stable order.
  const sortedRows = useMemo(() => {
    if (!matrix) return [];
    const coverage = new Map<string, { models: number; runs: number }>();
    for (const cell of matrix.cells) {
      const entry = coverage.get(cell.filename) ?? { models: 0, runs: 0 };
      if (cell.runs.length > 0) entry.models += 1;
      entry.runs += cell.runs.length;
      coverage.set(cell.filename, entry);
    }
    return [...matrix.rows].sort((a, b) => {
      const ca = coverage.get(a.filename) ?? { models: 0, runs: 0 };
      const cb = coverage.get(b.filename) ?? { models: 0, runs: 0 };
      if (cb.models !== ca.models) return cb.models - ca.models;
      if (cb.runs !== ca.runs) return cb.runs - ca.runs;
      return a.filename.localeCompare(b.filename);
    });
  }, [matrix]);

  const fetchSessions = useCallback(async (): Promise<EvalSession[]> => {
    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/eval-sessions`);
      const data = await response.json();
      setSessions(data.sessions);
      setConnectionFailed(false);
      return data.sessions;
    } catch (error) {
      // Dev backends restart (--reload) and briefly refuse connections;
      // flag it and let the retry effect re-attempt instead of settling
      // into a misleading empty state.
      console.error("Error fetching sessions", error);
      setConnectionFailed(true);
      return [];
    }
  }, []);

  const fetchSets = useCallback(async () => {
    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/eval-sets`);
      const data: EvalSetSummary[] = await response.json();
      setSets(data);
      setConnectionFailed(false);
      if (data.length > 0) {
        setNewSessionSet((current) => current || data[0].name);
      }
    } catch (error) {
      console.error("Error fetching eval sets", error);
      setConnectionFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!connectionFailed) return;
    const timer = window.setTimeout(() => {
      setRetryTick((n) => n + 1);
      fetchSets();
      fetchSessions().then((loaded) => {
        if (loaded.length > 0 && !selectedSessionId) {
          const active = loaded.find((s) => s.is_active) ?? loaded[0];
          loadMatrix(active.session_id);
        }
      });
    }, 2500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionFailed, retryTick]);

  const loadMatrix = useCallback(async (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setIsLoadingMatrix(true);
    try {
      const response = await fetch(
        `${HTTP_BACKEND_URL}/eval-sessions/${encodeURIComponent(
          sessionId
        )}/matrix`
      );
      if (!response.ok) throw new Error("Request failed");
      setMatrix(await response.json());
    } catch (error) {
      console.error("Error loading matrix", error);
      setMatrix(null);
      toast.error("Failed to load session matrix.");
    } finally {
      setIsLoadingMatrix(false);
    }
  }, []);

  useEffect(() => {
    fetchSets();
    fetchSessions().then((loaded) => {
      const active = loaded.find((s) => s.is_active) ?? loaded[0];
      if (active) loadMatrix(active.session_id);
    });
  }, [fetchSets, fetchSessions, loadMatrix]);

  // Live refresh while any cell is actively running.
  useEffect(() => {
    if (!matrix || !selectedSessionId) return;
    const hasLiveRuns = matrix.cells.some((cell) =>
      cell.runs.some((run) => run.status === "running" && !run.is_stale)
    );
    if (!hasLiveRuns) return;
    const interval = window.setInterval(
      () => loadMatrix(selectedSessionId),
      10_000
    );
    return () => window.clearInterval(interval);
  }, [matrix, selectedSessionId, loadMatrix]);

  const handleActivate = async (sessionId: string) => {
    try {
      const response = await fetch(
        `${HTTP_BACKEND_URL}/eval-sessions/${encodeURIComponent(
          sessionId
        )}/activate`,
        { method: "POST" }
      );
      if (!response.ok) throw new Error("Request failed");
      toast.success("Session activated.");
      fetchSessions();
    } catch (error) {
      console.error("Error activating session", error);
      toast.error("Failed to activate session.");
    }
  };

  const handleCreate = async () => {
    if (!newSessionSet) return;
    setIsCreating(true);
    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/eval-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eval_set: newSessionSet,
          name: newSessionName.trim() || null,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || "Request failed");
      }
      const created: EvalSession = await response.json();
      setNewSessionName("");
      toast.success(`Session "${created.name}" started.`);
      await fetchSessions();
      loadMatrix(created.session_id);
    } catch (error) {
      console.error("Error creating session", error);
      toast.error(String(error));
    } finally {
      setIsCreating(false);
    }
  };

  const openRun = (runId: string) => {
    navigate(`/evals/agent-runs?run=${encodeURIComponent(runId)}`);
  };

  const saveOrder = async (reordered: string[]) => {
    if (!matrix || !selectedSessionId) return;
    setMatrix({ ...matrix, models: reordered });
    try {
      await fetch(
        `${HTTP_BACKEND_URL}/eval-sessions/${encodeURIComponent(
          selectedSessionId
        )}/model-order`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: reordered }),
        }
      );
    } catch (error) {
      console.error("Error saving model order", error);
      toast.error("Failed to save column order.");
    }
  };

  const handleColumnDrop = (target: string) => {
    if (!matrix || !dragModel || dragModel === target) return;
    const dragIndex = matrix.models.indexOf(dragModel);
    const targetIndex = matrix.models.indexOf(target);
    if (dragIndex < 0 || targetIndex < 0) return;
    const reordered = matrix.models.filter((m) => m !== dragModel);
    // Dragging rightwards drops after the target, leftwards before it.
    const insertAt =
      dragIndex < targetIndex
        ? reordered.indexOf(target) + 1
        : reordered.indexOf(target);
    reordered.splice(insertAt, 0, dragModel);
    void saveOrder(reordered);
  };

  const saveNotes = async (model: string) => {
    if (!matrix || !selectedSessionId) return;
    const notes = notesDraft.trim();
    setEditingNotesModel(null);
    setMatrix({
      ...matrix,
      model_notes: { ...matrix.model_notes, [model]: notes },
    });
    try {
      await fetch(
        `${HTTP_BACKEND_URL}/eval-sessions/${encodeURIComponent(
          selectedSessionId
        )}/model-notes`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, notes }),
        }
      );
    } catch (error) {
      console.error("Error saving model notes", error);
      toast.error("Failed to save notes.");
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-white">
      <div className="shrink-0">
        <EvalNavigation />
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-2 px-4 py-2">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/80 px-4 py-2">
          <h1 className="text-base font-semibold tracking-tight">
            Eval Sessions
          </h1>
          <div className="flex items-center gap-2 text-xs">
            <select
              value={newSessionSet}
              onChange={(e) => setNewSessionSet(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200"
            >
              {sets.length === 0 && <option value="">No sets found</option>}
              {sets.map((set) => (
                <option key={set.name} value={set.name}>
                  {set.display_name} ({set.image_count})
                </option>
              ))}
            </select>
            <input
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              placeholder="Session name (optional)"
              className="w-44 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200 placeholder:text-zinc-600"
            />
            <button
              onClick={handleCreate}
              disabled={isCreating || !newSessionSet}
              className="rounded-md border border-emerald-800 bg-emerald-950/60 px-2.5 py-1 text-emerald-200 transition-colors hover:bg-emerald-900/60 disabled:opacity-50"
            >
              {isCreating ? "Starting…" : "New session"}
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
          <section className="min-h-0 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-2">
            <div className="px-2 py-1 text-xs uppercase tracking-wide text-zinc-500">
              {sessions.length} session{sessions.length === 1 ? "" : "s"}
            </div>
            {connectionFailed && (
              <p className="px-2 py-4 text-sm text-amber-300">
                Backend unreachable — retrying…
              </p>
            )}
            {!connectionFailed && sessions.length === 0 && (
              <p className="px-2 py-4 text-sm text-zinc-400">
                No sessions yet. Pick a set above and start one, or just run
                evals with a set — a session is created automatically.
              </p>
            )}
            {sessions.map((session) => (
              <div
                key={session.session_id}
                onClick={() => loadMatrix(session.session_id)}
                className={`mb-1.5 cursor-pointer rounded-lg border px-2.5 py-2 transition-colors ${
                  session.session_id === selectedSessionId
                    ? "border-blue-600 bg-blue-950/50"
                    : "border-zinc-800 bg-zinc-950/50 hover:bg-zinc-800/60"
                }`}
              >
                <div className="flex items-center gap-2">
                  {session.is_active && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-emerald-400"
                      title="Active session"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-100">
                    {session.name}
                  </span>
                  {!session.is_active && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleActivate(session.session_id);
                      }}
                      className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                    >
                      Activate
                    </button>
                  )}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                  <span className="rounded-full border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                    {session.eval_set}
                  </span>
                  <span>{formatTimestamp(session.created_at)}</span>
                </div>
              </div>
            ))}
          </section>

          <section className="min-h-0 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            {!selectedSessionId && (
              <p className="py-8 text-center text-sm text-zinc-400">
                Select a session to see its matrix.
              </p>
            )}
            {isLoadingMatrix && (
              <p className="py-8 text-center text-sm text-zinc-400">
                Loading matrix…
              </p>
            )}
            {!isLoadingMatrix && matrix && (
              <div className="flex flex-col gap-2">
                {matrix.set_missing && (
                  <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
                    The set "{matrix.session.eval_set}" no longer exists on
                    disk — showing recorded history only.
                  </div>
                )}
                {matrix.unmatched_run_count > 0 && (
                  <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                    {matrix.unmatched_run_count} run
                    {matrix.unmatched_run_count === 1 ? "" : "s"} reference
                    images no longer in the set.
                  </div>
                )}
                {matrix.rows.length === 0 && !matrix.set_missing && (
                  <p className="py-8 text-center text-sm text-zinc-400">
                    This set has no images. Drop PNGs into the set's inputs
                    folder.
                  </p>
                )}
                {matrix.models.length === 0 && matrix.rows.length > 0 && (
                  <p className="py-2 text-center text-xs text-zinc-500">
                    No runs in this session yet — run evals with this set and
                    cells will appear here.
                  </p>
                )}
                {matrix.rows.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full border-separate border-spacing-1">
                      <thead>
                        <tr>
                          <th className="sticky left-0 z-10 bg-zinc-900/95 px-2 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                            Image
                          </th>
                          {matrix.models.map((model) => (
                            <th
                              key={model}
                              onDragOver={(e) => {
                                e.preventDefault();
                                if (dragModel && dragModel !== model) {
                                  setDragOverModel(model);
                                }
                              }}
                              onDragLeave={() =>
                                setDragOverModel((current) =>
                                  current === model ? null : current
                                )
                              }
                              onDrop={(e) => {
                                e.preventDefault();
                                handleColumnDrop(model);
                                setDragModel(null);
                                setDragOverModel(null);
                              }}
                              className={`group/col min-w-[140px] px-2 py-1 text-left align-top font-mono text-[11px] font-normal text-zinc-400 transition-colors ${
                                dragOverModel === model
                                  ? "rounded-md bg-blue-950/60 ring-1 ring-blue-600"
                                  : ""
                              } ${dragModel === model ? "opacity-40" : ""}`}
                              title={model}
                            >
                              <div
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.effectAllowed = "move";
                                  e.dataTransfer.setData("text/plain", model);
                                  setDragModel(model);
                                }}
                                onDragEnd={() => {
                                  setDragModel(null);
                                  setDragOverModel(null);
                                }}
                                className="flex cursor-grab items-start gap-1 active:cursor-grabbing"
                              >
                                <BsGripVertical className="mt-0.5 shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover/col:opacity-100" />
                                <span className="min-w-0 flex-1">{model}</span>
                              </div>
                              {editingNotesModel === model ? (
                                <input
                                  autoFocus
                                  value={notesDraft}
                                  onChange={(e) =>
                                    setNotesDraft(e.target.value)
                                  }
                                  onBlur={() => void saveNotes(model)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      void saveNotes(model);
                                    } else if (e.key === "Escape") {
                                      setEditingNotesModel(null);
                                    }
                                  }}
                                  placeholder="Notes for this model…"
                                  className="mt-1 w-full rounded border border-zinc-600 bg-zinc-950 px-1.5 py-0.5 font-sans text-[11px] text-zinc-200 placeholder:text-zinc-600"
                                />
                              ) : (
                                <button
                                  onClick={() => {
                                    setEditingNotesModel(model);
                                    setNotesDraft(
                                      matrix.model_notes[model] ?? ""
                                    );
                                  }}
                                  title="Click to edit notes"
                                  className={`mt-1 block w-full truncate rounded px-1 py-0.5 text-left font-sans text-[11px] transition-colors hover:bg-zinc-800 ${
                                    matrix.model_notes[model]
                                      ? "text-amber-200/90"
                                      : "text-zinc-600 opacity-0 group-hover/col:opacity-100"
                                  }`}
                                >
                                  {matrix.model_notes[model] || "+ add note"}
                                </button>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedRows.map((row) => (
                          <tr key={row.filename}>
                            <td className="sticky left-0 z-10 bg-zinc-900/95 px-2 py-1">
                              {row.image_url ? (
                                <div className="flex items-center gap-2">
                                  <img
                                    src={`${HTTP_BACKEND_URL}${row.image_url}`}
                                    alt={row.filename}
                                    className="h-12 w-16 rounded border border-zinc-800 bg-zinc-800 object-cover"
                                    loading="lazy"
                                  />
                                  <span className="max-w-[160px] truncate font-mono text-[11px] text-zinc-300">
                                    {row.filename}
                                  </span>
                                  <a
                                    href={`${HTTP_BACKEND_URL}${row.image_url}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    title="Open image in new tab"
                                    className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
                                  >
                                    <BsBoxArrowUpRight className="text-[11px]" />
                                  </a>
                                </div>
                              ) : (
                                <div
                                  className="max-w-[220px]"
                                  title={row.brief ?? row.filename}
                                >
                                  <div className="truncate text-[11px] font-medium text-zinc-200">
                                    {row.title ?? row.filename}
                                  </div>
                                  <div className="line-clamp-2 text-[10px] leading-tight text-zinc-500">
                                    {row.brief}
                                  </div>
                                </div>
                              )}
                            </td>
                            {matrix.models.map((model) => {
                              const cell = cellsByKey.get(
                                `${row.filename}|${model}`
                              );
                              return (
                                <td
                                  key={model}
                                  className="min-w-[140px] px-1 py-1 align-top"
                                >
                                  {cell ? (
                                    <CellFace
                                      runs={cell.runs}
                                      onOpenRun={openRun}
                                    />
                                  ) : (
                                    <div className="rounded-md border border-dashed border-zinc-800 px-1.5 py-1.5 text-center text-[10px] text-zinc-700">
                                      —
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default EvalSessionsPage;
