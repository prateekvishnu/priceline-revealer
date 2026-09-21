# Priceline Express Deal Revealer

A Chrome extension that works out which hotel a Priceline **Express Deal** actually is,
before you book it.

An Express Deal hides the hotel name but shows you a "Guaranteed to be one of these N
hotels" strip. This extension reads the deal's own data, opens each named candidate,
and compares them until one fits.

## Why it works

An Express Deal listing is the real hotel's record with the name and photos stripped
out. Everything else is passed straight through, only rounded into buckets:

| Express Deal shows | The real hotel shows |
| --- | --- |
| `1,200+ Verified Reviews` | `1,251 Reviews` |
| `6+ Pleasant` | `6.6 Pleasant` |
| `Cleanliness 7+` | `7.2` |
| the full amenity list, verbatim | the same list |

So the true hotel reproduces the deal exactly and the decoys do not. The amenity list
is the strongest signal — it runs to 50+ oddly specific entries (`Socket near the bed`,
`Visual aids Braille/Tactile signs`, `Separate shower/bathtub`) and a same-class decoy
almost never reproduces it. Review count and the four sub-scores are an independent
confirmation, since a decoy would have to land in the same 100-review bucket *and* the
same integer band on all four scores.

## Two modes

**Listings page** (`/relax-ui/listings?...&product=sopq`) — writes the hotel name and
the saving onto each deal card. Some resolve instantly and free; the rest are resolved
lazily as you scroll past them. Works for any destination.

**Single deal page** (`/relax/at/express/...`) — the precise check for one deal, using
the guaranteed set and the full 50+ amenity list.

## Install

Chrome 111 or newer (the extension uses a `world: "MAIN"` content script).

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** and pick this folder

Icons are generated rather than committed as opaque binaries: `npm run icons` redraws
them from `tools/make-icons.mjs`, which encodes the PNGs itself using only `node:zlib`.

Then open any Express Deal page. The panel appears bottom-right and starts on its own.
The toolbar button re-runs it.

## Measured results

Run end to end against a live Peoria Express Deals page (09/22–09/23, 60 deals):

| | Deals named | Ambiguous | Not found |
| --- | --- | --- | --- |
| Listing data only | 9 of 30 (30%) | 0 | the rest |
| With GraphQL enrichment | **40 of 60 (67%)** | 0 | 20 |

Enrichment pulled a full amenity record for all 60 deals — averaging **62 entries**
(range 20–102) against the 6 a card shows. The West Phoenix deal resolved to Red Roof
PLUS+ Phoenix West, matching an independent hand analysis of the same deal.

All 20 remaining failures fail on **neighbourhood**, which means the real hotel is not
in the pool at all rather than being mismatched — the paging limit below, not a
matching weakness. Nothing was ambiguous, and nothing was misidentified.

**On savings, a caveat worth stating plainly:** most identified deals came out around
**$1/night cheaper** than booking the same hotel directly, not the headline discount
the strike-through price implies. A few were genuinely better (one Days Inn at $11.35).
The extension reports the real difference, which is often small.

## How the listings page works

Two paths, cheapest first. This matters because the cheap one is not sufficient on its
own — measured on a real Peoria page it named only 9 of 30 deals.

### 1. Pool match — free, instant, partial

`/relax-ui/listings` is server-rendered (React Server Components), so every deal is
already embedded in the HTML as JSON: amenities, review score bands, star level,
neighbourhood and price. The pool of *real* hotels for the same search is one
same-origin `fetch` of the same URL with `product=sopq` removed.

Both sides expose the **same** short amenity vocabulary (`Swimming Pool`,
`Hot Breakfast Included`, …) and the same review score labels, so deals match against
the pool directly, with no tabs and no detail pages.

The catch, and it is a hard one: **that search returns 30 hotels and ignores every
paging parameter.** `offset`, `pageSize`, `page`, and every neighbourhood or star
filter spelling were tested against the live site — all are silently ignored, and the
route always renders the same first page out of 538 available hotels. There is also no
infinite scroll or load-more control to borrow a paginated request from.

So for a deal in a neighbourhood away from the searched city, the real hotel is simply
not in the pool, and no amount of matching will find it. On the Peoria page this
accounted for the majority of failures: the closest pool hotel was in a different
neighbourhood entirely.

