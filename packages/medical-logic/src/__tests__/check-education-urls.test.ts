/**
 * Unit tests for the URL-rot detector (issue #1151). The HTTP layer is
 * exercised with a stubbed fetch so the suite never touches the network.
 * The cron workflow drives the real-network run on its own schedule.
 */

import { describe, it, expect } from "vitest";
import {
  classifyStatus,
  checkUrl,
  formatReport,
  collectCuratedUrls,
  type Report,
  type UrlCheckResult,
} from "../../scripts/check-education-urls.js";

describe("classifyStatus", () => {
  it("treats 200, 204, 299 as pass", () => {
    expect(classifyStatus(200)).toBe("pass");
    expect(classifyStatus(204)).toBe("pass");
    expect(classifyStatus(299)).toBe("pass");
  });

  it("treats 405 as the HEAD-not-supported sentinel", () => {
    expect(classifyStatus(405)).toBe("retry-with-get");
  });

  it("treats 404 / 500 / leftover 3xx as fail", () => {
    expect(classifyStatus(404)).toBe("fail");
    expect(classifyStatus(500)).toBe("fail");
    expect(classifyStatus(301)).toBe("fail");
  });
});

describe("checkUrl 405 → GET fallback", () => {
  /** Build a fake `fetch` that returns scripted responses, one per call. */
  function scriptedFetch(statuses: number[]): typeof fetch {
    let i = 0;
    return (async () => {
      const status = statuses[i++] ?? 500;
      return new Response(null, { status }) as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("returns pass on a HEAD 200 without a GET retry", async () => {
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await checkUrl("https://example.test/a", stub);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.method).toBe("HEAD");
    expect(calls).toBe(1);
  });

  it("retries with GET when HEAD returns 405 and succeeds on GET", async () => {
    const stub = scriptedFetch([405, 200]);
    const result = await checkUrl("https://www.heart.org/example", stub);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.method).toBe("GET");
  });

  it("retries with GET when HEAD returns 405 and still fails on GET", async () => {
    const stub = scriptedFetch([405, 404]);
    const result = await checkUrl("https://example.test/missing", stub);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.method).toBe("GET");
  });

  it("does not retry on a non-405 HEAD failure", async () => {
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const result = await checkUrl("https://example.test/gone", stub);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.method).toBe("HEAD");
    expect(calls).toBe(1);
  });

  it("surfaces fetch errors (network down, DNS failure) as failures", async () => {
    const stub = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await checkUrl("https://example.invalid/", stub);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.reason).toMatch(/fetch failed/);
  });

  it("reports a timeout when fetch is aborted", async () => {
    const stub = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // Honour the abort signal so the test doesn't hang.
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const result = await checkUrl("https://slow.test/", stub, 5);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.reason).toMatch(/timeout/);
  });
});

describe("formatReport", () => {
  it("reports a clean all-pass run", () => {
    const report: Report = { total: 5, passed: 5, failed: [] };
    const md = formatReport(report);
    expect(md).toMatch(/Total URLs checked.*5/);
    expect(md).toMatch(/Passed.*5/);
    expect(md).toMatch(/Failed.*0/);
    expect(md).toMatch(/All curated patient-education URLs/);
  });

  it("renders failures as a markdown table", () => {
    const failed: UrlCheckResult[] = [
      {
        url: "https://medlineplus.gov/bad.html",
        ok: false,
        status: 404,
        reason: "HTTP 404",
        method: "HEAD",
      },
      {
        url: "https://www.cdc.gov/missing",
        ok: false,
        status: null,
        reason: "fetch failed",
        method: "GET",
      },
    ];
    const md = formatReport({ total: 7, passed: 5, failed });
    expect(md).toMatch(/\| URL \| Status \| Method \| Reason \|/);
    expect(md).toMatch(/medlineplus\.gov\/bad\.html.*404.*HEAD.*HTTP 404/);
    expect(md).toMatch(/cdc\.gov\/missing.*—.*GET.*fetch failed/);
  });

  it("escapes pipe characters in reason text", () => {
    const md = formatReport({
      total: 1,
      passed: 0,
      failed: [
        {
          url: "https://example.test/",
          ok: false,
          status: 500,
          reason: "weird | reason",
          method: "HEAD",
        },
      ],
    });
    expect(md).toMatch(/weird \\\| reason/);
  });
});

describe("collectCuratedUrls", () => {
  it("dedupes URLs that appear in multiple education entries", () => {
    const diag = {
      X1: {
        title: "X1",
        summary: "",
        self_care: [],
        when_to_contact_provider: [],
        links: [
          { label: "a", url: "https://medlineplus.gov/a" },
          { label: "b", url: "https://medlineplus.gov/b" },
        ],
      },
      X2: {
        title: "X2",
        summary: "",
        self_care: [],
        when_to_contact_provider: [],
        links: [{ label: "a-again", url: "https://medlineplus.gov/a" }],
      },
    };
    const meds = {
      M1: {
        title: "M1",
        summary: "",
        self_care: [],
        when_to_contact_provider: [],
        links: [{ label: "c", url: "https://medlineplus.gov/c" }],
      },
    };
    const urls = collectCuratedUrls(diag, meds);
    expect(urls).toEqual([
      "https://medlineplus.gov/a",
      "https://medlineplus.gov/b",
      "https://medlineplus.gov/c",
    ]);
  });

  it("handles entries without links", () => {
    const diag = {
      X1: {
        title: "X1",
        summary: "",
        self_care: [],
        when_to_contact_provider: [],
      },
    };
    const urls = collectCuratedUrls(diag, {});
    expect(urls).toEqual([]);
  });
});
