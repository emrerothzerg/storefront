import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase, SEED_CATALOG_PRODUCTS } from "@/server/db/seed";
import { HELP_TOPIC_SLUGS } from "@/content/help-topics";
import type { AppError, Result } from "@/lib/result";
import {
  CONTACT_DUPLICATE_WINDOW_MS,
  CONTACT_TOPICS,
  REFERENCE_ALPHABET,
  SqliteContactService,
  createContactService,
  EMAIL_PATTERN,
  generateReference,
  getContactService,
  validateContactFields,
  type ContactInput,
  type ContactReceipt,
} from "./contact-service";
import { SqliteContactRepository, type ContactRepository } from "./contact-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const NAME = "Zelda Quartermaine";
const EMAIL = "zelda.secret@example.com";
const MESSAGE = "My parcel arrived damaged, please help me with a replacement.";
const SLUG = SEED_CATALOG_PRODUCTS[0]?.slug ?? "missing";

interface Spy {
  readonly calls: unknown[][];
  readonly logger: Pick<Console, "error" | "warn">;
}

function spy(): Spy {
  const calls: unknown[][] = [];
  return {
    calls,
    logger: {
      error: (...args: unknown[]) => void calls.push(args),
      warn: (...args: unknown[]) => void calls.push(args),
    },
  };
}

function setup(opts: { random?: () => number } = {}) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const log = spy();
  const service = new SqliteContactService({ db, logger: log.logger, ...(opts.random ? { random: opts.random } : {}) });
  return { db, service, log };
}

function insertOrder(db: Database, id: string, sessionId: string): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key)
     VALUES (?, ?, 'paid', 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', ?)`,
  ).run(id, sessionId, `key-${id}`);
}

function input(over: Partial<Record<keyof ContactInput, unknown>> = {}): ContactInput {
  return { name: NAME, email: EMAIL, topic: "shipping", message: MESSAGE, ...over };
}

function unwrap(r: Result<ContactReceipt, AppError>): ContactReceipt {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error("expected error");
  return r.error;
}

function fieldsOf(e: AppError): Record<string, { code: string }> {
  return (e.details?.fields ?? {}) as Record<string, { code: string }>;
}

function count(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM contact_messages").get() as { n: number }).n;
}

describe("constants", () => {
  test("topics = help topic slugs + product + feedback + other", () => {
    expect([...CONTACT_TOPICS]).toEqual([...HELP_TOPIC_SLUGS, "product", "feedback", "other"]);
  });
  test("duplicate window is 10 minutes", () => {
    expect(CONTACT_DUPLICATE_WINDOW_MS).toBe(600_000);
  });
});

describe("generateReference", () => {
  test("alphabet is Crockford base32 without I L O U", () => {
    expect(REFERENCE_ALPHABET).toHaveLength(32);
    for (const c of "ILOU") expect(REFERENCE_ALPHABET).not.toContain(c);
  });

  test("seeded random: prefix, length 10, alphabet chars only", () => {
    let s = 42;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    for (let i = 0; i < 500; i++) {
      const ref = generateReference(rnd);
      expect(ref).toHaveLength(10);
      expect(ref.startsWith("C-")).toBe(true);
      for (const c of ref.slice(2)) expect(REFERENCE_ALPHABET).toContain(c);
    }
  });

  test("edge random values are clamped into the alphabet", () => {
    expect(generateReference(() => 0)).toBe("C-00000000");
    expect(generateReference(() => 0.999999)).toBe("C-ZZZZZZZZ");
    expect(generateReference(() => 1)).toBe("C-ZZZZZZZZ");
    expect(generateReference(() => -5)).toBe("C-00000000");
    expect(generateReference(() => Number.NaN)).toBe("C-00000000");
  });

  test("default crypto source: 10,000 references, valid and no collision", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const ref = generateReference();
      expect(ref).toMatch(/^C-[0-9A-HJKMNP-TV-Z]{8}$/);
      seen.add(ref);
    }
    expect(seen.size).toBe(10_000);
  });
});