To widen the pool without tabs, the extension asks the *same* question several
ways — different `destination` (each deal carries its own location id) and different
`sort` — and merges the results. Measured union growth was 21 → 30 for one destination
across variants, and 46 across destinations. Requests are sequential and capped at 10.

Where a deal guarantees a **brand** set (22 of 60 deals on the measured page guarantee
5–9 brands rather than named hotels), the brand is used to settle a tie between
otherwise-equal survivors. It is deliberately a tiebreak and not a filter: the
hotel-side brand field's shape is not fully verified, so it can turn "ambiguous" into
an answer but can never discard a hotel. There is a test for exactly that.

### 2. Exact resolve — on demand, as you scroll

For anything the pool cannot settle, the deal's **own page** is the authority: it names
the exact guaranteed set for any destination, which is what makes this work anywhere
rather than only in the searched city. The candidates load client-side, so this needs a
real page render — a plain `fetch` of a deal page returns the shell without them.

That is driven lazily by an `IntersectionObserver`: as a card scrolls into view its
deal is queued, resolved one at a time, and the card is filled in. Two caches keep it
affordable — candidate hotels repeat heavily across the deals of one city, so each
hotel is read once per session, and each deal is resolved once.

You can switch the scroll behaviour off and resolve individual cards by hand, or hit
"Check all remaining now". The ↻ button retries everything that failed; failures are
usually just a slow page hitting the timeout.

### Matching

Both paths use hard constraints rather than a weighted score, because each value is one
Priceline passes through unchanged or only rounded — so a mismatch rules a hotel out
rather than merely costing it points:

- star level identical
- neighbourhood identical
- review count inside the deal's bucket (`1,200+` → 1200–1299)
- every sub-score inside the deal's band (`7+` → 7.0–7.9)
- every amenity the deal advertises also present on the hotel

One survivor is an identification. Several means the search genuinely cannot separate
them, and the card says so rather than picking one. Anything that cannot be compared
(a field missing on either side) is skipped rather than counted against, and a hotel
with fewer than three comparable signals is never declared a match.

Each card then shows the saving: deal nightly rate vs that hotel's own nightly rate,
with the percentage and the all-in total. If the deal is the *more* expensive option,
it says that too.

