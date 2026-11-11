# organisms

Larger, self-contained page sections. Owner: programmer.

**Rule:** organisms compose atoms and molecules; no server imports; data arrives via props.
Server-safe by default; any client interactivity is isolated behind a `"use client"` boundary.

## Index

| Organism | Purpose | Props |
| --- | --- | --- |
| `SiteHeader` | Skip link + sticky banner with the wordmark and a row-1 list (Catalog, Cart with item count); v3 rows below (T148) | `cartCount: number`, `currentPath?: string`, `storeName?: string` |
| `SiteFooter` | v3 (T150): light contentinfo with back to top, "Footer: Quick links" nav, one named nav per link column + "Get the app" placeholder column, "Ways to pay" placeholder row, light bottom bar (wordmark + copyright). Server-safe | `storeName?: string` (SITE_NAME), `now?: number \| Date` (clock, read once), `year?: number` (deprecated override), `columns?: readonly FooterColumn[]` (SITE_FOOTER_COLUMNS), `links?` (deprecated flat mode), `backToTopHref?: string` ("#main") |
| `CheckoutForm` (client) | Address + payment form for the checkout action: error summary/alerts, double-submit guard, idempotency key per attempt (contract: `_contracts/checkout-actions.ts`) | `placeOrder: CheckoutActionFn`, `initialIdempotencyKey: string`, `cartHref?: string` (default "/cart"), `className?: string` |
| `ProductGrid` | Responsive product list (2/3/4 cols since T156; never 1) of `ProductCard`s with optional promo tiles; empty state when no products. Server-safe | `products: readonly Product[]`, `priorityCount?: number` (4), `headingLevel?: 2 \| 3 \| 4` (3), `emptyMessage?: string` |
| `CartTable` | Client. Cart line list (`CartLineItem`), summary, checkout link (only when `canCheckout` and no unavailable line), empty state, polite totals live region | `cart: CartTableData`, `updateQuantity: CartActionFn`, `removeItem: CartActionFn`, `checkoutHref?: string` ("/checkout"), `continueShoppingHref?: string` ("/") |
| `OrderSummary` | Read-only order lines (unit x qty) + Subtotal / Shipping ("Free" at 0) / Total as given. Server-safe | `items`, `subtotalCents`, `shippingCents`, `totalCents`, `currency`, `heading?: string`, `headingLevel?: 2 \| 3` |

`SiteHeader` renders the "Skip to content" link targeting `#main`, so the layout must render `<main id="main">`.

### SiteFooter v3 (T150)

Server component, light surfaces only (`bg-surface-page`, back-to-top band and bottom bar `bg-surface-sunken`; no inverse band, no social links, no images). Every link is `Link tone="default"` with a 44px target; no `!` classes.

- Structure: "Back to top" (`#main`, first focusable) -> `<nav aria-label="Footer: Quick links">` (Track order `/orders`, Contact us `/contact`; no catalogue link) -> grid `grid-cols-1 sm:grid-cols-2 lg:grid-cols-5` (`[data-footer-columns]`) of one `<nav aria-label="Footer: <heading>">` per column (`<h2>` + `<ul>`) plus the "Get the app" `<div>` (`[data-footer-app]`, `StoreBadge` "Mobile app coming soon") -> "Ways to pay" row (`[data-footer-payments]`, `PaymentMark` Card / Gift card / Pay later: coming soon) -> bottom bar (`[data-footer-bottom-bar]`: wordmark `<p data-footer-wordmark>` in `text-accent`, copyright `© <year> <storeName>. All rights reserved.`, demo notice).
- Default columns: `SITE_FOOTER_COLUMNS` = `FOOTER_COLUMNS` from `src/content/navigation.ts` (Help, Orders & delivery, About, Legal); quick links = `FOOTER_QUICK_LINKS`. `SiteFooter/footer-links.ts` re-exports them and holds the placeholder copy. The layout's `columns={FOOTER_COLUMNS}` renders the same v3 columns.
- Links: unsafe hrefs (not `isAllowedInternalHref`, non-http external) and duplicate hrefs anywhere in the footer (quick links win, then first column) are dropped with a dev warning; emptied columns are removed. Legal links (`LEGAL_LINKS`) missing from the given columns are appended as a "Legal" column, so they are always reachable.
- Nav names are unique: a repeated heading gets a numeric suffix ("Footer: Shop 2").
- Year: `footerYear(now, year)` = explicit `year`, else the UTC year of `now`, else `Date.now()` read once.

### SiteFooter v2 (T81) (superseded by v3)

Server-safe. Inverse band (`bg-surface-inverse text-text-inverse`), exactly one `<footer>`; every link is `Link variant="subtle" tone="inverse"` (44px target, no `!` classes).

- Props: `storeName?: string` ("Storefront"), `year?: number` (current year), `columns?: readonly FooterColumn[]`, `links?: ReadonlyArray<{ href; label; external? }>` (MVP; used only when `columns` is absent, default Catalog + Cart), `backToTopHref?: string` ("#main"; must be an `#id`, else falls back with a dev warning).
- Structure: full-width "Back to top" anchor (`Icon arrow-up`, works without JS) -> `<nav aria-label="Footer">` with one `<section>` per column (`<h2 class="text-small font-semibold">` + `<ul>`; grid 1 / `sm:` 2 / `lg:` 4 cols) -> copyright, demo-store notice, legal links paragraph (`/privacy`, `/terms`, `/accessibility`; a `<p>`, not a second `<ul>`, so the default footer keeps one list as the T17 QA test expects).
- Every internal href must pass `isAllowedInternalHref`; external links must be http(s). Failing links are dropped with a dev warning; columns left empty are removed.
- Defaults keep the MVP contract (tests unchanged). The layout should render `<SiteFooter storeName={SITE_NAME} columns={FOOTER_COLUMNS} />`.

### ReviewsSection (T76)

Server-safe `<section id="reviews">` labelled by the "Customer reviews" heading (`#reviews-heading`): `ReviewSummary` (histogram rows = star filter links), filter chips ("All stars", "Remove filter: N stars", "Verified purchase only"), a sort `<form method="get" action="<basePath>#reviews">` (`Select name="sort"`: Top reviews / Most recent + "Apply"), a `<ul aria-label="Reviews">` of `ReviewCard`s, "Showing x–y of N reviews" and `Pagination` (`aria-label="Reviews pagination"`, hidden below 2 pages), and the "Write a review" `Disclosure` (`#write-review-disclosure`) holding `ReviewForm` (`#write-review`). Everything is plain GET (D9: state in the URL); no JS required.

| Props | |
| --- | --- |
| `productId`, `productSlug`, `basePath` (e.g. `/products/<slug>`) | strings |
| `list: ReviewListResult` | from `reviewService.list(...)` |
| `query: { sort: ReviewSort; stars?: 1..5; verifiedOnly?: boolean }` | parsed from the URL by the page |
| `actions: { submitReview: ReviewActionFn; voteReviewHelpful: VoteActionFn }` | server actions |
| `viewer: { signedInName?: string \| null; alreadyReviewed: boolean }` | |
| `headingLevel?: 2 \| 3` (2), `pageSize?: number` (10), `className?` | review titles render at `headingLevel + 1` |

Look (Phase 3, T160): `ReviewSummary` on a white `Card` (`data-testid="reviews-summary-card"`; histogram bars `bg-accent` with the percentage as text); filter chips + sort form on a light-grey `Card tone="sunken"` band (`data-testid="reviews-controls"`; "Apply" is an `outline` pill `Button`); the review list inside a white `Card` (`data-testid="reviews-list-card"`, each `ReviewCard` keeps its bottom divider); empty / no-match / past-the-end states on a sunken band with `outline` pill button-links; the write-review `Disclosure` is `bordered` + `shadow-sm` (white card). Markup contracts (ids, anchors, heading levels, GET forms, `$$FORM_ACTION` no-JS POST via ReviewForm) unchanged.

States: `summary.count === 0` -> "Be the first to review this product" and the form open; filters with 0 matches -> "No reviews match your filters" + "Clear filters" (keeps sort); page past the end -> link to page 1; `viewer.alreadyReviewed` -> the already-reviewed notice inside `<div id="write-review">` instead of the disclosure.

URL helper: `buildReviewsHref(basePath, state: { sort; stars?; verifiedOnly?; rpage? }, patch?)` -> `${basePath}?sort&stars&verified=1&rpage#reviews` (that key order; defaults omitted: sort "helpful", no stars, verified off, page 1; invalid values dropped; any query/fragment on `basePath` discarded). A key present in `patch` (even `undefined`) replaces the value; changing sort/stars/verified without `rpage` resets to page 1. Pages should parse `sort`, `stars`, `verified=1`, `rpage` with the same names (`REVIEWS_PARAM`).

### QASection (T77)

Server-safe `<section id="questions">` labelled by the "Customer questions & answers" heading (`#questions-heading`), followed by the count as text ("12 questions" / "1 question"). Then the "Ask a question" `Disclosure` (`#ask-question`, bordered) holding `QuestionForm`; an `<ol aria-label="Questions">` of `QuestionCard`s (`maxVisibleAnswers={2}`: the card puts the rest behind "See all N answers", a native `<details>`); "Showing x–y of N questions" and `Pagination` (`aria-label="Questions pagination"`, hidden below 2 pages). Pagination is plain GET links and every mutation form posts its server action directly, so no JS is needed. All user text goes through the molecules' text-only rendering.

| Props | |
| --- | --- |
| `productId`, `productSlug`, `basePath` (e.g. `/products/<slug>`) | strings |
| `list: QaListResult` | from `qaService.list(productId, { page }, viewer)` (5 per page, `QA_SECTION_PAGE_SIZE` mirrors `QA_PAGE_SIZE`) |
| `actions: { askQuestion; answerQuestion: QaActionFn; voteQuestion; voteAnswer: QaVoteActionFn }` | server actions (`_contracts/qa-actions.ts`) |
| `viewer: { signedInName?: string \| null }` | forms show "Posting as <name>" |
| `headingLevel?: 2 \| 3` (2), `extraParams?: Record<string, string \| string[]>`, `className?` | `extraParams` = other URL params to keep on pagination links (e.g. the reviews `sort`/`stars`/`rpage`) |

States: `total === 0` -> "No questions yet. Be the first to ask." with the ask form open (`<details open>`); page past the end -> "There are no questions on this page" + link to page 1.

Look (Phase 3, T160): questions are `QuestionCard`s (white `Card`s) in the `<ol>`; the "Ask a question" `Disclosure` is `bordered` + `shadow-sm`; the empty and past-the-end states sit on a light-grey `Card tone="sunken"` band, the "first page" link is an `outline` pill button-link (`min-h-touch`). No markup or behaviour change.

URL helper: `buildQaHref(basePath, state: { qpage?; extra? }, patch?: { qpage? })` -> `${basePath}?<extra…>&qpage=N#questions` (page 1 / invalid omitted; `extra` keys kept in order, a `qpage` key in `extra` ignored; any query/fragment on `basePath` discarded). A `qpage` key present in `patch` (even `undefined`) replaces the current one. Pages should parse `qpage` (`QA_PAGE_PARAM`).

### AccountHub (T87)

