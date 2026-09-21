/*
 * Tests for the listings-page parser and matcher:  node test/listings.mjs
 *
 * listings-core.js is a classic script (content scripts cannot be ES modules),
 * so it is loaded here through vm rather than import. That keeps the extension
 * loadable by Chrome without a build step while still being testable.
 *
 * Field values come from the live Peoria/Phoenix Express Deals page captured on
 * 2026-09-21. The one exception is each candidate's own retail price, which is
 * synthetic: those exercise the savings arithmetic and are not price claims.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "..", "src", "listings-core.js"),
  "utf8"
);
// runInThisContext, not runInNewContext: a separate realm gives the parsed
// objects a different Object.prototype, which makes assert's strict deepEqual
// fail on prototype identity even when the structure is identical.
globalThis.self = globalThis;
vm.runInThisContext(src);
const CORE = globalThis.self.PCLNREV_CORE;

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message });
  }
}

/* ------------------------------------------------------------------ *
 * Fixture builders -- shaped exactly like Priceline's embedded JSON
 * ------------------------------------------------------------------ */

const amen = (names) =>
  names.map((n) => ({
    __typename: "SopqHotelAmenityWithCategory",
    category: { __typename: "SopqAmenityCategory", id: "205", text: "General" },
    code: n.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8),
    name: n,
  }));

const reviewInfo = (countLabel, scores) => ({
  __typename: "HotelReviewEntityDefinition",
  reviewSummary: {
    __typename: "HotelReviewSummary",
    total: { __typename: "HotelReviewCountSummary", label: countLabel },
    scores: Object.entries(scores).map(([label, score]) => ({
      __typename: "HotelReviewScore",
      label,
      score: String(score),
    })),
  },
});

const rateSummary = (nightly, total, strike) => ({
  __typename: "HotelRoomRateSummary",
  pclnId: "PCLN",
  minPrice: {
    __typename: "HotelPrice",
    amount: String(nightly),
    currencyPrefix: "$",
    strikePrice: strike == null ? null : String(strike),
  },
  nightlyAllRoomsPriceExcludingTax: {
    __typename: "HotelPrice",
    amount: String(nightly),
    strikePrice: strike == null ? null : String(strike),
  },
  grandTotal: { __typename: "HotelPrice", amount: String(total) },
});

function sopqDeal(o) {
  return {
    __typename: "SopqHotelListing",
    productType: "EXPRESS_DEAL",
    hotelInfo: {
      __typename: "SopqHotel",
      id: o.token,
      name: o.name,
      starLevelText: o.starText,
      location: { __typename: "HotelLocation", id: o.locationId, name: "Phoenix, AZ" },
      neighborhood: { __typename: "Neighborhood", id: "910000339", name: o.hood },
      amenities: amen(o.amenities),
      guaranteedBrands: { __typename: "GuaranteedHotelBrands", brands: [] },
      traitBadges: (o.badges || []).map((label) => ({ code: label, label, category: "X" })),
      reviewInfo: reviewInfo(o.reviewLabel, o.scores),
    },
    minRateSummary: rateSummary(o.nightly, o.total, o.strike),
  };
}

function rtlHotel(o) {
  return {
    __typename: "RtlHotelListing",
    hotelInfo: {
      __typename: "RtlHotel",
      id: o.id,
      name: o.name,
      starRating: String(o.star),
      starLevelText: o.star + "-Star Hotel",
      location: { __typename: "HotelLocation", id: "3000001349", name: "Phoenix, AZ" },
      neighborhood: { __typename: "Neighborhood", id: "910000339", name: o.hood },
      amenities: amen(o.amenities),
      traitBadges: (o.badges || []).map((label) => ({ code: label, label, category: "X" })),
      reviewInfo: reviewInfo(o.reviewLabel, o.scores),
    },
    minRateSummary: rateSummary(o.nightly, o.total, null),
  };
}

// Mimics the real document: the payload appears once as clean JSON and again
// inside an escaped string copy, which the parser must discard.
function buildHtml(objects) {
  const clean = objects.map((o) => JSON.stringify(o)).join(",");
  const escaped = JSON.stringify(clean);
  return (
    "<script>self.__next_f.push([1,[" +
    clean +
    "]])</script>\n<script>self.__next_f.push([1," +
    escaped +
    "])</script>"
  );
}

