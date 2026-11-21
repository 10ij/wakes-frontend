/// <reference lib="webworker" />
/**
 * WASM-only Web Worker for DocAligner corner detection + v1 perspective warp.
 *
 * Uses `onnxruntime-web/wasm` strictly with local `/ort/` assets (no CDN requests).
 * WebGPU is intentionally skipped in v1 to keep binary size and driver quirks minimal.
 */
import * as ort from 'onnxruntime-web/wasm';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  decodeHeatmapsToCorners,
  rgba256ToBgrTensor,
  warpPerspectiveRgba,
  type QuadCorners,
} from '../utils/docalignerMath';

export interface ModelInspectionInfo {
  inputNames: readonly string[];
  outputNames: readonly string[];
  numThreads: number;
  wasmPath: string;
}

export interface ProcessPageRequest {
  type: 'process';
  jobId: string;
  workingWidth: number;
  workingHeight: number;
  workingBuffer: ArrayBuffer;
  inferBuffer?: ArrayBuffer;
  manualCorners?: QuadCorners;
  confidenceThreshold?: number;
  alwaysWarp?: boolean;
}

export interface ProcessPageSuccess {
  type: 'result';
  jobId: string;
  corners: QuadCorners;
  peaks: [number, number, number, number];
  confidence: number;
  geometryValid: boolean;
  lowConfidence: boolean;
  inferenceMs: number;
  decodeCornerMs: number;
  warpMs: number;
  modelInfo: ModelInspectionInfo;
  warpedWidth?: number;
  warpedHeight?: number;
  warpedJpegBlob?: Blob;
  warpedBuffer?: ArrayBuffer;
}

export interface ProcessPageError {
  type: 'error';
  jobId: string;
  message: string;
}

let sessionPromise: Promise<{
  session: ort.InferenceSession;
  info: ModelInspectionInfo;
}> | null = null;

async function getSession(): Promise<{
  session: ort.InferenceSession;
  info: ModelInspectionInfo;
}> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // Point strictly to our local single-file WASM binary (zero CDN calls)
      ort.env.wasm.wasmPaths = {
        wasm: '/ort/ort-wasm-simd-threaded.wasm',
      };
      // Only use multi-threading when COOP/COEP headers enable crossOriginIsolated
      const numThreads = self.crossOriginIsolated
        ? Math.min(4, self.navigator?.hardwareConcurrency || 2)
        : 1;
      ort.env.wasm.numThreads = numThreads;

      const session = await ort.InferenceSession.create('/models/docaligner-lcnet100.onnx', {
        executionProviders: ['wasm'],
        enableCpuMemArena: false,
        enableMemPattern: false,
      });

      return {
        session,
        info: {
          inputNames: session.inputNames,
          outputNames: session.outputNames,
          numThreads,
          wasmPath: '/ort/ort-wasm-simd-threaded.wasm',
        },
      };
    })();
  }
  return sessionPromise;
}

async function encodeRgbaToJpegBlob(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  quality = 0.88
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.convertToBlob !== 'function') return null;
    const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  } catch {
    return null;
  }
}

self.onmessage = async (event: MessageEvent<ProcessPageRequest>) => {
  const req = event.data;
  if (req.type !== 'process') return;

  try {
    const { session, info } = await getSession();

    let corners: QuadCorners;
    let peaks: [number, number, number, number] = [1, 1, 1, 1];
    let confidence = 1;
    let geometryValid = true;
    let inferenceMs = 0;
    let decodeCornerMs = 0;

    if (req.manualCorners) {
      corners = req.manualCorners;
    } else {
      if (!req.inferBuffer) {
        throw new Error('Missing 256x256 inference buffer');
      }
      const inferRgba = new Uint8ClampedArray(req.inferBuffer);
      const tensorData = rgba256ToBgrTensor(inferRgba);
      const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, 256, 256]);

      const tInfer0 = performance.now();
      const outputs = await session.run({ [info.inputNames[0]]: inputTensor });
      inferenceMs = performance.now() - tInfer0;

      const heatmapTensor = outputs[info.outputNames[0]];
      const tDec0 = performance.now();
      const decoded = decodeHeatmapsToCorners(
        heatmapTensor.data as Float32Array,
        req.workingWidth,
        req.workingHeight
      );
      decodeCornerMs = performance.now() - tDec0;

      // Dispose ONNX tensors immediately after reading the output
      inputTensor.dispose();
      heatmapTensor.dispose();

      corners = decoded.corners;
      peaks = decoded.peaks;
      confidence = decoded.confidence;
      geometryValid = decoded.geometryValid;
    }

    const threshold = req.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const lowConfidence = !req.manualCorners && (!geometryValid || confidence < threshold);

    if (lowConfidence && !req.alwaysWarp) {
      const response: ProcessPageSuccess = {
        type: 'result',
        jobId: req.jobId,
        corners,
        peaks,
        confidence,
        geometryValid,
        lowConfidence: true,
        inferenceMs,
        decodeCornerMs,
        warpMs: 0,
        modelInfo: info,
      };
      self.postMessage(response);
      return;
    }

    const workingRgba = new Uint8ClampedArray(req.workingBuffer);
    const tWarp0 = performance.now();
    const warped = warpPerspectiveRgba(
      workingRgba,
      req.workingWidth,
      req.workingHeight,
      corners,
      2400
    );
    const warpMs = performance.now() - tWarp0;

    // Encode JPEG inside worker if OffscreenCanvas.convertToBlob works; else transfer RGBA back
    const jpegBlob = await encodeRgbaToJpegBlob(warped.rgba, warped.width, warped.height, 0.88);

    if (jpegBlob) {
      const response: ProcessPageSuccess = {
        type: 'result',
        jobId: req.jobId,
        corners,
        peaks,
        confidence,
        geometryValid,
        lowConfidence,
        inferenceMs,
        decodeCornerMs,
        warpMs,
        modelInfo: info,
        warpedWidth: warped.width,
        warpedHeight: warped.height,
        warpedJpegBlob: jpegBlob,
      };
      self.postMessage(response);
    } else {
      const outBuf = warped.rgba.buffer as ArrayBuffer;
      const response: ProcessPageSuccess = {
        type: 'result',
        jobId: req.jobId,
        corners,
        peaks,
        confidence,
        geometryValid,
        lowConfidence,
        inferenceMs,
        decodeCornerMs,
        warpMs,
        modelInfo: info,
        warpedWidth: warped.width,
        warpedHeight: warped.height,
        warpedBuffer: outBuf,
      };
      self.postMessage(response, [outBuf]);
    }
  } catch (err) {
    const response: ProcessPageError = {
      type: 'error',
      jobId: req.jobId,
      message: err instanceof Error ? err.message : 'Unknown worker error',
    };
    self.postMessage(response);
  }
};
