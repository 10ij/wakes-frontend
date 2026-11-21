import React, { useCallback, useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { CaptureBar, type ProcessingStage } from './components/CaptureBar';
import { ConfirmClearModal } from './components/ConfirmClearModal';
import { ExportModal } from './components/ExportModal';
import {
  ManualCornerModal,
  type ManualCornerDraft,
} from './components/ManualCornerModal';
import { PagePreviewModal } from './components/PagePreviewModal';
import { PageQueue } from './components/PageQueue';
import { PWAInstallButton } from './components/PWAInstallButton';
import { SettingsModal } from './components/SettingsModal';
import { VerboseLogPanel, type VerboseLogEntry } from './components/VerboseLogPanel';
import { WakeLockBadge } from './components/WakeLockBadge';
import {
  addPage,
  clearAllBookData,
  deletePage,
  getAllPages,
  getDraftSource,
  movePage,
  requestPersistentStorage,
  saveDraftSource,
  updatePageImage,
  type SavedPageRecord,
} from './db/pageStore';
import { useWakeLock } from './hooks/useWakeLock';
import type { QuadCorners } from './utils/docalignerMath';
import {
  decodeBoundedPhoto,
  decodeDraftSourceForWarp,
  encodeRgbaToJpegBlob,
} from './utils/imageMemory';
import {
  loadSettings,
  saveSettings,
  type AppSettings,
} from './utils/settings';
import type {
  ProcessPageError,
  ProcessPageRequest,
  ProcessPageStage,
  ProcessPageSuccess,
} from './workers/dewarp.worker';

interface EditToastState {
  pageId: string;
  pageNumber: number;
}

function makeDefaultInsetCorners(w: number, h: number): QuadCorners {
  const mx = w * 0.08;
  const my = h * 0.08;
  return [
    { x: mx, y: my },
    { x: w - mx, y: my },
    { x: w - mx, y: h - my },
    { x: mx, y: h - my },
  ];
}

function formatTimestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export default function App() {
  const wakeLock = useWakeLock(true);
  const workerRef = useRef<Worker | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const manualResolveRef = useRef<((corners: QuadCorners | null) => void) | null>(null);
  const logSeqRef = useRef<number>(1);

  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);

  const [currentActivity, setCurrentActivity] = useState<string>('Idle · Ready to scan');
  const [verboseLogs, setVerboseLogs] = useState<VerboseLogEntry[]>([]);

  const [pages, setPages] = useState<SavedPageRecord[]>([]);
  const [isLoadingStore, setIsLoadingStore] = useState<boolean>(true);
  const [stage, setStage] = useState<ProcessingStage>('idle');
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Brief post-save toast offering one-tap corner adjustment (reads draftSource from IDB)
  const [editToast, setEditToast] = useState<EditToastState | null>(null);
  const [manualDraft, setManualDraft] = useState<ManualCornerDraft | null>(null);
  const [isApplyingManual, setIsApplyingManual] = useState<boolean>(false);

  const [previewPage, setPreviewPage] = useState<SavedPageRecord | null>(null);
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [showClearModal, setShowClearModal] = useState<boolean>(false);

  // PWA offline + prompted update banner
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [updateReady, setUpdateReady] = useState<boolean>(false);
  const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  const addLog = useCallback(
    (text: string, level: VerboseLogEntry['level'] = 'info') => {
      setCurrentActivity(text);
      setVerboseLogs((prev) => {
        const entry: VerboseLogEntry = {
          id: logSeqRef.current++,
          time: formatTimestamp(),
          text,
          level,
        };
        const next = [...prev, entry];
        return next.length > 80 ? next.slice(next.length - 80) : next;
      });
    },
    []
  );

  const handleSettingsChange = useCallback(
    (next: AppSettings) => {
      setSettings(next);
      saveSettings(next);
      if (next.verboseMode && !settings.verboseMode) {
        addLog('Verbose activity mode enabled', 'done');
      }
    },
    [settings.verboseMode, addLog]
  );

  // Rehydrate ordered pages from IndexedDB on load (survives iOS reloads/screen locks)
  useEffect(() => {
    let active = true;
    addLog('Checking IndexedDB & persistent storage…', 'info');

    void requestPersistentStorage().then((persisted) => {
      if (active) {
        addLog(`Storage persistence: ${persisted ? 'granted' : 'standard'}`, 'info');
      }
    });

    getAllPages()
      .then((saved) => {
        if (active) {
          setPages(saved);
          setIsLoadingStore(false);
          addLog(`Rehydrated ${saved.length} saved page(s) from IndexedDB`, 'done');
          setCurrentActivity('Idle · Ready to scan');
        }
      })
      .catch((err) => {
        if (active) {
          const msg = err instanceof Error ? err.message : 'Failed to load saved pages';
          setErrorMsg(msg);
          setIsLoadingStore(false);
          addLog(`IndexedDB load error: ${msg}`, 'error');
        }
      });

    return () => {
      active = false;
    };
  }, [addLog]);

  // Register prompt-based Service Worker + online/offline listener
  useEffect(() => {
    const updateSW = registerSW({
      onNeedRefresh() {
        setUpdateReady(true);
        addLog('New app version detected and waiting to apply', 'warn');
      },
      onOfflineReady() {
        addLog('Offline service worker cache ready', 'done');
      },
    });
    updateSWRef.current = updateSW;

    const handleOnline = () => {
      setIsOnline(true);
      addLog('Network connection restored', 'info');
    };
    const handleOffline = () => {
      setIsOnline(false);
      addLog('Offline mode active (running from local cache)', 'warn');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [addLog]);

  // Initialize WASM Web Worker once
  useEffect(() => {
    const worker = new Worker(new URL('./workers/dewarp.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    addLog('Initialized WASM processing Web Worker', 'info');

    return () => {
      worker.terminate();
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, [addLog]);

  const prevWakeActiveRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!wakeLock.supported) return;
    if (prevWakeActiveRef.current === null) {
      prevWakeActiveRef.current = wakeLock.active;
      return;
    }
    if (wakeLock.active !== prevWakeActiveRef.current) {
      prevWakeActiveRef.current = wakeLock.active;
      addLog(
        wakeLock.active
          ? 'Screen Wake Lock active (screen kept awake)'
          : wakeLock.needsGesture
            ? 'Screen Wake Lock paused by iOS (tap Awake badge or Scan to re-enable)'
            : 'Screen Wake Lock released (sleep allowed)',
        wakeLock.needsGesture ? 'warn' : 'info'
      );
    }
  }, [wakeLock.supported, wakeLock.active, wakeLock.needsGesture, addLog]);

  const showCornerToast = useCallback(
    (pageId: string, pageNumber: number, durationSec: number) => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      setEditToast({ pageId, pageNumber });
      toastTimerRef.current = window.setTimeout(() => {
        setEditToast(null);
        toastTimerRef.current = null;
      }, durationSec * 1000);
    },
    []
  );

  const runWorkerJob = useCallback(
    (req: ProcessPageRequest, transfer: Transferable[]) => {
      return new Promise<ProcessPageSuccess>((resolve, reject) => {
        const worker = workerRef.current;
        if (!worker) {
          reject(new Error('Processing worker unavailable'));
          return;
        }

        const cleanup = () => {
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          worker.removeEventListener('messageerror', onMsgError);
        };
        const onMessage = (
          event: MessageEvent<ProcessPageSuccess | ProcessPageStage | ProcessPageError>
        ) => {
          if (event.data.jobId !== req.jobId) return;
          if (event.data.type === 'stage') {
            addLog(event.data.message, 'info');
            return;
          }
          cleanup();
          if (event.data.type === 'error') {
            reject(new Error(event.data.message));
          } else {
            resolve(event.data);
          }
        };
        const onError = (err: ErrorEvent) => {
          cleanup();
          reject(new Error(err.message || 'Worker execution failed'));
        };
        const onMsgError = () => {
          cleanup();
          reject(new Error('Worker communication error'));
        };

        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onMsgError);
        worker.postMessage(req, transfer);
      });
    },
    [addLog]
  );

  const extractJpegFromWorkerResult = useCallback(
    async (res: ProcessPageSuccess, quality: number): Promise<Blob> => {
      if (res.warpedJpegBlob) return res.warpedJpegBlob;
      if (res.warpedBuffer && res.warpedWidth && res.warpedHeight) {
        const t0 = performance.now();
        const blob = await encodeRgbaToJpegBlob(
          res.warpedBuffer,
          res.warpedWidth,
          res.warpedHeight,
          quality
        );
        addLog(
          `Main-thread JPEG encode (${Math.round(blob.size / 1024)} KB) done in ${Math.round(
            performance.now() - t0
          )} ms`,
          'done'
        );
        return blob;
      }
      throw new Error('Missing processed image output');
    },
    [addLog]
  );

  /**
   * Prompt the user with ManualCornerModal during capture when confidence is low
   * (or when Always Confirm is enabled), returning adjusted corners or `null` if discarded.
   */
  const promptManualCorners = (draft: ManualCornerDraft): Promise<QuadCorners | null> => {
    return new Promise((resolve) => {
      manualResolveRef.current = resolve;
      setManualDraft(draft);
    });
  };

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0 || stage !== 'idle') return;
    setErrorMsg(null);
    setEditToast(null);
    void requestPersistentStorage();
    addLog(`Capture batch started (${files.length} file${files.length === 1 ? '' : 's'})`, 'info');

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const tFileStart = performance.now();
        setBatchProgress({ current: i + 1, total: files.length });

        // 1. Read EXIF header + decode upright bounded bitmap
        setStage('preparing');
        addLog(
          `[${i + 1}/${files.length}] Reading JPEG/EXIF header & decoding (cap ${settings.maxInputLongEdge}px)…`,
          'info'
        );
        const tDec0 = performance.now();
        const decoded = await decodeBoundedPhoto(file, settings.maxInputLongEdge);
        addLog(
          `Decoded upright ${decoded.workingWidth}×${decoded.workingHeight} (EXIF ${
            decoded.header.orientation
          }${
            decoded.header.rawWidth
              ? `, raw ${decoded.header.rawWidth}×${decoded.header.rawHeight}`
              : ''
          }) in ${Math.round(performance.now() - tDec0)} ms`,
          'done'
        );

        const workingBuf = decoded.workingRgba.buffer.slice(0) as ArrayBuffer;
        const inferBuf = decoded.inferRgba.buffer.slice(0) as ArrayBuffer;

        // 2. Run WASM DocAligner detection (and perspective warp if confident & not always-confirm)
        setStage('detecting');
        const jobId = `page-${Date.now()}-${i}`;
        const forcePromptAfterDetect = settings.postSaveBehavior === 'always-confirm';

        const detectRes = await runWorkerJob(
          {
            type: 'process',
            jobId,
            workingWidth: decoded.workingWidth,
            workingHeight: decoded.workingHeight,
            workingBuffer: workingBuf,
            inferBuffer: inferBuf,
            confidenceThreshold: settings.confidenceThreshold,
            maxOutputLongEdge: settings.maxOutputLongEdge,
            jpegQuality: settings.jpegQuality,
            alwaysWarp: false,
          },
          [workingBuf, inferBuf]
        );

        let finalBlob: Blob;
        let finalWidth: number;
        let finalHeight: number;
        let finalCorners = detectRes.corners;

        if (detectRes.lowConfidence || forcePromptAfterDetect) {
          const reason = detectRes.lowConfidence
            ? `Low confidence (${detectRes.confidence.toFixed(2)} < ${settings.confidenceThreshold.toFixed(2)})`
            : 'Always-confirm mode active';
          addLog(`${reason} — opening 4-corner editor`, 'warn');

          const seedCorners = detectRes.geometryValid
            ? detectRes.corners
            : makeDefaultInsetCorners(decoded.workingWidth, decoded.workingHeight);

          await saveDraftSource({
            targetPageId: null,
            blob: decoded.workingJpegBlob,
            workingWidth: decoded.workingWidth,
            workingHeight: decoded.workingHeight,
            corners: seedCorners,
            confidence: detectRes.confidence,
          });
          addLog('Saved draftSource to IndexedDB before manual review', 'info');

          const chosenCorners = await promptManualCorners({
            targetPageId: null,
            blob: decoded.workingJpegBlob,
            workingWidth: decoded.workingWidth,
            workingHeight: decoded.workingHeight,
            initialCorners: seedCorners,
            confidence: detectRes.confidence,
            isLowConfidenceSafetyNet: detectRes.lowConfidence,
          });

          if (!chosenCorners) {
            addLog(`Photo ${i + 1}/${files.length} discarded by user`, 'warn');
            continue;
          }

          setStage('straightening');
          addLog('Applying confirmed 4-corner perspective warp…', 'info');
          const rewarp = await decodeDraftSourceForWarp(decoded.workingJpegBlob);
          const manualBuf = rewarp.workingRgba.buffer.slice(0) as ArrayBuffer;
          const warpRes = await runWorkerJob(
            {
              type: 'process',
              jobId: `${jobId}-manual`,
              workingWidth: rewarp.workingWidth,
              workingHeight: rewarp.workingHeight,
              workingBuffer: manualBuf,
              manualCorners: chosenCorners,
              maxOutputLongEdge: settings.maxOutputLongEdge,
              jpegQuality: settings.jpegQuality,
            },
            [manualBuf]
          );

          finalBlob = await extractJpegFromWorkerResult(warpRes, settings.jpegQuality);
          finalWidth = warpRes.warpedWidth || rewarp.workingWidth;
          finalHeight = warpRes.warpedHeight || rewarp.workingHeight;
          finalCorners = chosenCorners;
        } else {
          setStage('straightening');
          finalBlob = await extractJpegFromWorkerResult(detectRes, settings.jpegQuality);
          finalWidth = detectRes.warpedWidth || decoded.workingWidth;
          finalHeight = detectRes.warpedHeight || decoded.workingHeight;
        }

        // 3. Commit immediately to IndexedDB
        setStage('saving');
        addLog(`Saving ${finalWidth}×${finalHeight} JPEG to IndexedDB…`, 'info');
        const pageId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const saved = await addPage({
          id: pageId,
          blob: finalBlob,
          width: finalWidth,
          height: finalHeight,
          createdAt: Date.now(),
          confidence: detectRes.confidence,
          corners: finalCorners,
        });

        await saveDraftSource({
          targetPageId: saved.id,
          blob: decoded.workingJpegBlob,
          workingWidth: decoded.workingWidth,
          workingHeight: decoded.workingHeight,
          corners: finalCorners,
          confidence: detectRes.confidence,
        });

        let updatedCount = 0;
        setPages((prev) => {
          const next = [...prev, saved].sort((a, b) => a.order - b.order);
          updatedCount = next.length;
          return next;
        });

        addLog(
          `Page ${String(updatedCount).padStart(2, '0')} committed (${Math.round(
            finalBlob.size / 1024
          )} KB) · total ${Math.round(performance.now() - tFileStart)} ms`,
          'done'
        );

        if (!detectRes.lowConfidence && settings.postSaveBehavior === 'toast') {
          showCornerToast(saved.id, updatedCount, settings.toastDurationSec);
        }
      }
      setCurrentActivity('Idle · Ready to scan');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to process photo';
      setErrorMsg(msg);
      addLog(`Capture error: ${msg}`, 'error');
    } finally {
      setBatchProgress(null);
      setStage('idle');
    }
  };

  /**
   * When the user taps "Adjust corners" on the brief toast, read `draftSource` back from
   * IndexedDB on demand (never held in React state during capture).
   */
  const handleOpenToastCornerAdjust = async () => {
    if (!editToast || stage !== 'idle') return;
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    const targetId = editToast.pageId;
    setEditToast(null);
    addLog('Loading draftSource from IndexedDB for corner adjustment…', 'info');

    try {
      const draft = await getDraftSource();
      if (!draft || draft.targetPageId !== targetId) {
        setErrorMsg('Original capture draft is no longer available to adjust.');
        addLog('Draft source unavailable in IndexedDB', 'warn');
        return;
      }
      setManualDraft({
        targetPageId: targetId,
        blob: draft.blob,
        workingWidth: draft.workingWidth,
        workingHeight: draft.workingHeight,
        initialCorners: draft.corners,
        confidence: draft.confidence,
        isLowConfidenceSafetyNet: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not load draft for editing';
      setErrorMsg(msg);
      addLog(`Draft load failed: ${msg}`, 'error');
    }
  };

  const handleManualConfirm = async (corners: QuadCorners) => {
    if (manualResolveRef.current) {
      const resolve = manualResolveRef.current;
      manualResolveRef.current = null;
      setManualDraft(null);
      resolve(corners);
      return;
    }

    if (!manualDraft || !manualDraft.targetPageId) {
      setManualDraft(null);
      return;
    }

    setIsApplyingManual(true);
    addLog('Re-warping saved page from adjusted corners…', 'info');
    try {
      const rewarp = await decodeDraftSourceForWarp(manualDraft.blob);
      const buf = rewarp.workingRgba.buffer.slice(0) as ArrayBuffer;
      const warpRes = await runWorkerJob(
        {
          type: 'process',
          jobId: `rewarp-${Date.now()}`,
          workingWidth: rewarp.workingWidth,
          workingHeight: rewarp.workingHeight,
          workingBuffer: buf,
          manualCorners: corners,
          maxOutputLongEdge: settings.maxOutputLongEdge,
          jpegQuality: settings.jpegQuality,
        },
        [buf]
      );

      const newBlob = await extractJpegFromWorkerResult(warpRes, settings.jpegQuality);
      const newW = warpRes.warpedWidth || rewarp.workingWidth;
      const newH = warpRes.warpedHeight || rewarp.workingHeight;

      const updatedPage = await updatePageImage(manualDraft.targetPageId, {
        blob: newBlob,
        width: newW,
        height: newH,
        corners,
        confidence: 1,
      });

      await saveDraftSource({
        targetPageId: manualDraft.targetPageId,
        blob: manualDraft.blob,
        workingWidth: manualDraft.workingWidth,
        workingHeight: manualDraft.workingHeight,
        corners,
        confidence: 1,
      });

      if (updatedPage) {
        setPages((prev) =>
          prev.map((p) => (p.id === updatedPage.id ? updatedPage : p))
        );
      }
      setManualDraft(null);
      addLog(`Updated page (${newW}×${newH}, ${Math.round(newBlob.size / 1024)} KB)`, 'done');
      setCurrentActivity('Idle · Ready to scan');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to straighten page';
      setErrorMsg(msg);
      addLog(`Re-warp failed: ${msg}`, 'error');
    } finally {
      setIsApplyingManual(false);
    }
  };

  const handleManualCancel = () => {
    if (manualResolveRef.current) {
      const resolve = manualResolveRef.current;
      manualResolveRef.current = null;
      setManualDraft(null);
      resolve(null);
      return;
    }
    setManualDraft(null);
    addLog('Cancelled corner adjustment', 'info');
  };

  const handleMovePage = async (id: string, direction: -1 | 1) => {
    const updatedMetas = await movePage(id, direction);
    setPages((prev) => {
      const blobMap = new Map(prev.map((p) => [p.id, p.blob]));
      return updatedMetas
        .map((m) => {
          const blob = blobMap.get(m.id);
          return blob ? { ...m, blob } : null;
        })
        .filter((x): x is SavedPageRecord => x !== null);
    });
    addLog(`Moved page ${direction === -1 ? 'earlier' : 'later'} in book order`, 'done');
  };

  const handleDeletePage = async (id: string) => {
    const remainingMetas = await deletePage(id);
    setPages((prev) => {
      const blobMap = new Map(prev.map((p) => [p.id, p.blob]));
      return remainingMetas
        .map((m) => {
          const blob = blobMap.get(m.id);
          return blob ? { ...m, blob } : null;
        })
        .filter((x): x is SavedPageRecord => x !== null);
    });
    if (editToast?.pageId === id) {
      setEditToast(null);
    }
    addLog(`Deleted page (${remainingMetas.length} remaining)`, 'done');
  };

  const handleConfirmClearAll = async () => {
    await clearAllBookData();
    setPages([]);
    setEditToast(null);
    setShowClearModal(false);
    addLog('Cleared all pages & draftSource from IndexedDB', 'done');
    setCurrentActivity('Idle · Ready to scan');
  };

  const previewIndex = previewPage
    ? pages.findIndex((p) => p.id === previewPage.id)
    : -1;

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#F3F4F6] flex flex-col">
      {/* Compact Sticky Top Bar (<= 56px, within mobile sticky cap) */}
      <header className="sticky top-0 z-30 bg-[#0B0D10]/90 backdrop-blur-md border-b border-white/10 pt-safe">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between gap-3">
          <span className="text-lg font-bold tracking-tight whitespace-nowrap shrink-0">
            📖 wakes
          </span>

          <div className="flex items-center gap-1.5 shrink-0">
            <WakeLockBadge wakeLock={wakeLock} />
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => setShowSettingsModal(true)}
              aria-label="Settings"
              title="Settings"
              className="min-h-[44px] min-w-[44px] rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-base flex items-center justify-center shrink-0 active:scale-[0.97] transition"
            >
              ⚙️
            </button>
          </div>
        </div>
      </header>

      {/* Non-intrusive Prompted Update Banner */}
      {updateReady && (
        <div className="bg-amber-500 text-neutral-950 px-4 py-2 text-xs sm:text-sm font-medium flex items-center justify-between gap-3">
          <span>✨ New version available — update when you finish this page.</span>
          <button
            type="button"
            onClick={() => void updateSWRef.current?.(true)}
            className="min-h-[36px] px-3 rounded-lg bg-neutral-950 text-amber-400 font-semibold text-xs whitespace-nowrap shrink-0"
          >
            Update
          </button>
        </div>
      )}

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-5 pb-28 space-y-4">
        {/* Live Verbose Activity Panel (shown when Verbose Mode is enabled in Settings) */}
        {settings.verboseMode && (
          <VerboseLogPanel
            currentActivity={currentActivity}
            entries={verboseLogs}
            onClear={() => setVerboseLogs([])}
          />
        )}

        {errorMsg && (
          <div className="rounded-2xl bg-red-500/15 border border-red-500/30 px-4 py-3 text-sm text-red-200 flex items-center justify-between gap-3">
            <span>⚠️ {errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-xs font-semibold text-red-200 underline whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        <PageQueue
          pages={pages}
          isLoading={isLoadingStore}
          isLocked={stage !== 'idle'}
          onPreview={setPreviewPage}
          onMove={handleMovePage}
          onDelete={handleDeletePage}
          onRequestClearAll={() => setShowClearModal(true)}
        />
      </main>

      {/* Brief Post-Save Corner-Edit Toast */}
      {editToast && stage === 'idle' && (
        <div className="fixed bottom-24 left-4 right-4 z-40 max-w-md mx-auto pointer-events-none">
          <div className="pointer-events-auto rounded-2xl bg-[#15181E]/95 backdrop-blur-md border border-amber-500/35 px-4 py-2.5 shadow-2xl flex items-center justify-between gap-3">
            <span className="text-xs sm:text-sm text-neutral-100 font-medium truncate">
              ✅ Page {String(editToast.pageNumber).padStart(2, '0')} saved
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleOpenToastCornerAdjust()}
                className="min-h-[38px] px-3 rounded-xl bg-amber-500 text-neutral-950 font-semibold text-xs whitespace-nowrap active:scale-95 transition"
              >
                ✂️ Adjust corners
              </button>
              <button
                type="button"
                aria-label="Dismiss toast"
                onClick={() => setEditToast(null)}
                className="min-h-[38px] min-w-[38px] rounded-xl text-neutral-400 hover:text-white text-xs flex items-center justify-center"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Non-intrusive Offline Toast */}
      {!isOnline && (
        <div className="fixed top-16 right-4 z-30 rounded-xl bg-[#15181E]/95 border border-white/10 px-3 py-1.5 text-xs text-neutral-300 shadow-lg pointer-events-none">
          ✈️ Offline Mode — Saved locally
        </div>
      )}

      {/* Thumb-Zone Bottom Capture & Export Bar */}
      <CaptureBar
        stage={stage}
        batchProgress={batchProgress}
        pageCount={pages.length}
        onBeforeCapture={() => void wakeLock.ensureOnGesture()}
        onFilesSelected={(selected) => void handleFilesSelected(selected)}
        onOpenExport={() => setShowExportModal(true)}
      />

      {/* Settings Modal */}
      {showSettingsModal && (
        <SettingsModal
          settings={settings}
          onChange={handleSettingsChange}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

      {/* Manual 4-Corner Drag Overlay (Safety Net & Toast Adjust) */}
      {manualDraft && (
        <ManualCornerModal
          draft={manualDraft}
          isApplying={isApplyingManual}
          onConfirm={(c) => void handleManualConfirm(c)}
          onCancel={handleManualCancel}
        />
      )}

      {/* Full-Screen Page Preview Modal */}
      {previewPage && previewIndex !== -1 && (
        <PagePreviewModal
          page={previewPage}
          pageNumber={previewIndex + 1}
          onClose={() => setPreviewPage(null)}
          onDelete={(id) => void handleDeletePage(id)}
        />
      )}

      {/* Two-Step PDF Export Modal */}
      {showExportModal && (
        <ExportModal
          pages={pages}
          onLog={addLog}
          onClose={() => setShowExportModal(false)}
        />
      )}

      {/* New Book / Clear All Confirmation Dialog */}
      {showClearModal && (
        <ConfirmClearModal
          pageCount={pages.length}
          onConfirm={() => void handleConfirmClearAll()}
          onCancel={() => setShowClearModal(false)}
        />
      )}
    </div>
  );
}