describe("submit: happy path (criterion 1)", () => {
  test("stores the cleaned message and returns a reference", () => {
    const { db, service } = setup();
    const receipt = unwrap(service.submit(S1, input({ name: "  Zelda \t Q  ", message: `  ${MESSAGE}\r\n\r\n\r\nThanks  ` }), T0));
    expect(receipt.reference).toMatch(/^C-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(receipt.createdAt).toBe("2026-11-07T12:00:00.000Z");
    const row = db.query("SELECT * FROM contact_messages").get() as Record<string, unknown>;
    expect(row.reference).toBe(receipt.reference);
    expect(row.session_id).toBe(S1);
    expect(row.name).toBe("Zelda Q");
    expect(row.message).toBe(`${MESSAGE}\n\nThanks`);
    expect(row.topic).toBe("shipping");
    expect(row.order_id).toBeNull();
    expect(row.product_slug).toBeNull();
  });

  test("every topic in the enum is accepted; topic is trimmed", () => {
    const { service } = setup();
    for (const [i, topic] of CONTACT_TOPICS.entries()) {
      expect(service.submit(S1, input({ topic: ` ${topic} `, message: `${MESSAGE} #${i}` }), T0).ok).toBe(true);
    }
  });

  test("guest without a session (null) may submit; invalid session string is treated as null", () => {
    const { db, service } = setup();
    expect(service.submit(null, input(), T0).ok).toBe(true);
    expect(service.submit("not-a-uuid", input(), T0).ok).toBe(true);
    expect(service.submit("' OR 1=1 --", input(), T0).ok).toBe(true);
    const rows = db.query("SELECT session_id FROM contact_messages").all() as { session_id: string | null }[];
    expect(rows.map((r) => r.session_id)).toEqual([null, null, null]);
  });

  test("HTML is stored verbatim as text (criterion 6)", () => {
    const { db, service } = setup();
    const html = `<script>alert("x")</script><b>bold</b> & <img src=x onerror=1>`;
    unwrap(service.submit(S1, input({ name: "<i>Eve</i>", message: html }), T0));
    const row = db.query("SELECT name, message FROM contact_messages").get() as { name: string; message: string };
    expect(row).toEqual({ name: "<i>Eve</i>", message: html });
  });

  test("limits accepted at the boundary: name 80, email 254, message 10 and 2000", () => {
    const { service } = setup();
    const email254 = `${"a".repeat(64)}@${"b".repeat(185)}.com`;
    expect(email254).toHaveLength(254);
    expect(service.submit(S1, input({ name: "n".repeat(80), email: email254, message: "m".repeat(2000) }), T0).ok).toBe(true);
    expect(service.submit(S1, input({ message: "0123456789" }), T0).ok).toBe(true);
  });
});

describe("submit: validation (criterion 1)", () => {
  test("too long fields -> TOO_LONG with per-field codes", () => {
    const { db, service } = setup();
    const e = errorOf(service.submit(S1, input({ name: "n".repeat(81), message: "m".repeat(2001) }), T0));
    expect(e.code).toBe("TOO_LONG");
    expect(fieldsOf(e)).toEqual({
      name: { code: "TOO_LONG", message: expect.any(String) },
      message: { code: "TOO_LONG", message: expect.any(String) },
    } as never);
    expect(count(db)).toBe(0);
  });

  test("email over 254 -> TOO_LONG on email", () => {
    const { service } = setup();
    const e = errorOf(service.submit(S1, input({ email: `${"a".repeat(64)}@${"b".repeat(186)}.com` }), T0));
    expect(e.code).toBe("TOO_LONG");
    expect(fieldsOf(e).email?.code).toBe("TOO_LONG");
  });

  test("huge raw input is rejected without storing", () => {
    const { db, service } = setup();
    const e = errorOf(service.submit(S1, input({ message: "x".repeat(1_000_000) }), T0));
    expect(e.code).toBe("TOO_LONG");
    expect(count(db)).toBe(0);
  });

  test("mixed errors -> VALIDATION_FAILED listing every field", () => {
    const { service } = setup();
    const e = errorOf(
      service.submit(S1, input({ name: "   ", email: "nope", topic: "billing", message: "short", orderId: "o-1" }), T0),
    );
    expect(e.code).toBe("VALIDATION_FAILED");
    const f = fieldsOf(e);
    expect(f.name?.code).toBe("REQUIRED");
    expect(f.email?.code).toBe("INVALID_EMAIL");
    expect(f.topic?.code).toBe("INVALID_TOPIC");
    expect(f.message?.code).toBe("TOO_SHORT");
    expect(f.orderId?.code).toBe("INVALID_ORDER");
  });

  test("too long + too short together -> VALIDATION_FAILED (TOO_LONG only when every error is length)", () => {
    const { service } = setup();
    const e = errorOf(service.submit(S1, input({ name: "n".repeat(81), message: "short" }), T0));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fieldsOf(e).name?.code).toBe("TOO_LONG");
  });

  test("non-string and missing values are field errors, not throws", () => {
    const { service } = setup();
    for (const bad of [undefined, null, 42, {}, [], true]) {
      const e = errorOf(service.submit(S1, { name: bad, email: bad, topic: bad, message: bad }, T0));
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(Object.keys(fieldsOf(e)).sort()).toEqual(["email", "message", "name", "topic"]);
    }
    expect(errorOf(service.submit(S1, null as unknown as ContactInput, T0)).code).toBe("VALIDATION_FAILED");
  });

  test("message under 10 chars after cleaning (whitespace / invisible chars do not count)", () => {
    const { service } = setup();
    const e = errorOf(service.submit(S1, input({ message: "  abc ​​​​​​​  " }), T0));
    expect(fieldsOf(e).message?.code).toBe("TOO_SHORT");
  });

  test("empty / whitespace / invisible-only message -> REQUIRED (D-T42-1); 1..9 chars -> TOO_SHORT", () => {
    const { service } = setup();
    for (const message of ["", "   ", "\u200b\u200b\u200b", "\n\n\t "]) {
      expect(fieldsOf(errorOf(service.submit(S1, input({ message }), T0))).message?.code).toBe("REQUIRED");
    }
    for (const message of ["a", "123456789"]) {
      expect(fieldsOf(errorOf(service.submit(S1, input({ message }), T0))).message?.code).toBe("TOO_SHORT");
    }
  });

  test("email variants rejected", () => {
    const { service } = setup();
    for (const email of ["a@b", "a b@c.de", "@c.de", "a@.de", "a@b..de", "a@@b.de"]) {
      expect(fieldsOf(errorOf(service.submit(S1, input({ email }), T0))).email?.code).toBe("INVALID_EMAIL");
    }
  });

  test("topic is case-sensitive and must be in the enum", () => {
    const { service } = setup();
    for (const topic of ["Shipping", "", "billing", "x".repeat(1000)]) {
      expect(fieldsOf(errorOf(service.submit(S1, input({ topic }), T0))).topic?.code).toBe("INVALID_TOPIC");
    }
  });
});

