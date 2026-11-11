# tests/e2e

QA-owned end-to-end checks of the full storefront against a running **production** server. Owning tasks: T27 (MVP smoke), T113 (Phase 2 extension + build gate), T175 (Phase 3 redesign extension + build gate), all qa-engineer.

## Files

| File | Contents |
|---|---|
| `http-smoke.ts` | Entry point: seed, start `next start`, the 61 MVP checks (ids R/C/K/NJ/S/A11Y/LOG), then the Phase 2 and Phase 3 sections, then teardown and the PASS/FAIL/INFO table |
| `_phase2.ts` | Phase 2 sections (T113): P, GC, N, SEO, FM, F, XSS, ISO, H, RL, ACC |
| `_phase3.ts` | Phase 3 redesign sections (T175): BR, LT, ST, NJ3, SD, LD3, GC3, SZ |
| `_lib.ts` | Shared helpers: results table, cookie jar (honours `Max-Age=0`), `http()`, HTML helpers, the no-JS form serializer `serializeForm`/`submitForm`, read-only DB queries, process helpers, `dump()` |
| `REPORT-2026-11-06.md` | MVP run (T27a) |
| `REPORT-phase2-2026-11-07.md` | Phase 2 build gate + smoke (T113) |

## `http-smoke.ts`: production HTTP smoke (T27a + T113)

A plain Bun script, not a `*.test.ts`, so `bun test` never runs it. It needs no dependencies beyond Bun (`fetch`, `bun:sqlite`, `Bun.spawn`). A full run takes about 12 s and makes about 600 requests (Phase 3 run, 2026-11-08: 243 PASS / 2 FAIL / 19 INFO, 596 responses; the T175 results went to the orchestrator in the hand-back).

```sh
bun run build                          # the script refuses to run without .next/BUILD_ID
bun run tests/e2e/http-smoke.ts        # exit 0 = all PASS, 1 = any FAIL, 2 = setup error
```

| Env var | Effect |
|---|---|
| `SMOKE_PORT=3200` | first port to try (default 3105, then +1 until a free one is found) |
| `SMOKE_VERBOSE=1` | also print the full server log after the table |
| `SMOKE_MVP_ONLY=1` | run only the 61 MVP checks (skip the Phase 2 and Phase 3 sections) |
| `SMOKE_DUMP=<dir>` | write selected response bodies (`dump()` calls in `_phase2.ts`) to `<dir>/*.html` for debugging |

Only one task at a time may build or start the server (`.next/` is shared). Check `ps` for a leftover `next start` before a run. The script kills only the process tree it started.

What it does:
1. Deletes and re-seeds `./data/smoke.sqlite` with `DATABASE_PATH=./data/smoke.sqlite bun run seed`. It never touches `data/storefront.sqlite`.
2. Starts `bun run start` with that `DATABASE_PATH` on the first free port. It waits until the port accepts TCP connections and does not send an HTTP probe, so the first request is a true cold request.
3. Runs the checks with `fetch` (`redirect: "manual"`) and a small cookie jar per simulated shopper, and queries the DB read-only for stock, cart and order counts.
4. Prints a PASS/FAIL/INFO table, stops the server process tree by PID (`pgrep -P` walk, then SIGTERM, then SIGKILL), checks that the port is free, and deletes `smoke.sqlite*`.

### Coverage

| IDs | What |
|---|---|
| TTFB | Cold and warm (median of 7) time-to-headers for `/` and a product page |
| R01-R21 | Every route: status, one `<h1>`, one `<main id="main">`, skip link, `lang`, viewport, 15 product links, `alt` on every `<img>`, PDP h1/title/form, stock-0 PDP, unknown/SQL-fragment slugs, empty `/cart`, `/checkout` redirect, unknown/malformed order ids, unknown route 404 |
| C01-C13 | No-JS cart: add-to-cart form replay, `sf_session` HttpOnly cookie, cart line/total/checkout link, header count, `quantity=999`, over-stock add, garbage cookie, cart update, over-stock update, remove last line, `/checkout` with a valid session but an empty cart |
| K01-K18 | No-JS checkout: form and idempotency key, 4242 → 303 `/orders/<uuid>`, confirmation details, cookie gating, cart emptied, stock decremented, same-key replay, decline leaves cart/stock intact, retry after decline, validation errors, concurrent double submit, last-unit contention between two sessions, no existence leak |
| NJ01 | Whether action results (messages, re-filled values) are present in the server HTML or only in the RSC payload |
| S01-S02 | No full card number or CVC in any response of the cart/checkout flows (headers, `Location`, body; the static test-card hint is excluded and reported separately) |
| A11Y | `/`, PDP, filled `/cart`, `/checkout`, order page: one h1, one main, every visible control labelled, no `outline-none`, `<title>` set |
| LOG | No error lines in the server log. Each error is attributed to the request that preceded it |

Phase 2 sections (T113, `_phase2.ts`; they run after the MVP flows on the same server and DB):

