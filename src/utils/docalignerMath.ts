/**
 * Verified DocAligner preprocessing, heatmap corner decoding, and flat perspective warp.
 *
 * Verified directly against DocsaidLab/DocAligner (`docaligner/heatmap_reg/infer.py`):
 * - Input shape:  [1, 3, 256, 256] float32 ("img")
 * - Resize:       Direct stretch to 256x256 (no letterbox padding when do_center_crop=False)
 * - Color order:  BGR (OpenCV convention used by capybara/DocAligner)
 * - Normalization: pixel / 255.0 -> [0.0, 1.0]
 * - Output shape: [1, 4, 128, 128] float32 ("heatmap"), no extra score outputs
 */

export interface Point2D {
  x: number;
  y: number;
}

/** Ordered corners: [topLeft, topRight, bottomRight, bottomLeft] */
export type QuadCorners = [Point2D, Point2D, Point2D, Point2D];

export interface DecodedCornersResult {
  corners: QuadCorners;
  /** Peak heatmap value (0..~1) for each of the 4 channels */
  peaks: [number, number, number, number];
  /** Minimum of the 4 corner peak strengths; used for the low-confidence threshold */
  confidence: number;
  /** True when corners form a valid non-degenerate convex quad */
  geometryValid: boolean;
}

export const MODEL_INPUT_SIZE = 256;
export const HEATMAP_SIZE = 128;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.45;

/**
 * Convert a 256x256 RGBA buffer into NCHW float32 BGR tensor [1, 3, 256, 256] in [0, 1].
 */
export function rgba256ToBgrTensor(rgba: Uint8ClampedArray): Float32Array {
  const planeSize = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const tensor = new Float32Array(3 * planeSize);
  const inv255 = 1 / 255;

  for (let i = 0; i < planeSize; i++) {
    const px = i * 4;
    // BGR channel order: channel 0 = B, channel 1 = G, channel 2 = R
    tensor[i] = rgba[px + 2] * inv255;
    tensor[planeSize + i] = rgba[px + 1] * inv255;
    tensor[2 * planeSize + i] = rgba[px] * inv255;
  }

  return tensor;
}

/**
 * Decode [1, 4, 128, 128] heatmaps into [topLeft, topRight, bottomRight, bottomLeft]
 * coordinates in the working photo's pixel space.
 */
export function decodeHeatmapsToCorners(
  heatmapData: Float32Array,
  workingWidth: number,
  workingHeight: number
): DecodedCornersResult {
  const planeSize = HEATMAP_SIZE * HEATMAP_SIZE;
  const rawPoints: Point2D[] = [];
  const peaks: number[] = [];

  for (let ch = 0; ch < 4; ch++) {
    const offset = ch * planeSize;

    // 1. Locate strongest activation peak in this channel
    let maxVal = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < planeSize; i++) {
      const v = heatmapData[offset + i];
      if (v > maxVal) {
        maxVal = v;
        maxIdx = i;
      }
    }

    const peakY = Math.floor(maxIdx / HEATMAP_SIZE);
    const peakX = maxIdx % HEATMAP_SIZE;
    peaks.push(maxVal);

    // 2. Refine sub-pixel location with a weighted centroid inside a local radius
    //    around the peak, ignoring faint stray reflections elsewhere in the frame.
    const radius = 6;
    const localThresh = Math.max(0.25, maxVal * 0.5);
    const xStart = Math.max(0, peakX - radius);
    const xEnd = Math.min(HEATMAP_SIZE - 1, peakX + radius);
    const yStart = Math.max(0, peakY - radius);
    const yEnd = Math.min(HEATMAP_SIZE - 1, peakY + radius);

    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = yStart; y <= yEnd; y++) {
      for (let x = xStart; x <= xEnd; x++) {
        const w = heatmapData[offset + y * HEATMAP_SIZE + x];
        if (w >= localThresh) {
          sumW += w;
          sumX += x * w;
          sumY += y * w;
        }
      }
    }

    const cx = sumW > 0 ? sumX / sumW : peakX;
    const cy = sumW > 0 ? sumY / sumW : peakY;

    // 3. Map from 128x128 heatmap pixel centers back to upright working photo pixels
    const photoX = Math.max(0, Math.min(workingWidth, ((cx + 0.5) / HEATMAP_SIZE) * workingWidth));
    const photoY = Math.max(0, Math.min(workingHeight, ((cy + 0.5) / HEATMAP_SIZE) * workingHeight));

    rawPoints.push({ x: photoX, y: photoY });
  }

  const ordered = orderQuadCorners(rawPoints);
  const geometryValid = isValidConvexQuad(ordered, workingWidth, workingHeight);
  const minPeak = Math.min(...peaks);

  return {
    corners: ordered,
    peaks: [peaks[0], peaks[1], peaks[2], peaks[3]],
    confidence: geometryValid ? minPeak : Math.min(minPeak, 0.1),
    geometryValid,
  };
}

/**
 * Guarantee consistent [topLeft, topRight, bottomRight, bottomLeft] order
 * regardless of slight skew or channel swap.
 */
export function orderQuadCorners(pts: Point2D[]): QuadCorners {
  if (pts.length !== 4) {
    throw new Error(`Expected 4 corners, got ${pts.length}`);
  }

  // Sort by (x + y) -> smallest is Top-Left, largest is Bottom-Right
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];

  // Remaining two points: sort by (x - y) -> largest is Top-Right, smallest is Bottom-Left
  const remaining = [bySum[1], bySum[2]].sort((a, b) => b.x - b.y - (a.x - a.y));
  const tr = remaining[0];
  const bl = remaining[1];

  return [tl, tr, br, bl];
}

