import React, { useState } from 'react';
import type { SavedPageRecord } from '../db/pageStore';
import type { BuiltPdfResult } from '../utils/pdfExport';

interface ExportModalProps {
  pages: SavedPageRecord[];
  onLog?: (text: string, level?: 'info' | 'done' | 'warn' | 'error') => void;
  onClose: () => void;
}

function defaultBookName(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `Book-${y}-${m}-${d}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Two-step PDF Export Modal:
 * 1. User names the book and taps "Build PDF" (sequential pdf-lib embedJpg, zero canvas re-decode).
 * 2. Once built, user gets a fresh "Share PDF" button so iOS Safari receives an immediate
 *    user gesture for `navigator.share({ files })`, plus a standard download fallback.
 *
 * Saved pages remain untouched in IndexedDB after exporting.
 */
export const ExportModal: React.FC<ExportModalProps> = ({ pages, onLog, onClose }) => {
  const [title, setTitle] = useState<string>(defaultBookName);
  const [isBuilding, setIsBuilding] = useState<boolean>(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [builtPdf, setBuiltPdf] = useState<BuiltPdfResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleBuild = async () => {
    if (isBuilding || pages.length === 0) return;
    setIsBuilding(true);
    setErrorMsg(null);
    setFeedback(null);
    setBuiltPdf(null);
    setProgress({ current: 0, total: pages.length });
    onLog?.(`Starting PDF build for ${pages.length} page(s) as "${title}"…`, 'info');

    try {
      const { buildBookPdf } = await import('../utils/pdfExport');
      const result = await buildBookPdf(pages, title, (current, total) => {
        setProgress({ current, total });
        if (current === 1 || current === total || current % 10 === 0) {
          onLog?.(`Embedded PDF page ${current}/${total}`, 'info');
        }
      });
      setBuiltPdf(result);
      onLog?.(
        `PDF "${result.file.name}" built (${formatBytes(result.sizeBytes)}) in ${Math.round(
          result.buildMs
        )} ms`,
        'done'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to build PDF';
      setErrorMsg(msg);
      onLog?.(`PDF build failed: ${msg}`, 'error');
    } finally {
      setIsBuilding(false);
      setProgress(null);
    }
  };

  const handleShare = async () => {
    if (!builtPdf) return;
    onLog?.(`Opening share sheet for ${builtPdf.file.name}…`, 'info');
    const { shareOrDownloadPdf } = await import('../utils/pdfExport');
    const outcome = await shareOrDownloadPdf(builtPdf.file);
    if (outcome === 'shared') {
      setFeedback('PDF shared successfully. Your scanned pages remain saved here.');
      onLog?.('PDF shared via system share sheet', 'done');
    } else if (outcome === 'downloaded') {
      setFeedback('PDF download started. Your scanned pages remain saved here.');
      onLog?.('PDF downloaded via fallback link', 'done');
    } else {
      onLog?.('Share sheet dismissed by user', 'warn');
    }
  };

  const handleDownload = async () => {
    if (!builtPdf) return;
    const { downloadPdfFile } = await import('../utils/pdfExport');
    downloadPdfFile(builtPdf.file);
    setFeedback('PDF download started. Your scanned pages remain saved here.');
    onLog?.(`Downloaded ${builtPdf.file.name}`, 'done');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      onClick={() => {
        if (!isBuilding) onClose();
      }}
    >
      <div
        className="w-full max-w-md max-h-full overflow-y-auto rounded-3xl bg-[#15181E] border border-white/10 p-6 space-y-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-neutral-100">📄 Export PDF</h2>
            <p className="text-xs text-neutral-400 mt-0.5 font-mono">
              {pages.length} {pages.length === 1 ? 'page' : 'pages'} · Matched page aspect ratio
            </p>
          </div>
          <button
            type="button"
            disabled={isBuilding}
            onClick={onClose}
            aria-label="Close export modal"
            className="min-h-[44px] min-w-[44px] rounded-xl bg-white/5 hover:bg-white/10 text-neutral-300 flex items-center justify-center text-sm disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {/* Book Filename Input */}
        <div className="space-y-1.5">
          <label htmlFor="pdf-title-input" className="block text-xs font-medium text-neutral-300">
            PDF Filename
          </label>
          <div className="flex items-center rounded-xl bg-[#0B0D10] border border-white/15 focus-within:border-amber-500 px-3.5">
            <input
              id="pdf-title-input"
              type="text"
              value={title}
              disabled={isBuilding}
              onChange={(e) => {
                setTitle(e.target.value);
                if (builtPdf) setBuiltPdf(null);
              }}
              placeholder="My-Scanned-Book"
              className="flex-1 min-h-[46px] bg-transparent text-sm text-neutral-100 focus:outline-none"
            />
            <span className="text-xs font-mono text-neutral-500">.pdf</span>
          </div>
        </div>

        {errorMsg && (
          <div className="rounded-xl bg-red-500/15 border border-red-500/30 px-3.5 py-2.5 text-xs text-red-300">
            ⚠️ {errorMsg}
          </div>
        )}

        {feedback && (
          <div className="rounded-xl bg-emerald-500/15 border border-emerald-500/30 px-3.5 py-2.5 text-xs text-emerald-300">
            ✅ {feedback}
          </div>
        )}

        {/* Step 1: Build OR Step 2: Share / Download */}
        {!builtPdf ? (
          <button
            type="button"
            disabled={isBuilding || pages.length === 0}
            onClick={() => void handleBuild()}
            className="w-full min-h-[50px] rounded-2xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.98] transition"
          >
            {isBuilding && progress
              ? `⏳ Building page ${progress.current} of ${progress.total}…`
              : '📄 Build High-Res PDF'}
          </button>
        ) : (
          <div className="space-y-3">
            <div className="rounded-2xl bg-[#0B0D10] border border-amber-500/30 p-3.5 flex items-center justify-between text-xs">
              <span className="font-mono text-amber-400 font-semibold truncate">
                {builtPdf.file.name}
              </span>
              <span className="font-mono text-neutral-400 whitespace-nowrap shrink-0 ml-2">
                {formatBytes(builtPdf.sizeBytes)} · {Math.round(builtPdf.buildMs)} ms
              </span>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => void handleShare()}
                className="flex-1 min-h-[50px] rounded-2xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-semibold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition"
              >
                <span aria-hidden="true">📲</span>
                <span>Share PDF</span>
              </button>

              <button
                type="button"
                onClick={() => void handleDownload()}
                className="min-h-[50px] px-4 rounded-2xl bg-white/10 hover:bg-white/15 text-neutral-100 font-medium text-sm flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 active:scale-[0.98] transition"
              >
                <span aria-hidden="true">⬇️</span>
                <span>Download</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
