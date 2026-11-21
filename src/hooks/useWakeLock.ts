import { useCallback, useEffect, useRef, useState } from 'react';

export interface WakeLockState {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  needsGesture: boolean;
  toggle: () => Promise<void>;
  ensureOnGesture: () => Promise<void>;
}

/**
 * iOS-safe Screen Wake Lock hook.
 *
 * - Enabled by default during an active scanning session.
 * - Requests wake lock inside real user gestures (toggle tap or Scan button tap) because
 *   iOS WebKit may reject wake lock requests without user activation (`NotAllowedError`).
 * - Listens to `visibilitychange` to silently re-acquire the lock when returning from the
 *   native iOS camera sheet or screen unlock.
 */
export function useWakeLock(defaultEnabled = true): WakeLockState {
  const supported =
    typeof navigator !== 'undefined' && 'wakeLock' in navigator && !!navigator.wakeLock;

  const [enabled, setEnabled] = useState<boolean>(defaultEnabled);
  const [active, setActive] = useState<boolean>(false);
  const [needsGesture, setNeedsGesture] = useState<boolean>(false);

  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const enabledRef = useRef<boolean>(defaultEnabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const releaseLock = useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    if (sentinel) {
      try {
        await sentinel.release();
      } catch {
        // Ignore already-released sentinel
      }
    }
    setActive(false);
    setNeedsGesture(false);
  }, []);

  const requestLock = useCallback(async () => {
    if (!supported || !enabledRef.current) return;
    if (document.visibilityState !== 'visible') return;
    if (sentinelRef.current && !sentinelRef.current.released) {
      setActive(true);
      setNeedsGesture(false);
      return;
    }

    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinelRef.current = sentinel;
      setActive(true);
      setNeedsGesture(false);

      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null;
          setActive(false);
        }
      });
    } catch (err) {
      setActive(false);
      if (err instanceof Error && err.name === 'NotAllowedError') {
        // iOS Safari may require a fresh tap after returning from background
        setNeedsGesture(true);
      }
    }
  }, [supported]);

  // Try initial acquire and re-acquire silently whenever app returns to foreground
  useEffect(() => {
    if (!supported) return;

    if (enabled) {
      void requestLock();
    } else {
      void releaseLock();
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && enabledRef.current) {
        void requestLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [supported, enabled, requestLock, releaseLock]);

  // Release sentinel cleanly when unmounting
  useEffect(() => {
    return () => {
      void releaseLock();
    };
  }, [releaseLock]);

  const toggle = useCallback(async () => {
    if (!supported) return;
    if (enabledRef.current && !needsGesture) {
      enabledRef.current = false;
      setEnabled(false);
      await releaseLock();
    } else {
      enabledRef.current = true;
      setEnabled(true);
      await requestLock();
    }
  }, [supported, needsGesture, releaseLock, requestLock]);

  const ensureOnGesture = useCallback(async () => {
    if (!supported || !enabledRef.current) return;
    await requestLock();
  }, [supported, requestLock]);

  return {
    supported,
    enabled,
    active,
    needsGesture,
    toggle,
    ensureOnGesture,
  };
}
