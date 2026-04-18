import { describe, it, expect, beforeEach } from "vitest";
import { createMockDb } from "../mock-db.js";

describe("createMockDb", () => {
  it("exposes select, insert, update, delete as vi.fn spies", () => {
    const db = createMockDb();
    expect(typeof db.select).toBe("function");
    expect(typeof db.insert).toBe("function");
    expect(typeof db.update).toBe("function");
    expect(typeof db.delete).toBe("function");
    // vi.fn spies expose `.mock.calls`.
    expect(db.select).toHaveBeenCalledTimes(0);
  });

  describe("select chains", () => {
    it("resolves select().from(t).where(x).limit(n) to the queued rows", async () => {
      const rows = [{ id: "1" }, { id: "2" }];
      const db = createMockDb().willSelect(rows);

      const result = await db.select().from({}).where({}).limit(10);

      expect(result).toEqual(rows);
      expect(db.select).toHaveBeenCalledOnce();
    });

    it("resolves select().from(t) without further chaining", async () => {
      const rows = [{ id: "a" }];
      const db = createMockDb().willSelect(rows);

      const result = await db.select().from({});

      expect(result).toEqual(rows);
    });

    it("resolves chain methods in any order (order-independent)", async () => {
      // Reordering .orderBy and .where in prod code should not break the
      // test. Both permutations resolve to the same queued rows.
      const rows = [{ id: "z" }];
      const db = createMockDb().willSelect(rows).willSelect(rows);

      const a = await db.select().from({}).where({}).orderBy({});
      const b = await db.select().from({}).orderBy({}).where({});

      expect(a).toEqual(rows);
      expect(b).toEqual(rows);
    });

    it("returns undefined when the queue is empty", async () => {
      const db = createMockDb();
      const result = await db.select().from({}).where({});
      expect(result).toBeUndefined();
    });

    it("consumes queued results in FIFO order across multiple chains", async () => {
      const db = createMockDb().willSelect([{ n: 1 }]).willSelect([{ n: 2 }]);

      const first = await db.select().from({}).where({});
      const second = await db.select().from({}).where({});

      expect(first).toEqual([{ n: 1 }]);
      expect(second).toEqual([{ n: 2 }]);
    });
  });

  describe("insert chains", () => {
    it("resolves insert(t).values(row) to undefined by default", async () => {
      const db = createMockDb();
      const result = await db.insert({}).values({ id: "1" });
      expect(result).toBeUndefined();
    });

    it("records the insert args and chain sequence for assertions", async () => {
      const db = createMockDb();
      const table = { name: "patients" };
      const row = { id: "1", name: "Alice" };

      await db.insert(table).values(row);

      expect(db.insert).toHaveBeenCalledOnce();
      expect(db.insert).toHaveBeenCalledWith(table);
      expect(db.insert.calls[0]?.chain).toEqual(["values"]);
      expect(db.insert.calls[0]?.chainArgs[0]).toEqual([row]);
    });
  });

  describe("update chains", () => {
    it("resolves update(t).set(x).where(y) to undefined by default", async () => {
      const db = createMockDb();
      const result = await db.update({}).set({ name: "x" }).where({});
      expect(result).toBeUndefined();
    });

    it("resolves update(t).set(x).where(y).returning() to queued rows", async () => {
      const db = createMockDb().willUpdate([{ id: "1" }]);
      const result = await db.update({}).set({}).where({}).returning({});
      expect(result).toEqual([{ id: "1" }]);
    });
  });

  describe("queueResult", () => {
    it("is an alias for the per-operation willXxx helpers", async () => {
      const db = createMockDb()
        .queueResult("select", [{ id: "x" }])
        .queueResult("update", [{ id: "y" }]);

      const s = await db.select().from({}).where({});
      const u = await db.update({}).set({}).where({}).returning({});

      expect(s).toEqual([{ id: "x" }]);
      expect(u).toEqual([{ id: "y" }]);
    });
  });

  describe("reset", () => {
    beforeEach(() => {
      // nothing — each test builds its own db
    });

    it("clears queued results and call history", async () => {
      const db = createMockDb().willSelect([{ id: "1" }]);

      await db.select().from({});
      expect(db.select).toHaveBeenCalledOnce();

      db.reset();
      expect(db.select).toHaveBeenCalledTimes(0);
      expect(db.select.calls).toHaveLength(0);

      // Queue was drained too — next await resolves to undefined.
      const after = await db.select().from({}).where({});
      expect(after).toBeUndefined();
    });
  });

  describe("thenable semantics", () => {
    it("works with Promise.resolve() wrapping", async () => {
      const db = createMockDb().willSelect([{ id: "1" }]);
      const chain = db.select().from({}).where({});
      const result = await Promise.resolve(chain);
      expect(result).toEqual([{ id: "1" }]);
    });

    it("supports .execute() as an explicit terminator", async () => {
      const db = createMockDb().willSelect([{ id: "1" }]);
      const chain = db.select().from({}) as unknown as {
        execute: () => Promise<unknown>;
      };
      const result = await chain.execute();
      expect(result).toEqual([{ id: "1" }]);
    });
  });
});
