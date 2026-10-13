import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";

import { HTTP_BACKEND_URL } from "../../config";
import EvalNavigation from "./EvalNavigation";
import {
  formatBytes,
  formatCost,
  formatTimestamp,
  providerBadgeClass,
} from "./report-format";
import { JsonNode } from "./report-json";

interface PromptReportSummary {
  filename: string;
  provider: string;
  model: string;
  created_at: string;
  session_id: string;
  turn: number;
  size_bytes: number;
  cost_usd: number | null;
}

interface PromptReportListResponse {
  reports: PromptReportSummary[];
  total_size_bytes: number;
  reports_directory: string;
}

interface PromptReportUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cache_hit_rate_percent: number;
  cost_usd: number | null;
}

interface PromptReportContent {
  provider: string;
  model: string;
  api_model_name: string;
  session_id: string;
  turn: number;
  created_at: string;
  request: unknown;
  usage: PromptReportUsage | null;
}

interface SessionGroup {
  sessionId: string;
  provider: string;
  model: string;
  createdAt: string;
  sizeBytes: number;
  costUsd: number | null;
  turns: PromptReportSummary[];
}

function groupBySession(reports: PromptReportSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const report of reports) {
    let group = groups.get(report.session_id);
    if (!group) {
      group = {
        sessionId: report.session_id,
        provider: report.provider,
        model: report.model,
        createdAt: report.created_at,
        sizeBytes: 0,
        costUsd: null,
        turns: [],
      };
      groups.set(report.session_id, group);
    }
    group.sizeBytes += report.size_bytes;
    if (typeof report.cost_usd === "number") {
      group.costUsd = (group.costUsd ?? 0) + report.cost_usd;
    }
    if (report.created_at > group.createdAt) {
      group.createdAt = report.created_at;
    }
    group.turns.push(report);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.turns.sort((a, b) => a.turn - b.turn);
  }
  result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return result;
}

function UsagePanel({ usage }: { usage: PromptReportUsage }) {
  const metrics: [string, string][] = [
    ["Input tokens", usage.input_tokens.toLocaleString()],
    ["Output tokens", usage.output_tokens.toLocaleString()],
    ["Cache read", usage.cache_read.toLocaleString()],
    ["Cache write", usage.cache_write.toLocaleString()],
    ["Total tokens", usage.total_tokens.toLocaleString()],
    ["Cache hit rate", `${usage.cache_hit_rate_percent.toFixed(1)}%`],
    [
      "Cost",
      usage.cost_usd === null ? "n/a" : `$${usage.cost_usd.toFixed(4)}`,
    ],
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
      {metrics.map(([metricLabel, metricValue]) => (
        <div
          key={metricLabel}
          className="rounded-lg border border-zinc-800 bg-zinc-950 p-2"
        >
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">
            {metricLabel}
          </div>
          <div className="mt-1 font-mono text-sm text-zinc-100">
            {metricValue}
          </div>
        </div>
      ))}
    </div>
  );
}

