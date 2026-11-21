/**
 * iOS WebKit memory-hygienic photo intake & cleanup helpers.
 *
 * Key iOS Safari protections:
 * 1. Read ONLY the first 64 KB of a JPEG to parse raw SOF dimensions + EXIF Orientation (1–8).
 *    Knowing the true upright orientation upfront lets us pass a single `resizeWidth` OR
 *    `resizeHeight` to `createImageBitmap`, keeping aspect ratio and capping the long edge at 2600px.
 * 2. Check the decoded bitmap size; if Safari ignored resize options, downscale in one pass.
 * 3. Call `.close()` on every `ImageBitmap` and zero temporary canvases (`width = 0; height = 0`)
 *    immediately after extracting pixels so WebKit stays well below per-tab RAM limits.
 */

const MODEL_INFER_SIZE = 256;

export interface ImageHeaderInfo {
  rawWidth: number | null;
  rawHeight: number | null;
  orientation: number;
  uprightWidth: number | null;
  uprightHeight: number | null;
  isJpeg: boolean;
}

export interface BoundedPhotoBuffers {
  header: ImageHeaderInfo;
  workingWidth: number;
  workingHeight: number;
  workingRgba: Uint8ClampedArray;
  inferRgba: Uint8ClampedArray;
  workingJpegBlob: Blob;
}

export interface RewarpBuffers {
  workingWidth: number;
  workingHeight: number;
  workingRgba: Uint8ClampedArray;
}

/** Zero out a temporary canvas so WebKit releases its backing GPU/CPU buffer immediately. */
export function zeroCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

export function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode JPEG image'));
      },
      'image/jpeg',
      quality
    );
  });
}

/** Fallback JPEG encoder on main thread when worker OffscreenCanvas.convertToBlob is unavailable. */
export async function encodeRgbaToJpegBlob(
  rgbaBuffer: ArrayBuffer,
  width: number,
  height: number,
  quality = 0.88
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    zeroCanvas(canvas);
    throw new Error('Could not create canvas context for JPEG export');
  }
  const imageData = new ImageData(new Uint8ClampedArray(rgbaBuffer), width, height);
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvasToJpegBlob(canvas, quality);
  zeroCanvas(canvas);
  return blob;
}

/**
 * Parse JPEG SOF dimensions and EXIF Orientation tag (0x0112) from the first 64 KB.
 */
export async function readImageHeader(file: Blob): Promise<ImageHeaderInfo> {
  const slice = file.slice(0, 65536);
  const buffer = await slice.arrayBuffer();
  const view = new DataView(buffer);

  const info: ImageHeaderInfo = {
    rawWidth: null,
    rawHeight: null,
    orientation: 1,
    uprightWidth: null,
    uprightHeight: null,
    isJpeg: false,
  };

  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) {
    return info;
  }

  info.isJpeg = true;
  let offset = 2;

  while (offset + 4 <= view.byteLength) {
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) {
      offset++;
    }
    if (offset >= view.byteLength) break;

    const marker = view.getUint8(offset);
    offset++;

    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > view.byteLength) break;
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > view.byteLength) break;

    if (marker === 0xe1 && segmentLength >= 14) {
      const orient = parseExifOrientation(view, offset + 2, segmentLength - 2);
      if (orient !== null) info.orientation = orient;
    }

    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSof && segmentLength >= 7) {
      info.rawHeight = view.getUint16(offset + 3, false);
      info.rawWidth = view.getUint16(offset + 5, false);
    }

    offset += segmentLength;
    if (info.rawWidth !== null && info.orientation !== 1) break;
  }

  if (info.rawWidth !== null && info.rawHeight !== null) {
    // Orientations 5–8 rotate 90° or 270°, swapping width and height
    const swaps = info.orientation >= 5 && info.orientation <= 8;
    info.uprightWidth = swaps ? info.rawHeight : info.rawWidth;
    info.uprightHeight = swaps ? info.rawWidth : info.rawHeight;
  }

  return info;
}