/* ------------------------------------------------------------------ *
 * The captured deal
 * ------------------------------------------------------------------ */

const DEAL_AMENITIES = [
  "Free Internet Access",
  "Free Parking",
  "Pets Allowed",
  "Swimming Pool",
  "Accessible Rooms/Facilities",
  "No Smoking Rooms/Facilities",
];

const theDeal = sopqDeal({
  token: "75B935C7A9FDFE1CABC8220B39CA1B41",
  name: "A 2.5-Star Hotel in the West Phoenix Area",
  starText: "2.5-Star Hotel",
  locationId: "3000001349",
  hood: "West Phoenix - Avondale",
  amenities: DEAL_AMENITIES,
  badges: ["Family Friendly", "Top Booked"],
  reviewLabel: "1,200+ Reviews",
  scores: { Staff: "7+", Cleanliness: "7+", Location: "6+", Overall: "6+" },
  nightly: "57.37",
  total: "63.97",
  strike: "69",
});

// Retail prices below are synthetic; the rest is captured.
const redRoof = rtlHotel({
  id: "4593905",
  name: "Red Roof PLUS+ Phoenix West",
  star: 2.5,
  hood: "West Phoenix - Avondale",
  amenities: DEAL_AMENITIES,
  badges: ["Top Booked", "Family Friendly"],
  reviewLabel: "1,251 Reviews",
  scores: { Staff: "7.5", Cleanliness: "7.2", Location: "6.8", Overall: "6.6" },
  nightly: "68.00",
  total: "74.50",
});

const comfortInn = rtlHotel({
  id: "48184",
  name: "Comfort Inn I-10 West at 51st Ave Phoenix",
  star: 2.5,
  hood: "West Phoenix - Avondale",
  amenities: [...DEAL_AMENITIES, "Hot Breakfast Included", "Fitness Center"],
  reviewLabel: "283 Reviews",
  scores: { Staff: "7.8", Cleanliness: "6.9", Location: "7.1", Overall: "6.8" },
  nightly: "62.00",
  total: "69.00",
});

const baymont = rtlHotel({
  id: "2232505",
  name: "Baymont by Wyndham Phoenix I-10 near 51st Ave",
  star: 2.5,
  hood: "West Phoenix - Avondale",
  amenities: [...DEAL_AMENITIES, "Hot Breakfast Included"],
  reviewLabel: "912 Reviews",
  scores: { Staff: "8.4", Cleanliness: "7.9", Location: "7.5", Overall: "7.6" },
  nightly: "85.00",
  total: "92.00",
});

// Same metro, different neighbourhood -- must be excluded on location alone.
const elsewhere = rtlHotel({
  id: "37165104",
  name: "Residence Inn Tempe Downtown",
  star: 3,
  hood: "Tempe North - ASU",
  amenities: DEAL_AMENITIES,
  reviewLabel: "1,240 Reviews",
  scores: { Staff: "7.4", Cleanliness: "7.1", Location: "6.2", Overall: "6.4" },
  nightly: "120.00",
  total: "131.00",
});

const pool = [redRoof, comfortInn, baymont, elsewhere].map((l) =>
  CORE.parseHotels(buildHtml([l]))[0]
);
const deal = CORE.parseDeals(buildHtml([theDeal]))[0];

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

check("parses deals and discards the escaped duplicate copy", () => {
  const parsed = CORE.parseDeals(buildHtml([theDeal]));
  assert.equal(parsed.length, 1, "got " + parsed.length);
  assert.equal(parsed[0].token, theDeal.hotelInfo.id);
});

check("parses several deals from one page", () => {
  const two = CORE.parseDeals(
    buildHtml([theDeal, { ...theDeal, hotelInfo: { ...theDeal.hotelInfo, id: "OTHER" } }])
  );
  assert.equal(two.length, 2);
});

check("reads the deal fields the matcher depends on", () => {
  assert.equal(deal.star, 2.5);
  assert.equal(deal.neighborhood, "West Phoenix - Avondale");
  assert.equal(deal.locationId, "3000001349");
  assert.deepEqual(deal.reviews, { count: 1200, bucketed: true });
  assert.equal(deal.scores.overall, 6);
  assert.equal(deal.scores.bucketed, true);
  assert.deepEqual(deal.scores.sub, { Staff: 7, Cleanliness: 7, Location: 6 });
  assert.equal(deal.amenities.length, 6);
  assert.equal(deal.prices.nightly, 57.37);
  assert.equal(deal.prices.total, 63.97);
});

