import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';

/**
 * In-app PWA Install trigger.
 * - Hides automatically when already running in `standalone` Home Screen mode.
 * - Triggers `beforeinstallprompt` on Android/Chromium.
 * - Shows a clear "Share → Add to Home Screen" guide modal on iOS Safari.
 */
export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="min-h-[44px] px-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-medium text-neutral-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition active:scale-[0.97]"
      >
        <span aria-hidden="true">📲</span>
        <span>Install</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="min-h-[44px] px-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-medium text-neutral-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition active:scale-[0.97]"
        >
          <span aria-hidden="true">📲</span>
          <span>Install</span>
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={() => setShowIOSGuide(false)}
          >
            <div
              className="w-full max-w-sm rounded-3xl bg-[#15181E] border border-white/10 p-6 space-y-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-neutral-100">
                  📲 Install wakes on iPhone
                </h2>
                <p className="text-sm text-neutral-400">
                  Install to your Home Screen for full-screen scanning and 100% offline use.
                </p>
              </div>

              <ol className="space-y-3 text-sm text-neutral-200 bg-[#0B0D10] rounded-2xl p-4 border border-white/5">
                <li>
                  1. Tap the <strong>Share</strong> button in Safari&apos;s toolbar (bottom or top bar).
                </li>
                <li>
                  2. Scroll down and tap <strong>Add to Home Screen</strong>.
                </li>
                <li>
                  3. Confirm the name <strong>wakes</strong> and tap <strong>Add</strong>.
                </li>
              </ol>

              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full min-h-[48px] rounded-xl bg-amber-500 text-neutral-950 font-semibold text-sm active:scale-[0.98] transition"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
