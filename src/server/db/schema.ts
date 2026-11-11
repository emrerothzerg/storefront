import type { Database } from "bun:sqlite";

/**
 * Versioned, idempotent schema migrations for ALL storefront tables.
 * This file is the single owner of DDL; other modules only query.
 * Append new steps to `MIGRATIONS` with the next version; never edit an
 * applied step. See README.md in this folder for the table reference.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE IF NOT EXISTS products (
  id           TEXT    PRIMARY KEY NOT NULL,
  slug         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
  currency     TEXT    NOT NULL CHECK (length(currency) = 3),
  image_url    TEXT    NOT NULL,
  stock        INTEGER NOT NULL CHECK (stock >= 0),
  created_at   TEXT    NOT NULL DEFAULT ${NOW},
  updated_at   TEXT    NOT NULL DEFAULT ${NOW}
) STRICT;

CREATE TABLE IF NOT EXISTS carts (
  session_id  TEXT PRIMARY KEY NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  updated_at  TEXT NOT NULL DEFAULT ${NOW}
) STRICT;

CREATE TABLE IF NOT EXISTS cart_items (
  cart_session_id  TEXT    NOT NULL REFERENCES carts (session_id) ON DELETE CASCADE,
  product_id       TEXT    NOT NULL REFERENCES products (id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  created_at       TEXT    NOT NULL DEFAULT ${NOW},
  updated_at       TEXT    NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (cart_session_id, product_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_cart_items_product_id ON cart_items (product_id);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT    PRIMARY KEY NOT NULL,
  session_id       TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('paid', 'payment_failed')),
  failure_code     TEXT,
  subtotal_cents   INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  shipping_cents   INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  total_cents      INTEGER NOT NULL CHECK (total_cents >= 0),
  currency         TEXT    NOT NULL CHECK (length(currency) = 3),
  full_name        TEXT    NOT NULL,
  email            TEXT    NOT NULL,
  line1            TEXT    NOT NULL,
  line2            TEXT,
  city             TEXT    NOT NULL,
  region           TEXT    NOT NULL,
  postal_code      TEXT    NOT NULL,
  country          TEXT    NOT NULL,
  card_last4       TEXT    NOT NULL,
  payment_ref      TEXT,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  created_at       TEXT    NOT NULL DEFAULT ${NOW}
) STRICT;

CREATE INDEX IF NOT EXISTS idx_orders_session_id ON orders (session_id);

CREATE TABLE IF NOT EXISTS order_items (
  order_id          TEXT    NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id        TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, product_id)
) STRICT;
`,
  },
  {
    version: 2,
    name: "phase2_catalog_reviews_lists_orders",
    sql: `
-- Catalogue taxonomy ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS categories (
  id           TEXT    PRIMARY KEY NOT NULL,
  slug         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL CHECK (length(name) > 0),
  description  TEXT    NOT NULL DEFAULT '',
  parent_id    TEXT    REFERENCES categories (id),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  image_url    TEXT,
  created_at   TEXT    NOT NULL DEFAULT ${NOW},
  updated_at   TEXT    NOT NULL DEFAULT ${NOW},
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories (parent_id);

-- Two levels only (department -> category): a parent must be top-level, and a
-- category that has children cannot itself get a parent.
CREATE TRIGGER IF NOT EXISTS trg_categories_depth_insert
BEFORE INSERT ON categories
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT parent_id FROM categories WHERE id = NEW.parent_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'categories: maximum depth is 2 (department -> category)');
END;

CREATE TRIGGER IF NOT EXISTS trg_categories_depth_update
BEFORE UPDATE OF parent_id ON categories
WHEN NEW.parent_id IS NOT NULL
 AND ((SELECT parent_id FROM categories WHERE id = NEW.parent_id) IS NOT NULL
      OR EXISTS (SELECT 1 FROM categories WHERE parent_id = NEW.id))
BEGIN
  SELECT RAISE(ABORT, 'categories: maximum depth is 2 (department -> category)');
END;

CREATE TABLE IF NOT EXISTS brands (
  id           TEXT PRIMARY KEY NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL CHECK (length(name) > 0),
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  updated_at   TEXT NOT NULL DEFAULT ${NOW}
) STRICT;

-- Products: new columns (ADD COLUMN only; no table rebuild) -------------------
-- ADD COLUMN cannot use an expression default, so published_at defaults to ''
-- and trg_products_published_at fills it from created_at on insert.

ALTER TABLE products ADD COLUMN brand_id TEXT REFERENCES brands (id);
ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES categories (id);
ALTER TABLE products ADD COLUMN list_price_cents INTEGER
  CHECK (list_price_cents IS NULL OR list_price_cents >= price_cents);
ALTER TABLE products ADD COLUMN sku TEXT;
ALTER TABLE products ADD COLUMN bullets TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN specs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN images TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0);
ALTER TABLE products ADD COLUMN rating_sum INTEGER NOT NULL DEFAULT 0 CHECK (rating_sum >= 0);
ALTER TABLE products ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1));
ALTER TABLE products ADD COLUMN published_at TEXT NOT NULL DEFAULT '';

UPDATE products SET published_at = created_at WHERE published_at = '';

CREATE TRIGGER IF NOT EXISTS trg_products_published_at
AFTER INSERT ON products
WHEN NEW.published_at = ''
BEGIN
  UPDATE products SET published_at = NEW.created_at WHERE rowid = NEW.rowid;
END;

CREATE INDEX IF NOT EXISTS idx_products_category_id ON products (category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products (brand_id);
CREATE INDEX IF NOT EXISTS idx_products_is_featured ON products (is_featured);
CREATE INDEX IF NOT EXISTS idx_products_published_at ON products (published_at);
CREATE INDEX IF NOT EXISTS idx_products_category_brand_price ON products (category_id, brand_id, price_cents);

-- Full-text search -------------------------------------------------------------
-- products_search is the external content of products_fts: one row per product
-- with brand, category and department names joined in. bullets is indexed as
-- its raw JSON text (the tokenizer drops the JSON punctuation; json_each is not
-- usable in a view read by triggers); malformed JSON indexes as ''.
-- rowid = products.rowid. Column order (for bm25 weights): name, brand_name,
-- category_name, description, bullets, department_name.
-- Sync: BEFORE triggers remove the row as currently indexed (read through the
-- view, so the 'delete' values always match), AFTER triggers re-add it.
-- Never use INSERT OR REPLACE on products: REPLACE deletes skip triggers.

CREATE VIEW IF NOT EXISTS products_search AS
SELECT
  p.rowid AS product_rowid,
  p.name AS name,
  coalesce(b.name, '') AS brand_name,
  coalesce(c.name, '') AS category_name,
  p.description AS description,
  CASE WHEN json_valid(p.bullets) THEN p.bullets ELSE '' END AS bullets,
  coalesce(d.name, '') AS department_name
FROM products AS p
LEFT JOIN brands AS b ON b.id = p.brand_id
LEFT JOIN categories AS c ON c.id = p.category_id
LEFT JOIN categories AS d ON d.id = c.parent_id;

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name, brand_name, category_name, description, bullets, department_name,
  content = 'products_search',
  content_rowid = 'product_rowid',
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3'
);

-- Term list (term, doc, cnt) for "did you mean" / suggestion queries.
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts_vocab USING fts5vocab(products_fts, 'row');

CREATE TRIGGER IF NOT EXISTS trg_products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts (rowid, name, brand_name, category_name, description, bullets, department_name)
  SELECT product_rowid, name, brand_name, category_name, description, bullets, department_name FROM products_search WHERE product_rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_products_fts_bd BEFORE DELETE ON products BEGIN
  INSERT INTO products_fts (products_fts, rowid, name, brand_name, category_name, description, bullets, department_name)
  SELECT 'delete', product_rowid, name, brand_name, category_name, description, bullets, department_name FROM products_search WHERE product_rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_products_fts_bu
BEFORE UPDATE OF name, description, bullets, brand_id, category_id ON products BEGIN
  INSERT INTO products_fts (products_fts, rowid, name, brand_name, category_name, description, bullets, department_name)
  SELECT 'delete', product_rowid, name, brand_name, category_name, description, bullets, department_name FROM products_search WHERE product_rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_products_fts_au
AFTER UPDATE OF name, description, bullets, brand_id, category_id ON products BEGIN
  INSERT INTO products_fts (rowid, name, brand_name, category_name, description, bullets, department_name)
  SELECT product_rowid, name, brand_name, category_name, description, bullets, department_name FROM products_search WHERE product_rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_brands_fts_bu BEFORE UPDATE OF name ON brands BEGIN
  INSERT INTO products_fts (products_fts, rowid, name, brand_name, category_name, description, bullets, department_name)
  SELECT 'delete', s.product_rowid, s.name, s.brand_name, s.category_name, s.description, s.bullets, s.department_name
    FROM products_search AS s JOIN products AS p ON p.rowid = s.product_rowid
   WHERE p.brand_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_brands_fts_au AFTER UPDATE OF name ON brands BEGIN
  INSERT INTO products_fts (rowid, name, brand_name, category_name, description, bullets, department_name)
  SELECT s.product_rowid, s.name, s.brand_name, s.category_name, s.description, s.bullets, s.department_name
    FROM products_search AS s JOIN products AS p ON p.rowid = s.product_rowid
   WHERE p.brand_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_categories_fts_bu BEFORE UPDATE OF name, parent_id ON categories BEGIN
  INSERT INTO products_fts (products_fts, rowid, name, brand_name, category_name, description, bullets, department_name)
  SELECT 'delete', s.product_rowid, s.name, s.brand_name, s.category_name, s.description, s.bullets, s.department_name
    FROM products_search AS s JOIN products AS p ON p.rowid = s.product_rowid
   WHERE p.category_id = OLD.id
      OR p.category_id IN (SELECT id FROM categories WHERE parent_id = OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_categories_fts_au AFTER UPDATE OF name, parent_id ON categories BEGIN
  INSERT INTO products_fts (rowid, name, brand_name, category_name, description, bullets, department_name)
  SELECT s.product_rowid, s.name, s.brand_name, s.category_name, s.description, s.bullets, s.department_name
    FROM products_search AS s JOIN products AS p ON p.rowid = s.product_rowid
   WHERE p.category_id = NEW.id
      OR p.category_id IN (SELECT id FROM categories WHERE parent_id = NEW.id);
END;

-- Carts and order snapshots -------------------------------------------------------

ALTER TABLE carts ADD COLUMN coupon_code TEXT;
ALTER TABLE carts ADD COLUMN shipping_method_id TEXT;

ALTER TABLE order_items ADD COLUMN product_slug TEXT;
ALTER TABLE order_items ADD COLUMN image_url TEXT;

CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items (product_id);

-- Reviews ----------------------------------------------------------------------
-- products.rating_count / rating_sum count PUBLISHED reviews only; the
-- triggers below keep them in step with inserts, deletes, rating changes,
-- product moves and status changes. recomputeProductRating() in
-- src/server/catalog/product-repository.ts is the safety net.

CREATE TABLE IF NOT EXISTS reviews (
  id                 TEXT    PRIMARY KEY NOT NULL,
  product_id         TEXT    NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  session_id         TEXT    NOT NULL,
  display_name       TEXT    NOT NULL CHECK (length(display_name) > 0),
  rating             INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title              TEXT    NOT NULL DEFAULT '',
  body               TEXT    NOT NULL DEFAULT '',
  verified_purchase  INTEGER NOT NULL DEFAULT 0 CHECK (verified_purchase IN (0, 1)),
  helpful_count      INTEGER NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  status             TEXT    NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  created_at         TEXT    NOT NULL DEFAULT ${NOW},
  updated_at         TEXT    NOT NULL DEFAULT ${NOW},
  UNIQUE (product_id, session_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_reviews_product_status_created ON reviews (product_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews (created_at);

CREATE TRIGGER IF NOT EXISTS trg_reviews_rating_ai AFTER INSERT ON reviews
WHEN NEW.status = 'published'
BEGIN
  UPDATE products SET rating_count = rating_count + 1, rating_sum = rating_sum + NEW.rating
   WHERE id = NEW.product_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_reviews_rating_ad AFTER DELETE ON reviews
WHEN OLD.status = 'published'
BEGIN
  UPDATE products SET rating_count = rating_count - 1, rating_sum = rating_sum - OLD.rating
   WHERE id = OLD.product_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_reviews_rating_au_old AFTER UPDATE OF rating, product_id, status ON reviews
WHEN OLD.status = 'published'
BEGIN
  UPDATE products SET rating_count = rating_count - 1, rating_sum = rating_sum - OLD.rating
   WHERE id = OLD.product_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_reviews_rating_au_new AFTER UPDATE OF rating, product_id, status ON reviews
WHEN NEW.status = 'published'
BEGIN
  UPDATE products SET rating_count = rating_count + 1, rating_sum = rating_sum + NEW.rating
   WHERE id = NEW.product_id;
END;

CREATE TABLE IF NOT EXISTS review_votes (
  review_id   TEXT NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (review_id, session_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS trg_review_votes_ai AFTER INSERT ON review_votes BEGIN
  UPDATE reviews SET helpful_count = helpful_count + 1 WHERE id = NEW.review_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_review_votes_ad AFTER DELETE ON review_votes BEGIN
  UPDATE reviews SET helpful_count = helpful_count - 1 WHERE id = OLD.review_id AND helpful_count > 0;
END;

-- Questions and answers ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS questions (
  id             TEXT    PRIMARY KEY NOT NULL,
  product_id     TEXT    NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  session_id     TEXT    NOT NULL,
  display_name   TEXT    NOT NULL CHECK (length(display_name) > 0),
  body           TEXT    NOT NULL CHECK (length(body) > 0),
  helpful_count  INTEGER NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  status         TEXT    NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  created_at     TEXT    NOT NULL DEFAULT ${NOW}
) STRICT;

CREATE INDEX IF NOT EXISTS idx_questions_product_id ON questions (product_id, status, created_at);

CREATE TABLE IF NOT EXISTS answers (
  id             TEXT    PRIMARY KEY NOT NULL,
  question_id    TEXT    NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  session_id     TEXT    NOT NULL,
  display_name   TEXT    NOT NULL CHECK (length(display_name) > 0),
  body           TEXT    NOT NULL CHECK (length(body) > 0),
  is_store       INTEGER NOT NULL DEFAULT 0 CHECK (is_store IN (0, 1)),
  helpful_count  INTEGER NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  status         TEXT    NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  created_at     TEXT    NOT NULL DEFAULT ${NOW}
) STRICT;

CREATE INDEX IF NOT EXISTS idx_answers_question_id ON answers (question_id, status, created_at);

CREATE TABLE IF NOT EXISTS question_votes (
  question_id  TEXT NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (question_id, session_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS trg_question_votes_ai AFTER INSERT ON question_votes BEGIN
  UPDATE questions SET helpful_count = helpful_count + 1 WHERE id = NEW.question_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_question_votes_ad AFTER DELETE ON question_votes BEGIN
  UPDATE questions SET helpful_count = helpful_count - 1 WHERE id = OLD.question_id AND helpful_count > 0;
END;

CREATE TABLE IF NOT EXISTS answer_votes (
  answer_id   TEXT NOT NULL REFERENCES answers (id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (answer_id, session_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS trg_answer_votes_ai AFTER INSERT ON answer_votes BEGIN
  UPDATE answers SET helpful_count = helpful_count + 1 WHERE id = NEW.answer_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_answer_votes_ad AFTER DELETE ON answer_votes BEGIN
  UPDATE answers SET helpful_count = helpful_count - 1 WHERE id = OLD.answer_id AND helpful_count > 0;
END;

-- Wishlists / save for later -------------------------------------------------------
-- Service rules: exactly one save_for_later list per session (created lazily;
-- enforced by ux_lists_save_for_later, so INSERT ... ON CONFLICT DO NOTHING is
-- race-safe); at most one wishlist with is_default = 1 per session (service rule).

CREATE TABLE IF NOT EXISTS lists (
  id           TEXT    PRIMARY KEY NOT NULL,
  session_id   TEXT    NOT NULL,
  name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind         TEXT    NOT NULL CHECK (kind IN ('wishlist', 'save_for_later')),
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_public    INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  share_token  TEXT    UNIQUE,
  created_at   TEXT    NOT NULL DEFAULT ${NOW},
  updated_at   TEXT    NOT NULL DEFAULT ${NOW}
) STRICT;

CREATE INDEX IF NOT EXISTS idx_lists_session_id ON lists (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lists_save_for_later ON lists (session_id) WHERE kind = 'save_for_later';

CREATE TABLE IF NOT EXISTS list_items (
  list_id             TEXT    NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  product_id          TEXT    NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  quantity_desired    INTEGER NOT NULL DEFAULT 1 CHECK (quantity_desired > 0),
  priority            INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1, 2)),
  price_at_add_cents  INTEGER NOT NULL CHECK (price_at_add_cents >= 0),
  note                TEXT,
  added_at            TEXT    NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (list_id, product_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_list_items_product_id ON list_items (product_id);

-- Browsing history: one row per (session, product); upsert bumps viewed_at ----------

CREATE TABLE IF NOT EXISTS product_views (
  session_id  TEXT NOT NULL,
  product_id  TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  viewed_at   TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (session_id, product_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_product_views_session ON product_views (session_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_views_product ON product_views (product_id);

-- Promotions and shipping ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS coupons (
  code                TEXT    PRIMARY KEY NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code = upper(code)),
  kind                TEXT    NOT NULL CHECK (kind IN ('percent', 'fixed', 'free_shipping')),
  value               INTEGER NOT NULL,
  min_subtotal_cents  INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal_cents >= 0),
  max_uses            INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  used_count          INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  starts_at           TEXT,
  expires_at          TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  promoted            INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0, 1)),
  created_at          TEXT    NOT NULL DEFAULT ${NOW},
  updated_at          TEXT    NOT NULL DEFAULT ${NOW},
  CHECK ((kind = 'percent' AND value BETWEEN 1 AND 100)
      OR (kind = 'fixed' AND value > 0)
      OR (kind = 'free_shipping' AND value = 0)),
  CHECK (max_uses IS NULL OR used_count <= max_uses)
) STRICT;

-- One redemption per (coupon, session).
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  coupon_code  TEXT NOT NULL REFERENCES coupons (code),
  session_id   TEXT NOT NULL,
  order_id     TEXT,
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (coupon_code, session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS shipping_methods (
  id               TEXT    PRIMARY KEY NOT NULL,
  name             TEXT    NOT NULL CHECK (length(name) > 0),
  description      TEXT    NOT NULL DEFAULT '',
  price_cents      INTEGER NOT NULL CHECK (price_cents >= 0),
  free_over_cents  INTEGER CHECK (free_over_cents IS NULL OR free_over_cents >= 0),
  min_days         INTEGER NOT NULL CHECK (min_days >= 0),
  max_days         INTEGER NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at       TEXT    NOT NULL DEFAULT ${NOW},
  updated_at       TEXT    NOT NULL DEFAULT ${NOW},
  CHECK (max_days >= min_days)
) STRICT;

-- Fixed-window rate limiter counters (key = e.g. "review:<session>").
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, window_start)) STRICT;

-- Orders: fulfilment lifecycle (orders.status stays the payment status) -----------------

ALTER TABLE orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'processing'
  CHECK (fulfillment_status IN ('processing', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'));
ALTER TABLE orders ADD COLUMN coupon_code TEXT;
ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);
ALTER TABLE orders ADD COLUMN shipping_method_id TEXT;
ALTER TABLE orders ADD COLUMN shipping_method_name TEXT;
ALTER TABLE orders ADD COLUMN estimated_delivery_start TEXT;
ALTER TABLE orders ADD COLUMN estimated_delivery_end TEXT;
ALTER TABLE orders ADD COLUMN cancelled_at TEXT;
ALTER TABLE orders ADD COLUMN shipped_at TEXT;
ALTER TABLE orders ADD COLUMN delivered_at TEXT;
ALTER TABLE orders ADD COLUMN phone TEXT;
ALTER TABLE orders ADD COLUMN delivery_note TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_session_created ON orders (session_id, created_at);

CREATE TABLE IF NOT EXISTS order_events (
  id        INTEGER PRIMARY KEY,
  order_id  TEXT    NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  status    TEXT    NOT NULL
    CHECK (status IN ('processing', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled')),
  at        TEXT    NOT NULL DEFAULT ${NOW},
  note      TEXT,
  UNIQUE (order_id, status)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events (order_id);

-- Back-in-stock alerts (no email: session-scoped), contact form, address book -----------

CREATE TABLE IF NOT EXISTS stock_alerts (
  id               TEXT PRIMARY KEY NOT NULL,
  product_id       TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT ${NOW},
  acknowledged_at  TEXT,
  UNIQUE (product_id, session_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_stock_alerts_session_id ON stock_alerts (session_id);

CREATE TABLE IF NOT EXISTS contact_messages (
  id            TEXT PRIMARY KEY NOT NULL,
  reference     TEXT NOT NULL UNIQUE CHECK (length(reference) BETWEEN 4 AND 32),
  session_id    TEXT,
  name          TEXT NOT NULL CHECK (length(name) > 0),
  email         TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  topic         TEXT NOT NULL CHECK (length(topic) > 0),
  order_id      TEXT,
  product_slug  TEXT,
  message       TEXT NOT NULL CHECK (length(message) > 0),
  created_at    TEXT NOT NULL DEFAULT ${NOW}
) STRICT;

-- Service rule: at most one is_default = 1 address per session (not an index,
-- so the service can switch defaults in any order inside its transaction).
CREATE TABLE IF NOT EXISTS addresses (
  id           TEXT    PRIMARY KEY NOT NULL,
  session_id   TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  full_name    TEXT    NOT NULL,
  phone        TEXT,
  line1        TEXT    NOT NULL,
  line2        TEXT,
  city         TEXT    NOT NULL,
  region       TEXT    NOT NULL,
  postal_code  TEXT    NOT NULL,
  country      TEXT    NOT NULL,
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT ${NOW},
  updated_at   TEXT    NOT NULL DEFAULT ${NOW}
) STRICT;

CREATE INDEX IF NOT EXISTS idx_addresses_session_id ON addresses (session_id);

-- User accounts --------------------------------------------------------------------
-- Owner-keyed tables keep session_id: it holds either a guest session id or a
-- user's owner_key (both UUIDs). email is stored trimmed + lower-cased
-- (service rule). Never seed users; never select password_hash outside auth.

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT    PRIMARY KEY NOT NULL,
  email               TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL,
  display_name        TEXT    NOT NULL,
  owner_key           TEXT    NOT NULL UNIQUE,
  failed_login_count  INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until        TEXT,
  last_login_at       TEXT,
  created_at          TEXT    NOT NULL DEFAULT ${NOW},
  updated_at          TEXT    NOT NULL DEFAULT ${NOW}
) STRICT;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT PRIMARY KEY NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  revoked_at    TEXT,
  user_agent    TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions (user_id);

-- Index rows that existed before this migration.
INSERT INTO products_fts (products_fts) VALUES ('rebuild');
`,
  },
];

/** Latest schema version this build knows about. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * Applies every migration not yet recorded in `schema_migrations`, each in
 * its own transaction. Running it again is a no-op. Returns the versions applied.
 */
export function runMigrations(db: Database): number[] {
  db.run(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY NOT NULL,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL DEFAULT ${NOW}
) STRICT`);

  const appliedRows = db
    .query<{ version: number }, []>("SELECT version FROM schema_migrations")
    .all();
  const applied = new Set(appliedRows.map((row) => row.version));
  const record = db.query<unknown, [number, string]>(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  const newlyApplied: number[] = [];
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name);
    })();
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}
