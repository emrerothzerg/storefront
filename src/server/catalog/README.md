# server/catalog

Product catalog data access. Server-only. Owning tasks: T07 (programmer), P2-A (phase 2 data model). Search and facets live in `src/server/search/`, not here.

`product-repository.ts` exports the `ProductRepository` interface and `SqliteProductRepository` (construct with a `bun:sqlite` `Database`, e.g. `new SqliteProductRepository(getDatabase())`). All methods are synchronous, use bound parameters only, and return `Product` from `@/lib/types` (never raw rows).

| Method | Returns |
|---|---|
| `list()` | `Product[]` sorted by name, `[]` when empty |
| `getBySlug(slug)` | `Product \| null` (exact match; quotes, `%`, `_`, unicode and very long strings are safe) |
| `getById(id)` | `Product \| null` |
| `getManyByIds(ids)` | `Product[]` in first-appearance order of `ids`, unknown ids skipped, duplicates collapsed |
| `decrementStock(productId, quantity)` | `Result<Product>` with the updated product |

**Sparse summary fields.** Every `Product` returned above also carries, only when they hold a value: `listPriceCents`, `ratingCount` + `ratingAvg` (published reviews; avg rounded to 1 decimal), `brandName` + `brandSlug`, `categoryName` + `categorySlug`, `isFeatured: true`, `sku`. A product with none of these has exactly the eight MVP keys. `publishedAt`/`updatedAt` are only on `ProductDetail`.

`ProductRepository` (above) is the core contract that cart/checkout depend on and fake in tests. Phase 2 reads are on `CatalogProductRepository extends ProductRepository`, which `SqliteProductRepository` implements:

| Method | Returns |
|---|---|
| `getDetailBySlug(slug)` | `ProductDetail \| null`: bullets, specs, images (primary first; falls back to `imageUrl`), `listPriceCents` (null), `ratingCount`/`ratingAvg` (0), `brand`, `category` (leaf; use `getPath` for breadcrumbs), `publishedAt`, `updatedAt`. Malformed JSON columns yield `[]`, never a throw; image urls must be site-relative (`/...`, not `//`) |
| `listByCategory(categoryId, limit?)` | products in the category, or for a department in it and its children; by name |
| `listFeatured(limit)` | `is_featured = 1`, newest first |
| `listNewest(limit)` | by `published_at` desc |
| `listDeals(limit)` | `list_price_cents > price_cents`, biggest % saving first |
| `listTopRated(limit)` | reviewed products, best average first (ties: more reviews) |
| `listSlugsWithUpdatedAt()` | `{ slug, updatedAt }[]` ordered by slug (sitemap) |

Publication-aware single read (`PublishedProductReader`, consistency av; used by the PDP `loadPublishedProduct` and `/compare` `loadCompare`): `getPublishedDetailBySlug(slug, now)` returns `getDetailBySlug(slug)` only when the product is published at `now` (epoch ms), using the same rule as `filterPublishedIds` (`published_at <> '' AND published_at <= nowIso`, exported in JS form as `isPublishedAtIso(publishedAt, nowIso)`); a non-finite or out-of-range `now` returns `null` without SQL.

Sitemap lastmod (CONS-B4 bm, additive; T112 switches `src/app/sitemap.ts` over): `listPublishedSlugsWithUpdatedAt(nowIso: string): { slug: string; updatedAt: string }[]` on `SqliteProductRepository` (interface `PublishedSlugLister`) returns only products published at `nowIso` under the same rule (`published_at <> '' AND published_at <= nowIso`, bound parameter), ordered by slug; a blank or non-string `nowIso` returns `[]` without SQL. `listSlugsWithUpdatedAt()` (above) still returns every product.

`limit`: a positive safe integer, capped at `MAX_LIST_LIMIT` (200); anything else returns `[]`. Other exports: `recomputeProductRating(db, productId)` (recomputes `rating_count/rating_sum` from published reviews; returns `{ ratingCount, ratingSum } | null`), `ratingAverage(sum, count)`, `parseBullets`, `parseSpecs`, `parseImages`.

`category-repository.ts`: `SqliteCategoryRepository` with `listDepartments()`, `listChildren(parentId)`, `getBySlug(slug)`, `getById(id)`, `getPath(categoryId)` (`[department, category]`, `[department]`, or `[]`), `listAllWithCounts()` (departments each followed by children; department counts include children), `listSlugsWithUpdatedAt(): { slug: string; updatedAt: string }[]` (every category, ordered by slug, from `categories.updated_at`; interface `CategorySlugLister`, CONS-B4 bm). Also exports `toCategory`, `CategoryRow`, `CATEGORY_COLUMNS`.

