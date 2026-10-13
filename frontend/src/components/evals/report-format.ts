const PROVIDER_BADGE_CLASSES: Record<string, string> = {
  openai: "bg-emerald-900/60 text-emerald-200 border-emerald-700",
  anthropic: "bg-orange-900/60 text-orange-200 border-orange-700",
  gemini: "bg-sky-900/60 text-sky-200 border-sky-700",
};

export function providerBadgeClass(provider: string): string {
  return (
    PROVIDER_BADGE_CLASSES[provider] ||
    "bg-zinc-800 text-zinc-200 border-zinc-600"
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (isNaN(date.getTime())) return isoTimestamp;
  return date.toLocaleString();
}

export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return "—";
  // Round to cents; flag sub-cent totals so a real cost never reads as $0.00.
  if (costUsd > 0 && costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

// formatDurationMs (generation-time.ts) floors at 1s; run timelines need
// millisecond precision for fast tool calls.
export function formatMs(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