describe("submit: order and product references (criterion 2)", () => {
  test("own order is stored", () => {
    const { db, service } = setup();
    insertOrder(db, "order-own", S1);
    unwrap(service.submit(S1, input({ orderId: " order-own " }), T0));
    expect((db.query("SELECT order_id FROM contact_messages").get() as { order_id: string }).order_id).toBe("order-own");
  });

  test("foreign, missing and malformed order ids give the same field error (no existence leak)", () => {
    const { db, service } = setup();
    insertOrder(db, "order-other", S2);
    const errors = ["order-other", "order-missing", 123, "x".repeat(500)].map((orderId) =>
      errorOf(service.submit(S1, input({ orderId }), T0)),
    );
    for (const e of errors) {
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(Object.keys(fieldsOf(e))).toEqual(["orderId"]);
    }
    expect(new Set(errors.map((e) => JSON.stringify(e))).size).toBe(1);
    expect(count(db)).toBe(0);
  });

  test("null session always rejects orderId, even for an existing order", () => {
    const { db, service } = setup();
    insertOrder(db, "order-own", S1);
    expect(fieldsOf(errorOf(service.submit(null, input({ orderId: "order-own" }), T0))).orderId?.code).toBe("INVALID_ORDER");
    expect(fieldsOf(errorOf(service.submit("bogus", input({ orderId: "order-own" }), T0))).orderId?.code).toBe(
      "INVALID_ORDER",
    );
  });

  test("empty / null / undefined orderId is treated as absent", () => {
    const { service } = setup();
    for (const orderId of ["", "   ", null, undefined]) {
      expect(service.submit(null, input({ orderId, message: `${MESSAGE} ${String(orderId)}` }), T0).ok).toBe(true);
    }
  });

  test("known product slug is stored; unknown or non-string slug is dropped without error", () => {
    const { db, service } = setup();
    unwrap(service.submit(S1, input({ productSlug: SLUG, message: `${MESSAGE} 1` }), T0));
    unwrap(service.submit(S1, input({ productSlug: "no-such-product", message: `${MESSAGE} 2` }), T0));
    unwrap(service.submit(S1, input({ productSlug: 42, message: `${MESSAGE} 3` }), T0));
    unwrap(service.submit(S1, input({ productSlug: "' OR 1=1 --", message: `${MESSAGE} 4` }), T0));
    const slugs = db.query("SELECT product_slug FROM contact_messages ORDER BY rowid").all() as { product_slug: string | null }[];
    expect(slugs.map((r) => r.product_slug)).toEqual([SLUG, null, null, null]);
  });
});

