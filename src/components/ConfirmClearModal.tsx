import React from 'react';

interface ConfirmClearModalProps {
  pageCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmClearModal: React.FC<ConfirmClearModalProps> = ({
  pageCount,
  onConfirm,
  onCancel,
}) => {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-3xl bg-[#15181E] border border-white/10 p-6 space-y-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold text-neutral-100">
            🗑️ Start a new book?
          </h2>
          <p className="text-sm text-neutral-400">
            This will permanently remove all{' '}
            <strong className="text-neutral-200 font-mono">{pageCount}</strong> saved{' '}
            {pageCount === 1 ? 'page' : 'pages'} from this device. Make sure you&apos;ve exported your PDF first.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 min-h-[48px] rounded-2xl bg-white/10 hover:bg-white/15 text-neutral-200 font-medium text-sm active:scale-[0.98] transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 min-h-[48px] rounded-2xl bg-red-500 hover:bg-red-400 text-white font-semibold text-sm active:scale-[0.98] transition"
          >
            Clear All Pages
          </button>
        </div>
      </div>
    </div>
  );
};
