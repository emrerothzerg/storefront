# `src/app/products/[slug]/_lib`: product detail page helpers

Private folder for `/products/[slug]` (T97 v2, T169 v3). The page (`../page.tsx`) is a thin renderer: one `loadPdp` call per render, the session cookie read once with `readSessionId()` and the user with `readCurrentUser()` (both read-only, never mint a cookie), and the clock read once inside the loader.

| File | What it holds | Tests | Owner |
| --- | --- | --- | --- |
| `pdp-data.ts` | `loadPdp(input, deps)` (slug check before any DB access, published-only via `getPublishedDetailBySlug(slug, now)`, one view recorded with a valid cookie, every section in one `Promise.all`, optional sections degrade with a logged code), `loadPublishedProduct` (metadata), `createPdpDeps(db)` / `defaultPdpDeps()`, `RAIL_LIMIT`, `withoutProduct(products, id)` (T169: the related / also bought / also viewed rails never contain the current product; recently viewed already filters it). `PdpData.now` (T169, FIX-card-now) = the epoch ms the load used, so the page builds one `Date` for badges and rails instead of reading the clock again | `pdp-data.test.ts` | T97, T169 |
| `pdp-view.ts` | `safeHref` (allow-list), `breadcrumbItems`, `ratingLinkText`, `infoRows`, `pdpBadges(product, now)` (T169: badge row under the title with the product-card rules: Sale > New > Top pick, max 2, labels/tones from `PRODUCT_CARD_BADGES`) | `pdp-view.test.ts` | T97, T169 |
| `pdp-meta.ts` | `buildPdpDescription` (70-160 char meta description) | `pdp-meta.test.ts` | T97 |
| `pdp-json-ld.ts` | `buildProductJsonLd` (one Product graph; the page emits ONE script with [Product, BreadcrumbList]) | `pdp-json-ld.test.ts` | T97 |
| `pdp-params.ts` | `parsePdpParams` (`img`, review sort/stars/verified/page, `qpage`), `IMAGE_PARAM`, `reviewsExtraParams` | `pdp-params.test.ts` | T97 |
| `product-detail.ts` | `isValidSlug`, `productTitle` | `product-detail.test.ts` | MVP, T97 |

## Page layout (T169 v3) — REFERENCE PENDING

No PDP reference screenshot was supplied (BACKLOG-phase3 section 1c, open question 1); the layout follows the listing reference's style family and may get a rework pass when the reference arrives. Nothing depends on it being final.

1. `Breadcrumb` (first in `<main>`, matches the BreadcrumbList JSON-LD).
2. `<article>` (the first article on the page; QA reads the buy box forms from it): one column below `lg` in DOM order gallery -> title block -> buy box; from `lg` a 12-column grid with `ImageGallery` (`basePath`, `?img=N#gallery`) in 7 columns and a block (not flex) right column of 5 holding the title block (`h1` product name at the h2 visual size, h1 size from `md`, `text-balance break-words` (T180/U09: a display-size name hyphen-split in the 5/12 column), "Visit the <brand> store" link, compact rating link to `#reviews`, badge row, "N+ bought in past month", Best Sellers Rank) and `BuyBox sticky` (sticks from `lg` only, inside the stretched column).
3. Content Cards: "About this item" bullets + "Product description" (7 columns) and "Specifications" + "Product information" tables (5 columns); a side with no data is omitted and the other spans the row.
4. `FrequentlyBoughtTogether` (when a bundle exists).
5. `ReviewsSection` (`#reviews`, `#write-review`) and `QASection` (`#questions`), `signedInName` from `readCurrentUser()`.
6. `ProductRail`s: related (`#rail-related`), also bought, also viewed, recently viewed (cookie only); compact cards with `quickAdd={{ action: addToCart }}` and the loader's single `now`. Empty rails render nothing.
7. `ViewTracker recorded={data.viewRecorded}` and one JSON-LD script.
