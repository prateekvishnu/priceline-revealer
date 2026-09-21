/*
 * Priceline GraphQL client -- the tabless route.
 *
 * The deal page renders its detail through one operation, getSopqHotelDetails,
 * against POST /pws/v0/pcln-graph/. Calling that directly gets a deal's full
 * fingerprint with no tab, no page render and no waiting for hydration:
 *
 *   - starRating
 *   - the complete categorised amenity list (56 entries for the deal this was
 *     built against, versus the 6 a listing card shows)
 *   - neighborhood
 *   - guaranteedBrands, with real brand names rather than logo filenames
 *
 * Verified against the live endpoint: same-origin, cookies only, and no
 * Authorization or authToken header required despite the page sending them.
 *
 * The query TEXT is used rather than the persisted-query hash the page sends.
 * Hashes are registered per build and would break on every deploy, whereas the
 * text is embedded in any deal page's HTML -- and that HTML can be fetched even
 * for deals whose page will not hydrate, which is what makes this reliable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PCLNREV_GRAPH = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const ENDPOINT = "/pws/v0/pcln-graph/";
  const OP = "getSopqHotelDetails";
  const CACHE_KEY = "pclnrev.sopqQuery.v1";

  const HEADERS = {
    accept: "*/*",
    "content-type": "application/json",
    "apollographql-client-name": "pcln-web",
    "apollographql-client-version": "1.0.0",
  };

  /* ------------------------------------------------------------------ *
   * Query bootstrap
   * ------------------------------------------------------------------ */

  // Brace-matches the operation out of a page's inline scripts.
  function extractQuery(html, name) {
    const at = html.indexOf("query " + name);
    if (at === -1) return null;
    const open = html.indexOf("{", at);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < html.length; i++) {
      const c = html[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return html.slice(at, i + 1);
      }
    }
    return null;
  }

  function cached() {
    try {
      const v = sessionStorage.getItem(CACHE_KEY);
      return v && v.length > 500 ? v : null;
    } catch (_) {
      return null;
    }
  }

  function remember(text) {
    try {
      sessionStorage.setItem(CACHE_KEY, text);
    } catch (_) {
      /* private mode */
    }
  }

  let queryPromise = null;

  /*
   * `dealUrl` only has to be a deal page that responds; it does not have to
   * render. The operation text is identical on every deal page, so the first
   * deal on the listing is as good as any.
   */
  function loadQuery(dealUrl) {
    const hit = cached();
    if (hit) return Promise.resolve(hit);
    if (queryPromise) return queryPromise;

    queryPromise = fetch(dealUrl, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : null))
      .then((html) => {
        const text = html && extractQuery(html, OP);
        if (text) remember(text);
        return text;
      })
      .catch(() => null)
      .finally(() => {
        queryPromise = null;
      });
    return queryPromise;
  }

  /* ------------------------------------------------------------------ *
   * Request
   * ------------------------------------------------------------------ */

  // cguid is nullable, so a miss is harmless; it is only read to look like a
  // normal request rather than because the server demands it.
  function findCguid(haystack) {
    const m = String(haystack || "").match(/"cguid":"([A-Za-z0-9_-]{10,60})"/);
    return m ? m[1] : null;
  }

  function variables(o) {
    return {
      appc: "DESKTOP",
      appId: "relax",
      cguid: o.cguid || null,
      checkIn: o.checkIn,
      checkOut: o.checkOut,
      currency: o.currency || "USD",
      adultOcc: String(o.adults || 2),
      childAges: [],
      rooms: Number(o.rooms || 1),
      pclnId: o.pclnId,
      price: Number(o.price || 0),
      priceAvailable: o.price != null,
      couponAvailable: false,
      refId: "",
      clickId: "",
      isWhiteLabel: false,
      traitBadgesPageType: "DETAILS",
    };
  }

  const num = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  function shape(sopq) {
    const hi = (sopq && sopq.hotelInfo) || {};
    const categories = [];
    const flat = [];
    const seen = new Set();
    for (const a of hi.amenities || []) {
      if (!a || !a.name) continue;
      const cat = (a.category && a.category.text) || null;
      let bucket = categories.find((c) => c.label === cat);
      if (!bucket) {
        bucket = { id: (a.category && a.category.id) || null, label: cat, items: [] };
        categories.push(bucket);
      }
      bucket.items.push(a.name);
      if (!seen.has(a.name)) {
        seen.add(a.name);
        flat.push(a.name);
      }
    }

    const gb = hi.guaranteedBrands || null;
    const brandNames = gb && gb.brands ? gb.brands.map((b) => b.name).filter(Boolean) : [];
    const guaranteedHotels = [];
    if (gb && gb.brands) {
      for (const b of gb.brands) {
        const src = (b.logo && b.logo.source) || "";
        const m = src.match(/master_(\d+)/);
        if (m) guaranteedHotels.push({ hotelId: m[1], name: b.name || null });
      }
    }

    return {
      star: num(hi.starRating),
      neighborhood: (hi.neighborhood && hi.neighborhood.name) || null,
      amenityCategories: categories,
      amenities: flat,
      amenitySource: "graph",
      guaranteedTitle: (gb && gb.title) || null,
      brandNames,
      // Populated only for deals whose guarantee names specific properties:
      // those entries carry a master_<hotelId> image instead of a chain logo.
      guaranteedHotels,
    };
  }

  /*
   * Returns the enriched fingerprint for one deal, or null on any failure.
   * Null is always safe: the caller keeps whatever the listing already gave it.
   */
  async function dealDetails(opts) {
    const query = await loadQuery(opts.bootstrapUrl);
    if (!query) return null;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: HEADERS,
        body: JSON.stringify({
          operationName: OP,
          query,
          variables: variables(opts),
        }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      if (!body || !body.data || !body.data.sopqHotelDetails) return null;
      return shape(body.data.sopqHotelDetails);
    } catch (_) {
      return null;
    }
  }

  return { dealDetails, extractQuery, findCguid, shape, ENDPOINT, OP };
});
