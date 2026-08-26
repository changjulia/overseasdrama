"use client";

import { useEffect, useRef, useState } from "react";

const rebuildableKeys = new Set(["analysisResult", "storylineMatchCache"]);

function compactForLocalStorage(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (typeof value === "string") {
    // Object URLs do not survive a reload, and embedded data URLs are the
    // common reason one draft consumes the entire localStorage quota.
    if (/^(?:data:|blob:)/i.test(value)) return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    const source = depth === 0 ? value.slice(0, 50) : value.slice(0, 120);
    return source.map(item => compactForLocalStorage(item, depth + 1)).filter(item => item !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([entryKey, entryValue]) => {
      if (rebuildableKeys.has(entryKey)) return [];
      const compacted = compactForLocalStorage(entryValue, depth + 1);
      return compacted === undefined ? [] : [[entryKey, compacted]];
    }));
  }
  return value;
}

function persistWithoutCrashing(key: string, value: unknown) {
  const serialized = JSON.stringify(value);
  try {
    window.localStorage.setItem(key, serialized);
    return;
  } catch (error) {
    if (!(error instanceof DOMException) || !["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"].includes(error.name)) {
      console.warn(`Unable to persist ${key}`, error);
      return;
    }
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(compactForLocalStorage(value)));
  } catch (error) {
    // Persistence is an enhancement.  The current in-memory state remains
    // usable even when the browser has no writable storage left.
    console.warn(`Local storage quota is full; ${key} will remain in memory only`, error);
  }
}

export function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);
  const [hydrated, setHydrated] = useState(false);
  // Capture the initializer once. Callers commonly pass array/object literals;
  // treating their identity as an effect dependency creates a hydration loop:
  // render -> new literal -> hydrate -> setValue -> render.
  const initialValueRef = useRef(initialValue);

  useEffect(() => {
    let nextValue = initialValueRef.current;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored) nextValue = JSON.parse(stored) as T;
    } catch {
      // Keep the safe in-memory default when stored data is invalid.
    }
    queueMicrotask(() => {
      setValue(nextValue);
      setHydrated(true);
    });
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    persistWithoutCrashing(key, value);
  }, [hydrated, key, value]);

  return [value, setValue, hydrated] as const;
}
