# Phase 3 redesign: structure contracts (T134)

Owner: qa-engineer. Consumers: implementers of T137–T171 (build to these), QA T163/T164 (organisms), **T172** (home, listing, search pages) and **T173** (PDP, cart, checkout, account). Source of truth for the rules: `BACKLOG-phase3.md` (inventory H1–H26, L1–L12, rules R1–R11, section 4 placeholders). Where this file and the backlog disagree, the backlog wins and this file is corrected.

## How to read a row

Every row is one test. `Check` is what the test queries (Testing Library role query, CSS selector or text), `Expected` is the assertion. Unless a row says otherwise:

- **Render** = the page's server component output rendered with `@testing-library/react` (`render(await Page(props))`), with the root-layout parts (header, footer) rendered from `HeaderShell` / `SiteFooter` the way `tests/redesign/guards.test.ts` does it.
- **No-JS** = the assertion must hold on the server-rendered markup alone: `renderToStaticMarkup(await Page(props))` string or the DOM from it, with no event handler fired and no effect run. A no-JS row fails if the behaviour needs a click handler, `useEffect` or client state.
- **Omit** = when the section's data source is empty, the section root, its heading and any wrapper are absent (no empty `<section>`, no orphan heading). Tested by stubbing that one reader empty while the others return seeded data.
- Heading rows count headings inside `<main>` only unless they say "page".
- Section roots on home are found by `id` (existing convention in `src/app/page.tsx`: `id="home-…"`). The ids below are part of the contract.
- Assertions never put a DOM node into `expect` inside `waitFor` (see `src/test/README.md`); use `@/test/dom-assertions`.

## G. Global (every page; T148, T149, T150, T171)

| ID | Check | Expected | Owner |
|---|---|---|---|
| G-1 | `getAllByRole("banner")` | exactly 1, tag `HEADER` | T148 |
| G-2 | first element matching `a[href], button, input, select, textarea, [tabindex="0"]` in the document | is the skip link, `href="#main"`, accessible name "Skip to content" | T148 |
| G-3 | `getByRole("main")` | exactly 1, `id="main"`, `tabindex="-1"` | layout (unchanged) |
| G-4 | `getAllByRole("contentinfo")` | exactly 1, tag `FOOTER` | T150 |
| G-5 | every `nav` landmark on the page | has an accessible name; names are unique per page. Expected names: `Primary` (CategoryNav), `Departments` (DepartmentMenu), `Breadcrumb`, footer navs each uniquely named, `Listing pages` (listing pagination). No two navs share a name | T143, T148, T150 |
| G-6 | `getAllByRole("heading", { level: 1 })` (page) | exactly 1 on every page | each page task |
| G-7 | heading levels in `<main>` in DOM order | never skip a level downward (h1 → h3 without an h2 between is a fail) | each page task |
| G-8 | header wordmark: `within(banner).getByRole("link", { name: /Northwind Goods/ })` | `href="/"`; contains text, not an `<img>` with a brand asset | T148 |
| G-9 | header search: `within(banner).getByRole("search")` or the `form` containing `input[name="q"]` | `method="get"` (or absent = GET), `action="/search"`, input has an associated label (may be visually hidden), `maxlength="100"`, placeholder "Search products, categories and more" | T143 |
| G-10 | header cart link | accessible name states the count; count over 99 displays "99+" and the full count is in visually-hidden text | T148 |
| G-11 | header, signed out (No-JS) | a link to `/signin` with text "Sign in" | T148 |
| G-12 | header benefits strip `ul` | 3–4 `li`; each link `href` is one of `/shipping`, `/orders`, `/returns`, `/help`; free-shipping text contains the threshold read from shipping-method data (stub the data to a different threshold: text changes) | T140, T148 |
| G-13 | CategoryNav `nav[aria-label="Primary"]` | one link per department, at most N (default 9) direct links; the rest inside `details > summary` with text "More"; current department link has `aria-current="page"` | T143 |
| G-14 | footer `a[href]` (all) | every href is a known route per `content/routes.ts` / `isAllowedInternalHref`; no duplicate href within one column | T150 |
| G-15 | footer placeholders: text "Mobile app coming soon"; texts "Card", "Gift card", "Pay later: coming soon" | present as text; the element and its ancestors up to the footer are not `a`/`button`; no `tabindex` ≥ 0; no `<img>` | T132, T150 |
| G-16 | footer text | contains "Northwind Goods" and the copyright year from the injected clock; no "Catalogue" link; no social links | T150 |
| G-17 | page HTML string (No-JS) | contains none of (case-insensitive) `kmart`, `onepass`, `anko` (word start), `afterpay`, `zip pay`, `app store`, `google play`; contains none of `prefers-color-scheme`, `data-theme`, ` dark:` | T174 (guards G01/G02 cover source) |
| G-18 | `<meta name="color-scheme">` / `viewport.themeColor` | absent or exactly `light`; `themeColor` is one string equal to the primary raw value (guard G08) | T149 |
| G-19 | `<script>` elements in layout output | only `type="application/ld+json"` (no theme or inline bootstrap script) | T149 |
| G-20 | no theme toggle | no element with accessible name matching `/theme|dark mode|light mode/i` | T148, T174 |

