/**
 * QA adversarial tests for T42 (contact message service), src/server/contact/**.
 * Owned by QA (QA-W1-T42). In-memory DB only (one worker test uses a temp file
 * under os.tmpdir()); never touches ./data/.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import type { AppError, Result } from "@/lib/result";
import {
  CONTACT_DUPLICATE_WINDOW_MS,
  CONTACT_LIST_LIMIT,
  CONTACT_TOPICS,
  REFERENCE_ALPHABET,
  SqliteContactService,
  generateReference,
  type ContactInput,
  type ContactReceipt,
  type ContactService,
} from "@/server/contact/contact-service";

const A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const B = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const MIN = 60_000;
const CONTACT_DIR = join(import.meta.dir, "../../../src/server/contact");

const NAME = "Quillon Pemberton-Vasquez";
const EMAIL = "quillon.secret.pii@example.org";
const MESSAGE = "Hello team, my parcel QA-PII-MARKER-77 arrived crushed. Please advise.";
const REF_RE = /^C-[0-9A-HJKMNP-TV-Z]{8}$/;

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

interface LogSpy {
  readonly calls: unknown[][];
  readonly logger: Pick<Console, "error" | "warn">;
}
function logSpy(): LogSpy {
  const calls: unknown[][] = [];
  return {
    calls,
    logger: {
      error: (...a: unknown[]) => void calls.push(a),
      warn: (...a: unknown[]) => void calls.push(a),
    },
  };
}

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Harness {
  readonly db: Database;
  readonly svc: ContactService;
  readonly log: LogSpy;
  readonly slug: string;
}
function harness(opts: { random?: () => number } = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  open.push(db);
  const log = logSpy();
  const svc = new SqliteContactService({ db, logger: log.logger, ...(opts.random ? { random: opts.random } : {}) });
  const row = db
    .query<{ slug: string }, []>("SELECT slug FROM products WHERE published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY slug LIMIT 1")
    .get();
  return { db, svc, log, slug: row!.slug };
}

function input(over: Partial<Record<keyof ContactInput, unknown>> = {}): ContactInput {
  return { name: NAME, email: EMAIL, topic: "shipping", message: MESSAGE, ...over };
}

function insertOrder(db: Database, id: string, sessionId: string): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key)
     VALUES (?, ?, 'paid', 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', ?)`,
  ).run(id, sessionId, `qa-key-${id}`);
}

function okValue(r: Result<ContactReceipt, AppError>): ContactReceipt {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
function errOf<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error("expected error");
  return r.error;
}
function fieldsOf(e: AppError): Record<string, { code: string; message: string }> {
  return (e.details?.fields ?? {}) as Record<string, { code: string; message: string }>;
}
function rowCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM contact_messages").get()!.n;
}
interface StoredRow {
  session_id: string | null;
  name: string;
  email: string;
  topic: string;
  order_id: string | null;
  product_slug: string | null;
  message: string;
  created_at: string;
}
function stored(db: Database, reference: string): StoredRow {
  return db
    .query<StoredRow, [string]>(
      "SELECT session_id, name, email, topic, order_id, product_slug, message, created_at FROM contact_messages WHERE reference = ?",
    )
    .get(reference)!;
}

// ---------------------------------------------------------------------------
describe("criterion 1: submit contract, references, per-field validation", () => {
  test("valid submit returns { reference, createdAt } exactly; createdAt = ISO(now); row stored", () => {
    const { db, svc } = harness();
    const r = okValue(svc.submit(A, input(), T0));
    expect(Object.keys(r).sort()).toEqual(["createdAt", "reference"]);
    expect(r.reference).toMatch(REF_RE);
    expect(r.createdAt).toBe("2026-11-07T10:00:00.000Z");
    const row = stored(db, r.reference);
    expect(row).toMatchObject({ session_id: A, name: NAME, email: EMAIL, topic: "shipping", message: MESSAGE });
  });

  test("10,000 references from a seeded random: unique, C- + 8 Crockford chars, never I L O U", () => {
    const rnd = seeded(20261107);
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const ref = generateReference(rnd);
      expect(ref).toMatch(REF_RE);
      expect(ref.slice(2)).not.toMatch(/[ILOU]/);
      for (const ch of ref.slice(2)) expect(REFERENCE_ALPHABET.includes(ch)).toBe(true);
      seen.add(ref);
    }
    expect(seen.size).toBe(10_000);
    expect(REFERENCE_ALPHABET).toHaveLength(32);
    expect(new Set(REFERENCE_ALPHABET).size).toBe(32);
  });

  test("hostile random sources (NaN, Infinity, -1, 1, 0.9999999) still yield alphabet-only references", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1, 0.9999999, 5]) {
      expect(generateReference(() => v)).toMatch(REF_RE);
    }
  });

  test("references persisted by the service are unique across 300 submits with a seeded random", () => {
    const { db, svc } = harness({ random: seeded(7) });
    const refs = new Set<string>();
    for (let i = 0; i < 300; i++) refs.add(okValue(svc.submit(null, input({ message: `${MESSAGE} #${i}` }), T0 + i)).reference);
    expect(refs.size).toBe(300);
    expect(rowCount(db)).toBe(300);
  });

  test("reference collision exhausts retries -> generic error, nothing stored, no PII logged", () => {
    const { db, svc, log } = harness({ random: () => 0 });
    okValue(svc.submit(A, input(), T0));
    const e = errOf(svc.submit(B, input({ message: `${MESSAGE} again` }), T0 + 1));
    expect(e.code).toBe("INVALID_INPUT");
    expect(rowCount(db)).toBe(1);
    const dump = JSON.stringify(log.calls);
    for (const pii of [NAME, EMAIL, "QA-PII-MARKER-77"]) expect(dump).not.toContain(pii);
  });

  test("boundaries accepted: name 80, email 254, message 10 and 2000 (after cleaning)", () => {
    const { svc } = harness();
    const email254 = `${"e".repeat(254 - "@example.com".length)}@example.com`;
    expect(email254).toHaveLength(254);
    expect(svc.submit(A, input({ name: "n".repeat(80), email: email254, message: "m".repeat(10) }), T0).ok).toBe(true);
    expect(svc.submit(A, input({ message: "z".repeat(2000) }), T0).ok).toBe(true);
    // whitespace padding is cleaned before measuring
    expect(svc.submit(B, input({ name: `   ${"n".repeat(80)}   `, message: `  ${"q".repeat(10)}  ` }), T0).ok).toBe(true);
  });

  test("one over each limit -> TOO_LONG per field; top-level TOO_LONG when all errors are length errors", () => {
    const { db, svc } = harness();
    const email255 = `${"e".repeat(255 - "@example.com".length)}@example.com`;
    const e = errOf(svc.submit(A, input({ name: "n".repeat(81), email: email255, message: "m".repeat(2001) }), T0));
    expect(e.code).toBe("TOO_LONG");
    const f = fieldsOf(e);
    expect(f.name?.code).toBe("TOO_LONG");
    expect(f.email?.code).toBe("TOO_LONG");
    expect(f.message?.code).toBe("TOO_LONG");
    expect(Object.keys(f).sort()).toEqual(["email", "message", "name"]);
    expect(rowCount(db)).toBe(0);
  });

  test("single TOO_LONG field -> top-level TOO_LONG", () => {
    const { svc } = harness();
    const e = errOf(svc.submit(A, input({ name: "n".repeat(81) }), T0));
    expect(e.code).toBe("TOO_LONG");
    expect(Object.keys(fieldsOf(e))).toEqual(["name"]);
  });

  test("mixed length + non-length errors -> top-level VALIDATION_FAILED with every field reported", () => {
    const { svc } = harness();
    const e = errOf(
      svc.submit(A, input({ name: "n".repeat(81), email: "not-an-email", topic: "billing", message: "short" }), T0),
    );
    expect(e.code).toBe("VALIDATION_FAILED");
    const f = fieldsOf(e);
    expect(f.name?.code).toBe("TOO_LONG");
    expect(f.email?.code).toBe("INVALID_EMAIL");
    expect(f.topic?.code).toBe("INVALID_TOPIC");
    expect(f.message?.code).toBe("TOO_SHORT");
  });

  test("TOO_LONG message + INVALID_ORDER -> VALIDATION_FAILED (not every error is a length error)", () => {
    const { svc } = harness();
    const e = errOf(svc.submit(A, input({ message: "m".repeat(2001), orderId: "nope" }), T0));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fieldsOf(e).message?.code).toBe("TOO_LONG");
    expect(fieldsOf(e).orderId?.code).toBe("INVALID_ORDER");
  });

  test("missing / non-string fields -> REQUIRED (name, email, message) and INVALID_TOPIC", () => {
    const { svc } = harness();
    const e = errOf(svc.submit(A, { name: undefined, email: 42, topic: undefined, message: null }, T0));
    expect(e.code).toBe("VALIDATION_FAILED");
    const f = fieldsOf(e);
    expect(f.name?.code).toBe("REQUIRED");
    expect(f.email?.code).toBe("REQUIRED");
    expect(f.topic?.code).toBe("INVALID_TOPIC");
    expect(f.message?.code).toBe("REQUIRED");
  });

  test("empty-string name/email -> REQUIRED; 9-char message -> TOO_SHORT; every field error has a message", () => {
    const { svc } = harness();
    const e = errOf(svc.submit(A, input({ name: "", email: "   ", message: "123456789" }), T0));
    const f = fieldsOf(e);
    expect(f.name?.code).toBe("REQUIRED");
    expect(f.email?.code).toBe("REQUIRED");
    expect(f.message?.code).toBe("TOO_SHORT");
    for (const v of Object.values(f)) expect(typeof v.message).toBe("string");
  });

  // DEFECT D-T42-1 (minor): empty/blank message maps to TOO_SHORT; REQUIRED is unreachable for a form post.
  test("empty / whitespace-only message is reported as REQUIRED, consistent with name and email", () => {
    const { svc } = harness();
    for (const m of ["", "     ", "​​​"]) {
      const f = fieldsOf(errOf(svc.submit(A, input({ message: m }), T0)));
      expect(f.message?.code).toBe("REQUIRED");
    }
  });

  test("message under 10 only after cleaning (zero-width padding) -> TOO_SHORT", () => {
    const { svc } = harness();
    const e = errOf(svc.submit(A, input({ message: "abc​​​​​​​​def" }), T0));
    expect(fieldsOf(e).message?.code).toBe("TOO_SHORT");
  });

  test("invalid emails -> INVALID_EMAIL", () => {
    const { svc } = harness();
    for (const bad of ["plain", "a@b", "@b.co", "a@.co", "a b@c.co", "a@b..co", "a@@b.co", "a@b.co.", "<a@b.co>x y"]) {
      const e = errOf(svc.submit(A, input({ email: bad }), T0));
      expect(fieldsOf(e).email?.code, bad).toBe("INVALID_EMAIL");
    }
  });

  test("topic: every enum member accepted (trimmed); case variants, prototype keys and non-strings rejected", () => {
    const { db, svc } = harness();
    CONTACT_TOPICS.forEach((t, i) => {
      const r = okValue(svc.submit(A, input({ topic: ` ${t} `, message: `${MESSAGE} topic ${i}` }), T0 + i));
      expect(stored(db, r.reference).topic).toBe(t);
    });
    for (const bad of ["Shipping", "SHIPPING", "__proto__", "constructor", "toString", "hasOwnProperty", "", 1, ["shipping"], {}, null]) {
      const e = errOf(svc.submit(B, input({ topic: bad }), T0));
      expect(fieldsOf(e).topic?.code).toBe("INVALID_TOPIC");
    }
  });
});

// ---------------------------------------------------------------------------
describe("criterion 2: orderId ownership (no existence leak) and productSlug drop", () => {
  test("own order accepted (trimmed) and stored", () => {
    const { db, svc } = harness();
    insertOrder(db, "ord_qa_a", A);
    const r = okValue(svc.submit(A, input({ orderId: "  ord_qa_a  " }), T0));
    expect(stored(db, r.reference).order_id).toBe("ord_qa_a");
  });

  test("missing / foreign / malformed / non-string / null-sender orderId -> byte-identical error objects", () => {
    const { db, svc } = harness();
    insertOrder(db, "ord_qa_b", B);
    insertOrder(db, "ord_qa_a", A);
    const errors = [
      svc.submit(A, input({ orderId: "ord_does_not_exist" }), T0),
      svc.submit(A, input({ orderId: "ord_qa_b" }), T0), // foreign
      svc.submit(A, input({ orderId: "x".repeat(129) }), T0),
      svc.submit(A, input({ orderId: "' OR 1=1 --" }), T0),
      svc.submit(A, input({ orderId: 12345 }), T0),
      svc.submit(A, input({ orderId: { id: "ord_qa_a" } }), T0),
      svc.submit(null, input({ orderId: "ord_qa_a" }), T0), // real order, no sender
      svc.submit("not-a-uuid", input({ orderId: "ord_qa_a" }), T0),
      svc.submit(B, input({ orderId: "ord_qa_a" }), T0), // A's order from B
    ].map(errOf);
    const first = JSON.stringify(errors[0]);
    for (const e of errors) expect(JSON.stringify(e)).toBe(first);
    expect(errors[0]!.code).toBe("VALIDATION_FAILED");
    expect(fieldsOf(errors[0]!).orderId?.code).toBe("INVALID_ORDER");
    expect(Object.keys(fieldsOf(errors[0]!))).toEqual(["orderId"]);
    expect(rowCount(db)).toBe(0);
  });

  test("absent orderId forms (undefined, null, '', whitespace) are fine and store NULL", () => {
    const { db, svc } = harness();
    [undefined, null, "", "   "].forEach((o, i) => {
      const r = okValue(svc.submit(A, input({ orderId: o, message: `${MESSAGE} ${i}` }), T0));
      expect(stored(db, r.reference).order_id).toBeNull();
    });
  });

  test("published slug stored; unknown / unpublished / hostile / non-string slug stored NULL, never an error", () => {
    const { db, svc, slug } = harness();
    const r1 = okValue(svc.submit(A, input({ productSlug: ` ${slug} ` }), T0));
    expect(stored(db, r1.reference).product_slug).toBe(slug);

    const hidden = db.query<{ slug: string }, []>("SELECT slug FROM products ORDER BY slug DESC LIMIT 1").get()!.slug;
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE slug = ?").run(hidden);

    const bad: unknown[] = ["no-such-product", hidden, "' OR 1=1 --", "%", "x".repeat(10_000), 7, {}, null, ["a"]];
    bad.forEach((s, i) => {
      const r = okValue(svc.submit(A, input({ productSlug: s, message: `${MESSAGE} slug ${i}` }), T0 + i));
      expect(stored(db, r.reference).product_slug).toBeNull();
    });
  });
});

describe("criterion 2: published = published_at <= injected now (wave-1 contract)", () => {
  // DEFECT D-T42-2 (minor): productSlugExists compares against SQLite wall-clock 'now', not submit's `now`.
  test("a product published between wall clock and the injected now is kept; one published after now is dropped", () => {
    const { db, svc } = harness();
    const slugs = db.query<{ slug: string }, []>("SELECT slug FROM products ORDER BY slug LIMIT 2").all().map((r) => r.slug);
    db.query("UPDATE products SET published_at = '2030-01-01T00:00:00.000Z' WHERE slug = ?").run(slugs[0]!);
    db.query("UPDATE products SET published_at = '2026-01-01T00:00:00.000Z' WHERE slug = ?").run(slugs[1]!);
    const future = Date.parse("2031-01-01T00:00:00.000Z");
    const past = Date.parse("2025-01-01T00:00:00.000Z");
    const r1 = okValue(svc.submit(A, input({ productSlug: slugs[0] }), future));
    const r2 = okValue(svc.submit(B, input({ productSlug: slugs[1] }), past));
    expect(stored(db, r1.reference).product_slug).toBe(slugs[0]!);
    expect(stored(db, r2.reference).product_slug).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("criterion 3: more than 3 URLs", () => {
  test("3 URLs ok; 4 -> VALIDATION_FAILED / TOO_MANY_URLS", () => {
    const { db, svc } = harness();
    expect(svc.submit(A, input({ message: "see http://a.com https://b.com www.c.com thanks" }), T0).ok).toBe(true);
    const e = errOf(svc.submit(A, input({ message: "see http://a.com https://b.com www.c.com HTTP://d.com" }), T0));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fieldsOf(e).message?.code).toBe("TOO_MANY_URLS");
    expect(rowCount(db)).toBe(1);
  });

  test("punctuation-joined and zero-width-obfuscated URLs are each counted", () => {
    const { svc } = harness();
    for (const m of [
      "links:http://a.co,http://b.co;http://c.co|http://d.co",
      "www.a.co,www.b.co,www.c.co,www.d.co here",
      "h​ttp://a.co h​ttp://b.co h​ttp://c.co h​ttp://d.co",
      "(https://a.co)(https://b.co)[https://c.co]<https://d.co>",
    ]) {
      const e = errOf(svc.submit(A, input({ message: m }), T0));
      expect(fieldsOf(e).message?.code, m).toBe("TOO_MANY_URLS");
    }
  });
});

// ---------------------------------------------------------------------------
describe("criterion 4: duplicates", () => {
  test("same owner, same cleaned message, inclusive 10-minute boundary -> DUPLICATE; +1 ms -> ok", () => {
    const { db, svc } = harness();
    okValue(svc.submit(A, input(), T0));
    expect(errOf(svc.submit(A, input(), T0 + 1)).code).toBe("DUPLICATE");
    expect(errOf(svc.submit(A, input(), T0 + CONTACT_DUPLICATE_WINDOW_MS)).code).toBe("DUPLICATE");
    expect(CONTACT_DUPLICATE_WINDOW_MS).toBe(10 * MIN);
    expect(svc.submit(A, input(), T0 + CONTACT_DUPLICATE_WINDOW_MS + 1).ok).toBe(true);
    expect(rowCount(db)).toBe(2);
  });

  test("duplicate compares the CLEANED message, ignores topic/name/email", () => {
    const { svc } = harness();
    okValue(svc.submit(A, input({ message: "Hello   there team,​\tplease help me." }), T0));
    const e = errOf(
      svc.submit(A, input({ message: "  Hello there team, please help me.  ", topic: "returns", name: "Other", email: "x@y.co" }), T0 + MIN),
    );
    expect(e.code).toBe("DUPLICATE");
  });

  test("different owner, null sender, or different message -> ok", () => {
    const { db, svc } = harness();
    okValue(svc.submit(A, input(), T0));
    expect(svc.submit(B, input(), T0 + 1).ok).toBe(true);
    expect(svc.submit(null, input(), T0 + 2).ok).toBe(true);
    expect(svc.submit(null, input(), T0 + 3).ok).toBe(true);
    expect(svc.submit(A, input({ message: `${MESSAGE}!` }), T0 + 4).ok).toBe(true);
    expect(rowCount(db)).toBe(5);
  });

  test("DUPLICATE error carries no stored data (no reference, no PII)", () => {
    const { svc } = harness();
    const ref = okValue(svc.submit(A, input(), T0)).reference;
    const dump = JSON.stringify(errOf(svc.submit(A, input(), T0 + 1)));
    for (const s of [ref, NAME, EMAIL, "QA-PII-MARKER-77"]) expect(dump).not.toContain(s);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 5: listForSession", () => {
  test("own only, newest first, no name/email, exact view keys", () => {
    const { svc } = harness();
    const a1 = okValue(svc.submit(A, input({ message: `${MESSAGE} one` }), T0));
    okValue(svc.submit(B, input({ message: `${MESSAGE} bee` }), T0 + MIN));
    const a2 = okValue(svc.submit(A, input({ message: `${MESSAGE} two`, topic: "returns" }), T0 + 2 * MIN));
    okValue(svc.submit(null, input({ message: `${MESSAGE} anon` }), T0 + 3 * MIN));
    const list = svc.listForSession(A);
    expect(list.map((v) => v.reference)).toEqual([a2.reference, a1.reference]);
    expect(list[0]!.topic).toBe("returns");
    expect(list[0]!.createdAt).toBe(a2.createdAt);
    for (const v of list) {
      expect(Object.keys(v).sort()).toEqual(["createdAt", "excerpt", "orderId", "productSlug", "reference", "topic"]);
      const dump = JSON.stringify(v);
      expect(dump).not.toContain(NAME);
      expect(dump).not.toContain(EMAIL);
      expect(dump).not.toContain(A);
    }
  });

  test("same-timestamp messages: later insert listed first", () => {
    const { svc } = harness();
    const r1 = okValue(svc.submit(A, input({ message: `${MESSAGE} x1` }), T0));
    const r2 = okValue(svc.submit(A, input({ message: `${MESSAGE} x2` }), T0));
    expect(svc.listForSession(A).map((v) => v.reference)).toEqual([r2.reference, r1.reference]);
  });

  test(`caps at ${CONTACT_LIST_LIMIT}, keeping the newest`, () => {
    const { svc } = harness({ random: seeded(42) });
    let newest = "";
    for (let i = 0; i < 205; i++) newest = okValue(svc.submit(A, input({ message: `${MESSAGE} n${i}` }), T0 + i * 1000)).reference;
    const list = svc.listForSession(A);
    expect(CONTACT_LIST_LIMIT).toBe(200);
    expect(list).toHaveLength(200);
    expect(list[0]!.reference).toBe(newest);
    expect(list.at(-1)!.excerpt).toContain("n5");
  });

  test("excerpt = first 80 code points; astral emoji never split; short message whole", () => {
    const { svc } = harness();
    okValue(svc.submit(A, input({ message: "\u{1F600}".repeat(150) }), T0));
    okValue(svc.submit(A, input({ message: `a${"\u{1F4E6}".repeat(100)}` }), T0 + 1));
    okValue(svc.submit(A, input({ message: "short msg." }), T0 + 2));
    const [short, mixed, smile] = svc.listForSession(A);
    expect(short!.excerpt).toBe("short msg.");
    expect(smile!.excerpt).toBe("\u{1F600}".repeat(80));
    expect(Array.from(mixed!.excerpt)).toHaveLength(80);
    expect(mixed!.excerpt).toBe(`a${"\u{1F4E6}".repeat(79)}`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(mixed!.excerpt)).toBe(false);
  });

  test("hostile / invalid session ids -> [] (never null-sender rows)", () => {
    const { svc } = harness();
    okValue(svc.submit(null, input(), T0));
    okValue(svc.submit("garbage", input({ message: `${MESSAGE} g` }), T0));
    for (const s of ["", "garbage", "' OR 1=1 --", "%", A.toUpperCase(), `${A}\u0000`, "x".repeat(10_000)]) {
      expect(svc.listForSession(s)).toEqual([]);
    }
    expect(svc.listForSession(null as unknown as string)).toEqual([]);
    expect(svc.listForSession(undefined as unknown as string)).toEqual([]);
    expect(svc.listForSession(A)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("getByReference", () => {
  test("owner gets the full message; input trimmed and upper-cased", () => {
    const { db, svc } = harness();
    insertOrder(db, "ord_qa_a", A);
    const r = okValue(svc.submit(A, input({ orderId: "ord_qa_a" }), T0));
    const got = svc.getByReference(A, `  ${r.reference.toLowerCase()}\t`);
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect(got.value).toMatchObject({
      reference: r.reference,
      name: NAME,
      email: EMAIL,
      topic: "shipping",
      orderId: "ord_qa_a",
      message: MESSAGE,
      createdAt: r.createdAt,
    });
    expect(JSON.stringify(got.value)).not.toContain(A);
  });

  test("other owner, unknown, malformed and hostile references -> identical NOT_FOUND", () => {
    const { svc } = harness();
    const r = okValue(svc.submit(A, input(), T0));
    const results = [
      svc.getByReference(B, r.reference),
      svc.getByReference(A, "C-00000000"),
      svc.getByReference(A, r.reference.replace("C-", "CM-")),
      svc.getByReference(A, `${r.reference}X`),
      svc.getByReference(A, "' OR 1=1 --"),
      svc.getByReference(A, "%"),
      svc.getByReference(A, "x".repeat(10_000)),
      svc.getByReference(A, null as unknown as string),
      svc.getByReference(A, { toString: () => r.reference } as unknown as string),
      svc.getByReference("garbage", r.reference),
      svc.getByReference(A.toUpperCase(), r.reference),
    ].map(errOf);
    const first = JSON.stringify(results[0]);
    expect(results[0]!.code).toBe("NOT_FOUND");
    for (const e of results) expect(JSON.stringify(e)).toBe(first);
  });

  test("null-sender rows: session_id NULL and never returned by any read", () => {
    const { db, svc } = harness();
    const r1 = okValue(svc.submit(null, input(), T0));
    const r2 = okValue(svc.submit("not-a-uuid", input({ message: `${MESSAGE} z` }), T0));
    expect(stored(db, r1.reference).session_id).toBeNull();
    expect(stored(db, r2.reference).session_id).toBeNull();
    for (const s of [A, B, "", "null", "garbage"]) {
      expect(svc.getByReference(s, r1.reference).ok).toBe(false);
      expect(svc.getByReference(s, r2.reference).ok).toBe(false);
      expect(svc.listForSession(s)).toEqual([]);
    }
    expect(svc.getByReference(null as unknown as string, r1.reference).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("two-session isolation matrix", () => {
  test("A and B each see only their own messages via list and getByReference", () => {
    const { svc } = harness();
    const refs: Record<string, string[]> = { [A]: [], [B]: [] };
    for (const [s, n] of [[A, 3], [B, 2]] as const) {
      for (let i = 0; i < n; i++) refs[s]!.push(okValue(svc.submit(s, input({ message: `${MESSAGE} ${s} ${i}` }), T0 + i)).reference);
    }
    for (const viewer of [A, B]) {
      const other = viewer === A ? B : A;
      expect(new Set(svc.listForSession(viewer).map((v) => v.reference))).toEqual(new Set(refs[viewer]));
      for (const ref of refs[viewer]!) expect(svc.getByReference(viewer, ref).ok).toBe(true);
      for (const ref of refs[other]!) expect(errOf(svc.getByReference(viewer, ref)).code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
describe("criterion 6: HTML kept as text; PII never logged", () => {
  test("HTML / script / SQL-looking text stored verbatim", () => {
    const { db, svc } = harness();
    const html = `<script>alert("x")</script><img src=x onerror=alert(1)> &amp; '); DROP TABLE contact_messages; --`;
    const r = okValue(svc.submit(A, input({ message: html, name: "<b>Bob</b>" }), T0));
    const row = stored(db, r.reference);
    expect(row.message).toBe(html);
    expect(row.name).toBe("<b>Bob</b>");
    expect(rowCount(db)).toBe(1);
  });

  function consoleSpy(): { calls: unknown[][]; restore: () => void } {
    const calls: unknown[][] = [];
    const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const saved = methods.map((m) => [m, console[m]] as const);
    for (const m of methods) console[m] = (...a: unknown[]) => void calls.push(a);
    return {
      calls,
      restore: () => {
        for (const [m, f] of saved) console[m] = f;
      },
    };
  }

  function assertNoPii(dump: string): void {
    for (const pii of [NAME, EMAIL, "QA-PII-MARKER-77", "ord_qa_secret"]) expect(dump).not.toContain(pii);
  }

  test("table dropped: submit/list/get settle with generic errors and the logger never sees PII", () => {
    const { db, svc, log } = harness();
    const ref = okValue(svc.submit(A, input({ message: `${MESSAGE} pre` }), T0)).reference;
    db.run("DROP TABLE contact_messages");
    const c = consoleSpy();
    try {
      const e = errOf(svc.submit(A, input(), T0 + MIN));
      expect(e.code).toBe("INVALID_INPUT");
      assertNoPii(JSON.stringify(e));
      expect(svc.listForSession(A)).toEqual([]);
      expect(errOf(svc.getByReference(A, ref)).code).toBe("NOT_FOUND");
    } finally {
      c.restore();
    }
    expect(log.calls.length).toBeGreaterThan(0);
    assertNoPii(JSON.stringify(log.calls) + JSON.stringify(c.calls));
    expect(JSON.stringify(log.calls)).not.toContain(A);
  });

  test("orders table dropped during order lookup: no throw, no PII logged", () => {
    const { db, svc, log } = harness();
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DROP TABLE orders");
    const r = svc.submit(A, input({ orderId: "ord_qa_secret" }), T0);
    expect(r.ok).toBe(false);
    assertNoPii(JSON.stringify(log.calls) + JSON.stringify(r));
  });

  test("database closed: every method settles, logger never sees PII", () => {
    const { db, svc, log } = harness();
    const ref = okValue(svc.submit(A, input({ message: `${MESSAGE} pre` }), T0)).reference;
    db.close();
    const c = consoleSpy();
    try {
      expect(svc.submit(A, input({ orderId: "ord_qa_secret", productSlug: "x" }), T0 + MIN).ok).toBe(false);
      expect(svc.submit(A, input(), T0 + MIN).ok).toBe(false);
      expect(svc.listForSession(A)).toEqual([]);
      expect(svc.getByReference(A, ref).ok).toBe(false);
    } finally {
      c.restore();
    }
    assertNoPii(JSON.stringify(log.calls) + JSON.stringify(c.calls));
  });

  test("successful, validation and duplicate paths log nothing at all", () => {
    const { svc, log } = harness();
    okValue(svc.submit(A, input(), T0));
    svc.submit(A, input(), T0 + 1);
    svc.submit(A, input({ email: "bad", name: "n".repeat(81) }), T0);
    svc.listForSession(A);
    svc.getByReference(A, "C-ZZZZZZZZ");
    expect(log.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("hostile inputs never throw", () => {
  const protoInput = JSON.parse(
    `{"__proto__": {"name": "Polluted", "topic": "other"}, "name": "${NAME}", "email": "${EMAIL}", "topic": "shipping", "message": "${MESSAGE}"}`,
  ) as ContactInput;

  const hostileValues: unknown[] = [
    "x".repeat(10_000),
    "x".repeat(100_000),
    "‮evil‬ RTL שלום مرحبا message",
    "​‌‍﻿",
    "\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000",
    "a\u0000b\u0000c\u0000d\u0000e\u0000f\u0000g",
    "'; DROP TABLE contact_messages; --",
    "\" OR \"\"=\"",
    "%_%",
    "__proto__",
    "\uD800\uD800 lone surrogates \uDC00",
    null,
    undefined,
    0,
    Number.NaN,
    true,
    [],
    {},
    Symbol("s"),
    () => "fn",
    BigInt(1),
  ];

  test("every field x every hostile value: settles with a Result, table survives", () => {
    const { db, svc } = harness();
    let i = 0;
    for (const field of ["name", "email", "topic", "message", "orderId", "productSlug"] as const) {
      for (const v of hostileValues) {
        i++;
        const r = svc.submit(A, input({ [field]: v, message: field === "message" ? v : `${MESSAGE} ${i}` }), T0 + i);
        expect(typeof r.ok).toBe("boolean");
      }
    }
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'contact_messages'").get()).not.toBeNull();
  });

  test("hostile whole-input values and session ids never throw", () => {
    const { svc } = harness();
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error(`boom ${EMAIL}`);
        },
      },
    ) as ContactInput;
    for (const whole of [null, undefined, 42, "str", [], throwing, Object.create(null) as ContactInput]) {
      const r = svc.submit(A, whole as ContactInput, T0);
      expect(r.ok).toBe(false);
    }
    for (const s of ["", "' OR 1=1 --", "x".repeat(10_000), 7, {}, null, undefined]) {
      expect(typeof svc.submit(s as string | null, input({ message: `${MESSAGE} ${String(s).slice(0, 5)}` }), T0).ok).toBe("boolean");
    }
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, "2026" as unknown as number, 8.64e15 + 1]) {
      expect(svc.submit(A, input(), now).ok).toBe(false);
    }
  });

  test("__proto__ in parsed JSON does not pollute and does not override fields", () => {
    const { db, svc } = harness();
    const r = okValue(svc.submit(A, protoInput, T0));
    expect(stored(db, r.reference).name).toBe(NAME);
    expect(({} as Record<string, unknown>).name).toBeUndefined();
  });

  test("NUL / zero-width / bidi controls are stripped from stored text; RTL letters kept", () => {
    const { db, svc } = harness();
    const r = okValue(
      svc.submit(A, input({ name: "Ad\u0000a​ ‮m", message: "שלום\u0000 ‮hello‬ world!!" }), T0),
    );
    const row = stored(db, r.reference);
    expect(row.name).toBe("Ada m");
    expect(row.message).toBe("שלום hello world!!");
    expect(row.message).not.toMatch(/[\u0000​‪-‮]/);
  });

  test("name made only of invisible chars -> REQUIRED", () => {
    const { svc } = harness();
    expect(fieldsOf(errOf(svc.submit(A, input({ name: "​‮\u0000﻿" }), T0))).name?.code).toBe("REQUIRED");
  });
});

// ---------------------------------------------------------------------------
describe("static: parameterised SQL, no any / ts-ignore / console in contact sources", () => {
  const files = readdirSync(CONTACT_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ f, src: readFileSync(join(CONTACT_DIR, f), "utf8") }));

  test("only the NOW constant is interpolated into SQL; no string concatenation into queries", () => {
    for (const { f, src } of files) {
      const interps = [...src.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
      const sqlInterps = interps.filter((x) => !/^(label|max|min|CONTACT_MAX_URLS)$/.test(x!));
      for (const x of sqlInterps) expect(`${f}:${x}`).toBe(`${f}:NOW`);
      expect(src).not.toMatch(/query\([^)]*\+/);
    }
  });

  test("no `any`, @ts-ignore, @ts-expect-error or direct console calls", () => {
    for (const { f, src } of files) {
      expect(src, f).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src, f).not.toMatch(/@ts-ignore|@ts-expect-error/);
      expect(src, f).not.toMatch(/console\.(log|info|debug|warn|error)\(/);
    }
  });
});

// ---------------------------------------------------------------------------
describe("concurrency (worker threads, separate connections, file DB)", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test(
    "10 concurrent identical submits from one owner -> exactly one row, the rest DUPLICATE",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "qa-t42-"));
      tmpDirs.push(dir);
      const dbPath = join(dir, "contact.sqlite");
      const db = createDatabase(dbPath);
      runMigrations(db);
      seedDatabase(db);
      db.close();

      const workerSrc = join(dir, "worker.ts");
      writeFileSync(
        workerSrc,
        `import { createDatabase } from ${JSON.stringify(join(CONTACT_DIR, "../db/client.ts"))};
import { createContactService } from ${JSON.stringify(join(CONTACT_DIR, "contact-service.ts"))};
declare const self: Worker;
self.onmessage = (e: MessageEvent) => {
  const { dbPath, session, message, now } = e.data as { dbPath: string; session: string; message: string; now: number };
  const db = createDatabase(dbPath);
  const svc = createContactService({ db, logger: { error: () => {}, warn: () => {} } });
  const r = svc.submit(session, { name: "Q", email: "q@example.com", topic: "other", message }, now);
  db.close();
  postMessage(r.ok ? "ok" : r.error.code);
};
`,
      );
      const run = () =>
        new Promise<string>((resolve, reject) => {
          const w = new Worker(workerSrc);
          w.onmessage = (e: MessageEvent) => {
            resolve(e.data as string);
            w.terminate();
          };
          w.onerror = (e) => reject(e);
          w.postMessage({ dbPath, session: A, message: MESSAGE, now: T0 });
        });
      const out = await Promise.all(Array.from({ length: 10 }, run));
      const check = createDatabase(dbPath);
      open.push(check);
      expect(rowCount(check)).toBe(1);
      expect(out.filter((x) => x === "ok")).toHaveLength(1);
      expect(out.filter((x) => x === "DUPLICATE")).toHaveLength(9);
    },
    30_000,
  );
});
