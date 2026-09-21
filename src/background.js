/*
 * Orchestrates a reveal.
 *
 * The Express Deal page names its candidates but not their data, and the hotel
 * pages are client-rendered, so there is no useful response to fetch. Instead
 * each candidate is opened in a background tab, its own content script reports
 * the fingerprint, and the tab is closed again.
 *
 * bridge.js drives this over a long-lived port. That matters: an open port
 * keeps the service worker alive for the whole run, which a plain
 * sendMessage/await would not.
 */

import { scoreCandidates } from "./score.js";

const CANDIDATE_TIMEOUT_MS = 60000;

// tabId -> resolver, for fingerprints arriving from candidate tabs.
const awaiting = new Map();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "FINGERPRINT") return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  const resolve = awaiting.get(tabId);
  if (resolve) {
    awaiting.delete(tabId);
    resolve(msg.fingerprint);
  }
});

// If the user closes a candidate tab mid-read, fail that candidate rather than
// hanging until the timeout.
chrome.tabs.onRemoved.addListener((tabId) => {
  const resolve = awaiting.get(tabId);
  if (resolve) {
    awaiting.delete(tabId);
    resolve(null);
  }
});

// Carry the deal's own dates and occupancy across to each candidate, so the
// comparison is like-for-like and the prices shown are directly comparable.
function itineraryFrom(url) {
  const m = String(url).match(
    /\/from\/(\d{8})\/to\/(\d{8})(?:\/rooms\/(\d+))?/
  );
  if (!m) return null;
  return { from: m[1], to: m[2], rooms: m[3] || "1" };
}

function candidateUrl(hotelId, itinerary) {
  const base = "https://www.priceline.com/relax/at/" + hotelId;
  if (!itinerary) return base;
  return (
    base +
    "/from/" +
    itinerary.from +
    "/to/" +
    itinerary.to +
    "/rooms/" +
    itinerary.rooms
  );
}

async function closeTabQuietly(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    /* already gone */
  }
}

// Opens one candidate, waits for its fingerprint, then cleans up its tab.
async function fetchCandidate(candidate, itinerary) {
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: candidateUrl(candidate.hotelId, itinerary),
      active: false,
    });
  } catch (err) {
    return { ...candidate, fingerprint: null, error: String(err) };
  }

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      awaiting.delete(tab.id);
      resolve({ fingerprint: null, error: "Timed out reading the page." });
    }, CANDIDATE_TIMEOUT_MS);

    awaiting.set(tab.id, (fingerprint) => {
      clearTimeout(timer);
      resolve(
        fingerprint
          ? { fingerprint }
          : { fingerprint: null, error: "Tab closed before it finished loading." }
      );
    });
  });

  await closeTabQuietly(tab.id);
  return { ...candidate, ...result };
}

async function reveal(deal, port) {
  const send = (msg) => {
    try {
      port.postMessage(msg);
    } catch (_) {
      /* panel went away */
    }
  };

  const candidates = deal.candidates || [];
  if (!candidates.length) {
    send({ type: "ERROR", error: "No guaranteed hotels found on this page." });
    return;
  }

  const itinerary = itineraryFrom(deal.url);
  const collected = [];

  // Sequential on purpose: three tabs at once is a burst of traffic that looks
  // nothing like a person browsing, and the run only takes a few seconds each.
  for (let i = 0; i < candidates.length; i++) {
    send({
      type: "PROGRESS",
      done: i,
      total: candidates.length,
      message: "Reading " + (candidates[i].name || candidates[i].hotelId),
    });
    collected.push(await fetchCandidate(candidates[i], itinerary));
  }

  send({ type: "PROGRESS", done: candidates.length, total: candidates.length, message: "Comparing" });
  send({ type: "RESULT", result: scoreCandidates(deal, collected), deal });
}