## H. Home page `/` (T166; data from T165 `loadHomeData`)

### H-order. Section order

Test: collect the elements in `<main>` that carry the ids below, in document order. With every reader returning seeded data, the list equals this order exactly (no extra home section ids, none missing). Header, nav and benefits live in the layout `<header>` and come before `<main>`; footer comes after it.

**Amended by T172 (2026-11-08)** per the T165/T166 rulings in `STATE.md`: the hero comes first (it holds the page's single h1, so the h1 is the first heading in `<main>`), then the category rail; the 3-column make-room set (inventory H14) renders right after the 4-column explore set; BrandStrip (T155) is placed and sits before the services band (O-1 resolved); the recently-viewed rail sits after the promo pair. Rows 4–14 below are the order T172 tests (`tests/app/phase3-pages/home.qa.test.tsx`).

| # | Section | Root (`id`) | Data source (T165 loader / content) | Omit rule |
|---|---|---|---|---|
| 1 | Header (utility row) | `header` (banner) | layout, `loadHeaderData` | never omitted |
| 2 | Category nav row | `nav[aria-label="Primary"]` inside banner | department list (`categoryTree`) | nav omitted when 0 departments; header still renders |
| 3 | Benefits strip | `ul` inside banner (after the nav row) | `content/home.ts` benefits + shipping threshold | omitted when the items array is empty; hardcoded safe fallback when content is absent (T148 AC5) |
| 4 | Hero carousel | `#home-hero` | `content/home.ts` hero slides (≤ 3) + deal of the day | omitted at 0 slides; deal panel omitted when no deal |
| 5 | Category rail | `#home-categories` | departments (`categoryTree`, top level) | omitted at 0 departments |
| 6 | Delivery / shipping promo | `#home-shipping-promo` | `content/home.ts` promo strip + shipping threshold | omitted when there is no free-shipping threshold, the content entry is absent or its CTA fails `isAllowedInternalHref` |
| 7 | Category discovery | `#home-discovery` | child categories of the departments by product count | omitted at < 1 child category |
| 8 | Lifestyle banner (split) | `#home-lifestyle-banner` | `content/home.ts` | omitted when content absent or its CTA is not allowed |
| 9 | Top picks tabs | `#top-picks` | tab data keyed by `rail` (best-sellers, deals, new-arrivals, top-rated) | whole section omitted when every tab is empty; an empty tab keeps its link but shows no rail; a tab whose reader failed is dropped |
| 10 | Lifestyle cards (4 col) | `#home-lifestyle-cards` | `content/home.ts` explore set | omitted when < 2 valid cards (T154 AC2) |
| 10a | Lifestyle cards (3 col, "make room", H14) | `#home-lifestyle-make-room` | `content/home.ts` make-room set | omitted when < 2 valid cards |
| 11 | Popular searches | `#home-popular-searches` | `content/home.ts` popular searches (shared `/search` list + home extras, ≤ 12) | omitted when the list is empty |
| 12 | Promo pair | `#home-promo-pair` | `content/home.ts` ("New arrivals", "Top rated") | omitted when < 2 valid promos |
| 13 | Recently viewed | `#home-recently-viewed` | recommender `recentlyViewed(ownerKey)` | omitted with no owner key or 0 items |
| 13a | Brand strip (T155) | `#home-brands` | `listWithCounts(now)` brands with published products | omitted at 0 brands |
| 14 | Service tiles | `#home-services` | `content/home.ts` + ServicesBand default tiles; the returns notice line comes before the tile band | always rendered (static content) |
| 15 | Footer | `footer` (contentinfo) | layout | never omitted |

Not rendered (omitted per the placeholder table, O-1 ruling): H16 sign-up CTA strip, H17 "Never miss a deal" strip. H14 (row 10a) and BrandStrip (row 13a) are placed above.

### H-rows

| ID | Check | Expected | Owner |
|---|---|---|---|
| H-1 | `getAllByRole("heading", { level: 1 })` | exactly 1, inside `#home-hero`, the first slide's headline; it is the first heading in `<main>` (amended by T172: hero first) | T151, T166 |
| H-2 | each section 5–14 (the hero holds the h1; its other slides and the deal panel use h2) | has exactly one `h2` (may be visually hidden) as its first heading; the section element is labelled by it (`aria-labelledby` = h2 id, or `getByRole("region", { name })` finds it) | T166 |
| H-3 | cards, tiles, chips inside sections | contain no `h1`/`h2`; card titles are `h3` or not headings (tiles contain no headings at all, T152 AC3) | T137, T141, T152 |
| H-4 | omission matrix | for each reader stubbed empty in turn, only its section(s) disappear, the rest stay in order, page renders, no empty `section` and no orphan `h2` remain | T165, T166, T172 |
| H-5 | all catalogue readers throw | page throws (renders `error.tsx`); a single reader throwing logs a code only and omits its section | T165 |
| H-6 | `#home-categories` | one link per department in data order; > 12 departments: 12 tiles + trailing "All departments" tile linking `/products` (no `/departments` route exists today; T152 verifies); tile images `alt=""` and the link name is the department name | T138, T152 |
| H-7 | `#home-categories` rail scroller (No-JS) | scroll container has `tabindex="0"` and is reachable by keyboard; arrow buttons, when rendered, have names "Previous"/"Next" (or "Scroll left"/"Scroll right") | T131, T152 |
| H-8 | `#home-hero` root | `role="region"`, `aria-roledescription="carousel"`, accessible name non-empty | T139 |
| H-9 | `#home-hero` slides (3 slides) | each slide labelled "1 of 3" … "3 of 3"; dots are 3 links `href="#slide-1"`…, names "Slide 1 of 3"…; exactly one has `aria-current`. 1 slide: no dots. 0 slides: no `#home-hero` | T139, T151 |
| H-10 | `#home-hero` images | first slide image not `loading="lazy"` (eager/priority), the others `loading="lazy"`; every `img` has `alt`, width and height (or an aspect box) | T139 |
| H-11 | `#home-hero` (No-JS) | no autoplay attribute/timer; pause button absent in static markup | T139 |
| H-12 | `#home-shipping-promo` | one link, `href="/shipping"`; text names the free-shipping threshold from data; no partner name or logo | T141, T154 |
| H-13 | `#home-discovery` | an eyebrow text + `h2`; up to 6 card tiles, each a single link to `/category/<slug>` | T152 |
| H-14 | `#top-picks` tabs (No-JS) | a `nav` containing 4 links in order "Best sellers", "Deals", "New arrivals", "Top rated" with `href` `/?rail=best-sellers#top-picks`, `/?rail=deals#top-picks`, `/?rail=new-arrivals#top-picks`, `/?rail=top-rated#top-picks`; the selected one has `aria-current="page"`; no `role="tab"` on links | T131, T153 |
| H-15 | `#top-picks` with `?rail=deals` | only the Deals products are rendered; `rail=x`, `rail=` (empty), `rail=a&rail=b`, `rail=__proto__`, 500-char value → default tab, no throw. **Default tab (amended by T172, T165 ruling):** the content default (Best sellers) when it has products, else the first non-empty tab in tab order (a fresh seed with no paid orders opens on Deals) | T153, T165 |
| H-16 | `#top-picks` cards | ≤ 12 cards (RAIL_LIMIT), no duplicate product within the rail, each card is the compact variant and has a "+ Add" form (see L-12) | T137, T153 |
| H-17 | `#home-lifestyle-cards` | 4 cards (2 to 4 rendered after invalid hrefs are dropped); each has one link to `/category/<slug>` or another allowed route; image `alt` present | T141, T154 |
| H-18 | `#home-popular-searches` | `nav` with an accessible name, `ul` of links `href="/search?q=<encodeURIComponent(term)>"`; ≤ 12 chips; each term returns ≥ 1 seeded result (T165 content test) | T142, T165 |
| H-19 | `#home-promo-pair` | 2 promo cards with texts "New arrivals" → `/new-arrivals` and "Top rated" → `/top-rated` | T154 |
| H-20 | `#home-recently-viewed` | present only with an owner key that has views; never contains the owner key in markup | T153, T165 |
| H-21 | `#home-services` | `h2` "Customer services" (may be visually hidden); `ul` of tiles linking `/orders`, `/returns`, `/shipping`, `/help`, `/faq`, `/contact`; one-line notice links `/returns` and comes before the tile `ul` (reference placement, T155/T166) | T140, T155 |
| H-22 | canonical | `/` for `/` and for `/?rail=deals`; no second canonical; robots per Phase 2 helper | T166 |
| H-23 | JSON-LD | WebSite + SearchAction (layout) and ItemList of the deals rail present (independent of the selected tab), valid JSON, `<` escaped | T166 |
| H-24 | omitted reference items | no element/text for: app download strip, store badges outside the footer, assistant bar ("Joy"), catalogue strip, membership strip, newsletter email field (`input[type="email"]` absent on home), pay-later strip, community photos, recall ticker, store finder | T166, T174 |
| H-25 | images | every `img` in `<main>` has an `alt` attribute (decorative `alt=""`) and either width+height or sits in an aspect-ratio box; below-the-fold images `loading="lazy"` | T136, T166 |

## L. Listing pages (T158 template; T167 category/brand/deals/best-sellers/new-arrivals/top-rated/all products; T168 search)

Order inside `<main>` (DOM order): breadcrumb → h1 + result count → related-search chips → toolbar (Filter button left, sort right, grid/list toggle) → filter panel → grid (with promo slots) → pagination → feedback block.

| ID | Check | Expected | Owner |
|---|---|---|---|
| L-1 | `nav[aria-label="Breadcrumb"]` | first element in `<main>`; last item `aria-current="page"` | T131, T167 |
| L-2 | `getAllByRole("heading", { level: 1 })` | exactly 1 (the results heading, `id` = `LISTING_HEADING_ID`). Search: text `Showing results for "<q>"` with the query as text (SR3) | T158, T168 |
| L-3 | result count line | "1–24 of N results" style (en dash; page size is `LISTING_PAGE_SIZE`, currently 24), last partial page and "0 results" as in Phase 2; count excludes promo tiles | T156, T158 |
| L-4 | related chips | `nav` with accessible name (e.g. "Related searches") and `ul` of links; search: built from suggestions, ≤ 12, the current query is not a chip; category: child categories/brands. Omitted when there are none (no empty nav, no heading) | T142, T167, T168 |
| L-5 | chips and toolbar | add no headings. Outside product cards and promo tiles only these exist: the h1, the visually hidden "Results" h2 that opens the results region (T158 ruling, amended by T172), the feedback h2, on empty states the empty-state h2 (+ its h3 cards on search), and on `/category/<slug>` the h2 of the page's own subcategory rail (`#category-subcategories`) and top-sellers rail (`#category-top-sellers`, T167) | T158, T167 |
| L-6 | Filter control (No-JS) | a `details[data-filter-panel]`, closed by default, whose `summary` text is exactly "Filter" with no facet active and "Filter" followed by the count badge (e.g. "Filter 3") otherwise (amended by T172 to the T157 markup); inside it a `form` with `method="get"` whose field names are within the `parse-params.ts` vocabulary; a submit button whose text starts with "Apply" ("Apply filters") | T157 |
| L-7 | filter badge | the badge inside the "Filter" summary: text equals the number of applied facet values (none → no badge, summary text "Filter"; 3 facets → "3"; price only → "1") | T157 |
| L-8 | "Clear all" | a link whose href drops facet params but keeps `q` and `sort` | T157 |
| L-9 | sort | a `select` (SortSelect) with a label, inside a GET form or with a no-JS submit; placed after the Filter control in DOM order | T157, T158 |
| L-10 | no left sidebar | no `aside`/complementary landmark holding facets outside the details panel | T158 |
| L-11 | grid `ul`/`ol` | product cards and promo tiles are all `li` children of the same list; `N` product `li` + `P` promo `li` | T156 |
| L-12 | product card (each) | one link to `/products/<slug>` wrapping image + title (no nested interactive element inside it); the "+ Add" `form` is a sibling of that link with `input[name="productId"]` and `input[name="quantity"][value="1"]`, no price/total field (SR9); out-of-stock: no form, text "Out of stock"; at most 2 badges, texts from {"Sale", "New", "Top pick"}; price accessible text "$12.50" and list price "Was $19.00" in `<s>` | T137 |
| L-13 | promo slots: count | ≤ 3 promo `li` on page 1 | T156, T167 |
| L-14 | promo slots: page 1 only | `?page=2` (and later): 0 promo `li` | T156, T167 |
| L-15 | promo slots: threshold and filters | results < 8 → 0 promos; any facet active → 0 promos; search with filters → 0 promos | T167, T168 |
| L-16 | promo slots: positions | promos are the 3rd, 10th and 17th grid `li` (2-cell tiles after product indexes 1, 7, 13, T167 `LISTING_PROMO_AFTER_INDEXES`; clarified by T172: "positions" are `li` positions), so the grid cells before each tile are even (2, 10, 18) and a span-2 tile never straddles a 4-column row end; a tile that would follow the last product of a non-full page is dropped, so no promo is the last `li` | T156, T167 |
| L-17 | promo tile content | one link each, href passes `isAllowedInternalHref`; heading level h3 or none (never h1/h2 inside the grid); no partner/membership/app copy | T141 |
| L-18 | pagination | `nav[aria-label="Listing pages"]`; current page `aria-current="page"`; prev/next links carry `rel="prev"`/`rel="next"`; absent on single-page results | T158 (Pagination atom KEEP) |
| L-19 | feedback block | `h2` "Did you find what you were looking for?"; a link "Give feedback" with `href="/contact?topic=feedback"` exactly; 2–3 suggestion links; no `form`, no `input` | T142, T158 |
| L-20 | feedback visibility | rendered when results ≥ 1 or a search query exists; not rendered for a 0-result category with no query | T158 |
| L-21 | `/contact?topic=feedback` | the contact form preselects topic `feedback` (today `CONTACT_TOPICS` has no `feedback`; T142 hands off, T162 adds it) | T142, T162 |
| L-22 | empty category | empty state with a link to `/products`; no grid, no promos | T167 |
| L-23 | search: zero results | message, suggestion links, popular-search chips; status and `noindex` as Phase 2 | T168 |
| L-24 | search: hostile `q` | `<script>`, quotes, 101+ chars, emoji render as text in h1 and chips; chip hrefs encoded; title truncated | T168 |
| L-25 | canonical | no `sort`, `view`, `page` (page 1), facet or `rail` params; rel prev/next unchanged from Phase 2 | T167 |
| L-26 | invalid params | `page=0`, `page=999`, `sort=;drop` behave as in Phase 2 (ignore, clamp or redirect, as the existing tests pin) | T167 |
| L-27 | omitted reference items | no "Marketplace" toggle, no seller chips, no "Online only" text | T137, T158 |
| L-28 | grid columns | grid classes give 4 columns at `lg`, 3 at `md`, 2 below; no 1-column class at any breakpoint | T156 |

## P. Product page `/products/[slug]` — REFERENCE PENDING

No PDP reference was supplied (backlog section 1c, open question 1). These rows fix structure and behaviour only; layout details may change when the reference arrives, and T144/T145/T159/T160/T169 may get a rework pass. The page file header must say "reference pending" (T169 AC6).

**Status (T174, 2026-11-08): every P row is "reference pending".** The rows were built and tested against this structure (T144/T145/T159/T160/T169 colocated tests, T173 page QA, T174 audit (d)/(e) on a rendered PDP), but none is signed off against a visual reference: the human's third and fourth attachments were byte-identical listing screenshots. When the real PDP reference arrives, re-run the P rows and the PDP entries of the Playwright list in `PLAN.md`; layout rows (P-3, P-9, P-14) are the ones most likely to change.

| ID | Check | Expected | Reused from Phase 2 | Owner |
|---|---|---|---|---|
| P-1 | breadcrumb | `nav[aria-label="Breadcrumb"]` first in `<main>`, BreadcrumbList JSON-LD matches | yes (Breadcrumb atom, JSON-LD) | T169 |
| P-2 | h1 | exactly 1, the product title | yes | T169 |
| P-3 | DOM order | gallery before buy box (single column below 1024px follows DOM order) | new layout | T169 |
| P-4 | gallery (No-JS) | every image reachable through links/anchors; thumbnails named "Image 2 of 5"; selected `aria-current`; 1 image → no thumbnails; 0 images → placeholder with the product name as `alt` | ImageGallery no-JS pattern (`basePath`/`galleryHrefForIndex`) | T144 |
| P-5 | buy box text | brand link to `/brand/<slug>`; rating link `href="#reviews"`; badges row (same rules as L-12) | rating/brand links from Phase 2 | T159 |
| P-6 | price | accessible "$12.50"; list > price → `<s>` "Was …" and text "Save $X (Y%)", Y rounded down (1999 vs 2499 → "Save $5.00 (20%)"); list ≤ price → no saving | Price atom (T131), PriceBlock | T159 |
| P-7 | stock | text for in stock / low (≤ 5, "Only N left") / out of stock; never colour only | StockBadge, StockUrgency | T145 |
| P-8 | actions (No-JS) | `form` posting add-to-cart with `productId`, `quantity` (max = stock); "Buy now" posts its action; out of stock → both replaced by the stock-alert form | AddToCartForm, BuyNow, StockAlertForm | T145, T159 |
| P-9 | focus order | quantity → Add to cart → Buy now → Add to list → compare → share | Wishlist, CompareToggle, ShareLink | T145 |
| P-10 | delivery estimate and trust list | delivery estimate text; free-shipping threshold from data; link `/returns` | DeliveryEstimate | T159 |
| P-11 | content sections | "About this item" bullets (`ul`), specs `table` with header cells, `section#reviews`, `section#questions`, each with an `h2` | ReviewsSection, QASection, specs | T160, T169 |
| P-12 | rails | Frequently bought together, Related, Also viewed, Recently viewed: each `h2` + compact cards; omitted when empty; never contains the current product | FBT (no-JS checkboxes), ProductRail, recommenders | T153, T160, T169 |
| P-13 | SEO | Product JSON-LD with `offers.availability`; canonical; OG tags; unknown slug → 404; future `published_at` → 404 | all Phase 2 | T169, T173 |
| P-14 | sticky buy box | sticky only from `lg`; focused elements keep `scroll-margin` so the sticky box never hides them | new | T159 |

## R. Light-only and no-branding assertions (all pages)

| ID | Check | Expected | Owner |
|---|---|---|---|
| R-1 | guard G01 over `src/**`, `public/**` | no `kmart`, `onepass`, `anko`, `afterpay`, `zip pay` | T174 (guards.test.ts) |
| R-2 | guard G02 | no `dark:`, `prefers-color-scheme`, `data-theme`, `color-scheme: light dark` outside rule-stating prose | T174 |
| R-3 | guards G03–G09 | brand "Northwind Goods" in site.ts, metadata, header, footer, manifest, Organization JSON-LD; theme colour = primary | T148–T150, T174 |
| R-4 | guards G10–G12 | primary hue outside **335–20** deg (widened by T174 from 345–20: the reference red/pink measured ~340 deg, STATE.md ruling) and ≥ 30 deg from the reference teal (170) and purple (270); `color-scheme: light` only | T130, T174 |
| R-5 | rendered HTML of `/`, a listing, search, PDP, cart, checkout, signin | G-17 string checks hold; no element with class token starting `dark:` | T172, T173, T175 |
| R-6 | copy | none of "low prices", "delivered faster", "Click & Collect", "same day", "catalogue", "member" offers, "App Store", "Google Play", "PayPal", "Visa", "Mastercard" in rendered text (R2, R10). Checked by `audit.test.tsx` (a) over `src/content`, `src/app`, organisms, `public/images/**` SVG text and 12 rendered pages. Documented exception: the card network of the shopper's own payment method on order detail ("<network> ending in 4242", `OrderDetail/order-detail-model.ts`) is data, not a partner offer (observation O-T174-1, orchestrator to confirm). Open: D-T174-3 ("catalogue" in the home promo-pair blurb) | T165, T174 |

## Open items for the orchestrator / PM (resolved)

All four were ruled by the orchestrator (STATE.md, "Rulings on CONTRACTS open items", plus the T165/T166 rulings); T172 folded the answers into the rows above.

- **O-1 resolved.** BrandStrip stays on home (row 13a, before the services band); H14 is the 3-column make-room set (row 10a, after the explore set); H16 and H17 are omitted per the placeholder table. The hero now comes before the category rail (h1 first).
- **O-2 resolved.** Listing page size stays 24 (`LISTING_PAGE_SIZE`, 6 rows × 4); T172 AC2 reads 24. L-3 unchanged.
- **O-3 resolved.** No `/departments` index: department links go to `/category/<dept>`, the rail's "All departments" tile links `/products` (H-6 unchanged).
- **O-4 resolved.** `feedback` is in `CONTACT_TOPICS` (T142 scope); L-19/L-21 hold as written.

## A. Whole-app audit (T174, `tests/redesign/audit.test.tsx`)

Rendered pages (header + `<main>` + footer + toast viewport together, `:memory:` seeded DB, wave-5 harness mocks): home (guest), home (signed in), `/category/<first department>`, `/products`, `/search?q=desk`, a PDP, `/cart` and `/checkout` with one line, `/account` (signed in), `/signin`, `/shipping`, not-found. Every helper has a planted-violation self-test.

| ID | Check | Expected | Status |
|---|---|---|---|
| A-1 | retailer, payment, social, membership, newsletter, app-store and copied-copy words (built at run time) in `src/content/**`, `src/app/**`, organisms (comments stripped), `public/images/**` SVG text/titles, rendered text + `aria-label`/`alt`/`title`/`placeholder` | none, except the documented card-network exception | FAIL: D-T174-3 |
| A-2 | home art SVGs (`public/images/home`) | no `<text>`/`<title>` | pass |
| A-3 | brand: `SITE_NAME`, manifest `name`/`short_name`, metadata title/applicationName/og:site_name, Organization + WebSite JSON-LD; header wordmark text link to `/` (no image), footer text | "Northwind Goods" everywhere | pass |
| A-4 | light-only strings in `src/**` and `public/**` (code AND tests, only the designer's negative-grep test exempt), root configs, rendered HTML | none; `color-scheme` in globals.css is exactly `light`; no non-JSON-LD script (React's no-JS form shim excepted) | pass |
| A-5 | manifest `theme_color` / `viewport.themeColor` / `background_color` | = `--accent` / `--accent` / `--surface-page` raw values; no `viewport.colorScheme` | pass |
| A-6 | theme toggle | no file named theme/dark-mode/color-scheme, no ThemeProvider/useTheme/toggle-dark code, no control named theme/dark/light mode | pass |
| A-7 | tokens | `check:tokens` exit 0; no raw hex outside globals.css, site.ts and SVG art (incl. the seed SVG generators); no arbitrary-value token in any string in `src/**` (arbitrary variants allowed); inline `style` only `width:N%` data bars and next/image | pass |
| A-8 | headings | one h1 per page, first heading in `<main>` is the h1, no skipped level in main/header/footer, no h1 in header/footer | pass |
| A-9 | landmarks | one banner, main, contentinfo; every nav/aside/search named; names unique per role across header + main + footer | pass |
| A-10 | forms | named forms unique; unnamed forms have a named submit control | pass |
| A-11 | images | every `<img>` has `alt` | pass |
| A-12 | targets | buttons/selects/summaries/text inputs `min-h-touch` (or `h-touch`/`size-touch`/48px); icon-only controls `min-w-touch`; nav links and pill links `min-h-touch`; checkboxes/radios in a 44px row | pass |
| A-13 | focus | globals.css `:focus-visible` 2px ring + 2px offset; no `outline-none`/`outline-hidden`/`outline-0` without a `focus(-visible):ring/outline` replacement (rendered + source); no positive tabindex; skip link first; unique ids, no dangling `aria-labelledby`/`aria-describedby`/`for` | pass |
| A-14 | 320px | unprefixed `w-N`/`min-w-N` ≥ 160px only inside a scroller or with a `max-*:min-w-0`/`max-w-full` override (rendered) and on the source allow-list (CategoryTile, Dialog, Drawer, ScrollRail, CategoryNav "More" popover, ProductCard, CompareTable); grid items without `min-w-0` hold no fixed width; product grids `grid-cols-2 min-w-0` at base; `<main>` `w-full` with no fixed width | pass |
| A-15 | scroll rows | every focusable inside an `overflow-x-auto` row has padding on both axes between it and the scroller (ring = 2px + 2px offset) | FAIL: D-T174-1 (top-picks tabs), D-T174-2 (CategoryNav horizontal ends) |