`brand-repository.ts`: `SqliteBrandRepository` with `list()`, `listWithCounts(now?)` (published products only: `published_at <> '' AND published_at <= now`; `now` epoch ms, omitted/invalid -> the clock; brands without published products keep count 0), `getBySlug(slug)`, `getById(id)`, `listSlugsWithUpdatedAt(): { slug: string; updatedAt: string }[]` (every brand, ordered by slug, from `brands.updated_at`; interface `BrandSlugLister`, CONS-B4 bm). Also exports `toBrand`, `BrandRow`, `BRAND_COLUMNS`.

`decrementStock` runs one statement, `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ? RETURNING id` (then re-reads the joined summary on the same connection), so stock can never go negative even with concurrent buyers. When no row is updated it reports:

- `INVALID_QUANTITY`: quantity is not a positive safe integer (checked before any SQL)
- `PRODUCT_NOT_FOUND`: no such id (`details.productId`)
- `OUT_OF_STOCK`: stock is 0 (`details.available = 0`, `details.requested`)
- `INSUFFICIENT_STOCK`: 0 < stock < quantity (`details.available`, `details.requested`)

Checkout (T11) calls it inside `withTransaction` from `@/server/db/client`; see `src/server/db/README.md` for the abort-on-error pattern.

## Listing service (T33)

`listing-service.ts` (contract) + `listing-repository.ts` (SQL; ids and counts only). Construct with `createListingService({ db })`; the app uses `getListingService()` (globalThis singleton over `getDatabase()`, rebuilt if the handle changes). Items are hydrated through `SqliteProductRepository.getManyByIds`, so they are plain `Product` (+ optional `rank`; `list()` items (T167 (bx)) and the collection helpers `deals`/`bestSellers`/`newArrivals`/`topRated` (CLEANUP-P3 (ch)) also carry `publishedAt` via `publishedAtByIds`, so cards and home/PDP rails can show "New"; omitted only when the row has no date): never `rating_sum`, `session_id` or any other internal column. All SQL fragments are module constants; input is bound (`IN` lists as one JSON parameter via `json_each(?)`).

`list(query)` rules:

| Input | Rule |
|---|---|
| visibility | only `published_at <= now` (`now` = epoch ms, default `Date.now()`; invalid → clock) |
| `categorySlug` | unknown → `NOT_FOUND`; `""` = no filter; a department includes its children |
| `brandSlugs` | OR within the dimension; unknown, non-string or beyond `MAX_BRAND_FILTERS` (50) dropped, `"brandSlugs"` added to `ignored` once; if none survive, no brand filter |
| `minPriceCents` / `maxPriceCents` | inclusive; each must be a non-negative safe integer, else dropped into `ignored`; `min > max` drops both |
| `minRating` | 1..4 else ignored; exact average (`rating_sum >= N * rating_count`), unreviewed never match |
| `inStockOnly` / `dealsOnly` | only `=== true` applies; deals = `list_price_cents > price_cents` |
| `ids` | restricts to those ids (`[]` = no results); `rank` = 1-based first position in `ids` |
| `sort` | missing → `relevance` when `ids` given, else `featured`; unknown → `featured`; `relevance` without `ids` orders like `featured` but `result.sort` stays `"relevance"` |
| `pageSize` | default 24, truncated and clamped 1..48 (non-finite → 24) |
| `page` | non-integer or < 1 → 1; beyond the last page → `items: []` with the real `total`, `page` echoed |
| `pageCount` | `ceil(total / pageSize)` (0 when there are no results) |

Orders (id always last): featured = `is_featured desc, avg desc, id`; price_asc/desc = price then id; rating = `avg desc, rating_count desc, id`; newest = `published_at desc, id`; best_selling = units desc, id. Avg is the exact `rating_sum / rating_count` (0 when unrated).

Facets are disjunctive: each dimension's counts apply every OTHER active filter (and `ids`, deals) and replace its own, so a bucket's count equals `list({...query, <that bucket>}).total` (brand bucket = `brandSlugs: [slug]`). Buckets with count 0 are omitted unless selected. `categories`: departments at root (count includes children), else the children of the current department (the selected leaf flagged); `brands` ordered by name; `price`: `PRICE_BUCKETS` (`<2500`, `2500–4999`, `5000–9999`, `10000–24999`, `>=25000`; selected when min/max equal the bucket bounds exactly); `rating`: 4, 3, 2, 1 "N stars & up"; `inStock`: count with stock > 0.

**`deals` (T91, additive):** number of matching products with `list_price_cents > price_cents` under EVERY current filter (same filter set and query pass as the other facets; deals is a plain AND filter, not a disjunctive dimension, so with `dealsOnly` it equals `total`). Feeds `FilterSidebar dealsCount`. `list()` always sets it; required in the type (`deals: number`) since CONS-B5 (every `FacetCounts` literal must include it, e.g. `deals: 0`).

