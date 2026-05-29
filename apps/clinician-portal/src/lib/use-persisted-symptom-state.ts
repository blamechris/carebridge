/**
 * Persistence hooks for the symptom UX state — issue #1311.
 *
 * The /notes/new page keeps two pieces of UI-only state that the
 * inspector flagged as resetting on remount or page reload:
 *
 *   - `sectionCollapseState` — per-field per-body-system collapsed flag.
 *   - `unlinkedPairs` — set of `"<nsOption>||<rosOption>"` strings the
 *     user has explicitly unlinked.
 *
 * Both round-trip through localStorage so the affordance survives
 * navigation, refresh, and tab restoration. We deliberately use a
 * single global key per slot (rather than a per-draft key) so the
 * affordance also persists across drafts for the same clinician — when
 * a clinician collapses the GU section because their specialty is
 * oncology, that preference should follow them to the next draft too.
 *
 * Both hooks share a write-on-change effect that JSON-serialises the
 * current value back into localStorage. The initial read happens lazily
 * in a useState initialiser so SSR doesn't crash on a missing window.
 */

import { useEffect, useState, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

/**
 * Persist any JSON-serialisable Record-shaped value behind a string key.
 * Falls back to the supplied default on first mount and on malformed
 * payloads.
 */
export function usePersistedRecord<T extends Record<string, unknown>>(
  storageKey: string,
  defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => readJSON(storageKey, defaultValue));

  useEffect(() => {
    writeJSON(storageKey, state);
  }, [storageKey, state]);

  return [state, setState];
}

/**
 * Persist a Set<string> behind a string key. The Set is serialised as a
 * JSON array (Sets aren't natively JSON-serialisable) and rehydrated on
 * mount. The setter exposes the standard `Dispatch<SetStateAction<...>>`
 * signature so callers can use `setSet(prev => new Set(prev).add(x))`
 * just like a regular `useState<Set<string>>`.
 */
export function usePersistedStringSet(
  storageKey: string,
): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [state, setState] = useState<Set<string>>(() => {
    const arr = readJSON<string[]>(storageKey, []);
    return new Set(Array.isArray(arr) ? arr : []);
  });

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(storageKey, JSON.stringify([...state]));
    } catch {
      // localStorage may be unavailable (private mode quota, etc.);
      // silently skip so the UI keeps working.
    }
  }, [storageKey, state]);

  const stableSetter = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    (action) => {
      setState((prev) =>
        typeof action === "function"
          ? (action as (p: Set<string>) => Set<string>)(prev)
          : action,
      );
    },
    [],
  );

  return [state, stableSetter];
}

function readJSON<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON<T>(key: string, value: T): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota / private mode — fail open so UI keeps working.
  }
}
