# @carebridge/test-utils

Shared test utilities for CareBridge services. The centerpiece is
[`createMockDb()`](./src/mock-db.ts) — a fluent mock builder that replaces the
brittle hand-rolled `vi.fn().mockReturnValueOnce({...})` nests that services
used to write when stubbing Drizzle query chains.

## `createMockDb()` at a glance

Drizzle services write chains like:

```ts
await db.select().from(t).where(eq(t.id, id)).limit(1);
await db.update(t).set(x).where(eq(t.id, id)).returning();
await db.insert(t).values(row);
```

`createMockDb()` models these as four root operations (`select`, `insert`,
`update`, `delete`), each backed by a FIFO result queue. Every chain method
returns a thenable proxy, so prod code can stop chaining at any point and the
test does not care about method order.

```ts
import { createMockDb } from "@carebridge/test-utils";

const db = createMockDb()
  .willSelect([existingRow])    // 1st select chain resolves to [existingRow]
  .willInsert()                  // 1st insert chain resolves to undefined
  .willUpdate([{ id: "..." }]); // 1st update chain resolves to the rows

vi.mock("@carebridge/db-schema", () => ({ getDb: () => db, /* ...tables */ }));

// Standard vi.fn assertions still work on each root:
expect(db.select).toHaveBeenCalledOnce();
expect(db.insert).toHaveBeenCalledWith(tableRef);

// Chain-shape assertions via the call-record metadata:
expect(db.update.calls[0]?.chain).toContain("set");
```

See [`src/mock-db.ts`](./src/mock-db.ts) for the full API and
[`src/__tests__/mock-db.test.ts`](./src/__tests__/mock-db.test.ts) for more
examples.

## When NOT to use `createMockDb`

`createMockDb` is the default choice for service unit tests, but a few access
patterns do not fit the single-queue / fluent-chain model it exposes. The
following files are intentional, permanent holdouts. If you are writing a new
test that would need any of these patterns, prefer a hand-rolled mock in the
shape shown by the linked canonical example rather than forcing the helper.

These holdouts are tracked by issues [#850][issue-850] and [#852][issue-852]
as documentation-only resolutions.

### 1. Dual-table `select` routing with per-table call-count assertions

**Canonical example:** [`services/api-gateway/src/middleware/rbac.test.ts`][rbac-test]

The RBAC cache middleware runs two different `select(...).from(...)` chains
against two different tables (`careTeamAssignments` and `emergencyAccess`)
inside the same code path, and the test asserts on each table's call count
separately:

```ts
expect(careTeamSelectMock).toHaveBeenCalledTimes(1);
expect(emergencySelectMock).toHaveBeenCalledTimes(1);
// ...and, critically:
expect(emergencySelectMock).not.toHaveBeenCalled();
```

Those assertions are the whole point of the test — the cache must short-circuit
the emergency-access lookup when a care-team row is found.

**Why `createMockDb` does not fit:** its `select` queue is table-agnostic.
Pushing both tables' results through `db.willSelect(...)` merges the two call
streams into one — `db.select` registers two calls, but "how many times was
the emergency-access table queried?" is no longer recoverable. We would have
to either:

- introduce an opt-in table-routed API (e.g. `db.willSelectFrom(table, rows)`)
  that inspects the `from(...)` argument and dispatches to a per-table queue, or
- weaken the test to `expect(db.select).toHaveBeenCalledTimes(N)`, which loses
  the short-circuit invariant.

Until a future test also needs table-routed select assertions, the hand-rolled
dual-mock pattern in `rbac.test.ts` is the recommended shape.

### 2. `db.query.<table>.findFirst(...)` prepared queries

**Canonical example:** [`services/ai-oversight/src/__tests__/llm-timeout-fallback.test.ts`][llm-fallback-test]

The AI-oversight review service uses Drizzle's prepared-query API alongside
fluent chains:

```ts
// Fluent chain (modelled by createMockDb):
await db.select().from(reviewJobs).where(eq(reviewJobs.id, jobId));

// Prepared query (NOT modelled by createMockDb):
await db.query.patients.findFirst({ where: eq(patients.id, patientId) });
```

`db.query.<table>.findFirst` is a completely separate Drizzle surface from
`db.select()`. It is not part of the fluent chain and therefore is not wired
into `createMockDb`'s proxy. The test stubs it directly:

```ts
const mockDb = {
  select: mockSelect,
  insert: mockInsert,
  update: mockUpdate,
  query: {
    patients: {
      findFirst: vi.fn().mockResolvedValue({ name: "Test Patient" }),
    },
  },
};
```

The same test also relies on index-based `update().set(...)` argument
assertions:

```ts
const lastCall = mockSetFn.mock.calls[mockSetFn.mock.calls.length - 1][0];
expect(lastCall).toEqual(expect.objectContaining({ status: "llm_timeout" }));
```

`createMockDb` exposes `db.update.calls[i].chainArgs`, but the migrated access
pattern (find the index of the `set` call inside `chain`, then index into
`chainArgs` at the same position) is noticeably harder to read than the direct
`mockSetFn.mock.calls[...]` form the test already uses.

**Why `createMockDb` does not fit:** neither `db.query.*` modelling nor
ergonomic per-chain argument assertions are in the helper's scope today. Both
could be added (see option 1 in each linked issue), but until enough tests
need them, the cost/benefit is not there.

### When to keep a hand-rolled mock

As a rule of thumb, reach for a hand-rolled mock over `createMockDb` when any
of the following is true:

- The test needs **per-table call assertions** on the same root operation
  (e.g. "assert that table A was selected from N times but table B was not
  selected from at all").
- The code under test uses Drizzle's **prepared-query API**
  (`db.query.<table>.findFirst` / `.findMany`) in addition to, or instead of,
  the fluent builder.
- The test asserts on the **exact argument object** passed to a specific
  chain method (e.g. `set`) and the ergonomics of the hand-rolled form are
  materially better than the equivalent `chainArgs`-based access.
- The service deliberately exercises an **unusual chain shape** the helper
  does not currently model (new chain verbs, non-thenable return values, etc.)
  and only one or two tests need it.

For everything else — especially the "select something, maybe update it,
maybe insert a row, assert it happened" shape that most service tests have —
`createMockDb` is the right default.

[issue-850]: https://github.com/blamechris/carebridge/issues/850
[issue-852]: https://github.com/blamechris/carebridge/issues/852
[rbac-test]: ../../services/api-gateway/src/middleware/rbac.test.ts
[llm-fallback-test]: ../../services/ai-oversight/src/__tests__/llm-timeout-fallback.test.ts