/* ------------------------------------------------------------------ *
 * Resolving a deal from a listings page
 *
 * A listings page can hold dozens of deals, and nothing about the search
 * guarantees the real hotel is among the 30 the pool returns -- Priceline's
 * listings route caps at 30 and ignores every paging parameter we can send. So
 * for anything the pool cannot settle, the deal's own page is the authority:
 * it names the exact guaranteed set for any destination.
 *
 * Two caches make that affordable. Candidate hotels repeat heavily across the
 * deals of one city, and a deal's answer never changes for fixed dates, so
 * each hotel is read once per session and each deal resolved once.
 * ------------------------------------------------------------------ */

const hotelCache = new Map(); // hotelId -> fingerprint
const dealCache = new Map(); // deal detail url -> result

async function readHotel(hotelId, itinerary) {
  if (hotelCache.has(hotelId)) return { fingerprint: hotelCache.get(hotelId), cached: true };
  const got = await fetchCandidate({ hotelId }, itinerary);
  if (got.fingerprint) hotelCache.set(hotelId, got.fingerprint);
  return got;
}

async function readDealPage(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    return { fingerprint: null, error: String(err) };
  }
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      awaiting.delete(tab.id);
      resolve({ fingerprint: null, error: "Timed out reading the deal page." });
    }, CANDIDATE_TIMEOUT_MS);
    awaiting.set(tab.id, (fingerprint) => {
      clearTimeout(timer);
      resolve(
        fingerprint
          ? { fingerprint }
          : { fingerprint: null, error: "Tab closed before it finished loading." }
      );
    });
  });
  await closeTabQuietly(tab.id);
  return result;
}

async function resolveDeal(url, port, requestId) {
  const send = (msg) => {
    try {
      port.postMessage({ ...msg, requestId });
    } catch (_) {
      /* panel went away */
    }
  };

  if (dealCache.has(url)) {
    send({ type: "DEAL_RESULT", result: dealCache.get(url), cached: true });
    return;
  }

  send({ type: "DEAL_PROGRESS", message: "Opening the deal page" });
  const deal = await readDealPage(url);
  if (!deal.fingerprint) {
    /*
     * A deal page that loads but never reports a fingerprint is the shape
     * Priceline's throttling takes here: the document arrives, the app never
     * starts. Saying "throttled" is far more useful than "timed out", because
     * the answer is to wait rather than to retry immediately.
     */
    const timedOut = /timed out/i.test(deal.error || "");
    send({
      type: "DEAL_ERROR",
      throttled: timedOut,
      error: timedOut
        ? "Priceline did not render the deal page - most likely throttling us."
        : deal.error || "Could not read the deal page.",
    });
    return;
  }
  const fp = deal.fingerprint;
  if (!fp.candidates || !fp.candidates.length) {
    send({ type: "DEAL_ERROR", error: "That deal page lists no guaranteed hotels." });
    return;
  }

  const itinerary = itineraryFrom(url);
  const collected = [];
  for (let i = 0; i < fp.candidates.length; i++) {
    const c = fp.candidates[i];
    send({
      type: "DEAL_PROGRESS",
      message: "Checking " + (c.name || c.hotelId) + " (" + (i + 1) + "/" + fp.candidates.length + ")",
    });
    const got = await readHotel(c.hotelId, itinerary);
    collected.push({ ...c, ...got });
  }

  const scored = scoreCandidates(fp, collected);
  const result = { deal: fp, ...scored };
  dealCache.set(url, result);
  send({ type: "DEAL_RESULT", result });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "resolve") {
    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "RESOLVE_DEAL" || !msg.url) return;
      resolveDeal(msg.url, port, msg.requestId).catch((err) => {
        try {
          port.postMessage({
            type: "DEAL_ERROR",
            requestId: msg.requestId,
            error: String((err && err.message) || err),
          });
        } catch (_) {
          /* ignore */
        }
      });
    });
    return;
  }
  if (port.name !== "reveal") return;
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "REVEAL") return;
    reveal(msg.deal, port).catch((err) => {
      try {
        port.postMessage({ type: "ERROR", error: String((err && err.message) || err) });
      } catch (_) {
        /* ignore */
      }
    });
  });
});

// Toolbar button re-runs the panel on the current tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PANEL_OPEN" });
  } catch (_) {
    /* not a Priceline hotel page */
  }
});
