/*
 * Tests for the week-long cache and the throttle classifier:
 *   node test/store.mjs
 *
 * The cache exists to stop the extension re-requesting something it already
 * has, so the central assertion is that a cached deal causes NO fetch at all.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const checks = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => checks.push({ name, ok: true }))
    .catch((err) => checks.push({ name, ok: false, err: err.message }));
}

/* ------------------------------------------------------------------ *
 * A minimal chrome.storage.local stand-in
 * ------------------------------------------------------------------ */

function fakeChrome() {
  const data = {};
  return {
    data,
    runtime: { lastError: null },
    storage: {
      local: {
        get(key, cb) {
          if (key === null) return cb({ ...data });
          cb(key in data ? { [key]: data[key] } : {});
        },
        set(obj, cb) {
          Object.assign(data, obj);
          cb && cb();
        },
        remove(keys, cb) {
          for (const k of [].concat(keys)) delete data[k];
          cb && cb();
        },
      },
    },
  };
}

// Same realm as the test, not a fresh vm context: a separate realm gives the
// returned arrays a different Array.prototype, which makes assert's strict
// deepEqual fail on prototype identity even when the contents are identical.
function loadModule(file, extraGlobals) {
  Object.assign(globalThis, extraGlobals);
  globalThis.self = globalThis;
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", file),
    "utf8"
  );
  vm.runInThisContext(src);
  return globalThis;
}

const chrome = fakeChrome();
const STORE = loadModule("store.js", { chrome }).PCLNREV_STORE;
const GRAPH = loadModule("graph.js", {
  fetch: async () => {
    throw new Error("no network in tests");
  },
  sessionStorage: { getItem: () => null, setItem: () => {} },
}).PCLNREV_GRAPH;

/* ------------------------------------------------------------------ *
 * Keys and freshness
 * ------------------------------------------------------------------ */

await check("keys include everything that changes the answer", () => {
  const a = STORE.makeKey("deal", ["ID1", "20260922", "20260923", "1"]);
  const b = STORE.makeKey("deal", ["ID1", "20260923", "20260924", "1"]);
  assert.notEqual(a, b, "different dates must not share a key");
  assert.ok(a.startsWith(STORE.PREFIX));
});

await check("an entry is fresh for a week and stale after", () => {
  const now = 1_000_000_000_000;
  assert.equal(STORE.isFresh({ at: now }, now, STORE.WEEK_MS), true);
  assert.equal(
    STORE.isFresh({ at: now - STORE.WEEK_MS + 1000 }, now, STORE.WEEK_MS),
    true,
    "just inside a week should be fresh"
  );
  assert.equal(
    STORE.isFresh({ at: now - STORE.WEEK_MS - 1000 }, now, STORE.WEEK_MS),
    false,
    "just over a week should be stale"
  );
  assert.equal(STORE.isFresh(null, now, STORE.WEEK_MS), false);
  assert.equal(STORE.isFresh({}, now, STORE.WEEK_MS), false);
});

await check("prune targets expired entries and leaves foreign keys alone", () => {
  const now = 2_000_000_000_000;
  const all = {
    [STORE.PREFIX + "a"]: { at: now - 1000 },
    [STORE.PREFIX + "b"]: { at: now - STORE.WEEK_MS - 1 },
    "someone.else": { at: 0 },
  };
  const dead = STORE.expiredKeys(all, now, STORE.WEEK_MS);
  assert.deepEqual(dead, [STORE.PREFIX + "b"]);
});

await check("overflow trims the oldest entries only", () => {
  const all = {};
  for (let i = 0; i < 10; i++) all[STORE.PREFIX + i] = { at: i };
  const over = STORE.overflowKeys(all, 7);
  assert.equal(over.length, 3);
  assert.deepEqual(over, [STORE.PREFIX + "0", STORE.PREFIX + "1", STORE.PREFIX + "2"]);
});

/* ------------------------------------------------------------------ *
 * The point of the whole thing: no repeat requests
 * ------------------------------------------------------------------ */

await check("a cached deal is never fetched again", async () => {
  const key = STORE.makeKey("deal", ["DEAL-A", "20260922", "20260923", "1"]);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { amenities: ["Outdoor pool"], star: 2.5 };
  };

  const first = await STORE.getOrFetch(key, fetcher, STORE.WEEK_MS);
  assert.equal(calls, 1, "first read should fetch once");
  assert.equal(first.cached, false);

  const second = await STORE.getOrFetch(key, fetcher, STORE.WEEK_MS);
  assert.equal(calls, 1, "second read must not fetch again");
  assert.equal(second.cached, true);
  assert.deepEqual(second.value, first.value);

  const third = await STORE.getOrFetch(key, fetcher, STORE.WEEK_MS);
  assert.equal(calls, 1, "still must not fetch");
  assert.equal(third.cached, true);
});