describe("product slug publication uses the injected now (D-T42-2)", () => {
  test("published after wall clock but before now is kept; published after now is dropped", () => {
    const { db, service } = setup();
    db.query("UPDATE products SET published_at = '2030-01-01T00:00:00.000Z' WHERE slug = ?").run(SLUG);
    const r1 = unwrap(service.submit(S1, input({ productSlug: SLUG }), Date.parse("2031-01-01T00:00:00.000Z")));
    const r2 = unwrap(service.submit(S2, input({ productSlug: SLUG }), Date.parse("2029-01-01T00:00:00.000Z")));
    const slugOf = (ref: string) =>
      (db.query("SELECT product_slug FROM contact_messages WHERE reference = ?").get(ref) as { product_slug: string | null })
        .product_slug;
    expect(slugOf(r1.reference)).toBe(SLUG);
    expect(slugOf(r2.reference)).toBeNull();
  });
});

describe("validateContactFields (pure helper)", () => {
  test("valid input returns cleaned values and no field errors", () => {
    const r = validateContactFields({ name: " Ann  B ", email: " a@b.co ", topic: " other ", message: `  ${MESSAGE}  ` });
    expect(r).toEqual({ fields: {}, cleaned: { name: "Ann B", email: "a@b.co", topic: "other", message: MESSAGE } });
  });

  test("errors per field, no cleaned; ignores orderId/productSlug", () => {
    const r = validateContactFields({ name: "", email: "x", topic: "nope", message: "short", orderId: "o", productSlug: 1 });
    expect(r.cleaned).toBeUndefined();
    expect(Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v?.code]))).toEqual({
      name: "REQUIRED",
      email: "INVALID_EMAIL",
      topic: "INVALID_TOPIC",
      message: "TOO_SHORT",
    });
  });

  test("non-object inputs never throw", () => {
    for (const bad of [null, undefined, 1, "s", [], () => 1]) {
      const r = validateContactFields(bad);
      expect(r.cleaned).toBeUndefined();
      expect(Object.keys(r.fields).sort()).toEqual(["email", "message", "name", "topic"]);
    }
  });

  test("submit reports exactly the helper's field errors (no drift)", () => {
    const { service } = setup();
    const cases: ContactInput[] = [
      input({ name: "", message: "" }),
      input({ email: "a".repeat(300), message: "m".repeat(2001) }),
      input({ topic: 5, message: "http://a http://b http://c http://d go" }),
      input({ message: "\u200b" }),
    ];
    for (const c of cases) {
      const e = errorOf(service.submit(S1, c, T0));
      expect(e.details?.fields).toEqual(validateContactFields(c).fields);
    }
  });

  test("EMAIL_PATTERN is exported and matches validation.ts behaviour", () => {
    expect(EMAIL_PATTERN.test("a@b.co")).toBe(true);
    expect(EMAIL_PATTERN.test("a@b")).toBe(false);
    expect(EMAIL_PATTERN.test("a b@c.de")).toBe(false);
  });
});

describe("submit: URLs (criterion 3)", () => {
  test("3 URLs accepted, 4 rejected", () => {
    const { service } = setup();
    expect(service.submit(S1, input({ message: "see http://a.co https://b.co www.c.co ok" }), T0).ok).toBe(true);
    const e = errorOf(service.submit(S1, input({ message: "see http://a.co https://b.co www.c.co http://d.co" }), T0));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fieldsOf(e).message?.code).toBe("TOO_MANY_URLS");
  });
});

