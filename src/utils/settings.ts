export type PostSaveBehavior = 'toast' | 'silent' | 'always-confirm';

export interface AppSettings {
  verboseMode: boolean;
  confidenceThreshold: number;
  maxInputLongEdge: number;
  maxOutputLongEdge: number;
  jpegQuality: number;
  postSaveBehavior: PostSaveBehavior;
  toastDurationSec: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  verboseMode: false,
  confidenceThreshold: 0.45,
  maxInputLongEdge: 2600,
  maxOutputLongEdge: 2400,
  jpegQuality: 0.88,
  postSaveBehavior: 'toast',
  toastDurationSec: 6,
};

const STORAGE_KEY = 'wakes-settings-v1';

export function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      verboseMode:
        typeof parsed.verboseMode === 'boolean'
          ? parsed.verboseMode
          : DEFAULT_SETTINGS.verboseMode,
      confidenceThreshold: clampNum(
        parsed.confidenceThreshold,
        0.15,
        0.9,
        DEFAULT_SETTINGS.confidenceThreshold
      ),
      maxInputLongEdge: clampNum(
        parsed.maxInputLongEdge,
        1600,
        3600,
        DEFAULT_SETTINGS.maxInputLongEdge
      ),
      maxOutputLongEdge: clampNum(
        parsed.maxOutputLongEdge,
        1200,
        3200,
        DEFAULT_SETTINGS.maxOutputLongEdge
      ),
      jpegQuality: clampNum(parsed.jpegQuality, 0.65, 0.96, DEFAULT_SETTINGS.jpegQuality),
      postSaveBehavior:
        parsed.postSaveBehavior === 'toast' ||
        parsed.postSaveBehavior === 'silent' ||
        parsed.postSaveBehavior === 'always-confirm'
          ? parsed.postSaveBehavior
          : DEFAULT_SETTINGS.postSaveBehavior,
      toastDurationSec: clampNum(
        parsed.toastDurationSec,
        2,
        15,
        DEFAULT_SETTINGS.toastDurationSec
      ),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(next: AppSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota errors
  }
}

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || Number.isNaN(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}
