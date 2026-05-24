/**
 * Patient-education URL rot detector (issue #1151).
 *
 * Walks every `links[*].url` in DIAGNOSIS_EDUCATION_TABLE +
 * MEDICATION_EDUCATION_TABLE and HEADs each one. Health-domain CDNs
 * (notably the Cloudflare front in front of `heart.org`) sometimes reject
 * HEAD with 405, so we fall back to a GET on 405. Redirect-following is
 * delegated to Node fetch's default cap (~20 hops via `redirect: "follow"`);
 * once the chain resolves, the final status is what we classify.
 *
 * Designed to be driven by `.github/workflows/patient-education-url-check.yml`
 * on the first of every month. Not part of CI — live HTTP would be flaky.
 *
 * The helper functions below (`classifyStatus`, `checkUrl`, `formatReport`)
 * are exported so the vitest suite can exercise the 405-fallback and
 * report-formatting logic with a mocked fetch.
 */

import { pathToFileURL } from "node:url";
import {
  DIAGNOSIS_EDUCATION_TABLE,
  MEDICATION_EDUCATION_TABLE,
  type EducationContent,
} from "../src/patient-education.js";

const TIMEOUT_MS = 10_000;

export interface UrlCheckResult {
  url: string;
  ok: boolean;
  /** Final HTTP status code we observed, or null if the request never produced one. */
  status: number | null;
  /** Short reason string for non-ok results. */
  reason?: string;
  /** Which method ultimately produced `status` ("HEAD" or "GET"). */
  method: "HEAD" | "GET";
}

/**
 * Decide whether a status code counts as PASS. 2xx is the obvious yes;
 * a 3xx only reaches this function when Node fetch returns one without
 * following it — either a non-redirect 3xx response, or a redirect loop
 * that exceeded fetch's default cap (~20 hops). Either way we treat it
 * as a failure. 405 is the sentinel for "HEAD not supported — caller
 * should retry with GET".
 */
export function classifyStatus(status: number): "pass" | "retry-with-get" | "fail" {
  if (status >= 200 && status < 300) return "pass";
  if (status === 405) return "retry-with-get";
  return "fail";
}

/**
 * Single-URL probe with HEAD-then-GET-on-405 semantics. `fetchImpl` is
 * injectable so tests can drive the 405-fallback branch deterministically.
 */
export async function checkUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = TIMEOUT_MS,
): Promise<UrlCheckResult> {
  const attempt = async (method: "HEAD" | "GET"): Promise<UrlCheckResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: "follow",
        // Some health sites bot-block missing UA; identify the check politely.
        headers: {
          "user-agent":
            "carebridge-url-rot-check/1.0 (+https://github.com/blamechris/carebridge)",
          accept: "*/*",
        },
        signal: controller.signal,
      });
      const verdict = classifyStatus(res.status);
      if (verdict === "pass") {
        return { url, ok: true, status: res.status, method };
      }
      if (verdict === "retry-with-get" && method === "HEAD") {
        // Surface the 405 trigger by returning a sentinel; outer driver
        // re-calls with method=GET. Easier to test than a recursive call.
        return {
          url,
          ok: false,
          status: 405,
          reason: "HEAD rejected; will retry with GET",
          method,
        };
      }
      return {
        url,
        ok: false,
        status: res.status,
        reason: `HTTP ${res.status}`,
        method,
      };
    } catch (err) {
      const reason =
        err instanceof Error
          ? err.name === "AbortError"
            ? `timeout after ${timeoutMs}ms`
            : err.message
          : "unknown fetch error";
      return { url, ok: false, status: null, reason, method };
    } finally {
      clearTimeout(timer);
    }
  };

  const head = await attempt("HEAD");
  if (head.ok) return head;
  if (head.status === 405) {
    return attempt("GET");
  }
  return head;
}

export interface Report {
  total: number;
  passed: number;
  failed: UrlCheckResult[];
}

/**
 * Markdown-flavoured summary safe to drop into `$GITHUB_STEP_SUMMARY`
 * and into the body of a tracking issue. Kept text-only so a plaintext
 * reader (e.g. a notification email) still gets the meaningful content.
 */
export function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Patient-education URL check`);
  lines.push("");
  lines.push(`- Total URLs checked: **${report.total}**`);
  lines.push(`- Passed: **${report.passed}**`);
  lines.push(`- Failed: **${report.failed.length}**`);
  lines.push("");
  if (report.failed.length === 0) {
    lines.push(`All curated patient-education URLs responded with 2xx.`);
    return lines.join("\n");
  }
  lines.push(`## Broken URLs`);
  lines.push("");
  lines.push(`| URL | Status | Method | Reason |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const f of report.failed) {
    const status = f.status === null ? "—" : String(f.status);
    const reason = (f.reason ?? "").replace(/\|/g, "\\|");
    lines.push(`| ${f.url} | ${status} | ${f.method} | ${reason} |`);
  }
  return lines.join("\n");
}

/**
 * Pull every curated URL out of both education tables. De-duped because
 * a few entries genuinely share the same MedlinePlus landing page.
 */
export function collectCuratedUrls(
  diagnosis: Record<string, EducationContent> = DIAGNOSIS_EDUCATION_TABLE,
  medication: Record<string, EducationContent> = MEDICATION_EDUCATION_TABLE,
): string[] {
  const urls = new Set<string>();
  for (const entry of Object.values(diagnosis)) {
    for (const link of entry.links ?? []) urls.add(link.url);
  }
  for (const entry of Object.values(medication)) {
    for (const link of entry.links ?? []) urls.add(link.url);
  }
  return [...urls].sort();
}

async function main(): Promise<void> {
  const urls = collectCuratedUrls();
  const failed: UrlCheckResult[] = [];
  let passed = 0;

  // Sequential — 31ish URLs × 10s worst case is still under five minutes
  // and keeps us off any host's "too many concurrent requests" radar.
  for (const url of urls) {
    process.stdout.write(`Checking ${url} ... `);
    const result = await checkUrl(url);
    if (result.ok) {
      passed += 1;
      process.stdout.write(`OK (${result.status} via ${result.method})\n`);
    } else {
      failed.push(result);
      process.stdout.write(
        `FAIL (status=${result.status ?? "—"}, ${result.reason ?? "unknown"})\n`,
      );
    }
  }

  const report: Report = { total: urls.length, passed, failed };
  const markdown = formatReport(report);
  process.stdout.write("\n");
  process.stdout.write(markdown);
  process.stdout.write("\n");

  // GitHub Actions: write the markdown into the step summary so the run
  // page shows the table without a re-run-with-logs round trip.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(summaryPath, `${markdown}\n`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

// Only auto-run when invoked as a script (not when imported by tests).
// `import.meta.url` matches `process.argv[1]` exactly when this file is
// the entry point — works for both `tsx` and a future `node dist/...`.
const invokedAsScript = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
