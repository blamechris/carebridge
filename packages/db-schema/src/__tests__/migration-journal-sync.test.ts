import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DRIZZLE_DIR = join(__dirname, "..", "..", "drizzle");
const JOURNAL_PATH = join(DRIZZLE_DIR, "meta", "_journal.json");

type JournalEntry = { idx: number; tag: string; when: number };
type Journal = { entries: JournalEntry[] };

describe("drizzle migration journal", () => {
  const sqlFiles = readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""));
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as Journal;
  const journalTags = journal.entries.map((e) => e.tag);

  it("records every .sql file in drizzle/", () => {
    const missingFromJournal = sqlFiles.filter((f) => !journalTags.includes(f));
    assert.deepEqual(
      missingFromJournal,
      [],
      `SQL files on disk but not in _journal.json (these would be silently skipped on a fresh DB): ${missingFromJournal.join(", ")}`,
    );
  });

  it("does not reference SQL files that do not exist on disk", () => {
    const missingFromDisk = journalTags.filter((t) => !sqlFiles.includes(t));
    assert.deepEqual(
      missingFromDisk,
      [],
      `Journal references SQL files not present on disk: ${missingFromDisk.join(", ")}`,
    );
  });

  it("has strictly increasing idx values starting at 0", () => {
    journal.entries.forEach((entry, i) => {
      assert.equal(
        entry.idx,
        i,
        `journal entry at position ${i} has idx=${entry.idx}; idx values must be contiguous from 0`,
      );
    });
  });

  it("has strictly monotonic when timestamps", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1];
      const curr = journal.entries[i];
      assert.ok(
        curr.when > prev.when,
        `journal entry idx=${curr.idx} (${curr.tag}) has when=${curr.when} not greater than prior idx=${prev.idx} (${prev.tag}) when=${prev.when}`,
      );
    }
  });
});
