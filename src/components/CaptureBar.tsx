import React from 'react';

export type ProcessingStage =
  | 'idle'
  | 'preparing'
  | 'detecting'
  | 'straightening'
  | 'saving';

interface CaptureBarProps {
  stage: ProcessingStage;
  batchProgress: { current: number; total: number } | null;
  pageCount: number;
  onBeforeCapture: () => void;
  onFilesSelected: (files: File[]) => void;
  onOpenExport: () => void;
}

const STAGE_LABEL: Record<ProcessingStage, string> = {
  idle: 'Scan Page',
  preparing: 'Reading photo…',
  detecting: 'Detecting page…',
  straightening: 'Straightening…',
  saving: 'Saving…',
};

/**
 * Thumb-zone bottom dock for native iPhone camera capture + strict processing lock + PDF export.
 *
 * - Capturing snapshots `Array.from(e.target.files)` synchronously BEFORE resetting `input.value`
 *   so iOS Safari's live FileList is never wiped prematurely.
 * - While `stage !== 'idle'`, capture & import controls are strictly locked to prevent overlapping jobs.
 */
export const CaptureBar: React.FC<CaptureBarProps> = ({
  stage,
  batchProgress,
  pageCount,
  onBeforeCapture,
  onFilesSelected,
  onOpenExport,
}) => {
  const isLocked = stage !== 'idle';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length > 0) {
      onFilesSelected(files);
    }
  };

  const lockText = batchProgress && batchProgress.total > 1
    ? `${batchProgress.current}/${batchProgress.total} · ${STAGE_LABEL[stage]}`
    : STAGE_LABEL[stage];

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 bg-[#0B0D10]/95 backdrop-blur-md border-t border-white/10 pb-safe">
      <div className="max-w-5xl mx-auto px-4 pt-2.5 flex items-center gap-2.5">
        {/* Primary Thumb CTA: Native iPhone Camera */}
        <label
          onClick={() => {
            if (!isLocked) onBeforeCapture();
          }}
          className={`relative flex-1 min-h-[50px] rounded-2xl bg-amber-500 text-neutral-950 font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-amber-500/10 active:scale-[0.98] transition select-none ${
            isLocked ? 'opacity-65 pointer-events-none cursor-wait' : 'hover:bg-amber-400'
          }`}
        >
          <span aria-hidden="true">{isLocked ? '⏳' : '📷'}</span>
          <span className="whitespace-nowrap truncate">{lockText}</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={isLocked}
            className="sr-only"
            onChange={handleFileChange}
          />
        </label>

        {/* Secondary Action: Pick existing photo(s) from Library */}
        <label
          onClick={() => {
            if (!isLocked) onBeforeCapture();
          }}
          title="Import photos from library"
          className={`relative min-h-[50px] min-w-[50px] px-3.5 rounded-2xl bg-[#15181E] border border-white/15 text-neutral-200 font-medium text-sm flex items-center justify-center cursor-pointer active:scale-[0.98] transition select-none ${
            isLocked ? 'opacity-45 pointer-events-none' : 'hover:bg-white/10'
          }`}
        >
          <span aria-hidden="true">🖼️</span>
          <span className="sr-only">Import from Library</span>
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={isLocked}
            className="sr-only"
            onChange={handleFileChange}
          />
        </label>

        {/* Export PDF Trigger */}
        <button
          type="button"
          disabled={isLocked || pageCount === 0}
          onClick={onOpenExport}
          className="min-h-[50px] px-4 rounded-2xl bg-[#15181E] border border-white/15 text-neutral-100 font-semibold text-sm flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none active:scale-[0.98] transition"
        >
          <span aria-hidden="true">📄</span>
          <span>PDF</span>
          {pageCount > 0 && (
            <span className="font-mono text-amber-400">({pageCount})</span>
          )}
        </button>
      </div>
    </footer>
  );
};
