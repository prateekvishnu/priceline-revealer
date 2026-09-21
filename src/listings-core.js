/*
 * Listings-page core: parsing and matching, with no DOM or chrome.* use so it
 * can be exercised from Node.
 *
 * The /relax-ui/listings pages are server-rendered React Server Components, so
 * every listing is already in the HTML as embedded JSON. That means:
 *
 *   - all Express Deals on the page can be fingerprinted with zero extra loads
 *   - the pool of real hotels for the same search can be pulled with a
 *     same-origin fetch of the same URL without product=sopq
 *
 * Both sides then expose the same short amenity vocabulary ("Swimming Pool",
 * "Hot Breakfast Included", ...) and the same review score labels, so a deal
 * can be matched against the pool directly. That is the whole trick: no tabs,
 * no detail pages, one extra request per page of hotels.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PCLNREV_CORE = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Embedded-JSON extraction
   * ------------------------------------------------------------------ */

  // Walks forward from an opening brace and returns the complete object text.
  function objectAt(s, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }

  /*
   * The payload appears more than once in the document: once as real JSON and
   * again inside escaped string copies. Rather than try to tell them apart,
   * every occurrence of the marker is attempted and the ones that fail to parse
   * (the escaped copies, where the brace search lands mid-string) are dropped.
   * Results are keyed by id so the surviving clean copy wins.
   *
   * This is why a page reporting 63 marker hits yields 21 hotels.
   */
  function parseByTypename(html, typename, idOf) {
    const marker = '"__typename":"' + typename + '"';
    const out = new Map();
    let from = 0;
    for (;;) {
      const at = html.indexOf(marker, from);
      if (at === -1) break;
      from = at + 1;
      const open = html.lastIndexOf("{", at);
      if (open === -1) continue;
      const raw = objectAt(html, open);
      if (!raw) continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch (_) {
        continue; // escaped duplicate
      }
      const id = idOf(obj);
      if (id && !out.has(id)) out.set(id, obj);
    }
    return [...out.values()];
  }

  /* ------------------------------------------------------------------ *
   * Normalisation
   * ------------------------------------------------------------------ */

  const num = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const normAmenity = (s) =>
    String(s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  /*
   * Neighbourhood names arrive in two spellings for the same place: listings
   * give "West Phoenix - Avondale", the deal detail record gives "West Phoenix
   * - Avondale Area". Without dropping that suffix every neighbourhood check
   * fails once a deal has been enriched, which would make enrichment actively
   * harmful rather than helpful.
   */
  const normHood = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+area$/, "");

  // "2.5-Star Hotel" -> 2.5 ; "3" -> 3
  function starOf(hotelInfo) {
    const direct = num(hotelInfo.starRating);
    if (direct != null) return direct;
    const m = String(hotelInfo.starLevelText || "").match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }

  // "1,200+ Reviews" -> { count: 1200, bucketed: true }
  // "1,251 Reviews"  -> { count: 1251, bucketed: false }
  function reviewCountOf(hotelInfo) {
    const total =
      ((hotelInfo.reviewInfo || {}).reviewSummary || {}).total || {};
    const label = String(total.label || total.count || "");
    const m = label.match(/([\d,]+)\s*(\+?)/);
    if (!m) return { count: null, bucketed: false };
    return { count: Number(m[1].replace(/,/g, "")), bucketed: m[2] === "+" };
  }

  // Scores come as { label: "Cleanliness", score: "7+" | "7.2" }.
  function scoresOf(hotelInfo) {
    const list =
      ((hotelInfo.reviewInfo || {}).reviewSummary || {}).scores || [];
    const out = { overall: null, bucketed: false, sub: {} };
    for (const s of list) {
      const raw = String(s.score == null ? "" : s.score);
      if (/\+/.test(raw)) out.bucketed = true;
      const value = num(raw);
      if (value == null) continue;
      const label = String(s.label || "");
      if (/^overall$/i.test(label)) out.overall = value;
      else out.sub[label] = value;
    }
    return out;
  }

  function pricesOf(listing) {
    const r = listing.minRateSummary || {};
    return {
      nightly: num((r.nightlyAllRoomsPriceExcludingTax || {}).amount),
      nightlyStrike: num((r.nightlyAllRoomsPriceExcludingTax || {}).strikePrice),
      minNightly: num((r.minPrice || {}).amount),
      total: num((r.grandTotal || {}).amount),
      totalStrike: num((r.grandTotal || {}).strikePrice),
      currency: (r.minPrice || {}).currencyPrefix || "$",
    };
  }

  /*
   * Both an Express Deal page and a named hotel page render the headline rate
   * identically, as separate lines:
   *
   *   Per night | $ | 53 | $ | 70 | $ | 58 | 1 night, 1 room
   *                   rate     strike  total
   *
   * Taking the three numbers after "Per night" therefore yields comparable
   * figures on either page, which is what a savings number needs. Given fewer
   * than three numbers the missing ones stay null rather than being guessed.
   */
  function parsePriceLines(lines) {
    const out = { nightly: null, strike: null, total: null };
    const at = lines.findIndex((l) => /^Per night$/i.test(String(l).trim()));
    if (at === -1) return out;
    const nums = [];
    for (let i = at + 1; i < lines.length && nums.length < 3; i++) {
      const line = String(lines[i]).trim();
      if (line === "$") continue;
      const m = line.match(/^\$?\s*([\d,]+(?:\.\d{1,2})?)$/);
      if (m) {
        nums.push(Number(m[1].replace(/,/g, "")));
        continue;
      }
      // "1 night, 1 room" closes the block; anything else unexpected does too.
      break;
    }
    if (nums.length > 0) out.nightly = nums[0];
    if (nums.length > 1) out.strike = nums[1];
    if (nums.length > 2) out.total = nums[2];
    return out;
  }

  /*
   * Brand identity, normalised to a comparable token.
   *
   * A deal that guarantees a brand set exposes those brands only as logos, so
   * both the alt text and the logo filename are harvested ("comfort_inn.svg"
   * -> "comfort inn"). The hotel side puts its brand in `brand`, whose exact
   * shape has not been pinned down, so several plausible ones are accepted and
   * anything unrecognised yields null -- which makes the comparison skip
   * rather than wrongly exclude a hotel.
   */
  const normBrand = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\.(svg|png|jpg|webp)$/, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  function brandKeysFromLogos(guaranteedBrands) {
    const keys = new Set();
    for (const b of (guaranteedBrands || {}).brands || []) {
      const logo = b.logo || {};
      if (logo.alt) keys.add(normBrand(logo.alt));
      const src = String(logo.source || "");
      const file = src.split("/").pop();
      if (file) keys.add(normBrand(file));
    }
    keys.delete("");
    return [...keys];
  }

  function hotelBrandKey(h) {
    const b = h.brand;
    if (!b) return null;
    const raw =
      typeof b === "string" ? b : b.name || b.label || b.displayName || b.code;
    const key = normBrand(raw);
    return key || null;
  }

  function commonFields(listing) {
    const h = listing.hotelInfo || {};
    return {
      id: h.id,
      // The rate's pclnId is what the GraphQL detail operation keys on.
      pclnId: (listing.minRateSummary || {}).pclnId || null,
      brandKey: hotelBrandKey(h),
      name: h.name || null,
      star: starOf(h),
      starText: h.starLevelText || null,
      neighborhood: (h.neighborhood || {}).name || null,
      locationId: (h.location || {}).id || null,
      amenities: (h.amenities || []).map((a) => a.name).filter(Boolean),
      badges: (h.traitBadges || []).map((b) => b.label).filter(Boolean),
      reviews: reviewCountOf(h),
      scores: scoresOf(h),
      prices: pricesOf(listing),
    };
  }

  function parseDeals(html) {
    return parseByTypename(
      html,
      "SopqHotelListing",
      (o) => (o.hotelInfo || {}).id
    ).map((listing) => {
      const base = commonFields(listing);
      const h = listing.hotelInfo || {};
      const brands = ((h.guaranteedBrands || {}).brands || [])
        .map((b) => (b.logo || {}).alt)
        .filter(Boolean);
      return {
        ...base,
        token: base.id,
        brands,
        brandKeys: brandKeysFromLogos(h.guaranteedBrands),
        kind: "deal",
      };
    });
  }

  function parseHotels(html) {
    return parseByTypename(
      html,
      "RtlHotelListing",
      (o) => (o.hotelInfo || {}).id
    ).map((listing) => ({ ...commonFields(listing), kind: "hotel" }));
  }

  /* ------------------------------------------------------------------ *
   * Matching
   * ------------------------------------------------------------------ */

  // A bucketed value "7+" covers 7.0-7.9; "1,200+" covers 1200-1299.
  function inBucket(dealValue, candValue, bucketed, size) {
    if (dealValue == null || candValue == null) return null;
    if (!bucketed) return Math.abs(dealValue - candValue) < (size >= 100 ? 1 : 0.05);
    const floorTo = (v) => Math.floor(v / size) * size;
    return floorTo(candValue) === floorTo(dealValue);
  }

  /*
   * Cross-vocabulary amenity matching.
   *
   * Priceline uses two different wordings. A listing card and a hotel's search
   * result use a short marketing vocabulary ("Swimming Pool", "Free Internet
   * Access"); the detail record uses a granular one ("Outdoor pool", "Free
   * Wi-Fi"). When a deal's full detail list is available -- which the GraphQL
   * route provides without opening anything -- the hotel's short list can be
   * checked against it, but only through a mapping.
   *
   * This is the strongest tabless signal available, because a deal's detail
   * list IS the real hotel's full amenity record. So every short-vocabulary
   * amenity the hotel advertises must be satisfied somewhere in the deal's
   * list, and one that is not rules the hotel out -- which is what catches a
   * hotel with free breakfast or a fitness centre that the deal never mentions.
   *
   * Terms absent from the map are skipped rather than guessed at.
   */
  const LIST_TO_DETAIL = {
    "swimming pool": ["outdoor pool", "indoor pool", "pool", "kids pool", "rooftop pool"],
    "free internet access": ["free wi fi", "free wifi", "free internet", "wi fi"],
    "hot breakfast included": ["free breakfast", "breakfast included", "hot breakfast"],
    "free breakfast": ["free breakfast", "breakfast included", "hot breakfast"],
    "free parking": ["free parking"],
    "pets allowed": ["pets allowed charges may apply", "pets allowed", "pet friendly"],
    // Keys are normalised the same way as the data: "/" becomes a space, so
    // "Accessible Rooms/Facilities" keys as "accessible rooms facilities".
    "accessible rooms facilities": [
      "wheelchair accessible",
      "facilities for disabled guests available",
      "accessible by stairs",
      "accessible vanities available",
    ],
    "no smoking rooms facilities": [
      "non smoking property",
      "non smoking rooms available",
    ],
    "fitness center": ["fitness center", "fitness centre", "gym", "fitness facility"],
    spa: ["spa services", "spa"],
    "hot tub whirlpool": ["hot tub whirlpool", "hot tub", "whirlpool", "jacuzzi"],
    restaurant: ["restaurant", "on site restaurant"],
    "airport shuttle": ["airport shuttle", "free airport shuttle", "airport transportation"],
    "business center": ["business center", "business facilities"],
    casino: ["casino"],
    "adults only": ["adults only"],
    waterfront: ["waterfront", "beachfront"],
    "all inclusive": ["all inclusive"],
    "laundry services": ["laundry services", "laundry facilities"],
    kitchen: ["kitchen", "kitchenette", "kitchenware"],
  };

  /*
   * Checks a hotel's short-vocabulary amenities against a deal's full detail
   * list. Returns which terms could be compared and which failed.
   */
  const wordsOf = (s) => normAmenity(s).split(" ").filter(Boolean);

  // Whole-word sequence containment, not substring: plain substring matching
  // makes "spa" match "Spanish" (a real entry, since deals list the languages
  // spoken) and would wave through a hotel with a spa that the deal lacks.
  function containsSequence(hay, needle) {
    if (!needle.length || needle.length > hay.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  function crossAmenityCheck(dealDetailAmenities, hotelListAmenities) {
    const have = (dealDetailAmenities || []).map(wordsOf);
    const satisfied = (needles) =>
      needles.some((n) => {
        const nw = wordsOf(n);
        return have.some((h) => containsSequence(h, nw));
      });

    const compared = [];
    const missing = [];
    for (const raw of hotelListAmenities || []) {
      const key = normAmenity(raw);
      const needles = LIST_TO_DETAIL[key];
      if (!needles) continue; // not mappable, so not judged
      compared.push(raw);
      if (!satisfied(needles)) missing.push(raw);
    }
    return { compared, missing };
  }

  /*
   * Hard constraints. Each one is something Priceline passes through from the
   * real hotel unchanged (or only rounded), so a mismatch is not a weak signal
   * -- it rules the hotel out. Anything that cannot be compared (a missing
   * field on either side) is skipped rather than counted against.
   */
  function hardChecks(deal, hotel) {
    const checks = [];

    if (deal.star != null && hotel.star != null) {
      checks.push({ key: "Star rating", ok: deal.star === hotel.star, deal: deal.star, cand: hotel.star });
    }

    if (deal.neighborhood && hotel.neighborhood) {
      checks.push({
        key: "Neighbourhood",
        ok: normHood(deal.neighborhood) === normHood(hotel.neighborhood),
        deal: deal.neighborhood,
        cand: hotel.neighborhood,
      });
    }

    const rc = inBucket(deal.reviews.count, hotel.reviews.count, deal.reviews.bucketed, 100);
    if (rc !== null) {
      checks.push({
        key: "Review count",
        ok: rc,
        deal: deal.reviews.count + (deal.reviews.bucketed ? "+" : ""),
        cand: hotel.reviews.count,
      });
    }

    const ov = inBucket(deal.scores.overall, hotel.scores.overall, deal.scores.bucketed, 1);
    if (ov !== null) {
      checks.push({
        key: "Overall score",
        ok: ov,
        deal: deal.scores.overall + (deal.scores.bucketed ? "+" : ""),
        cand: hotel.scores.overall,
      });
    }

    for (const label of Object.keys(deal.scores.sub)) {
      const m = inBucket(deal.scores.sub[label], hotel.scores.sub[label], deal.scores.bucketed, 1);
      if (m === null) continue;
      checks.push({
        key: label,
        ok: m,
        deal: deal.scores.sub[label] + (deal.scores.bucketed ? "+" : ""),
        cand: hotel.scores.sub[label],
      });
    }

    // The deal advertises a subset of the hotel's amenities, never more.
    const have = new Set(hotel.amenities.map(normAmenity));
    const missing = deal.amenities.filter((a) => !have.has(normAmenity(a)));
    if (deal.amenities.length) {
      checks.push({
        key: "Amenities",
        ok: missing.length === 0,
        deal: deal.amenities.length + " listed",
        cand: missing.length ? "missing " + missing.join(", ") : "all present",
        missing,
      });
    }

    /*
     * When the deal's full detail list has been fetched, the far stronger
     * reverse check applies: anything the hotel advertises that the deal's
     * record does not contain rules the hotel out.
     */
    if (deal.detailAmenities && deal.detailAmenities.length) {
      const cross = crossAmenityCheck(deal.detailAmenities, hotel.amenities);
      if (cross.compared.length) {
        checks.push({
          key: "Full amenity record",
          ok: cross.missing.length === 0,
          deal: deal.detailAmenities.length + " on the deal record",
          cand: cross.missing.length
            ? "hotel has " + cross.missing.join(", ")
            : cross.compared.length + " checked, all consistent",
          missing: cross.missing,
        });
      }
    }

    return checks;
  }

  function priceDelta(deal, hotel) {
    const d = deal.prices;
    const h = hotel.prices;
    const out = { currency: d.currency || "$" };
    if (d.nightly != null && h.nightly != null) {
      out.dealNightly = d.nightly;
      out.hotelNightly = h.nightly;
      out.saveNightly = h.nightly - d.nightly;
      out.savePct = h.nightly > 0 ? ((h.nightly - d.nightly) / h.nightly) * 100 : null;
    }
    if (d.total != null && h.total != null) {
      out.dealTotal = d.total;
      out.hotelTotal = h.total;
      out.saveTotal = h.total - d.total;
    }
    return out;
  }

  /*
   * Returns every pool hotel that survives all hard checks, best-first. A
   * single survivor is an identification; several means the search genuinely
   * cannot separate them on listing-level data and the caller should escalate
   * to the deal's detail page, where the guaranteed set and the full 50+
   * amenity list are available.
   */
  function matchDeal(deal, pool) {
    const scored = pool.map((hotel) => {
      const checks = hardChecks(deal, hotel);
      const failed = checks.filter((c) => !c.ok);
      const comparable = checks.length;
      return {
        hotel,
        checks,
        failed,
        comparable,
        survives: failed.length === 0 && comparable >= 3,
        price: priceDelta(deal, hotel),
      };
    });

    const survivors = scored
      .filter((s) => s.survives)
      .sort((a, b) => b.comparable - a.comparable);

    // Near-misses are useful to show when nothing survives: usually one hotel
    // fails a single check, which tells the user where the data disagreed.
    const nearMiss = scored
      .filter((s) => !s.survives && s.failed.length === 1 && s.comparable >= 4)
      .sort((a, b) => b.comparable - a.comparable)
      .slice(0, 3);

    let verdict;
    if (survivors.length === 1) verdict = "identified";
    else if (survivors.length > 1) verdict = "ambiguous";
    else if (nearMiss.length) verdict = "near-miss";
    else verdict = "no-match";

    /*
     * Brand tiebreak. When a deal guarantees a brand set, the real hotel must
     * carry one of those brands. This is applied only to separate survivors
     * that are otherwise tied, and only when exactly one of them matches -- it
     * can turn "ambiguous" into an answer but can never remove a hotel from
     * consideration. Deliberate: the hotel-side brand shape is not fully
     * verified, so it must not be able to exclude the correct hotel.
     */
    let tiebreak = null;
    // Logo filenames from the listing, plus real brand names when the deal has
    // been enriched over GraphQL -- the names are the more reliable of the two.
    const wantedBrands = [
      ...(deal.brandKeys || []),
      ...(deal.brandNames || []).map(normBrand),
    ].filter(Boolean);
    if (verdict === "ambiguous" && wantedBrands.length) {
      const wanted = new Set(wantedBrands);
      const onBrand = survivors.filter(
        (s) => s.hotel.brandKey && wanted.has(s.hotel.brandKey)
      );
      if (onBrand.length === 1) {
        survivors.sort((a, b) => (a === onBrand[0] ? -1 : b === onBrand[0] ? 1 : 0));
        verdict = "identified";
        tiebreak = "brand";
      }
    }

    return {
      deal,
      verdict,
      tiebreak,
      survivors,
      nearMiss,
      poolSize: pool.length,
    };
  }

  function matchAll(deals, pool) {
    return deals.map((d) => matchDeal(d, pool));
  }

  /*
   * Folds a GraphQL-enriched fingerprint onto the deal parsed from the page.
   * The listing figures stay authoritative for price (they are what the card
   * shows); enrichment only adds what the listing could not know.
   */
  function enrichDeal(deal, details) {
    if (!details) return deal;
    return {
      ...deal,
      star: details.star != null ? details.star : deal.star,
      // The listing spelling is preferred: it matches the hotel-side spelling
      // exactly, whereas the detail record appends " Area".
      neighborhood: deal.neighborhood || details.neighborhood,
      detailAmenities: details.amenities || [],
      detailCategories: details.amenityCategories || [],
      brandNames: details.brandNames && details.brandNames.length
        ? details.brandNames
        : deal.brandNames || [],
      guaranteedHotels: details.guaranteedHotels || [],
      guaranteedTitle: details.guaranteedTitle || null,
      enriched: true,
    };
  }

  return {
    objectAt,
    parsePriceLines,
    crossAmenityCheck,
    enrichDeal,
    parseByTypename,
    parseDeals,
    parseHotels,
    matchDeal,
    matchAll,
    priceDelta,
    hardChecks,
    inBucket,
    normAmenity,
    starOf,
    reviewCountOf,
    scoresOf,
  };
});