describe("submit: duplicates (criterion 4)", () => {
  test("identical cleaned message from the same session within 10 minutes -> DUPLICATE", () => {
    const { db, service } = setup();
    unwrap(service.submit(S1, input(), T0));
    const e = errorOf(service.submit(S1, input({ message: `  ${MESSAGE}  `, topic: "other" }), T0 + CONTACT_DUPLICATE_WINDOW_MS - 1));
    expect(e.code).toBe("DUPLICATE");
    expect(count(db)).toBe(1);
  });

  test("exactly at the window boundary is still a duplicate; after it is accepted", () => {
    const { service } = setup();
    unwrap(service.submit(S1, input(), T0));
    expect(errorOf(service.submit(S1, input(), T0 + CONTACT_DUPLICATE_WINDOW_MS)).code).toBe("DUPLICATE");
    expect(service.submit(S1, input(), T0 + CONTACT_DUPLICATE_WINDOW_MS + 1).ok).toBe(true);
  });

  test("different session, different message, or null session are not duplicates", () => {
    const { service } = setup();
    unwrap(service.submit(S1, input(), T0));
    expect(service.submit(S2, input(), T0 + 1).ok).toBe(true);
    expect(service.submit(S1, input({ message: `${MESSAGE}!` }), T0 + 2).ok).toBe(true);
    expect(service.submit(null, input(), T0 + 3).ok).toBe(true);
    expect(service.submit(null, input(), T0 + 4).ok).toBe(true);
  });
});

describe("listForSession / getByReference (criterion 5)", () => {
  test("own messages only, newest first, with excerpt of 80 chars", () => {
    const { service } = setup();
    const long = `${"a".repeat(79)}\u{1F600}tail of the message`;
    const r1 = unwrap(service.submit(S1, input({ message: `${MESSAGE} first` }), T0));
    const r2 = unwrap(service.submit(S1, input({ message: long, topic: "product", productSlug: SLUG }), T0 + 1000));
    unwrap(service.submit(S2, input({ message: `${MESSAGE} other` }), T0 + 2000));
    unwrap(service.submit(null, input({ message: `${MESSAGE} guest` }), T0 + 3000));

    const list = service.listForSession(S1);
    expect(list.map((m) => m.reference)).toEqual([r2.reference, r1.reference]);
    expect(list[0]).toEqual({
      reference: r2.reference,
      topic: "product",
      createdAt: r2.createdAt,
      orderId: null,
      productSlug: SLUG,
      excerpt: `${"a".repeat(79)}\u{1F600}`,
    });
    expect(list[1]?.excerpt).toBe(`${MESSAGE} first`.slice(0, 80));
    for (const view of list) {
      const json = JSON.stringify(view);
      expect(json).not.toContain(EMAIL);
      expect(json).not.toContain(NAME);
    }
    expect(service.listForSession(S2)).toHaveLength(1);
  });

  test("two sessions never see each other's messages", () => {
    const { service } = setup();
    const a = unwrap(service.submit(S1, input({ message: `${MESSAGE} from one` }), T0));
    const b = unwrap(service.submit(S2, input({ message: `${MESSAGE} from two` }), T0));
    expect(service.listForSession(S1).map((m) => m.reference)).toEqual([a.reference]);
    expect(service.listForSession(S2).map((m) => m.reference)).toEqual([b.reference]);
    expect(errorOf(service.getByReference(S1, b.reference)).code).toBe("NOT_FOUND");
    expect(errorOf(service.getByReference(S2, a.reference)).code).toBe("NOT_FOUND");
    const own = service.getByReference(S1, a.reference);
    expect(own.ok && own.value.message).toBe(`${MESSAGE} from one`);
    expect(own.ok && own.value.email).toBe(EMAIL);
  });

  test("getByReference: case-insensitive and trimmed; unknown/malformed/invalid session -> NOT_FOUND", () => {
    const { service } = setup();
    const a = unwrap(service.submit(S1, input(), T0));
    expect(service.getByReference(S1, ` ${a.reference.toLowerCase()} `).ok).toBe(true);
    for (const ref of ["C-00000000", "", "C-", "x".repeat(10_000), "' OR 1=1 --"]) {
      expect(errorOf(service.getByReference(S1, ref)).code).toBe("NOT_FOUND");
    }
    expect(errorOf(service.getByReference("not-a-uuid", a.reference)).code).toBe("NOT_FOUND");
  });

  test("guest (null-session) messages are visible to nobody", () => {
    const { service } = setup();
    const g = unwrap(service.submit(null, input(), T0));
    expect(service.listForSession(S1)).toEqual([]);
    expect(service.getByReference(S1, g.reference).ok).toBe(false);
  });

  test("invalid session lists nothing", () => {
    const { service } = setup();
    unwrap(service.submit(S1, input(), T0));
    expect(service.listForSession("bogus")).toEqual([]);
    expect(service.listForSession("")).toEqual([]);
  });
});