function PromptReportsPage() {
  const [reports, setReports] = useState<PromptReportSummary[]>([]);
  const [totalSizeBytes, setTotalSizeBytes] = useState(0);
  const [reportsDirectory, setReportsDirectory] = useState("");
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [content, setContent] = useState<PromptReportContent | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isPruning, setIsPruning] = useState(false);

  const sessionGroups = useMemo(() => groupBySession(reports), [reports]);

  const fetchReports = useCallback(async (): Promise<
    PromptReportSummary[]
  > => {
    setIsLoadingList(true);
    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/prompt-reports`);
      const data: PromptReportListResponse = await response.json();
      setReports(data.reports);
      setTotalSizeBytes(data.total_size_bytes);
      setReportsDirectory(data.reports_directory);
      return data.reports;
    } catch (error) {
      console.error("Error fetching prompt reports", error);
      toast.error("Failed to load prompt reports.");
      return [];
    } finally {
      setIsLoadingList(false);
    }
  }, []);

  const openReport = useCallback(async (filename: string) => {
    setSelectedFilename(filename);
    setShowRawJson(false);
    setIsLoadingContent(true);
    try {
      const response = await fetch(
        `${HTTP_BACKEND_URL}/prompt-reports/content?filename=${encodeURIComponent(
          filename
        )}`
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || "Request failed");
      }
      setContent(await response.json());
    } catch (error) {
      console.error("Error fetching report content", error);
      setContent(null);
      toast.error("Failed to load report.");
    } finally {
      setIsLoadingContent(false);
    }
  }, []);

  useEffect(() => {
    fetchReports().then((loadedReports) => {
      if (loadedReports.length > 0) {
        const groups = groupBySession(loadedReports);
        openReport(groups[0].turns[0].filename);
      }
    });
  }, [fetchReports, openReport]);

  const handlePrune = async () => {
    if (
      !window.confirm(
        "Delete all reports older than 7 days? This also removes legacy run_logs artifacts."
      )
    ) {
      return;
    }

    setIsPruning(true);
    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/prompt-reports/prune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_age_days: 7 }),
      });
      if (!response.ok) throw new Error("Prune request failed");
      const data = await response.json();
      toast.success(
        `Pruned ${data.deleted_count} item${
          data.deleted_count === 1 ? "" : "s"
        }, freed ${formatBytes(data.freed_bytes)}.`,
        { duration: 8000 }
      );
      const refreshed = await fetchReports();
      if (
        selectedFilename &&
        !refreshed.some((report) => report.filename === selectedFilename)
      ) {
        setSelectedFilename(null);
        setContent(null);
      }
    } catch (error) {
      console.error("Error pruning prompt reports", error);
      toast.error("Failed to prune reports.");
    } finally {
      setIsPruning(false);
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-white">
      <div className="shrink-0">
        <EvalNavigation />
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-3 px-4 py-4">
        <div className="shrink-0 rounded-2xl border border-zinc-800 bg-zinc-900/80 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">
                Prompt Reports
              </h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-300">
                Every LLM request is captured as a JSON report when{" "}
                <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-100">
                  PROMPT_REPORTS_ENABLED=1
                </code>{" "}
                is set.{" "}
                {reportsDirectory && (
                  <span className="font-mono text-xs text-zinc-500">
                    {reportsDirectory}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-right">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Total size on disk
                </div>
                <div className="font-mono text-lg text-zinc-100">
                  {formatBytes(totalSizeBytes)}
                </div>
              </div>
              <button
                onClick={handlePrune}
                disabled={isPruning}
                className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200 transition-colors hover:bg-red-900/60 disabled:opacity-50"
              >
                {isPruning ? "Pruning…" : "Prune reports older than 7 days"}
              </button>
            </div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="min-h-0 overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900/60 p-2">
            <div className="px-2 py-1 text-xs uppercase tracking-wide text-zinc-500">
              {isLoadingList
                ? "Loading…"
                : `${sessionGroups.length} request${
                    sessionGroups.length === 1 ? "" : "s"
                  } · ${reports.length} turn${reports.length === 1 ? "" : "s"}`}
            </div>
            {!isLoadingList && reports.length === 0 && (
              <p className="px-2 py-4 text-sm text-zinc-400">
                No reports yet. Start the backend with{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5">
                  PROMPT_REPORTS_ENABLED=1
                </code>{" "}
                and generate some code.
              </p>
            )}
            {sessionGroups.map((group) => (
              <div
                key={group.sessionId}
                className="mb-2 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${providerBadgeClass(
                      group.provider
                    )}`}
                  >
                    {group.provider}
                  </span>
                  <span className="font-mono text-[11px] text-zinc-500">
                    {formatBytes(group.sizeBytes)}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-sm text-zinc-100">
                  {group.model}
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-zinc-500">
                    {formatTimestamp(group.createdAt)}
                  </span>
                  <span
                    className="font-mono font-medium text-emerald-400"
                    title="Total cost across all turns in this request"
                  >
                    {formatCost(group.costUsd)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {group.turns.map((turnReport) => (
                    <button
                      key={turnReport.filename}
                      onClick={() => openReport(turnReport.filename)}
                      className={`rounded-lg border px-2 py-1 text-xs transition-colors ${
                        turnReport.filename === selectedFilename
                          ? "border-blue-600 bg-blue-950/60 text-blue-100"
                          : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                      }`}
                    >
                      turn {turnReport.turn}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section className="min-h-0 overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            {!selectedFilename && (
              <p className="py-8 text-center text-sm text-zinc-400">
                Select a report to inspect the request.
              </p>
            )}
            {selectedFilename && isLoadingContent && (
              <p className="py-8 text-center text-sm text-zinc-400">
                Loading report…
              </p>
            )}
            {selectedFilename && !isLoadingContent && content && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${providerBadgeClass(
                      content.provider
                    )}`}
                  >
                    {content.provider}
                  </span>
                  <span className="font-mono text-sm text-zinc-100">
                    {content.model}
                  </span>
                  <span className="font-mono text-xs text-zinc-500">
                    api: {content.api_model_name} · session{" "}
                    {content.session_id} · turn {content.turn} ·{" "}
                    {formatTimestamp(content.created_at)}
                  </span>
                </div>

                {content.usage ? (
                  <UsagePanel usage={content.usage} />
                ) : (
                  <p className="text-xs italic text-zinc-500">
                    Usage unavailable for this request (turn may not have
                    completed).
                  </p>
                )}

                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-zinc-200">
                      Request structure
                    </h2>
                    <button
                      onClick={() => setShowRawJson(!showRawJson)}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      {showRawJson ? "Show tree" : "Show raw JSON"}
                    </button>
                  </div>
                  {showRawJson ? (
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
                      {JSON.stringify(content.request, null, 2)}
                    </pre>
                  ) : (
                    <JsonNode label="request" value={content.request} depth={0} />
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default PromptReportsPage;