await check("a stale entry is refetched", async () => {
  const key = STORE.makeKey("deal", ["DEAL-B", "20260922", "20260923", "1"]);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { n: calls };
  };
  await STORE.getOrFetch(key, fetcher, STORE.WEEK_MS);
  assert.equal(calls, 1);

  // Age the stored entry past a week.
  chrome.data[key].at = Date.now() - STORE.WEEK_MS - 1;
  const again = await STORE.getOrFetch(key, fetcher, STORE.WEEK_MS);
  assert.equal(calls, 2, "a week-old entry should be refetched");
  assert.equal(again.cached, false);
});

await check("a failed fetch is not cached, so it will be retried", async () => {
  const key = STORE.makeKey("deal", ["DEAL-C", "20260922", "20260923", "1"]);
  let calls = 0;
  const failing = async () => {
    calls++;
    return null; // what a throttled request returns
  };
  await STORE.getOrFetch(key, failing, STORE.WEEK_MS);
  await STORE.getOrFetch(key, failing, STORE.WEEK_MS);
  assert.equal(calls, 2, "a null result must not be cached");
  assert.equal(chrome.data[key], undefined, "nothing should have been stored");
});

await check("a throwing fetch is contained and not cached", async () => {
  const key = STORE.makeKey("deal", ["DEAL-D", "20260922", "20260923", "1"]);
  const boom = async () => {
    throw new Error("network down");
  };
  const got = await STORE.getOrFetch(key, boom, STORE.WEEK_MS);
  assert.equal(got.value, null);
  assert.equal(chrome.data[key], undefined);
});

/* ------------------------------------------------------------------ *
 * Throttle detection
 * ------------------------------------------------------------------ */

await check("classifies an explicit rate limit", () => {
  assert.equal(GRAPH.classifyResponse(429, "application/json", "{}"), GRAPH.THROTTLED);
  assert.equal(GRAPH.classifyResponse(403, "application/json", "{}"), GRAPH.THROTTLED);
  assert.equal(GRAPH.classifyResponse(503, "text/html", ""), GRAPH.THROTTLED);
});

await check("treats an HTML body from a JSON endpoint as throttling", () => {
  // The observed failure mode: 200 with an interstitial instead of data.
  assert.equal(
    GRAPH.classifyResponse(200, "text/html; charset=utf-8", "<!DOCTYPE html>"),
    GRAPH.THROTTLED
  );
  assert.equal(GRAPH.classifyResponse(200, null, "  <html>"), GRAPH.THROTTLED);
});

await check("accepts a normal JSON answer", () => {
  assert.equal(
    GRAPH.classifyResponse(200, "application/json", '{"data":{}}'),
    GRAPH.OK
  );
});

await check("separates a server error from throttling", () => {
  assert.equal(GRAPH.classifyResponse(500, "application/json", "{}"), GRAPH.FAILED);
  assert.equal(GRAPH.classifyResponse(404, "application/json", "{}"), GRAPH.FAILED);
});

await check("detects a deal page that returns 200 but never hydrates", () => {
  // This is what Priceline actually did: HTTP 200, complete document, no app.
  const shell = "<html><body>" + "x".repeat(3000) + "</body></html>";
  assert.equal(GRAPH.classifyDealPage(200, shell), GRAPH.THROTTLED);

  const real = "<html>" + "y".repeat(3000) + "PCLN_BOOTSTRAP_DATA</html>";
  assert.equal(GRAPH.classifyDealPage(200, real), GRAPH.OK);

  const withQuery = "<html>" + "y".repeat(3000) + "query getSopqHotelDetails{}</html>";
  assert.equal(GRAPH.classifyDealPage(200, withQuery), GRAPH.OK);

  assert.equal(GRAPH.classifyDealPage(200, "tiny"), GRAPH.THROTTLED);
});

/* ------------------------------------------------------------------ */

let failed = 0;
for (const c of checks) {
  console.log("  " + (c.ok ? "PASS" : "FAIL") + "  " + c.name);
  if (!c.ok) {
    console.log("        " + c.err);
    failed++;
  }
}
console.log("\n" + (checks.length - failed) + "/" + checks.length + " checks passed\n");
process.exit(failed ? 1 : 0);
