# Phase 2 production build gate + HTTP smoke — 2026-11-07 (T113)

Run by the QA agent. This was the only task that ran `bun run build` (once) and `bun run start` (the smoke script starts and stops it).
Script: `tests/e2e/http-smoke.ts` (MVP checks) + `tests/e2e/_phase2.ts` (Phase 2 sections) + `tests/e2e/_lib.ts` (shared helpers).
DB: dedicated `./data/smoke.sqlite`, re-seeded on every run and deleted at teardown. `./data/storefront.sqlite` was never touched.

**Verdict: FAIL, but only on two minor defects (D-T113-1, D-T113-2).** The build passes. All 61 MVP checks pass. Every numbered T113 criterion (1–12) is met; the details are below. The two failures are checks from the "T113 list" (handed over by T104a/T104b), not numbered criteria.

## 1. Build gate (criterion 1)

`bun run build` (`bun --bun next build`, Next.js 16.4.5 Turbopack), run once. Exit 0. Compile 1.8 s, TypeScript 12.4 s, static generation of 38 entries in 197 ms on 9 workers (all page routes still ƒ). Wall time 15.9 s, max RSS 2.68 GB.

| Kind | Routes |
|---|---|
| ƒ Dynamic (42) | `/`, `/_not-found`, `/about`, `/accessibility`, `/account`, `/account/addresses`, `/account/alerts`, `/account/contributions`, `/account/history`, `/account/messages`, `/account/settings`, `/api/search/suggest`, `/best-sellers`, `/brand/[slug]`, `/brands`, `/cart`, `/category/[slug]`, `/checkout`, `/compare`, `/contact`, `/deals`, `/faq`, `/help`, `/help/[topic]`, `/lists`, `/lists/[id]`, `/lists/shared/[token]`, `/new-arrivals`, `/orders`, `/orders/[id]`, `/orders/[id]/invoice`, `/privacy`, `/products`, `/products/[slug]`, `/returns`, `/search`, `/shipping`, `/signin`, `/signup`, `/sitemap.xml`, `/terms`, `/top-rated` |
| ○ Static (2) | `/manifest.webmanifest`, `/robots.txt`: metadata routes with no request, cookie or DB input. Prerendering them is correct; the Sitemap URL in robots comes from `NEXT_PUBLIC_SITE_URL`, which is inlined at build time anyway |

- Every page route is dynamic. The PPR-off decision holds: no ◐ partial prerender, and no prerendered page routes.
- `data/` after the build contains only `.gitkeep`. The build prerender opened no database.
- Sizes: Next 16.4 no longer prints per-route size columns, so they were measured from the build output and the served HTML. `.next/static` is 1.4 MB: 37 JS chunks totalling 1,137 KiB (largest 224 / 166 / 110 / 41 / 39 KiB) and 45.5 KiB of CSS. `.next/server` is 18 MB. Served HTML per route (cookie-less, run 3) is in the table below. Home (295 KiB) and the PDP (339 KiB) are heavy because the RSC payload repeats the markup (INFO, not a defect).

| Route | HTML | TTFB | Route | HTML | TTFB |
|---|---|---|---|---|---|
| `/` | 294.8 KiB | 18 ms | `/faq` | 233.3 KiB | 7 ms |
| `/products` | 259.9 KiB | 19 ms | `/contact` | 72.6 KiB | 7 ms |
| `/deals` | 220.4 KiB | 11 ms | `/about` … `/accessibility` | 69–82 KiB | 5–12 ms |
| `/best-sellers` | 266.9 KiB | 12 ms | `/cart` | 80.9 KiB | 5 ms |
| `/new-arrivals` | 254.5 KiB | 11 ms | `/checkout` | 65.2 KiB | 4 ms |
| `/top-rated` | 260.2 KiB | 12 ms | `/compare` | 65.3 KiB | 6 ms |
| `/brands` | 80.3 KiB | 6 ms | `/lists` | 67.6 KiB | 7 ms |
| `/brand/<slug>` | 118.6 KiB | 9 ms | `/orders` | 70.8 KiB | 5 ms |
| `/category/<top>` | 135.8 KiB | 10 ms | `/account` | 85.4 KiB | 6 ms |
| `/category/<sub>` | 108.3 KiB | 7 ms | `/account/*` (5) | 68–76 KiB | 5–8 ms |
| `/products/<slug>` | 338.6 KiB | 16 ms | `/signin` / `/signup` | 66.9 / 67.8 KiB | 8 / 6 ms |
| `/search?q=lamp` | 98.3 KiB | 9 ms | `/help`, `/help/<topic>` | 89.5 / 84.0 KiB | 6 ms |

## 2. Smoke run

`bun run tests/e2e/http-smoke.ts` after the build. Runs 3 and 4 gave identical results (runs 1–2 were script debugging). Run 4:

**199 PASS / 2 FAIL / 10 INFO**, 540 HTTP responses, 9.0 s wall time. Teardown was clean: the server process tree was stopped by PID, port 3105 was free afterwards, `smoke.sqlite*` was deleted, `data/` = `.gitkeep`, and `ps` showed no leftover `next start`.

