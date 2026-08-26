export const formatDurationZh = (seconds: number, precision = 0) => {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  const rounded = Number(remainder.toFixed(precision));
  if (rounded >= 60) return `${minutes + 1}分0秒`;
  return `${minutes}分${precision > 0 ? rounded.toFixed(precision).replace(/\.0+$/, "") : Math.round(rounded)}秒`;
};

// Analysis copy can contain model-generated raw-second expressions. Normalize them
// at the presentation boundary so old and new analysis records remain consistent.
export const normalizeDurationCopy = (value: string) => value
  .replace(/(\d+(?:\.\d+)?)\s*[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*秒/g, (_, start: string, end: string) =>
    `${formatDurationZh(Number(start), start.includes(".") ? 2 : 0)}–${formatDurationZh(Number(end), end.includes(".") ? 2 : 0)}`)
  .replace(/(\d+(?:\.\d+)?)\s*秒/g, (_, raw: string) =>
    formatDurationZh(Number(raw), raw.includes(".") ? 2 : 0));
