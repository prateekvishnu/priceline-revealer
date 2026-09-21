/*
 * Listings page feature: write the hotel name and the saving onto every
 * Express Deal card.
 *
 * Two paths, cheapest first.
 *
 * 1. Pool match (free). Every deal on the page is already in the HTML, and the
 *    real hotels for the same search are one same-origin fetch away. When that
 *    uniquely identifies a deal, the card is filled in immediately.
 *
 * 2. Exact resolve (on demand). Priceline's listings route returns 30 hotels
 *    and ignores every paging parameter, so the pool often will not contain
 *    the real hotel at all -- especially for deals in neighbourhoods away from
 *    the searched city. For those, the deal's own page is the authority: it
 *    names the exact guaranteed set anywhere in the world. That needs a real
 *    page render, so it runs lazily as cards scroll into view, one at a time,
 *    with results cached per hotel and per deal.
 */
(() => {
  "use strict";

  const CORE = self.PCLNREV_CORE;
  if (!CORE) return;

  const CARD_ATTR = "data-pclnrev-card";
  const NAME_RE = /-Star Hotel in the .+ Area$/;
  const AUTO_KEY = "pclnrev.auto";

  let deals = [];
  let pool = [];
  let status = { phase: "idle", message: "" };
  let auto = localStorage.getItem(AUTO_KEY) !== "0";

  // token -> { deal, pool: matchResult, exact, phase, error }
  const state = new Map();

  /* ------------------------------------------------------------------ *
   * Data
   * ------------------------------------------------------------------ */

  const pageScripts = () =>
    Array.from(document.querySelectorAll("script:not([src])"))
      .map((s) => s.textContent || "")
      .join("\n");

  function readDeals() {
    const found = CORE.parseDeals(pageScripts());
    let added = 0;
    for (const d of found) {
      if (!d.token || state.has(d.token)) continue;
      state.set(d.token, { deal: d, phase: "pending" });
      added++;
    }
    deals = [...state.values()].map((s) => s.deal);
    return added;
  }

  /*
   * Pool harvesting, entirely without tabs.
   *
   * One search returns 30 hotels and no paging parameter is honoured, so the
   * only way to see more is to ask different questions. Two levers were found
   * to actually change the returned set:
   *
   *   - destination: each deal carries its own location id, and searching that
   *     location returns hotels concentrated there
   *   - sort: a different ordering surfaces a different slice of the same city
   *
   * Neither is a substitute for real pagination -- measured union growth was
   * 21 -> 30 for one destination across variants, and 46 across destinations --
   * so this widens coverage without guaranteeing it. Requests are sequential
   * and capped to stay well inside what ordinary browsing looks like.
   */
  const POOL_REQUEST_CAP = 10;
  const SORTS = ["PRICE_LOW_TO_HIGH", "GUEST_RATING"];

  function poolUrls(locationIds) {
    const seen = new Set();
    const urls = [];
    const push = (u) => {
      const s = u.toString();
      if (seen.has(s)) return;
      seen.add(s);
      urls.push(s);
    };

    const base = () => {
      const u = new URL(location.href);
      u.searchParams.delete("product");
      u.searchParams.delete("sort");
      return u;
    };

    push(base());
    for (const sort of SORTS) {
      const u = base();
      u.searchParams.set("sort", sort);
      push(u);
    }
    for (const loc of locationIds) {
      const u = base();
      u.searchParams.set("destination", loc);
      push(u);
      if (urls.length >= POOL_REQUEST_CAP) break;
    }
    return urls.slice(0, POOL_REQUEST_CAP);
  }

  async function fetchPool() {
    const locationIds = [
      ...new Set(deals.map((d) => d.locationId).filter(Boolean)),
    ];
    const urls = poolUrls(locationIds);
    const found = new Map();

    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await fetch(urls[i], { credentials: "include" });
        if (res.ok) {
          for (const h of CORE.parseHotels(await res.text())) {
            if (!found.has(h.id)) found.set(h.id, h);
          }
        }
      } catch (_) {
        /* skip this variant */
      }
      setStatus(
        "running",
        "Building the hotel pool: " + found.size + " found (" + (i + 1) + "/" + urls.length + ")"
      );
    }
    return [...found.values()];
  }

  function applyPool() {
    for (const s of state.values()) {
      if (s.phase !== "pending") continue;
      const m = CORE.matchDeal(s.deal, pool);
      s.pool = m;
      if (m.verdict === "identified") s.phase = "pool-hit";
      else s.phase = "unresolved";
    }
  }

  /*
   * Enriches every deal over GraphQL: one request each, no tabs, no rendering.
   * This is what turns a card's six advertised amenities into the deal's full
   * ~56-entry record, which is by far the strongest signal available.
   *
   * Runs with a small amount of concurrency because each request is
   * independent and cheap. A failure leaves that deal on its listing data.
   */
  const ENRICH_CONCURRENCY = 3;

  async function enrichAll() {
    const GRAPH = self.PCLNREV_GRAPH;
    if (!GRAPH) return;

    const p = new URLSearchParams(location.search);
    const checkIn = p.get("checkIn");
    const checkOut = p.get("checkOut");
    if (!checkIn || !checkOut) return;

    const cguid = GRAPH.findCguid(pageScripts());
    const entries = [...state.values()].filter((s) => !s.deal.enriched);
    if (!entries.length) return;

    // Any deal page will do as the source of the operation text.
    const bootstrapUrl = detailUrl(entries[0].deal);
    if (!bootstrapUrl) return;

    let done = 0;
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= entries.length) return;
        const s = entries[i];
        const details = await GRAPH.dealDetails({
          bootstrapUrl,
          pclnId: s.deal.pclnId || s.deal.token,
          price: (s.deal.prices || {}).minNightly,
          checkIn,
          checkOut,
          rooms: p.get("rooms") || "1",
          adults: p.get("adults") || "2",
          cguid,
        });
        if (details) s.deal = CORE.enrichDeal(s.deal, details);
        done++;
        if (done % 5 === 0 || done === entries.length) {
          setStatus(
            "running",
            "Reading deal records: " + done + "/" + entries.length
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ENRICH_CONCURRENCY, entries.length) }, worker)
    );
  }

  async function run() {
    setStatus("running", "Reading deals on this page");
    readDeals();
    if (!deals.length) {
      setStatus("error", "No Express Deals found in this page.");
      return;
    }

    setStatus("running", "Fetching the hotels for this search");
    pool = await fetchPool();

    await enrichAll();
    deals = [...state.values()].map((s) => s.deal);

    applyPool();
    setStatus("done", "");
    decorate();
    pump();
  }

  /* ------------------------------------------------------------------ *
   * Exact resolve queue
   * ------------------------------------------------------------------ */

  const queue = [];
  let working = false;
  let port = null;
  let requestSeq = 0;
  const pendingRequests = new Map();

  function connect() {
    if (port) return port;
    port = chrome.runtime.connect({ name: "resolve" });
    port.onMessage.addListener((msg) => {
      const entry = pendingRequests.get(msg.requestId);
      if (!entry) return;
      if (msg.type === "DEAL_PROGRESS") {
        entry.state.message = msg.message;
        decorate();
        return;
      }
      pendingRequests.delete(msg.requestId);
      if (msg.type === "DEAL_RESULT") {
        entry.state.exact = msg.result;
        entry.state.phase = "exact";
      } else {
        entry.state.phase = "failed";
        entry.state.error = msg.error || "Could not resolve this deal.";
      }
      entry.done();
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const [, entry] of pendingRequests) {
        entry.state.phase = "failed";
        entry.state.error = "The extension worker stopped.";
        entry.done();
      }
      pendingRequests.clear();
    });
    return port;
  }

  function enqueue(token) {
    const s = state.get(token);
    if (!s) return;
    if (s.phase !== "unresolved" && s.phase !== "failed") return;
    if (queue.includes(token)) return;
    s.phase = "queued";
    queue.push(token);
    decorate();
    pump();
  }

  // Re-queues every deal whose resolve failed. Failures are usually transient
  // (a slow page hitting the timeout), so retrying the whole batch is the
  // useful gesture rather than clicking each card.
  function retryFailed() {
    const tokens = [...state.values()]
      .filter((s) => s.phase === "failed")
      .map((s) => s.deal.token);
    for (const t of tokens) {
      const s = state.get(t);
      if (s) s.error = null;
      enqueue(t);
    }
    return tokens.length;
  }

  function pump() {
    if (working || !queue.length) return;
    const token = queue.shift();
    const s = state.get(token);
    if (!s) return pump();

    const url = dealUrl(s);
    if (!url) {
      s.phase = "failed";
      s.error = "Could not build this deal's page URL.";
      decorate();
      return pump();
    }

    working = true;
    s.phase = "resolving";
    s.message = "Starting";
    decorate();

    const requestId = ++requestSeq;
    pendingRequests.set(requestId, {
      state: s,
      done: () => {
        working = false;
        decorate();
        pump();
      },
    });

    try {
      connect().postMessage({ type: "RESOLVE_DEAL", url, requestId });
    } catch (_) {
      pendingRequests.delete(requestId);
      s.phase = "failed";
      s.error = "Could not reach the extension worker.";
      working = false;
      decorate();
      pump();
    }
  }

  /* ------------------------------------------------------------------ *
   * Card discovery
   * ------------------------------------------------------------------ */

  const dealNames = () => new Set(deals.map((d) => d.name).filter(Boolean));

  function climbToCard(el, names) {
    const own = (el.textContent || "").trim();
    let best = el;
    let node = el.parentElement;
    for (let i = 0; i < 12 && node && node !== document.body; i++) {
      const text = node.textContent || "";
      let others = 0;
      for (const n of names) if (n !== own && text.includes(n)) others++;
      if (others > 0) break;
      if (text.length > 2000) break;
      best = node;
      node = node.parentElement;
    }
    return best === el ? null : best;
  }

  function locateCards() {
    const names = dealNames();
    const byName = new Map();
    const nodes = document.querySelectorAll("h1,h2,h3,h4,p,span,div");
    for (const el of nodes) {
      if (el.children.length !== 0) continue;
      const t = (el.textContent || "").trim();
      if (!names.has(t) || !NAME_RE.test(t)) continue;
      const card = climbToCard(el, names);
      if (!card) continue;
      if (!byName.has(t)) byName.set(t, []);
      byName.get(t).push({ heading: el, card });
    }
    return byName;
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  const money = (n, cur) => (cur || "$") + Number(n).toFixed(2).replace(/\.00$/, "");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /*
   * Prefer a real URL taken from the card itself.
   *
   * A URL built from the listing data (location id + deal token) is accepted by
   * the server -- it returns 200 -- but was observed to render only the header
   * and footer with no PCLN_BOOTSTRAP_DATA, so the deal never appears. The deal
   * links Priceline produces itself carry extra parameters (a backlink id, for
   * one) and do render. So if the card exposes a real link, use it, and treat
   * the constructed URL as a fallback only.
   */
  function dealUrlFromCard(card) {
    if (!card) return null;
    const a = card.querySelector('a[href*="/relax/at/express/"]');
    return a && a.href ? a.href : null;
  }

  function dealUrl(s) {
    return dealUrlFromCard(s.card) || detailUrl(s.deal);
  }

  function detailUrl(deal) {
    const p = new URLSearchParams(location.search);
    const checkIn = p.get("checkIn");
    const checkOut = p.get("checkOut");
    const rooms = p.get("rooms") || "1";
    if (!deal.locationId || !deal.token || !checkIn || !checkOut) return null;
    return (
      "https://www.priceline.com/relax/at/express/" +
      deal.locationId +
      "/" +
      deal.token +
      "/from/" +
      checkIn +
      "/to/" +
      checkOut +
      "/rooms/" +
      rooms
    );
  }

  // Savings from the deal's listing price against the hotel's own rate.
  function savingsBlock(dealPrices, hotelPrices, currency) {
    if (!dealPrices || !hotelPrices) return null;
    const dn = dealPrices.nightly;
    const hn = hotelPrices.nightly;
    if (dn == null || hn == null) return null;

    const diff = hn - dn;
    const pct = hn > 0 ? (diff / hn) * 100 : null;
    const wrap = el("div", "pclnrev-badge-save");
    wrap.appendChild(
      el(
        "span",
        diff >= 0 ? "pclnrev-save-good" : "pclnrev-save-bad",
        (diff >= 0 ? "Save " : "Costs ") +
          money(Math.abs(diff), currency) +
          "/night" +
          (pct != null ? " (" + Math.round(Math.abs(pct)) + "%)" : "")
      )
    );
    wrap.appendChild(
      el(
        "span",
        "pclnrev-save-detail",
        "  deal " + money(dn, currency) + " vs " + money(hn, currency) + " direct"
      )
    );

    const box = el("div");
    box.appendChild(wrap);
    if (dealPrices.total != null && hotelPrices.total != null) {
      const td = hotelPrices.total - dealPrices.total;
      box.appendChild(
        el(
          "div",
          "pclnrev-badge-total",
          "All in: " + money(dealPrices.total, currency) +
            " vs " + money(hotelPrices.total, currency) +
            " — " + (td >= 0 ? "save " : "extra ") + money(Math.abs(td), currency)
        )
      );
    }
    return box;
  }

  const EXACT_COPY = {
    certain: "Identified",
    likely: "Very likely",
    leaning: "Best guess",
    inconclusive: "Inconclusive",
    unknown: "Could not tell",
  };

  function revealButton(token, label) {
    const b = el("button", "pclnrev-badge-btn", label);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      enqueue(token);
    });
    return b;
  }

  function badgeFor(s) {
    const wrap = el("div", "pclnrev-badge");
    wrap.setAttribute(CARD_ATTR, "1");
    const cur = (s.deal.prices || {}).currency || "$";

    if (s.phase === "pool-hit") {
      const hit = s.pool.survivors[0];
      wrap.classList.add("pclnrev-badge-hit");
      wrap.appendChild(el("div", "pclnrev-badge-kicker", "Almost certainly"));
      wrap.appendChild(el("div", "pclnrev-badge-name", hit.hotel.name));
      const sav = savingsBlock(s.deal.prices, hit.hotel.prices, cur);
      if (sav) wrap.appendChild(sav);
      wrap.appendChild(
        el(
          "div",
          "pclnrev-badge-why",
          "Matched on " + hit.comparable + " signals" +
            (s.pool.tiebreak === "brand"
              ? ", with the guaranteed brand settling it"
              : "")
        )
      );
      return wrap;
    }

    if (s.phase === "exact") {
      const r = s.exact;
      const top = r.ranked && r.ranked[0];
      const good = r.verdict === "certain" || r.verdict === "likely";
      wrap.classList.add(good ? "pclnrev-badge-hit" : "pclnrev-badge-warn");
      wrap.appendChild(el("div", "pclnrev-badge-kicker", EXACT_COPY[r.verdict] || r.verdict));
      if (top && !top.unreadable) {
        wrap.appendChild(el("div", "pclnrev-badge-name", top.name || top.hotelId));
        const hp = top.fingerprint && top.fingerprint.prices;
        const sav = savingsBlock(s.deal.prices, hp, cur);
        if (sav) wrap.appendChild(sav);
        wrap.appendChild(
          el(
            "div",
            "pclnrev-badge-why",
            Math.round(top.score * 100) + "% match, " +
              Math.round(r.margin * 100) + " pts clear of the next of " +
              r.ranked.length + " guaranteed hotels"
          )
        );
      } else {
        wrap.appendChild(el("div", "pclnrev-badge-name", "No candidate could be read"));
      }
      return wrap;
    }

    if (s.phase === "resolving" || s.phase === "queued") {
      wrap.classList.add("pclnrev-badge-busy");
      wrap.appendChild(
        el("div", "pclnrev-badge-kicker", s.phase === "queued" ? "Queued" : "Checking the deal page")
      );
      if (s.message) wrap.appendChild(el("div", "pclnrev-badge-why", s.message + "…"));
      return wrap;
    }

    if (s.phase === "failed") {
      wrap.classList.add("pclnrev-badge-warn");
      wrap.appendChild(el("div", "pclnrev-badge-kicker", "Could not resolve"));
      wrap.appendChild(el("div", "pclnrev-badge-why", s.error || ""));
      wrap.appendChild(revealButton(s.deal.token, "Try again"));
      return wrap;
    }

    // Unresolved: say what the cheap pass found, and offer the exact check.
    const m = s.pool;
    wrap.classList.add("pclnrev-badge-warn");
    if (m && m.verdict === "ambiguous") {
      wrap.appendChild(
        el("div", "pclnrev-badge-kicker", m.survivors.length + " hotels in this search fit")
      );
      wrap.appendChild(
        el("div", "pclnrev-badge-name", m.survivors.slice(0, 3).map((x) => x.hotel.name).join("  ·  "))
      );
    } else if (m && m.verdict === "near-miss") {
      const nm = m.nearMiss[0];
      wrap.appendChild(el("div", "pclnrev-badge-kicker", "Closest in this search"));
      wrap.appendChild(el("div", "pclnrev-badge-name", nm.hotel.name));
      wrap.appendChild(
        el(
          "div",
          "pclnrev-badge-why",
          nm.failed[0].key + " disagrees: deal " + nm.failed[0].deal + ", hotel " + nm.failed[0].cand
        )
      );
    } else {
      wrap.appendChild(el("div", "pclnrev-badge-kicker", "Not in the hotels we could list"));
      wrap.appendChild(
        el(
          "div",
          "pclnrev-badge-why",
          "Priceline returns 30 hotels per search and blocks paging, so the real " +
            "one is outside the " + pool.length + " we could gather."
        )
      );
    }
    wrap.appendChild(revealButton(s.deal.token, "Check the deal page"));
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * Decoration + lazy trigger
   * ------------------------------------------------------------------ */

  const visibility = new IntersectionObserver(
    (entries) => {
      if (!auto) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const token = e.target.getAttribute("data-pclnrev-token");
        if (token) enqueue(token);
      }
    },
    { rootMargin: "200px" }
  );

  function decorate() {
    const cards = locateCards();
    const byName = new Map();
    for (const s of state.values()) {
      if (!s.deal.name) continue;
      if (!byName.has(s.deal.name)) byName.set(s.deal.name, []);
      byName.get(s.deal.name).push(s);
    }

    let placed = 0;
    for (const [name, slots] of cards) {
      const group = byName.get(name) || [];
      for (let i = 0; i < slots.length; i++) {
        const { heading, card } = slots[i];
        const s = group.length === 1 ? group[0] : group[i];
        if (!s) continue;

        s.card = card;
        card.setAttribute("data-pclnrev-token", s.deal.token);
        visibility.observe(card);

        const existing = card.querySelector("[" + CARD_ATTR + "]");
        const signature = s.phase + "|" + (s.message || "");
        if (existing && existing.getAttribute("data-pclnrev-sig") === signature) {
          placed++;
          continue; // unchanged, leave the DOM alone
        }
        if (existing) existing.remove();
        const badge = badgeFor(s);
        badge.setAttribute("data-pclnrev-sig", signature);
        heading.insertAdjacentElement("afterend", badge);
        placed++;
      }
    }
    renderSummary(placed);
  }

  /* ------------------------------------------------------------------ *
   * Summary panel
   * ------------------------------------------------------------------ */

  function setStatus(phase, message) {
    status = { phase, message };
    renderSummary();
  }

  function renderSummary(placed) {
    let box = document.getElementById("pclnrev-summary");
    if (!box) {
      box = el("div", "pclnrev pclnrev-summary");
      box.id = "pclnrev-summary";
      document.body.appendChild(box);
    }
    box.textContent = "";

    const head = el("div", "pclnrev-head");
    head.appendChild(el("span", "pclnrev-title", "Express Deal Revealer"));
    const btns = el("div", "pclnrev-headbtns");
    const failedTokens = [...state.values()]
      .filter((s) => s.phase === "failed")
      .map((s) => s.deal.token);

    const again = el("button", "pclnrev-icon", "↻");
    again.title = failedTokens.length
      ? "Retry the " + failedTokens.length + " that failed"
      : "Re-read this page";
    again.addEventListener("click", () => {
      if (status.phase === "running") return;
      if (failedTokens.length) {
        retryFailed();
        return;
      }
      state.clear();
      run();
    });
    const close = el("button", "pclnrev-icon", "×");
    close.title = "Hide";
    close.addEventListener("click", () => box.remove());
    btns.appendChild(again);
    btns.appendChild(close);
    head.appendChild(btns);
    box.appendChild(head);

    const body = el("div", "pclnrev-body");
    box.appendChild(body);

    if (status.phase === "running") {
      body.appendChild(el("div", "pclnrev-note", status.message + "…"));
      return;
    }
    if (status.phase === "error") {
      body.appendChild(el("div", "pclnrev-err", status.message));
      return;
    }
    if (status.phase !== "done") {
      body.appendChild(el("div", "pclnrev-note", "Waiting for the page…"));
      return;
    }

    let named = 0;
    let unresolved = 0;
    let busy = 0;
    let failed = 0;
    let totalSave = 0;
    let saveCount = 0;
    for (const s of state.values()) {
      if (s.phase === "pool-hit") {
        named++;
        const hit = s.pool.survivors[0];
        const dn = (s.deal.prices || {}).nightly;
        const hn = (hit.hotel.prices || {}).nightly;
        if (dn != null && hn != null) {
          totalSave += hn - dn;
          saveCount++;
        }
      } else if (s.phase === "exact") {
        const top = s.exact.ranked && s.exact.ranked[0];
        if (top && !top.unreadable) {
          named++;
          const hp = (top.fingerprint || {}).prices || {};
          const dn = (s.deal.prices || {}).nightly;
          if (dn != null && hp.nightly != null) {
            totalSave += hp.nightly - dn;
            saveCount++;
          }
        } else failed++;
      } else if (s.phase === "resolving" || s.phase === "queued") busy++;
      else if (s.phase === "failed") failed++;
      else unresolved++;
    }

    body.appendChild(el("div", "pclnrev-bignum", named + " of " + state.size + " named"));
    body.appendChild(
      el("div", "pclnrev-note", "Free pass compared against " + pool.length + " hotels in this search.")
    );
    if (saveCount) {
      body.appendChild(
        el(
          "div",
          "pclnrev-note",
          "Average saving where known: " + money(totalSave / saveCount) + "/night"
        )
      );
    }

    const bits = [];
    if (busy) bits.push(busy + " checking");
    if (unresolved) bits.push(unresolved + " need the deal page");
    if (failed) bits.push(failed + " failed");
    if (bits.length) body.appendChild(el("div", "pclnrev-sub", bits.join(" · ")));

    const row = el("div", "pclnrev-autorow");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "pclnrev-auto";
    cb.checked = auto;
    cb.addEventListener("change", () => {
      auto = cb.checked;
      localStorage.setItem(AUTO_KEY, auto ? "1" : "0");
      if (auto) {
        for (const s of state.values()) {
          if (s.phase === "unresolved") enqueue(s.deal.token);
        }
      }
      renderSummary();
    });
    const lab = document.createElement("label");
    lab.setAttribute("for", "pclnrev-auto");
    lab.textContent = " Resolve deals as I scroll past them";
    row.appendChild(cb);
    row.appendChild(lab);
    body.appendChild(row);

    if (unresolved) {
      const all = el("button", "pclnrev-copy", "Check all " + unresolved + " remaining now");
      all.addEventListener("click", () => {
        for (const s of state.values()) {
          if (s.phase === "unresolved") enqueue(s.deal.token);
        }
      });
      body.appendChild(all);
    }

    if (failed) {
      const retry = el("button", "pclnrev-copy", "Retry " + failed + " failed");
      retry.addEventListener("click", retryFailed);
      body.appendChild(retry);
    }

    if (placed != null && placed < state.size) {
      body.appendChild(
        el("div", "pclnrev-warn", state.size - placed + " card(s) could not be located in the layout.")
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "PANEL_OPEN") {
      if (status.phase === "done") decorate();
      else run();
    }
  });

  // New cards arrive when filters or sort change, or a further page renders.
  // Re-read the payload so late deals are picked up, then re-attach badges.
  let debounce = null;
  const observer = new MutationObserver(() => {
    if (status.phase !== "done" || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (status.phase !== "done") return;
      const added = readDeals();
      if (added) applyPool();
      decorate();
    }, 700);
  });

  function start() {
    run().then(() => observer.observe(document.body, { childList: true, subtree: true }));
  }

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();
