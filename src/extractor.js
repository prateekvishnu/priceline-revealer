/*
 * Runs in the page's own JS context (world: MAIN) so it can read
 * window.__APOLLO_CLIENT__, which is where Priceline keeps the authoritative
 * amenity data. Builds a fingerprint of whatever hotel page it lands on and
 * hands it to bridge.js via window.postMessage.
 *
 * The same script serves both page types:
 *   /relax/at/express/<dealId>/<token>/...  -> the opaque Express Deal
 *   /relax/at/<hotelId>/...                 -> a named hotel, i.e. a candidate
 */
(() => {
  "use strict";

  const CHANNEL = "PCLN_REVEALER";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isExpress = () => /\/relax\/at\/express\//.test(location.pathname);

  async function waitFor(fn, tries = 60, interval = 600) {
    for (let i = 0; i < tries; i++) {
      let v = null;
      try {
        v = fn();
      } catch (_) {
        v = null;
      }
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Apollo cache
   * ------------------------------------------------------------------ */

  // Returns the extracted cache only once the amenity entities have landed,
  // so callers never see a half-hydrated page.
  function readyCache() {
    const client = window.__APOLLO_CLIENT__;
    if (!client || !client.cache) return null;
    let data;
    try {
      data = client.cache.extract();
    } catch (_) {
      return null;
    }
    const hasAmenities = Object.keys(data).some((k) =>
      k.startsWith("RtlAmenityCategory:")
    );
    return hasAmenities ? data : null;
  }

  // Category ids are stable across hotels. These were read from Priceline's own
  // SopqAmenityCategory records in the listings payload, so they are the real
  // labels rather than guesses; anything not listed falls back to its id.
  const CATEGORY_NAMES = {
    201: "Accessibility",
    203: "Fitness Activities",
    204: "Food & Drinks",
    205: "General",
    207: "Kid Friendly",
    208: "Languages spoken",
    209: "Media & Technology",
    211: "Room Amenities",
    212: "Security",
    213: "Services and Conveniences",
    214: "Swimming & Soaking",
    215: "Transportation",
    218: "Business facilities",
  };

  const categoryLabel = (id) => CATEGORY_NAMES[id] || "Category " + id;

  function amenitiesFromCache(data) {
    const categories = [];
    for (const key of Object.keys(data)) {
      if (!key.startsWith("RtlAmenityCategory:")) continue;
      const id = Number(key.split(":")[1]);
      const items = (data[key].amenities || [])
        .map((a) => a && a.name)
        .filter(Boolean);
      if (items.length) categories.push({ id, label: categoryLabel(id), items });
    }
    categories.sort((a, b) => a.id - b.id);
    return categories;
  }

  /* ------------------------------------------------------------------ *
   * DOM fallback
   * ------------------------------------------------------------------ */

  // Headings Priceline uses inside the amenity panel. Used both to locate the
  // panel and to strip the headings back out of the flattened text.
  const AMENITY_HEADINGS = [
    "Room Amenities",
    "Security",
    "Services and Conveniences",
    "Sanitation Procedures",
    "Languages spoken",
    "General",
    "INTERNET",
    "Food & Drinks",
    "PARKING",
    "Swimming & Soaking",
    "Accessibility",
    "Activities",
    "Business",
    "Wellness",
    "Things to do",
  ];

  const STOP_HEADINGS =
    /^(Show All Amenities|About the hotel|About this hotel|Hotel location|Hotel Location|Guest policies)$/;

  function textLines() {
    return (document.body.innerText || "")
      .split("\n")
      .map((l) => l.replace(/ /g, " ").trim())
      .filter(Boolean);
  }

  // Anchors on an exact "Amenities" line immediately followed by a known
  // category heading. That distinguishes the real panel from the nav tab and
  // from the "Top Amenities" summary block, both of which also say Amenities.
  function amenitiesFromDom() {
    const lines = textLines();
    let start = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === "Amenities" && AMENITY_HEADINGS.includes(lines[i + 1])) {
        start = i + 1;
        break;
      }
    }
    if (start === -1) return [];

    const categories = [];
    let current = null;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (STOP_HEADINGS.test(line)) break;
      if (AMENITY_HEADINGS.includes(line)) {
        current = { id: null, label: line, items: [] };
        categories.push(current);
      } else if (current) {
        current.items.push(line);
      }
    }
    return categories.filter((c) => c.items.length);
  }

  /* ------------------------------------------------------------------ *
   * Review stats
   * ------------------------------------------------------------------ */

  const VERDICT_WORDS =
    "Exceptional|Wonderful|Excellent|Very Good|Good|Pleasant|Fair|Poor";

  // Express pages bucket their numbers ("1,200+ Verified Reviews", "6+");
  // hotel pages give exact values ("1,251 Reviews", "6.6"). Both forms are
  // parsed here, and `bucketed` records which was seen so the scorer can
  // compare like with like rather than penalising the rounding.
  function reviewStats() {
    const text = (document.body.innerText || "").replace(/ /g, " ");
    const stats = {
      count: null,
      countBucketed: false,
      overall: null,
      overallLabel: null,
      bucketed: false,
      sub: {},
    };

    const countMatch = text.match(/([\d,]+)(\+?)\s+(?:Verified\s+)?Reviews/i);
    if (countMatch) {
      stats.count = Number(countMatch[1].replace(/,/g, ""));
      stats.countBucketed = countMatch[2] === "+";
    }

    // Scores render as a number on one line and its label on the next.
    const scope = countMatch
      ? text.slice(countMatch.index, countMatch.index + 600)
      : text;
    const pair = new RegExp(
      "(\\d+(?:\\.\\d+)?)(\\+?)\\s*\\n\\s*(" +
        VERDICT_WORDS +
        "|Cleanliness|Staff|Location|Amenities|Value|Comfort|Facilities)\\b",
      "gi"
    );
    const verdictOnly = new RegExp("^(" + VERDICT_WORDS + ")$", "i");

    let m;
    while ((m = pair.exec(scope)) !== null) {
      const value = Number(m[1]);
      if (m[2] === "+") stats.bucketed = true;
      const label = m[3];
      if (verdictOnly.test(label)) {
        if (stats.overall === null) {
          stats.overall = value;
          stats.overallLabel = label;
        }
      } else {
        const key = label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
        if (stats.sub[key] === undefined) stats.sub[key] = value;
      }
    }
    return stats;
  }

  /* ------------------------------------------------------------------ *
   * Other signals
   * ------------------------------------------------------------------ */

  function starRating(data) {
    if (data) {
      for (const key of Object.keys(data)) {
        if (key.startsWith("RtlHotel:") && data[key].starRating) {
          return String(data[key].starRating);
        }
      }
    }
    const m = (document.body.innerText || "").match(/(\d(?:\.\d)?)[- ]Star/i);
    return m ? m[1] : null;
  }

  const KNOWN_BADGES = [
    "Top Booked",
    "Family Friendly",
    "Top Rated",
    "Guest Favorite",
    "Best Value",
    "Top Pick",
    "Great Deal",
    "Romantic",
    "Business Friendly",
  ];

  function badges() {
    const text = document.body.innerText || "";
    return KNOWN_BADGES.filter((b) =>
      new RegExp("(^|\\n)\\s*" + b + "\\s*(\\n|$)").test(text)
    );
  }

  // Express pages name a neighbourhood ("West Phoenix - Avondale Area");
  // hotel pages carry it at the end of the address line. Soft signal only.
  function area() {
    const lines = textLines();
    const withArea = lines.find((l) => /\sArea$/.test(l) && l.length < 80);
    if (withArea) return withArea.replace(/\s*Area$/, "").trim();
    const addr = lines.find((l) => /,\s*[A-Z]{2}\s+-\s+/.test(l));
    if (addr) {
      const parts = addr.split(" - ");
      return parts.length > 1 ? parts.slice(1).join(" - ").trim() : null;
    }
    return null;
  }

  function address(data) {
    if (data) {
      for (const key of Object.keys(data)) {
        if (!key.startsWith("HotelLocation:")) continue;
        const loc = data[key];
        const bits = [loc.address1, loc.cityName, loc.provinceCode]
          .filter(Boolean)
          .join(", ");
        if (bits) return bits;
      }
    }
    const line = textLines().find(
      (l) => /,\s*[A-Z]{2}\b/.test(l) && l.length < 120
    );
    return line || null;
  }

  // Shared with the listings matcher (listings-core.js is loaded into this
  // same MAIN world ahead of this file) so the rate on a deal page and the
  // rate on a hotel page are read by one tested implementation.
  function prices() {
    const core = self.PCLNREV_CORE;
    if (!core || !core.parsePriceLines) {
      return { nightly: null, strike: null, total: null };
    }
    return core.parsePriceLines(textLines());
  }

  function hotelName(data) {
    if (data) {
      for (const key of Object.keys(data)) {
        if (key.startsWith("RtlHotel:") && data[key].name) return data[key].name;
      }
    }
    return (document.title || "").replace(/\s*-\s*Priceline\.com\s*$/i, "").trim();
  }

  /* ------------------------------------------------------------------ *
   * Express Deal candidates
   * ------------------------------------------------------------------ */

  // The "Guaranteed to be one of these N hotels" strip. Each thumbnail URL
  // embeds the hotel's own Priceline id (.../master_4593905?...), which is
  // what makes a direct lookup of every candidate possible.
  function candidates() {
    const root = document.querySelector(
      '[data-testid="express-deal-info-guaranteed-brands"]'
    );
    if (!root) return null;
    const imgs = Array.from(root.querySelectorAll("img"));
    if (!imgs.length) return null; // still rendering loading skeletons

    const seen = new Set();
    const out = [];
    for (const img of imgs) {
      const src = img.getAttribute("src") || "";
      const m = src.match(/master_(\d+)/) || src.match(/\/(\d{3,})\/master/);
      const id = m ? m[1] : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ hotelId: id, name: (img.alt || "").trim() });
    }
    return out.length ? out : null;
  }

  /* ------------------------------------------------------------------ *
   * Assembly
   * ------------------------------------------------------------------ */

  function pathId() {
    const m = location.pathname.match(/\/relax\/at\/(?:express\/)?(\d+)/);
    return m ? m[1] : null;
  }

  async function buildFingerprint() {
    const data = await waitFor(readyCache, 50, 600);

    let categories = data ? amenitiesFromCache(data) : [];
    let amenitySource = "cache";
    if (!categories.length) {
      categories = amenitiesFromDom();
      amenitySource = "dom";
    }

    const flat = [];
    const seen = new Set();
    for (const cat of categories) {
      for (const item of cat.items) {
        if (seen.has(item)) continue;
        seen.add(item);
        flat.push(item);
      }
    }

    const kind = isExpress() ? "deal" : "hotel";
    return {
      kind,
      url: location.href,
      id: pathId(),
      name: kind === "deal" ? null : hotelName(data),
      stars: starRating(data),
      reviews: reviewStats(),
      badges: badges(),
      area: area(),
      address: kind === "deal" ? null : address(data),
      prices: prices(),
      amenitySource,
      amenityCategories: categories,
      amenities: flat,
      candidates: kind === "deal" ? await waitFor(candidates, 40, 600) : null,
      capturedAt: Date.now(),
    };
  }

  function post(message) {
    window.postMessage(
      Object.assign({ channel: CHANNEL, dir: "up" }, message),
      location.origin
    );
  }

  let inFlight = null;

  function run() {
    if (inFlight) return inFlight;
    inFlight = buildFingerprint()
      .then((fingerprint) => {
        post({ type: "FINGERPRINT", fingerprint });
        return fingerprint;
      })
      .catch((err) => {
        post({ type: "EXTRACT_ERROR", error: String((err && err.message) || err) });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  // bridge.js asks for a re-read after an in-page navigation or a manual retry.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.channel !== CHANNEL || d.dir !== "down") return;
    if (d.type === "RESCAN") run();
  });

  // Priceline is a single-page app, so the URL can change without a reload.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    post({ type: "NAVIGATED", url: location.href });
    run();
  }, 1000);

  run();
})();
