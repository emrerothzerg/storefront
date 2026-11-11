import type { Database } from "bun:sqlite";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import type { User } from "@/lib/types";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createAuthRepository, type AuthRepository } from "./auth-repository";
import type { AccountServiceDeps } from "./account-service";

/**
 * Test-only fixture for the T118 tests (imported by colocated tests only):
 * a seeded `:memory:` DB with users A and B and guest H, each owning rows in
 * every owner-keyed table, plus fast fake auth deps (no argon2).
 */

export const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

export const PASSWORDS = {
  A: "correct horse battery A",
  B: "correct horse battery B",
} as const;

/** Fake stored hash: deliberately not the password, but derived from it. */
export function fakeHash(password: string): string {
  return `fake$${Bun.hash(`pepper:${password}`).toString(16)}`;
}

export interface SessionRef {
  readonly id: string;
  readonly tokenHash: string;
}

export interface Party {
  readonly key: string;
  readonly label: "A" | "B" | "H";
  readonly reviewIds: string[];
  readonly questionIds: string[];
  readonly answerIds: string[];
  readonly orderIds: string[];
}

export interface UserParty extends Party {
  readonly user: User;
  readonly password: string;
  readonly sessions: readonly SessionRef[];
}

export interface Fixture {
  readonly db: Database;
  readonly repo: AuthRepository;
  readonly A: UserParty;
  readonly B: UserParty;
  readonly H: Party;
  readonly products: readonly string[];
}