Server-safe, presentational "Your Account" hub. Data arrives via props; mutations are plain `<form action>` posts (work without JS). Import from `@/components/organisms/AccountHub`.

| Props | |
| --- | --- |
| `user: AccountHubUser \| null` | `{ displayName; email }` (a `CurrentUser` from `readCurrentUser()` fits; its `id` is never rendered). `ownerKey`, `owner_key`, `sessionId`, `session_id`, `passwordHash`, `token`, `tokenHash` are typed `never` (R-1) |
| `counts: AccountHubCounts` | `orders, lists, addresses, history, reviews, questions, alerts, messages`; NaN/negative/infinite -> 0, fractions floor |
| `backInStock: readonly { alertId; productSlug; productName; available? }[]` | map `stockAlertService.listBackInStock(ownerKey)` with `toBackInStockItems(views)` (drops alerts with no product; an unpublished product maps to `productSlug: ""`, `available: false` and renders as text + "No longer available" with only the Acknowledge form, D-T98-4). Product links carry `inline-flex min-h-touch items-center font-semibold` (44px target, D-T87-2) |
| `actions?: { signOut?: AuthActionFn; acknowledgeAlert?: StockAlertActionFn }` | `signOut` from `src/app/actions/auth.ts`, `acknowledgeStockAlert` from `src/app/actions/stock-alerts.ts`; bound with `prevState = null` |
| `headingLevel?: 1 \| 2` (1), `className?` | "Your Account" heading; card titles at `headingLevel + 1` |

Structure: heading -> back-in-stock `Notice tone="success"` ("Back in stock:", product links to `/products/<slug>`, one "Acknowledge" form per item posting hidden `alertId` + `productSlug`; hidden when empty; bad slug -> name as text, bad alert id -> no form) -> header block (signed in: "Hello, <displayName>", email as text, "Login & security" link to `/account/settings`, "Sign out" form when `signOut` is given; guest: "Hello, shopper", `Notice tone="info"` with `GUEST_NOTICE_TEXT`, button-styled links to `/signin` and `/signup`) -> `<ul aria-label="Account sections">` of eight one-link cards (Your Orders, Your Lists, Addresses, Browsing History, Your Reviews & Questions, Stock Alerts, Messages, Help; grid 1 / `sm:` 2 / `lg:` 3 / `xl:` 4). Zero counts show an invitation instead of "0 ...". Every href passes `isAllowedInternalHref` (else omitted with a dev warning). No ids or data-* carry user data; the only id-like values in the HTML are the hidden `alertId` inputs.

Usage (page): `<AccountHub user={await readCurrentUser()} counts={counts} backInStock={toBackInStockItems(alerts.listBackInStock(ownerKey))} actions={{ signOut, acknowledgeAlert: acknowledgeStockAlert }} />`.

Look (Phase 3, T162): the signed-in / guest header block is a white `Card` (`data-slot="account-hub-header"`) with the user glyph in a light-blue circle; guest actions are a primary "Sign in" pill + `outline` "Create account" pill; each section tile is a white `Card as="li"` (`interactive` hover lift, no padding) wrapping the full-size `nav` link (`min-h-touch w-full`, icon in a `bg-accent-subtle` circle). "Sign out" stays the `secondary` pill. No markup roles, names, forms or heading levels changed.

### CompareTable (T86)

Server-safe (no `"use client"`; `renderToStaticMarkup` works). `<section>` labelled by the "Side-by-side comparison" heading (`headingLevel`, default 2) around a `Table` (`label="Product comparison"`, `density="compact"`) whose `<table>` carries a visually hidden `<caption>` "Product comparison". All state is in the URL (D9): remove and "Differences only" are plain links; Add to cart is a `<form action>` that works without JS.

| Props | |
| --- | --- |
| `products: readonly ProductDetail[]` | resolved by the page, in selection order; duplicate ids dropped (first wins); > 4 -> first 4 + notice "Showing the first 4 of N products." |
| `selectedSlugs: readonly string[]` | slugs in the URL, used for links; only slugs of shown products are kept (an unknown slug never sticks in links); falls back to the products' slugs when none match |
| `differencesOnly?: boolean` (false) | hide rows whose values are identical in every column; remove links keep `diff=1` |
| `basePath?: string` ("/compare") | unsafe values (absolute, `//`, backslash) fall back to `/compare`; query/hash dropped |
| `addToCart?: CartActionFn` | per column `<form action={addToCart.bind(null, null)}>` posting hidden `productId` + `quantity=1` ("Add to cart for <name>"; disabled "Out of stock" button at 0 stock). Absent -> `Link variant="button"` "View product" to `/products/<slug>`. The action's returned state is not shown (no `useActionState`); the action must revalidate the cart itself |
| `headingLevel?: 2 \| 3`, `className?` | |

Rendering: < 2 products -> `Notice tone="info"` "Add at least two products to compare" (+ browse link) and, for one product, a card with image, name link, price and remove link; no table. Header row: image (alt = name), name link, "Remove <name> from comparison" link. Body rows (`TableHeaderCell scope="row"`, sticky `left-0 z-raised bg-surface-raised`, `min-w-28`): Price, Customer rating (or "No reviews yet"), Brand, Availability (`StockUrgency`), then the spec union, then Buy. Missing values render `<span aria-label="not specified">—</span>`. Product hrefs (`/products/<slug>`) must pass `isAllowedInternalHref`; otherwise the name renders as plain text, "View product" becomes the text "Product page unavailable", and a `[CompareTable]` `console.warn` fires outside production. Product columns are `min-w-40`, so at 320px the table scrolls inside the region (`overflow-x-auto`), never the page; the root is `min-w-0 max-w-full` (flex/grid parents must allow shrinking). Differences-only with no differing row shows "These products have the same details." Look (Phase 3, T160): the table region is a white card (`rounded-lg border shadow-sm`), the single-product view is a `Card` (`data-testid="compare-single"`), and the "Show differences only" / "Show all details" toggle is an `outline` pill button-link (`buttonSize="sm"`, still a plain GET link with `data-differences-only`).

Helpers (`compare-table-helpers.ts`, re-exported from the index): `specRows(products)` -> `{ label, values: (string | null)[], allEqual }[]` (labels trimmed, first-seen order, empty value = null, first duplicate wins; `allEqual` treats null as a value); `visibleRows(rows, differencesOnly)`; `toggleDifferencesHref(basePath, slugs, differencesOnly)` (takes the CURRENT state: off -> `?p=…&diff=1`, on -> `?p=…`); `removeHref(basePath, slugs, slug, differencesOnly = false)` (never adds a slug); `compareStateHref(basePath, slugs, differencesOnly)`; `truncateProducts` (dedupes by id, first wins, then caps at 4); `linkSlugs(selectedSlugs, shown)` (selected slugs of shown products, else the shown slugs); `safeCompareBase`; `COMPARE_DIFF_PARAM = "diff"`. Slugs are normalised with `normaliseCompareSlugs` (trim, dedupe, max 4) and encoded with URLSearchParams; outputs pass `isAllowedInternalHref`.

### FaqList (T89)

Server-safe `<ul>` of `Disclosure`s (native `<details id={entry.slug}>`): the question is the `<summary>` (Enter/Space toggle it natively, no JS), the answer paragraphs are `<p>` text children, then "Related pages" links (`relatedHrefs` filtered by `isAllowedInternalHref`, de-duplicated; label = the navigation label for that path, else the humanized last segment, see `faqRelatedLinkLabel`). Deep links: `/help/<topic>#<slug>` and `/faq#<slug>` scroll to the item; the target is the `<details>` itself, so it stays collapsed (the question is visible and one keypress opens it). To land on an open answer, link with `?open=<slug>#<slug>` and pass `openSlug`. There is no `hidden` content: without JS the native collapsed state is the only "hidden" state, find-in-page reaches closed answers in supporting browsers, and printing shows items as they are (collapsed items print collapsed; no print stylesheet). Duplicate slugs keep only the first entry.

| Props | |
| --- | --- |
| `entries: readonly FaqEntry[]` | from `src/content/faq.ts` |
| `openSlug?: string` | entry rendered `<details open>` (pages pass `?open=<slug>`; `#hash` is client-only) |
| `title?: string`, `headingLevel?: 2 \| 3` (2) | optional visible list heading; `headingLevel` applies to it only (summaries never contain headings, per the Disclosure atom) |
| `relatedLabel?: string` ("Related pages"), `className?` | |

Look (Phase 3, T162): each entry is a `bordered` Disclosure (white rounded card, `shadow-sm`) with a 12px gap between entries; `<details id>`, `<summary>` and related links unchanged.

### ContactSection (T89)

Server-safe `<section aria-labelledby="contact-heading">`: heading ("Contact us"), the honest intro ("We reply within two business days. This demo store stores your message but does not send email."), `ContactForm` (which renders the success Notice with the reference number in `<code>` inside its live region, and every error state), and an `<aside>` "Looking for something else?" with help links (invalid hrefs omitted; the aside is dropped when none remain). Works without JS (the form posts its action).

| Props | |
| --- | --- |
| `action: ContactActionFn` | `sendContactMessage` |
| `orders?: readonly { id; label }[]` | the visitor's own orders only (the page must load them); select hidden when empty |
| `initialTopic?`, `initialOrderId?`, `productSlug?`, `signedInEmail?` | forwarded to `ContactForm` (it ignores topics/orders not in its lists) |
| `headingLevel?: 1 \| 2` (2) | use 1 on `/contact`; the aside heading is one level lower |
| `title?` ("Contact us"), `helpLinks?` (`DEFAULT_CONTACT_HELP_LINKS`: Help center, FAQ, Your orders, Returns, Shipping), `className?` | |

Look (Phase 3, T162): `ContactForm` sits in a white `Card` (`data-slot="contact-form-card"`, still `max-w-prose`); the help-links `<aside>` is a light-grey `Card as="aside" tone="sunken"`. Landmarks, heading ids/levels and the form are unchanged.

### ProductRail, FrequentlyBoughtTogether (T75; ProductRail v3 T153)

**ProductRail** (server component; import `@/components/organisms/ProductRail`). A titled horizontal rail of compact product cards for every recommendation, recently viewed and best seller rail, and the home "Top picks" rail with link tabs.

