/*
 * Scores each guaranteed candidate against the Express Deal fingerprint.
 *
 * The premise the whole thing rests on: an Express Deal listing is the real
 * hotel's own record with the name and photos stripped out. Everything else --
 * the amenity list, the review count, the sub-scores -- is passed through, only
 * rounded down into buckets. So the true hotel should reproduce the deal
 * exactly, and the decoys should not.
 */

const normalise = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Amenities that reliably separate hotels of the same class, so a mismatch on
// one of these is worth calling out in the UI even though every difference
// already feeds the numeric score.
const HIGH_SIGNAL = [
  "free breakfast",
  "hot breakfast included",
  "fitness center",
  "indoor pool",
  "outdoor pool",
  "hot tub whirlpool",
  "bar",
  "spa services",
  "kids pool",
  "refrigerator",
  "airport shuttle",
  "restaurant",
  "laundry services",
  "elevator",
  "closed caption tv",
];

const isHighSignal = (n) => HIGH_SIGNAL.includes(n);

function toSet(list) {
  const map = new Map();
  for (const item of list || []) map.set(normalise(item), item);
  return map;
}

/*
 * Express pages floor their numbers. "1,200+ reviews" means 1200-1299, and a
 * score shown as "6+" means 6.0-6.9. When the deal value is bucketed the
 * candidate is compared at that granularity; when it is exact (some pages do
 * show exact values) a small tolerance is allowed instead.
 */
function bucketMatch(dealValue, candValue, bucketed, bucketSize) {
  if (dealValue == null || candValue == null) return null;
  if (!bucketed) {
    const tol = bucketSize >= 100 ? Math.max(bucketSize * 0.02, 5) : 0.15;
    return Math.abs(dealValue - candValue) <= tol;
  }
  const floorTo = (v) => Math.floor(v / bucketSize) * bucketSize;
  return floorTo(candValue) === floorTo(dealValue);
}

function scoreReviews(deal, cand) {
  const d = deal.reviews || {};
  const c = cand.reviews || {};
  const parts = [];

  const count = bucketMatch(d.count, c.count, d.countBucketed, 100);
  if (count !== null) {
    parts.push({
      key: "Review count",
      weight: 3,
      ok: count,
      deal: d.countBucketed ? d.count + "+" : d.count,
      candidate: c.count,
    });
  }

  const overall = bucketMatch(d.overall, c.overall, d.bucketed, 1);
  if (overall !== null) {
    parts.push({
      key: "Overall score",
      weight: 2,
      ok: overall,
      deal: (d.bucketed ? d.overall + "+" : d.overall) +
        (d.overallLabel ? " " + d.overallLabel : ""),
      candidate: c.overall + (c.overallLabel ? " " + c.overallLabel : ""),
    });
  }

  for (const label of Object.keys(d.sub || {})) {
    const m = bucketMatch(d.sub[label], (c.sub || {})[label], d.bucketed, 1);
    if (m === null) continue;
    parts.push({
      key: label,
      weight: 1,
      ok: m,
      deal: d.bucketed ? d.sub[label] + "+" : d.sub[label],
      candidate: c.sub[label],
    });
  }

  const total = parts.reduce((a, p) => a + p.weight, 0);
  const hit = parts.reduce((a, p) => a + (p.ok ? p.weight : 0), 0);
  return { parts, ratio: total ? hit / total : null };
}

function scoreAmenities(deal, cand) {
  const dealSet = toSet(deal.amenities);
  const candSet = toSet(cand.amenities);

  const missing = []; // in the deal but not on the candidate
  const extra = []; // on the candidate but not in the deal

  for (const [n, original] of dealSet) {
    if (!candSet.has(n)) missing.push({ name: original, highSignal: isHighSignal(n) });
  }
  for (const [n, original] of candSet) {
    if (!dealSet.has(n)) extra.push({ name: original, highSignal: isHighSignal(n) });
  }

  const dealCount = dealSet.size;
  const candCount = candSet.size;

  // Both directions matter. A candidate missing something the deal advertises
  // cannot be the hotel; a candidate advertising something the deal omits is
  // equally disqualifying, because the deal would have listed it.
  const coverage = dealCount ? (dealCount - missing.length) / dealCount : null;
  const cleanliness = candCount ? (candCount - extra.length) / candCount : null;

  // A cache list and a DOM-scraped list can differ by a whole category for
  // structural reasons rather than real ones, so the comparison is flagged and
  // the scorer leans on the review signals instead of over-punishing.
  const sourceMismatch = deal.amenitySource !== cand.amenitySource;

  let ratio = null;
  if (coverage !== null && cleanliness !== null) {
    ratio = sourceMismatch
      ? coverage * 0.75 + cleanliness * 0.25
      : coverage * 0.5 + cleanliness * 0.5;
  }

  return {
    ratio,
    coverage,
    cleanliness,
    sourceMismatch,
    dealCount,
    candCount,
    missing,
    extra,
    exact: missing.length === 0 && extra.length === 0 && dealCount > 0,
  };
}

