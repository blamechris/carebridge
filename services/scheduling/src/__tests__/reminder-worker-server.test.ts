/**
 * Structural test for the reminder-worker entrypoint (#984).
 *
 * The worker factory `startReminderWorker` was exported but never invoked
 * because the scheduling service had no server.ts. Jobs enqueued by
 * `scheduleReminders` accumulated in Redis with no drainer. This test
 * fails if either the entrypoint file or the `dev` script disappears so
 * the regression can't recur silently.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");
const SERVER_PATH = join(PACKAGE_ROOT, "src", "server.ts");
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, "package.json");

describe("scheduling service worker entrypoint (#984)", () => {
  it("has src/server.ts that imports and invokes startReminderWorker", () => {
    expect(existsSync(SERVER_PATH)).toBe(true);
    const source = readFileSync(SERVER_PATH, "utf8");
    expect(source).toMatch(/from\s+["']\.\/workers\/reminder-worker\.js["']/);
    expect(source).toMatch(/startReminderWorker\s*\(/);
  });

  it("registers a SIGTERM handler so the BullMQ worker shuts down cleanly", () => {
    const source = readFileSync(SERVER_PATH, "utf8");
    expect(source).toMatch(/process\.on\(\s*["']SIGTERM["']/);
  });

  it("package.json has a dev script that runs the entrypoint", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const devScript = pkg.scripts?.dev;
    expect(devScript).toBeDefined();
    expect(devScript).toMatch(/src\/server\.ts/);
  });

  it("package.json has a start script that runs the built entrypoint", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.start).toBeDefined();
    expect(pkg.scripts?.start).toMatch(/dist\/server\.js/);
  });
});
