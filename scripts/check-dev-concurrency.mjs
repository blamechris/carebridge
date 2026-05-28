#!/usr/bin/env node
/**
 * Guards root `dev` script's `turbo --concurrency=N` flag against the number
 * of workspace packages that declare a persistent `dev` script.
 *
 * Why: turbo silently queues persistent tasks when concurrency < task count,
 * which lets consuming services boot before their upstream packages' dist/
 * exists — the cold-start race that re-creates the #1264 false-negative
 * window. This guard fails CI when headroom drops below the buffer so we
 * notice before `pnpm dev` breaks.
 *
 * Strategy:
 *   1. Read root package.json, extract `--concurrency=N` from `scripts.dev`.
 *   2. Walk pnpm-workspace.yaml globs, count packages whose package.json
 *      has a non-empty `scripts.dev`.
 *   3. Exit 1 if concurrency < count + BUFFER.
 *
 * No external deps — node stdlib only.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUFFER = 4;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(msg) {
  console.error(`check-dev-concurrency: ${msg}`);
  process.exit(1);
}

function extractConcurrency(devScript) {
  // Match --concurrency=N or --concurrency N
  const eq = devScript.match(/--concurrency=(\d+)/);
  if (eq) return Number(eq[1]);
  const sp = devScript.match(/--concurrency\s+(\d+)/);
  if (sp) return Number(sp[1]);
  return null;
}

function parseWorkspaceGlobs(yamlText) {
  // Tiny parser: looks for `packages:` block and entries beginning with `- "..."`
  // or `- '...'` or `- bare`. Adequate for our pnpm-workspace.yaml shape.
  const lines = yamlText.split(/\r?\n/);
  const globs = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/);
      if (m) {
        globs.push(m[1]);
      } else if (/^\S/.test(line)) {
        // top-level key — end of packages block
        inPackages = false;
      }
    }
  }
  return globs;
}

function expandGlob(root, glob) {
  // Supports only the simple `dir/*` shape used by pnpm-workspace.yaml.
  // Returns absolute directory paths.
  if (!glob.endsWith("/*")) {
    // Treat as literal path.
    const abs = resolve(root, glob);
    try {
      if (statSync(abs).isDirectory()) return [abs];
    } catch {
      /* not present */
    }
    return [];
  }
  const parent = resolve(root, glob.slice(0, -2));
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(parent, e.name));
}

function main() {
  const rootPkgPath = join(repoRoot, "package.json");
  const rootPkg = readJson(rootPkgPath);
  const devScript = rootPkg.scripts?.dev;
  if (!devScript) fail("root package.json has no scripts.dev");

  const concurrency = extractConcurrency(devScript);
  if (concurrency === null) {
    fail(`could not extract --concurrency=N from scripts.dev: ${devScript}`);
  }

  const workspaceYamlPath = join(repoRoot, "pnpm-workspace.yaml");
  const workspaceYaml = readFileSync(workspaceYamlPath, "utf8");
  const globs = parseWorkspaceGlobs(workspaceYaml);
  if (globs.length === 0) {
    fail("no workspace globs parsed from pnpm-workspace.yaml");
  }

  const pkgDirs = globs.flatMap((g) => expandGlob(repoRoot, g));
  const devPkgs = [];
  for (const dir of pkgDirs) {
    const pkgPath = join(dir, "package.json");
    let pkg;
    try {
      pkg = readJson(pkgPath);
    } catch {
      continue;
    }
    const dev = pkg.scripts?.dev;
    if (typeof dev === "string" && dev.trim().length > 0) {
      devPkgs.push(pkg.name ?? dir);
    }
  }

  const count = devPkgs.length;
  const required = count + BUFFER;
  const headroom = concurrency - count;

  console.log(
    `check-dev-concurrency: turbo --concurrency=${concurrency}, ` +
      `${count} workspace packages with a dev script ` +
      `(headroom: ${headroom}, buffer required: ${BUFFER})`,
  );

  if (concurrency < required) {
    console.error("");
    console.error(
      `ERROR: turbo --concurrency=${concurrency} is below ${count} dev ` +
        `tasks + buffer ${BUFFER} = ${required}.`,
    );
    console.error(
      "Raise --concurrency in the root package.json `dev` script, or remove " +
        "a workspace dev script. See issue #1279 for context.",
    );
    console.error("");
    console.error("Workspaces with a dev script:");
    for (const name of devPkgs.sort()) console.error(`  - ${name}`);
    process.exit(1);
  }
}

main();
