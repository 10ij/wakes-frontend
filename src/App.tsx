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
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  type QuadCorners,
} from './utils/docalignerMath';
import {
  decodeBoundedPhoto,
  decodeDraftSourceForWarp,
  encodeRgbaToJpegBlob,
} from './utils/imageMemory';
import type {
  ProcessPageError,
  ProcessPageRequest,
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

export default function App() {
  const wakeLock = useWakeLock(true);
  const workerRef = useRef<Worker | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const manualResolveRef = useRef<((corners: QuadCorners | null) => void) | null>(null);

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

  // Rehydrate ordered pages from IndexedDB on load (survives iOS reloads/screen locks)
  useEffect(() => {
    let active = true;
    void requestPersistentStorage();

    getAllPages()
      .then((saved) => {
        if (active) {
          setPages(saved);
          setIsLoadingStore(false);
        }
      })
      .catch((err) => {
        if (active) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load saved pages');
          setIsLoadingStore(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  // Register prompt-based Service Worker + online/offline listener
  useEffect(() => {
    const updateSW = registerSW({
      onNeedRefresh() {
        setUpdateReady(true);
      },
    });
    updateSWRef.current = updateSW;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Initialize WASM Web Worker once
  useEffect(() => {
    const worker = new Worker(new URL('./workers/dewarp.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    return () => {
      worker.terminate();
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const showCornerToast = useCallback((pageId: string, pageNumber: number) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setEditToast({ pageId, pageNumber });
    toastTimerRef.current = window.setTimeout(() => {
      setEditToast(null);
      toastTimerRef.current = null;
    }, 6000);
  }, []);

  const runWorkerJob = useCallback((req: ProcessPageRequest, transfer: Transferable[]) => {
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
      const onMessage = (event: MessageEvent<ProcessPageSuccess | ProcessPageError>) => {
        if (event.data.jobId !== req.jobId) return;
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
  }, []);

  const extractJpegFromWorkerResult = async (res: ProcessPageSuccess): Promise<Blob> => {
    if (res.warpedJpegBlob) return res.warpedJpegBlob;
    if (res.warpedBuffer && res.warpedWidth && res.warpedHeight) {
      return encodeRgbaToJpegBlob(res.warpedBuffer, res.warpedWidth, res.warpedHeight, 0.88);
    }
    throw new Error('Missing processed image output');
  };

  /**
   * Prompt the user with ManualCornerModal during capture when confidence is low,
   * returning either adjusted corners or `null` if discarded.
   */
  const promptLowConfidenceCorners = (draft: ManualCornerDraft): Promise<QuadCorners | null> => {
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

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setBatchProgress({ current: i + 1, total: files.length });

        // 1. Read EXIF header + decode upright bounded bitmap (<=2600px)
        setStage('preparing');
        const decoded = await decodeBoundedPhoto(file, 2600);
        const workingBuf = decoded.workingRgba.buffer.slice(0) as ArrayBuffer;
        const inferBuf = decoded.inferRgba.buffer.slice(0) as ArrayBuffer;

        // 2. Run WASM DocAligner detection (and perspective warp if confident) in Web Worker
        setStage('detecting');
        const jobId = `page-${Date.now()}-${i}`;
        const detectRes = await runWorkerJob(
          {
            type: 'process',
            jobId,
            workingWidth: decoded.workingWidth,
            workingHeight: decoded.workingHeight,
            workingBuffer: workingBuf,
            inferBuffer: inferBuf,
            confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
            alwaysWarp: false,
          },
          [workingBuf, inferBuf]
        );

        let finalBlob: Blob;
        let finalWidth: number;
        let finalHeight: number;
        let finalCorners = detectRes.corners;

        if (detectRes.lowConfidence) {
          // Low-confidence safety net: keep draftSource in IDB and ask user to verify 4 corners
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

          const chosenCorners = await promptLowConfidenceCorners({
            targetPageId: null,
            blob: decoded.workingJpegBlob,
            workingWidth: decoded.workingWidth,
            workingHeight: decoded.workingHeight,
            initialCorners: seedCorners,
            confidence: detectRes.confidence,
            isLowConfidenceSafetyNet: true,
          });

          if (!chosenCorners) {
            continue; // User discarded this shot
          }

          setStage('straightening');
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
            },
            [manualBuf]
          );

          finalBlob = await extractJpegFromWorkerResult(warpRes);
          finalWidth = warpRes.warpedWidth || rewarp.workingWidth;
          finalHeight = warpRes.warpedHeight || rewarp.workingHeight;
          finalCorners = chosenCorners;
        } else {
          setStage('straightening');
          finalBlob = await extractJpegFromWorkerResult(detectRes);
          finalWidth = detectRes.warpedWidth || decoded.workingWidth;
          finalHeight = detectRes.warpedHeight || decoded.workingHeight;
        }

        // 3. Commit immediately to IndexedDB
        setStage('saving');
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

        // Store single draftSource strictly in IndexedDB (never React state) for optional toast edit
        await saveDraftSource({
          targetPageId: saved.id,
          blob: decoded.workingJpegBlob,
          workingWidth: decoded.workingWidth,
          workingHeight: decoded.workingHeight,
          corners: finalCorners,
          confidence: detectRes.confidence,
        });

        const nextPages = await getAllPages();
        setPages(nextPages);

        // Offer brief corner-edit toast on the saved page when confident
        if (!detectRes.lowConfidence) {
          showCornerToast(saved.id, nextPages.length);
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to process photo');
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

    try {
      const draft = await getDraftSource();
      if (!draft || draft.targetPageId !== targetId) {
        setErrorMsg('Original capture draft is no longer available to adjust.');
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
      setErrorMsg(err instanceof Error ? err.message : 'Could not load draft for editing');
    }
  };

  const handleManualConfirm = async (corners: QuadCorners) => {
    if (manualResolveRef.current) {
      // Resolving a paused low-confidence capture inside handleFilesSelected
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

    // Re-warping an already-saved page invoked from the post-save toast
    setIsApplyingManual(true);
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
        },
        [buf]
      );

      const newBlob = await extractJpegFromWorkerResult(warpRes);
      const newW = warpRes.warpedWidth || rewarp.workingWidth;
      const newH = warpRes.warpedHeight || rewarp.workingHeight;

      await updatePageImage(manualDraft.targetPageId, {
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

      setPages(await getAllPages());
      setManualDraft(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to straighten page');
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
  };

  const handleMovePage = async (id: string, direction: -1 | 1) => {
    const updated = await movePage(id, direction);
    setPages(updated);
  };

  const handleDeletePage = async (id: string) => {
    const updated = await deletePage(id);
    setPages(updated);
    if (editToast?.pageId === id) {
      setEditToast(null);
    }
  };

  const handleConfirmClearAll = async () => {
    await clearAllBookData();
    setPages([]);
    setEditToast(null);
    setShowClearModal(false);
  };

  const previewIndex = previewPage
    ? pages.findIndex((p) => p.id === previewPage.id)
    : -1;

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#F3F4F6] flex flex-col">
      {/* Compact Sticky Top Bar (<= 56px, within mobile sticky cap) */}
      <header className="sticky top-0 z-30 bg-[#0B0D10]/90 backdrop-blur-md border-b border-white/10 pt-safe">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between gap-4">
          <span className="text-lg font-bold tracking-tight whitespace-nowrap shrink-0">
            📖 wakes
          </span>

          <div className="flex items-center gap-2 shrink-0">
            <WakeLockBadge wakeLock={wakeLock} />
            <PWAInstallButton />
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
        <ExportModal pages={pages} onClose={() => setShowExportModal(false)} />
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