Collections (`limit` default 12, clamped 1..48; all published only): `deals` (biggest % saving first), `bestSellers(limit, { categoryId?, now? })` (units from order items of orders with `status = 'paid' AND fulfillment_status <> 'cancelled'`, products with sales only, `rank` 1..n set; department id includes children), `newArrivals` (newest first), `topRated` (`rating_count >= TOP_RATED_MIN_REVIEWS` = 3, rating order). `categoryTree(now?)`: departments with children and product counts published at `now` (direct; epoch ms, omitted/invalid -> the clock). Route loaders pass their request `now`. `breadcrumb(slug)`: `[department, category]`, `[department]`, or `[]`. `rankInCategory(productId, now?)`: rank by units within the product's leaf category among products with sales (ties by id); `null` without sales, or for an unknown, unpublished or uncategorised product.

## Search (T32): `search-service.ts`, `search-repository.ts`

FTS5 product search, typeahead suggestions and "did you mean". Server-only. (The P2-A note above points at `src/server/search/`; T32 was assigned to `src/server/catalog/`, so search lives here.) Use `getSearchService()` in app code (a `globalThis` singleton over `getDatabase()`, rebuilt when `getDatabase()` returns a different handle, e.g. after `closeDatabase()`) or `createSearchService({ db, now? })` in tests (`now: () => number`, epoch ms, is the clock for `suggest`/`didYouMean` and the default for `search`).

| Export | Contract |
|---|---|
| `search(query: unknown, options?)` | `Result<SearchResult>`; never throws. `options` may be omitted, `null` or a non-object (= defaults; wrongly typed fields are ignored): `inStockOnly`, `page` (non-integer or < 1 → 1), `pageSize` (1..48, default 24; non-integer → 24), `now` (epoch ms, overrides the injected clock for this call). Returns `ids` (bm25 rank, then product id), `total`, `normalizedQuery`, `terms`, `didYouMean` (only when `total === 0`), `browseAll` (query empty after normalisation: all published products ordered by id). A query with only non-word terms (e.g. emoji) is not browse-all and returns 0 results. `err(INTERNAL_ERROR)` only if SQLite itself fails (unreachable by construction) |
| `suggest(prefix: unknown, limit = 8)` | `Suggestion[]` (`{ type: "product" \| "category" \| "brand", label, href }`), never throws. `[]` when the normalised prefix has < 2 characters. `limit` clamped 1..8. Products ranked like search (prefix on last term); categories (departments included) and brands whose name words start with every query token get at most 2 slots each, products fill the rest. De-duplicated by href and by (type, lower-cased label). Hrefs: `/products/<slug>`, `/category/<slug>`, `/brand/<slug>` |
| `didYouMean(query: string)` | `string \| null`. Null when the query already matches, when nothing is close, or when the correction finds nothing either; never the input back |
| `normalizeSearchQuery(raw)` | Non-string → empty. Ignore input past 1,000 code units, NFKC, control chars → space, `\p{Cf}` (zero-width, bidi marks) removed, `" * ^ : ( )` → space, lower-case, split on whitespace, strip leading `-` per term, drop bare `and/or/not/near`, keep 8 terms, cap 100 code units (never splits a surrogate pair) |
| `buildMatchExpression(terms)` | Each term `"..."` (inner `"` doubled, control chars → space), last term gets `*`, joined by spaces (implicit AND); terms with no letter/digit are skipped; `""` when nothing remains |
| `boundedDamerauLevenshtein(a, b, max)` | OSA distance over code points; returns `max + 1` once exceeded |
| `createSearchServiceWithRepository(repo, now?)` | Test seam (e.g. a failing fake repository) |

Rules:
- **Published** = `published_at <= now` (ISO string compare). Unpublished products never appear in results, suggestions or spelling hints, and categories/brands are suggested only when they have a published product. Out-of-stock products appear unless `inStockOnly` (suggestions ignore stock). `suggest`/`didYouMean` use the injected clock (default `Date.now`).
- **Safety.** The MATCH string is always a bound parameter built from sanitised, quoted terms. A quoted FTS5 string is always valid syntax, so user input cannot produce FTS errors or change query semantics (`AND`/`OR`/`NOT`/`NEAR` are dropped, `-x` does not negate, `col:x` does not filter). The repository itself throws on a malformed MATCH; only the service builds them.
- **Ranking.** `bm25(products_fts, 10, 6, 4, 1, 1, 3)` over (name, brand_name, category_name, description, bullets, department_name); ties by product id, so pages are stable (no gaps or duplicates).
- **Did you mean.** Per term: terms that match on their own are kept; others are replaced by the closest word from published products' indexed text (distance <= 2; <= 1 for terms of 4 chars or fewer; terms under 3 chars are never corrected), ties broken by the `products_fts_vocab.doc` of the word's porter stem, then alphabetically. Vocabulary terms are stems (`headphon`), so surface words come from the published text, and the vocab gives the weights. The lexicon is rebuilt per call (only on zero-result searches; fine for a catalog of this size, add a cache if the catalog grows to thousands of products).
- Rendering: labels and `normalizedQuery` are user/DB text; render as React text only (SR3).
