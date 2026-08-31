export type KeyOriginalAudioWindow = { start: number; end: number };

const roundTime = (value: number) => Math.round(value * 100) / 100;

export function narrationWindowLimit(durationSeconds: number): number {
  return Math.max(60, Math.min(100, Number.isFinite(durationSeconds) ? durationSeconds : 60));
}

export function normalizeKeyOriginalAudioWindows(
  windows: KeyOriginalAudioWindow[],
  durationSeconds: number,
): KeyOriginalAudioWindow[] {
  const limit = narrationWindowLimit(durationSeconds);
  const sorted = windows
    .map((window) => ({ start: Number(window.start), end: Number(window.end) }))
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end))
    .map((window) => ({ start: Math.max(0, Math.min(limit, window.start)), end: Math.max(0, Math.min(limit, window.end)) }))
    .filter((window) => window.end > window.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const normalized: KeyOriginalAudioWindow[] = [];
  for (const window of sorted) {
    if (normalized.length >= 20) break;
    const start = Math.max(window.start, normalized.at(-1)?.end ?? 0);
    if (window.end <= start) continue;
    normalized.push({ start: roundTime(start), end: roundTime(window.end) });
  }
  return normalized;
}

export function appendKeyOriginalAudioWindow(
  windows: KeyOriginalAudioWindow[],
  durationSeconds: number,
): KeyOriginalAudioWindow[] {
  const normalized = normalizeKeyOriginalAudioWindows(windows, durationSeconds);
  if (normalized.length >= 20) return normalized;
  const limit = narrationWindowLimit(durationSeconds);
  const start = normalized.at(-1)?.end ?? 0;
  if (start >= limit) return normalized;
  return [...normalized, { start: roundTime(start), end: roundTime(Math.min(limit, start + 2)) }];
}
