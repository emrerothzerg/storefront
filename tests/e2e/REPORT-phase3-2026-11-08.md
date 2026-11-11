# Phase 3 build gate + HTTP smoke — 2026-11-08 (T175)

Written by the orchestrator from the T175 QA hand-back (the agent could not write this file itself).

## Build gate
- `bun run build` (Next 16.4.5, Turbopack): exit 0, 16.06 s, max RSS 2.71 GB (Phase 2: 15.9 s / 2.68 GB).
- Routes: 42 dynamic (every page route, `/sitemap.xml`, `/api/search/suggest`); static only `/manifest.webmanifest` and `/robots.txt`; no partial prerender.
- `data/`: `.gitkeep` plus the pre-existing dev DB (`storefront.sqlite*`, untouched).
- Chunks: 37 JS chunks, 1,149.9 KiB (largest 223.7 KiB); one CSS file 49.8 KiB. Built CSS has only `color-scheme:light` (the `--lightningcss-dark` helper is a minifier artefact, not a theme).
- Served HTML: `/` 240 KiB (guest) / 255.5 KiB (signed in), `/products` 381.7 KiB, `/category/beauty-personal-care` 269.8 KiB, `/search?q=desk` 228.9 KiB, PDP 551 KiB, `/cart` 194.9 KiB, `/checkout` 107.4 KiB. Warm TTFB: `/` 15.8 ms median, PDP 25.3 ms.

## Smoke totals (final run): 243 PASS / 2 FAIL / 19 INFO — 596 HTTP responses in 11.6 s, clean teardown
| Section | PASS / FAIL / INFO |
|---|---|
| MVP | 61 / 0 / 6 |
| P public routes | 38 / 0 / 0 |
| N 404s | 11 / 1 / 0 (N12 = known D-T113-1) |
| SEO | 18 / 0 / 1 |
| FM forms | 7 / 0 / 0 |
| F no-JS flows | 24 / 0 / 0 |
| XSS | 5 / 0 / 0 |
| ISO isolation | 5 / 0 / 0 |
| H hostile search | 2 / 0 / 0 |
| RL rate limits | 5 / 0 / 0 |
| ACC accounts | 20 / 0 / 2 |
| LOG2 server log | 4 / 0 / 1 |
| BR brand-free | 5 / 1 / 0 (BR02 = D-T175-1, fixed after this run) |
| LT light-only | 4 / 0 / 1 |
| ST structure (CONTRACTS) | 18 / 0 / 0 |
| NJ3 no-JS replays | 7 / 0 / 0 |
| SD seed sanity | 5 / 0 / 0 |
| LD3 JSON-LD | 2 / 0 / 0 |
| GC3 no Set-Cookie on GET | 2 / 0 / 0 |
| SZ sizes | 0 / 0 / 8 |

## Defects
- **D-T175-1 (minor, fixed 2026-11-08 by the orchestrator):** the home `<title>` lacked "Northwind Goods" because the root segment is not covered by the layout title template. `src/app/page.tsx` now sets `title: { absolute: "<HOME_TITLE> | Northwind Goods" }`.
- **D-T113-1 (known, escalated):** in-page `notFound()` on dynamic routes serves the empty error shell without JS (status 404 + noindex are correct). Fix requires a request proxy — awaiting the hosting decision.

## Phase 2 expectations updated (ids kept)
- R06: home needs ≥ 12 distinct product links (one top-picks rail capped at 12, contract H-16).
- R13: on the stock-0 PDP the rule is scoped to that product (rails carry quick-add forms for other products).
- N12: relabelled as the known D-T113-1.

## Observations
- PDP HTML grew to 551 KiB (36 rail cards with quick-add forms + RSC payload); `/products` to 382 KiB.
- Home deal panel still says "List price:" / "You save" where cards say "Was" / "Save".
- Manifest description still says "check out as a guest". `NEXT_PUBLIC_SITE_URL` unset; `Secure` cookies on localhost; test-card hint in checkout HTML (unchanged from T113).

## Browser-only checks (not verifiable over HTTP)
PLAN.md browser list 1–11 and 13; `#slide-n` anchors scrolling the snap track without a vertical jump; sticky buy box vs focused controls and the sticky header at ≥ 1024 px; filter drawer below lg (Escape, focus return); tab links keeping scroll position with JS; JS quick-add live region + header count; 320/360/480 px horizontal scroll, focus-ring clipping in scroll rows, measured touch targets; contrast in context, reduced motion, image layout shift; the PDP against a real reference.

