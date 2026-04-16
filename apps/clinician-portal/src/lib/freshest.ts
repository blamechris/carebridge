/**
 * Pick the item with the largest (most recent) ISO timestamp at `key`.
 *
 * Issue #529: prior implementations used `a.recorded_at > b.recorded_at`
 * (lexicographic string compare) which silently returns the wrong item
 * when timestamps differ in format for the same instant — e.g.
 *   "2026-04-16T10:00:00-05:00"  vs  "2026-04-16T15:00:00Z"
 *   "2026-04-16T10:00:00Z"        vs  "2026-04-16T10:00:00.000Z"
 * Parsing to an epoch-ms number normalizes format differences so the
 * comparison reflects the actual moment in time.
 *
 * Returns `null` when the input is empty or when every selected
 * timestamp fails to parse. Items whose timestamp is null/undefined
 * or unparseable are skipped.
 */
export function pickFreshest<T>(
  items: readonly T[],
  getIso: (item: T) => string | null | undefined,
): T | null {
  let best: T | null = null;
  let bestMs = -Infinity;
  for (const item of items) {
    const iso = getIso(item);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = item;
    }
  }
  return best;
}

/**
 * Return the most recent ISO timestamp from a list of raw strings.
 * Same normalization guarantees as `pickFreshest`. Returns null when
 * the list is empty or every entry is unparseable.
 */
export function mostRecentIso(
  values: ReadonlyArray<string | null | undefined>,
): string | null {
  const picked = pickFreshest(values, (v) => v);
  return picked ?? null;
}
