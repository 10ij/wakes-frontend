import React, { useEffect, useState } from 'react';
import type { SavedPageRecord } from '../db/pageStore';

interface PageQueueProps {
  pages: SavedPageRecord[];
  isLoading: boolean;
  isLocked: boolean;
  onPreview: (page: SavedPageRecord) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onDelete: (id: string) => void;
  onRequestClearAll: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Individual thumbnail card that owns its Object URL lifecycle cleanly,
 * revoking the URL immediately when deleted or unmounted.
 */
const PageCard: React.FC<{
  page: SavedPageRecord;
  index: number;
  total: number;
  isLocked: boolean;
  onPreview: (page: SavedPageRecord) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onDelete: (id: string) => void;
}> = ({ page, index, total, isLocked, onPreview, onMove, onDelete }) => {
  const [thumbUrl, setThumbUrl] = useState<string>('');

  useEffect(() => {
    const url = URL.createObjectURL(page.blob);
    setThumbUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [page.blob]);

  const pageNum = String(index + 1).padStart(2, '0');

  return (
    <article className="rounded-2xl bg-[#15181E] border border-white/10 overflow-hidden flex flex-col">
      {/* Tap thumbnail to open high-res preview modal */}
      <button
        type="button"
        onClick={() => onPreview(page)}
        className="relative w-full aspect-[3/4] bg-[#0B0D10] overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 group"
      >
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={`Scanned page ${index + 1}`}
            className="w-full h-full object-contain transition-transform duration-150 group-active:scale-[0.98]"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-neutral-500">
            Loading…
          </div>
        )}
      </button>

      {/* Clean unboxed metadata + tactile actions */}
      <div className="p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2 text-xs text-neutral-400">
          <span className="font-mono font-semibold text-neutral-100">Page {pageNum}</span>
          <span className="font-mono truncate">
            {page.width}×{page.height} · {formatBytes(page.blob.size)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-white/5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={isLocked || index === 0}
              onClick={() => onMove(page.id, -1)}
              aria-label={`Move page ${index + 1} up`}
              title="Move earlier"
              className="min-h-[44px] min-w-[44px] rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center text-sm active:scale-95 transition"
            >
              ⬆️
            </button>
            <button
              type="button"
              disabled={isLocked || index === total - 1}
              onClick={() => onMove(page.id, 1)}
              aria-label={`Move page ${index + 1} down`}
              title="Move later"
              className="min-h-[44px] min-w-[44px] rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center text-sm active:scale-95 transition"
            >
              ⬇️
            </button>
          </div>

          <button
            type="button"
            disabled={isLocked}
            onClick={() => onDelete(page.id)}
            aria-label={`Delete page ${index + 1}`}
            title="Delete page"
            className="min-h-[44px] min-w-[44px] px-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-300 disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center text-sm active:scale-95 transition"
          >
            🗑️
          </button>
        </div>
      </div>
    </article>
  );
};

export const PageQueue: React.FC<PageQueueProps> = ({
  pages,
  isLoading,
  isLocked,
  onPreview,
  onMove,
  onDelete,
  onRequestClearAll,
}) => {
  if (isLoading) {
    return (
      <div className="py-16 text-center text-sm text-neutral-400">
        Restoring saved pages from this device…
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <section className="rounded-3xl bg-[#15181E] border border-white/10 p-8 sm:p-10 text-center space-y-4">
        <div className="text-4xl" aria-hidden="true">
          📖
        </div>
        <div className="space-y-1.5 max-w-md mx-auto">
          <h1 className="text-xl font-semibold text-neutral-100 text-balance">
            Scan one folded page at a time
          </h1>
          <p className="text-sm text-neutral-400 leading-relaxed">
            Tap <strong>Scan Page</strong> below to photograph a page in natural color. Every scan straightens automatically and saves safely on your iPhone, even offline.
          </p>
        </div>
        <div className="pt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-neutral-400">
          <span>📷 Auto corner detection</span>
          <span aria-hidden="true">·</span>
          <span>💾 Saved across reloads</span>
          <span aria-hidden="true">·</span>
          <span>📄 High-res PDF export</span>
        </div>
      </section>
    );
  }

  const totalBytes = pages.reduce((acc, p) => acc + p.blob.size, 0);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-base font-semibold text-neutral-100">
            Scanned Pages
          </h1>
          <span className="text-xs font-mono text-neutral-400">
            {pages.length} {pages.length === 1 ? 'page' : 'pages'} · {formatBytes(totalBytes)}
          </span>
        </div>

        <button
          type="button"
          disabled={isLocked}
          onClick={onRequestClearAll}
          className="min-h-[44px] px-3.5 rounded-xl bg-white/5 hover:bg-red-500/15 hover:text-red-300 border border-white/10 text-xs font-medium text-neutral-300 disabled:opacity-40 whitespace-nowrap shrink-0 transition"
        >
          New Book / Clear All
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
        {pages.map((page, index) => (
          <PageCard
            key={page.id}
            page={page}
            index={index}
            total={pages.length}
            isLocked={isLocked}
            onPreview={onPreview}
            onMove={onMove}
            onDelete={onDelete}
          />
        ))}
      </div>
    </section>
  );
};
