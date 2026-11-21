import { PDFDocument } from 'pdf-lib';
import type { SavedPageRecord } from '../db/pageStore';

export interface BuiltPdfResult {
  file: File;
  pageCount: number;
  sizeBytes: number;
  buildMs: number;
}

/**
 * Build a multi-page PDF sequentially from stored JPEG blobs using pdf-lib.
 *
 * - Reads raw JPEG bytes directly (`embedJpg`) without re-decoding through a canvas.
 * - Matches each PDF page's dimensions to its exact cropped image aspect ratio.
 * - Returns a `File` ready for a fresh user tap on "Share PDF" (so iOS Safari's
 *   transient user-gesture requirement for `navigator.share` never times out).
 */
export async function buildBookPdf(
  pages: SavedPageRecord[],
  bookTitle: string,
  onProgress?: (current: number, total: number) => void
): Promise<BuiltPdfResult> {
  if (pages.length === 0) {
    throw new Error('Add at least one page before exporting');
  }

  const t0 = performance.now();
  const pdfDoc = await PDFDocument.create();
  const cleanTitle = sanitizeFilename(bookTitle || 'wakes-book');
  pdfDoc.setTitle(cleanTitle);
  pdfDoc.setCreator('wakes');

  // 612pt = 8.5 inches base width; height scales dynamically to preserve exact cropped ratio
  const BASE_WIDTH_PT = 612;

  for (let i = 0; i < pages.length; i++) {
    const pageRecord = pages[i];
    const jpgBytes = new Uint8Array(await pageRecord.blob.arrayBuffer());
    const embeddedJpg = await pdfDoc.embedJpg(jpgBytes);

    const aspect = embeddedJpg.height / embeddedJpg.width;
    const pageWidth = BASE_WIDTH_PT;
    const pageHeight = BASE_WIDTH_PT * aspect;

    const pdfPage = pdfDoc.addPage([pageWidth, pageHeight]);
    pdfPage.drawImage(embeddedJpg, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
    });

    onProgress?.(i + 1, pages.length);
  }

  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength
  ) as ArrayBuffer;

  const file = new File([pdfBuffer], `${cleanTitle}.pdf`, {
    type: 'application/pdf',
  });

  return {
    file,
    pageCount: pages.length,
    sizeBytes: file.size,
    buildMs: performance.now() - t0,
  };
}

/**
 * Trigger iOS Share Sheet ("Save to Files") from a direct user button tap,
 * falling back to standard `<a download>` when Web Share for files isn't supported.
 */
export async function shareOrDownloadPdf(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const sharePayload: ShareData = {
    files: [file],
    title: file.name,
  };

  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare(sharePayload)) {
    try {
      await navigator.share(sharePayload);
      return 'shared';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall through to standard file download on share error
    }
  }

  downloadPdfFile(file);
  return 'downloaded';
}

export function downloadPdfFile(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function sanitizeFilename(input: string): string {
  const trimmed = input.trim().replace(/\.pdf$/i, '');
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._ -]/g, '').replace(/\s+/g, '-');
  return cleaned || 'wakes-book';
}