check("reads real hotels with exact, non-bucketed stats", () => {
  const rr = pool[0];
  assert.equal(rr.star, 2.5);
  assert.deepEqual(rr.reviews, { count: 1251, bucketed: false });
  assert.equal(rr.scores.overall, 6.6);
  assert.equal(rr.scores.bucketed, false);
});

/* ------------------------------------------------------------------ *
 * Bucketing
 * ------------------------------------------------------------------ */

check("1,251 satisfies a 1,200+ bucket but 1,320 does not", () => {
  assert.equal(CORE.inBucket(1200, 1251, true, 100), true);
  assert.equal(CORE.inBucket(1200, 1200, true, 100), true);
  assert.equal(CORE.inBucket(1200, 1299, true, 100), true);
  assert.equal(CORE.inBucket(1200, 1320, true, 100), false);
  assert.equal(CORE.inBucket(1200, 912, true, 100), false);
});

check("6.6 satisfies a 6+ band but 7.6 does not", () => {
  assert.equal(CORE.inBucket(6, 6.6, true, 1), true);
  assert.equal(CORE.inBucket(6, 6.0, true, 1), true);
  assert.equal(CORE.inBucket(6, 6.9, true, 1), true);
  assert.equal(CORE.inBucket(6, 7.6, true, 1), false);
  assert.equal(CORE.inBucket(7, 6.9, true, 1), false);
});

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

const match = CORE.matchDeal(deal, pool);

check("identifies exactly one hotel", () => {
  assert.equal(match.verdict, "identified", JSON.stringify(match.survivors.map((s) => s.hotel.name)));
  assert.equal(match.survivors.length, 1);
  assert.equal(match.survivors[0].hotel.id, "4593905");
});

check("rules out the low-review-count decoy", () => {
  const ci = CORE.hardChecks(deal, pool[1]);
  const failed = ci.filter((c) => !c.ok).map((c) => c.key);
  assert.ok(failed.includes("Review count"), "failed: " + failed.join(", "));
});

check("rules out the high-score decoy", () => {
  const bm = CORE.hardChecks(deal, pool[2]);
  const failed = bm.filter((c) => !c.ok).map((c) => c.key);
  assert.ok(failed.includes("Review count"));
  assert.ok(failed.includes("Overall score"));
});

check("rules out a hotel in a different neighbourhood", () => {
  const far = CORE.hardChecks(deal, pool[3]);
  const failed = far.filter((c) => !c.ok).map((c) => c.key);
  assert.ok(failed.includes("Neighbourhood"), "failed: " + failed.join(", "));
  assert.ok(failed.includes("Star rating"));
});

check("amenity check is one-directional: extras on the hotel are allowed", () => {
  // The deal card shows a curated top-six, not an exhaustive list, so a hotel
  // offering more must not be penalised at listing level.
  const withExtras = CORE.hardChecks(deal, pool[1]).find((c) => c.key === "Amenities");
  assert.equal(withExtras.ok, true);
});

check("a hotel missing an advertised amenity is ruled out", () => {
  const stripped = CORE.parseHotels(
    buildHtml([
      rtlHotel({
        ...{
          id: "999",
          name: "No Pool Inn",
          star: 2.5,
          hood: "West Phoenix - Avondale",
          reviewLabel: "1,251 Reviews",
          scores: { Staff: "7.5", Cleanliness: "7.2", Location: "6.8", Overall: "6.6" },
          nightly: "60.00",
          total: "66.00",
        },
        amenities: DEAL_AMENITIES.filter((a) => a !== "Swimming Pool"),
      }),
    ])
  )[0];
  const c = CORE.hardChecks(deal, stripped).find((x) => x.key === "Amenities");
  assert.equal(c.ok, false);
  assert.deepEqual(c.missing, ["Swimming Pool"]);
});

