/*
 * Runs the scorer against the captured Phoenix deal and asserts it reaches the
 * right hotel for the right reasons. No dependencies:  node test/verify.mjs
 */

import assert from "node:assert/strict";
import { scoreCandidates } from "../src/score.js";
import { deal, candidates, expected } from "./fixtures.js";

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message });
  }
}

const result = scoreCandidates(deal, candidates);
const [top, second, third] = result.ranked;

console.log("\nRanking");
console.log("-------");
for (const c of result.ranked) {
  const a = c.signals.amenities;
  console.log(
    "  " +
      String(Math.round(c.score * 100)).padStart(3) +
      "%  " +
      (c.name || c.hotelId).padEnd(46) +
      " amenities " +
      (a.dealCount - a.missing.length) +
      "/" +
      a.dealCount +
      ", " +
      a.extra.length +
      " extra, " +
      c.disqualifiers.length +
      " disqualifier(s)"
  );
}
console.log("\nVerdict: " + result.verdict + "  (margin " + Math.round(result.margin * 100) + " pts)\n");

check("fixture sizes match what was captured live", () => {
  assert.equal(deal.amenities.length, expected.dealAmenityCount);
  const rr = candidates.find((c) => c.hotelId === expected.winnerId);
  assert.equal(rr.fingerprint.amenities.length, expected.redRoofAmenityCount);
});

check("Red Roof PLUS+ ranks first", () => {
  assert.equal(top.hotelId, expected.winnerId);
});

check("winner clears 90%", () => {
  assert.ok(top.score >= 0.9, "score was " + top.score);
});

check("winner is clear of the runner-up by >= 12 pts", () => {
  assert.ok(result.margin >= 0.12, "margin was " + result.margin);
});

check("verdict is confident", () => {
  assert.ok(
    result.verdict === "certain" || result.verdict === "likely",
    "verdict was " + result.verdict
  );
});

check("winner has no disqualifying contradiction", () => {
  assert.deepEqual(top.disqualifiers, []);
});

check("winner covers every amenity the deal advertises except the known cache gap", () => {
  const a = top.signals.amenities;
  assert.equal(a.extra.length, 0, "unexpected extras: " + JSON.stringify(a.extra));
  assert.equal(a.missing.length, 4, "missing: " + JSON.stringify(a.missing));
  assert.ok(
    a.missing.every((m) => !m.highSignal),
    "a high-signal amenity went missing"
  );
  assert.ok(a.sourceMismatch, "source mismatch should have been detected");
});

check("winner matches every review statistic", () => {
  const r = top.signals.reviews;
  assert.ok(r.parts.length >= 5, "only " + r.parts.length + " review signals");
  assert.equal(r.ratio, 1, "review ratio was " + r.ratio);
});

check("both decoys are rejected on high-signal amenities", () => {
  for (const c of [second, third]) {
    assert.ok(
      c.disqualifiers.length > 0,
      (c.name || c.hotelId) + " produced no disqualifier"
    );
  }
});

check("free breakfast is caught as a disqualifier on both decoys", () => {
  for (const c of [second, third]) {
    assert.ok(
      c.disqualifiers.some((d) => /breakfast/i.test(d)),
      (c.name || c.hotelId) + " did not flag breakfast"
    );
  }
});

check("review counts rule out both decoys", () => {
  for (const c of [second, third]) {
    const countPart = c.signals.reviews.parts.find((p) => p.key === "Review count");
    assert.ok(countPart && !countPart.ok, (c.name || c.hotelId) + " review count matched");
  }
});

check("bucketing does not punish the true hotel for exact values", () => {
  // 1,251 must satisfy "1,200+", and 6.6 must satisfy "6+".
  const r = top.signals.reviews;
  assert.ok(r.parts.find((p) => p.key === "Review count").ok);
  assert.ok(r.parts.find((p) => p.key === "Overall score").ok);
});

check("an unreadable candidate degrades instead of throwing", () => {
  const withFailure = [
    candidates[1],
    { hotelId: "999", name: "Broken", fingerprint: null, error: "Timed out" },
  ];
  const r = scoreCandidates(deal, withFailure);
  assert.equal(r.ranked[0].hotelId, expected.winnerId);
  assert.ok(r.ranked[1].unreadable);
  assert.equal(r.ranked[1].score, 0);
});

check("a deal with no usable signals is reported as unknown, not guessed", () => {
  const blank = {
    ...deal,
    amenities: [],
    reviews: {
      count: null,
      countBucketed: false,
      overall: null,
      overallLabel: null,
      bucketed: false,
      sub: {},
    },
    stars: null,
    badges: [],
    area: null,
  };
  const r = scoreCandidates(blank, [
    { hotelId: "1", name: "A", fingerprint: null, error: "no data" },
  ]);
  assert.equal(r.verdict, "unknown");
});

let failed = 0;
console.log("Checks");
console.log("------");
for (const c of checks) {
  console.log("  " + (c.ok ? "PASS" : "FAIL") + "  " + c.name);
  if (!c.ok) {
    console.log("        " + c.err);
    failed++;
  }
}
console.log(
  "\n" + (checks.length - failed) + "/" + checks.length + " checks passed\n"
);
process.exit(failed ? 1 : 0);
