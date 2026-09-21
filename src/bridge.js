/*
 * Isolated-world half of the content script. It cannot see the page's Apollo
 * client, and extractor.js cannot see chrome.*, so this file sits between them:
 * it relays fingerprints to the service worker and renders the panel.
 */
(() => {
  "use strict";

  const CHANNEL = "PCLN_REVEALER";
  const PANEL_ID = "pclnrev-panel";

  let dealFingerprint = null;
  let port = null;
  let state = { phase: "waiting" };

  /* ------------------------------------------------------------------ *
   * Messaging
   * ------------------------------------------------------------------ */

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.channel !== CHANNEL || d.dir !== "up") return;

    if (d.type === "FINGERPRINT") {
      const fp = d.fingerprint;
      if (fp.kind === "hotel") {
        // A candidate tab reporting in. The service worker is waiting on this.
        chrome.runtime.sendMessage({ type: "FINGERPRINT", fingerprint: fp });
        return;
      }
      dealFingerprint = fp;
      if (!fp.candidates || !fp.candidates.length) {
        setState({
          phase: "error",
          error: "This page does not list a set of guaranteed hotels.",
        });
        return;
      }
      setState({ phase: "ready" });
      startReveal();
    }

    if (d.type === "EXTRACT_ERROR") {
      setState({ phase: "error", error: d.error });
    }

    if (d.type === "NAVIGATED") {
      dealFingerprint = null;
      setState({ phase: "waiting" });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "PANEL_OPEN") {
      if (dealFingerprint) startReveal();
      else window.postMessage({ channel: CHANNEL, dir: "down", type: "RESCAN" }, location.origin);
      render();
    }
  });

  function startReveal() {
    if (!dealFingerprint) return;
    if (state.phase === "running") return;

    setState({
      phase: "running",
      progress: { done: 0, total: dealFingerprint.candidates.length, message: "Starting" },
    });

    try {
      port = chrome.runtime.connect({ name: "reveal" });
    } catch (err) {
      setState({ phase: "error", error: "Could not reach the extension worker." });
      return;
    }

    port.onMessage.addListener((msg) => {
      if (msg.type === "PROGRESS") setState({ phase: "running", progress: msg });
      else if (msg.type === "RESULT") setState({ phase: "done", result: msg.result });
      else if (msg.type === "ERROR") setState({ phase: "error", error: msg.error });
    });

    port.onDisconnect.addListener(() => {
      port = null;
      if (state.phase === "running") {
        setState({ phase: "error", error: "The reveal stopped unexpectedly." });
      }
    });

    port.postMessage({ type: "REVEAL", deal: dealFingerprint });
  }

  function setState(next) {
    state = next;
    render();
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const VERDICT_COPY = {
    certain: "Identified",
    likely: "Very likely",
    leaning: "Best guess",
    inconclusive: "Inconclusive",
    unknown: "Could not tell",
  };

  function panel() {
    let root = document.getElementById(PANEL_ID);
    if (root) return root;
    root = el("div", "pclnrev");
    root.id = PANEL_ID;
    document.body.appendChild(root);
    return root;
  }

  function header(onClose) {
    const head = el("div", "pclnrev-head");
    head.appendChild(el("span", "pclnrev-title", "Express Deal Revealer"));
    const btns = el("div", "pclnrev-headbtns");

    const again = el("button", "pclnrev-icon", "↻");
    again.title = "Run again";
    again.addEventListener("click", () => {
      if (state.phase === "running") return;
      if (dealFingerprint) startReveal();
      else window.postMessage({ channel: CHANNEL, dir: "down", type: "RESCAN" }, location.origin);
    });

    const close = el("button", "pclnrev-icon", "×");
    close.title = "Hide";
    close.addEventListener("click", onClose);

    btns.appendChild(again);
    btns.appendChild(close);
    head.appendChild(btns);
    return head;
  }

  function amenityChips(list, cls) {
    const wrap = el("div", "pclnrev-chips");
    const shown = list.slice(0, 8);
    for (const a of shown) {
      const chip = el("span", "pclnrev-chip " + cls + (a.highSignal ? " pclnrev-chip-strong" : ""), a.name);
      wrap.appendChild(chip);
    }
    if (list.length > shown.length) {
      wrap.appendChild(el("span", "pclnrev-chip pclnrev-chip-more", "+" + (list.length - shown.length) + " more"));
    }
    return wrap;
  }

  function candidateRow(c, index) {
    const row = el("div", "pclnrev-cand" + (index === 0 ? " pclnrev-cand-top" : ""));

    const top = el("div", "pclnrev-candhead");
    top.appendChild(el("span", "pclnrev-candname", c.name || c.hotelId));
    top.appendChild(
      el("span", "pclnrev-pct", c.unreadable ? "--" : Math.round(c.score * 100) + "%")
    );
    row.appendChild(top);

    if (c.unreadable) {
      row.appendChild(el("div", "pclnrev-note", c.reason));
      return row;
    }

    const bar = el("div", "pclnrev-bar");
    const fill = el("div", "pclnrev-barfill");
    fill.style.width = Math.max(2, Math.round(c.score * 100)) + "%";
    bar.appendChild(fill);
    row.appendChild(bar);

    const a = c.signals.amenities;
    const r = c.signals.reviews;
    const facts = [];
    if (a.ratio != null) {
      facts.push(
        a.exact
          ? "Amenities: exact match (" + a.dealCount + "/" + a.dealCount + ")"
          : "Amenities: " + (a.dealCount - a.missing.length) + "/" + a.dealCount +
            " matched, " + a.extra.length + " extra"
      );
    }
    if (r.ratio != null) {
      const bad = r.parts.filter((p) => !p.ok).length;
      facts.push("Review stats: " + (r.parts.length - bad) + "/" + r.parts.length + " consistent");
    }
    row.appendChild(el("div", "pclnrev-note", facts.join(" · ")));

    if (a.sourceMismatch) {
      row.appendChild(
        el("div", "pclnrev-warn", "Amenity lists came from different sources; weighted accordingly.")
      );
    }

    if (c.disqualifiers.length) {
      const dq = el("div", "pclnrev-dq");
      for (const d of c.disqualifiers.slice(0, 4)) dq.appendChild(el("div", "pclnrev-dqitem", d));
      if (c.disqualifiers.length > 4) {
        dq.appendChild(el("div", "pclnrev-dqitem", "+" + (c.disqualifiers.length - 4) + " more"));
      }
      row.appendChild(dq);
    }

    if (a.missing.length) {
      row.appendChild(el("div", "pclnrev-sub", "In the deal, not here:"));
      row.appendChild(amenityChips(a.missing, "pclnrev-chip-miss"));
    }
    if (a.extra.length) {
      row.appendChild(el("div", "pclnrev-sub", "Here, not in the deal:"));
      row.appendChild(amenityChips(a.extra, "pclnrev-chip-extra"));
    }

    return row;
  }

  function render() {
    const root = panel();
    root.textContent = "";
    root.appendChild(header(() => root.remove()));

    const body = el("div", "pclnrev-body");
    root.appendChild(body);

    if (state.phase === "waiting") {
      body.appendChild(el("div", "pclnrev-note", "Reading this deal…"));
      return;
    }

    if (state.phase === "error") {
      body.appendChild(el("div", "pclnrev-err", state.error));
      return;
    }

    if (state.phase === "running" || state.phase === "ready") {
      const p = state.progress || { done: 0, total: 0, message: "Starting" };
      body.appendChild(el("div", "pclnrev-note", p.message + "…"));
      const bar = el("div", "pclnrev-bar");
      const fill = el("div", "pclnrev-barfill pclnrev-barfill-busy");
      fill.style.width = p.total ? Math.round((p.done / p.total) * 100) + "%" : "10%";
      bar.appendChild(fill);
      body.appendChild(bar);
      body.appendChild(
        el("div", "pclnrev-sub", "Checking each guaranteed hotel in a background tab.")
      );
      return;
    }

    const result = state.result;
    const top = result.ranked[0];

    const verdict = el("div", "pclnrev-verdict pclnrev-v-" + result.verdict);
    verdict.appendChild(el("div", "pclnrev-vlabel", VERDICT_COPY[result.verdict] || result.verdict));
    verdict.appendChild(
      el("div", "pclnrev-vname", top && !top.unreadable ? top.name || top.hotelId : "No match")
    );
    if (top && !top.unreadable) {
      verdict.appendChild(
        el(
          "div",
          "pclnrev-vmeta",
          Math.round(top.score * 100) + "% match · " +
            Math.round(result.margin * 100) + " pts clear of next"
        )
      );
    }
    body.appendChild(verdict);

    if (result.verdict === "inconclusive" || result.verdict === "leaning") {
      body.appendChild(
        el(
          "div",
          "pclnrev-warn",
          "The candidates look too alike on the data this page exposes. Treat the ranking as a hint, not an answer."
        )
      );
    }

    for (let i = 0; i < result.ranked.length; i++) {
      body.appendChild(candidateRow(result.ranked[i], i));
    }

    const copy = el("button", "pclnrev-copy", "Copy full report");
    copy.addEventListener("click", async () => {
      const payload = JSON.stringify({ deal: dealFingerprint, result }, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy full report"), 1500);
      } catch (_) {
        copy.textContent = "Copy failed";
      }
    });
    body.appendChild(copy);
  }
})();