| Props | |
| --- | --- |
| `title: string` | Section heading; names the `<section>` via `aria-labelledby`. The inner `ScrollRail` region is named `railLabel(title)` = "<title>, product list" (with tabs: `railLabel("<title>: <active tab label>")`), so the page never has two regions with the same name |
| `products: readonly Product[]` | The rail's (or the active tab's) products. Duplicates (by id) render once |
| `eyebrow?: string` | Short text line above the heading; blank = omitted |
| `headingLevel?: 2 \| 3` (2), `id?`, `className?` | Heading id is `<id>-heading`, or a `useId` id, so `aria-labelledby` is unique per rail. Card names are one level below (h3 / h4). `id` is the anchor target (home passes `top-picks`) |
| `quickAdd?: { action: CartActionFn }` | "+ Add" one-unit form on every card (`ProductCard quickAdd`; posts productId + quantity=1; out of stock = disabled "Out of stock"). Omitted = no form |
| `tabs?: readonly { id, label, href }[]`, `activeId?`, `tabsLabel?` | Link tabs: a `<nav aria-label>` (default `railTabsLabel(title)` = "<title>, lists") holding a `ul` of plain `Link`s (no `role="tab"`), server-rendered, work without JS. Hrefs are built by the caller (home: `/?rail=<id>#top-picks`) and must pass `isAllowedInternalHref`; invalid, blank or duplicate tabs are dropped with a dev warning. The `activeId` tab gets `aria-current="page"` plus an accent bottom bar; unknown `activeId` = first tab. 44px targets (`min-h-touch`); the list scrolls inside the nav at 320px (`overflow-x-auto`, `w-max`, `whitespace-nowrap`) |
| `hrefForProduct?: (p) => string` | Validation hook: a product whose href fails `isAllowedInternalHref` (or throws) is dropped with a dev warning. Cards always link to `/products/<slug>` (ProductCard owns the link), a different allowed href only warns |
| `itemWidth?: "sm" \| "md" \| "lg" \| "auto"` | `sm` 80px below md, 160px from md; `md` 224px; `lg` 288px; `auto` leaves the width to the child (`ScrollRail`) |
| `seeAllHref?: string` | "See all" link next to the heading (sr-only suffix with the title); omitted with a dev warning when not allowed |
| `now?: Date` | The page's single clock (read once by its loader) forwarded to every compact card for the "New" badge. Pages pass it (FIX-card-now; wave-3 page tasks); omitted → no "New" badge and no clock read |

Helpers: `resolveRailTab(raw, ids, defaultId)` turns a raw `?rail=` search param into a known tab id (missing, empty, repeated `rail=a&rail=b`, unknown, `__proto__`, > 64 chars all give `defaultId`; never throws); `validRailTabs(tabs, activeId)`.

Empty: no tabs and no card left = renders `null` (no empty heading). With tabs and an empty active tab, the heading and tab links stay and a `role="status"` text (`PRODUCT_RAIL_EMPTY_TAB_TEXT`) replaces the rail, so the user can switch tabs; the caller omits the whole section when every tab is empty. Cards are `ProductCard variant="compact"`: ONE link (decorative image + name heading) to the product page, rating/price/stock as siblings, quick add in the overlay. Without JS it is ScrollRail's native snap scroller; the "Previous"/"Next" buttons stay hidden and with JS appear only while there is content in that direction.

Usage (home): `<ProductRail id="top-picks" title="Top picks" tabs={tabs} activeId={resolveRailTab(searchParams.rail, ids, "best-sellers")} products={tabProducts} quickAdd={{ action: addToCart }} />`.

**FrequentlyBoughtTogether** (client; import `@/components/organisms/FrequentlyBoughtTogether`).

| Props | |
| --- | --- |
| `bundle: Bundle` | From `recommendationService.frequentlyBoughtTogether(id)`; main item first. Fewer than 2 distinct items renders `null`; capped at `ADD_MANY_MAX_ITEMS` |
| `action: CartActionFnV2` | `addManyToCart` (pass the server action directly) |
| `headingLevel?: 2 \| 3` (2), `className?` | Heading "Frequently bought together" |

Structure: images (links to `/products/<slug>`) joined by decorative `plus` icons -> one `<form action>` with one `Checkbox name="productId" value=<id>` per item (all checked; labels "This item: <name> — <price>" / "<name> — <price>") -> polite live total "Total for N items: $X" (exact `sumCents`; the server render equals `bundle.totalCents`) -> "Add selected to cart" (`Adding…` while pending; disabled when nothing is checked) -> errors in `role="alert"`, success as text in a polite region from `perItem` ("Added: A, B. Out of stock: C. Already at the cart limit: D. Unavailable: E."; falls back to `message`). The main item's checkbox is disabled while it is the only checked item and then posts through a hidden `productId` input (disabled checkboxes do not post). Without JS the form posts whatever is checked; the server rejects an empty post. Helpers: `describePerItem`, `bundleItems`, `totalCentsOf`.

Look (Phase 3, T160): the `<section>` is a white `Card` (`padding="md"`); each image link is a bordered white tile; the plus separators sit in small grey circles (decorative); the checkbox fieldset is a light-grey band; "Add selected to cart" is the primary pill `Button`. Structure and behaviour unchanged.

Usage (PDP): `<FrequentlyBoughtTogether bundle={bundle} action={addManyToCart} />` and `<ProductRail title="Customers also viewed" products={alsoViewed} />` (renders nothing when empty).

### FilterSidebar (T79, v3 T157)

Server-safe; import `@/components/organisms/FilterSidebar`. Listing filters as ONE `<form method="get" action={safeListingBase(base)}>` that works without JS.

| Props | |
| --- | --- |
| `facets: FacetCounts` | `ListingResult.facets` (type-only import) |
| `params: ListingParams` | normalised listing state (T91 parser; non-managed params in `extra`) |
| `base: string` | listing path, e.g. "/search" (unsafe values fall back to "/") |
| `labels: { brand?; category? }` | slug -> name for the active-filter chips |
| `showCategoryFacet?: boolean` (true) | category links group |
| `resultCount?: number` | shown next to "Active filters" |
| `dealsCount?: number` | deals count; absent = `facets.deals` (required on `FacetCounts` since CONS-B5). The Deals group renders only when > 0 or `deals` is applied |
| `defaultSort?: ListingSort` | route default sort (CONS-B1): only this sort is omitted from the hidden inputs and the Reset link, so a chosen `featured` survives Apply/Reset on /best-sellers, /new-arrivals, /top-rated |
| `headingLevel?: 2 \| 3 \| 4 \| 5 \| 6` | level of a "Filters" heading at the top of the inline panel; absent = no heading (contract L-5: the toolbar adds no headings). The Drawer always has its own `h2` title |
| `toolbarEnd?: ReactNode` | rendered after the Filter pill in the same row, right-aligned (`SortSelect`, view toggle); outside the details, so forms never nest (contract L-9) |
| `id?`, `className?` | on the outer wrapper only |

Structure: `ActiveFilters` (links) -> form: hidden inputs `filterHiddenEntries(params)` (`q`, `dept`, `category`, `sort`, `view`, `extra`; `page` dropped) -> Category (`FacetGroup kind="links"`) -> Brand (checkbox) -> Customer review (radio, "Any" posts empty) -> Price (`PriceFacet`, presets + min/max whole dollars) -> Availability (checkbox `instock=1`, count `facets.inStock`) -> Deals (checkbox `deals=1`) -> "Apply filters" (the only submit) + "Reset" link (`filterResetHref`: keeps `q`/`sort`/`view`/`dept`/`extra`, drops every facet and `page`). A group with no bucket that is selected or has count > 0 is omitted (price also stays while `min`/`max` is applied). Category is links (it navigates by itself, so unapplied checkbox changes are lost on a category click) and therefore rides along as a hidden input on Apply.

Layout (v3, T157): one toolbar row: `<details data-filter-panel>` (closed by default) whose `<summary>` is the outlined "Filter" pill (filter icon + `FILTER_SUMMARY_LABEL` + an accent count `Badge data-filter-badge` = `filterBadgeText(activeFilterCount(params))`, no badge at 0; price range counts once), then `toolbarEnd`. The details panel holds `<aside aria-label="Filters">` (optional heading + the panel) as an overlay under the row (`absolute`, full width below `lg`, `w-96` from `lg`, `z-dropdown`). No JS: the details opens/closes natively at every width and Apply posts the GET form. After hydration (`FilterDrawerToggle`, `"use client"`): from `lg` (`FILTER_PANEL_DESKTOP_QUERY` = `(min-width: 64rem)`) the details toggles natively and Escape inside it closes it and focuses the pill; below `lg` the pill click is cancelled (details kept closed) and a left `Drawer` titled "Filters" opens with the same panel, mounted only while open (Escape / Close / backdrop close it, focus returns to the pill). While the Drawer is open two panel instances exist; ids come from `useId`, so none collide. No `matchMedia` = desktop behaviour. Helpers: `filterHiddenEntries(params, opts?)`, `filterResetHref(base, params, opts?)`, `activeFilterCount`, `filterBadgeText`, `filtersButtonLabel` (Phase 2 "Filters (N)" label, kept for callers), `hasAvailableBucket`, `isDesktopViewport`.

Sort is not inside the panel: the listing passes `SortSelect` through `toolbarEnd` (or renders it itself); the current sort is preserved as a hidden input.

### OrderSummary v2 (T83)

Server-safe (no `"use client"`; `renderToStaticMarkup` works). Additive over the MVP row above: every MVP prop and behaviour is unchanged (total is DISPLAYED as given; 0 shipping reads "Free"). One component feeds cart, checkout, confirmation, order detail and invoice from plain data (`OrderView`, `Totals`, cart view fields map 1:1).

| Optional props | |
| --- | --- |
| `discountCents?: number`, `couponCode?: string \| null` | row "Discount (WELCOME10)" (or "Discount") shown only when > 0; value "−$5.50" (the minus is `aria-hidden`, a visually hidden "minus" is read) |
| `shippingMethodName?: string \| null`, `isFreeShipping?: boolean` | method name next to the price in the Shipping row; "Free" (text) when `isFreeShipping` or shipping is 0. `isFreeShipping` is display-only: pass `shippingCents={0}` too |
| `deliveryNote?: string \| null` | "Delivery note" as React text (`whitespace-pre-line break-words`); absent when blank |
| `estimatedDelivery?: { start; end } \| null` | "Estimated delivery" via `formatDeliveryRange` (en-US, UTC); invalid ranges omitted |
| `variant?: "default" \| "invoice"`, `invoice?: { orderId; placedAt; status; paymentLast4?; billToName?; shipTo? }` | invoice adds a header `<dl>`: order number (`font-mono`), "Order placed" (en-US UTC long date), humanised status, "Paid with card ending in 4242" (only for exactly 4 digits), bill-to, ship-to lines; lines also show the unit price. `invoice` is ignored in the default variant |
| line fields `productSlug?`, `imageUrl?` | accepted so `OrderViewItem` can be passed directly; not rendered |

No interactive controls in either variant (no links/buttons/forms), so the invoice page can print the region as is; no `print:` utilities are used (none exist in the project; the page owns print CSS). Rendering rules: invalid amounts (NaN, floats, negatives, non-numbers) display as $0.00 and quantities as 0, so "NaN" never renders; amounts beyond `Number.MAX_SAFE_INTEGER` (or +Infinity) display "—" plus a visually hidden "unavailable" instead of throwing. The exact recomputation `sum(unit × qty) + shipping − discount` (`computeOrderSummaryTotal`, `multiplyCents`/`sumCents`, discount > gross clamps to 0) is exposed as `data-total-check="match" | "mismatch" | "unavailable"` on the section for tests/QA; the server total is still what is shown. Helpers exported from the index: `computeOrderSummaryTotal`, `checkOrderSummaryTotal`, `toDisplayAmount`, `toDisplayQuantity`, `formatPlacedDate`, `formatStatus`. 320px: rows wrap, the coupon label uses `wrap-anywhere`, the invoice header is one column below `sm`.

Usage: `<OrderSummary items={order.items} subtotalCents={order.subtotalCents} discountCents={order.discountCents} couponCode={order.couponCode} shippingCents={order.shippingCents} shippingMethodName={order.shippingMethodName} totalCents={order.totalCents} currency={order.currency} deliveryNote={order.deliveryNote} estimatedDelivery={order.estimatedDelivery} />`.

