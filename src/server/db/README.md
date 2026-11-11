# server/db

SQLite (`bun:sqlite`) connection, schema and seed data. Server-only; never import from a `"use client"` module. Owning tasks: T07 (v1), P2-A (v2). See `SPIKE-NOTES.md` for how `bun:sqlite` behaves inside Next.js on Bun.

| File | Contents |
|---|---|
| `client.ts` | `createDatabase(path)`, `getDatabase()` singleton, `closeDatabase()`, `withTransaction(db, fn)`, `resolveDatabasePath(env?)`, `DEFAULT_DATABASE_PATH`, `BUSY_TIMEOUT_MS` |
| `schema.ts` | `runMigrations(db)`, `MIGRATIONS`, `SCHEMA_VERSION`. The only place DDL lives. |
| `seed.ts` | `SEED_PRODUCTS` (15 legacy), `SEED_CATALOG` / `SEED_CATALOG_PRODUCTS` (125, 2 of them unpublished), `SEED_PUBLISHED_CATALOG`, `SEED_UNPUBLISHED_SLUGS`, `SEED_CATALOG_STATS`, `isSeedPublished(entry)`, `seedProducts(db)`, `seedCatalogProducts(db)`, `seedTaxonomy`, `seedReviews`, `seedQuestions`, `seedCoupons`, `seedShippingMethods`, `seedDatabase(db): SeedCounts`, `seedImageFiles()`, `productImageUrl(slug)`, `galleryImageUrl(slug, view?)`, `publishedAtFor(daysAgo, now)`; re-exports `renderPlaceholderSvg`, `renderVariantSvg` |
| `seed-images.ts` | Pure SVG renderers (primary placeholder + gallery views `side`/`detail`/`back`) |
| `seed-data/*.ts` | Seed content: `taxonomy.ts` (8 departments x 3 categories, 12 fictional brands), `products.ts` (125 products, append-only), `community.ts` (deterministic review / Q&A generator), `commerce.ts` (coupons, shipping methods) |
| `seed-cli.ts` | `bun run seed` seeds everything and prints counts per entity; `--images` also rewrites `public/images/products/**/*.svg` |

## Connections

- `getDatabase()` opens `process.env.DATABASE_PATH` (trimmed; empty or whitespace-only means unset) `?? "./data/storefront.sqlite"` (relative to the process cwd, i.e. the storefront root), creates the directory, runs migrations, and caches the handle on `globalThis` so Next dev HMR reuses it.
- `createDatabase(":memory:")` is what tests use. It sets pragmas but does **not** migrate; call `runMigrations(db)` yourself. Tests must never call `getDatabase()` without `DATABASE_PATH=":memory:"`.
- Pragmas on every connection: `foreign_keys = ON`, `busy_timeout = 5000`, and `journal_mode = WAL` for file DBs.
- Connections are opened with `strict: true` (bun:sqlite named params without prefix; unknown names throw). Positional `?` works as usual. Always use bound parameters, never string-built SQL.
- Pages that read the DB must render dynamically (they do: `cacheComponents`/PPR is off and all pages are cookie/DB dependent; SPIKE-NOTES finding 2).

## Transactions

`withTransaction(db, (tx) => ...)` commits when the callback returns and rolls back (rethrowing) when it throws. Nested calls become savepoints.