function scoreSimple(deal, cand) {
  const parts = [];

  if (deal.stars && cand.stars) {
    parts.push({
      key: "Star rating",
      weight: 1,
      ok: String(deal.stars) === String(cand.stars),
      deal: deal.stars,
      candidate: cand.stars,
    });
  }

  if (deal.badges && cand.badges && (deal.badges.length || cand.badges.length)) {
    const d = new Set(deal.badges);
    const c = new Set(cand.badges);
    const inter = [...d].filter((b) => c.has(b)).length;
    const union = new Set([...d, ...c]).size;
    parts.push({
      key: "Badges",
      weight: 1,
      ok: union > 0 && inter === union,
      ratio: union ? inter / union : null,
      deal: deal.badges.join(", ") || "none",
      candidate: cand.badges.join(", ") || "none",
    });
  }

  if (deal.area && (cand.area || cand.address)) {
    const target = normalise(deal.area);
    const hay = normalise((cand.area || "") + " " + (cand.address || ""));
    parts.push({
      key: "Neighbourhood",
      weight: 1,
      ok: hay.includes(target) || target.includes(normalise(cand.area || "")),
      deal: deal.area,
      candidate: cand.area || cand.address,
    });
  }

  const total = parts.reduce((a, p) => a + p.weight, 0);
  const hit = parts.reduce(
    (a, p) => a + (p.ratio != null ? p.ratio : p.ok ? 1 : 0) * p.weight,
    0
  );
  return { parts, ratio: total ? hit / total : null };
}

const WEIGHTS = { amenities: 0.5, reviews: 0.35, simple: 0.15 };

export function scoreCandidate(deal, candidate) {
  const fp = candidate.fingerprint;
  if (!fp) {
    return {
      ...candidate,
      score: 0,
      unreadable: true,
      reason: candidate.error || "Could not read this hotel page.",
    };
  }

  const amenities = scoreAmenities(deal, fp);
  const reviews = scoreReviews(deal, fp);
  const simple = scoreSimple(deal, fp);

  // Renormalise across whichever signals were actually available, so a page
  // that hid one of them does not drag the score down on its own.
  let weighted = 0;
  let used = 0;
  for (const [name, group] of [
    ["amenities", amenities],
    ["reviews", reviews],
    ["simple", simple],
  ]) {
    if (group.ratio == null) continue;
    weighted += group.ratio * WEIGHTS[name];
    used += WEIGHTS[name];
  }
  const score = used ? weighted / used : 0;

  return {
    ...candidate,
    score,
    signals: { amenities, reviews, simple },
    disqualifiers: [
      ...amenities.missing.filter((a) => a.highSignal).map((a) => "Deal lists " + a.name + ", this hotel does not"),
      ...amenities.extra.filter((a) => a.highSignal).map((a) => "Has " + a.name + ", absent from the deal"),
      ...reviews.parts.filter((p) => !p.ok).map((p) => p.key + ": deal says " + p.deal + ", this hotel is " + p.candidate),
    ],
  };
}

export function scoreCandidates(deal, candidates) {
  const ranked = candidates
    .map((c) => scoreCandidate(deal, c))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const runnerUp = ranked[1];
  const margin = top && runnerUp ? top.score - runnerUp.score : top ? 1 : 0;

  // "Confident" is deliberately strict: a near-perfect top score, clear air
  // behind it, and no high-signal contradiction.
  const exactAmenities = !!(top && top.signals && top.signals.amenities.exact);
  const confident = !!(
    top &&
    !top.unreadable &&
    top.score >= 0.9 &&
    margin >= 0.12 &&
    top.disqualifiers.length === 0
  );

  let verdict;
  if (!top || top.unreadable) verdict = "unknown";
  else if (confident && exactAmenities) verdict = "certain";
  else if (confident) verdict = "likely";
  else if (margin >= 0.06) verdict = "leaning";
  else verdict = "inconclusive";

  return { ranked, verdict, margin, confident, exactAmenities };
}
