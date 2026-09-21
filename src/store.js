/*
 * A small time-to-live cache over chrome.storage.local.
 *
 * Its job is to stop the extension asking Priceline for something it has
 * already been told. A deal's amenity record is a property of the hotel, not
 * of today, so once fetched it is good for a week and must not be requested
 * again -- that is the whole point, and `getOrFetch` is the only entry point
 * for that reason: it cannot fetch without checking first.
 *
 * What is deliberately NOT cached: anything priced. Rates move daily and a
 * stale one would produce a wrong savings figure, which is worse than no
 * figure at all. Prices are always read live.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PCLNREV_STORE = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const PREFIX = "pclnrev.v1.";
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = 2000;

  /* ---- pure helpers, unit tested ---- */

  // Keys carry everything that would change the answer. Dates are included
  // even though the amenity record is date-independent, because the response
  // is fetched per itinerary and mixing them would be sloppy.
  function makeKey(kind, parts) {
    return (
      PREFIX +
      kind +
      ":" +
      []
        .concat(parts)
        .map((p) => String(p == null ? "" : p))
        .join("|")
    );
  }

  function isFresh(entry, now, ttl) {
    if (!entry || typeof entry !== "object") return false;
    if (typeof entry.at !== "number") return false;
    return now - entry.at < (ttl || WEEK_MS);
  }

  // Oldest first, so the caller can drop the head.
  function expiredKeys(all, now, ttl) {
    const out = [];
    for (const k of Object.keys(all)) {
      if (!k.startsWith(PREFIX)) continue;
      if (!isFresh(all[k], now, ttl)) out.push(k);
    }
    return out;
  }

  function overflowKeys(all, limit) {
    const mine = Object.keys(all)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => ({ k, at: (all[k] && all[k].at) || 0 }))
      .sort((a, b) => a.at - b.at);
    const excess = mine.length - (limit || MAX_ENTRIES);
    return excess > 0 ? mine.slice(0, excess).map((x) => x.k) : [];
  }

  /* ---- storage ---- */

  const available = () => {
    try {
      return !!(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local);
    } catch (_) {
      return false;
    }
  };

  function read(key) {
    if (!available()) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (o) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve(null);
          resolve((o && o[key]) || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function write(key, value) {
    if (!available()) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: { at: Date.now(), value } }, () => {
          resolve(!(chrome.runtime && chrome.runtime.lastError));
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function get(key, ttl) {
    const entry = await read(key);
    return isFresh(entry, Date.now(), ttl) ? entry.value : null;
  }

  /*
   * The only way to fetch. Returns { value, cached }.
   *
   * `fetcher` is not called at all when a fresh entry exists, and a fetcher
   * returning null or throwing is never written, so a failed or throttled
   * request cannot poison the cache with an empty record.
   */
  async function getOrFetch(key, fetcher, ttl) {
    const hit = await get(key, ttl);
    if (hit != null) return { value: hit, cached: true };

    let fresh = null;
    try {
      fresh = await fetcher();
    } catch (_) {
      fresh = null;
    }
    if (fresh == null) return { value: null, cached: false };

    await write(key, fresh);
    return { value: fresh, cached: false };
  }

  // Drops expired entries and trims the oldest if the cache has grown large.
  async function prune(ttl) {
    if (!available()) return 0;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (all) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve(0);
          const now = Date.now();
          const doomed = new Set(expiredKeys(all || {}, now, ttl));
          for (const k of overflowKeys(all || {}, MAX_ENTRIES)) doomed.add(k);
          if (!doomed.size) return resolve(0);
          chrome.storage.local.remove([...doomed], () => resolve(doomed.size));
        });
      } catch (_) {
        resolve(0);
      }
    });
  }

  async function stats() {
    if (!available()) return { entries: 0, oldest: null };
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (all) => {
          const mine = Object.keys(all || {}).filter((k) => k.startsWith(PREFIX));
          let oldest = null;
          for (const k of mine) {
            const at = all[k] && all[k].at;
            if (at && (oldest == null || at < oldest)) oldest = at;
          }
          resolve({ entries: mine.length, oldest });
        });
      } catch (_) {
        resolve({ entries: 0, oldest: null });
      }
    });
  }

  async function clear() {
    if (!available()) return 0;
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (all) => {
        const mine = Object.keys(all || {}).filter((k) => k.startsWith(PREFIX));
        if (!mine.length) return resolve(0);
        chrome.storage.local.remove(mine, () => resolve(mine.length));
      });
    });
  }

  return {
    PREFIX,
    WEEK_MS,
    MAX_ENTRIES,
    makeKey,
    isFresh,
    expiredKeys,
    overflowKeys,
    get,
    getOrFetch,
    prune,
    stats,
    clear,
  };
});
