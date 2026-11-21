import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Point2D, QuadCorners } from '../utils/docalignerMath';

export interface ManualCornerDraft {
  /** Non-null when adjusting an already-saved page from the post-save toast */
  targetPageId: string | null;
  blob: Blob;
  workingWidth: number;
  workingHeight: number;
  initialCorners: QuadCorners;
  confidence: number;
  isLowConfidenceSafetyNet: boolean;
}

interface ManualCornerModalProps {
  draft: ManualCornerDraft;
  isApplying: boolean;
  onConfirm: (corners: QuadCorners) => void;
  onCancel: () => void;
}

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const;

function fallbackInsetCorners(w: number, h: number): QuadCorners {
  const mx = w * 0.08;
  const my = h * 0.08;
  return [
    { x: mx, y: my },
    { x: w - mx, y: my },
    { x: w - mx, y: h - my },
    { x: mx, y: h - my },
  ];
}

/**
 * Interactive 4-corner drag overlay with a zoomed loupe magnifier for iPhone touch accuracy.
 * Uses Retina-scaled HTML5 Canvas (zero inline SVG) and cleans up its bitmap/canvases on close.
 */
export const ManualCornerModal: React.FC<ManualCornerModalProps> = ({
  draft,
  isApplying,
  onConfirm,
  onCancel,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);

  const [corners, setCorners] = useState<QuadCorners>(draft.initialCorners);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [canvasLayout, setCanvasLayout] = useState<{
    width: number;
    height: number;
    scale: number;
  }>({ width: 320, height: 420, scale: 0.2 });

  // Decode draft blob once into an ImageBitmap for fast 60fps drag redraws; close on unmount
  useEffect(() => {
    let cancelled = false;
    createImageBitmap(draft.blob)
      .then((bmp) => {
        if (cancelled) {
          bmp.close();
          return;
        }
        bitmapRef.current = bmp;
        redraw();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (bitmapRef.current) {
        bitmapRef.current.close();
        bitmapRef.current = null;
      }
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      if (loupeCanvasRef.current) {
        loupeCanvasRef.current.width = 0;
        loupeCanvasRef.current.height = 0;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.blob]);

  // Measure available stage container and compute fit scale
  const updateLayout = useCallback(() => {
    const box = containerRef.current;
    if (!box) return;
    const maxW = Math.max(200, box.clientWidth - 16);
    const maxH = Math.max(240, box.clientHeight - 16);
    const scale = Math.min(maxW / draft.workingWidth, maxH / draft.workingHeight);
    setCanvasLayout({
      width: Math.round(draft.workingWidth * scale),
      height: Math.round(draft.workingHeight * scale),
      scale,
    });
  }, [draft.workingWidth, draft.workingHeight]);

  useEffect(() => {
    updateLayout();
    window.addEventListener('resize', updateLayout);
    return () => window.removeEventListener('resize', updateLayout);
  }, [updateLayout]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const bmp = bitmapRef.current;
    if (!canvas || !bmp) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height, scale } = canvasLayout;
    if (width <= 0 || height <= 0) return;

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // 1. Draw the upright photo
    ctx.drawImage(bmp, 0, 0, width, height);

    // 2. Darken area outside the selected quadrilateral using even-odd fill rule
    const pts = corners.map((pt) => ({ x: pt.x * scale, y: pt.y * scale }));
    ctx.fillStyle = 'rgba(11, 13, 16, 0.58)';
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.closePath();
    ctx.fill('evenodd');

    // 3. Draw crisp amber quadrilateral border
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.closePath();
    ctx.stroke();

    // 4. Draw corner handles and labels
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    pts.forEach((p, idx) => {
      const isActive = idx === activeIndex;
      const radius = isActive ? 15 : 12;

      // Outer touch halo
      ctx.fillStyle = isActive ? 'rgba(245, 158, 11, 0.35)' : 'rgba(245, 158, 11, 0.2)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 7, 0, Math.PI * 2);
      ctx.fill();

      // Solid handle circle
      ctx.fillStyle = isActive ? '#fbbf24' : '#f59e0b';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#0b0d10';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#0b0d10';
      ctx.fillText(CORNER_LABELS[idx], p.x, p.y + 0.5);
    });

    ctx.restore();

    // 5. Update magnified circular loupe when dragging a corner
    if (activeIndex !== null && loupeCanvasRef.current) {
      const loupe = loupeCanvasRef.current;
      const lSize = 112;
      if (loupe.width !== lSize * dpr) {
        loupe.width = lSize * dpr;
        loupe.height = lSize * dpr;
      }
      const lCtx = loupe.getContext('2d');
      if (lCtx) {
        lCtx.save();
        lCtx.scale(dpr, dpr);
        lCtx.clearRect(0, 0, lSize, lSize);
        lCtx.fillStyle = '#0b0d10';
        lCtx.fillRect(0, 0, lSize, lSize);

        const target = corners[activeIndex];
        const cropRadius = 90; // pixels in working image space
        const sx = target.x - cropRadius;
        const sy = target.y - cropRadius;
        const sw = cropRadius * 2;
        const sh = cropRadius * 2;

        // Draw zoomed region centered in loupe
        lCtx.drawImage(bmp, sx, sy, sw, sh, 0, 0, lSize, lSize);

        // Crosshair at exact corner coordinate
        const half = lSize * 0.5;
        lCtx.strokeStyle = '#f59e0b';
        lCtx.lineWidth = 1.5;
        lCtx.beginPath();
        lCtx.moveTo(half - 14, half);
        lCtx.lineTo(half + 14, half);
        lCtx.moveTo(half, half - 14);
        lCtx.lineTo(half, half + 14);
        lCtx.stroke();
        lCtx.restore();
      }
    }
  }, [activeIndex, canvasLayout, corners]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const pointerToImagePoint = (clientX: number, clientY: number): Point2D => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * draft.workingWidth;
    const y = ((clientY - rect.top) / rect.height) * draft.workingHeight;
    return {
      x: Math.max(0, Math.min(draft.workingWidth, x)),
      y: Math.max(0, Math.min(draft.workingHeight, y)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isApplying) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Find closest corner handle within generous 48px touch radius
    let bestIdx = -1;
    let bestDist = 48;
    corners.forEach((c, idx) => {
      const cx = c.x * canvasLayout.scale;
      const cy = c.y * canvasLayout.scale;
      const d = Math.hypot(cx - px, cy - py);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    });

    if (bestIdx !== -1) {
      canvas.setPointerCapture(e.pointerId);
      setActiveIndex(bestIdx);
      const nextPt = pointerToImagePoint(e.clientX, e.clientY);
      setCorners((prev) => {
        const copy = [...prev] as QuadCorners;
        copy[bestIdx] = nextPt;
        return copy;
      });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeIndex === null || isApplying) return;
    const nextPt = pointerToImagePoint(e.clientX, e.clientY);
    setCorners((prev) => {
      const copy = [...prev] as QuadCorners;
      copy[activeIndex] = nextPt;
      return copy;
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeIndex !== null && canvasRef.current?.hasPointerCapture(e.pointerId)) {
      canvasRef.current.releasePointerCapture(e.pointerId);
    }
    setActiveIndex(null);
  };

  // Position loupe on the opposite top corner from the dragged point so thumb never obscures it
  const loupeOnRight = activeIndex !== null && corners[activeIndex].x < draft.workingWidth * 0.5;

  return (
    <div className="fixed inset-0 z-50 bg-[#0B0D10] flex flex-col pt-safe pb-safe">
      {/* Header */}
      <header className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-neutral-100 truncate">
            {draft.isLowConfidenceSafetyNet
              ? '✂️ Adjust Page Corners'
              : '✂️ Refine Page Corners'}
          </h2>
          <p className="text-xs text-neutral-400 truncate">
            {draft.isLowConfidenceSafetyNet
              ? 'Page edges were uncertain. Drag the 4 corners before saving.'
              : 'Drag any corner handle to fine-tune the crop.'}
          </p>
        </div>

        <button
          type="button"
          disabled={isApplying}
          onClick={() =>
            setCorners(fallbackInsetCorners(draft.workingWidth, draft.workingHeight))
          }
          className="min-h-[44px] px-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-neutral-200 whitespace-nowrap shrink-0"
        >
          Reset Frame
        </button>
      </header>

      {/* Canvas Drag Stage */}
      <div
        ref={containerRef}
        className="relative flex-1 flex items-center justify-center p-2 overflow-hidden touch-none select-none"
      >
        <canvas
          ref={canvasRef}
          style={{ width: canvasLayout.width, height: canvasLayout.height }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="rounded-xl shadow-2xl touch-none cursor-crosshair"
        />

        {/* Zoomed Magnifier Loupe */}
        {activeIndex !== null && (
          <div
            className={`absolute top-4 ${
              loupeOnRight ? 'right-4' : 'left-4'
            } w-28 h-28 rounded-full border-2 border-amber-400 shadow-2xl overflow-hidden pointer-events-none bg-[#0B0D10]`}
          >
            <canvas ref={loupeCanvasRef} className="w-full h-full" />
          </div>
        )}
      </div>

      {/* Bottom Action Bar */}
      <footer className="px-4 pt-3 border-t border-white/10 flex items-center gap-3">
        <button
          type="button"
          disabled={isApplying}
          onClick={onCancel}
          className="min-h-[50px] px-5 rounded-2xl bg-[#15181E] border border-white/15 text-neutral-200 font-medium text-sm whitespace-nowrap shrink-0 active:scale-[0.98] transition"
        >
          {draft.targetPageId ? 'Cancel' : 'Discard'}
        </button>

        <button
          type="button"
          disabled={isApplying}
          onClick={() => onConfirm(corners)}
          className="flex-1 min-h-[50px] rounded-2xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.98] transition"
        >
          <span>{isApplying ? '⏳ Straightening…' : '✅ Straighten & Save'}</span>
        </button>
      </footer>
    </div>
  );
};