/**
 * Check that the 4 ordered corners form a convex quad covering at least 5% of the frame.
 */
export function isValidConvexQuad(
  quad: QuadCorners,
  frameW: number,
  frameH: number
): boolean {
  const [tl, tr, br, bl] = quad;
  const pts = [tl, tr, br, bl];

  // Check consistent winding via cross product signs
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-3) return false;
    const curSign = cross > 0 ? 1 : -1;
    if (sign === 0) sign = curSign;
    else if (sign !== curSign) return false;
  }

  // Shoelace area check
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % 4];
    area2 += p1.x * p2.y - p2.x * p1.y;
  }
  const area = Math.abs(area2) * 0.5;
  return area >= frameW * frameH * 0.05;
}

/**
 * Compute target output dimensions from the average opposite edge lengths of the quad,
 * scaling so the long edge targets ~maxOutputLongEdge (2400px).
 */
export function computeWarpedDimensions(
  corners: QuadCorners,
  maxOutputLongEdge = 2400
): { width: number; height: number } {
  const [tl, tr, br, bl] = corners;
  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);

  const avgW = Math.max(64, (topW + bottomW) * 0.5);
  const avgH = Math.max(64, (leftH + rightH) * 0.5);
  const longEdge = Math.max(avgW, avgH);

  // Target ~2400px long edge for high-res readable book pages
  const scale = maxOutputLongEdge / longEdge;
  return {
    width: Math.max(64, Math.round(avgW * scale)),
    height: Math.max(64, Math.round(avgH * scale)),
  };
}

/**
 * Solve 3x3 homography matrix H mapping dst (u, v) -> src (x, y) using Gaussian elimination.
 * Returns 9-element row-major matrix [h0..h8] with h8 = 1.
 */
export function solveHomographyDstToSrc(
  corners: QuadCorners,
  dstW: number,
  dstH: number
): Float64Array {
  const dstPts: QuadCorners = [
    { x: 0, y: 0 },
    { x: dstW - 1, y: 0 },
    { x: dstW - 1, y: dstH - 1 },
    { x: 0, y: dstH - 1 },
  ];

  // Build 8x9 augmented linear system A * h = b
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const u = dstPts[i].x;
    const v = dstPts[i].y;
    const x = corners[i].x;
    const y = corners[i].y;

    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }

  // Gaussian elimination with partial pivoting
  for (let col = 0; col < 8; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(A[col][col]);
    for (let r = col + 1; r < 8; r++) {
      const val = Math.abs(A[r][col]);
      if (val > maxAbs) {
        maxAbs = val;
        pivotRow = r;
      }
    }
    if (pivotRow !== col) {
      const tmp = A[col];
      A[col] = A[pivotRow];
      A[pivotRow] = tmp;
    }

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-10) {
      throw new Error('Degenerate homography matrix');
    }

    for (let c = col; c < 9; c++) {
      A[col][c] /= pivot;
    }

    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      for (let c = col; c < 9; c++) {
        A[r][c] -= factor * A[col][c];
      }
    }
  }

  return new Float64Array([
    A[0][8], A[1][8], A[2][8],
    A[3][8], A[4][8], A[5][8],
    A[6][8], A[7][8], 1,
  ]);
}

/**
 * Modular v1 flat perspective warp (seam kept clean for optional future curved dewarp).
 * Bilinearly samples natural photo colors into a new RGBA buffer.
 */
export function warpPerspectiveRgba(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  corners: QuadCorners,
  maxOutputLongEdge = 2400
): { rgba: Uint8ClampedArray; width: number; height: number } {
  const { width: dstW, height: dstH } = computeWarpedDimensions(corners, maxOutputLongEdge);
  const H = solveHomographyDstToSrc(corners, dstW, dstH);

  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7], h8 = H[8];

  const dstRgba = new Uint8ClampedArray(dstW * dstH * 4);
  const maxX = srcW - 1;
  const maxY = srcH - 1;

  for (let v = 0; v < dstH; v++) {
    const vH1 = h1 * v + h2;
    const vH4 = h4 * v + h5;
    const vH7 = h7 * v + h8;
    const rowOffset = v * dstW;

    for (let u = 0; u < dstW; u++) {
      const denom = h6 * u + vH7;
      const sx = (h0 * u + vH1) / denom;
      const sy = (h3 * u + vH4) / denom;

      // Clamp to source bounds
      const cx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
      const cy = sy < 0 ? 0 : sy > maxY ? maxY : sy;

      const x0 = cx | 0;
      const y0 = cy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;

      const fx = cx - x0;
      const fy = cy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const out = (rowOffset + u) * 4;
      dstRgba[out] = (srcRgba[i00] * w00 + srcRgba[i10] * w10 + srcRgba[i01] * w01 + srcRgba[i11] * w11 + 0.5) | 0;
      dstRgba[out + 1] = (srcRgba[i00 + 1] * w00 + srcRgba[i10 + 1] * w10 + srcRgba[i01 + 1] * w01 + srcRgba[i11 + 1] * w11 + 0.5) | 0;
      dstRgba[out + 2] = (srcRgba[i00 + 2] * w00 + srcRgba[i10 + 2] * w10 + srcRgba[i01 + 2] * w01 + srcRgba[i11 + 2] * w11 + 0.5) | 0;
      dstRgba[out + 3] = 255;
    }
  }

  return { rgba: dstRgba, width: dstW, height: dstH };
}