### SiteHeader v2 (T80)

Server-safe and presentational (no `"use client"`; `renderToStaticMarkup` works). The root layout's `src/app/_layout/HeaderShell.tsx` feeds it. Every prop added in v2 is optional; with only `cartCount` it renders the MVP header (skip link, sticky banner, `Main` nav with Catalog + Cart), so the T17 tests still hold. Interactive parts are client molecules (DepartmentMenu, SearchBox) and the `AccountMenu` flyout (client, in this folder). All of them render working links or GET/POST forms in the server HTML, so the header works without JavaScript.

| Props | |
| --- | --- |
| `cartCount: number` | invalid values become 0. Cart link name "Cart, N items" ("1 item"); the badge shows "99+" above 99 |
| `storeName?` ("Storefront") | home link; the layout passes `SITE_NAME` |
| `departments?: DepartmentInput[]` | from `categoryTree()`. When given (even `[]`), shows the "All" `DepartmentMenu` (without JS it is a link to `/products`) and `SearchBox` (GET `/search?dept=&q=`; below `md` the search takes its own row) |
| `popularSearches?` | passed to SearchBox |
| `account?: HeaderAccount` | `{ status: "guest" }` or `{ status: "signed-in", displayName, signOutAction }`. Omitted = no account block |
| `accountNav?` (`ACCOUNT_NAV`), `authNav?` (`AUTH_NAV`) | flyout links (also passed to DepartmentMenu) |
| `utilityLinks?: HeaderNavLink[]` (`[{ Catalog, "/" }]`) | Main nav links before the cart. With `icon`, the label is `sr-only` below `sm` (icon only on screen, name kept) |
| `primaryNav?` | `<nav aria-label="Shop">` row. Hrefs already in row 1 (utility links, `/cart`) are skipped |
| `promo?: { message?, coupon? }` | text-only strip: message + "Use code CODE for <description>". The code must match `[A-Z0-9_-]{1,32}` or it is dropped |
| `currentPath?` | `aria-current="page"` on matching links (the layout cannot pass it) |

Account block (`AccountMenu`): a link ("Hello, <name>" goes to `/account`; "Hello, Sign in" goes to `/signin`). Its accessible name is "Hello, <full name>, Account & Lists". On screen the name is cut to 20 code points plus "…". The name is cleaned of control characters and rendered as text only. Next to it is a `Disclosure` (native `<details>`, closed in the HTML) named "Account menu". Signed-in users see `ACCOUNT_NAV` plus `<form action={signOutAction}>` "Sign out"; guests see `AUTH_NAV`. With JS it closes on Escape (focus returns to the summary), on a pointer press outside, and when a panel link is clicked. The panel is `absolute` against the header row (`relative`): full width under the row on small screens, and `sm:w-72` right-aligned from `sm`.

Every rendered href passes `isAllowedInternalHref` (`allowedLinks` drops other hrefs, empty labels and duplicates). Landmarks: skip link first (outside the banner), one `<header>`, `nav "Main"`, optional `nav "Shop"`, and SearchField's `role="search"`. The v2 header sticks only from `lg` (`lg:sticky lg:top-0`) so its 2 to 3 rows never cover a phone screen; the MVP header keeps `sticky top-0`. Helpers (`header-model.ts`, re-exported): `normalizeCartCount`, `cartAccessibleName`, `visibleCartCount`, `cleanDisplayName`, `truncateDisplayName` (both re-exported from `src/lib/display-name.ts` since CONS-B4 bh; ZWNJ/ZWJ between visible characters are kept, other `\p{Cf}` removed), `allowedLinks`, `isCurrentPath`, `couponPromoParts`.

### SiteHeader v3 (T148)

Same component and props as v2 plus `categoryNav?: CategoryNavItem[]`, `categoryNavLeading?: { label, href }` and `benefits?: { label, items: BenefitItem[] }`. The layout shell (`src/app/_layout/HeaderShell.tsx`) passes `departments`, `popularSearches`, `account`, `utilityLinks` (Lists only), `categoryNav={DEPARTMENT_NAV}`, `categoryNavLeading` (Deals → `/deals`) and the benefits built by `src/app/_layout/header-benefits.ts`. It no longer passes `primaryNav` or `promo`; both still render (optional legacy "Shop" nav and promo strip) when a caller passes them.

Structure: skip link (first focusable, outside the banner), then one `<header>`:
1. Row 1 (`relative flex flex-wrap`): wordmark link (`storeName` text inside `text-accent`, `/`), then the pill `SearchBox` without the department select (`departments` not passed; `role="search"` named "Site search"; `order-last basis-full` below `md`, so it gets its own row 2 on phones), then a plain `<ul>` (`data-testid="header-actions"`, **not** a nav landmark) with the AccountMenu, utility links, a phone-only account icon link and the cart, then the "All" `DepartmentMenu` (`md:hidden`; its drawer holds `nav "Departments"`; without JS it is a link to `/products`). When `departments` is given, the account block and utility links are `hidden md:block` (the drawer lists account/sign-in links), so below 768px row 1 is wordmark, account icon, cart, menu button. The account icon link (`md:hidden`, 44px, `data-testid="header-mobile-account"`) goes to `/signin` (name "Sign in") or `/account` (name "Your account") and works without JS; it renders only when `account` and `departments` are both given. The visible "Cart" word is hidden below `sm`; the count badge ("99+" cap) and the sr-only "Cart, N items" stay.
2. CategoryNav row (`hidden md:block`): `nav "Primary"`, the optional leading link (Deals) first, then one link per department, "More" `<details>` after 9. `aria-current` comes from `currentPath` (`/category/<slug>`, `categorySlugFromPath`); the layout cannot pass it, so none is marked there.
3. Optional legacy Shop nav / promo strip.
4. Benefits strip (`BenefitsStrip`, named list, scrolls inside its own container at every width). Shown only when an item has a non-blank label.

Landmark names on a page: `banner`, `Primary`, `Departments` (when the drawer is open), `Site search`. No "Main" or "Shop" nav from the shell. No theme toggle. Every href passes `isAllowedInternalHref`.

### BuyBox, AddedToCartToast (T78, v3 restyle T159)

**BuyBox** (server-safe; import `@/components/organisms/BuyBox`). PDP purchase panel: white `Card` tile (`as="section"`, raised, soft border, `shadow-sm`, `rounded-lg`, `p-4 sm:p-5`, `min-w-0`), `<section aria-labelledby>` with a visually hidden "Buying options" heading. Reference pending (no PDP screenshot); follows the listing reference's style language.

| Props | |
| --- | --- |
| `product: BuyBoxProduct` | `Pick<Product, id \| slug \| name \| priceCents \| currency \| stock>` + `listPriceCents?`, `brandName?` (`ProductDetail` fits) |
| `actions` | `{ addToCart: CartActionFn; buyNow: CartActionFnV2; addToList: ListActionFn; removeFromList: ListActionFn; subscribeStockAlert: StockAlertActionFn; unsubscribeStockAlert?: StockAlertActionFn }` (pass the server actions directly) |
| `viewer` | `{ inWishlist; wishlistId?; lists?; alertRegistered; alertId? }` (server truth) |
| `delivery` | `{ estimate: { start; end } \| null; methodName?; isFree?; freeShippingNote? }` |
| `promotedCoupon?: { code; description } \| null` | PriceBlock coupon line |
| `shareUrl?: string \| null` | `ShareLink` only when non-empty |
| `compare?: { selected; basePath? } \| null` | `CompareToggle` only when given |
| `headingLevel?: 2 \| 3` (2), `sellerName?` (`SITE_NAME`), `className?` | |
| `sticky?: boolean` (false) | `lg:sticky lg:top-4 lg:self-start` from 1024px only; enable only when the column is taller than the box (no internal scroll, never clipped). Descendants always get `scroll-mt-4`/`scroll-mb-4` (P-14) |

Order (v3): price group `data-slot="buy-box-price"` = `PriceBlock` (`size="lg"`, `display="superscript"`, `layout="inline"`: price in deal colour on sale, struck `<s>` "Was $X", "N% off") + `SavingBadge` ("Save $X (Y%)", percent floored; nothing when list <= price or invalid) + coupon line "Save with code CODE: description" (text, only when both trimmed parts are non-empty; `data-slot="buy-box-coupon"`, `flex items-start`: the tag icon is `shrink-0` beside a `flex-1 min-w-0` text span so the icon never sits alone on a line, T180/U10) -> `StockUrgency` (the single stock pill; no separate `StockBadge`, so "In stock" appears once) -> `DeliveryEstimate` -> in stock: `BuyBoxPurchase` (client: ONE `AddToCartForm` variant "buybox" with "Add to cart" + "Buy Now" (`formAction`), stepper max `min(stock, BUY_BOX_MAX_QUANTITY = 10)`, plus `AddedToCartToast`) / out of stock (stock normalised; NaN/negative/fraction = 0): no quantity/add/buy, `StockAlertForm` instead -> `WishlistButton` (variant "button", `fullWidth`) -> row `data-slot="buy-box-secondary"` (only when either is given) with `CompareToggle?` + `ShareLink?` -> trust lines with decorative `lock`/`refresh`/`truck` icons ("Secure transaction", "Free returns within 30 days (sample policy)", "Ships from <seller>"). All product text is React text.

Usage (PDP): `<BuyBox product={detail} actions={{ addToCart, buyNow, addToList, removeFromList, subscribeStockAlert, unsubscribeStockAlert }} viewer={...} delivery={...} shareUrl={`/products/${detail.slug}`} />`.

**AddedToCartToast** (client; import `@/components/organisms/ToastRegion`). Renders nothing. `trigger: { count: number; description?: string } | null`, `cartHref?` ("/cart"; must pass `isAllowedInternalHref`, else "View cart" goes to "/cart" — `safeCartHref`), `navigate?` (default `window.location.assign`). Each time `count` increases (safe integer) it calls `useToast().toast({ title: "Added to cart", description, tone: "success", action: { label: "View cart" } })`: polite region, 6 s auto-dismiss, no focus move. Without a `ToastProvider` it is a no-op (never throws). The layout (T80) supplies the provider.

### CartTable v2 + SavedForLaterSection (T82)

