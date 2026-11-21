import React, { useEffect, useState } from 'react';
import type { SavedPageRecord } from '../db/pageStore';

interface PagePreviewModalProps {
  page: SavedPageRecord;
  pageNumber: number;
  onClose: () => void;
  onDelete: (id: string) => void;
}

export const PagePreviewModal: React.FC<PagePreviewModalProps> = ({
  page,
  pageNumber,
  onClose,
  onDelete,
}) => {
  const [imageUrl, setImageUrl] = useState<string>('');

  useEffect(() => {
    const url = URL.createObjectURL(page.blob);
    setImageUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [page.blob]);

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0B0D10]/95 backdrop-blur-md flex flex-col pt-safe pb-safe"
      onClick={onClose}
    >
      <header
        className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-100 font-mono">
            Page {String(pageNumber).padStart(2, '0')}
          </div>
          <div className="text-xs font-mono text-neutral-400">
            {page.width}×{page.height} · {(page.blob.size / 1024).toFixed(0)} KB
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              onDelete(page.id);
              onClose();
            }}
            className="min-h-[44px] px-3.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 text-red-300 text-xs font-medium flex items-center gap-1.5"
          >
            <span aria-hidden="true">🗑️</span>
            <span>Delete</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 rounded-xl bg-white/10 hover:bg-white/15 text-neutral-100 text-xs font-semibold"
          >
            Done
          </button>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
        {imageUrl && (
          <img
            src={imageUrl}
            alt={`Full preview of page ${pageNumber}`}
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl border border-white/10"
          />
        )}
      </div>
    </div>
  );
};