describe("reference collisions", () => {
  test("a colliding reference is regenerated", () => {
    const seq = [0, 0, 0, 0, 0, 0, 0, 0]; // first reference C-00000000
    let i = 0;
    const random = () => (i < 16 ? (seq[i++ % 8] ?? 0) : 0.5 + (i++ % 8) / 100);
    const { service } = setup({ random });
    expect(unwrap(service.submit(S1, input({ message: `${MESSAGE} a` }), T0)).reference).toBe("C-00000000");
    // second submit: first candidate collides (C-00000000), next one differs
    const second = unwrap(service.submit(S1, input({ message: `${MESSAGE} b` }), T0));
    expect(second.reference).not.toBe("C-00000000");
  });

  test("5 collisions in a row -> INVALID_INPUT, nothing stored", () => {
    const { db, service, log } = setup({ random: () => 0 });
    unwrap(service.submit(S1, input({ message: `${MESSAGE} a` }), T0));
    const e = errorOf(service.submit(S1, input({ message: `${MESSAGE} b` }), T0));
    expect(e.code).toBe("INVALID_INPUT");
    expect(count(db)).toBe(1);
    expect(log.calls.length).toBeGreaterThan(0);
  });
});

describe("PII never logged (criterion 6)", () => {
  function assertNoPii(calls: unknown[][]): void {
    const text = calls.map((c) => c.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(" ")).join("\n");
    expect(text).not.toContain(NAME);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(MESSAGE);
    expect(text).not.toContain("zelda");
  }

  test("DB error on insert: logged without PII, generic error returned", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const real = new SqliteContactRepository(db);
    const failing: ContactRepository = {
      referenceExists: (r) => real.referenceExists(r),
      hasRecentDuplicate: (s, m, t) => real.hasRecentDuplicate(s, m, t),
      listForSession: (s, l) => real.listForSession(s, l),
      getOwnedByReference: (s, r) => real.getOwnedByReference(s, r),
      isOrderOwnedBy: (s, o) => real.isOrderOwnedBy(s, o),
      productSlugExists: (slug, now) => real.productSlugExists(slug, now),
      insert: (row) => {
        throw new Error(`boom ${row.name} ${row.email} ${row.message}`);
      },
    };
    const log = spy();
    const service = new SqliteContactService({ db, logger: log.logger }, failing);
    const e = errorOf(service.submit(S1, input(), T0));
    expect(e.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(e)).not.toContain(EMAIL);
    expect(log.calls.length).toBe(1);
    assertNoPii(log.calls);
  });

  test("DB closed / table dropped: submit, list, get all fail safely without PII in logs", () => {
    const { db, service, log } = setup();
    unwrap(service.submit(S1, input(), T0));
    db.exec("DROP TABLE contact_messages");
    expect(errorOf(service.submit(S1, input({ message: `${MESSAGE} again` }), T0)).code).toBe("INVALID_INPUT");
    expect(service.listForSession(S1)).toEqual([]);
    expect(errorOf(service.getByReference(S1, "C-00000000")).code).toBe("NOT_FOUND");
    expect(log.calls.length).toBe(3);
    assertNoPii(log.calls);
  });

  test("validation and duplicate failures do not log at all", () => {
    const { service, log } = setup();
    service.submit(S1, input({ email: "bad" }), T0);
    service.submit(S1, input(), T0);
    service.submit(S1, input(), T0);
    expect(log.calls).toEqual([]);
  });
});

describe("factories", () => {
  const previousPath = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
  });

  test("createContactService works over a given db", () => {
    const { db } = setup();
    const service = createContactService({ db, logger: spy().logger });
    expect(service.submit(S1, input(), T0).ok).toBe(true);
    expect(service.listForSession(S1)).toHaveLength(1);
  });

  test("getContactService is a singleton over getDatabase()", () => {
    process.env.DATABASE_PATH = ":memory:";
    const a = getContactService();
    expect(getContactService()).toBe(a);
    expect(a.submit(S1, input(), T0).ok).toBe(true);
    expect(a.listForSession(S1)).toHaveLength(1);
  });
});
