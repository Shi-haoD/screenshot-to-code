import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BsArrowsFullscreen,
  BsBoxArrowUpRight,
  BsChevronLeft,
  BsChevronRight,
  BsDash,
  BsPlus,
  BsX,
} from "react-icons/bs";

interface LightboxEntry {
  id: string;
  src: string;
  alt: string;
}

interface LightboxContextValue {
  register: (entry: LightboxEntry) => void;
  unregister: (id: string) => void;
  open: (id: string) => void;
}

const LightboxContext = createContext<LightboxContextValue | null>(null);

const MIN_SCALE_FACTOR = 0.2; // relative to fit
const MAX_SCALE = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function LightboxViewer({
  entries,
  index,
  onClose,
  onNavigate,
}: {
  entries: LightboxEntry[];
  index: number;
  onClose: () => void;
  onNavigate: (nextIndex: number) => void;
}) {
  const entry = entries[index];
  const containerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const fitScale = useMemo(() => {
    const container = containerRef.current;
    if (!natural || !container) return 1;
    return Math.min(
      (container.clientWidth * 0.92) / natural.w,
      (container.clientHeight * 0.85) / natural.h,
      1
    );
  }, [natural]);

  const resetToFit = useCallback(() => {
    setScale(fitScale);
    setTx(0);
    setTy(0);
  }, [fitScale]);

  // Refit when the image changes/loads.
  useEffect(() => {
    resetToFit();
  }, [resetToFit, entry?.src]);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cx = clientX - rect.left - rect.width / 2;
      const cy = clientY - rect.top - rect.height / 2;
      setScale((previousScale) => {
        const nextScale = clamp(
          previousScale * factor,
          fitScale * MIN_SCALE_FACTOR,
          MAX_SCALE
        );
        const ratio = nextScale / previousScale;
        setTx((previousTx) => cx - (cx - previousTx) * ratio);
        setTy((previousTy) => cy - (cy - previousTy) * ratio);
        return nextScale;
      });
    },
    [fitScale]
  );

  // Native wheel listener: React's synthetic wheel handlers are passive, so
  // preventDefault (needed to stop page scroll) requires a manual listener.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0018));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.3);
      } else if (e.key === "-" || e.key === "_") {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.3);
      } else if (e.key === "0" || e.key.toLowerCase() === "f") {
        resetToFit();
      } else if (e.key === "1") {
        setScale(1);
      } else if (e.key === "ArrowLeft" && entries.length > 1) {
        onNavigate((index - 1 + entries.length) % entries.length);
      } else if (e.key === "ArrowRight" && entries.length > 1) {
        onNavigate((index + 1) % entries.length);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, onNavigate, resetToFit, zoomAt, entries.length, index]);

  // Lock page scroll while open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!entry) return null;

  const zoomPercent = natural ? Math.round(scale * 100) : 100;

  const toolbarButton =
    "flex h-8 w-8 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-auto mt-3 flex shrink-0 items-center gap-1 rounded-xl border border-zinc-700 bg-zinc-900/90 px-2 py-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className={toolbarButton}
          title="Zoom out (-)"
          onClick={() => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (rect)
              zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.3);
          }}
        >
          <BsDash />
        </button>
        <span className="w-14 text-center font-mono text-xs text-zinc-300">
          {zoomPercent}%
        </span>
        <button
          className={toolbarButton}
          title="Zoom in (+)"
          onClick={() => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (rect)
              zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.3);
          }}
        >
          <BsPlus />
        </button>
        <button
          className={`${toolbarButton} w-auto px-2 text-xs`}
          title="Fit to screen (0 / f)"
          onClick={resetToFit}
        >
          <BsArrowsFullscreen className="mr-1" /> Fit
        </button>
        <button
          className={`${toolbarButton} w-auto px-2 font-mono text-xs`}
          title="Actual size (1)"
          onClick={() => setScale(1)}
        >
          1:1
        </button>
        <div className="mx-1 h-5 w-px bg-zinc-700" />
        <a
          href={entry.src}
          target="_blank"
          rel="noreferrer"
          className={toolbarButton}
          title="Open in new tab"
        >
          <BsBoxArrowUpRight />
        </a>
        <button className={toolbarButton} title="Close (Esc)" onClick={onClose}>
          <BsX className="text-lg" />
        </button>
      </div>

      <div
        ref={containerRef}
        className={`relative min-h-0 flex-1 overflow-hidden ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dragRef.current = { x: e.clientX, y: e.clientY };
          setIsDragging(true);
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const dx = e.clientX - dragRef.current.x;
          const dy = e.clientY - dragRef.current.y;
          dragRef.current = { x: e.clientX, y: e.clientY };
          setTx((previous) => previous + dx);
          setTy((previous) => previous + dy);
        }}
        onPointerUp={(e) => {
          dragRef.current = null;
          setIsDragging(false);
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        }}
        onDoubleClick={(e) => {
          // Toggle between fit and a closer look at the point under the cursor.
          if (scale > fitScale * 1.4) resetToFit();
          else zoomAt(e.clientX, e.clientY, (fitScale * 3) / scale || 3);
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <img
            src={entry.src}
            alt={entry.alt}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              maxWidth: "none",
              maxHeight: "none",
            }}
            className="select-none"
          />
        </div>
      </div>

      <div
        className="pointer-events-none mx-auto mb-3 flex shrink-0 items-center gap-3 text-xs text-zinc-400"
        onClick={(e) => e.stopPropagation()}
      >
        {entries.length > 1 && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/90 px-2 py-1">
            <button
              className={toolbarButton}
              title="Previous image (←)"
              onClick={() =>
                onNavigate((index - 1 + entries.length) % entries.length)
              }
            >
              <BsChevronLeft />
            </button>
            <span className="font-mono">
              {index + 1} / {entries.length}
            </span>
            <button
              className={toolbarButton}
              title="Next image (→)"
              onClick={() => onNavigate((index + 1) % entries.length)}
            >
              <BsChevronRight />
            </button>
          </div>
        )}
        <span className="max-w-[50vw] truncate rounded-lg bg-zinc-900/80 px-2 py-1">
          {entry.alt}
        </span>
      </div>
    </div>
  );
}

/**
 * Collects every LightboxImage rendered beneath it so the viewer can page
 * through all images in the run with ←/→.
 */
export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<LightboxEntry[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  const register = useCallback((entry: LightboxEntry) => {
    setEntries((previous) => {
      const without = previous.filter((e) => e.id !== entry.id);
      return [...without, entry];
    });
  }, []);

  const unregister = useCallback((id: string) => {
    setEntries((previous) => previous.filter((e) => e.id !== id));
  }, []);

  const open = useCallback((id: string) => setOpenId(id), []);

  const value = useMemo(
    () => ({ register, unregister, open }),
    [register, unregister, open]
  );

  const openIndex = entries.findIndex((e) => e.id === openId);

  return (
    <LightboxContext.Provider value={value}>
      {children}
      {openId !== null && openIndex >= 0 && (
        <LightboxViewer
          entries={entries}
          index={openIndex}
          onClose={() => setOpenId(null)}
          onNavigate={(nextIndex) => setOpenId(entries[nextIndex]?.id ?? null)}
        />
      )}
    </LightboxContext.Provider>
  );
}

/**
 * Thumbnail that opens the shared lightbox. Falls back to opening the image
 * in a new tab when no LightboxProvider is mounted (e.g. PromptReportsPage).
 */
export function LightboxImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const context = useContext(LightboxContext);
  const id = useId();

  useEffect(() => {
    if (!context) return;
    context.register({ id, src, alt });
    return () => context.unregister(id);
  }, [context, id, src, alt]);

  const image = (
    <img
      src={src}
      alt={alt}
      title={alt}
      className={
        className ??
        "max-h-28 w-auto max-w-full rounded bg-zinc-800 object-contain transition-opacity hover:opacity-80"
      }
      loading="lazy"
    />
  );

  if (!context) {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="inline-block">
        {image}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        context.open(id);
      }}
      className="inline-block cursor-zoom-in"
      title={`${alt} — click to zoom`}
    >
      {image}
    </button>
  );
}