function parseExifOrientation(view: DataView, start: number, length: number): number | null {
  if (length < 12) return null;
  if (
    view.getUint8(start) !== 0x45 ||
    view.getUint8(start + 1) !== 0x78 ||
    view.getUint8(start + 2) !== 0x69 ||
    view.getUint8(start + 3) !== 0x66 ||
    view.getUint8(start + 4) !== 0x00 ||
    view.getUint8(start + 5) !== 0x00
  ) {
    return null;
  }

  const tiffStart = start + 6;
  const endian = view.getUint16(tiffStart, false);
  const littleEndian = endian === 0x4949;
  if (!littleEndian && endian !== 0x4d4d) return null;

  const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
  const ifdStart = tiffStart + ifdOffset;
  if (ifdStart + 2 > start + length) return null;

  const entries = view.getUint16(ifdStart, littleEndian);
  for (let i = 0; i < entries; i++) {
    const entryOffset = ifdStart + 2 + i * 12;
    if (entryOffset + 12 > start + length) break;
    if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
      const value = view.getUint16(entryOffset + 8, littleEndian);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return null;
}

/**
 * Safely decode an incoming camera/library photo into:
 * - an upright bounded RGBA buffer (long edge <= 2600px)
 * - a stretched 256x256 RGBA buffer for DocAligner
 * - a compact JPEG blob of the working frame for IDB-only `draftSource`
 */
export async function decodeBoundedPhoto(
  file: Blob,
  maxLongEdge = 2600
): Promise<BoundedPhotoBuffers> {
  const header = await readImageHeader(file);

  const bitmapOptions: ImageBitmapOptions = {
    imageOrientation: 'from-image',
    resizeQuality: 'high',
  };

  if (header.uprightWidth !== null && header.uprightHeight !== null) {
    const longEdge = Math.max(header.uprightWidth, header.uprightHeight);
    if (longEdge > maxLongEdge) {
      if (header.uprightWidth >= header.uprightHeight) {
        bitmapOptions.resizeWidth = maxLongEdge;
      } else {
        bitmapOptions.resizeHeight = maxLongEdge;
      }
    }
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, bitmapOptions);
  } catch {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  }

  let workingWidth = bitmap.width;
  let workingHeight = bitmap.height;
  const actualLongEdge = Math.max(workingWidth, workingHeight);
  if (actualLongEdge > maxLongEdge) {
    const scale = maxLongEdge / actualLongEdge;
    workingWidth = Math.max(1, Math.round(workingWidth * scale));
    workingHeight = Math.max(1, Math.round(workingHeight * scale));
  }

  const workCanvas = document.createElement('canvas');
  workCanvas.width = workingWidth;
  workCanvas.height = workingHeight;
  const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
  if (!workCtx) {
    bitmap.close();
    zeroCanvas(workCanvas);
    throw new Error('Could not initialize working canvas');
  }

  workCtx.drawImage(bitmap, 0, 0, workingWidth, workingHeight);
  bitmap.close();

  const workingRgba = workCtx.getImageData(0, 0, workingWidth, workingHeight).data;
  const workingJpegBlob = await canvasToJpegBlob(workCanvas, 0.91);

  const inferCanvas = document.createElement('canvas');
  inferCanvas.width = MODEL_INFER_SIZE;
  inferCanvas.height = MODEL_INFER_SIZE;
  const inferCtx = inferCanvas.getContext('2d', { willReadFrequently: true });
  if (!inferCtx) {
    zeroCanvas(workCanvas);
    zeroCanvas(inferCanvas);
    throw new Error('Could not initialize inference canvas');
  }

  inferCtx.drawImage(workCanvas, 0, 0, MODEL_INFER_SIZE, MODEL_INFER_SIZE);
  const inferRgba = inferCtx.getImageData(0, 0, MODEL_INFER_SIZE, MODEL_INFER_SIZE).data;

  zeroCanvas(workCanvas);
  zeroCanvas(inferCanvas);

  return {
    header,
    workingWidth,
    workingHeight,
    workingRgba,
    inferRgba,
    workingJpegBlob,
  };
}

/**
 * Decode an already-upright bounded `draftSource` JPEG blob back into RGBA pixels
 * when the user confirms manual 4-corner adjustments.
 */
export async function decodeDraftSourceForWarp(blob: Blob): Promise<RewarpBuffers> {
  const bitmap = await createImageBitmap(blob);
  const workingWidth = bitmap.width;
  const workingHeight = bitmap.height;

  const canvas = document.createElement('canvas');
  canvas.width = workingWidth;
  canvas.height = workingHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    zeroCanvas(canvas);
    throw new Error('Could not decode draft source image');
  }

  ctx.drawImage(bitmap, 0, 0, workingWidth, workingHeight);
  bitmap.close();

  const workingRgba = ctx.getImageData(0, 0, workingWidth, workingHeight).data;
  zeroCanvas(canvas);

  return { workingWidth, workingHeight, workingRgba };
}