check("reports ambiguity instead of guessing when two hotels both fit", () => {
  const twin = CORE.parseHotels(
    buildHtml([
      rtlHotel({
        id: "111",
        name: "Twin Inn Phoenix West",
        star: 2.5,
        hood: "West Phoenix - Avondale",
        amenities: DEAL_AMENITIES,
        reviewLabel: "1,288 Reviews",
        scores: { Staff: "7.1", Cleanliness: "7.9", Location: "6.1", Overall: "6.2" },
        nightly: "72.00",
        total: "79.00",
      }),
    ])
  )[0];
  const m = CORE.matchDeal(deal, [...pool, twin]);
  assert.equal(m.verdict, "ambiguous");
  assert.equal(m.survivors.length, 2);
});

check("reports a near miss with the failing signal named", () => {
  const off = CORE.parseHotels(
    buildHtml([
      rtlHotel({
        id: "222",
        name: "One Off Inn",
        star: 2.5,
        hood: "West Phoenix - Avondale",
        amenities: DEAL_AMENITIES,
        reviewLabel: "1,251 Reviews",
        scores: { Staff: "7.5", Cleanliness: "7.2", Location: "8.8", Overall: "6.6" },
        nightly: "60.00",
        total: "66.00",
      }),
    ])
  )[0];
  const m = CORE.matchDeal(deal, [off]);
  assert.equal(m.verdict, "near-miss");
  assert.equal(m.nearMiss[0].failed.length, 1);
  assert.equal(m.nearMiss[0].failed[0].key, "Location");
});

check("reports no match rather than inventing one", () => {
  const m = CORE.matchDeal(deal, [pool[3]]);
  assert.equal(m.verdict, "no-match");
  assert.equal(m.survivors.length, 0);
});

check("will not identify on too few comparable signals", () => {
  const sparse = {
    kind: "hotel",
    id: "333",
    name: "Sparse Inn",
    star: null,
    neighborhood: null,
    amenities: [],
    badges: [],
    reviews: { count: null, bucketed: false },
    scores: { overall: null, bucketed: false, sub: {} },
    prices: { nightly: null, total: null, currency: "$" },
  };
  const m = CORE.matchDeal(deal, [sparse]);
  assert.notEqual(m.verdict, "identified");
});

/* ------------------------------------------------------------------ *
 * Cross-vocabulary amenity matching (the GraphQL-enriched path)
 *
 * The detail wording below is the real 56-entry record for the West Phoenix
 * deal, captured on 2026-09-21; the short wording is what listings return.
 * ------------------------------------------------------------------ */

const REAL_DETAIL_AMENITIES = [
  "Coffee/tea maker", "Ironing amenities", "Fire extinguishers", "Trash cans",
  "Room towels provided", "Telephone", "Bathtub", "Linens", "Safety deposit box",
  "Complimentary drinking water", "Sleep comfort items", "Blackout curtains",
  "Toiletries provided", "Alarm clock", "Separate shower/bathtub",
  "Cleaning products available", "Smoke alarms", "Carbon monoxide detector",
  "Air conditioning", "Shower", "Clothes drying rack", "Hair dryer", "Heating",
  "Socket near the bed", "Microwave", "Family rooms",
  "CCTV security in common areas", "Safety chain and/or latch on doors available",
  "Designated smoking area", "Cashless payment available", "Wake up call",
  "Desk/workspace available", "ATM or cash withdraw on site",
  "Staff trained in safety protocol", "Physical/social distancing guidelines",
  "Contactless check-in/out", "Daily disinfection", "Spanish", "English",
  "Heating in public area", "Air conditioning in public area", "Elevator",
  "Non-smoking rooms available", "24-hour front desk",
  "Pets allowed (charges may apply)", "Non-smoking property",
  "TV & Movies/Shows", "Free Wi-Fi", "Vending machine", "On-site parking",
  "Free parking", "Outdoor pool", "Closed-caption TV", "Wheelchair accessible",
  "Facilities for disabled guests available", "Visual aids Braille/Tactile signs",
];

check("maps short amenity wording onto the detail record", () => {
  const r = CORE.crossAmenityCheck(REAL_DETAIL_AMENITIES, DEAL_AMENITIES);
  assert.equal(r.missing.length, 0, "unmatched: " + JSON.stringify(r.missing));
  assert.ok(r.compared.length >= 5, "only compared " + r.compared.length);
});