One asymmetry is deliberate: at listing level the amenity check runs in **one**
direction only (the deal's amenities must be present on the hotel). The card's list is
a curated top-six rather than exhaustive, so a hotel offering more must not be
penalised. The bidirectional check — where extras *are* disqualifying — only applies on
the deal page, where the list really is complete.

## How the single deal page works

1. `src/extractor.js` runs in the page's own JS context — the only way to reach
   `window.__APOLLO_CLIENT__`, where Priceline keeps the authoritative amenity data.
   It fingerprints the deal and pulls each candidate's hotel id out of its thumbnail
   URL (`.../master_4593905?...`).
2. `src/background.js` opens each candidate in a background tab, carrying over the
   deal's own dates and occupancy so the comparison is like-for-like, waits for that
   tab's fingerprint, then closes it. Candidates are read one at a time.
3. `src/score.js` scores each one; `src/bridge.js` renders the result.

Amenities are worth 50% of the score, review statistics 35%, and star rating / badges
/ neighbourhood the remaining 15%. Weights are renormalised over whichever signals a
page actually exposed, so a missing section does not drag a score down by itself.

Amenity comparison runs in **both** directions. A candidate missing something the deal
advertises cannot be the hotel; a candidate advertising something the deal omits is
equally disqualifying, because the deal would have listed it. That second direction is
what catches free breakfast, a fitness centre or an indoor pool.

## The GraphQL route (no tabs)

Deals are fingerprinted by calling Priceline's own GraphQL operation directly, which
needs no tab, no page render, and no waiting for hydration.

```
POST /pws/v0/pcln-graph/
{ operationName: "getSopqHotelDetails", query: <text>, variables: { pclnId, price, … } }
```

Verified against the live endpoint: same-origin, cookies only, and **no `Authorization`
or `authToken` header required** despite the page sending both. It returns, per deal:

- `starRating`
- the complete categorised amenity list — **56 entries** for the deal this was built
  against, versus the 6 a listing card shows
- `neighborhood`
- `guaranteedBrands`, with real brand names rather than logo filenames

The deal's `pclnId` comes from the listing payload already in the page, so a whole page
of deals is enriched with one request each, three in flight at a time.

**Query text, not the persisted hash.** The page sends only an APQ hash
(`extensions.persistedQuery.sha256Hash`), which is registered per build and would break
on every deploy. Instead the operation text is lifted out of any deal page's HTML — and
that HTML can be fetched even for deals whose page will not hydrate, which is what
makes the approach durable. The extension bootstraps it once and caches it in
`sessionStorage`.

Two approaches that do **not** work, both tested:

| Approach | Result |
| --- | --- |
| `fetch` the deal page and parse the rendered markup | **No.** Returns the shell; the guaranteed set is client-side. |
| Same-origin hidden `iframe` | **No.** Frame loads and is readable, but the deal app never bootstraps in a frame (`__APOLLO_CLIENT__` undefined, body stays ~1.4 KB). |

### What the full record buys

The short six-amenity list can only be checked one way, so a decoy that happens to
offer all six passes. The full record is the real hotel's own amenity list, so the
reverse check applies: anything the *hotel* advertises that the deal's record lacks
rules it out. That is what catches free breakfast, a fitness centre or an indoor pool —
and it is the same signal that made the very first identification decisive.

It needs a vocabulary mapping, because listings say `Swimming Pool` where the detail
record says `Outdoor pool`. Matching is on whole-word sequences, not substrings: deals
list the languages spoken, so `Spanish` is a real entry, and substring matching made
`Spa` match it and wave through a hotel with a spa. There is a regression test.

`getHotelDealMatches` was also explored — it is the *inverse* mapping (given a hotel,
which deals it backs) and returns nothing useful when keyed by a deal, so it is not
used. The `HotelIdTypeEnum` it accepts is `hotelId` or `pclnId`.

### The "guaranteed 3 hotels" strip

Not reachable this way, and tested rather than assumed. Across all 60 deals on the
measured page, `guaranteedBrands` returned **chain names only, never a hotel id** — 24
deals carried 5–9 brand names and the rest returned `null`. An initial guess that the
strip appears only on certain dates was checked against the exact dates of the page
that displayed it, and disproved.

So that list still comes from an operation not yet identified. It no longer matters
much: a 62-entry amenity record is a far stronger fingerprint than a 3-item shortlist,
and it is what drives the 67% above. The parser still extracts `master_<hotelId>`
images from the response should a guarantee ever name specific properties.

## Caching: nothing is asked for twice

A deal's amenity record is a property of the hotel, not of today, so once read it is
kept in `chrome.storage.local` for **seven days** and never requested again.
`store.js` exposes `getOrFetch` as the only way in, precisely so a fetch cannot happen
without a cache check first — a cached deal produces no network request at all, and
there is a test asserting the fetcher is called exactly once across three reads.

Deliberately **not** cached: anything priced. Rates move daily, and a stale one would
produce a wrong savings figure, which is worse than showing none. Prices are always
read live.

A failed or throttled request is never written, so a refusal cannot poison the cache
with an empty record — it simply gets retried later. The panel reports how many deal
records were reused versus fetched, and expired entries are pruned on each run (with a
2,000-entry ceiling trimming oldest-first).

## When Priceline throttles

It does throttle, and not always politely: during development it began answering with
HTTP 200 and a document that never hydrates — no bootstrap data, no content — which is
indistinguishable from "nothing found" unless you check for it. Silently reporting no
matches in that situation would be actively misleading.

So both forms are classified and surfaced:

- `429`, `403`, `503` — an explicit refusal
- HTML from the JSON endpoint, or a JSON body that will not parse — an interstitial
- a deal page returning 200 with no `PCLN_BOOTSTRAP_DATA` and no app — the silent form

On detection the panel shows a clear notice, **all further requests stop** (including
ones that scrolling would otherwise queue), and it says that anything already read is
cached for a week so resuming later costs nothing. Pressing ↻ is an explicit decision
to try again and lifts the pause.

Stopping rather than retrying is the deliberate choice: a throttle is a request to
back off, and hammering through it would neither work nor be reasonable.

## Verdicts

The extension distinguishes how sure it is, and will say when it does not know:

- **Identified** — ≥90% match, ≥12 points clear of the next candidate, no
  contradictions, and a byte-exact amenity match.
- **Very likely** — the same, but the amenity lists differ slightly for structural
  reasons (see below).
- **Best guess** / **Inconclusive** — the candidates are too alike on the data the
  page exposes. Shown with a warning; treat the ranking as a hint.
- **Could not tell** — no candidate page could be read.

## Verifying it

```
npm test
```

Three suites, 67 checks, no dependencies.

`test/listings.mjs` (40 checks) covers the listings parser, the rate parser and the
matcher: that the
escaped duplicate copies of the payload are discarded, that bucketing accepts 1,251
for `1,200+` and 6.6 for `6+` while rejecting 1,320 and 7.6, that each decoy is ruled
out on the signal that actually separates it, and that ambiguity, near misses and
no-match are reported rather than guessed. Field values are from the live Peoria
listings page; the per-hotel *retail* prices are synthetic and exercise the savings
arithmetic only — they are not price claims.

`test/store.mjs` (13 checks) covers the week-long cache and the throttle classifier,
including that a cached deal triggers no fetch and that a refusal is never cached.

`test/verify.mjs` (14 checks) covers the single-deal scorer. `test/fixtures.js` holds
real data captured on 2026-09-21 from a West Phoenix deal
whose candidates were Red Roof PLUS+ Phoenix West, Comfort Inn I-10 West and Baymont
by Wyndham. The scorer separates them 97% / 47% / 44%, a 50-point margin, and the
14 checks assert it got there for the right reasons rather than by luck.

Two of the fixture amenity lists are deliberately *partial* (the live capture was
truncated), which understates the gap and makes the test harder, not easier.

## Known limits

- **The free pass covers only part of a page.** 9 of 30 on the page it was measured
  against, for the paging reason described above. Everything else needs the exact path,
  which costs one deal-page render plus up to three hotel reads, cached. A full page of
  30 deals resolved end to end is real work; that is why it is lazy and queued rather
  than eager.
- **The exact path needs a rendered page.** Candidates are fetched client-side, so
  background tabs are unavoidable there. Hidden tabs get ~1s timer granularity, which
  is fine for the seconds each one lives, and there is a 60s per-candidate timeout.
- **Cards are joined to deals by what they display.** Two cards showing an identical
  star level, neighbourhood and name string are matched in DOM order. If a card cannot
  be located unambiguously it is skipped rather than risk labelling the wrong one, and
  the summary panel says how many were skipped.
- **The deal-page URL shape** (`/relax/at/express/<location id>/<deal token>/from/…`)
  is derived from the embedded listing data. It was confirmed against the live site
  (HTTP 200, no redirect) for the captured search, but not across every destination
  type. If it were ever wrong for some locale the exact path would fail loudly for
  those deals rather than mis-name them.
- **Mixed data sources.** Amenities come from the Apollo cache when available and from
  the rendered panel otherwise. The two can differ by a whole category for structural
  reasons — in the captured deal the cache omitted `Sanitation Procedures`, costing the
  correct hotel 4 of 56 amenities. The scorer detects this (`sourceMismatch`), reweights
  towards coverage, and downgrades **Identified** to **Very likely** rather than
  claiming an exact match it cannot prove. If both sides read from the cache, a true
  match comes out exact.
- **Category names.** The Apollo cache exposes numeric category ids. Only the five
  confirmed against live pages are named; the rest display as `Category <id>` rather
  than guess a label.
- **Background-tab throttling.** Hidden tabs get ~1s timer granularity, and much worse
  after 5 minutes hidden. Candidate tabs live for seconds, so this is fine, but the
  60s per-candidate timeout exists for slow loads.
- **It depends on Priceline's markup.** The `express-deal-info-guaranteed-brands`
  test id, the `master_<id>` thumbnail pattern and the Apollo cache shape are all
  implementation details that can change without notice. The DOM path is a fallback for
  exactly that reason, but a large redesign would need the selectors revisited.
- **Sold-out candidates.** If a candidate has no availability for the deal's dates its
  page may not render enough to fingerprint. It is reported as unreadable and the other
  candidates are still scored.
- Read-only. It never books anything, and it opens only pages you could visit yourself.
