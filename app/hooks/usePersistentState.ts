"use client";

import { useEffect, useState } from "react";

export function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let nextValue = initialValue;
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
  }, [initialValue, key]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [hydrated, key, value]);

  return [value, setValue, hydrated] as const;
}
