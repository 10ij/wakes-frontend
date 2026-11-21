import React, { useEffect, useRef, useState } from 'react';

export interface VerboseLogEntry {
  id: number;
  time: string;
  text: string;
  level: 'info' | 'done' | 'warn' | 'error';
}

interface VerboseLogPanelProps {
  currentActivity: string;
  entries: VerboseLogEntry[];
  onClear: () => void;
}

const LEVEL_ICON: Record<VerboseLogEntry['level'], string> = {
  info: '⏳',
  done: '✅',
  warn: '⚠️',
  error: '❌',
};

const LEVEL_COLOR: Record<VerboseLogEntry['level'], string> = {
  info: 'text-neutral-300',
  done: 'text-emerald-300',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

/**
 * Live activity console displayed when Verbose Mode is enabled in Settings.
 * Includes a Copy button for sharing/debugging logs directly from iPhone.
 */
export const VerboseLogPanel: React.FC<VerboseLogPanelProps> = ({
  currentActivity,
  entries,
  onClear,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!collapsed && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, collapsed]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopyLogs = async () => {
    const header = [
      `wakes verbose log (${new Date().toISOString()})`,
      `Current: ${currentActivity}`,
      `Entries: ${entries.length}`,
      '---',
    ];
    const lines = entries.map(
      (e) => `[${e.time}] [${e.level.toUpperCase()}] ${e.text}`
    );
    const payload = [...header, ...lines].join('\n');

    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        ok = true;
      }
    } catch {
      ok = false;
    }

    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = payload;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch {
        ok = false;
      }
    }

    if (ok) {
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <section
      aria-live="polite"
      className="rounded-2xl bg-[#15181E] border border-amber-500/25 overflow-hidden"
    >
      <div className="px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 border-b border-white/5">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span aria-hidden="true">📋</span>
          <span className="text-xs font-semibold text-amber-400 whitespace-nowrap shrink-0">
            Verbose
          </span>
          <span className="text-xs font-mono text-neutral-200 truncate">
            {currentActivity}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void handleCopyLogs()}
            className="min-h-[36px] px-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] font-medium text-neutral-200 whitespace-nowrap"
          >
            {copied ? '✅ Copied' : '📋 Copy'}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="min-h-[36px] px-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] font-medium text-neutral-300 whitespace-nowrap"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="min-h-[36px] px-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] font-medium text-neutral-300 whitespace-nowrap"
          >
            {collapsed ? `Show (${entries.length})` : 'Hide'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div
          ref={listRef}
          className="max-h-48 overflow-y-auto px-3.5 py-2.5 space-y-1 bg-[#0B0D10] font-mono text-[11px] leading-relaxed"
        >
          {entries.length === 0 ? (
            <div className="text-neutral-500">Waiting for activity…</div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className={`flex items-start gap-2 ${LEVEL_COLOR[entry.level]}`}>
                <span className="text-neutral-500 shrink-0">{entry.time}</span>
                <span aria-hidden="true" className="shrink-0">
                  {LEVEL_ICON[entry.level]}
                </span>
                <span className="break-words">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
};
