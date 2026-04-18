/**
 * Shared tRPC mock helper for render / a11y tests.
 *
 * Many tests only care about one slice of the UI (e.g. a tab strip,
 * a button, a layout shell) but the components they render pull
 * dozens of tRPC queries and mutations. Re-implementing a permissive
 * stub in every test file is noisy and fragile — any new call path
 * added downstream breaks unrelated tests.
 *
 * `createPermissiveTrpcMock` returns a Proxy that answers any
 * `trpc.<router>.<...>.<proc>.useQuery(...)` or `.useMutation()` call
 * with a loading-but-quiet stub, plus a no-op `trpc.useUtils()` whose
 * `.invalidate()` always resolves. Callers may pass per-route
 * overrides keyed by the dot-separated procedure path (e.g.
 * `"patients.getById"`) when they need a real-looking value for a
 * single query.
 *
 * Scope is intentionally small: only what the current caller set
 * needs. Expand deliberately, not speculatively.
 */
import { vi } from "vitest";

/** Minimal shape of a React Query `useQuery` result our tests read. */
export interface StubQueryResult<T = unknown> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  [key: string]: unknown;
}

/** Minimal shape of a React Query `useMutation` result our tests read. */
export interface StubMutationResult {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  [key: string]: unknown;
}

/**
 * Per-route overrides. Keys are dot-separated procedure paths as
 * they would appear on the tRPC client (e.g. `"patients.getById"`,
 * `"clinicalFlags.listForPatient"`). The value is either a
 * `useQuery`-shaped result or a factory that produces one.
 */
export type TrpcMockOverrides = Record<
  string,
  StubQueryResult | (() => StubQueryResult)
>;

export interface CreatePermissiveTrpcMockOptions {
  /**
   * Default shape returned by `useQuery` when no override matches.
   * Defaults to `{ data: undefined, isLoading: true, isError: false }`.
   */
  defaultQuery?: StubQueryResult;
  /**
   * Default shape returned by `useMutation`.
   * Defaults to `{ mutate: vi.fn(), isPending: false }`.
   */
  defaultMutation?: () => StubMutationResult;
  /** Per-route `useQuery` overrides keyed by procedure path. */
  overrides?: TrpcMockOverrides;
}

/**
 * Build a `vi.mock("@/lib/trpc", ...)` factory return value.
 *
 * Usage:
 *
 * ```ts
 * vi.mock("@/lib/trpc", () =>
 *   createPermissiveTrpcMock({
 *     overrides: {
 *       "patients.getById": { data: patient, isLoading: false, isError: false },
 *     },
 *   })
 * );
 * ```
 */
export function createPermissiveTrpcMock(
  options: CreatePermissiveTrpcMockOptions = {},
): { trpc: unknown } {
  const defaultQuery: StubQueryResult = options.defaultQuery ?? {
    data: undefined,
    isLoading: true,
    isError: false,
  };
  const defaultMutation = options.defaultMutation ?? (() => ({
    mutate: vi.fn(),
    isPending: false,
  }));
  const overrides = options.overrides ?? {};

  const resolveQuery = (path: string): StubQueryResult => {
    const override = overrides[path];
    if (override === undefined) return defaultQuery;
    return typeof override === "function" ? override() : override;
  };

  // `trpc.useUtils()` returns a deeply-chainable proxy whose `invalidate`
  // always resolves. Every other access keeps proxying so chains like
  // `utils.patients.getById.invalidate()` just work.
  const utilsProxy = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "invalidate") {
            return () => Promise.resolve();
          }
          return utilsProxy();
        },
      },
    );

  const proxy = (path: string[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          // Guard against accidental thenable detection by awaiters.
          if (prop === "then") return undefined;
          if (prop === "useUtils") return () => utilsProxy();
          if (prop === "useQuery") {
            return (..._args: unknown[]) => resolveQuery(path.join("."));
          }
          if (prop === "useMutation") {
            return () => defaultMutation();
          }
          return proxy([...path, prop]);
        },
      },
    );

  return { trpc: proxy([]) };
}
