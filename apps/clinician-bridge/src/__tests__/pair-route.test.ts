import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../../app/api/v1/pair/route";
import { GET as GET_CAPTURE } from "../../app/api/v1/captures/[code]/route";
import { relayStore } from "../lib/relay-store";
import { bridgePairRecordSchema } from "@carebridge/shared-types";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost:3002/api/v1/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_CIPHERTEXT = "A".repeat(128);

describe("POST /api/v1/pair", () => {
  beforeEach(() => relayStore._reset());

  it("rejects non-JSON bodies", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/pair", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_json");
  });

  it("rejects requests that don't match the schema", async () => {
    const res = await POST(jsonReq({ wrong: "field" }));
    expect(res.status).toBe(400);
  });

  it("returns a pair record on a valid request and stores the envelope", async () => {
    const res = await POST(
      jsonReq({ ciphertext: VALID_CIPHERTEXT, caregiver_label: "Test" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(bridgePairRecordSchema.safeParse(body).success).toBe(true);
    expect(relayStore._size()).toBe(1);
  });

  it("subsequent GET by display_code returns the envelope", async () => {
    const postRes = await POST(jsonReq({ ciphertext: VALID_CIPHERTEXT }));
    const pair = await postRes.json();

    const getRes = await GET_CAPTURE(
      new Request(`http://localhost/api/v1/captures/${pair.display_code}`),
      { params: Promise.resolve({ code: pair.display_code }) },
    );
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.envelope.ciphertext).toBe(VALID_CIPHERTEXT);
    expect(body.envelope.capture_id).toBe(pair.capture_id);
  });
});

describe("GET /api/v1/captures/[code]", () => {
  beforeEach(() => relayStore._reset());

  it("returns 404 for an unknown code", async () => {
    const res = await GET_CAPTURE(new Request("http://localhost/x"), {
      params: Promise.resolve({ code: "ABCDEF" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed code (does not leak the code-format error)", async () => {
    const res = await GET_CAPTURE(new Request("http://localhost/x"), {
      params: Promise.resolve({ code: "with-dash" }),
    });
    expect(res.status).toBe(404);
  });

  it("accepts lowercase codes by normalizing to upper", async () => {
    const postRes = await POST(jsonReq({ ciphertext: VALID_CIPHERTEXT }));
    const pair = await postRes.json();

    const lower = pair.display_code.toLowerCase();
    const res = await GET_CAPTURE(new Request("http://localhost/x"), {
      params: Promise.resolve({ code: lower }),
    });
    expect(res.status).toBe(200);
  });
});