Client; import `@/components/organisms/CartTable`. Every MVP prop and behaviour is unchanged (empty state, warnings, polite totals live region, checkout link only when `canCheckout` AND every line status is `"ok"`; the UI keeps this stricter rule even though the service's `canCheckout` only excludes unavailable lines).

| Added optional props | |
| --- | --- |
| `saved?: { items: readonly SavedForLaterLine[]; listId: string \| null; actions: SavedForLaterActions; headingLevel?: 2 \| 3 }` | Renders `SavedForLaterSection` below the cart (also under the empty state). Hidden when `items` is empty |
| `saveForLaterAction?: CartActionFnV2` | `saveForLater`; adds a "Save for later" form to every line |
| `thumbnails?: boolean` (false) | 64px `Image` per line, alt = product name |
| `emptyState?: ReactNode` | Rendered under "Your cart is empty" (e.g. a recommendations rail) |
| `cart.items[i].listPriceCents?: number \| null` | `CartTableLine` = `CartLineItemData` + optional list price; "You save $X" per line when above the unit price |
| `hideSummary?: boolean` (false; T108) | Omits the built-in summary box (subtotal, warning, checkout and continue links) so the page can render `CartSummary` beside the lines. Default markup is byte-identical to before |

Lines now always get `lineTotal="computed"` (visible "Line total: $X", unit x billable quantity in exact integer cents; matches the service's `lineTotalCents`) and a product link (`/products/<slug>`, plain text for an empty slug).

`SavedForLaterSection` props: `items`, `actions: { moveToCart: CartActionFnV2; removeSaved: ListActionFn /* removeFromList */; addToList?: ListActionFn }`, `saveForLaterListId: string | null` (null hides Delete), `headingLevel?: 2 | 3` (2), `className?`. Empty -> only an empty polite live region (count changes, including "Saved for later is empty", are announced). Each row: thumbnail, name link, current `Price`, "Price dropped by $X", availability text ("In stock" / "Out of stock" / "No longer available" for a vanished product), then plain forms: "Move to cart" (hidden `productId`; disabled "Unavailable" button described by the availability text when not in stock), "Delete" (hidden `listId` + `productId`), optional `WishlistButton variant="button"` (add to the default Wish List; its remove path reuses `removeSaved`). Accessible names: "Move to cart: <name>", "Delete: <name>". Move errors (e.g. OUT_OF_STOCK) and delete errors (`listErrorMessage`) show in a row-level `role="alert"`. Helpers: `savedAvailability`, `SAVED_AVAILABILITY_TEXT`, `priceDropText`, `savedHeading`, `savedProductHref`.

```tsx
<CartTable cart={data} updateQuantity={updateCartQuantity} removeItem={removeFromCart}
  saveForLaterAction={saveForLater} thumbnails emptyState={<ProductRail title="Recommended" products={recs} />}
  saved={{ items: view.saved, listId: saveForLaterListId, actions: { moveToCart, removeSaved: removeFromList, addToList } }} />
```

### T88

Home page sections. All four are server-safe (no `"use client"`; they compose the client `Image` atom only through molecules or for brand logos), render `null` on empty/invalid data, render every string as React text, and only emit hrefs that pass `isAllowedInternalHref`. Each labelled section takes an optional `id` (heading id `<id>-heading`, else `useId`), so `aria-labelledby` is unique even with repeats. Default headings are distinct: "Deal of the day", "Shop by category", "Featured brands", "Coupon of the week".

**HomeHero** (`@/components/organisms/HomeHero`)

| Props | |
| --- | --- |
| `slides?: HeroSlide[] \| null` | **v3 (T151).** Slides from the home content/loader, rendered by the `HeroBanner` carousel (`@/components/molecules/HeroBanner`). Unusable slides dropped (`normaliseHeroSlides`), at most `HOME_HERO_MAX_SLIDES` (3). 0 usable slides -> `null` (deal panel included). 1 slide: no dots. No autoplay |
| `label?` | Carousel region name from content (default HeroBanner "Featured offers") |
| `headingLevel?: 1 \| 2` (**1**), `id?` (`HOME_HERO_ID` = `home-hero`), `className?` | The region is `#home-hero` (`role="region"`, `aria-roledescription="carousel"`); the first slide headline is the page's single `<h1>` (later slides `<h2>`); the deal heading is one level below. A non-identifier `id` falls back to `home-hero`; the deal heading id is `<id>-deal-heading` |
| `deal?: { title; priceCents; listPriceCents?; currency; href; endsAt? } \| null` | "Deal of the day" panel: `<section aria-labelledby>`, name, `PriceBlock display="superscript"` (deal badge, "You save $X (Y%)" when list > price), "Ends <date>" (`<time>`, UTC, valid ISO 8601 only), one "View deal" button link to the PDP. Blank title, invalid cents/currency or disallowed href drops the panel |
| `banner?: { title; subtitle?; cta?; secondaryCta?; image?: { url; alt }; eyebrow?; tone? } \| null` | **Deprecated** Phase 2 input, used only when `slides` is null/undefined: `bannerToHeroSlide` maps it onto ONE slide (title -> headline, subtitle -> subline, cta, image 800x600 or `HERO_PANEL_ART` (descriptive alt), tone inverse/accent-subtle/raised -> inverse/accent-subtle/neutral). `eyebrow` and `secondaryCta` are ignored. Remove once T165/T166 pass `slides` |

Layout: stacked at 320px; with a deal, the carousel spans 2 of 3 columns from `lg`. Exports `resolveHomeHeroSlides(slides, banner?)`, `bannerToHeroSlide`, `normaliseDeal`, `HOME_HERO_ID`, `HOME_HERO_MAX_SLIDES`, `DEAL_HEADING`. Helpers in `home-format.ts`: `parseIsoDate`, `formatIsoDate`, `tryFormatMoney`, `isSupportedCurrency`, `cleanText` (pure, never throw). `tryFormatMoney(cents, currency)` returns null for invalid cents and for any code not in `Intl.supportedValuesOf("currency")` (a well-formed but unknown code such as "ZZZ" is rejected, D-T88-1); `isSupportedCurrency(code)` is exported for that check (upper-case codes, list computed once).

**CategoryRail** (T152, `@/components/organisms/CategoryGrid`; the deprecated `CategoryGrid` alias was removed in FIX-P3-pages (cj), the folder name stays)

| Props | |
| --- | --- |
| `categories: readonly { slug; name; image?; imageUrl?; productCount? }[]` | `Category` / `CategoryWithCount` rows fit directly (`image`/`imageUrl`/`productCount` are accepted but unused). One circular `CategoryTile` atom (`shape="circle"`, `size="lg"`) per department in data order, linking `categoryRailHref(slug)` = `/category/<encoded slug>`; art = `getCategoryTileArt(slug).path` (department slug -> its department tile; any other slug, e.g. a department page's leaf categories, -> a stable per-slug discovery pattern, T179 U13; blank slug -> `FALLBACK_TILE_ART`, but blank slugs are dropped anyway; the "All departments" tile keeps `FALLBACK_TILE_ART`), `alt=""`, link name = department name. Blank slug/name, duplicate slug or a disallowed href drops the tile. More than `CATEGORY_RAIL_MAX_TILES` (12) valid tiles: first 12 + trailing "All departments" tile -> `/products` (ruling O-3, no `/departments` route). No valid tile -> `null` (no empty heading) |
| `title?` ("Shop by department"; blank -> default), `headingLevel?: 2 \| 3` (2), `id?` (home passes `home-categories`), `className?` | |

`<section aria-labelledby>` -> heading -> `ScrollRail` (`itemWidth="sm"`, `gap="sm"`, region name "<title>, category list", `tabindex="0"`, arrow buttons only after hydration). Tiles contain no headings. Helpers `categoryRailTiles`, `categoryRailHref`; constants `CATEGORY_RAIL_DEFAULT_TITLE`, `CATEGORY_RAIL_MAX_TILES`, `CATEGORY_RAIL_ALL_LABEL`, `CATEGORY_RAIL_ALL_HREF`. Server component.

**CategoryDiscovery** (T152, `@/components/organisms/CategoryDiscovery`)

| Props | |
| --- | --- |
| `categories: readonly { slug; name }[]` | Child categories (e.g. of the top department by product count; the loader picks them, T165). Up to `CATEGORY_DISCOVERY_MAX_TILES` (6) valid, de-duplicated tiles in input order; each is ONE `CategoryTile` atom link (`shape="card"`, `size="lg"`) to `/category/<encoded slug>`, art `getCategoryTileArt(slug).path` (T179 U13: the same per-category art as the department page's `CategoryRail`, stable per slug; department slugs get their department tile, blank slugs `FALLBACK_TILE_ART`), `alt=""`. Invalid slugs/names dropped; none left -> `null` |
| `title?` ("Explore popular categories"), `eyebrow?` ("Discover something new"; blank hides it), `id?` (`home-discovery`, contract H-13), `className?` | |

`<section aria-labelledby>` -> eyebrow `<p>` (small, secondary) + `h2` -> `ScrollRail` (`itemWidth="auto"`, region name "<title>, category list"). Tiles contain no headings. Helper `categoryDiscoveryTiles`. Server component.

**BrandStrip** (`@/components/organisms/BrandStrip`)

| Props | |
| --- | --- |
| `brands: readonly { slug; name; logo? }[]` | `Brand` / `BrandWithCount` fit. Links to `brandHref(slug)` = `/brand/<encoded slug>`; logo shown via `Image` with `alt = name`, else the name as text. Invalid/duplicate entries dropped; none left -> `null` |
| `title?` ("Featured brands"), `headingLevel?: 2 \| 3` (2), `id?`, `className?` | |

T155 restyle: `<section aria-labelledby>` -> heading -> scroller `div` (`BRAND_STRIP_SCROLLER_CLASSES`: `overflow-x-auto max-w-full`, visible from `sm`) -> `<ul role="list">` (`BRAND_STRIP_LIST_CLASSES`: one no-wrap row `w-max min-w-full flex-nowrap` with `p-1` focus room below 640px, so 320px scrolls inside the strip, not the page; wraps from `sm`). Each `li` (`shrink-0 max-w-xs`) holds ONE rounded white tile link (`Link variant="nav"`: `min-h-touch min-w-touch`, `rounded-lg border-border-default bg-surface-raised shadow-sm`, hover `shadow-md`). Link text is only the name (or the logo `img` with `alt` = name). Props unchanged. Helpers `brandHref`, `brandStripItems`. Home position: after category discovery (ruling O-1), id `home-brands`.

**ServicesBand** (T155, `@/components/organisms/ServicesBand`)

| Props | |
| --- | --- |
| `tiles?: readonly ServiceTileItem[]` | `{ id?, label, href, icon? }` from a content module (T165). Defaults to `SERVICES_BAND_DEFAULT_TILES` (Track my order `/orders`, Returns and refunds `/returns`, Shipping and delivery `/shipping`, Help centre `/help`, FAQ `/faq`, Contact us `/contact`; hrefs typed `StaticPlannedRoute` from `routes.ts`, each has a page). Normalised once with `normaliseServiceTiles` (blank labels / non-allow-listed hrefs dropped, one dev warning each); none left -> `null` (no heading, no notice) |
| `heading?` (`SERVICES_BAND_DEFAULT_HEADING` = "Customer services", contract H-21; blank falls back), `headingLevel?: 2 \| 3` (2), `headingVisuallyHidden?` (true: the reference shows no title) | |
| `notice?: { text; linkLabel?; href? } \| null` | One-line notice (contract H-21). `undefined` -> `SERVICES_BAND_DEFAULT_NOTICE` ("Thinking about a return or refund? Read our returns and refunds policy" -> `/returns`); `null` -> none. Blank text drops it; blank label or non-allow-listed href drops only the link (dev warning). `noticePlacement?: "before" \| "after"` ("after"; the reference shows it above the band) |
| `tone?` (`accent-subtle` default \| `sunken`, passed to ServiceTiles), `id?` (`home-services`; heading id `<id>-heading`, else `useId`), `className?` | |

`<section aria-labelledby>` -> `h2` (sr-only by default) -> `ServiceTiles` band (no heading of its own, so it is a `div`; 2/3/6 grid) -> `<p>` notice on `bg-surface-sunken` (`text-small text-text-primary`, link `Link variant="nav"` 44px, underlined). All text is React text. Helper `resolveServicesBandNotice`. Server component.

```tsx
<ServicesBand id="home-services" tiles={HOME_SERVICE_TILES} notice={HOME_SERVICES_NOTICE} />
```

**PromoBanner** (`@/components/organisms/PromoBanner`)

| Props | |
| --- | --- |
| `coupon: { code; description; minSubtotalCents?; endsAt?; currency? } \| null` | **Coupon mode.** A `ValidatedCoupon` from `couponService.listPromoted()` fits. Code trimmed + upper-cased and must match the coupon charset (1-32 `[A-Za-z0-9_-]`), else `null` |
| `cartHref?` ("/cart"; a disallowed value falls back to "/cart" with a dev warning), `title?` ("Coupon of the week"), `headingLevel?: 2 \| 3` (2), `tone?: PromoTone` ("primary-subtle"; unknown → neutral), `id?` (root id; heading id `<id>-heading`), `className?` | coupon mode only |
| `promo: { heading; blurb?; cta: { label; href }; image?; imagePosition?: "start" \| "end"; tone?: PromoTone } \| null` | **Banner mode** (T154) when a `promo` prop is passed. Renders a `PromoStrip` (`<section aria-labelledby>`). Omitted (null) when missing, heading blank, or the CTA is missing/blank/fails `isAllowedInternalHref` (contract H-order 6). Default tone "primary-subtle" |
| `headingLevel?: 2 \| 3 \| 4` (2), `id?`, `priority?` (eager image), `className?` | banner mode only |

Coupon mode (Phase 2 behaviour unchanged): `<aside aria-labelledby>` (complementary; one per page) on the PromoStrip surface (`Card as="aside" radius="xl" padding="lg"`, tone via `promoToneStyle`): heading, "Use code <code>CODE</code> at checkout" (monospace), description text, conditions list "Minimum order $X" (only when `minSubtotalCents` is a positive safe integer, supported currency) and "Ends <date>" (valid ISO via `parseIsoDate`), "Go to cart" button link. No stretched-link overlay, so the code stays selectable. Banner mode: delivery promo (`image={DELIVERY_PROMO_ART}`), split beauty banner (`image={BEAUTY_PROMO_ART} imagePosition="start"`), sign-up / "never miss a deal" strips; copy from `content/home.ts` (T165). Helpers `normalisePromoCode`, `promoConditions`, `normalisePromoBannerContent`.

**PromoBannerPair** (same module, contract H-19): `<PromoBannerPair promos={[newArrivals, topRated]} id="home-promo-pair" heading? showHeading? className? />` → `<section aria-labelledby>` with an `h2` (visually hidden unless `showHeading`; default "More to explore") and a `ul` (1 column, 2 from `lg`) of two `PromoStrip`s with `h3`. Invalid promos dropped; first `PROMO_PAIR_SIZE` (2) valid render; fewer than 2 valid → `null`. Helper `promoPairItems`.

Usage (T166): `<PromoBanner promo={home.shippingPromo} id="home-shipping-promo" />`, `<PromoBanner promo={home.lifestyleBanner} id="home-lifestyle-banner" />`, `<PromoBannerPair promos={home.promoPair} id="home-promo-pair" />`.

Usage (home, T166): `<HomeHero slides={data.heroSlides} label={HERO_LABEL} deal={dealOfTheDay} />` (Phase 2 `banner={HOME_BANNER}` still compiles), `<CategoryRail categories={departments} id="home-categories" />` + `<CategoryDiscovery categories={children} />`, rails, `<BrandStrip brands={brands} />`, `<PromoBanner coupon={promoted[0] ?? null} />`.

### LifestyleBanners (T154)

**LifestyleBanners** (`@/components/organisms/LifestyleBanners`), server component.

| Props | |
| --- | --- |
| `items: readonly { heading?; blurb?; cta: { label; href }; image?; tone? }[] \| null` | Cards whose CTA is missing/blank/fails `isAllowedInternalHref` are dropped (dev warning); at most `columns` render; fewer than 2 valid → `null` (T154 AC2, contract H-17) |
| `columns: 3 \| 4` | Grid 4/2/1 or 3/2/1 (`lg` / `sm` / base; one column at 320px). Junk → 4 |
| `heading?` ("Explore more ideas" when blank), `eyebrow?`, `headingLevel?: 2 \| 3` (2; cards one level below), `id?` (heading id `<id>-heading`), `className?` | |

`<section aria-labelledby>` → optional eyebrow `<p data-eyebrow>` (small, secondary) + heading → `<ul role="list">` of `LifestyleCard as="li"` (one link each, decorative lazy images; no `tone` = plain card). Helpers `lifestyleBannerItems`, `normaliseLifestyleColumns`, `LIFESTYLE_BANNERS_GRID_CLASSES`.

Usage (T166): `<LifestyleBanners items={home.lifestyleCards} columns={4} heading="…" eyebrow="…" id="home-lifestyle-cards" />` (`image: LIFESTYLE_ART.living` etc.); 3-column set: `columns={3}` with `LIFESTYLE_THREE_COLUMN_KEYS`.

### ListView (T85)

Server-safe wish list page body (import `@/components/organisms/ListView`). One component, discriminated by `mode`. The interactive parts are the molecules (`ListItemRow`, `ShareListPanel`) and small client islands in `ListViewIslands.tsx` (`RenameListForm`, `DeleteListForm`, `AddAllToCartForm`, `ListSwitcher`, `SharedListItemRow`). Every mutation is a `<form action>` that works without JS (SR2). List names and notes are rendered only as React text (SR3).

| Props (`mode: "owner"`) | |
| --- | --- |
| `list: ListView` | from `listService.getList(ownerKey, id, sort)` |
| `otherLists: readonly { id; name; itemCount; kind }[]` | the viewer's lists; the current one is filtered out. Used for the switcher and as ListItemRow move targets |
| `sort: ListSort`, `basePath: string` | `basePath` = `/lists/<id>`; an unsafe value falls back to `/lists/<list.id>` |
| `actions: { renameList; deleteList; setListSharing; addAllToCart; updateListItem; removeFromList; moveListItem: ListActionFn; addToCart?: (formData) => void \| Promise<unknown> }` | from `src/app/actions/lists.ts`; `addToCart` is optional (per-row "Add to cart" posts `productId`) |
| `siteUrl?`, `headingLevel?: 1 \| 2` (1), `addAllResult?: ListActionState`, `className?` | `addAllResult` becomes the add-all form's initial state |

| Props (`mode: "shared"`) | |
| --- | --- |
| `shared: SharedListView`, `sort: ListSort`, `basePath: string` (`/lists/shared/<token>`), `headingLevel?`, `className?` | `list` / `actions` / `otherLists` are typed `never` |

Owner structure: `<section aria-labelledby="list-view-heading">` -> header (name heading, `Badge` "Default" / "Saved for later" / "Shared", "N items · $X") with, for wish lists only, "Rename list" `Disclosure` (form: hidden `listId`, `name` maxLength 60) and "Delete list" (JS: button + confirm `Dialog` posting `confirm=yes`; server markup / no JS: a disclosure with a required `confirm=yes` checkbox) -> `ShareListPanel` -> toolbar: GET sort form (`<form method="get" action={basePath}>`, `select name="sort"`, "Apply"), other-lists switcher (no JS: `nav` of links to `/lists/<id>`; after hydration a `Select` + "Go"), "Add all to cart (N)" (N = items whose product exists and is in stock; disabled at 0) with results from `perItem` as text ("Added: A, B. Out of stock: C.") -> "Items" heading + `<ul role="list">` of `ListItemRow`s, or the empty state ("This list is empty", links to `/products` and `/best-sellers`). Sort form and add-all are hidden for an empty list. The only-wish-list delete is not hidden: the action's FORBIDDEN message shows in `role="alert"`.

Phase 3 look (T156): kind badges are pills; the toolbar (sort form, other-lists switcher, add-all) sits in a raised `Card` (`data-slot="list-toolbar"`); "Apply"/"Go" are `outline` pill buttons; the no-JS other-lists links and the shared sort links are `Chip as="a"` pills (44px); the empty state is a sunken `Card` with pill button links; "View product" is an `outline` `sm` pill. Markup roles, forms, field names and hrefs unchanged.

Shared structure: name heading, "N items", sort as plain GET links (`?sort=`, default omitted, `aria-current` on the active one; hidden when `basePath` is unsafe), read-only rows (`ListItemRow readOnly`) each followed by a "View product" button link to the PDP. No `<form>`, no inputs, no list ids, no badges, no owner data.

Helpers (`list-view-model.ts`): `LIST_SORT_OPTIONS`, `normaliseListSort`, `sortHref`, `safeListBase`, `listHref`, `productHref`, `addableCount`, `listTotalText`, `describeAddAllResults`. Every href passes `isAllowedInternalHref`.

Usage: `/lists/[id]`: `<ListView mode="owner" list={view} otherLists={lists} sort={sort} basePath={`/lists/${view.id}`} actions={{ renameList, deleteList, setListSharing, addAllToCart, updateListItem, removeFromList, moveListItem }} />`; `/lists/shared/[token]`: `<ListView mode="shared" shared={view} sort={sort} basePath={`/lists/shared/${token}`} />`.

### CartSummary (T92)

Server-safe (no `"use client"`; `renderToStaticMarkup` works); import `@/components/organisms/CartSummary`. Right-hand cart panel: `<aside aria-labelledby>` "Order summary" composed of `SummaryRow`, `FreeShippingProgress`, `CouponForm` (compact) and `ShippingMethodPicker`. The component never renders a `<form>` itself: the coupon form (apply, or remove when applied) and the shipping form are siblings, so both round-trip without JS.

| Props | |
| --- | --- |
| `cart: CartSummaryCart` | The `getCartView()` result fits as is (`CartViewV2`); a trimmed copy with `items` (`productId, quantity, unitPriceCents, status, availableStock`), `itemCount`, `canCheckout`, `currency?`, `saved` (only counted), `coupon`, `couponNotice`, `shipping`, `shippingOptions`, `totals` also works |
| `actions: { applyCoupon; removeCoupon; setShippingMethod }` | `CartActionFnV2` each: `applyCoupon`, `removeCoupon`, `selectShippingMethod` from `src/app/actions/cart.ts` |
| `checkoutHref?` ("/checkout"), `currency?` (cart's, else "USD"; unknown codes fall back), `now?`, `arrivals?: Record<methodId, { start; end }>`, `headingLevel?: 2 \| 3` (2), `className?` | A `checkoutHref` failing `isAllowedInternalHref` falls back to "/checkout". `now`/`arrivals` pass through to the picker (compute arrivals in the page loader with `computeArrivals` from `src/app/_lib/arrivals.ts`, which wraps `estimateDelivery`) |
| `shippingNotice?: string \| null` | One-time shipping message from the server (`CartViewV2.shippingNotice`, e.g. the previously selected method was dropped). Non-blank text renders as an info `Notice` (`role="status"`, `data-testid="cart-summary-shipping-notice"`) just before the shipping picker; with no cart lines (saved-only) it sits after the subtotal row. Blank/null renders nothing |

Rendering rules:
- No cart lines and nothing saved -> `null`. Saved-only cart -> heading, "Subtotal (0 items)" and "Your cart is empty"; no forms, no totals.
- "Subtotal (N items)" uses `cart.itemCount` ("1 item" / "N items"; invalid -> 0). Discount row "Discount (CODE)" only when > 0; Shipping row shows the method name and "Free" at 0, "—" (visually hidden "not available") when the cart has no shipping quote.
- Amounts are the server's `cart.totals` (shown as given, through `toDisplayAmount`: NaN/negatives/floats -> $0.00, overflow -> "—"). `data-total-check="match|mismatch|unavailable"` on the aside compares `totals.totalCents` with `computeOrderSummaryTotal` over billable quantities (`min(quantity, stock)`, 0 for unavailable lines) + shipping − discount, i.e. the same input `OrderSummary` gets (`toOrderSummaryItems`, `toOrderSummaryTotalInput`).
- "Proceed to checkout" (`Link variant="button"`, full width) only when `canCheckout` AND every line is `"ok"` (CartTable's stricter rule). Otherwise no link/button and the reason as text (`data-testid="cart-summary-blocked"`, `CHECKOUT_BLOCKED_TEXT`): empty / all out of stock / some out of stock / reduced quantities / unknown. `data-can-checkout="true|false"` on the aside.
- Free-shipping progress uses the selected method's `freeOverCents` and `totals.amountToFreeShippingCents` (none for a method without a threshold).
- 320px: the aside is `min-w-0`, every row wraps; pass the column width via `className` (e.g. `lg:w-80`).

Usage (cart page, T108): `<CartSummary cart={view} actions={{ applyCoupon, removeCoupon, setShippingMethod: selectShippingMethod }} now={now} arrivals={arrivals} className="lg:w-80" />`.

### ProductGrid v2 (T74; additive)

Server-safe; still a `<ul role="list">` of `<li class="flex min-w-0">` (`data-layout` on the `ul`). New optional props:

| Prop | |
| --- | --- |
| `layout?: "grid" \| "list"` ("grid") | grid = 2 / 3 (md) / 4 (lg) columns (T156, see v3 below); list = single column (`flex flex-col gap-4`), cards get `layout="list"` |
| `emptyState?: ReactNode` | Replaces the default "No products yet" block when `products` is empty (`null`/`false` = default) |
| `cardProps?: (product: P, index: number) => Partial<Omit<ProductCardProps, "product">>` | Per-card extras (badges, rank, wishlist state, compare selection, quickAdd). Overrides grid defaults (priority, headingLevel, layout); cannot replace `product`; `className` merges with `w-full` |

Generic over `P extends Product`, so `products: ProductListItem[]` types `cardProps` with `rank`: `<ProductGrid products={result.items} cardProps={(p) => ({ rank: p.rank, quickAdd: { action: addToCart } })} />`.

### ProductGrid v3 (T156; promo slots, 4/3/2 columns)

Columns: `PRODUCT_GRID_CLASSES` = `grid min-w-0 grid-cols-2 gap-x-2 gap-y-4 xs:gap-4 md:grid-cols-3 lg:grid-cols-4 lg:gap-6` (4 at >=1024, 3 at >=768, 2 below; no 1-column class at any width, CONTRACTS L-28). The 8px column gap below `xs` lets two 160px (`min-w-40`) ProductCard v3 cards fit at 360px inside the page's 16px gutters. Grid cards also get `PRODUCT_GRID_CARD_CLASS` (`max-xs:min-w-0`) so under 360px (320px phones) the two cards shrink instead of scrolling the page sideways (R9). Product `<li>` stays exactly `flex min-w-0`; rows stretch, so cards in a row share a height.

| Prop | |
| --- | --- |
| `promoSlots?: readonly { afterIndex: number; tile: ProductGridPromoTile }[]` | `ProductGridPromoTile` = `PromoTileProps` without `as`. Each tile renders as `<PromoTile as="li">` directly in the same `<ul role="list">`, right after the product at 0-based `afterIndex` (`2` = after the 3rd product). `span` defaults to 2 (1 kept); heading level is clamped to 3 (4 kept; never h1/h2 inside the grid, L-17). Grid layout only; ignored for `layout="list"` and for an empty product list |
| `page?: number` (1) | Promos render only when this is exactly 1 (L-14). The template passes the listing page; promos on page 2+ are dropped here even if passed |
| `pageSize?: number` | Full page size (e.g. `LISTING_PAGE_SIZE`). A tile after the last product is kept only when `products.length >= pageSize`; without it a trailing tile is dropped |
| `now?: Date` | FIX-card-now. The page's single clock (read once by its loader), forwarded to every card for the "New" badge; a defined `now` from `cardProps` wins for that card. Pages pass it (wave-3 page tasks); omitted → no "New" badge and no clock read |

Placement rules (pure `placePromos(items, slots, { page, pageSize, isValidTile })` / `selectPromoSlots`, exported): non-integer, negative or beyond-the-count `afterIndex` dropped; two slots at the same index keep the first; blank-heading tiles dropped; then at most `MAX_PROMO_SLOTS` (3) in caller order; tiles placed by position. Product `index` (priority, `cardProps`) counts products only, so a result count / toolbar never includes promos. Grid cells are not reordered (no `grid-flow-dense`, so visual order = DOM/focus order): a span-2 tile that starts in the last column wraps and leaves one empty cell. To avoid holes at 4 and 2 columns, place a span-2 tile where the number of cells before it (products + earlier tile spans) is even, or use `span: 1`; at 3 columns a span-2 tile can still leave one empty cell.

Usage (T158/T167): `<ProductGrid products={items} now={data.now} page={params.page} pageSize={LISTING_PAGE_SIZE} promoSlots={page === 1 ? slots : undefined} cardProps={...} />`.

### OrdersList, OrderDetail (T94/T95)

**OrdersList** (`@/components/organisms/OrdersList`, server-safe) — order history body.

| Props | |
| --- | --- |
| `orders: readonly OrdersListOrder[]` | One page of `orderService.listOrders(...).items` (`OrderView` fits). Ignored on the Buy Again tab |
| `tab`, `range`, `query`, `page`, `pageCount` | Raw values are re-parsed (`parseOrderTab` / `parseOrderRange` -> "3m" / `parseOrderQuery` max 100); Pagination clamps page |
| `basePath?` ("/orders") | Query/fragment stripped; disallowed path -> "/orders" |
| `buyAgainProducts: readonly BuyAgainProduct[]` | `{ productId, slug, name, imageUrl, priceCents, currency, inStock }`; deduplicated by `productId` (first wins) |
| `actions: { buyAgain; addToCart }` | `(formData) => …`: `buyAgainFromForm` (OrderCard posts `orderId`) and a single-arg add-to-cart action (posts `CART_FIELD.productId` + `quantity=1`) |
| `headingLevel?: 1 \| 2` (1), `className?` | Cards use the next level |

Renders "Your orders" heading, `<nav aria-label="Order views">` with tab links (`aria-current="page"` on the selected one; tab links keep `range`), a GET `role="search"` form (`range` select, `q` input `maxLength=100`, hidden `tab`, "Search orders"; hidden on Buy Again), `<ul>` of `OrderCard`s, `Pagination` (label "Order pages", hrefs keep tab/range/q), per-tab empty states with next-step links (orders -> /products, not-shipped -> /orders, cancelled -> /help/ordering, buy-again -> /products; filtered -> "Clear search and filters"), and the Buy Again grid (one add-to-cart form per in-stock product, "Out of stock" text otherwise).
Helpers for the page: `ORDER_TABS` (`{ value, label, serviceTab }`), `ORDER_RANGES`, `ORDER_RANGE_LABELS`, `DEFAULT_ORDER_TAB`, `DEFAULT_ORDER_RANGE`, `parseOrderTab`, `parseOrderRange`, `parseOrderQuery`, `parseOrderPage`, `toServiceTab` (UI tab -> `listOrders` tab, null for buy-again), `buildOrdersHref(basePath, { tab, range, q, page })` (drops defaults), `toOrderCardData`, `dedupeBuyAgainProducts`, `ordersEmptyState`.

**OrderDetail** (`@/components/organisms/OrderDetail`, server-safe wrapper + `CancelOrderForm` client island) — order detail / confirmation body.

| Props | |
| --- | --- |
| `order: OrderDetailOrder` | `OrderView` fits. Card data is `cardLast4` only (no number/CVC/expiry key exists); email is not part of the type and never rendered |
| `variant: "confirmation" \| "detail"` | confirmation: "Order placed" heading, thank-you text, "Estimated delivery: …"; detail: "Order # <id>" + "Placed on …" |
| `buyAgainAction` | `(formData) => …` (`buyAgainFromForm`); per item posts `orderId` + `productId` |
| `cancelAction?: OrderActionFn`, `cancelState?: OrderActionState` | `cancelOrder`; island uses `useActionState(cancelAction, cancelState)` so it works without JS. Form only when `cancellable` and >= 1 whole minute left (placedAt + 30 min, capped by `cancellableUntil`); checkbox `confirm=yes` required. Success -> `role="status"`, error -> `role="alert"` |
| `now: number` | Required epoch ms (keeps render pure); non-finite hides the cancel form |
| `paymentBrand?: "Visa" \| "Mastercard" \| "American Express" \| "Discover" \| null` | "Visa ending in 4242"; absent -> "Card ending in 4242" |
| `headingLevel?: 1 \| 2` (1), `className?` | |

Also: `OrderTimeline`, items with thumbnail, name link, "Qty N × price", "Buy it again" / "Write a review" (`#write-review`) / "Get help" (`/contact?topic=ordering&order=<id>`), `OrderSummary variant="invoice"` with server totals (`isFreeShipping` and `shippingCents={0}` when shipping is 0; payment line not duplicated there), ship-to `<address>`, payment block, refund notice for cancelled orders (T55: refund recorded as pending, simulated, no money moved), "Print invoice" link to `/orders/<id>/invoice`, rendered only when `order.status === "paid"` (no invoice link for cancelled/refunded or other statuses). All hrefs go through `isAllowedInternalHref`. Helpers: `cancelMinutesLeft`, `cancelWindowText`, `paymentLabel`, `shipToLines`, `invoiceHref`, `orderHelpHref`, `refundNoticeText`, `CANCEL_WINDOW_MINUTES`, `CARD_BRANDS`.

Look (Phase 3, T162): OrdersList empty state is a light-grey `Card tone="sunken" padding="lg"` (`data-slot="orders-empty"`); each Buy Again tile is a white `Card as="li"` (`interactive`) with the price in `Price display="superscript"` (accessible text still "$15.00"). OrderDetail: Items, Ship to, Payment method and the Cancel order island are white `Card as="section"` panels (`data-slot` `order-items` / `order-ship-to` / `order-payment` / `order-cancel`; the last item row drops its divider), the Refund panel is `Card tone="sunken"` (`order-refund`); the status `Badge` keeps text + icon + tone. The "Qty N × $price" meta line keeps the standard `Price` (small type). Tabs, forms, names (incl. per-order/per-item sr-only suffixes), headings and `aria-current` unchanged.

### AddressBook (T84)

Server-safe account address-book body (no `"use client"`; `renderToStaticMarkup` works); import `@/components/organisms/AddressBook`. Composes `AddressCard` + `AddressForm` (T65). The list is a small client island (`AddressBookList.tsx`) that only adds focus management and a status announcement; every mutation is a `<form action>` that works without JS (SR2). Address text is rendered only as React text (SR3).

| Props | |
| --- | --- |
| `addresses: readonly SavedAddress[]` | `getAddressService().list(ownerKey)` (any order) |
| `actions: { save; delete; setDefault }` | `AddressActionFn` each: `saveAddress`, `deleteAddress`, `setDefaultAddress` from `src/app/actions/addresses.ts`, passed unwrapped |
| `limit?: number` (10), `headingLevel?: 1 \| 2` (1), `className?` | `limit` defaults to `ADDRESS_BOOK_LIMIT`, pinned to the service's `MAX_ADDRESSES_PER_SESSION` by a type-only `typeof` import (non-positive / non-integer -> 10). Card titles and "Add a new address" sit at `headingLevel + 1` |

Structure: `<section aria-labelledby="address-book-heading">` -> heading "Your addresses" (`tabIndex=-1`, focus target) -> visually hidden `role="status"` region -> empty text "You haven't saved any addresses yet." OR `<ul role="list">` (1 col, `md:` 2) where each `<li>` holds the `AddressCard` (Set as default / Delete forms; no-JS delete = `<details>` + required `confirm=yes` checkbox, JS = confirm Dialog) and, as a sibling, an "Edit" `Disclosure` with the edit `AddressForm` (`idPrefix="address-form-<index>"`, `aria-label="Edit address <n>"`). One pattern with and without JS; no nested forms -> "Add a new address" section: `AddressForm` (`idPrefix="address-form-new"`, submit "Add address"; default checkbox only when the book is non-empty, otherwise the note "Your first address will become your default address.") OR, when `addresses.length >= limit`, `Notice tone="info"` (`id="address-book-limit"`, `tabIndex=-1`) "You've reached the limit of 10 addresses. Delete one to add another."

Rules:
- Order: the default first, then the service order (stable). Exactly one badge: the first flagged address keeps `isDefault`, later flagged ones render as regular cards; none flagged -> no badge (`sortAddresses`).
- Focus after JS actions (island; applied only when the focused control was removed, i.e. focus fell to `body`): delete -> heading of the card that took its place (else the new last card, else the book heading) + "Address deleted." announced; add that reaches the limit -> the limit notice + "Address saved."; set as default -> the new default card's heading (the card announces its own result). Card headings get `tabindex="-1"` at runtime when focused.
- No address content or address id in `id` / `name` / `for` / `data-*` / `aria-*` (static ids only; edit ids are index-based). The only address id in the HTML is the hidden `addressId` input `value`. One AddressBook per page (static ids).
- No hrefs are rendered (AddressForm error-summary `#id` links aside). 320px: everything `min-w-0` + `break-words`.
- Every edit form's submit is named "Update address: <addressTitle>" (visible "Update address", sr-only suffix via AddressForm `submitContext`, D-T98-3), matching the per-address names of Edit / Delete / Set as default. The add and edit forms render and post no `email` field (D-T98-2).

Usage (`/account/addresses`, T98): `<AddressBook addresses={getAddressService().list(ownerKey)} actions={{ save: saveAddress, delete: deleteAddress, setDefault: setDefaultAddress }} />` (page renders no other `<h1>`; pass `headingLevel={2}` if the page owns the h1).

Look (Phase 3, T162): the "Add a new address" `<section>` is a white `Card as="section"` (`data-slot="address-book-add"`); the empty-book text sits on a light-grey `Card tone="sunken"` (`address-book-empty`); each Edit Disclosure gets `shadow-sm`. Ids, focus targets, forms and the status region unchanged.

### ViewTracker (T97)

Client (`@/components/organisms/ViewTracker`). Renders nothing. PDP browsing-history beacon for visitors WITHOUT a session cookie.

| Props | |
| --- | --- |
| `productId`, `productSlug` | strings |
| `recorded: boolean` | `true` when the page already recorded the view server-side (a session cookie existed): the tracker does nothing |
| `recordView: RecordViewBeacon` | the `recordProductView` server action from `src/app/actions/views.ts` (pass it directly; contract `molecules/_contracts/view-actions.ts`) |

Behaviour: when `recorded` is false it calls `recordView({ productId, productSlug })` once in an effect after hydration, never during render, so crawlers without JS or cookies cause no writes. The action may mint the session cookie (a client-initiated mutation, allowed by SR10). The result is ignored and rejections or throws are swallowed. A ref stops StrictMode's double effect and re-renders from sending twice; a different product (client navigation) is tracked again. It never receives or renders a session id or owner key (R-1).

Usage (PDP): `<ViewTracker productId={p.id} productSlug={p.slug} recorded={viewer.hasSession} recordView={recordProductView} />`.

### CheckoutForm v2 (T93; additive takeover)
- Without `v2` the MVP form renders unchanged (MVP tests untouched). Shared helpers moved verbatim to `CheckoutForm/checkout-form-shared.tsx`; `CheckoutForm.tsx` re-exports the MVP ones, so import paths are unchanged.
- Props with v2: `{ initialIdempotencyKey: string; className?; v2: CheckoutFormV2Config }` (`placeOrder`/`cartHref` are not passed; `CheckoutFormProps` is a union). `CheckoutFormV2Config`: `action` (`placeOrderV2` from `@/app/actions/checkout-v2`), `savedAddresses: readonly SavedAddress[]`, `shipping: { options: readonly ShippingQuote[]; selectedId: string | null; arrivals?: Record<id, {start,end}>; currency: string; now?: number }`, `summary: { items: OrderSummaryLine[]; subtotalCents; discountCents; shippingCents; totalCents }` (server totals), `coupon: { code; description; freeShipping?: boolean } | null`, `freeShipping?: { subtotalCents; thresholdCents; amountToFreeCents; currency } | null`, `isSignedIn: boolean`, `email?: string | null`, `cartHref?` (default "/cart"; must pass `isAllowedInternalHref`).
- One `<form>` (no nested forms) posting every `CHECKOUT_FIELD_V2` name + MVP address/card names. Address step: with saved addresses an `addressMode` radio group ("Deliver to a saved address" / "Use a new address") + an `addressId` radio group of `AddressCard selectable` (default address preselected; picking a card switches to saved mode); without saved addresses a hidden `addressMode=new`. The new-address block (`AddressFields` legend "Shipping address"/"New shipping address", server `maxLengths`, + `phone`, "Save this address" `saveAddress=on`, `addressLabel` maxLength 40) is always visible without JS and `hidden` after hydration unless mode is "new". Email: signed in with an email → text + hidden `email`; guest with saved addresses → standalone Email field (`id="address-email"`, posts in both modes); otherwise inside `AddressFields` (MVP shape). Saving is offered to guests too (the action saves to the owner key's book either way).
- Shipping: radio group `shippingMethodId` built from `usableShippingOptions` ("<name> — <price|Free> — Arrives <range>"), default `selectedId`. Changing it (JS) re-prices shipping from the quote (0 when free or `coupon.freeShipping`) and recomputes the total with `computeOrderSummaryTotal` (so `data-total-check` stays "match"), with a polite note; without JS the server totals for the cart selection are shown and the checked method is posted.
- Delivery note `Textarea` (maxLength 200, `showCount`), coupon read-only `Chip` + "Change in cart" link (no coupon → "Add it in your cart"), MVP `PaymentFields`, review block `OrderSummary` (h3) + `FreeShippingProgress`, conditions line linking `/terms` and `/privacy`, "Place order" / "Placing order…".
- Errors: `fieldErrors` → inline errors (address keys, `addressId`, `shippingMethodId`, `deliveryNote`, `addressLabel`, `phone`); card errors only from `error.details.fields`. Summary (`role="alert"`, focused) links to each field; group targets focus their checked/first radio. Coupon codes → "Your promo code can't be used" + "Change in cart"; INTERNAL_ERROR → message + "won't be charged twice".
- Idempotency (`nextIdempotencyKeyV2`): keep after a network error or INTERNAL_ERROR, regenerate after every other completed attempt. The body remounts after each completed attempt, so card number/expiry/CVC come back empty; everything else refills from `values`.
- Exports: `CheckoutFormV2Config`, `CheckoutFormV2Summary`, `CheckoutV2Coupon`, `nextIdempotencyKeyV2`, `mapV2Errors` (plus `displayTotals`, `errorSummaryItems`, `CHECKOUT_V2_IDS` from `CheckoutFormV2.tsx`).

### Cart and checkout organisms: light-only pass (T161)

Presentation only; props, actions, contract field names, notices, `checkoutState`, `data-total-check`, idempotency key handling, no-JS POST shapes, live regions/alerts, heading levels and 44px targets are unchanged. No theme-dependent code existed in these folders.

| Organism | Phase 3 look |
|---|---|
| `CartTable` | Line list sits on a raised `Card` (`padding="none"`, list `px-4 sm:px-5`, `divide-y` only; the card supplies the edge). Built-in summary box is `Card as="section"` ("Cart summary", `lg:w-80`). Empty state is `Card tone="sunken" padding="lg"`. "Estimated total" uses `Price display="superscript"` (spoken text stays "$25.00"); Subtotal stays standard. "Proceed to checkout" is the primary pill (`Link variant="button"`) |
| `SavedForLaterSection` | `Card as="section"` (raised) with `divide-y` rows. Row price is `Price display="superscript"`. "Delete" is `Button variant="danger"` (filled danger pill, visible text "Delete", name "Delete: <name>"); "Move to cart" stays the secondary pill |
| `CartSummary` | `Card as="aside"` (raised). T180 (U18): every row, Total (`data-testid="cart-summary-total"`) included, is the standard `Price` ("$79.00"); superscript is for merchandising only (cards, buy box) |
| `OrderSummary` | `Card as="section"` (raised), both variants. T180 (U18): every row, Total included, is the standard `Price`, so a summary never mixes "$79.00" and a superscript "$79" |
| `CheckoutForm` v2 | Each step (`checkout-step-*`: address, shipping, note, promo, payment, review) is a raised `Card as="section"`; "Place order" is the primary full-width pill (Button default). The review step nests the `OrderSummary` card. MVP form (no `v2`) unchanged. T180 (U06): `data-testid="checkout-layout"` is one column below `lg` (steps, review, terms, "Place order" last) and from `lg` two columns inside the one `<form>`: `checkout-steps` (address, shipping, note, promo, payment; `lg:flex-1 lg:max-w-3xl`) left, `checkout-review-column` (review card + terms + "Place order"; `lg:sticky lg:top-20`, basis 20rem / 24rem from `xl`) right. The "Shipping address" and "Payment" legends are `hideLegend` (sr-only) under the same-named card headings; "New shipping address" (saved-address mode) stays visible |

Superscript note: the superscript visual is `aria-hidden`, so an element's `textContent` is now "full amount + visual digits" (e.g. "$5.50$550"). Tests that read a Total's text should use the spoken text (the `.sr-only` node, or `textContent` with `[aria-hidden="true"]` subtrees removed).