| IDs | What |
|---|---|
| P01-P35, P40 | Cookie-less GET of 35 public routes: 200, exactly one `<h1>`, one non-empty `<title>` (HTML size + TTFB in the detail). Guest `/account/settings` → redirect to `/signin?next=%2Faccount%2Fsettings` |
| GC01-GC04 | No `Set-Cookie` on GETs: cookie-less (all routes), R-1 (`sf_session` = a user's owner key → guest state), signed in (all routes), revoked `sf_auth` (read paths never clear cookies) |
| N01-N12 | Unknown product/category/brand/list/shared-list/order/invoice/help-topic and SQL-fragment slugs → real 404 + noindex. N12: the 404 body is the real not-found page (fails today, D-T113-1) |
| SEO01-SEO20 | `/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest` status + content type; 20 sampled sitemap URLs → 200; no private routes in the sitemap; robots allow/disallow list; noindex on 15 private routes; index + absolute self canonical on 15 indexable routes; `/search` and faceted canonicals; JSON-LD parsed on `/` (Organization, WebSite + SearchAction), PDP (Product + offers, BreadcrumbList), `/products` (ItemList), `/faq` (FAQPage); no page duplicates the layout graph; unique names for multiple `role=search` landmarks; `<link rel=prev/next>` on page 2 |
| FM01-FM08 | Review, question, contact, sign-in, sign-up, address and settings forms are real `method=POST` `multipart/form-data` forms with `$ACTION_*` fields; no response in the run renders `action="javascript:…"` |
| F01-F23 | No-JS multipart replays checked against the DB: add to cart, save for later, move to cart, expired + valid coupon, shipping method, checkout with coupon (`303 /orders/<id>?placed=1`), confirmation, invoice, order list, cancel (with the confirm checkbox), Buy Now (`formAction` submitter), list create/add/remove, review, duplicate review (fresh page and stale-form replay), helpful vote, question, stock alert, address, contact (reference in the HTML), product-view recording only with a session |
| XSS01-XSS05 | `<script>alert(1)</script>` posted in list name, review, question, address label, display name and contact appears escaped; no response of the run contains it raw |
| ISO01-ISO05 | A second cookie jar gets 404 / empty for the first jar's list, address book, order, invoice and order list |
| H01-H02 | 32 hostile `/search?q=` queries and 20 hostile suggest queries never 500 |
| RL01-RL05 | Suggest JSON, 405 on POST, 429 at request 121 with Retry-After; 6th review and 4th contact message in an hour refused |
| ACC01-ACC18 | Sign-up (no JS), `sf_auth` flags, argon2id at rest, signed-in cart/order/review, owner key never in a response, sign-out (`Max-Age=0`), sign-in on a second jar sees cart + order + review, sign-out-everywhere revokes the other jar, wrong password = unknown email, lockout on the 10th/11th attempt for known and unknown emails, noindex on auth pages, `?next=` open-redirect guard |
| LOG2-01..05 | Server log: no unstable-value warnings, no unhandled errors, no `$argon2`/token/password/card/email; no token or hash in any response body |

Phase 3 sections (T175, `_phase3.ts`; they run after the Phase 2 sections, so orders exist and the home top-picks default tab is Best sellers):

| IDs | What |
|---|---|
| BR01-BR06 | Brand-free: 38 retailer/payment/social/membership/newsletter/app/copied-copy patterns (built at run time, same vocabulary as `tests/redesign/audit.test.tsx`) over visible text + `aria-label`/`alt`/`title`/`placeholder` of 25 served pages; "Northwind Goods" in every `<title>` (BR02 fails on `/`: D-T175-1), header wordmark text link, footer (+ year), JSON-LD Organization/WebSite, manifest, `og:site_name` |
| LT01-LT05 | Light-only: no dark-variant class / `prefers-color-scheme` / `data-theme` anywhere in the served bodies (RSC payload included); one `theme-color` meta = the `--accent` raw value read from `globals.css` at run time; no theme toggle; served CSS `color-scheme` only `light`; LT05 INFO lists lightningcss's helper variables |
| ST01-ST18 | Structure per `tests/redesign/CONTRACTS.md`: G rows on 25 pages (one banner with "Primary" nav + "Site search", footer "Footer: *" navs, skip link first, unique nav names, one h1 first in `<main>`, no skipped levels); home H-order (guest; signed in with `#home-recently-viewed`), hero carousel, top-picks tabs, popular searches, promo pair, services, canonical, signed-in header; listing L rows on 6 listings (breadcrumb, h1, count, closed `details[data-filter-panel]`, sort after it, card link + sibling quick-add form, badges, feedback block); promo `li` at positions 3/10/17 on page 1 only; pagination; search chips; zero-result search; `/contact?topic=feedback`; PDP title block, sticky buy box classes, rails, Was/Save |
| NJ3-01..07 | No-JS replays: quick add from a listing card and from the home rail (DB-checked), filter GET keeps `sort`, sort GET, hero dot `#slide-2` target, `?rail=` tabs incl. hostile values, cookies-disabled search/tab/quick add/sign-in (T175 AC4) |
| SD01-SD05 | Seed: 125 products (123 published + 2 future-dated) vs sitemap PDP count, future-dated PDPs 404, `/new-arrivals` "New" badges, `/deals` >= 40, OOS PDP notify form |
| LD3-01..02, GC3-01..02, SZ | JSON-LD types on home/PDP/listings/FAQ; no Set-Cookie on Phase 3 GETs; INFO rows with served HTML size, inline-script share, referenced JS and TTFB |

Phase 2 expectations moved by deliberate Phase 3 changes (ids kept): R06 (home has >= 12 product links: one top-picks rail capped at 12, T166/H-16) and R13 (stock-0 PDP: no add-to-cart form or visible quantity input *for this product*; T169 rails carry quick-add forms for other products). N12 (D-T113-1) is relabelled as known only.

### How the no-JS form posts work

Phase 2 uses `submitForm()` from `_lib.ts`. It finds a POST form on the served page, serialises it the way a browser does before hydration (every successful control in document order, checked radios/checkboxes, the selected option, textarea text, and only the clicked submit button's name), applies overrides and posts it as multipart. Two details matter:
- A button with its own `formAction` (Buy Now) is rendered as `<button name="$ACTION_REF_n">` with its `$ACTION_n:*` hidden inputs **inside** the button. Those inputs are submitted whichever button is clicked; the clicked button's `$ACTION_REF_n` decides which action runs (the last `$ACTION_REF_` wins). Next rejects more than two `$ACTION_REF_` fields, and rejects a ref without its `:0` descriptor with `400 Invalid Server Actions request`.
- Some forms render an unbound action as a single `$ACTION_ID_<id>` hidden input (sign-out, create list, sign out of all devices).

The forms render `action=""`, `method="POST"`, `encType="multipart/form-data"` and hidden `$ACTION_REF_1`, `$ACTION_1:0` (`{"id":"<action id>","bound":"$@1"}`), `$ACTION_1:1`, `$ACTION_KEY` inputs. The script replays **every hidden input plus the visible fields as `multipart/form-data`** to the page URL with an `Origin` header, just as a browser does before hydration. Results:
- Add to cart / cart update / remove: 200 HTML re-render plus `Set-Cookie: sf_session=…; HttpOnly`.
- Checkout success: `303 See Other` with `Location: /orders/<uuid>`.
- Expected checkout failures (decline, validation): 200 HTML with the message and the re-filled address/name rendered in the markup (NJ01).
- Losing a last-unit race (K17): the action returns `STOCK_CHANGED`, but the page re-render finds `canCheckout === false` and sends a real `307` to `/cart`, where the line shows as unavailable ("Remove unavailable items to continue to checkout") and there is no checkout link. The JS path shows the inline `STOCK_CHANGED` message instead. K17 accepts either outcome.

`application/x-www-form-urlencoded` is **not** treated as an action by Next: the page just re-renders and nothing is mutated (INFO row). The `Next-Action` header fallback from `src/server/db/SPIKE-NOTES.md` was not needed.

### What the script expects (PPR is off)

`cacheComponents`/PPR and the root `loading.tsx` were removed after the first run of this script (see `next.config.ts`). Every route is now dynamic SSR (`ƒ` in the build route table), so the script expects real HTTP semantics and no streamed hidden blocks:
- `notFound()` gives a real **404**: unknown or SQL-fragment slug, unknown or malformed order id, and an order requested with no cookie or another session's cookie.
- `redirect()` during render gives a real **307** (e.g. guest `/account/settings` → `/signin?next=…`); server-action redirects give **303** (checkout → `/orders/<id>?placed=1`, sign-in/up → `/account`). There is no `<meta http-equiv="refresh">`. Since ruling D-T109-1, `/checkout` with no cookie or an empty cart is a 200 page linking `/cart` (R17, C13).
- Exception (D-T113-1): a `notFound()` thrown inside a page serves the right status but an empty `<html id="__next_error__">` document; the not-found UI renders only with JS. An unmatched URL renders the full page.
- Page content and action results are in the server HTML, so they are visible without JavaScript (R21 info, NJ01).
- No error lines in the server log (LOG).

If PPR is ever turned back on, these checks will fail again. The detail column then shows the soft-404/soft-redirect evidence: `NEXT_HTTP_ERROR_FALLBACK;404`, a `noindex` meta tag, or a meta refresh.

The header count is still asserted as "the right count is present" rather than "unique", which also works if a fallback copy ever returns.

## Still needs a real browser (T27 proper, blocked on the runner decision)

- The JS-enabled checkout path (`useActionState`, pending state, key rotation after a completed attempt, double-click with a hydrated form).
- Rendering of action feedback after hydration: inline errors, decline message, re-filled values, the "Added" status.
- Client-side navigation: the `redirect()` from `/checkout` and not-found during soft navigation.
- Focus management after submit and errors, `role="status"`/live-region announcements, keyboard reachability of every card, visible focus rings, responsive layout and `error.tsx` retry.
- Visual confirmation that the pages are usable with JavaScript disabled. Over HTTP the content is now in the static HTML (R21).