| Section | PASS | FAIL | INFO | Time |
|---|---|---|---|---|
| MVP (the 61 original checks + 6 INFO) | 61 | 0 | 6 | rest of the 9.0 s (incl. seed + server start) |
| P / GC public routes + no Set-Cookie on GET | 38 | 0 | 0 | 0.4 s |
| N real 404s | 11 | 1 | 0 | 0.1 s |
| SEO sitemap / robots / manifest / head / JSON-LD | 17 | 1 | 1 | 0.4 s |
| FM real POST forms | 7 | 0 | 0 | <0.1 s |
| F no-JS flows | 24 | 0 | 0 | 0.7 s |
| XSS escaping | 5 | 0 | 0 | <0.1 s |
| ISO two-jar isolation | 5 | 0 | 0 | 0.1 s |
| H hostile search | 2 | 0 | 0 | 0.4 s |
| RL rate limits (reviews, contact, suggest) | 5 | 0 | 0 | 0.5 s |
| ACC accounts (+ GC02–GC04, FM08) | 20 | 0 | 2 | 3.7 s |
| LOG2 server-log leak scan | 4 | 0 | 1 | — |

TTFB (run 4): `/` cold 203 ms, warm median 13.7 ms. PDP cold 47 ms, warm median 19.1 ms. MVP run was ~6 / 4 ms warm; the Phase 2 pages do more reads per render.

## 3. Acceptance criteria

| # | Criterion | Result | Evidence (check ids) |
|---|---|---|---|
| 1 | build passes; routes dynamic; `data/` clean | PASS | section 1 |
| 2 | 61 MVP checks pass | PASS | MVP 61/0. 5 expectations were updated to accepted rulings (section 5) |
| 3 | every public route 200 + one `<h1>` + one `<title>`; unknown product/category/brand/list/order slugs → real 404 | PASS | P01–P35 (35 routes), P40 + ACC11 (`/account/settings` guest 307 → `/signin?next=%2Faccount%2Fsettings`, signed in 200), N01–N11 (all status 404, noindex, no Set-Cookie). See D-T113-1 for the 404 body |
| 4 | no-JS multipart flows | PASS | F01 add, F02 save for later, F03 move to cart, F04/F05 coupon, F06 shipping, F12 Buy Now, F07/F08 checkout with SAVE5 → `303 /orders/<id>?placed=1`, F11 cancel, F13/F14/F15 list create/add/remove, F16/F17/F17b review + duplicate rejected, F18 vote, F19 question, F20 stock alert, F21 address, F22 contact (reference shown in HTML) |
| 5 | sitemap/robots/manifest content types; 20 sitemap URLs 200; noindex on private routes | PASS | SEO01–SEO05, SEO07 (robots: `/signin` `/signup` `/contact` allowed; `/search` `/account` blocked), SEO08 (15 private routes noindex), SEO09–SEO12 |
| 6 | PDP JSON-LD and listing ItemList parsed | PASS | SEO14 (Product + BreadcrumbList, offers), SEO15 (ItemList 24 positions), SEO13 (layout Organization + WebSite/SearchAction), SEO16 (FAQPage 38 Q), SEO17/SEO18 (no duplication of the layout graph) |
| 7 | 30 hostile queries never 500; suggest JSON + 429 | PASS | H01 (32 queries incl. FTS operators, NUL/control chars, 5,000 chars, SQL, script), H02 (20 on suggest), RL01 (JSON, no Set-Cookie), RL02 (POST 405), RL03 (first 429 at request 121, Retry-After 16) |
| 8 | rate limits over HTTP for reviews + contact; isolation for lists, addresses, orders | PASS | RL04 (6th review refused, 5 stored), RL05 (4th contact refused, 3 stored), ISO01–ISO05 (foreign list/order/invoice 404, nothing listed or leaked) |
| 9 | posted `<script>` escaped | PASS | XSS01 list name, XSS02 review + question on the PDP, XSS03 address label, XSS04 contact, XSS05 none of the 540 responses contains the raw string |
| 10 | server log scan; clean teardown | PASS | LOG, LOG2-01 (no unstable-value warnings), LOG2-02 (no unhandled errors), LOG2-03 (no `$argon2`, token, password, card or email), LOG2-05 (no token/hash in any body), TEARDOWN ×2 |
| 11 | report with PASS/FAIL/INFO table | PASS | this file |
| 12 | accounts journey on two jars; indistinguishable failures; lockout; cookie flags; sign-out-everywhere; noindex + not in sitemap; guest settings redirect | PASS | ACC01 sign-up 303; ACC02 `sf_auth` HttpOnly + SameSite=Lax + Path=/; ACC05 cart + order + review signed in; ACC07 sign-out `Max-Age=0` + `sf_session` rotated; ACC09/ACC10 jar 2 sees the cart line, order and review; ACC12 sign-out-everywhere on jar 2 → jar 1 redirected to `/signin`; ACC13 wrong password = unknown email (status, visible text, cookie names); ACC15 attempt 11 → "Too many attempts. Try again in N minutes.", correct password refused while locked; ACC16 same sequence for an unknown email; ACC17 + SEO05; P40; LOG2-03 |

Extra checks beyond the criteria (all PASS): GC01 no Set-Cookie on cookie-less GETs of 36 routes; GC02 R-1 (`sf_session` = an owner key → empty guest state, no Set-Cookie, no leak); GC03 signed-in GETs set no cookies; GC04 a revoked `sf_auth` is ignored on read paths without clearing cookies (R-8); ACC06 the owner key never appears in any response; ACC18 `?next=//evil.example/` → `/account`; FM01–FM08 every audited form is a real POST multipart form with `$ACTION_*` fields; FM07 no `action="javascript:…"` in any response; F23 a cookie-less PDP GET writes no `product_views` row, while a session's GET records the view server-side; SEO20 `<link rel=prev/next>` on page 2.

## 4. Defects