check("catches free breakfast that the deal record does not have", () => {
  const r = CORE.crossAmenityCheck(REAL_DETAIL_AMENITIES, [
    ...DEAL_AMENITIES,
    "Hot Breakfast Included",
  ]);
  assert.deepEqual(r.missing, ["Hot Breakfast Included"]);
});

check("catches a fitness centre the deal record does not have", () => {
  const r = CORE.crossAmenityCheck(REAL_DETAIL_AMENITIES, ["Fitness Center", "Spa"]);
  assert.deepEqual(r.missing.sort(), ["Fitness Center", "Spa"]);
});

check("does not let a substring collide across amenities", () => {
  // Regression guard: deals list the languages spoken, so "Spanish" is a real
  // entry. Substring matching made "Spa" match it and waved through a hotel
  // with a spa the deal does not have. Matching is whole-word sequences.
  assert.ok(REAL_DETAIL_AMENITIES.includes("Spanish"));
  const r = CORE.crossAmenityCheck(REAL_DETAIL_AMENITIES, ["Spa"]);
  assert.deepEqual(r.missing, ["Spa"], "Spa must not be satisfied by Spanish");
});

check("skips short terms it has no mapping for", () => {
  const r = CORE.crossAmenityCheck(REAL_DETAIL_AMENITIES, ["Rooftop Helipad"]);
  assert.deepEqual(r.compared, []);
  assert.deepEqual(r.missing, []);
});

check("enrichment survives the two neighbourhood spellings", () => {
  // Regression guard, found by running the real flow: the detail record says
  // "West Phoenix - Avondale Area" where listings say "West Phoenix -
  // Avondale". Overwriting the listing value with the suffixed one made every
  // neighbourhood check fail, so enrichment made matching worse, not better.
  const enriched = CORE.enrichDeal(deal, {
    star: 2.5,
    neighborhood: "West Phoenix - Avondale Area",
    amenities: REAL_DETAIL_AMENITIES,
    amenityCategories: [],
    brandNames: [],
    guaranteedHotels: [],
  });
  const hood = CORE.hardChecks(enriched, pool[0]).find((c) => c.key === "Neighbourhood");
  assert.ok(hood, "no neighbourhood check produced");
  assert.equal(hood.ok, true, "deal " + hood.deal + " vs hotel " + hood.cand);

  // And the suffix alone must not break a match even if it is the only value.
  const onlySuffixed = CORE.enrichDeal(
    { ...deal, neighborhood: null },
    {
      star: 2.5,
      neighborhood: "West Phoenix - Avondale Area",
      amenities: REAL_DETAIL_AMENITIES,
      amenityCategories: [],
      brandNames: [],
      guaranteedHotels: [],
    }
  );
  const h2 = CORE.hardChecks(onlySuffixed, pool[0]).find((c) => c.key === "Neighbourhood");
  assert.equal(h2.ok, true, "suffixed-only value should still match");
});

check("enrichment adds the detail record without overwriting listing price", () => {
  const enriched = CORE.enrichDeal(deal, {
    star: 2.5,
    neighborhood: "West Phoenix - Avondale",
    amenities: REAL_DETAIL_AMENITIES,
    amenityCategories: [],
    brandNames: ["Red Roof"],
    guaranteedHotels: [{ hotelId: "4593905", name: "Red Roof PLUS+ Phoenix West" }],
    guaranteedTitle: "Guaranteed to be one of these 3 hotels",
  });
  assert.equal(enriched.detailAmenities.length, 56);
  assert.equal(enriched.prices.nightly, 57.37, "listing price must win");
  assert.equal(enriched.amenities.length, 6, "short list must be preserved");
  assert.equal(enriched.enriched, true);
  assert.deepEqual(enriched.brandNames, ["Red Roof"]);
});

