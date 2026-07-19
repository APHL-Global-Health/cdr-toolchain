import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, getGlobalDispatcher } from "undici";
import { enableInsecureTls, __resetInsecureTlsForTest } from "./insecure-tls.js";

// The fix: `--insecure-tls` must install an insecure *global fetch dispatcher* — mutating
// process.env.NODE_TLS_REJECT_UNAUTHORIZED at runtime is too late for undici (already
// initialized), which is why the flag was a silent no-op on the CE POST path. These tests
// pin the dispatcher install + idempotency; the behavioral proof (a real fetch against a
// self-signed OpenLDR CE now succeeds) is exercised by the live migration run.

test("enableInsecureTls installs an insecure global fetch dispatcher + sets the env var", () => {
  __resetInsecureTlsForTest();
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  const before = getGlobalDispatcher();
  enableInsecureTls();

  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  const after = getGlobalDispatcher();
  assert.ok(after instanceof Agent, "global dispatcher should be an undici Agent");
  assert.notEqual(after, before, "a new (insecure) dispatcher should be installed");
});

test("enableInsecureTls is idempotent — a repeat call does not replace the dispatcher", () => {
  __resetInsecureTlsForTest();
  enableInsecureTls();
  const first = getGlobalDispatcher();
  enableInsecureTls();
  assert.equal(getGlobalDispatcher(), first, "second call must not swap the dispatcher");
});
