import { useState } from "react";
import Markdown from "react-markdown";

import { LightboxImage } from "./image-lightbox";

interface MediaInfo {
  src: string;
  kind: "image" | "video";
}

// Pydantic's JSON mode emits URL-safe base64; data: URLs need the standard
// alphabet. Normalize so reports written before the writer fix still render.
function normalizeBase64(data: string): string {
  return data.replace(/-/g, "+").replace(/_/g, "/");
}

// Detects renderable media in a JSON value: either a data URL string or an
// object shaped like {data: <base64>, mime_type|media_type: image/*|video/*}.
function mediaFromValue(value: unknown): MediaInfo | null {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return { src: value, kind: "image" };
    if (value.startsWith("data:video/")) return { src: value, kind: "video" };
    return null;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const mime = record["mime_type"] ?? record["media_type"];
    const data = record["data"];
    if (
      typeof mime === "string" &&
      typeof data === "string" &&
      data.length > 0
    ) {
      if (mime.startsWith("image/") || mime.startsWith("video/")) {
        return {
          src: `data:${mime};base64,${normalizeBase64(data)}`,
          kind: mime.startsWith("image/") ? "image" : "video",
        };
      }
    }
  }

  return null;
}

function MediaPreview({ media }: { media: MediaInfo }) {
  if (media.kind === "video") {
    return (
      <video
        src={media.src}
        controls
        className="my-1 max-h-48 rounded-lg border border-zinc-700"
      />
    );
  }
  return (
    <LightboxImage
      src={media.src}
      alt="embedded media"
      className="my-1 max-h-48 rounded-lg border border-zinc-700 bg-white object-contain"
    />
  );
}

function nodeSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return `array · ${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object" && value !== null) {
    const keyCount = Object.keys(value).length;
    return `object · ${keyCount} key${keyCount === 1 ? "" : "s"}`;
  }
  return typeof value;
}

const LONG_STRING_PREVIEW_CHARS = 280;
const MARKDOWN_MAX_CHARS = 20000;
// Object keys whose string values are prompt/message prose — rendered as
// markdown instead of a raw string.
const PROSE_KEYS = new Set([
  "text",
  "content",
  "system",
  "system_instruction",
  "instructions",
]);

const MARKDOWN_STYLES = [
  "[&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-bold",
  "[&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-bold",
  "[&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_p]:my-1.5",
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:text-[11px] [&_code]:text-amber-100",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-zinc-900 [&_pre]:p-2",
  "[&_a]:text-blue-400 [&_a]:underline",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-400",
].join(" ");

export function MarkdownLeaf({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="min-w-0 flex-1">
      <div className="mt-1 max-h-96 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        {showRaw ? (
          <pre className="whitespace-pre-wrap break-all text-xs text-amber-100">
            {text}
          </pre>
        ) : (
          <div className={`text-xs leading-5 text-zinc-200 ${MARKDOWN_STYLES}`}>
            <Markdown>{text}</Markdown>
          </div>
        )}
      </div>
      <button
        onClick={() => setShowRaw(!showRaw)}
        className="mt-1 text-xs text-blue-400 hover:text-blue-300"
      >
        {showRaw ? "Show rendered" : "Show raw"}
      </button>
    </div>
  );
}

function StringLeaf({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  if (text.length <= LONG_STRING_PREVIEW_CHARS) {
    return (
      <code className="whitespace-pre-wrap break-all rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-amber-100">
        {text}
      </code>
    );
  }

  return (
    <div className="min-w-0">
      <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-xs text-amber-100">
        {expanded ? text : `${text.slice(0, LONG_STRING_PREVIEW_CHARS)}…`}
      </pre>
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-1 text-xs text-blue-400 hover:text-blue-300"
      >
        {expanded
          ? "Collapse"
          : `Show all ${text.length.toLocaleString()} chars`}
      </button>
    </div>
  );
}

function ScalarLeaf({ label, value }: { label: string; value: unknown }) {
  if (typeof value === "string") {
    if (
      PROSE_KEYS.has(label) &&
      value.length > 80 &&
      value.length <= MARKDOWN_MAX_CHARS
    ) {
      return <MarkdownLeaf text={value} />;
    }
    return <StringLeaf text={value} />;
  }
  return (
    <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-teal-300">
      {value === null ? "null" : String(value)}
    </code>
  );
}

// Arrays under these keys hold tool definitions: collapse them by default and
// label each entry with the tool's name so the list scans as a name index.
const TOOL_ARRAY_KEYS = new Set(["tools", "function_declarations"]);

function toolEntryName(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const name = (value as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : null;
}

export function JsonNode({
  label,
  value,
  depth,
  defaultOpen,
}: {
  label: string;
  value: unknown;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 5);
  const media = mediaFromValue(value);
  const isContainer =
    typeof value === "object" && value !== null && !(media && !open);

  if (!isContainer || typeof value !== "object" || value === null) {
    return (
      <div className="flex min-w-0 items-start gap-2 py-0.5">
        <span className="shrink-0 font-mono text-xs text-violet-300">
          {label}:
        </span>
        {media ? (
          <MediaPreview media={media} />
        ) : (
          <ScalarLeaf label={label} value={value} />
        )}
      </div>
    );
  }

  const isToolArray = TOOL_ARRAY_KEYS.has(label) && Array.isArray(value);
  const entries: [string, unknown, boolean][] = Array.isArray(value)
    ? value.map((child, index) => {
        const toolName = isToolArray ? toolEntryName(child) : null;
        return [toolName ?? `[${index}]`, child, toolName !== null];
      })
    : Object.entries(value).map(([key, child]) => [key, child, false]);

  return (
    <div className="min-w-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800/60"
      >
        <span className="w-3 text-xs text-zinc-500">{open ? "▾" : "▸"}</span>
        <span className="font-mono text-xs text-violet-300">{label}</span>
        <span className="font-mono text-xs text-blue-400">
          {nodeSummary(value)}
        </span>
      </button>
      {open && (
        <div className="ml-2 border-l border-zinc-800 pl-4">
          {media && <MediaPreview media={media} />}
          {entries.map(([childLabel, childValue, isTool]) => (
            <JsonNode
              key={childLabel}
              label={childLabel}
              value={childValue}
              depth={depth + 1}
              defaultOpen={isTool ? false : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