**BEGIN IMMEDIATE.** The outermost call opens with `BEGIN IMMEDIATE` (bun's `transaction(fn).immediate()`; it works on `:memory:` too, so every connection uses it). The write lock is taken at BEGIN instead of at the first write. Why it matters for file DBs shared by several connections or processes (dev server, seed CLI, tests): with a deferred BEGIN, a read-then-write such as "check stock, then insert order" starts as a reader. If another connection commits a write in between, the upgrade to writer fails right away with `SQLITE_BUSY` (in WAL the snapshot is stale, so `busy_timeout` cannot help) in the middle of the transaction. With IMMEDIATE, a second writer blocks at BEGIN for up to `busy_timeout` (5 s), then runs on fresh data. Nothing can slip between its read and its write. `client.test.ts` proves this with two processes on a temp file DB. The test fails with `SQLITE_BUSY` if `.immediate` is removed.

**Synchronous only.** The callback must not `await`. If it returns a thenable (e.g. an `async` function), the transaction is rolled back and `TypeError("withTransaction callback must be synchronous")` is thrown. Writes made before the first `await` are undone. Writes after it would run outside any transaction, so never pass an async callback. To abort on a `Result` error, throw inside and convert back outside, e.g.

```ts
class Abort extends Error { constructor(readonly error: AppError) { super(error.message); } }
try {
  return withTransaction(db, () => {
    const r = products.decrementStock(id, qty);
    if (!r.ok) throw new Abort(r.error);
    // ... insert order rows ...
    return ok(order);
  });
} catch (e) { if (e instanceof Abort) return err(e.error); throw e; }
```

## Schema (migration v1)

All tables are `STRICT` (SQLite rejects a REAL in an INTEGER column, so `19.99` cannot sneak into a `*_cents` column). Timestamps are ISO 8601 UTC text (`2026-11-06T12:00:00.000Z`) with `DEFAULT` now; set `updated_at` explicitly on UPDATE. Money is integer minor units plus a 3-letter `currency`.

### products
| column | type | notes |
|---|---|---|
| id | TEXT PK | seed ids are `prod_<slug>` |
| slug | TEXT NOT NULL UNIQUE | URL key |
| name | TEXT NOT NULL | |
| description | TEXT NOT NULL DEFAULT '' | |
| price_cents | INTEGER NOT NULL | CHECK >= 0 |
| currency | TEXT NOT NULL | CHECK length 3 |
| image_url | TEXT NOT NULL | `/images/products/<slug>.svg` |
| stock | INTEGER NOT NULL | CHECK >= 0 |
| created_at, updated_at | TEXT NOT NULL | |

### carts
| column | type | notes |
|---|---|---|
| session_id | TEXT PK | guest session id |
| currency | TEXT NOT NULL DEFAULT 'USD' | CHECK length 3 |
| created_at, updated_at | TEXT NOT NULL | |

### cart_items — PK (cart_session_id, product_id)
| column | type | notes |
|---|---|---|
| cart_session_id | TEXT NOT NULL | FK → carts(session_id) ON DELETE CASCADE |
| product_id | TEXT NOT NULL | FK → products(id), no action on delete (deleting a product that is in a cart fails) |
| quantity | INTEGER NOT NULL | CHECK > 0 (delete the row instead of setting 0) |
| created_at, updated_at | TEXT NOT NULL | |

Index `idx_cart_items_product_id` on (product_id). Add-to-cart upsert: `INSERT ... ON CONFLICT (cart_session_id, product_id) DO UPDATE SET quantity = ...`. The cart row must exist first (FK).

### orders
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| session_id | TEXT NOT NULL | no FK (carts may be deleted) |
| status | TEXT NOT NULL | CHECK IN ('paid', 'payment_failed') |
| failure_code | TEXT NULL | e.g. a `PaymentFailureCode` |
| subtotal_cents, total_cents | INTEGER NOT NULL | CHECK >= 0 |
| shipping_cents | INTEGER NOT NULL DEFAULT 0 | CHECK >= 0 |
| currency | TEXT NOT NULL | CHECK length 3 |
| full_name, email, line1, city, region, postal_code, country | TEXT NOT NULL | `Address` fields |
| line2 | TEXT NULL | `Address.line2` |
| card_last4 | TEXT NOT NULL | never store full card data |
| payment_ref | TEXT NULL | provider reference on success |
| idempotency_key | TEXT NOT NULL UNIQUE | duplicate submit → UNIQUE violation; look up the existing order |
| created_at | TEXT NOT NULL | |

Index `idx_orders_session_id` on (session_id).

### order_items — PK (order_id, product_id)
| column | type | notes |
|---|---|---|
| order_id | TEXT NOT NULL | FK → orders(id) ON DELETE CASCADE |
| product_id | TEXT NOT NULL | **no FK**: snapshot survives product edits/deletes |
| name | TEXT NOT NULL | snapshot at purchase |
| unit_price_cents | INTEGER NOT NULL | snapshot, CHECK >= 0 |
| quantity | INTEGER NOT NULL | CHECK > 0 |

### schema_migrations
`version INTEGER PK, name TEXT, applied_at TEXT`. `runMigrations` applies each missing version in its own transaction; re-running is a no-op. To change the schema, append `{ version: 3, name, sql }` to `MIGRATIONS`; never edit an applied step.

## Ownership keys

Every owner-keyed table (`carts`, `orders`, `reviews`, `questions`, `answers`, the vote tables, `lists`, `product_views`, `coupon_redemptions`, `stock_alerts`, `contact_messages`, `addresses`) keys rows by `session_id`. That column holds either a guest session id or a signed-in user's `users.owner_key`; both are UUIDs, so `isSessionId()` validates either. The session layer resolves cookie -> owner key and services stay unchanged; on login the auth service re-keys the guest session's rows to the user's `owner_key`. Session ids are bearer credentials: never return another shopper's `session_id`/`owner_key` to a client (the domain types in `@/lib/types` deliberately omit them). Seed rows use synthetic `seed_session_NN` / `seed_voter_NN` / `seed_store` keys, which can never equal a real UUID.

## Schema (migration v2: `phase2_catalog_reviews_lists_orders`)

Applied with `ALTER TABLE ... ADD COLUMN` (no table rebuilds) plus new tables. Every new table is `STRICT`; the FTS5 objects (`products_fts*`) and the view `products_search` are the only non-STRICT objects. Booleans are `INTEGER` 0/1 with a CHECK. Ids of user content are app-generated `TEXT` (e.g. `crypto.randomUUID()`); seeds use `rev_seed_*`, `q_seed_*`, `a_seed_*`, `cat_<slug>`, `brand_<slug>`.

### products (added columns)
| column | type | notes |
|---|---|---|
| brand_id | TEXT NULL | FK -> brands(id) (deleting a referenced brand fails) |
| category_id | TEXT NULL | FK -> categories(id); seed fills it for every product (a leaf category) |
| list_price_cents | INTEGER NULL | "was" price; CHECK NULL or >= price_cents. Raising price above it fails: change both in one UPDATE |
| sku | TEXT NULL | |
| bullets | TEXT NOT NULL DEFAULT '[]' | JSON array of strings |
| specs | TEXT NOT NULL DEFAULT '[]' | JSON array of `{label, value}` |
| images | TEXT NOT NULL DEFAULT '[]' | JSON array of `{url, alt}`, primary first; `image_url` stays the primary |
| rating_count, rating_sum | INTEGER NOT NULL DEFAULT 0 | CHECK >= 0; trigger-maintained from PUBLISHED reviews only |
| is_featured | INTEGER NOT NULL DEFAULT 0 | 0/1 |
| published_at | TEXT NOT NULL | ADD COLUMN cannot default to an expression, so it defaults to '' and `trg_products_published_at` sets it to `created_at` on insert when not given; existing rows were backfilled |

Indexes: `category_id`, `brand_id`, `is_featured`, `published_at`, `(category_id, brand_id, price_cents)`. JSON columns are not CHECKed (malformed JSON is storable); readers must parse defensively (`parseBullets`/`parseSpecs`/`parseImages` in the product repository).

### Full-text search: products_fts, products_fts_vocab, products_search
- `products_search` (VIEW): one row per product: `product_rowid` (= products.rowid), `name`, `brand_name`, `category_name`, `description`, `bullets` (raw JSON text; '' if malformed), `department_name` (the category's parent).
- `products_fts` (FTS5, external content = `products_search`, `content_rowid = product_rowid`, `tokenize = 'porter unicode61 remove_diacritics 2'`, `prefix = '2 3'`). Column order for `bm25()` weights: **name, brand_name, category_name, description, bullets, department_name**. Join back with `JOIN products p ON p.rowid = products_fts.rowid`. Prefix queries (`head*`) and column filters (`brand_name:acme`) work. Always bind the MATCH string, AND build it from sanitised tokens: malformed FTS syntax throws (`t-shirt`, `usb-c`, `3.5mm`, `o'clock`, `NEAR(`, `-foo`, `a:b` all raise SQLiteError even when bound). Crash-free recipe (implemented in `src/server/catalog/search-service.ts` `buildMatchExpression`): replace control characters (incl. NUL — a NUL inside a quoted token still throws "unterminated string") with spaces, split on whitespace, drop empty tokens, wrap each token in double quotes doubling any inner `"` (`"tok"`, optionally `"tok"*` for prefix), and join with spaces. Fuzzed with 2,000 hostile strings without a throw.
- `products_fts_vocab` (fts5vocab `row`): `term, doc, cnt` for "did you mean"/suggestions (terms are porter stems, e.g. `headphon`).
- Sync triggers: product INSERT/DELETE, product UPDATE OF name/description/bullets/brand_id/category_id (stock/price updates do not touch the index), brand rename, category rename/re-parent. The migration ends with a `'rebuild'`. **Never use `INSERT OR REPLACE` on products** (REPLACE deletes skip triggers and would desync the index).

### categories
`id TEXT PK, slug TEXT UNIQUE, name TEXT (non-empty), description TEXT DEFAULT '', parent_id TEXT NULL FK -> categories(id), sort_order INTEGER DEFAULT 0, image_url TEXT NULL, created_at, updated_at`. CHECK parent_id <> id; triggers enforce max depth 2 (department -> category). Index `parent_id`.

### brands
`id TEXT PK, slug TEXT UNIQUE, name TEXT (non-empty), description TEXT DEFAULT '', created_at, updated_at`.

### carts (added) / order_items (added)
- carts: `coupon_code TEXT NULL`, `shipping_method_id TEXT NULL`.
- order_items: `product_slug TEXT NULL`, `image_url TEXT NULL` (snapshots; NULL on pre-v2 rows). New index `order_items(product_id)`.

### orders (added)
| column | type | notes |
|---|---|---|
| fulfillment_status | TEXT NOT NULL DEFAULT 'processing' | CHECK IN ('processing','packed','shipped','out_for_delivery','delivered','cancelled'). `status` stays the PAYMENT status (paid/payment_failed) |
| coupon_code | TEXT NULL | |
| discount_cents | INTEGER NOT NULL DEFAULT 0 | CHECK >= 0 |
| shipping_method_id, shipping_method_name | TEXT NULL | snapshot |
| estimated_delivery_start, estimated_delivery_end | TEXT NULL | ISO |
| cancelled_at, shipped_at, delivered_at | TEXT NULL | ISO |
| phone, delivery_note | TEXT NULL | |

Index `(session_id, created_at)`.

### order_events
`id INTEGER PK, order_id TEXT FK -> orders ON DELETE CASCADE, status TEXT CHECK IN (the six fulfilment statuses), at TEXT DEFAULT now, note TEXT NULL`, UNIQUE (order_id, status). Index `order_id`.

### reviews
`id TEXT PK, product_id TEXT FK -> products ON DELETE CASCADE, session_id TEXT, display_name TEXT (non-empty), rating INTEGER CHECK 1..5, title TEXT DEFAULT '', body TEXT DEFAULT '', verified_purchase INTEGER 0/1 DEFAULT 0, helpful_count INTEGER DEFAULT 0 (>= 0), status TEXT DEFAULT 'published' CHECK IN ('published','hidden'), created_at, updated_at`, UNIQUE (product_id, session_id). Indexes `(product_id, status, created_at)`, `created_at`. Triggers keep `products.rating_count/rating_sum` exact over published reviews for insert, delete, rating change, product move and status change (an `ON CONFLICT ... DO UPDATE SET rating = ...` upsert adjusts by the delta). `recomputeProductRating(db, productId)` (product repository) is the safety net.

### review_votes / question_votes / answer_votes
`(review_id | question_id | answer_id) TEXT FK ON DELETE CASCADE, session_id TEXT, created_at`, PK (target, session_id): one vote per session (a duplicate raises a PK violation -> map to `ALREADY_VOTED`). Triggers increment/decrement the target's `helpful_count`.

### questions / answers
- questions: `id TEXT PK, product_id FK -> products ON DELETE CASCADE, session_id, display_name, body (non-empty), helpful_count INTEGER DEFAULT 0, status ('published'|'hidden'), created_at`. Index `(product_id, status, created_at)`.
- answers: `id TEXT PK, question_id FK -> questions ON DELETE CASCADE, session_id, display_name, body (non-empty), is_store INTEGER 0/1 DEFAULT 0, helpful_count INTEGER DEFAULT 0, status, created_at`. Index `(question_id, status, created_at)`.

### lists / list_items
- lists: `id TEXT PK, session_id, name TEXT (1-100 chars), kind TEXT CHECK IN ('wishlist','save_for_later'), is_default INTEGER 0/1 DEFAULT 0, is_public INTEGER 0/1 DEFAULT 0, share_token TEXT UNIQUE NULL, created_at, updated_at`. Index `session_id`; partial UNIQUE index `ux_lists_save_for_later (session_id) WHERE kind = 'save_for_later'`.
- list_items: `list_id FK -> lists ON DELETE CASCADE, product_id FK -> products ON DELETE CASCADE, quantity_desired INTEGER DEFAULT 1 (> 0), priority INTEGER DEFAULT 0 CHECK IN (0,1,2), price_at_add_cents INTEGER NOT NULL (>= 0, no default), note TEXT NULL, added_at`, PK (list_id, product_id). Index `product_id`.
- **Service rules:** exactly one `save_for_later` list per session, created lazily (race-safe: `INSERT ... ON CONFLICT (session_id) WHERE kind = 'save_for_later' DO NOTHING`, then SELECT); at most one wishlist with `is_default = 1` per session (service rule, not an index).

### product_views
`session_id TEXT, product_id TEXT FK -> products ON DELETE CASCADE, viewed_at TEXT DEFAULT now`, PK (session_id, product_id). Upsert `ON CONFLICT (session_id, product_id) DO UPDATE SET viewed_at = excluded.viewed_at`. Indexes `(session_id, viewed_at DESC)`, `(product_id)`.

### coupons / coupon_redemptions
- coupons: `code TEXT PK (upper case, 1-64 chars, CHECK code = upper(code)), kind TEXT CHECK IN ('percent','fixed','free_shipping'), value INTEGER (percent 1..100 | fixed > 0 cents | free_shipping 0; CHECKed), min_subtotal_cents INTEGER DEFAULT 0, max_uses INTEGER NULL (> 0), used_count INTEGER DEFAULT 0 (CHECK <= max_uses), starts_at TEXT NULL, expires_at TEXT NULL, is_active INTEGER 0/1 DEFAULT 1, promoted INTEGER 0/1 DEFAULT 0, created_at, updated_at`. Race-safe redemption: `UPDATE coupons SET used_count = used_count + 1 WHERE code = ? AND (max_uses IS NULL OR used_count < max_uses)` and check `changes`.
- coupon_redemptions: `coupon_code TEXT FK -> coupons(code), session_id TEXT, order_id TEXT NULL, created_at`, PK (coupon_code, session_id): one redemption per session (violation -> `COUPON_USED`).

### shipping_methods
`id TEXT PK, name, description DEFAULT '', price_cents INTEGER >= 0, free_over_cents INTEGER NULL (>= 0), min_days INTEGER >= 0, max_days INTEGER (CHECK >= min_days), sort_order INTEGER DEFAULT 0, is_active INTEGER 0/1 DEFAULT 1, created_at, updated_at`.

### rate_limits
`key TEXT, window_start INTEGER, count INTEGER DEFAULT 0`, PK (key, window_start). Exactly the DDL the rate limiter expects.

### stock_alerts
`id TEXT PK, product_id FK -> products ON DELETE CASCADE, session_id, created_at, acknowledged_at TEXT NULL`, UNIQUE (product_id, session_id). No email (no PII collected). Index `session_id`.

### contact_messages
`id TEXT PK, reference TEXT UNIQUE (4-32 chars, e.g. C-7F3K2QAB: "C-" + 8 Crockford base32 chars), session_id TEXT NULL, name (non-empty), email (3-254 chars), topic (non-empty), order_id TEXT NULL, product_slug TEXT NULL, message (non-empty), created_at`.

### addresses
`id TEXT PK, session_id, label TEXT DEFAULT '', full_name, phone NULL, line1, line2 NULL, city, region, postal_code, country, is_default INTEGER 0/1 DEFAULT 0, created_at, updated_at`. Index `session_id`. **Service rule:** at most one `is_default = 1` per session (not an index, so defaults can be switched in either order inside one transaction).

### users / auth_sessions
- users: `id TEXT PK, email TEXT UNIQUE, password_hash TEXT, display_name TEXT, owner_key TEXT UNIQUE, failed_login_count INTEGER DEFAULT 0 (>= 0), locked_until TEXT NULL, last_login_at TEXT NULL, created_at, updated_at`. **Service rule:** store email trimmed and lower-cased. Never select `password_hash` outside the auth repository; the domain `User` type has no hash. No users are seeded.
- auth_sessions: `id TEXT PK, user_id FK -> users ON DELETE CASCADE, token_hash TEXT UNIQUE, created_at, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT NULL, user_agent TEXT NULL`. Index `user_id`. Store only a hash of the token.

## Seeding

`bun run seed` (= `seed-cli.ts`) runs `seedDatabase` on the app DB (`DATABASE_PATH` or `./data/storefront.sqlite`) and prints counts per entity plus table totals. `--images` also rewrites the placeholder SVGs and removes stale ones from `public/images/products/gallery/`. Everything is an idempotent upsert keyed by stable ids/slugs: running it twice leaves identical counts. Re-seeding resets seeded columns (including product **stock**) but keeps real activity: shopper votes stay, coupon `used_count` never decreases.

What it seeds: 12 brands, 8 departments x 3 categories (32 rows), 125 products (123 published + 2 future-dated "coming soon" ones that are unpublished until their date; 43 deals at 10-40% off, 12 featured, published over the last 90 days relative to the run with 23 in the last two weeks, 11 published out of stock and 17 with 1-3 left, 2-4 images each), ~280 reviews (skewed positive, some 1-2 stars, ~40% verified, 2 hidden for moderation demos; about 20 published products stay unrated) with helpful votes, ~100 questions with 0-3 answers (some from the store), coupons WELCOME10 (10%, promoted), SAVE5 ($5 off $25+), FREESHIP (free shipping on $20+, promoted), EXPIRED10 (expired), MAXED5 (max_uses 1, used 1), and shipping methods standard ($4.99, free over $35, 5-8 days), express ($9.99, 2-3 days), next_day ($19.99, 1 day). No users, lists, addresses, alerts or orders.

**Counts: never hard-code them.** Derive catalogue sizes from `SEED_CATALOG_STATS` (`total`, `published`, `unpublished`, `deals`, `featured`, `outOfStock`, `lowStock`, `newArrivals`, `byDepartment`, `byCategory`, `byBrand`; everything except `total`/`unpublished`/`legacy` counts PUBLISHED products) or filter `SEED_PUBLISHED_CATALOG`. A product is published at seed time exactly when `daysAgo >= 0` (`isSeedPublished`). The FTS index contains unpublished products too.

**Append-only order.** `SEED_PRODUCT_INPUT` is appended to, never reordered: the array index drives each product's SKU (`<prefix>-<1001 + index>`), its gallery view count and the deterministic review/Q&A generator (one PRNG stream in product order), so appending leaves every existing product's SKU, images, reviews and questions byte-identical (`seed-catalog.test.ts` proves it). Future-dated products (negative `daysAgo`) get no reviews or questions and consume no PRNG draws. After adding products run `bun run src/server/db/seed-cli.ts --images` to write their placeholder SVGs (the seed image tests compare files on disk).

**Legacy products.** The first 15 products (`SEED_PRODUCTS`, what `seedProducts(db)` inserts) keep their MVP ids, slugs, names, descriptions, prices, stock and colours exactly: stock covers 0 (`ceramic-pour-over`), 1 (`limited-print-no-1`), 3 (`walnut-desk`) and 10-100 for the rest, and `enamel-pin-set` costs 50 cents. They have no list price (MVP tests raise their prices, which the list-price CHECK would reject). Their primary images stay at `/images/products/<slug>.svg`. Everything else lives under `/images/products/gallery/` (`<slug>.svg` for new products' primaries, `<slug>--side|detail|back.svg` for gallery views), so the top-level folder still holds exactly the 15 legacy SVGs.

`SEED_PRODUCTS` / `SEED_CATALOG_PRODUCTS` entries equal what `ProductRepository.getBySlug` returns right after seeding (sparse summary fields, minus `color`); rating fields appear only once reviews are seeded.