function randomHex64(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createSession(repo: AuthRepository, userId: string): SessionRef {
  const tokenHash = randomHex64();
  const session = repo.createAuthSession(
    { userId, tokenHash, expiresAt: new Date(NOW + 30 * DAY).toISOString() },
    NOW,
  );
  if (!session.ok) throw new Error("fixture: session");
  return { id: session.value.id, tokenHash };
}

function exec(db: Database, sql: string, ...params: (string | number | null)[]): void {
  db.query<unknown, (string | number | null)[]>(sql).run(...params);
}

/** One row (or two) per owner-keyed table for `key`. */
function seedParty(db: Database, key: string, label: Party["label"], products: readonly string[]): Party {
  const [p1, p2, p3, p4] = products as [string, string, string, string];
  const tag = `${label}-${key.slice(0, 8)}`;
  exec(db, "INSERT INTO carts (session_id, coupon_code) VALUES (?, 'WELCOME10')", key);
  exec(db, "INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 1), (?1, ?3, 2)", key, p1, p2);

  const wishlist = `list-${tag}`;
  const sfl = `sfl-${tag}`;
  exec(db, "INSERT INTO lists (id, session_id, name, kind, is_default) VALUES (?, ?, 'Wish', 'wishlist', 1)", wishlist, key);
  exec(db, "INSERT INTO lists (id, session_id, name, kind) VALUES (?, ?, 'Saved', 'save_for_later')", sfl, key);
  exec(
    db,
    "INSERT INTO list_items (list_id, product_id, price_at_add_cents) VALUES (?1, ?2, 100), (?1, ?3, 200), (?4, ?5, 300)",
    wishlist,
    p1,
    p2,
    sfl,
    p3,
  );
  exec(db, "INSERT INTO product_views (session_id, product_id) VALUES (?1, ?2), (?1, ?3)", key, p1, p2);

  const reviewIds = [`rev-${tag}-1`];
  const ratings = { A: 5, B: 4, H: 3 } as const;
  exec(
    db,
    "INSERT INTO reviews (id, product_id, session_id, display_name, rating, title, body) VALUES (?, ?, ?, ?, ?, 'T', 'Body')",
    reviewIds[0] as string,
    p1,
    key,
    `Name ${label}`,
    ratings[label],
  );
  if (label === "A") {
    reviewIds.push(`rev-${tag}-2`);
    exec(
      db,
      "INSERT INTO reviews (id, product_id, session_id, display_name, rating, status) VALUES (?, ?, ?, 'Name A', 1, 'hidden')",
      reviewIds[1] as string,
      p2,
      key,
    );
  }

  const questionIds = [`q-${tag}`];
  exec(
    db,
    "INSERT INTO questions (id, product_id, session_id, display_name, body) VALUES (?, ?, ?, ?, ?)",
    questionIds[0] as string,
    p3,
    key,
    `Asker ${label}`,
    `Question from ${label}?`,
  );

  exec(db, "INSERT INTO stock_alerts (id, product_id, session_id) VALUES (?, ?, ?)", `alert-${tag}`, p4, key);
  exec(
    db,
    "INSERT INTO contact_messages (id, reference, session_id, name, email, topic, message) VALUES (?, ?, ?, ?, ?, 'other', 'Hello')",
    `cm-${tag}`,
    `C-${tag.slice(0, 10).toUpperCase()}`,
    key,
    `Contact ${label}`,
    `${label.toLowerCase()}@example.com`,
  );
  for (const n of [1, 2]) {
    exec(
      db,
      `INSERT INTO addresses (id, session_id, full_name, phone, line1, line2, city, region, postal_code, country, is_default)
       VALUES (?, ?, ?, '555-0100', '1 Main St', 'Apt 2', 'Springfield', 'IL', '62701', 'US', ?)`,
      `addr-${tag}-${n}`,
      key,
      `Person ${label}`,
      n === 1 ? 1 : 0,
    );
  }

  const orderIds = [`ord-${tag}-1`, `ord-${tag}-2`];
  orderIds.forEach((id, i) => {
    exec(
      db,
      `INSERT INTO orders (id, session_id, status, subtotal_cents, shipping_cents, total_cents, currency, full_name, email,
         line1, line2, city, region, postal_code, country, card_last4, payment_ref, idempotency_key, created_at,
         phone, delivery_note, coupon_code, discount_cents, fulfillment_status)
       VALUES (?1, ?2, 'paid', 1000, 499, ?3, 'USD', ?4, ?5, '1 Main St', 'Apt 2', 'Springfield', 'IL', '62701', 'US',
         '4242', ?6, ?7, ?8, '555-0100', 'Leave at door', ?9, ?10, 'shipped')`,
      id,
      key,
      1499 + i,
      `Person ${label}`,
      `${label.toLowerCase()}@example.com`,
      `pay_${id}`,
      `idem-${id}`,
      new Date(NOW - (i + 1) * DAY).toISOString(),
      i === 0 ? "WELCOME10" : null,
      i === 0 ? 100 : 0,
    );
    exec(
      db,
      "INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'Thing', 1000, 1)",
      id,
      p1,
    );
    exec(db, "INSERT INTO order_events (order_id, status, at) VALUES (?1, 'processing', ?2), (?1, 'shipped', ?2)", id, new Date(NOW - DAY).toISOString());
  });
  exec(
    db,
    "INSERT INTO coupon_redemptions (coupon_code, session_id, order_id) VALUES ('WELCOME10', ?, ?)",
    key,
    orderIds[0] as string,
  );

  return { key, label, reviewIds, questionIds, answerIds: [], orderIds };
}

function answer(db: Database, party: Party, questionId: string): void {
  const id = `ans-${party.label}-${questionId}`;
  exec(
    db,
    "INSERT INTO answers (id, question_id, session_id, display_name, body) VALUES (?, ?, ?, ?, ?)",
    id,
    questionId,
    party.key,
    `Answerer ${party.label}`,
    `Answer from ${party.label}`,
  );
  party.answerIds.push(id);
}

function createUserParty(db: Database, repo: AuthRepository, label: "A" | "B", products: readonly string[]): UserParty {
  const password = PASSWORDS[label];
  const created = repo.createUser(
    { email: `${label.toLowerCase()}@example.com`, passwordHash: fakeHash(password), displayName: `Name ${label}` },
    NOW,
  );
  if (!created.ok) throw new Error("fixture: user");
  const user = created.value;
  const party = seedParty(db, user.ownerKey, label, products);
  const sessions = [createSession(repo, user.id), createSession(repo, user.id)];
  return { ...party, user, password, sessions };
}

export function createFixture(): Fixture {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const products = db
    .query<{ id: string }, []>("SELECT id FROM products WHERE stock > 0 ORDER BY id LIMIT 4")
    .all()
    .map((r) => r.id);
  const repo = createAuthRepository(db);
  const A = createUserParty(db, repo, "A", products);
  const B = createUserParty(db, repo, "B", products);
  const H = seedParty(db, globalThis.crypto.randomUUID(), "H", products);

  // Cross-party activity.
  answer(db, B, A.questionIds[0] as string); // B answers A's question (must survive, R-7)
  answer(db, A, B.questionIds[0] as string); // A answers B's question (anonymised)
  answer(db, H, B.questionIds[0] as string);
  const vote = (table: string, column: string, target: string, key: string) =>
    exec(db, `INSERT INTO ${table} (${column}, session_id) VALUES (?, ?)`, target, key);
  vote("review_votes", "review_id", B.reviewIds[0] as string, A.key); // A -> B's review
  vote("review_votes", "review_id", H.reviewIds[0] as string, A.key); // A -> H's review
  vote("review_votes", "review_id", A.reviewIds[0] as string, B.key); // B -> A's review (cascades)
  vote("question_votes", "question_id", B.questionIds[0] as string, A.key); // A -> B's question
  vote("question_votes", "question_id", A.questionIds[0] as string, B.key); // B -> A's question (stays)
  vote("answer_votes", "answer_id", B.answerIds[0] as string, A.key); // A -> B's answer
  vote("answer_votes", "answer_id", H.answerIds[0] as string, B.key);
  exec(db, "INSERT INTO rate_limits (key, window_start, count) VALUES (?, 1, 3)", `900:account.delete:${A.key}`);

  return { db, repo, A, B, H, products };
}

export interface FakeAuth {
  readonly deps: AccountServiceDeps;
  readonly verifyCalls: { userId: string; now: number | undefined }[];
  readonly hashCalls: { count: number };
  readonly logs: string[];
}

/**
 * Fake T116 functions with the documented behaviour: verify against the
 * stored fake hash, wrong password -> recordLoginFailure + INVALID_CREDENTIALS,
 * locked -> ACCOUNT_LOCKED. Policy: string, 8..128 UTF-16 units, not on a
 * tiny weak list, not the email local part.
 */
export function createFakeAuth(db: Database, overrides: Partial<AccountServiceDeps> = {}): FakeAuth {
  const repo = createAuthRepository(db);
  const verifyCalls: FakeAuth["verifyCalls"] = [];
  const hashCalls = { count: 0 };
  const logs: string[] = [];
  const verifyPassword = async (userId: string, password: unknown, now?: number): Promise<Result<void, AppError>> => {
    verifyCalls.push({ userId, now });
    const user = repo.findUserById(userId);
    if (user === null) return fail("NOT_FOUND", "Account not found.");
    const row = db
      .query<{ password_hash: string; locked_until: string | null }, [string]>(
        "SELECT password_hash, locked_until FROM users WHERE id = ?",
      )
      .get(userId);
    const at = now ?? NOW;
    if (row?.locked_until != null && Date.parse(row.locked_until) > at) {
      return fail("ACCOUNT_LOCKED", "Too many attempts.", {
        retryAfterSeconds: Math.ceil((Date.parse(row.locked_until) - at) / 1000),
      });
    }
    if (typeof password !== "string" || row?.password_hash !== fakeHash(password)) {
      repo.recordLoginFailure(userId, at);
      return fail("INVALID_CREDENTIALS", "Email or password is incorrect");
    }
    return ok(undefined);
  };
  const deps: AccountServiceDeps = {
    db,
    verifyPassword,
    hashPassword: async (password) => {
      hashCalls.count++;
      return fakeHash(password);
    },
    validatePassword: (raw, ctx) => {
      if (typeof raw !== "string") return fail("VALIDATION_FAILED", "Password is required.", { fields: { password: { code: "REQUIRED", message: "Password is required." } } });
      if (raw.length < 8 || raw.length > 128) {
        return fail("VALIDATION_FAILED", "Password must be 8 to 128 characters.", {
          fields: { password: { code: raw.length < 8 ? "TOO_SHORT" : "TOO_LONG", message: "Password must be 8 to 128 characters." } },
        });
      }
      const local = ctx.email?.split("@")[0];
      if (["password", "12345678", "qwertyuiop"].includes(raw.toLowerCase()) || raw.toLowerCase() === local) {
        return fail("VALIDATION_FAILED", "That password is too common.", {
          fields: { password: { code: "WEAK", message: "That password is too common." } },
        });
      }
      return ok(raw);
    },
    revokeOthers: (userId, keepSessionId, now) => repo.revokeOthers(userId, keepSessionId, now),
    now: () => NOW,
    logger: {
      error: (...args: unknown[]) => logs.push(args.map((a) => JSON.stringify(a)).join(" ")),
      warn: (...args: unknown[]) => logs.push(args.map((a) => JSON.stringify(a)).join(" ")),
    },
    ...overrides,
  };
  return { deps, verifyCalls, hashCalls, logs };
}

/** Every row of every real table (FTS shadow tables and sqlite internals excluded), order-independent. */
export function snapshotDatabase(db: Database, exclude: readonly string[] = []): Record<string, string[]> {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products_fts%' ORDER BY name",
    )
    .all()
    .map((r) => r.name)
    .filter((name) => !exclude.includes(name));
  const out: Record<string, string[]> = {};
  for (const table of tables) {
    out[table] = db
      .query<Record<string, unknown>, []>(`SELECT * FROM ${table}`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return out;
}

/** Tables that have an owner column, discovered from the live schema. */
export function discoverOwnerColumns(db: Database): { table: string; column: string }[] {
  return db
    .query<{ table: string; column: string }, []>(
      `SELECT m.name AS "table", p.name AS "column"
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table' AND p.name IN ('session_id', 'cart_session_id')
        ORDER BY m.name`,
    )
    .all();
}
