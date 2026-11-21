import React from 'react';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type PostSaveBehavior,
} from '../utils/settings';

interface SettingsModalProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onChange,
  onClose,
}) => {
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  const postSaveOptions: { value: PostSaveBehavior; label: string }[] = [
    { value: 'toast', label: 'Toast Edit' },
    { value: 'silent', label: 'Silent Save' },
    { value: 'always-confirm', label: 'Always Confirm' },
  ];

  const inputEdgeOptions = [2000, 2600, 3000];
  const outputEdgeOptions = [1600, 2000, 2400, 2800];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-full flex flex-col rounded-3xl bg-[#15181E] border border-white/10 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-white/10 flex items-center justify-between gap-3 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-neutral-100">⚙️ Settings</h2>
            <p className="text-xs text-neutral-400">
              Saved locally on this device across reloads
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="min-h-[44px] min-w-[44px] rounded-xl bg-white/5 hover:bg-white/10 text-neutral-300 flex items-center justify-center text-sm"
          >
            ✕
          </button>
        </div>

        {/* Scrollable Settings Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {/* Verbose Mode Toggle */}
          <div className="rounded-2xl bg-[#0B0D10] border border-white/10 p-4 flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-sm font-semibold text-neutral-100">
                📋 Verbose Activity Mode
              </div>
              <p className="text-xs text-neutral-400">
                Continuously displays live step-by-step logs as each stage starts and completes.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.verboseMode}
              onClick={() => update('verboseMode', !settings.verboseMode)}
              className={`min-h-[44px] min-w-[68px] px-3 rounded-xl font-semibold text-xs whitespace-nowrap shrink-0 transition ${
                settings.verboseMode
                  ? 'bg-amber-500 text-neutral-950'
                  : 'bg-white/10 text-neutral-300 hover:bg-white/15'
              }`}
            >
              {settings.verboseMode ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Post-Capture Behavior */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-neutral-300">
              Post-Capture Behavior (Confident Shots)
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-[#0B0D10] border border-white/10">
              {postSaveOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => update('postSaveBehavior', opt.value)}
                  className={`min-h-[40px] px-2 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                    settings.postSaveBehavior === opt.value
                      ? 'bg-amber-500 text-neutral-950 font-semibold'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Toast Duration (shown when Toast Edit is selected) */}
          {settings.postSaveBehavior === 'toast' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-neutral-300">Adjust-Corners Toast Duration</span>
                <span className="font-mono text-amber-400">{settings.toastDurationSec} s</span>
              </div>
              <input
                type="range"
                min={2}
                max={15}
                step={1}
                value={settings.toastDurationSec}
                onChange={(e) => update('toastDurationSec', parseInt(e.target.value, 10))}
                className="w-full accent-amber-500"
              />
            </div>
          )}

          {/* Confidence Threshold */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-neutral-300">Auto-Crop Confidence Threshold</span>
              <span className="font-mono text-amber-400">
                {settings.confidenceThreshold.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0.15}
              max={0.85}
              step={0.05}
              value={settings.confidenceThreshold}
              onChange={(e) => update('confidenceThreshold', parseFloat(e.target.value))}
              className="w-full accent-amber-500"
            />
            <p className="text-[11px] text-neutral-500">
              Lower values auto-save more shots; higher values open the 4-corner editor more often.
            </p>
          </div>

          {/* Output Resolution */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-neutral-300">Saved Page Resolution (Long Edge)</span>
              <span className="font-mono text-amber-400">{settings.maxOutputLongEdge} px</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 p-1 rounded-xl bg-[#0B0D10] border border-white/10">
              {outputEdgeOptions.map((px) => (
                <button
                  key={px}
                  type="button"
                  onClick={() => update('maxOutputLongEdge', px)}
                  className={`min-h-[40px] rounded-lg text-xs font-mono transition ${
                    settings.maxOutputLongEdge === px
                      ? 'bg-amber-500 text-neutral-950 font-semibold'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {px}
                </button>
              ))}
            </div>
          </div>

          {/* Working Decode Cap */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-neutral-300">Input Decode Cap (iOS RAM Guard)</span>
              <span className="font-mono text-amber-400">{settings.maxInputLongEdge} px</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-[#0B0D10] border border-white/10">
              {inputEdgeOptions.map((px) => (
                <button
                  key={px}
                  type="button"
                  onClick={() => update('maxInputLongEdge', px)}
                  className={`min-h-[40px] rounded-lg text-xs font-mono transition ${
                    settings.maxInputLongEdge === px
                      ? 'bg-amber-500 text-neutral-950 font-semibold'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {px}
                </button>
              ))}
            </div>
          </div>

          {/* JPEG Quality */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-neutral-300">JPEG Quality</span>
              <span className="font-mono text-amber-400">
                {Math.round(settings.jpegQuality * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.7}
              max={0.96}
              step={0.02}
              value={settings.jpegQuality}
              onChange={(e) => update('jpegQuality', parseFloat(e.target.value))}
              className="w-full accent-amber-500"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => onChange(DEFAULT_SETTINGS)}
            className="min-h-[46px] px-4 rounded-xl bg-white/5 hover:bg-white/10 text-neutral-300 text-xs font-medium whitespace-nowrap shrink-0"
          >
            Reset Defaults
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 min-h-[46px] rounded-xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-semibold text-sm active:scale-[0.98] transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
