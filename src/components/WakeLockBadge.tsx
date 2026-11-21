import React from 'react';
import type { WakeLockState } from '../hooks/useWakeLock';

interface WakeLockBadgeProps {
  wakeLock: WakeLockState;
}

/**
 * Compact Screen Wake Lock toggle button for the top bar.
 * Shows clear human-readable status ("Awake" / "Sleep allowed" / "Tap to keep awake").
 */
export const WakeLockBadge: React.FC<WakeLockBadgeProps> = ({ wakeLock }) => {
  if (!wakeLock.supported) {
    return null;
  }

  let emoji = '🌙';
  let label = 'Sleep allowed';
  let styleClass = 'bg-white/5 border-white/10 text-neutral-300 hover:bg-white/10';

  if (wakeLock.enabled) {
    if (wakeLock.active) {
      emoji = '🔓';
      label = 'Awake';
      styleClass = 'bg-amber-500/15 border-amber-500/35 text-amber-300 hover:bg-amber-500/20';
    } else if (wakeLock.needsGesture) {
      emoji = '👆';
      label = 'Tap for Awake';
      styleClass = 'bg-amber-500/20 border-amber-500/45 text-amber-200 hover:bg-amber-500/30';
    } else {
      emoji = '🔓';
      label = 'Awake';
      styleClass = 'bg-white/5 border-white/15 text-neutral-200 hover:bg-white/10';
    }
  }

  return (
    <button
      type="button"
      onClick={() => void wakeLock.toggle()}
      aria-pressed={wakeLock.enabled}
      title={
        wakeLock.enabled
          ? 'Screen stays awake while scanning. Tap to allow sleep.'
          : 'Screen allowed to sleep. Tap to keep awake.'
      }
      className={`min-h-[44px] px-3 rounded-xl border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition active:scale-[0.97] ${styleClass}`}
    >
      <span aria-hidden="true">{emoji}</span>
      <span>{label}</span>
    </button>
  );
};