## Results table (264 rows)
| ID | Result | Check | Detail |
|---|---|---|---|
| SETUP | PASS | seed ./data/smoke.sqlite | $ bun run src/server/db/seed-cli.ts |
| SETUP | PASS | next start (production) on :3105, pid 38022 |  |
| TTFB | INFO | / cold 259.1 ms, warm median 15.8 ms |  |
| TTFB | INFO | /products/1000-piece-puzzle-coast cold 59.3 ms, warm median 25.3 ms |  |
| R01 | PASS | / status 200 | status 200 |
| R02 | PASS | / exactly one &lt;h1&gt; | h1 count 1 |
| R03 | PASS | / exactly one &lt;main id="main"&gt; (and one &lt;main&gt;) | main id=main 1, &lt;main 1 |
| R04 | PASS | / skip link href="#main" |  |
| R05 | PASS | / &lt;html lang="en"&gt; and viewport meta |  |
| R06 | PASS | / at least 12 distinct product links (MVP: exactly 15; Phase 2: &gt;= 15; Phase 3: one top-picks rail of &lt;= 12, T166/H-16) | 12 distinct /products/* hrefs |
| R07 | PASS | / every &lt;img&gt; has alt= | 38 imgs, 0 without alt |
| R08 | PASS | /products/1000-piece-puzzle-coast status 200 | status 200 |
| R09 | PASS | PDP one &lt;h1&gt; with the product name | h1 count 1, text "1000-Piece Puzzle: Coastal Village" |
| R10 | PASS | PDP &lt;title&gt; contains the name | title "1000-Piece Puzzle: Coastal Village \| Northwind Goods" |
| R11 | PASS | PDP has an add-to-cart form (productId + quantity + $ACTION fields) | &lt;form class="flex flex-col gap-3" action="" encType="multipart/form-data" method="POST"&gt; |
| R12 | PASS | /products/ceramic-pour-over (stock 0) status 200 | status 200 |
| R13 | PASS | stock-0 PDP: "Out of stock" shown, no visible quantity input, no add-to-cart/Buy Now form for this product (v2: "Notify me" form instead; v3: rail quick-add forms for other products allowed) | "Out of stock" true; visible quantity inputs 0; own add-to-cart form false; notify form true; rail quick-add forms for other products 36 |
| R14 | PASS | /products/nope 404 | status 404 |
| R15 | PASS | /products/%27%20OR%201%3D1%20-- 404, no SQL error in server log | status 404, sql error in log: false |
| R16 | PASS | /cart (no cookie) 200, empty state, no checkout link | status 200, empty: true, checkout link: false |
| R17 | PASS | /checkout (no cookie): 200 empty state with a link to /cart, no checkout form, no meta refresh (MVP: 3xx; ruling D-T109-1) | status 200, location null, /cart link true, form false |
| R18 | PASS | /orders/&lt;random uuid&gt; 404 | status 404 |
| R19 | PASS | /orders/not-a-uuid 404 | status 404 |
| R21 | INFO | JS disabled: / page content (h1) is in the static HTML, not only inside PPR-streamed &lt;div hidden&gt; blocks | first &lt;h1&gt; at 16915, first streamed hidden div at -1: h1 in shell |
| R20 | PASS | /definitely-not-a-route 404 with "Page not found" and a link home | status 404, text: true |
| C01 | PASS | no-JS add-to-cart POST (multipart/form-data, $ACTION_* replay) 2xx/3xx | status 200; "Added 2 to your cart." in response: true |
| C02 | PASS | Set-Cookie sf_session=&lt;uuid&gt;; HttpOnly | sf_session=&lt;uuid&gt;; Path=/; Expires=Tue, 08 Dec 2026 11:27:44 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax |
| C03 | PASS | /cart with cookie: 200, quantity 2, line total $43.98, "Proceed to checkout" link | status 200, qty 2, total present true |
| C04 | PASS | / with cookie contains "Cart, 2 items" | streamed count present: true |
| C05 | PASS | POST quantity=999: no 500, inline error, cart unchanged (DB qty 2) | status 200, DB qty 2, message: Please choose a quantity between 1 and 99.&amp;quot;,&amp;quot;details&amp;quot;:{&amp;quot;reason&amp;quot;:&amp;quot;ABOVE_MAX&amp;quot;,&amp;quot;max&amp;quot;:99}}}] |
| C06 | PASS | over-stock add (limited-print-no-1, stock 1, qty 2): inline "Only N left" error, no cart line | status 200, DB qty 0 |
| C07 | PASS | /cart after rejected adds still shows exactly the one line, quantity 2 | qty 2, quantity inputs 1 |
| C08 | PASS | garbage sf_session: /cart 200 empty state | status 200 |
| C09 | PASS | garbage sf_session: first add mints a fresh UUID session | new cookie is uuid: true |
| C10 | PASS | no-JS cart update to 3: DB qty 3, line total $135.00 on /cart | status 200, DB qty 3 |
| C11 | PASS | no-JS cart update above stock (61 &gt; 60): no 500, quantity stays 3, error in response | status 200, DB qty 3, message Only 60 left in stock. |
| C12 | PASS | no-JS remove of the last line: empty state, no checkout link | status 200, DB qty 0 |
| C13 | PASS | /checkout with a valid session but empty cart: 200 empty state linking /cart, no form (MVP: redirect; ruling D-T109-1) | status 200, location null, form false, meta refresh false |
| K01 | PASS | /checkout with cookie: 200, hidden idempotencyKey (UUID), all address/card fields | status 200, key uuid true, missing none |
| K02 | PASS | no-JS checkout POST (4242) redirects to /orders/&lt;uuid&gt; (v2: ?placed=1 query) | status 303, Location /orders/db269e9a-24b5-4dec-808b-fd772857b6e7?placed=1 |
| K03 | PASS | order page (Location incl. ?placed=1) with cookie: 200, "Thank you for your order", item, "Card ending in 4242", total $43.98 | status 200, thanks true, item true, last4 true, total true |
| K04 | PASS | order page without cookie: 404 | status 404 |
| K05 | PASS | /cart after order: empty state | empty true |
| K06 | PASS | stock decremented by 2 after paid order | before 34, after 32 |
| K07 | PASS | replay same POST (same idempotencyKey): same order URL, orders count still 1, stock unchanged | status 303, Location /orders/db269e9a-24b5-4dec-808b-fd772857b6e7?placed=1, orders 1, stock 32 |
| K08 | PASS | decline (4000000000000002, new session, new key): response carries PAYMENT_FAILED + decline message, no redirect | status 200, Location null, message: Your card was declined.&amp;quot;,&amp;quot;details&amp;quot;:{&amp;quot;orderId&amp;quot;:&amp;quot;a66ccafb-a64b-4d54-a336-abfb1d413a7a&amp;quot;,&amp;quot;failureCode&amp;quot;:&amp;quot;DECLINED&amp;q |
| K10 | PASS | decline: /cart still has the line | qty 1 |
| K11 | PASS | decline: stock unchanged, no new paid order | stock 60 -&gt; 60, paid orders 1 -&gt; 1 |
| K12 | PASS | order page with another session's cookie: 404 | status 404 |
| K14 | PASS | no existence leak: no-cookie and other-session order responses carry no order data and the same &lt;title&gt; as a random id | no-cookie leaks [], cross-session leaks [], titles "Page not found \| Northwind Goods" / "Page not found \| Northwind Goods" / random "Page not found \| Northwind Goods" |
| K13 | PASS | retry after decline with a fresh key + 4242 succeeds (redirect to a new order) | status 303, Location /orders/b46693da-f56c-40ea-94bd-e49395b0e8b4?placed=1, fresh key true, paid orders 2 |
| K15 | PASS | validation failure (non-Luhn card, blank city): no redirect, VALIDATION_FAILED with per-field errors for number and city | status 200, VALIDATION_FAILED true, card echoed false |
| K16 | PASS | concurrent double submit (same key, Promise.all): both redirect to the same order, exactly one new paid order, stock -1 | statuses 303/303, locations /orders/46d51f32-a046-44fc-821a-e4cdb052e2a1?placed=1 / /orders/46d51f32-a046-44fc-821a-e4cdb052e2a1?placed=1, paid 2 -&gt; 3, stock 59 -&gt; 58 |
| K17 | PASS | last-unit contention (limited-print-no-1, stock 1, two sessions): exactly one order, stock 0, loser gets inline STOCK_CHANGED naming the item OR a 3xx to /cart showing the unavailable warning without a checkout link | statuses 303/200, paid 3 -&gt; 4, stock 0, loser: inline STOCK_CHANGED |
| K18 | INFO | orders table after all flows (incl. payment_failed rows written by declines) | paid 4, payment_failed 1 |
| NJ01 | PASS | no-JS: action results are rendered in the server HTML (not only in the RSC payload applied at hydration) | "Added 2 to your cart.": in HTML; qty 999 error: in HTML; "Only 1 left in stock.": in HTML; "Your card was declined.": in HTML; fullName re-filled: in HTML |
| S01 | PASS | no full card number / CVC in any step 4-5 response (52 responses scanned, static test-card hint excluded) | clean |
| S02 | INFO | static "Test mode" hint lists the mock card numbers in production HTML | 9 responses contain it (fixed list from PaymentFields, not user input) |
| A11Y | PASS | /: one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "Deals, best sellers and new arrivals" |
| A11Y | PASS | /products/1000-piece-puzzle-coast: one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "1000-Piece Puzzle: Coastal Village \| Northwind Goods" |
| A11Y | PASS | /checkout (filled cart): one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "Checkout \| Northwind Goods" |
| A11Y | PASS | /cart (filled): one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "Your cart \| Northwind Goods" |
| A11Y | PASS | order page /orders/db269e9a…: one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "Order (number redacted) \| Northwind Goods" |
| INFO | INFO | add-to-cart replayed as application/x-www-form-urlencoded (form declares multipart) | status 200, Set-Cookie false, "Added" in body false (not treated as an action by Next) |
| P01 | PASS | /: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Everyday essentials, all in one place", title 1 "Deals, best sellers and new arrivals", 239.7 KiB HTML, 11 ms |
| P02 | PASS | /products: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "All products", title 1 "All products \| Northwind Goods", 382.7 KiB HTML, 22 ms |
| P03 | PASS | /deals: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Today's Deals", title 1 "Today's Deals \| Northwind Goods", 392.6 KiB HTML, 18 ms |
| P04 | PASS | /best-sellers: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Best Sellers", title 1 "Best Sellers \| Northwind Goods", 384.2 KiB HTML, 17 ms |
| P05 | PASS | /new-arrivals: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "New Arrivals", title 1 "New Arrivals \| Northwind Goods", 389.4 KiB HTML, 18 ms |
| P06 | PASS | /top-rated: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Top Rated", title 1 "Top Rated \| Northwind Goods", 379.8 KiB HTML, 16 ms |
| P07 | PASS | /brands: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Brands", title 1 "Brands \| Northwind Goods", 103.9 KiB HTML, 7 ms |
| P08 | PASS | /brand/driftwood-pine: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Driftwood &amp; Pine", title 1 "Driftwood &amp; Pine \| Northwind Goods", 240.1 KiB HTML, 13 ms |
| P09 | PASS | /category/beauty-personal-care: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Beauty &amp; Personal Care", title 1 "Beauty &amp; Personal Care \| Northwind Goods", 269.8 KiB HTML, 21 ms |
| P10 | PASS | /category/audio: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Headphones &amp; Audio", title 1 "Headphones &amp; Audio \| Northwind Goods", 177.4 KiB HTML, 11 ms |
| P11 | PASS | /products/1000-piece-puzzle-coast: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "1000-Piece Puzzle: Coastal Village", title 1 "1000-Piece Puzzle: Coastal Village \| Northwind Goods", 540.3 KiB HTML, 23 ms |
| P12 | PASS | /search?q=lamp: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Showing results for “lamp”", title 1 "Results for “lamp” \| Northwind Goods", 146.5 KiB HTML, 17 ms |
| P13 | PASS | /help: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Help center", title 1 "Help center \| Northwind Goods", 111.5 KiB HTML, 8 ms |
| P14 | PASS | /help/shipping: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Shipping and delivery", title 1 "Shipping and delivery help \| Northwind Goods", 105.2 KiB HTML, 7 ms |
| P15 | PASS | /faq: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Frequently asked questions", title 1 "Frequently asked questions \| Northwind Goods", 258.0 KiB HTML, 8 ms |
| P16 | PASS | /contact: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Contact us", title 1 "Contact us \| Northwind Goods", 93.7 KiB HTML, 8 ms |
| P17 | PASS | /about: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "About Northwind Goods", title 1 "About Northwind Goods \| Northwind Goods", 90.4 KiB HTML, 6 ms |
| P18 | PASS | /shipping: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Shipping policy", title 1 "Shipping policy \| Northwind Goods", 94.5 KiB HTML, 7 ms |
| P19 | PASS | /returns: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Returns and refunds policy", title 1 "Returns and refunds policy \| Northwind Goods", 89.9 KiB HTML, 6 ms |
| P20 | PASS | /privacy: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Privacy notice", title 1 "Privacy notice \| Northwind Goods", 103.2 KiB HTML, 6 ms |
| P21 | PASS | /terms: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Terms of use", title 1 "Terms of use \| Northwind Goods", 95.6 KiB HTML, 6 ms |
| P22 | PASS | /accessibility: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Accessibility statement", title 1 "Accessibility statement \| Northwind Goods", 90.3 KiB HTML, 6 ms |
| P23 | PASS | /cart: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Shopping Cart", title 1 "Your cart \| Northwind Goods", 109.5 KiB HTML, 7 ms |
| P24 | PASS | /checkout: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Checkout", title 1 "Checkout \| Northwind Goods", 86.6 KiB HTML, 5 ms |
| P25 | PASS | /compare: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Compare products", title 1 "Compare products \| Northwind Goods", 86.0 KiB HTML, 7 ms |
| P26 | PASS | /lists: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your lists", title 1 "Your lists \| Northwind Goods", 89.2 KiB HTML, 7 ms |
| P27 | PASS | /orders: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your orders", title 1 "Your Orders \| Northwind Goods", 91.6 KiB HTML, 6 ms |
| P28 | PASS | /account: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your Account", title 1 "Your Account \| Northwind Goods", 109.7 KiB HTML, 7 ms |
| P29 | PASS | /account/addresses: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your addresses", title 1 "Your Addresses \| Northwind Goods", 97.5 KiB HTML, 8 ms |
| P30 | PASS | /account/alerts: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your stock alerts", title 1 "Stock Alerts \| Northwind Goods", 89.3 KiB HTML, 6 ms |
| P31 | PASS | /account/contributions: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your reviews &amp; questions", title 1 "Your Reviews &amp; Questions \| Northwind Goods", 90.3 KiB HTML, 7 ms |
| P32 | PASS | /account/history: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your browsing history", title 1 "Browsing History \| Northwind Goods", 89.1 KiB HTML, 7 ms |
| P33 | PASS | /account/messages: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your messages", title 1 "Messages \| Northwind Goods", 89.0 KiB HTML, 6 ms |
| P34 | PASS | /signin: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Sign in", title 1 "Sign in \| Northwind Goods", 87.8 KiB HTML, 8 ms |
| P35 | PASS | /signup: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Create account", title 1 "Create account \| Northwind Goods", 88.7 KiB HTML, 6 ms |
| P40 | PASS | guest GET /account/settings → 3xx to /signin?next=%2Faccount%2Fsettings | status 307, Location /signin?next=%2Faccount%2Fsettings (307 = Next redirect() during render; brief said 302/303, AC 12 says 'redirects') |
| GC01 | PASS | no Set-Cookie on cookie-less GET of all 36 routes above | none |
| SEO20 | PASS | /products?page=2: &lt;link rel="prev"&gt; → page 1, &lt;link rel="next"&gt; → page 3, self canonical | status 200, prev /products, next /products?page=3, canonical /products?page=2 |
| N01 | PASS | /products/no-such-product-xyz → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N02 | PASS | /category/no-such-category-xyz → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N03 | PASS | /brand/no-such-brand-xyz → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N04 | PASS | /lists/e2af630e-0512-4bb8-96ef-95ab3d6ab624 → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N05 | PASS | /lists/not-a-uuid → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N06 | PASS | /orders/b54ef358-fdcb-4060-ad32-2afc7a6e3497 → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N07 | PASS | /orders/not-a-uuid → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N08 | PASS | /orders/961cb62e-fb05-43c6-bcbd-1666ae1d332b/invoice → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N09 | PASS | /help/no-such-topic → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N10 | PASS | /lists/shared/not-a-real-token → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N11 | PASS | /category/%27%20OR%201%3D1%20-- → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N12 | FAIL | 404 body is the not-found page in the served HTML (one &lt;h1&gt; 'Page not found', search box, links) for in-page notFound(), as it is for an unmatched URL (known open D-T113-1, escalated to the human; not a Phase 3 regression) | 11/11 in-page 404s serve the empty &lt;html id="__next_error__"&gt; shell (no &lt;h1&gt;, no &lt;main&gt;, title only; content rendered client-side): /products, /category, /brand, /lists, /orders, /help; unmatched URL: h1 1, error shell false |
| SEO01 | PASS | /sitemap.xml 200, XML content type, &lt;urlset&gt; with &lt;loc&gt; entries | status 200, content-type application/xml, 190 URLs |
| SEO02 | PASS | /robots.txt 200, text/plain | status 200, content-type text/plain |
| SEO03 | PASS | /manifest.webmanifest 200, application/manifest+json, parses with name + start_url | status 200, content-type application/manifest+json, parsed true |
| SEO04 | PASS | 20 sampled sitemap URLs return 200 | ok: / /about /brand/kestrel-audio /category/audio /category/computer-accessories /category/fragrance … |
| SEO05 | PASS | sitemap has no private/noindex routes (/signin, /signup, /account/**, /cart, /orders, /lists, /search, /contact …) | clean (190 URLs; origin http://localhost:3000) |
| SEO06 | INFO | sitemap/robots absolute origin (NEXT_PUBLIC_SITE_URL) | sitemap origin http://localhost:3000; robots Sitemap line "Sitemap: http://localhost:3000/sitemap.xml"; robots.txt and manifest are prerendered (○) at build time |
| SEO07 | PASS | robots.txt: /signin /signup /contact NOT disallowed; /search /account (+ /account/settings) /cart /checkout /orders /lists disallowed | allowed wrongly blocked [], must-block not blocked []; Disallow: /cart /checkout /orders /orders/ /account /lists /search /api/ /compare |
| SEO08 | PASS | noindex in served HTML or header on 15 private routes | all noindex |
| SEO09 | PASS | 15 indexable routes carry no noindex | ok |
| SEO10 | PASS | served &lt;link rel=canonical&gt; on indexable routes is the absolute self URL | ok |
| SEO11 | PASS | /search?q=lamp: robots noindex,follow and canonical /search?q=lamp | robots "noindex, follow", canonical /search?q=lamp |
| SEO12 | PASS | faceted listing /products?rating=4 → noindex,follow, canonical page-1 base | robots "noindex, follow", canonical /products |
| SEO13 | PASS | layout JSON-LD parses: Organization + WebSite with SearchAction (on /) | types [ItemList, Organization, WebSite], SearchAction target {"@type":"EntryPoint","urlTemplate":"http://localhost:3000/search?q={search_term_string}"}, errors 0 |
| SEO14 | PASS | PDP JSON-LD parses: Product (name, offers.price, priceCurrency, availability) + BreadcrumbList | types [Product, BreadcrumbList, Organization, WebSite], name "1000-Piece Puzzle: Coastal Village", price 21.99 USD, availability https://schema.org/InStock |
| SEO15 | PASS | listing (/products) JSON-LD parses: ItemList with ListItem positions 1..n and product URLs | ItemList 24 elements, numberOfItems 24, first {"@type":"ListItem","position":1,"url":"http://localhost:3000/products/brass-desk-lamp","name":"Brass Desk Lam |
| SEO16 | PASS | /faq JSON-LD parses: FAQPage with Question/acceptedAnswer entries | 38 questions |
| SEO17 | PASS | every JSON-LD block parses on 36 pages | ok |
| SEO18 | PASS | no page JSON-LD duplicates the layout's Organization/WebSite (exactly one each per page; ≤ 1 Product) | ok |
| SEO19 | PASS | pages with two role=search landmarks (header + /help search) give each a unique accessible name (T104b list) | ok; /help &lt;header&gt; inside &lt;main&gt;: true (scoped header, not a banner landmark) |
| FM01 | PASS | PDP write-review form: method=POST, enctype=multipart/form-data, $ACTION_* fields, no javascript: action | &lt;form id="write-review" noValidate="" aria-label="Write a review" action="" encType="multipart/form-data" method="POST"&gt; |
| FM02 | PASS | PDP ask-a-question form: method=POST, enctype=multipart/form-data, $ACTION_* fields, no javascript: action | &lt;form aria-label="Ask a question" action="" encType="multipart/form-data" method="POST"&gt; |
| FM03 | PASS | /contact form: method=POST, enctype=multipart/form-data, $ACTION_* fields, no javascript: action | &lt;form aria-label="Contact us" action="" encType="multipart/form-data" method="POST"&gt; |
| FM04 | PASS | /signin form: method=POST, enctype=multipart/form-data, $ACTION_* fields, no javascript: action | &lt;form id="signin-form" noValidate="" aria-label="Sign in" action="" encType="multipart/form-data" method="POST"&gt; |
| FM05 | PASS | /signup form: method=POST, enctype=multipart/form-data, $ACTION_* fields, no javascript: action | &lt;form id="signup-form" noValidate="" aria-label="Create account" action="" encType="multipart/form-data" method="POST"&gt; |
| FM06 | PASS | /account/addresses new-address form: method=POST, enctype=multipart/form-data, $ACTION_* fields, no javascript: action | &lt;form id="address-form-new" noValidate="" aria-label="Add a new address" action="" encType="multipart/form-data" method="POST"&gt; |
| F01 | PASS | no-JS add to cart (1000-piece-puzzle-coast) → cart_items row | status 200, msg Added 1 to your cart. |
| F02 | PASS | no-JS save for later → line leaves the cart, save_for_later list row | status 200, saved rows 1 |
| F03 | PASS | no-JS move to cart → line back in the cart, saved row gone | status 200, saved rows 0, buttons [Move to cart] |
| F05 | PASS | no-JS expired coupon (EXPIRED10) rejected inline, nothing stored, no 500 | status 200, coupon null, msg g! Promo code Apply This promo code has expired |
| F04 | PASS | no-JS apply coupon (lower-case 'save5') → carts.coupon_code SAVE5, discount shown | status 200, coupon SAVE5, msg SAVE5 $5 |
| F06 | PASS | no-JS select shipping (express) → carts.shipping_method_id express | status 200, method express |
| F07 | PASS | no-JS checkout with coupon → 303 /orders/&lt;uuid&gt;?placed=1; order has SAVE5, discount, express, paid | status 303, Location /orders/3aef6200-66c7-4ff5-af40-75dc944306e7?placed=1, order {"id":"3aef6200-66c7-4ff5-af40-75dc944306e7","coupon_code":"SAVE5","discount_cents":500,"shipping_method_id":"express","status":"paid"} |
| F08 | PASS | order confirmation (?placed=1) 200 with thank-you banner, SAVE5 discount line and Express | status 200, thanks true, SAVE5 true, Express true |
| F09 | PASS | invoice page 200 for the owner, one h1, noindex | status 200, h1 1, robots "noindex, nofollow" |
| F10 | PASS | /orders lists the new order for its owner | status 200, link present true |
| F11 | PASS | no-JS cancel order (confirm checkbox ticked) → fulfillment_status cancelled, cancelled_at set | status 200, row {"fulfillment_status":"cancelled","cancelled_at":"2026-11-08T11:27:47.190Z"}, buttons [Cancel order] |
| F12 | PASS | no-JS Buy Now (submitter = Buy Now button's $ACTION_REF) → redirect to /checkout, item in cart | status 303, Location /checkout, cart rows 1 |
| F13 | PASS | no-JS create list → 303 /lists/&lt;id&gt;?created=1, lists row | status 303, Location /lists/3ea6c5dc-c16e-4379-9654-1130c8744bdc?created=1, row {"id":"3ea6c5dc-c16e-4379-9654-1130c8744bdc","name":"Smoke list &lt;script&gt;alert(1)&lt;/script&gt;"} |
| F14 | PASS | no-JS add to list (PDP form, listId = new list) → list_items row | status 200, rows 1 |
| F15 | PASS | no-JS remove from list → list_items row gone | status 200, rows 0 |
| F16 | PASS | no-JS submit review → reviews row (published) | status 200, rows 1, msg none |
| F17b | PASS | stale write-review form replayed (same fields, same session) → rejected: still one row, 'already reviewed' message, no 500 | status 200, rows 1, msg  Helpful (0) You already reviewed this product |
| F17 | PASS | duplicate review on the same product rejected (still one row; DUPLICATE message, or the form is replaced by an 'already reviewed' state) | no write-review form on the second visit; text:  Helpful (0) You already reviewed this product |
| F18 | PASS | no-JS vote helpful on a review → review_votes row, helpful_count +1 | review rev_seed_052_01, count 5 → 6, status 200 |
| F19 | PASS | no-JS ask a question → questions row | status 200 |
| F20 | PASS | no-JS subscribe stock alert (stock-0 PDP) → stock_alerts row | status 200, msg  Stop watching Add 500-Piece Puzzle: Night Garden to Wish List Share Copy |
| F21 | PASS | no-JS save address → addresses row for the guest session | status 200, Location -, msg pt&gt; Add a new address Address saved |
| F22 | PASS | no-JS contact message → contact_messages row, reference shown in the response HTML | status 200, reference C-30YMFGXY, in HTML true |
| F23 | PASS | cookie-less PDP GET writes no product_views row; GET with a session records the view server-side (ViewTracker beacon itself needs JS) | rows 13 → 13 after cookie-less GET; session row 1 |
| XSS01 | PASS | list name on /lists/&lt;id&gt;: posted "&lt;script&gt;alert(1)&lt;/script&gt;" appears escaped (&amp;lt;script&amp;gt;), never raw | escaped true, raw false |
| XSS02 | PASS | review title/body/display name + question on the PDP (cookie-less visitor): posted "&lt;script&gt;alert(1)&lt;/script&gt;" appears escaped (&amp;lt;script&amp;gt;), never raw | escaped true, raw false |
| XSS03 | PASS | address label on /account/addresses: posted "&lt;script&gt;alert(1)&lt;/script&gt;" appears escaped (&amp;lt;script&amp;gt;), never raw | escaped true, raw false |
| XSS04 | PASS | contact response never echoes the raw &lt;script&gt; string | raw false, escaped false (message body is not necessarily echoed) |
| ISO01 | PASS | another session's GET /lists/&lt;id&gt; → 404, no list content | status 404, name leaked false |
| ISO02 | PASS | cookie-less GET /lists/&lt;id&gt; → 404 | status 404 |
| ISO03 | PASS | another session's /lists does not show the list | status 200, Location - |
| ISO04 | PASS | another session's /account/addresses does not show the saved address | status 200, leaked false |
| ISO05 | PASS | another session: foreign order 404, invoice 404, not in /orders | order 404, invoice 404, listed false, name leaked false |
| H01 | PASS | 32 hostile /search?q= queries (FTS operators, quotes, control chars, 5,000 chars, SQL, script) never 500 and never echo raw &lt;script&gt; | all &lt; 500 |
| H02 | PASS | 20 hostile /api/search/suggest?q= queries never 500 | all &lt; 500 |
| RL04 | PASS | reviews: 6 submissions from one session in an hour → 5 stored, the 6th refused with a rate-limit message (no 500) | statuses 200,200,200,200,200,200, stored 5, 6th msg sted several reviews recently Try again in 33 minutes |
| RL05 | PASS | contact: 4 messages from one session in an hour → 3 stored, the 4th refused with a rate-limit message (no 500) | statuses 200,200,200,200, stored 3, 4th msg eral messages recently Please try again in 33 minutes |
| ACC01 | PASS | no-JS sign-up → 303 to /account, users row, sf_auth cookie set | status 303, Location /account, sf_auth set true |
| ACC02 | PASS | Set-Cookie sf_auth: HttpOnly, SameSite=Lax, Path=/ | sf_auth=&lt;token&gt;; Path=/; Expires=Tue, 08 Dec 2026 11:27:49 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax |
| ACC03 | INFO | sf_auth attributes beyond the criteria (Secure on http://localhost, Max-Age) | sf_auth=&lt;token&gt;; Path=/; Expires=Tue, 08 Dec 2026 11:27:49 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax |
| ACC04 | PASS | stored password hash is argon2id (sanity, read from the smoke DB) | prefix $argon2id$ |
| ACC05 | PASS | signed in: order placed, second cart line, review stored under the user's owner key | order /orders/f708b205-c6c1-46fe-ac1e-2dadebc9184e (status 303), cart qty 2, review rows 1 (status 200) |
| ACC06 | PASS | owner key never appears in any response so far (R-1) | owner key 1fc06f34… |
| GC02 | PASS | R-1: GET /cart and / with sf_session = a user's owner key → empty guest state, no Set-Cookie | cart status 200, empty true, user line leaked false, Set-Cookie 0 |
| ACC07 | PASS | no-JS sign-out: Set-Cookie sf_auth with Max-Age=0 (or epoch Expires), sf_session rotated | status 303, Location /, sf_auth "sf_auth=&lt;v&gt;; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax" |
| ACC08 | PASS | after sign-out jar 1 is a guest: /cart does not show the user's cart, /account/settings redirects to /signin | user line shown false |
| ACC09 | PASS | no-JS sign-in on jar 2 → 303, sf_auth set | status 303, Location /account |
| ACC10 | PASS | jar 2: cart (2 × second item), order history (the order) and review (contributions) intact | cart has item true, order listed true, review in contributions true |
| ACC11 | PASS | signed-in /account/settings 200, one h1, noindex | status 200, h1 1, robots "noindex, nofollow" |
| FM08 | PASS | /account/settings: all 5 POST forms are real no-JS forms | 0 bad |
| GC03 | PASS | signed-in GET of 36 routes: no Set-Cookie | none |
| GC04 | PASS | GET with a revoked sf_auth (jar 1 after sign-out-everywhere): treated as signed out, no Set-Cookie (read paths never clear cookies, R-8) | none |
| ACC12 | PASS | sign-out-everywhere on jar 2 → jar 1's session revoked (/account/settings redirects to /signin), jar 2 signed out too (R-2) | jar1 before 200, POST 303 (Set-Cookie sf_session(set),sf_auth(cleared)), jar1 after 307 → /signin?next=%2Faccount%2Fsettings, jar2 after 307; revoked rows 3 |
| ACC13 | PASS | wrong password vs unknown email: same status, same visible HTML text (email masked), same Set-Cookie names, message 'Email or password is incorrect' | statuses 200/200, same text true, cookies [sf_session] / [sf_session] |
| ACC14 | INFO | wrong-password vs unknown-email timing (server-side dummy argon2 verify) | 98 ms vs 101 ms |
| ACC15 | PASS | 11th rapid wrong-password attempt → 'Too many attempts. Try again in N minutes.'; correct password also refused while locked; no sf_auth issued | sequence INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,TOO_MANY,TOO_MANY; correct-password attempt: Too many attempts. Try again in 3 minutes. |
| ACC16 | PASS | unknown email: the same 11-attempt sequence is indistinguishable (R-10) | known INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,TOO_MANY,TOO_MANY \| unknown INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,TOO_MANY,TOO_MANY |
| ACC17 | PASS | /signin, /signup, /account/settings carry noindex (AC 12; sitemap exclusion in SEO05) | signin "noindex, nofollow", signup "noindex, nofollow", settings "noindex, nofollow" |
| ACC18 | PASS | sign-in with ?next=//evil.example/ never redirects off-site | status 303, Location /account |
| RL01 | PASS | /api/search/suggest?q=lam → 200 application/json, parses, no Set-Cookie | status 200, type application/json; charset=utf-8, body {"suggestions":[{"type":"product","label":"Lambswool Crew Jumper","href":"/products/lambswool-crew-jumper"},{"type":"pro |
| RL02 | PASS | POST /api/search/suggest → 405 | status 405 |
| RL03 | PASS | suggest rate limit: 429 after 120 requests/min for one session (Retry-After header) | first 429 at request 121, Retry-After "8", statuses 200/429 |
| BR01 | PASS | no retailer/payment/social/membership/newsletter/app/copied-copy words in served text + aria-label/alt/title/placeholder of 25 pages (words built at run time, 38 patterns) | clean |
| BR02 | FAIL | "Northwind Goods" in the &lt;title&gt; of every page | home guest "Deals, best sellers and new arrivals" \| home signed in "Deals, best sellers and new arrivals" |
| BR03 | PASS | header wordmark is a text link to "/" reading "Northwind Goods" (no image) on every page | ok |
| BR04 | PASS | footer text carries "Northwind Goods" and "© 2026", never "Storefront", on every page | ok |
| BR05 | PASS | JSON-LD Organization + WebSite name = "Northwind Goods" (home) | Organization: Northwind Goods, WebSite: Northwind Goods |
| BR06 | PASS | manifest name "Northwind Goods", short_name starts "Northwind", og:site_name "Northwind Goods" | name Northwind Goods, short_name Northwind, og:site_name Northwind Goods |
| LT01 | PASS | no dark-variant class, no prefers-color-scheme, no data-theme, color-scheme meta absent or light: whole served body (incl. RSC payload) of 25 pages | clean |
| LT02 | PASS | exactly one &lt;meta name=theme-color&gt; per page and it equals the primary raw value (--accent in globals.css, read at run time) | all pages: the --accent value (7 chars) |
| LT03 | PASS | no theme toggle (no button/link/input named theme / dark mode / light mode) | none |
| LT04 | PASS | served CSS (1 file, 49.8 KiB): every color-scheme declaration is "light" and at least one exists; no prefers-color-scheme, data-theme, dark selectors | color-scheme values [light]; no dark selectors |
| LT05 | INFO | lightningcss helper variables in the built CSS (emitted by the CSS minifier for color-scheme: light; not a dark theme) | --lightningcss-light:initial; --lightningcss-dark: ; |
| ST01 | PASS | global rows on 25 pages: one banner &lt;header&gt; with nav "Primary" + role=search "Site search" (GET /search), one &lt;footer&gt; with "Footer: Quick links" + &gt;= 4 "Footer: *" navs, skip link "#main" first focusable, every nav named and unique, one h1 that is the first heading in &lt;main&gt;, no skipped heading level in &lt;main&gt; | all pages |
| ST02 | PASS | home (guest): section ids in contract order (H-order: hero first … services; no recently-viewed without an owner key) | [home-hero, home-categories, home-shipping-promo, home-discovery, home-lifestyle-banner, top-picks, home-lifestyle-cards, home-lifestyle-make-room, home-popular-searches, home-promo-pair, home-brands, home-services] |
| ST03 | PASS | home (signed in, after one PDP view): the same order with #home-recently-viewed between the promo pair and the brands | signed in true; [home-hero, home-categories, home-shipping-promo, home-discovery, home-lifestyle-banner, top-picks, home-lifestyle-cards, home-lifestyle-make-room, home-popular-searches, home-promo-pair, home-recently-viewed, home-brands, home-services] |
| ST04 | PASS | home hero: role=region + aria-roledescription=carousel + name; one h1 (first heading in main) in #home-hero; slides "n of 3"; dot links #slide-1..3 each with a matching id, exactly one aria-current; first image eager, the rest lazy | name "Featured offers", h1 "Everyday essentials, all in one place", slides [slide-1=1 of 3, slide-2=2 of 3, slide-3=3 of 3], dots [slide-1,slide-2,slide-3], img loading [eager,lazy,lazy] |
| ST05 | PASS | home top-picks tabs: nav "Top picks lists" with 4 links in order Best sellers / Deals / New arrivals / Top rated → /?rail=…#top-picks, exactly one aria-current="page", no role=tab | Best sellers→/?rail=best-sellers#top-picks, Deals→/?rail=deals#top-picks, New arrivals→/?rail=new-arrivals#top-picks, Top rated→/?rail=top-rated#top-picks; current /?rail=best-sellers#top-picks |
| ST06 | PASS | home popular searches: named nav, 1–12 links to /search?q=&lt;term&gt; | 12 links, e.g. /search?q=headphones /search?q=desk /search?q=coffee |
| ST07 | PASS | home promo pair links /new-arrivals + /top-rated; services band links /orders /returns /shipping /help /faq /contact; no email input on home (no newsletter) | pair new true top true; services [/returns /orders /shipping /help /faq /contact]; email input false |
| ST08 | PASS | home canonical is / for / and /?rail=deals (H-22) | canonical http://localhost:3000 |
| ST09 | PASS | home signed in: header greets the user ("Phase Three") and has no "Sign in" link; guest header links /signin | signed in true; header text "Northwind Goods Search products Hello, Phase Three, Account &amp; Lists Hello, Phase Three Account &amp; Lists Account menu Your" |
| ST10 | PASS | listing template on /products, /category/&lt;dept&gt;, /brand/&lt;slug&gt;, /search?q=desk, /deals, /new-arrivals: breadcrumb first, h1#listing-title, result count, closed details[data-filter-panel] with summary "Filter" + GET form + Apply, sort select after it, no aside outside the panel, cards = one /products link (nothing interactive inside) + sibling quick-add form (productId, quantity=1, no price), feedback h2 + "Give feedback" → /contact?topic=feedback | ok (6 pages) |
| ST11 | PASS | promo tiles: /products page 1 has 1–3 promo &lt;li&gt; in the grid list at li positions 3/10/17 (never last), each with one link and no h1/h2; page 2 and a faceted page have none | page 1: 3 promos at [3,10,17] of 27 li; page 2: 0 of 24; ?brand=: 0 of 12; one link each true |
| ST12 | PASS | /products pagination: nav "Listing pages", current page aria-current="page", rel=next link | nav true, current true, rel=next true |
| ST13 | PASS | /search?q=desk: h1 "Showing results for “desk”", chips nav named "Related searches" with 1–12 links to /search?q=… (never the current query) | h1 "Showing results for “desk”", chips nav true, 7 chips: /search?q=Office /search?q=Electronics /search?q=Lumen%20%26%20Co. /search?q=Inkwell%20Studio |
| ST14 | PASS | /search?q=zzzzzz (zero results): 200, popular-search chips nav, feedback block still rendered, noindex | status 200, navs [Primary\|Breadcrumb\|Popular searches\|Shop by department\|Footer: Quick links\|Footer: Help\|Footer: Orders &amp; delivery\|Footer: About\|Footer: Legal] |
| ST15 | PASS | /contact?topic=feedback preselects the "feedback" topic (L-21) | status 200, selected &lt;option value="feedback" selected=""&gt; |
| ST16 | PASS | PDP title block (data-testid="pdp-title-block": h1 product name, brand link /brand/&lt;slug&gt;, rating link #reviews) and buy box with data-sticky + lg:sticky lg:top-*; DOM order gallery → title block → buy box; breadcrumb first | title block true, h1 "1000-Piece Puzzle: Coastal Village", brand link true, #reviews true, buy box sticky classes [lg:sticky lg:top-4], data-sticky true, order gallery 2467 &lt; title 4711 &lt; buy 6622 |
| ST17 | PASS | PDP rails (section#rail-*): &gt;= 1, each with an h2 and quick-add forms, none links the current product | rails [rail-related, rail-also-bought, rail-also-viewed], bad [] |
| ST18 | PASS | PDP buy box price for a discounted product: "Was $X" in &lt;s&gt; and "Save $Y (Z%)" (P-6) | "$21.99 $ 21 99 Was $27.99 Save $6.00 (21%) Save with code FREESHIP : Free shipping on orders of $20.00 or more" |
| NJ3-01 | PASS | quick add from a /products card (multipart replay: $ACTION_* + productId + quantity=1) → 200, "Added 1 to your cart." in the server HTML, cart_items row qty 1, line on /cart | status 200, product prod_brass-desk-lamp, DB qty 1, fields [$ACTION_REF_n,$ACTION_n:n,$ACTION_n:n,$ACTION_KEY,productId,quantity] |
| NJ3-02 | PASS | quick add from the home top-picks rail ("+ Add" compact card, multipart replay to /) → cart_items row qty 1 | status 200, product prod_1000-piece-puzzle-coast, DB qty 1 |
| NJ3-03 | PASS | filter form GET (from /products?sort=price_asc, one brand ticked) keeps sort: 200, query has sort=price_asc, sort select still price_asc, summary "Filter 1", no promo tiles | query ?sort=price_asc&amp;rating=&amp;min=&amp;max=&amp;brand=driftwood-pine, status 200, selected price_asc, summary "Filter 1", promos 0 |
| NJ3-04 | PASS | sort form GET (price_desc) → 200, first 4 cards in non-increasing price | status 200, prices [1250, 399, 349, 299] |
| NJ3-05 | PASS | hero dot "Slide 2 of 3" is a plain anchor href="#slide-2" whose target id="slide-2" is in the same server HTML (no JS needed to move the slide) | anchor true, target true |
| NJ3-06 | PASS | ?rail= tab links work without JS: /?rail=deals, new-arrivals, top-rated each 200 with aria-current on that tab and a different product set; canonical stays /; hostile values (x, empty, __proto__, 500 chars, repeated) → 200 with the default tab | default /?rail=best-sellers#top-picks; deals /?rail=deals#top-picks (12 cards), new /?rail=new-arrivals#top-picks, top /?rail=top-rated#top-picks; canonical /; hostile [200:best-sellers 200:best-sellers 200:best-sellers 200:best-sellers 200:best-sellers] |
| NJ3-07 | PASS | cookies disabled (no Cookie header ever sent): search GET 200 with results; tab link 200; quick-add POST 200 with "Added 1 to your cart."; sign-in POST with the right password → 303 /account, wrong password → 200 "Email or password is incorrect"; the next GET /account is the guest view (no session without cookies) | search 200, tab 200, quick add 200 added true, sign-in 303 → /account, wrong 200, /account after: guest true |
| SD01 | PASS | seed: 125 products in the DB (123 published + 2 future-dated); /sitemap.xml lists exactly the 123 published PDPs and none of the future-dated ones | 190 URLs: 123 PDPs + 67 other routes; future-dated in sitemap [] |
| SD02 | PASS | future-dated products (neroli-eau-de-toilette, smart-thermostat) → 404 on their PDP | 404,404 |
| SD03 | PASS | /new-arrivals: every product card on page 1 carries a "New" badge | 24/24 cards with "New"; result line "1–24 of 123 results" |
| SD04 | PASS | /deals lists at least 40 deals | 43 results |
| SD05 | PASS | out-of-stock PDP (night-garden-500-piece-puzzle): "Out of stock", "Notify me when available" form, no add-to-cart form for this product, no visible quantity input | status 200, notify true, own add-to-cart forms 0, visible quantity inputs 0 |
| LD3-01 | PASS | JSON-LD parses and has the expected types: home (Organization, WebSite, ItemList), PDP (Product, BreadcrumbList), /products (ItemList), category (ItemList, BreadcrumbList), brand (ItemList), FAQ (FAQPage) | ok |
| LD3-02 | PASS | every JSON-LD block on the 25 Phase 3 pages parses | ok |
| GC3-01 | PASS | no Set-Cookie on any of the 25 Phase 3 page GETs (guest, signed-in and filled-cart jars) | none |
| GC3-02 | PASS | no Set-Cookie on the 14 replayed GETs (tabs, hostile rail values, filter/sort form submits, sitemap) | none |
| SZ | INFO | home: served HTML size, RSC/inline script share, JS chunks referenced, TTFB | 240.0 KiB HTML (59% inline &lt;script&gt;), 11 JS files = 640.2 KiB, 9 ms |
| SZ | INFO | home signed in: served HTML size, RSC/inline script share, JS chunks referenced, TTFB | 255.5 KiB HTML (58% inline &lt;script&gt;), 11 JS files = 640.2 KiB, 10 ms |
| SZ | INFO | /products: served HTML size, RSC/inline script share, JS chunks referenced, TTFB | 381.7 KiB HTML (51% inline &lt;script&gt;), 11 JS files = 647.7 KiB, 14 ms |
| SZ | INFO | /category/beauty-personal-care: served HTML size, RSC/inline script share, JS chunks referenced, TTFB | 269.8 KiB HTML (55% inline &lt;script&gt;), 11 JS files = 649.8 KiB, 11 ms |
| SZ | INFO | /search?q=desk: served HTML size, RSC/inline script share, JS chunks referenced, TTFB | 228.9 KiB HTML (54% inline &lt;script&gt;), 11 JS files = 647.7 KiB, 20 ms |
| SZ | INFO | PDP 1000-piece-puzzle-coast: served HTML size, RSC/inline script share, JS chunks referenced, TTFB | 551.0 KiB HTML (47% inline &lt;script&gt;), 12 JS files = 696.5 KiB, 22 ms |
| SZ | INFO | /cart (filled): served HTML size, RSC/inline script share, JS chunks referenced, TTFB | 194.9 KiB HTML (58% inline &lt;script&gt;), 11 JS files = 677.2 KiB, 10 ms |
| SZ | INFO | /checkout (filled): served HTML size, RSC/inline script share, JS chunks referenced, TTFB | 107.4 KiB HTML (56% inline &lt;script&gt;), 11 JS files = 679.9 KiB, 5 ms |
| XSS05 | PASS | no response of the whole run contains the raw "&lt;script&gt;alert(1)" (596 responses) | clean |
| FM07 | PASS | no form with action="javascript:…" in any of 596 responses of the run | clean |
| LOG | PASS | server log has no error lines during the run | clean |
| LOG2-01 | PASS | server log: no unstable-value / prerender warnings | clean |
| LOG2-02 | PASS | server log: no unhandled errors / exceptions / SQLite errors | clean |
| LOG2-03 | PASS | server log: no $argon2 hash, sf_auth token, password, card number or email address | argon2 false, tokens 0, passwords 0, cards [], emails [] |
| LOG2-04 | INFO | server log size and line count | 173 bytes, 7 lines; first lines: $ bun --bun next start / ▲ Next.js 16.4.5 / - Local: http://localhost:3105 / - Network: http://192.168.0.159:3105 |
| LOG2-05 | PASS | no sf_auth token (outside Set-Cookie) or $argon2 hash in any response body/Location | tokens 0, argon2 in [] |
| TEARDOWN | PASS | server stopped by PID (38022, 38023, 38024), port 3105 free |  |
| TEARDOWN | PASS | smoke DB files deleted | data/: storefront.sqlite, .gitkeep, storefront.sqlite-shm, storefront.sqlite-wal |
