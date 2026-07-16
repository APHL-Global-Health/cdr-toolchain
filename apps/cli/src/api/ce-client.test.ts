import { test } from "node:test";
import assert from "node:assert/strict";
import { postFhirResources } from "./ce-client.js";

test("posts a bare JSON array with the webhook token header", async () => {
  let seenUrl = "";
  let seenInit: any = null;
  const fakeFetch = async (url: any, init: any) => {
    seenUrl = String(url); seenInit = init;
    return new Response(JSON.stringify({ ok: true, runId: "r1" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };

  const res = await postFhirResources([{ resourceType: "Patient", id: "p1" }], {
    baseUrl: "https://ce.example.com/",
    path: "/api/workflows/hooks/cdr-ingest",
    token: "secret-token",
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });

  assert.equal(seenUrl, "https://ce.example.com/api/workflows/hooks/cdr-ingest");
  assert.equal(seenInit.headers["x-webhook-token"], "secret-token");
  // Not application/json => CE diverts the body to blob storage and drops it.
  assert.equal(seenInit.headers["Content-Type"], "application/json");
  // CE's webhook is secret-gated, not Keycloak-gated.
  assert.equal("Authorization" in seenInit.headers, false);
  // BARE ARRAY: split-out does a flat lookup on `body`.
  assert.deepEqual(JSON.parse(seenInit.body), [{ resourceType: "Patient", id: "p1" }]);
  assert.equal(res.status, 200);
  assert.equal((res.body as any).runId, "r1");
});

test("a 4xx raises and does not retry", async () => {
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return new Response("invalid webhook token", { status: 401 }); };
  await assert.rejects(
    () => postFhirResources([], {
      baseUrl: "https://ce.example.com", path: "/h", token: "bad",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    }),
    /401|invalid webhook token|API_REJECTED/,
  );
  assert.equal(calls, 1, "4xx must not be retried");
});

test("a 5xx retries then fails", async () => {
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return new Response("boom", { status: 503 }); };
  await assert.rejects(
    () => postFhirResources([], {
      baseUrl: "https://ce.example.com", path: "/h", token: "t", maxRetries: 3,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    }),
    /unreachable|API_UNAVAILABLE|503/,
  );
  assert.equal(calls, 3, "5xx must exhaust maxRetries");
});

test("a transient 5xx then success returns the success", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("boom", { status: 503 });
    return new Response(JSON.stringify({ ok: true, runId: "r2" }), { status: 200 });
  };
  const res = await postFhirResources([{ resourceType: "Patient" }], {
    baseUrl: "https://ce.example.com", path: "/h", token: "t", maxRetries: 3,
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  assert.equal(res.status, 200);
  assert.equal(res.attempts, 2);
});
