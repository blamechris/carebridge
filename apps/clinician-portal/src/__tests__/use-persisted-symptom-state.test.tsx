/**
 * @vitest-environment jsdom
 *
 * Issue #1311 — persist sectionCollapseState + unlinkedPairs across
 * remounts and page reloads. The implementation lives in
 * `usePersistedSymptomState` which wraps `useState` with a localStorage
 * read on mount + write-on-change. These tests pin the persistence
 * contract:
 *
 *   1. Initial mount with no stored value uses the supplied default.
 *   2. State changes flush to localStorage under the supplied key.
 *   3. A fresh mount (simulating page reload) restores the stored value.
 *   4. A malformed stored value falls back to the default silently.
 *   5. Both the Record and Set variants serialise without losing data.
 */
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  usePersistedRecord,
  usePersistedStringSet,
} from "../lib/use-persisted-symptom-state";

const STORAGE_KEY_RECORD = "cb-symptom-collapse-state";
const STORAGE_KEY_SET = "cb-symptom-unlinked-pairs";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function RecordHarness({
  storageKey,
}: {
  storageKey: string;
}) {
  const [state, setState] = usePersistedRecord<
    Record<string, Record<string, boolean>>
  >(storageKey, {});
  return (
    <div>
      <span data-testid="record-json">{JSON.stringify(state)}</span>
      <button
        type="button"
        data-testid="record-set"
        onClick={() =>
          setState({
            new_symptoms: { Neurological: true },
          })
        }
      >
        set
      </button>
    </div>
  );
}

function SetHarness({ storageKey }: { storageKey: string }) {
  const [set, setSet] = usePersistedStringSet(storageKey);
  return (
    <div>
      <span data-testid="set-size">{set.size}</span>
      <span data-testid="set-has-foo">
        {set.has("foo||bar") ? "yes" : "no"}
      </span>
      <button
        type="button"
        data-testid="set-add"
        onClick={() => {
          setSet((prev) => {
            const next = new Set(prev);
            next.add("foo||bar");
            return next;
          });
        }}
      >
        add
      </button>
    </div>
  );
}

describe("usePersistedRecord (#1311)", () => {
  it("returns the default value when no stored entry exists", () => {
    render(<RecordHarness storageKey={STORAGE_KEY_RECORD} />);
    expect(screen.getByTestId("record-json").textContent).toBe("{}");
  });

  it("writes state changes to localStorage", () => {
    render(<RecordHarness storageKey={STORAGE_KEY_RECORD} />);
    fireEvent.click(screen.getByTestId("record-set"));
    const stored = localStorage.getItem(STORAGE_KEY_RECORD);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string)).toEqual({
      new_symptoms: { Neurological: true },
    });
  });

  it("restores state on remount (simulates page reload)", () => {
    // Pre-populate as if a previous mount had set state.
    localStorage.setItem(
      STORAGE_KEY_RECORD,
      JSON.stringify({ new_symptoms: { Neurological: true } }),
    );
    render(<RecordHarness storageKey={STORAGE_KEY_RECORD} />);
    expect(
      JSON.parse(screen.getByTestId("record-json").textContent ?? "null"),
    ).toEqual({ new_symptoms: { Neurological: true } });
  });

  it("falls back to default silently when stored payload is malformed", () => {
    localStorage.setItem(STORAGE_KEY_RECORD, "{not json");
    render(<RecordHarness storageKey={STORAGE_KEY_RECORD} />);
    expect(screen.getByTestId("record-json").textContent).toBe("{}");
  });
});

describe("usePersistedStringSet (#1311)", () => {
  it("starts empty when no stored entry exists", () => {
    render(<SetHarness storageKey={STORAGE_KEY_SET} />);
    expect(screen.getByTestId("set-size").textContent).toBe("0");
    expect(screen.getByTestId("set-has-foo").textContent).toBe("no");
  });

  it("persists additions to localStorage as a JSON array", () => {
    render(<SetHarness storageKey={STORAGE_KEY_SET} />);
    fireEvent.click(screen.getByTestId("set-add"));
    const stored = localStorage.getItem(STORAGE_KEY_SET);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain("foo||bar");
  });

  it("rehydrates a Set from a JSON array on remount", () => {
    localStorage.setItem(
      STORAGE_KEY_SET,
      JSON.stringify(["foo||bar", "baz||qux"]),
    );
    render(<SetHarness storageKey={STORAGE_KEY_SET} />);
    expect(screen.getByTestId("set-size").textContent).toBe("2");
    expect(screen.getByTestId("set-has-foo").textContent).toBe("yes");
  });

  it("falls back to empty Set on malformed payload", () => {
    localStorage.setItem(STORAGE_KEY_SET, "not-json-at-all");
    render(<SetHarness storageKey={STORAGE_KEY_SET} />);
    expect(screen.getByTestId("set-size").textContent).toBe("0");
  });
});