check("the enriched record rules out a decoy the short list could not", () => {
  // Comfort Inn passes the short one-directional check, because the deal's
  // six advertised amenities are all present on it. The full record does not:
  // Comfort Inn has breakfast and a fitness centre, which the deal lacks.
  const enriched = CORE.enrichDeal(deal, {
    star: 2.5,
    neighborhood: "West Phoenix - Avondale",
    amenities: REAL_DETAIL_AMENITIES,
    amenityCategories: [],
    brandNames: [],
    guaranteedHotels: [],
  });
  const shortCheck = CORE.hardChecks(deal, pool[1]).find((c) => c.key === "Amenities");
  assert.equal(shortCheck.ok, true, "short check should not have caught it");

  const rich = CORE.hardChecks(enriched, pool[1]).find(
    (c) => c.key === "Full amenity record"
  );
  assert.ok(rich, "no full-record check was produced");
  assert.equal(rich.ok, false, "full record should have caught it");
  assert.ok(rich.missing.some((m) => /breakfast/i.test(m)));
});

check("the enriched record still accepts the true hotel", () => {
  const enriched = CORE.enrichDeal(deal, {
    star: 2.5,
    neighborhood: "West Phoenix - Avondale",
    amenities: REAL_DETAIL_AMENITIES,
    amenityCategories: [],
    brandNames: [],
    guaranteedHotels: [],
  });
  const m = CORE.matchDeal(enriched, pool);
  assert.equal(m.verdict, "identified", JSON.stringify(m.survivors.map((s) => s.hotel.name)));
  assert.equal(m.survivors[0].hotel.id, "4593905");
});

/* ------------------------------------------------------------------ *
 * Brand tiebreak
 * ------------------------------------------------------------------ */

function brandedDeal(brandFiles) {
  const d = JSON.parse(JSON.stringify(theDeal));
  d.hotelInfo.guaranteedBrands = {
    __typename: "GuaranteedHotelBrands",
    brands: brandFiles.map((f) => ({
      __typename: "HotelBrand",
      logo: { alt: null, source: "https://s1.pclncdn.com/hotel/brand-logos/" + f },
    })),
  };
  return CORE.parseDeals(buildHtml([d]))[0];
}

function twinWith(brand, id, name) {
  const h = rtlHotel({
    id,
    name,
    star: 2.5,
    hood: "West Phoenix - Avondale",
    amenities: DEAL_AMENITIES,
    reviewLabel: "1,288 Reviews",
    scores: { Staff: "7.1", Cleanliness: "7.9", Location: "6.1", Overall: "6.2" },
    nightly: "72.00",
    total: "79.00",
  });
  if (brand) h.hotelInfo.brand = { __typename: "HotelBrand", name: brand };
  return CORE.parseHotels(buildHtml([h]))[0];
}

check("reads guaranteed brands from logo filenames", () => {
  const d = brandedDeal(["red_roof.svg", "comfort_inn.svg"]);
  assert.deepEqual(d.brandKeys.sort(), ["comfort inn", "red roof"]);
});

check("reads a hotel brand into a comparable token", () => {
  assert.equal(twinWith("Red Roof", "111", "Twin A").brandKey, "red roof");
  assert.equal(twinWith(null, "112", "Twin B").brandKey, null);
});

check("brand settles a tie that scoring alone cannot", () => {
  const d = brandedDeal(["red_roof.svg"]);
  const twins = [twinWith("Red Roof", "111", "Red Roof Twin"), twinWith("Motel 6", "112", "Motel 6 Twin")];
  const m = CORE.matchDeal(d, [...pool, ...twins]);
  assert.equal(m.verdict, "identified", "verdict was " + m.verdict);
  assert.equal(m.tiebreak, "brand");
  assert.equal(m.survivors[0].hotel.name, "Red Roof Twin");
});

check("brand never removes a hotel from consideration", () => {
  // Red Roof is the true match but the deal's guaranteed brand set names only
  // another chain. A hard brand filter would wrongly discard it; a tiebreak
  // must leave the single-survivor answer untouched.
  const d = brandedDeal(["holiday_inn.svg"]);
  const m = CORE.matchDeal(d, pool);
  assert.equal(m.verdict, "identified");
  assert.equal(m.survivors[0].hotel.id, "4593905");
  assert.equal(m.tiebreak, null);
});

check("brand leaves a tie alone when it cannot separate it", () => {
  const d = brandedDeal(["red_roof.svg"]);
  const twins = [twinWith("Red Roof", "111", "Red Roof A"), twinWith("Red Roof", "112", "Red Roof B")];
  const m = CORE.matchDeal(d, [...pool, ...twins]);
  assert.equal(m.verdict, "ambiguous", "two on-brand survivors must stay ambiguous");
  assert.equal(m.tiebreak, null);
});