### D-T113-1 (minor): in-page `notFound()` serves an empty error-shell document. The not-found page is visible only with JavaScript
- **Routes:** `/products/<unknown>`, `/category/<unknown>`, `/brand/<unknown>`, `/lists/<unknown or foreign>`, `/lists/shared/<bad>`, `/orders/<unknown, foreign or malformed>`, `/orders/<id>/invoice`, `/help/<unknown>`.
- **Repro:** `bun run build`, start the server, then `curl -s -o - -w '%{http_code}' http://localhost:<port>/products/no-such-product-xyz`.
- **Expected:** a 404 status (met) with the T103 not-found page in the served HTML: one `<h1>Page not found</h1>`, search box, helpful/department links, header/footer. An unmatched URL such as `/definitely-not-a-route` already gets exactly this.
- **Actual:** status 404 and `<meta name="robots" content="noindex">`, but the document is `<html id="__next_error__"><head>…</head><body></body></html>` plus scripts. There is no `<h1>`, no `<main>` and no navigation; the only text is the `<title>` "Page not found | Northwind Goods". The page renders only after JS boots the client router. JS-disabled visitors and no-JS agents see a blank page.
- **Evidence:** smoke N12 FAIL: "11/11 in-page 404s serve the empty `<html id="__next_error__">` shell … unmatched URL: h1 1, error shell false". In N01–N11 the detail reads "h1 0, error shell". Cause: Next 16.4 `node_modules/next/dist/server/app-render/app-render.js` ~L2490–2541 and `getErrorRSCPayload` L1321–1335 (`initialTree.d = { r: errorShell }`). A `notFound()` that escapes the SSR shell is served as the empty error shell. Here nothing catches it during SSR, because there is no Suspense boundary above the pages (the root `loading.tsx` was removed to fix the soft 404s). The pages throw in the page body (`src/app/products/[slug]/page.tsx:82`, `category/[slug]/page.tsx:34`, `help/[topic]/page.tsx:47`, `lists/[id]/page.tsx:52`, `orders/[id]/page.tsx:99,102`).
- **Violates:** no numbered T113 criterion (criterion 3 asserts the status, which passes). It does violate the T104a T113-list item "real 404 … no-JS" and the intent of T103 (Not-found page v2: search box + helpful links) together with the 2026-11-06 PPR decision rationale ("content visible without JS").
- **Note for the fix owner:** the fix must keep the real 404 status (the soft-404 lesson). Do not re-add a root `loading.tsx`. Re-run N01–N12 after any change.

### D-T113-2 (minor): the header search landmark has no accessible name, so pages with a second search landmark have two indistinguishable `role="search"` regions
- **Routes:** `/help` (header search + help search "Help") and `/orders` (header search + "Search orders"). The unmatched-URL 404 page also has two search fields (T103 note "ay").
- **Repro:** `curl -s http://localhost:<port>/help | grep -o '<form[^>]*role="search"[^>]*>'`
- **Expected:** every `role="search"` landmark has a unique accessible name (`aria-label` / `aria-labelledby`) whenever a page has more than one (axe `landmark-unique`; ARIA landmark guidance).
- **Actual:** `<form id="…-form" role="search" action="/search" method="get">` has no name. The second landmark is named ("Help", "Search orders").
- **Evidence:** smoke SEO19 FAIL: "/help [unnamed | Help], /orders [unnamed | Search orders]". Source: `src/components/atoms/SearchField/SearchField.tsx:244` (`role="search"` without a label), used by the header `SearchBox`.
- **Violates:** T104b T113-list item "two `role=search` landmarks (header + /help)". Accessibility basics (landmark labelling).
- **Suggested owner:** designer-technologist (atoms): a `landmarkLabel` / `aria-label` on SearchField (e.g. "Site search").

## 5. MVP checks whose expectations changed (ids kept), and why

| Id | MVP expectation | Now | Basis |
|---|---|---|---|
| R06 | exactly 15 product links on `/` | at least 15 (30 found) | T96 home v2 (rails) |
| R13 | stock-0 PDP has a disabled "Out of stock" button and no productId form | "Out of stock" text, no quantity input, no Add to cart / Buy Now form, "Notify me when available" form present | T78 BuyBox v2 + T50 stock alerts |
| R17, C13 | `/checkout` with no cookie or an empty cart → 3xx to `/cart` | 200 empty state linking `/cart`, no form, no meta refresh | ruling D-T109-1 (accepted) |
| K03 | order page at `/orders/<id>` shows "Thank you for your order" | the redirect `Location` (with `?placed=1`) is fetched; the banner shows only with `placed=1` | FIX-checkout-placed / T110 |
| A11Y (helper) | `<label for>` / `aria-*` only | controls wrapped in a `<label>` also count as labelled (the review form's star radios) | heuristic fix; the HTML was correct |

Script fix worth knowing for future replays: React renders a `formAction` button's hidden `$ACTION_n:*` inputs inside the `<button>` element. A browser still submits them. The serializer in `_lib.ts` therefore walks button content (Buy Now returned `400 Invalid Server Actions request` until this was fixed).

## 6. INFO rows and observations (not defects)
- **P40:** guest `/account/settings` → **307** (Next `redirect()` during render). The brief said 302/303; AC 12 only says "redirects to /signin". 307 meets the AC.
- **SEO06:** the sitemap `<loc>` values and the robots `Sitemap:` line use `http://localhost:3000` because `NEXT_PUBLIC_SITE_URL` was unset at build time. Set it before any deployment build. The smoke samples paths against its own origin.
- **ACC03:** `sf_auth` and `sf_session` carry `Secure` even on `http://localhost` (production mode). Browsers accept this on localhost; on any non-HTTPS host the cookies would be dropped.
- **ACC14:** wrong-password vs unknown-email timing ~100–113 ms each (dummy argon2 verify works).
- **SEO19 side note:** the `<header>` inside `<main>` on `/help` is a scoped header, not a banner landmark.
- **S02:** the static "Test mode" card list is still in the production checkout HTML (MVP observation).
- **TTFB / HTML size:** see sections 1–2.

## 7. Could not verify over HTTP (needs a browser; Playwright still unapproved)
- The JS-enabled paths: hydrated forms, `useActionState` pending states, toasts, ViewTracker's client beacon (F23 proves only the server-side half), suggest combobox keyboard use.
- FilterSidebar drawer below `lg`, responsive layout, focus management, live regions, visible focus rings, contrast in rendered pages.
- How D-T113-1's client-rendered not-found page looks once JS runs.

## 8. Full results (run 4)

| ID | Result | Check | Evidence (run 4) |
|---|---|---|---|
| SETUP | PASS | seed ./data/smoke.sqlite | $ bun run src/server/db/seed-cli.ts |
| SETUP | PASS | next start (production) on :3105, pid 64981 |  |
| TTFB | INFO | / cold 203.3 ms, warm median 13.7 ms |  |
| TTFB | INFO | /products/1000-piece-puzzle-coast cold 47.3 ms, warm median 19.1 ms |  |
| R01 | PASS | / status 200 | status 200 |
| R02 | PASS | / exactly one &lt;h1&gt; | h1 count 1 |
| R03 | PASS | / exactly one &lt;main id="main"&gt; (and one &lt;main&gt;) | main id=main 1, &lt;main 1 |
| R04 | PASS | / skip link href="#main" |  |
| R05 | PASS | / &lt;html lang="en"&gt; and viewport meta |  |
| R06 | PASS | / at least 15 distinct product links (MVP: exactly 15; home v2 has rails) | 30 distinct /products/* hrefs |
| R07 | PASS | / every &lt;img&gt; has alt= | 36 imgs, 0 without alt |
| R08 | PASS | /products/1000-piece-puzzle-coast status 200 | status 200 |
| R09 | PASS | PDP one &lt;h1&gt; with the product name | h1 count 1, text "1000-Piece Puzzle: Coastal Village" |
| R10 | PASS | PDP &lt;title&gt; contains the name | title "1000-Piece Puzzle: Coastal Village \| Northwind Goods" |
| R11 | PASS | PDP has an add-to-cart form (productId + quantity + $ACTION fields) | &lt;form class="flex flex-col gap-3" action="" encType="multipart/form-data" method="POST"&gt; |
| R12 | PASS | /products/ceramic-pour-over (stock 0) status 200 | status 200 |
| R13 | PASS | stock-0 PDP: "Out of stock" shown, no quantity input, no add-to-cart/Buy Now form (v2: "Notify me" form instead) | "Out of stock" true; quantity input false; add-to-cart form false; notify form true |
| R14 | PASS | /products/nope 404 | status 404 |
| R15 | PASS | /products/%27%20OR%201%3D1%20-- 404, no SQL error in server log | status 404, sql error in log: false |
| R16 | PASS | /cart (no cookie) 200, empty state, no checkout link | status 200, empty: true, checkout link: false |
| R17 | PASS | /checkout (no cookie): 200 empty state with a link to /cart, no checkout form, no meta refresh (MVP: 3xx; ruling D-T109-1) | status 200, location null, /cart link true, form false |
| R18 | PASS | /orders/&lt;random uuid&gt; 404 | status 404 |
| R19 | PASS | /orders/not-a-uuid 404 | status 404 |
| R21 | INFO | JS disabled: / page content (h1) is in the static HTML, not only inside PPR-streamed &lt;div hidden&gt; blocks | first &lt;h1&gt; at 12446, first streamed hidden div at -1: h1 in shell |
| R20 | PASS | /definitely-not-a-route 404 with "Page not found" and a link home | status 404, text: true |
| C01 | PASS | no-JS add-to-cart POST (multipart/form-data, $ACTION_* replay) 2xx/3xx | status 200; "Added 2 to your cart." in response: true |
| C02 | PASS | Set-Cookie sf_session=&lt;uuid&gt;; HttpOnly | sf_session=&lt;uuid&gt;; Path=/; Expires=Mon, 07 Dec 2026 11:26:04 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax |
| C03 | PASS | /cart with cookie: 200, quantity 2, line total $43.98, "Proceed to checkout" link | status 200, qty 2, total present true |
| C04 | PASS | / with cookie contains "Cart, 2 items" | streamed count present: true |
| C05 | PASS | POST quantity=999: no 500, inline error, cart unchanged (DB qty 2) | status 200, DB qty 2, message: Please choose a quantity between 1 and 99.&quot;,&quot;details&quot;:{&quot;reason&quot;:&quot;ABOVE_MAX&quot;,&quot;max&quot;:99}}}] |
| C06 | PASS | over-stock add (limited-print-no-1, stock 1, qty 2): inline "Only N left" error, no cart line | status 200, DB qty 0 |
| C07 | PASS | /cart after rejected adds still shows exactly the one line, quantity 2 | qty 2, quantity inputs 1 |
| C08 | PASS | garbage sf_session: /cart 200 empty state | status 200 |
| C09 | PASS | garbage sf_session: first add mints a fresh UUID session | new cookie is uuid: true |
| C10 | PASS | no-JS cart update to 3: DB qty 3, line total $135.00 on /cart | status 200, DB qty 3 |
| C11 | PASS | no-JS cart update above stock (61 &gt; 60): no 500, quantity stays 3, error in response | status 200, DB qty 3, message Only 60 left in stock. |
| C12 | PASS | no-JS remove of the last line: empty state, no checkout link | status 200, DB qty 0 |
| C13 | PASS | /checkout with a valid session but empty cart: 200 empty state linking /cart, no form (MVP: redirect; ruling D-T109-1) | status 200, location null, form false, meta refresh false |
| K01 | PASS | /checkout with cookie: 200, hidden idempotencyKey (UUID), all address/card fields | status 200, key uuid true, missing none |
| K02 | PASS | no-JS checkout POST (4242) redirects to /orders/&lt;uuid&gt; (v2: ?placed=1 query) | status 303, Location /orders/ef90371c-d71c-4ecc-b881-ba380dc0dea5?placed=1 |
| K03 | PASS | order page (Location incl. ?placed=1) with cookie: 200, "Thank you for your order", item, "Card ending in 4242", total $43.98 | status 200, thanks true, item true, last4 true, total true |
| K04 | PASS | order page without cookie: 404 | status 404 |
| K05 | PASS | /cart after order: empty state | empty true |
| K06 | PASS | stock decremented by 2 after paid order | before 34, after 32 |
| K07 | PASS | replay same POST (same idempotencyKey): same order URL, orders count still 1, stock unchanged | status 303, Location /orders/ef90371c-d71c-4ecc-b881-ba380dc0dea5?placed=1, orders 1, stock 32 |
| K08 | PASS | decline (4000000000000002, new session, new key): response carries PAYMENT_FAILED + decline message, no redirect | status 200, Location null, message: Your card was declined.&quot;,&quot;details&quot;:{&quot;orderId&quot;:&quot;76669bd5-c2ed-4f14-b5e5-a22949fe0a5c&quot;,&quot;failureCode&quot;:&quot;DECLINED&q |
| K10 | PASS | decline: /cart still has the line | qty 1 |
| K11 | PASS | decline: stock unchanged, no new paid order | stock 60 -&gt; 60, paid orders 1 -&gt; 1 |
| K12 | PASS | order page with another session's cookie: 404 | status 404 |
| K14 | PASS | no existence leak: no-cookie and other-session order responses carry no order data and the same &lt;title&gt; as a random id | no-cookie leaks [], cross-session leaks [], titles "Page not found \| Northwind Goods" / "Page not found \| Northwind Goods" / random "Page not found \| Northwind Goods" |
| K13 | PASS | retry after decline with a fresh key + 4242 succeeds (redirect to a new order) | status 303, Location /orders/04d07869-0162-433b-baaa-996f05f4eb36?placed=1, fresh key true, paid orders 2 |
| K15 | PASS | validation failure (non-Luhn card, blank city): no redirect, VALIDATION_FAILED with per-field errors for number and city | status 200, VALIDATION_FAILED true, card echoed false |
| K16 | PASS | concurrent double submit (same key, Promise.all): both redirect to the same order, exactly one new paid order, stock -1 | statuses 303/303, locations /orders/3bafb030-968d-4405-9500-21a82b3681f7?placed=1 / /orders/3bafb030-968d-4405-9500-21a82b3681f7?placed=1, paid 2 -&gt; 3, stock 59 -&gt; 58 |
| K17 | PASS | last-unit contention (limited-print-no-1, stock 1, two sessions): exactly one order, stock 0, loser gets inline STOCK_CHANGED naming the item OR a 3xx to /cart showing the unavailable warning without a checkout link | statuses 303/200, paid 3 -&gt; 4, stock 0, loser: inline STOCK_CHANGED |
| K18 | INFO | orders table after all flows (incl. payment_failed rows written by declines) | paid 4, payment_failed 1 |
| NJ01 | PASS | no-JS: action results are rendered in the server HTML (not only in the RSC payload applied at hydration) | "Added 2 to your cart.": in HTML; qty 999 error: in HTML; "Only 1 left in stock.": in HTML; "Your card was declined.": in HTML; fullName re-filled: in HTML |
| S01 | PASS | no full card number / CVC in any step 4-5 response (52 responses scanned, static test-card hint excluded) | clean |
| S02 | INFO | static "Test mode" hint lists the mock card numbers in production HTML | 9 responses contain it (fixed list from PaymentFields, not user input) |
| A11Y | PASS | /: one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "Deals, best sellers and new arrivals" |
| A11Y | PASS | /products/1000-piece-puzzle-coast: one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "1000-Piece Puzzle: Coastal Village \| Northwind Goods" |
| A11Y | PASS | /checkout (filled cart): one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "Checkout \| Northwind Goods" |
| A11Y | PASS | /cart (filled): one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "Your cart \| Northwind Goods" |
| A11Y | PASS | order page /orders/ef90371c…: one h1, one main, labelled controls, no outline-none, title | h1 1, main 1, unlabelled [], outline-none false, title "Order (number redacted) \| Northwind Goods" |
| INFO | INFO | add-to-cart replayed as application/x-www-form-urlencoded (form declares multipart) | status 200, Set-Cookie false, "Added" in body false (not treated as an action by Next) |
| P01 | PASS | /: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Everyday essentials, all in one place", title 1 "Deals, best sellers and new arrivals", 294.8 KiB HTML, 13 ms |
| P02 | PASS | /products: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "All products", title 1 "All products \| Northwind Goods", 259.9 KiB HTML, 17 ms |
| P03 | PASS | /deals: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Today's Deals", title 1 "Today's Deals \| Northwind Goods", 220.4 KiB HTML, 12 ms |
| P04 | PASS | /best-sellers: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Best Sellers", title 1 "Best Sellers \| Northwind Goods", 266.9 KiB HTML, 13 ms |
| P05 | PASS | /new-arrivals: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "New Arrivals", title 1 "New Arrivals \| Northwind Goods", 254.5 KiB HTML, 13 ms |
| P06 | PASS | /top-rated: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Top Rated", title 1 "Top Rated \| Northwind Goods", 260.2 KiB HTML, 12 ms |
| P07 | PASS | /brands: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Brands", title 1 "Brands \| Northwind Goods", 80.3 KiB HTML, 7 ms |
| P08 | PASS | /brand/driftwood-pine: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Driftwood & Pine", title 1 "Driftwood & Pine \| Northwind Goods", 118.6 KiB HTML, 9 ms |
| P09 | PASS | /category/beauty-personal-care: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Beauty & Personal Care", title 1 "Beauty & Personal Care \| Northwind Goods", 135.8 KiB HTML, 10 ms |
| P10 | PASS | /category/audio: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Headphones & Audio", title 1 "Headphones & Audio \| Northwind Goods", 108.3 KiB HTML, 7 ms |
| P11 | PASS | /products/1000-piece-puzzle-coast: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "1000-Piece Puzzle: Coastal Village", title 1 "1000-Piece Puzzle: Coastal Village \| Northwind Goods", 338.6 KiB HTML, 17 ms |
| P12 | PASS | /search?q=lamp: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Results for “lamp”", title 1 "Results for “lamp” \| Northwind Goods", 98.3 KiB HTML, 10 ms |
| P13 | PASS | /help: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Help center", title 1 "Help center \| Northwind Goods", 89.5 KiB HTML, 8 ms |
| P14 | PASS | /help/shipping: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Shipping and delivery", title 1 "Shipping and delivery help \| Northwind Goods", 84.0 KiB HTML, 8 ms |
| P15 | PASS | /faq: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Frequently asked questions", title 1 "Frequently asked questions \| Northwind Goods", 233.3 KiB HTML, 8 ms |
| P16 | PASS | /contact: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Contact us", title 1 "Contact us \| Northwind Goods", 72.6 KiB HTML, 15 ms |
| P17 | PASS | /about: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "About Northwind Goods", title 1 "About Northwind Goods \| Northwind Goods", 69.7 KiB HTML, 7 ms |
| P18 | PASS | /shipping: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Shipping policy", title 1 "Shipping policy \| Northwind Goods", 73.7 KiB HTML, 11 ms |
| P19 | PASS | /returns: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Returns and refunds policy", title 1 "Returns and refunds policy \| Northwind Goods", 69.2 KiB HTML, 6 ms |
| P20 | PASS | /privacy: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Privacy notice", title 1 "Privacy notice \| Northwind Goods", 82.3 KiB HTML, 6 ms |
| P21 | PASS | /terms: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Terms of use", title 1 "Terms of use \| Northwind Goods", 74.8 KiB HTML, 6 ms |
| P22 | PASS | /accessibility: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Accessibility statement", title 1 "Accessibility statement \| Northwind Goods", 69.6 KiB HTML, 5 ms |
| P23 | PASS | /cart: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Shopping Cart", title 1 "Your cart \| Northwind Goods", 80.9 KiB HTML, 5 ms |
| P24 | PASS | /checkout: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Checkout", title 1 "Checkout \| Northwind Goods", 65.2 KiB HTML, 4 ms |
| P25 | PASS | /compare: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Compare products", title 1 "Compare products \| Northwind Goods", 65.3 KiB HTML, 6 ms |
| P26 | PASS | /lists: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your lists", title 1 "Your lists \| Northwind Goods", 67.6 KiB HTML, 8 ms |
| P27 | PASS | /orders: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your orders", title 1 "Your Orders \| Northwind Goods", 70.8 KiB HTML, 7 ms |
| P28 | PASS | /account: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your Account", title 1 "Your Account \| Northwind Goods", 85.4 KiB HTML, 6 ms |
| P29 | PASS | /account/addresses: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your addresses", title 1 "Your Addresses \| Northwind Goods", 76.2 KiB HTML, 7 ms |
| P30 | PASS | /account/alerts: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your stock alerts", title 1 "Stock Alerts \| Northwind Goods", 68.2 KiB HTML, 5 ms |
| P31 | PASS | /account/contributions: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your reviews & questions", title 1 "Your Reviews & Questions \| Northwind Goods", 69.0 KiB HTML, 8 ms |
| P32 | PASS | /account/history: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your browsing history", title 1 "Browsing History \| Northwind Goods", 68.1 KiB HTML, 6 ms |
| P33 | PASS | /account/messages: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Your messages", title 1 "Messages \| Northwind Goods", 68.0 KiB HTML, 6 ms |
| P34 | PASS | /signin: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Sign in", title 1 "Sign in \| Northwind Goods", 66.9 KiB HTML, 7 ms |
| P35 | PASS | /signup: 200, exactly one &lt;h1&gt;, one non-empty &lt;title&gt; | status 200, h1 1 "Create account", title 1 "Create account \| Northwind Goods", 67.8 KiB HTML, 6 ms |
| P40 | PASS | guest GET /account/settings → 3xx to /signin?next=%2Faccount%2Fsettings | status 307, Location /signin?next=%2Faccount%2Fsettings (307 = Next redirect() during render; brief said 302/303, AC 12 says 'redirects') |
| GC01 | PASS | no Set-Cookie on cookie-less GET of all 36 routes above | none |
| SEO20 | PASS | /products?page=2: &lt;link rel="prev"&gt; → page 1, &lt;link rel="next"&gt; → page 3, self canonical | status 200, prev /products, next /products?page=3, canonical /products?page=2 |
| N01 | PASS | /products/no-such-product-xyz → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N02 | PASS | /category/no-such-category-xyz → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N03 | PASS | /brand/no-such-brand-xyz → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N04 | PASS | /lists/7a7aa964-cb5a-42d7-9606-47b007e7e986 → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N05 | PASS | /lists/not-a-uuid → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N06 | PASS | /orders/4950ab89-c3c0-424e-aaa4-ce7c33a26101 → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N07 | PASS | /orders/not-a-uuid → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N08 | PASS | /orders/72f2a735-84ff-465f-bfd2-089a3540f2ee/invoice → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N09 | PASS | /help/no-such-topic → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N10 | PASS | /lists/shared/not-a-real-token → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N11 | PASS | /category/%27%20OR%201%3D1%20-- → real 404 status (not a soft 404), noindex, no Set-Cookie | status 404, robots "noindex", Set-Cookie 0, h1 0, error shell |
| N12 | FAIL | 404 body is the not-found page in the served HTML (one &lt;h1&gt; 'Page not found', search box, links) for in-page notFound(), as it is for an unmatched URL | 11/11 in-page 404s serve the empty &lt;html id="__next_error__"&gt; shell (no &lt;h1&gt;, no &lt;main&gt;, title only; content rendered client-side): /products, /category, /brand, /lists, /orders, /help; unmatched URL: h1 1, error shell false |
| SEO01 | PASS | /sitemap.xml 200, XML content type, &lt;urlset&gt; with &lt;loc&gt; entries | status 200, content-type application/xml, 127 URLs |
| SEO02 | PASS | /robots.txt 200, text/plain | status 200, content-type text/plain |
| SEO03 | PASS | /manifest.webmanifest 200, application/manifest+json, parses with name + start_url | status 200, content-type application/manifest+json, parsed true |
| SEO04 | PASS | 20 sampled sitemap URLs return 200 | ok: / /brands /privacy /brand/kestrel-audio /brand/saltmarsh-botanics /category/board-games … |
| SEO05 | PASS | sitemap has no private/noindex routes (/signin, /signup, /account/**, /cart, /orders, /lists, /search, /contact …) | clean (127 URLs; origin http://localhost:3000) |
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
| SEO19 | FAIL | pages with two role=search landmarks (header + /help search) give each a unique accessible name (T104b list) | /help [unnamed \| Help], /orders [unnamed \| Search orders]; /help &lt;header&gt; inside &lt;main&gt;: true (scoped header, not a banner landmark) |
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
| F07 | PASS | no-JS checkout with coupon → 303 /orders/&lt;uuid&gt;?placed=1; order has SAVE5, discount, express, paid | status 303, Location /orders/557f854d-bcca-46b9-8f18-0d88505cb9b3?placed=1, order {"id":"557f854d-bcca-46b9-8f18-0d88505cb9b3","coupon_code":"SAVE5","discount_cents":500,"shipping_method_id":"express","status":"paid"} |
| F08 | PASS | order confirmation (?placed=1) 200 with thank-you banner, SAVE5 discount line and Express | status 200, thanks true, SAVE5 true, Express true |
| F09 | PASS | invoice page 200 for the owner, one h1, noindex | status 200, h1 1, robots "noindex, nofollow" |
| F10 | PASS | /orders lists the new order for its owner | status 200, link present true |
| F11 | PASS | no-JS cancel order (confirm checkbox ticked) → fulfillment_status cancelled, cancelled_at set | status 200, row {"fulfillment_status":"cancelled","cancelled_at":"2026-11-07T11:26:06.614Z"}, buttons [Cancel order] |
| F12 | PASS | no-JS Buy Now (submitter = Buy Now button's $ACTION_REF) → redirect to /checkout, item in cart | status 303, Location /checkout, cart rows 1 |
| F13 | PASS | no-JS create list → 303 /lists/&lt;id&gt;?created=1, lists row | status 303, Location /lists/7ecbd1a4-4c21-4e02-b138-ee08e7c7b032?created=1, row {"id":"7ecbd1a4-4c21-4e02-b138-ee08e7c7b032","name":"Smoke list &lt;script&gt;alert(1)&lt;/script&gt;"} |
| F14 | PASS | no-JS add to list (PDP form, listId = new list) → list_items row | status 200, rows 1 |
| F15 | PASS | no-JS remove from list → list_items row gone | status 200, rows 0 |
| F16 | PASS | no-JS submit review → reviews row (published) | status 200, rows 1, msg none |
| F17b | PASS | stale write-review form replayed (same fields, same session) → rejected: still one row, 'already reviewed' message, no 500 | status 200, rows 1, msg  Helpful (0) You already reviewed this product |
| F17 | PASS | duplicate review on the same product rejected (still one row; DUPLICATE message, or the form is replaced by an 'already reviewed' state) | no write-review form on the second visit; text:  Helpful (0) You already reviewed this product |
| F18 | PASS | no-JS vote helpful on a review → review_votes row, helpful_count +1 | review rev_seed_052_01, count 5 → 6, status 200 |
| F19 | PASS | no-JS ask a question → questions row | status 200 |
| F20 | PASS | no-JS subscribe stock alert (stock-0 PDP) → stock_alerts row | status 200, msg  Stop watching Add Ceramic Pour-Over to Wish List Share Copy link Link to |
| F21 | PASS | no-JS save address → addresses row for the guest session | status 200, Location -, msg pt&gt; Add a new address Address saved |
| F22 | PASS | no-JS contact message → contact_messages row, reference shown in the response HTML | status 200, reference C-SFH8RZ77, in HTML true |
| F23 | PASS | cookie-less PDP GET writes no product_views row; GET with a session records the view server-side (ViewTracker beacon itself needs JS) | rows 13 → 13 after cookie-less GET; session row 1 |
| XSS01 | PASS | list name on /lists/&lt;id&gt;: posted "&lt;script&gt;alert(1)&lt;/script&gt;" appears escaped (&lt;script&gt;), never raw | escaped true, raw false |
| XSS02 | PASS | review title/body/display name + question on the PDP (cookie-less visitor): posted "&lt;script&gt;alert(1)&lt;/script&gt;" appears escaped (&lt;script&gt;), never raw | escaped true, raw false |
| XSS03 | PASS | address label on /account/addresses: posted "&lt;script&gt;alert(1)&lt;/script&gt;" appears escaped (&lt;script&gt;), never raw | escaped true, raw false |
| XSS04 | PASS | contact response never echoes the raw &lt;script&gt; string | raw false, escaped false (message body is not necessarily echoed) |
| ISO01 | PASS | another session's GET /lists/&lt;id&gt; → 404, no list content | status 404, name leaked false |
| ISO02 | PASS | cookie-less GET /lists/&lt;id&gt; → 404 | status 404 |
| ISO03 | PASS | another session's /lists does not show the list | status 200, Location - |
| ISO04 | PASS | another session's /account/addresses does not show the saved address | status 200, leaked false |
| ISO05 | PASS | another session: foreign order 404, invoice 404, not in /orders | order 404, invoice 404, listed false, name leaked false |
| H01 | PASS | 32 hostile /search?q= queries (FTS operators, quotes, control chars, 5,000 chars, SQL, script) never 500 and never echo raw &lt;script&gt; | all &lt; 500 |
| H02 | PASS | 20 hostile /api/search/suggest?q= queries never 500 | all &lt; 500 |
| RL04 | PASS | reviews: 6 submissions from one session in an hour → 5 stored, the 6th refused with a rate-limit message (no 500) | statuses 200,200,200,200,200,200, stored 5, 6th msg sted several reviews recently Try again in 34 minutes |
| RL05 | PASS | contact: 4 messages from one session in an hour → 3 stored, the 4th refused with a rate-limit message (no 500) | statuses 200,200,200,200, stored 3, 4th msg eral messages recently Please try again in 34 minutes |
| ACC01 | PASS | no-JS sign-up → 303 to /account, users row, sf_auth cookie set | status 303, Location /account, sf_auth set true |
| ACC02 | PASS | Set-Cookie sf_auth: HttpOnly, SameSite=Lax, Path=/ | sf_auth=&lt;token&gt;; Path=/; Expires=Mon, 07 Dec 2026 11:26:08 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax |
| ACC03 | INFO | sf_auth attributes beyond the criteria (Secure on http://localhost, Max-Age) | sf_auth=&lt;token&gt;; Path=/; Expires=Mon, 07 Dec 2026 11:26:08 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax |
| ACC04 | PASS | stored password hash is argon2id (sanity, read from the smoke DB) | prefix $argon2id$ |
| ACC05 | PASS | signed in: order placed, second cart line, review stored under the user's owner key | order /orders/c81db9d9-53a4-4201-87f8-28fa30cdbe3d (status 303), cart qty 2, review rows 1 (status 200) |
| ACC06 | PASS | owner key never appears in any response so far (R-1) | owner key bc7e1b0a… |
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
| ACC14 | INFO | wrong-password vs unknown-email timing (server-side dummy argon2 verify) | 113 ms vs 103 ms |
| ACC15 | PASS | 11th rapid wrong-password attempt → 'Too many attempts. Try again in N minutes.'; correct password also refused while locked; no sf_auth issued | sequence INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,TOO_MANY,TOO_MANY; correct-password attempt: Too many attempts. Try again in 4 minutes. |
| ACC16 | PASS | unknown email: the same 11-attempt sequence is indistinguishable (R-10) | known INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,TOO_MANY,TOO_MANY \| unknown INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,INVALID,TOO_MANY,TOO_MANY |
| ACC17 | PASS | /signin, /signup, /account/settings carry noindex (AC 12; sitemap exclusion in SEO05) | signin "noindex, nofollow", signup "noindex, nofollow", settings "noindex, nofollow" |
| ACC18 | PASS | sign-in with ?next=//evil.example/ never redirects off-site | status 303, Location /account |
| RL01 | PASS | /api/search/suggest?q=lam → 200 application/json, parses, no Set-Cookie | status 200, type application/json; charset=utf-8, body {"suggestions":[{"type":"product","label":"Lambswool Crew Jumper","href":"/products/lambswool-crew-jumper"},{"type":"pro |
| RL02 | PASS | POST /api/search/suggest → 405 | status 405 |
| RL03 | PASS | suggest rate limit: 429 after 120 requests/min for one session (Retry-After header) | first 429 at request 121, Retry-After "49", statuses 200/429 |
| XSS05 | PASS | no response of the whole run contains the raw "&lt;script&gt;alert(1)" (540 responses) | clean |
| FM07 | PASS | no form with action="javascript:…" in any of 540 responses of the run | clean |
| LOG | PASS | server log has no error lines during the run | clean |
| LOG2-01 | PASS | server log: no unstable-value / prerender warnings | clean |
| LOG2-02 | PASS | server log: no unhandled errors / exceptions / SQLite errors | clean |
| LOG2-03 | PASS | server log: no $argon2 hash, sf_auth token, password, card number or email address | argon2 false, tokens 0, passwords 0, cards [], emails [] |
| LOG2-04 | INFO | server log size and line count | 173 bytes, 7 lines; first lines: $ bun --bun next start / ▲ Next.js 16.4.5 / - Local: http://localhost:3105 / - Network: http://192.168.0.159:3105 |
| LOG2-05 | PASS | no sf_auth token (outside Set-Cookie) or $argon2 hash in any response body/Location | tokens 0, argon2 in [] |
| TEARDOWN | PASS | server stopped by PID (64981, 64982, 64984), port 3105 free |  |
| TEARDOWN | PASS | smoke DB files deleted | data/: .gitkeep |