check("a deal with no guaranteed brands is unaffected", () => {
  const m = CORE.matchDeal(deal, [...pool, twinWith("Red Roof", "111", "Twin")]);
  assert.equal(m.verdict, "ambiguous");
  assert.equal(m.tiebreak, null);
});

/* ------------------------------------------------------------------ *
 * Savings
 * ------------------------------------------------------------------ */

check("computes the nightly saving and percentage", () => {
  const p = match.survivors[0].price;
  assert.equal(p.dealNightly, 57.37);
  assert.equal(p.hotelNightly, 68);
  assert.ok(Math.abs(p.saveNightly - 10.63) < 0.001, "saveNightly " + p.saveNightly);
  assert.ok(Math.abs(p.savePct - 15.632) < 0.01, "savePct " + p.savePct);
});

check("computes the all-in total saving", () => {
  const p = match.survivors[0].price;
  assert.equal(p.dealTotal, 63.97);
  assert.equal(p.hotelTotal, 74.5);
  assert.ok(Math.abs(p.saveTotal - 10.53) < 0.001, "saveTotal " + p.saveTotal);
});

check("handles a deal that is more expensive than booking direct", () => {
  const pricey = { ...deal, prices: { ...deal.prices, nightly: 90, total: 99 } };
  const p = CORE.priceDelta(pricey, pool[0]);
  assert.ok(p.saveNightly < 0, "expected a negative saving, got " + p.saveNightly);
});

check("omits savings rather than guessing when a price is missing", () => {
  const noPrice = { ...pool[0], prices: { nightly: null, total: null, currency: "$" } };
  const p = CORE.priceDelta(deal, noPrice);
  assert.equal(p.saveNightly, undefined);
  assert.equal(p.saveTotal, undefined);
});

/* ------------------------------------------------------------------ *
 * Rate parsing -- the line sequences below are exactly as captured from the
 * rendered pages, including the standalone "$" lines.
 * ------------------------------------------------------------------ */

check("reads the rate from a hotel page block", () => {
  // Red Roof PLUS+ Phoenix West, 09/22-09/23: $53 nightly, $70 struck, $58 total.
  const lines = ["Per night", "$", "53", "$", "70", "$", "58", "1 night, 1 room"];
  assert.deepEqual(CORE.parsePriceLines(lines), { nightly: 53, strike: 70, total: 58 });
});

check("reads the rate from an Express Deal block", () => {
  const lines = ["Per night", "$", "51", "$", "70", "$", "57", "1 night, 1 room"];
  assert.deepEqual(CORE.parsePriceLines(lines), { nightly: 51, strike: 70, total: 57 });
});

check("handles decimals and thousands separators", () => {
  const lines = ["Per night", "$", "1,234.50", "$", "1,500", "$", "1,299.99"];
  assert.deepEqual(CORE.parsePriceLines(lines), {
    nightly: 1234.5,
    strike: 1500,
    total: 1299.99,
  });
});

check("leaves missing figures null instead of guessing", () => {
  assert.deepEqual(CORE.parsePriceLines(["Per night", "$", "80", "1 night, 1 room"]), {
    nightly: 80,
    strike: null,
    total: null,
  });
  assert.deepEqual(CORE.parsePriceLines(["No prices here"]), {
    nightly: null,
    strike: null,
    total: null,
  });
});

check("does not read numbers from beyond the rate block", () => {
  const lines = ["Per night", "$", "58", "1 night, 1 room", "$", "999", "$", "888"];
  const p = CORE.parsePriceLines(lines);
  assert.equal(p.nightly, 58);
  assert.equal(p.strike, null, "leaked a number from after the block");
  assert.equal(p.total, null);
});

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

console.log("\nMatch for: " + deal.name);
console.log("  verdict:  " + match.verdict);
for (const s of match.survivors) {
  console.log(
    "  -> " + s.hotel.name + "  (" + s.comparable + " signals) " +
      "deal $" + s.price.dealNightly + " vs $" + s.price.hotelNightly +
      " direct, save $" + s.price.saveNightly.toFixed(2) +
      " (" + Math.round(s.price.savePct) + "%)"
  );
}
console.log("");

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
