import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SavedAddress } from "@/lib/types";
import type { AppError, Result } from "@/lib/result";
import { closeDatabase, createDatabase, getDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import {
  AddressStorageError,
  LABEL_MAX,
  MAX_ADDRESSES_PER_SESSION,
  PHONE_ALLOWED,
  PHONE_MAX,
  PHONE_MIN_DIGITS,
  createAddressService,
  duplicateKey,
  getAddressService,
  parseAddressInput,
  validatePhone,
  type AddressInput,
  type AddressService,
} from "./address-service";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined), warn: mock<(...args: unknown[]) => void>(() => undefined) };
  const service = createAddressService({ db, logger });
  return { db, logger, service };
}

function input(overrides: Partial<Record<keyof AddressInput, unknown>> = {}): AddressInput {
  return {
    fullName: "Ada Lovelace",
    email: undefined,
    line1: "12 Analytical Row",
    line2: undefined,
    city: "London",
    region: "Greater London",
    postalCode: "SW1A 1AA",
    country: "gb",
    ...overrides,
  };
}

/** Distinct valid address number `n` (different line1, so never a duplicate). */
function nth(n: number, overrides: Partial<Record<keyof AddressInput, unknown>> = {}): AddressInput {
  return input({ line1: `${n} Engine Street`, ...overrides });
}

function unwrap<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

function fieldsOf<T>(r: Result<T, AppError>): Record<string, { code: string }> {
  const e = errorOf(r);
  expect(e.code).toBe("VALIDATION_FAILED");
  return (e.details?.fields ?? {}) as Record<string, { code: string }>;
}

function rowCount(db: Database, sessionId?: string): number {
  const row =
    sessionId === undefined
      ? db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM addresses").get()
      : db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?").get(sessionId);
  return row?.n ?? 0;
}

function defaultCount(db: Database, sessionId: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM addresses WHERE session_id = ? AND is_default = 1")
      .get(sessionId)?.n ?? 0
  );
}

describe("constants", () => {
  test("match the backlog limits", () => {
    expect(MAX_ADDRESSES_PER_SESSION).toBe(10);
    expect(LABEL_MAX).toBe(40);
    expect(PHONE_MAX).toBe(20);
  });
});

describe("create", () => {
  test("stores a cleaned, validated address; the first one becomes default", () => {
    const { service, db } = setup();
    const saved = unwrap(service.create(S1, input({ label: " Home ", phone: "+44 (20) 7946-0018" }), T0));
    expect(saved).toEqual({
      id: saved.id,
      label: "Home",
      fullName: "Ada Lovelace",
      phone: "+44 (20) 7946-0018",
      line1: "12 Analytical Row",
      city: "London",
      region: "Greater London",
      postalCode: "SW1A 1AA",
      country: "GB",
      isDefault: true,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    expect(saved.line2).toBeUndefined();
    expect(rowCount(db, S1)).toBe(1);
  });

  test("label and phone are optional; email is ignored (not stored)", () => {
    const { service } = setup();
    const saved = unwrap(service.create(S1, input({ email: "not an email" })));
    expect(saved.label).toBe("");
    expect(saved.phone).toBeUndefined();
    expect(Object.keys(saved)).not.toContain("email");
  });

  test("missing required fields return per-field errors from validateAddress", () => {
    const { service, db } = setup();
    const fields = fieldsOf(
      service.create(S1, { fullName: "", email: undefined, line1: "   ", line2: undefined, city: undefined, region: null, postalCode: "", country: "USA" }),
    );
    expect(fields.fullName?.code).toBe("REQUIRED");
    expect(fields.line1?.code).toBe("REQUIRED");
    expect(fields.city?.code).toBe("REQUIRED");
    expect(fields.region?.code).toBe("REQUIRED");
    expect(fields.postalCode?.code).toBe("REQUIRED");
    expect(fields.country?.code).toBe("INVALID_COUNTRY");
    expect(fields.email).toBeUndefined();
    expect(fields.line2).toBeUndefined();
    expect(rowCount(db)).toBe(0);
  });

  test("non-string field values are INVALID_TYPE; a non-object input is INVALID_INPUT", () => {
    const { service } = setup();
    const fields = fieldsOf(service.create(S1, input({ city: 42, label: ["x"], phone: { n: 1 } })));
    expect(fields.city?.code).toBe("INVALID_TYPE");
    expect(fields.label?.code).toBe("INVALID_TYPE");
    expect(fields.phone?.code).toBe("INVALID_TYPE");
    for (const bad of [null, "text", 7, [input()]]) {
      expect(errorOf(service.create(S1, bad as unknown as AddressInput)).code).toBe("INVALID_INPUT");
    }
  });

  test("label is capped at 40 cleaned characters", () => {
    const { service } = setup();
    expect(unwrap(service.create(S1, nth(1, { label: "L".repeat(LABEL_MAX) }))).label).toHaveLength(40);
    expect(fieldsOf(service.create(S1, nth(2, { label: "L".repeat(LABEL_MAX + 1) }))).label?.code).toBe("TOO_LONG");
  });

  test("phone: allowed characters only, at most 20, at least 7 digits", () => {
    const { service } = setup();
    expect(unwrap(service.create(S1, nth(1, { phone: "555 0100 99" }))).phone).toBe("555 0100 99");
    expect(fieldsOf(service.create(S1, nth(2, { phone: "555-0100 ext 9" }))).phone?.code).toBe("INVALID_CHARACTERS");
    expect(fieldsOf(service.create(S1, nth(3, { phone: "<script>1234567" }))).phone?.code).toBe("INVALID_CHARACTERS");
    expect(fieldsOf(service.create(S1, nth(4, { phone: "+1 (555)" }))).phone?.code).toBe("INVALID_LENGTH");
    expect(fieldsOf(service.create(S1, nth(5, { phone: "1".repeat(PHONE_MAX + 1) }))).phone?.code).toBe("TOO_LONG");
    expect(unwrap(service.create(S1, nth(6, { phone: "1".repeat(PHONE_MAX) }))).phone).toHaveLength(20);
    // Blank phone counts as absent.
    expect(unwrap(service.create(S1, nth(7, { phone: "   " }))).phone).toBeUndefined();
  });

  test("an address field over 200 cleaned chars is a field TOO_LONG; raw input over 4x the cap is a top-level TOO_LONG", () => {
    const { service, db } = setup();
    expect(fieldsOf(service.create(S1, input({ city: "c".repeat(201) }))).city?.code).toBe("TOO_LONG");
    const e = errorOf(service.create(S1, input({ line1: "x".repeat(801) })));
    expect(e.code).toBe("TOO_LONG");
    expect(e.details).toEqual({ field: "line1", max: 200 });
    expect(errorOf(service.create(S1, input({ label: "x".repeat(161) }))).code).toBe("TOO_LONG");
    expect(rowCount(db)).toBe(0);
  });

  test("markup is stored as text; control characters are stripped and whitespace collapsed", () => {
    const { service, db } = setup();
    const saved = unwrap(
      service.create(S1, input({ fullName: "<b>Ada</b>\u0000 \t Lovelace", line2: "Flat <3 >\u0007", label: "Home​" })),
    );
    expect(saved.fullName).toBe("<b>Ada</b> Lovelace");
    expect(saved.line2).toBe("Flat <3 >");
    expect(saved.label).toBe("Home");
    const raw = db.query<{ full_name: string }, [string]>("SELECT full_name FROM addresses WHERE id = ?").get(saved.id);
    expect(raw?.full_name).toBe("<b>Ada</b> Lovelace");
  });

  test("the 11th address is LIMIT_REACHED and writes nothing", () => {
    const { service, db } = setup();
    for (let i = 0; i < MAX_ADDRESSES_PER_SESSION; i++) unwrap(service.create(S1, nth(i)));
    const e = errorOf(service.create(S1, nth(99)));
    expect(e.code).toBe("LIMIT_REACHED");
    expect(e.details).toEqual({ max: 10 });
    expect(rowCount(db, S1)).toBe(10);
    expect(service.countFor(S1)).toBe(10);
    // Another owner is unaffected.
    expect(unwrap(service.create(S2, nth(99))).isDefault).toBe(true);
  });

  test("a duplicate (normalised name + line1 + postal + country) is DUPLICATE without a second row", () => {
    const { service, db } = setup();
    unwrap(service.create(S1, input()));
    const variants = [
      input({ fullName: "  ADA   lovelace ", city: "Elsewhere", label: "Work" }),
      input({ line1: "12, Analytical Row." }),
      input({ postalCode: "sw1a1aa" }),
      input({ postalCode: "SW1A-1AA", country: "GB" }),
    ];
    for (const v of variants) expect(errorOf(service.create(S1, v)).code).toBe("DUPLICATE");
    expect(rowCount(db, S1)).toBe(1);
    // Different country, postcode, line1 or name is not a duplicate.
    unwrap(service.create(S1, input({ country: "IE" })));
    unwrap(service.create(S1, input({ postalCode: "SW1A 2AA" })));
    unwrap(service.create(S1, input({ fullName: "Ada King" })));
    expect(rowCount(db, S1)).toBe(4);
    // The same address in another session is fine.
    unwrap(service.create(S2, input()));
  });

  test("duplicate check runs before the limit check", () => {
    const { service } = setup();
    for (let i = 0; i < MAX_ADDRESSES_PER_SESSION; i++) unwrap(service.create(S1, nth(i)));
    expect(errorOf(service.create(S1, nth(3))).code).toBe("DUPLICATE");
  });

  test("isDefault on create moves the default in one step", () => {
    const { service, db } = setup();
    const a = unwrap(service.create(S1, nth(1), T0));
    const b = unwrap(service.create(S1, nth(2, { isDefault: "on" }), T0 + 1));
    expect(b.isDefault).toBe(true);
    expect(unwrap(service.get(S1, a.id)).isDefault).toBe(false);
    const c = unwrap(service.create(S1, nth(3, { isDefault: false }), T0 + 2));
    expect(c.isDefault).toBe(false);
    expect(defaultCount(db, S1)).toBe(1);
  });

  test("a non-finite or out-of-range now falls back to the clock", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const service = createAddressService({ db, now: () => T0 });
    expect(unwrap(service.create(S1, nth(1), Number.NaN)).createdAt).toBe(new Date(T0).toISOString());
    expect(unwrap(service.create(S1, nth(2), 1e20)).createdAt).toBe(new Date(T0).toISOString());
  });
});

describe("list / get / getDefault / countFor", () => {
  test("list is default first, then newest", () => {
    const { service } = setup();
    const a = unwrap(service.create(S1, nth(1), T0));
    const b = unwrap(service.create(S1, nth(2), T0 + 1000));
    const c = unwrap(service.create(S1, nth(3), T0 + 2000));
    expect(service.list(S1).map((x) => x.id)).toEqual([a.id, c.id, b.id]);
    unwrap(service.setDefault(S1, b.id));
    expect(service.list(S1).map((x) => x.id)).toEqual([b.id, c.id, a.id]);
    expect(service.getDefault(S1)?.id).toBe(b.id);
    expect(service.countFor(S1)).toBe(3);
  });

  test("same-millisecond creates still order newest first", () => {
    const { service } = setup();
    const ids = [1, 2, 3].map((n) => unwrap(service.create(S1, nth(n), T0)).id);
    const [first, second, third] = ids;
    expect(service.list(S1).map((x) => x.id)).toEqual([first, third, second].map(String));
  });

  test("an empty book has no default", () => {
    const { service } = setup();
    expect(service.list(S1)).toEqual([]);
    expect(service.getDefault(S1)).toBeNull();
    expect(service.countFor(S1)).toBe(0);
  });

  test("invalid owner keys: empty reads, INVALID_INPUT for get and mutations", () => {
    const { service, db } = setup();
    const a = unwrap(service.create(S1, nth(1)));
    for (const bad of ["", "not-a-uuid", S3.toUpperCase(), "11111111-1111-1111-8111-111111111111", `${S1} `]) {
      expect(service.list(bad)).toEqual([]);
      expect(service.getDefault(bad)).toBeNull();
      expect(service.countFor(bad)).toBe(0);
      expect(errorOf(service.get(bad, a.id)).code).toBe("INVALID_INPUT");
      expect(errorOf(service.create(bad, nth(2))).code).toBe("INVALID_INPUT");
      expect(errorOf(service.update(bad, a.id, nth(3))).code).toBe("INVALID_INPUT");
      expect(errorOf(service.remove(bad, a.id)).code).toBe("INVALID_INPUT");
      expect(errorOf(service.setDefault(bad, a.id)).code).toBe("INVALID_INPUT");
    }
    expect(rowCount(db)).toBe(1);
  });
});

describe("ownership", () => {
  test("foreign, unknown and malformed ids are NOT_FOUND everywhere (no distinction) and change nothing", () => {
    const { service, db } = setup();
    const mine = unwrap(service.create(S1, nth(1), T0));
    const theirs = unwrap(service.create(S2, nth(2), T0));
    const before = db.query("SELECT * FROM addresses ORDER BY id").all();
    const badIds = [theirs.id, crypto.randomUUID(), "", "x".repeat(65), "' OR 1=1 --", 42 as unknown as string];
    for (const id of badIds) {
      const errors = [
        errorOf(service.get(S1, id)),
        errorOf(service.update(S1, id, nth(9))),
        errorOf(service.remove(S1, id)),
        errorOf(service.setDefault(S1, id)),
      ];
      for (const e of errors) expect(e).toEqual({ code: "NOT_FOUND", message: "Address not found." });
    }
    expect(db.query("SELECT * FROM addresses ORDER BY id").all()).toEqual(before);
    expect(unwrap(service.get(S1, mine.id)).id).toBe(mine.id);
  });

  test("matrix: owners never see or touch each other's rows", () => {
    const { service } = setup();
    const owners = [S1, S2, S3];
    const created = new Map<string, SavedAddress[]>();
    for (const [i, s] of owners.entries()) {
      // Same physical addresses in every session: dedupe is per owner.
      created.set(s, [0, 1, 2].map((n) => unwrap(service.create(s, nth(n, { label: `owner-${i}` }), T0 + n))));
    }
    for (const viewer of owners) {
      const visible = service.list(viewer);
      expect(visible).toHaveLength(3);
      expect(new Set(visible.map((a) => a.label))).toEqual(new Set([`owner-${owners.indexOf(viewer)}`]));
      for (const owner of owners) {
        for (const a of created.get(owner) ?? []) {
          const got = service.get(viewer, a.id);
          if (owner === viewer) expect(unwrap(got).id).toBe(a.id);
          else expect(errorOf(got).code).toBe("NOT_FOUND");
        }
      }
    }
    // Mutations by S1 on S2's rows fail; S2's book is intact afterwards.
    for (const a of created.get(S2) ?? []) {
      expect(errorOf(service.remove(S1, a.id)).code).toBe("NOT_FOUND");
      expect(errorOf(service.setDefault(S1, a.id)).code).toBe("NOT_FOUND");
    }
    expect(service.list(S2).map((a) => a.id).sort()).toEqual((created.get(S2) ?? []).map((a) => a.id).sort());
    expect(service.getDefault(S2)?.id).toBe(created.get(S2)?.[0]?.id);
  });
});

describe("update", () => {
  test("replaces fields, keeps createdAt, bumps updatedAt", () => {
    const { service } = setup();
    const a = unwrap(service.create(S1, input({ label: "Home" }), T0));
    const b = unwrap(service.update(S1, a.id, input({ label: "Work", city: "Cambridge", phone: "01223 555 000" }), T0 + 5000));
    expect(b).toMatchObject({ id: a.id, label: "Work", city: "Cambridge", phone: "01223 555 000", isDefault: true });
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBe(new Date(T0 + 5000).toISOString());
    // Clearing optional fields removes them.
    const c = unwrap(service.update(S1, a.id, input({ label: "", phone: "" }), T0 + 6000));
    expect(c.label).toBe("");
    expect(c.phone).toBeUndefined();
  });

  test("unchanged values (after cleaning) are a no-op success with no write", () => {
    const { service, db } = setup();
    const a = unwrap(service.create(S1, input({ label: "Home", phone: "555 0100 99" }), T0));
    const same = unwrap(
      service.update(S1, a.id, input({ label: "  Home ", phone: "555  0100 99", fullName: "Ada \t Lovelace", country: "GB" }), T0 + 9999),
    );
    expect(same).toEqual(a);
    const raw = db.query<{ updated_at: string }, [string]>("SELECT updated_at FROM addresses WHERE id = ?").get(a.id);
    expect(raw?.updated_at).toBe(new Date(T0).toISOString());
    // isDefault on the current default is also a no-op.
    expect(unwrap(service.update(S1, a.id, input({ label: "Home", phone: "555 0100 99", isDefault: true }), T0 + 1))).toEqual(a);
  });

  test("validation errors and duplicates leave the row untouched", () => {
    const { service, db } = setup();
    const a = unwrap(service.create(S1, nth(1), T0));
    const b = unwrap(service.create(S1, nth(2), T0));
    expect(fieldsOf(service.update(S1, a.id, nth(1, { city: "" }))).city?.code).toBe("REQUIRED");
    expect(errorOf(service.update(S1, a.id, nth(2, { fullName: "ADA LOVELACE" }))).code).toBe("DUPLICATE");
    expect(errorOf(service.update(S1, a.id, nth(1, { region: "r".repeat(900) }))).code).toBe("TOO_LONG");
    expect(unwrap(service.get(S1, a.id))).toEqual(a);
    expect(unwrap(service.get(S1, b.id))).toEqual(b);
    expect(rowCount(db, S1)).toBe(2);
  });

  test("an address is not a duplicate of itself (re-saving with formatting changes works)", () => {
    const { service } = setup();
    const a = unwrap(service.create(S1, input(), T0));
    const b = unwrap(service.update(S1, a.id, input({ postalCode: "sw1a 1aa" }), T0 + 1));
    expect(b.postalCode).toBe("sw1a 1aa");
  });

  test("isDefault on a non-default makes it the only default; isDefault false never removes the default", () => {
    const { service, db } = setup();
    const a = unwrap(service.create(S1, nth(1), T0));
    const b = unwrap(service.create(S1, nth(2), T0 + 1));
    expect(unwrap(service.update(S1, b.id, nth(2, { isDefault: true }), T0 + 2)).isDefault).toBe(true);
    expect(unwrap(service.get(S1, a.id)).isDefault).toBe(false);
    expect(unwrap(service.update(S1, b.id, nth(2, { isDefault: false, city: "Bath" }), T0 + 3)).isDefault).toBe(true);
    expect(defaultCount(db, S1)).toBe(1);
  });
});

describe("remove", () => {
  test("removing the default promotes the most recent remaining address, then none", () => {
    const { service, db } = setup();
    const a = unwrap(service.create(S1, nth(1), T0));
    const b = unwrap(service.create(S1, nth(2), T0 + 2000));
    const c = unwrap(service.create(S1, nth(3), T0 + 1000));
    expect(unwrap(service.remove(S1, a.id))).toBeUndefined();
    expect(service.getDefault(S1)?.id).toBe(b.id);
    unwrap(service.remove(S1, b.id));
    expect(service.getDefault(S1)?.id).toBe(c.id);
    unwrap(service.remove(S1, c.id));
    expect(service.getDefault(S1)).toBeNull();
    expect(rowCount(db, S1)).toBe(0);
  });

  test("removing a non-default keeps the default; removing twice is NOT_FOUND", () => {
    const { service } = setup();
    const a = unwrap(service.create(S1, nth(1), T0));
    const b = unwrap(service.create(S1, nth(2), T0 + 1));
    unwrap(service.remove(S1, b.id));
    expect(service.getDefault(S1)?.id).toBe(a.id);
    expect(errorOf(service.remove(S1, b.id)).code).toBe("NOT_FOUND");
  });

  test("a freed slot can be reused after hitting the limit", () => {
    const { service } = setup();
    const ids = Array.from({ length: 10 }, (_, i) => unwrap(service.create(S1, nth(i))).id);
    unwrap(service.remove(S1, ids[4] ?? ""));
    unwrap(service.create(S1, nth(50)));
    expect(service.countFor(S1)).toBe(10);
  });
});

describe("setDefault", () => {
  test("switches the default in one transaction; idempotent on the current default", () => {
    const { service, db } = setup();
    const a = unwrap(service.create(S1, nth(1), T0));
    const b = unwrap(service.create(S1, nth(2), T0 + 1));
    expect(unwrap(service.setDefault(S1, b.id)).isDefault).toBe(true);
    expect(unwrap(service.get(S1, a.id)).isDefault).toBe(false);
    expect(defaultCount(db, S1)).toBe(1);
    const again = unwrap(service.setDefault(S1, b.id));
    expect(again).toEqual(unwrap(service.get(S1, b.id)));
    expect(defaultCount(db, S1)).toBe(1);
  });

  test("a failure mid-switch rolls back (old default kept)", () => {
    const { service, db, logger } = setup();
    const a = unwrap(service.create(S1, nth(1), T0));
    const b = unwrap(service.create(S1, nth(2), T0 + 1));
    // Make the second statement (mark new default) fail after the first (clear old) ran.
    db.run(`CREATE TRIGGER fail_mark BEFORE UPDATE OF is_default ON addresses
            WHEN NEW.is_default = 1 BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => service.setDefault(S1, b.id)).toThrow(AddressStorageError);
    expect(service.getDefault(S1)?.id).toBe(a.id);
    expect(defaultCount(db, S1)).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("invariants", () => {
  /** Deterministic PRNG (mulberry32) so failures are reproducible. */
  function prng(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("property: exactly one default whenever the book is non-empty, never more than 10 rows", () => {
    for (const seed of [1, 2, 3, 42, 1337]) {
      const { service, db } = setup();
      const rand = prng(seed);
      let clock = T0;
      for (let step = 0; step < 300; step++) {
        const s = rand() < 0.8 ? S1 : S2;
        const book = service.list(s);
        const pick = book[Math.floor(rand() * book.length)];
        const op = rand();
        if (op < 0.45) {
          service.create(s, nth(Math.floor(rand() * 30), { isDefault: rand() < 0.3 }), clock++);
        } else if (op < 0.7 && pick !== undefined) {
          unwrap(service.remove(s, pick.id));
        } else if (op < 0.9 && pick !== undefined) {
          unwrap(service.setDefault(s, pick.id));
        } else if (pick !== undefined) {
          service.update(s, pick.id, nth(Math.floor(rand() * 30), { isDefault: rand() < 0.5 }), clock++);
        }
        for (const owner of [S1, S2]) {
          const n = rowCount(db, owner);
          expect(n).toBeLessThanOrEqual(MAX_ADDRESSES_PER_SESSION);
          expect(defaultCount(db, owner)).toBe(n > 0 ? 1 : 0);
          const listed = service.list(owner);
          if (listed.length > 0) expect(listed[0]?.isDefault).toBe(true);
        }
      }
    }
  });

  test("concurrent Promise.all of 15 creates ends with exactly 10 rows and one default", async () => {
    const { service, db } = setup();
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) => Promise.resolve().then(() => service.create(S1, nth(i, { isDefault: i % 3 === 0 })))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok).map((r) => errorOf(r).code)).toEqual(Array(5).fill("LIMIT_REACHED"));
    expect(rowCount(db, S1)).toBe(10);
    expect(defaultCount(db, S1)).toBe(1);
  });

  test("concurrent duplicate creates store one row", async () => {
    const { service, db } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve().then(() => service.create(S1, input()))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(rowCount(db, S1)).toBe(1);
  });
});

describe("PII never reaches logs", () => {
  const PII = {
    fullName: "Zelda Quixote-Uniqueperson",
    line1: "77 Secretive Lane",
    line2: "Apt Hidden",
    city: "Privatown",
    region: "Confidentia",
    postalCode: "ZZ9 9ZZ",
    label: "My Secret Label",
    phone: "+1 (999) 555-1234",
  };
  const piiInput = (): AddressInput => input({ ...PII, country: "US" });

  function assertNoPii(calls: unknown[][]): void {
    const logged = calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" ")).join("\n");
    for (const value of Object.values(PII)) expect(logged).not.toContain(value);
    expect(logged).not.toContain(S1);
  }

  test("happy paths and expected errors log nothing", () => {
    const { service, logger } = setup();
    const a = unwrap(service.create(S1, piiInput()));
    service.create(S1, piiInput()); // DUPLICATE
    service.create(S1, input({ ...PII, city: "" })); // VALIDATION_FAILED
    unwrap(service.update(S1, a.id, input({ ...PII, country: "US", city: "Elsewhere" })));
    service.get(S2, a.id);
    unwrap(service.setDefault(S1, a.id));
    unwrap(service.remove(S1, a.id));
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("DB errors log only an operation + error code and throw AddressStorageError without PII", () => {
    const { service, db, logger } = setup();
    const a = unwrap(service.create(S1, piiInput()));
    db.run(`CREATE TRIGGER fail_writes BEFORE INSERT ON addresses BEGIN SELECT RAISE(ABORT, 'insert blocked'); END`);
    db.run(`CREATE TRIGGER fail_updates BEFORE UPDATE ON addresses BEGIN SELECT RAISE(ABORT, 'update blocked'); END`);
    db.run(`CREATE TRIGGER fail_deletes BEFORE DELETE ON addresses BEGIN SELECT RAISE(ABORT, 'delete blocked'); END`);

    const attempts: Array<() => unknown> = [
      () => service.create(S1, input({ ...PII, line1: "78 Secretive Lane", country: "US" })),
      () => service.update(S1, a.id, input({ ...PII, city: "Othertown", country: "US" })),
      () => service.remove(S1, a.id),
    ];
    for (const attempt of attempts) {
      let thrown: unknown;
      try {
        attempt();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AddressStorageError);
      const message = (thrown as Error).message;
      for (const value of Object.values(PII)) expect(message).not.toContain(value);
      expect((thrown as AddressStorageError).code).toMatch(/^SQLITE_/);
    }
    expect(logger.error).toHaveBeenCalledTimes(3);
    for (const call of logger.error.mock.calls) {
      expect(call).toHaveLength(1);
      expect(String(call[0])).toMatch(/^\[addresses\] (create|update|remove) failed: SQLITE_[A-Z_]+$/);
    }
    assertNoPii(logger.error.mock.calls);
  });

  test("read failures (closed DB) also log a code only and throw", () => {
    const { service, db, logger } = setup();
    unwrap(service.create(S1, piiInput()));
    db.close();
    expect(() => service.list(S1)).toThrow(AddressStorageError);
    expect(() => service.get(S1, "some-id")).toThrow(AddressStorageError);
    expect(() => service.getDefault(S1)).toThrow(AddressStorageError);
    expect(() => service.countFor(S1)).toThrow(AddressStorageError);
    expect(() => service.create(S1, piiInput())).toThrow(AddressStorageError);
    expect(logger.error).toHaveBeenCalledTimes(5);
    assertNoPii([...logger.error.mock.calls, ...logger.warn.mock.calls]);
  });
});

describe("helpers", () => {
  test("parseAddressInput drops an empty line2 and upper-cases country", () => {
    const parsed = parseAddressInput(input({ line2: "   " }));
    expect(parsed.ok && parsed.value).toMatchObject({ line2: null, country: "GB", phone: null, label: "" });
  });

  test("duplicateKey ignores case, punctuation and spacing", () => {
    const base = { fullName: "Ada Lovelace", line1: "12 Analytical Row", postalCode: "SW1A 1AA", country: "GB" };
    expect(duplicateKey({ ...base, fullName: "ada  LOVELACE", line1: "12, analytical row.", postalCode: "sw1a-1aa" })).toBe(
      duplicateKey(base),
    );
    expect(duplicateKey({ ...base, country: "IE" })).not.toBe(duplicateKey(base));
  });
});

describe("getAddressService", () => {
  const previous = process.env.DATABASE_PATH;
  beforeAll(() => {
    closeDatabase();
    process.env.DATABASE_PATH = ":memory:";
  });
  afterAll(() => {
    closeDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  });

  test("is a singleton over the shared database and rebuilds when the handle changes", () => {
    const first: AddressService = getAddressService();
    expect(getAddressService()).toBe(first);
    unwrap(first.create(S1, input()));
    expect(getDatabase().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM addresses").get()?.n).toBe(1);
    closeDatabase();
    const second = getAddressService();
    expect(second).not.toBe(first);
    expect(second.countFor(S1)).toBe(0);
  });
});

describe("validatePhone / PHONE_ALLOWED (shared with the order service)", () => {
  test("valid numbers return null; codes and messages per cause", () => {
    expect(validatePhone("+44 20 7946 0958")).toBeNull();
    expect(validatePhone("(555) 123-4567")).toBeNull();
    expect(validatePhone("1".repeat(PHONE_MIN_DIGITS))).toBeNull();
    expect(validatePhone("1".repeat(PHONE_MIN_DIGITS - 1))).toEqual({
      code: "INVALID_LENGTH",
      message: `Phone must contain at least ${PHONE_MIN_DIGITS} digits.`,
    });
    expect(validatePhone("555-CALL-NOW")).toEqual({
      code: "INVALID_CHARACTERS",
      message: "Phone may contain only digits, spaces and + - ( ).",
    });
  });

  test("PHONE_ALLOWED admits digits, spaces and + - ( ) only", () => {
    expect(PHONE_ALLOWED.test("0123456789 +-()")).toBe(true);
    for (const bad of ["a", ".", "/", "\t", "１", "*1"]) expect(PHONE_ALLOWED.test(bad)).toBe(false);
  });

  test("parseAddressInput applies exactly validatePhone to the cleaned value", () => {
    const base = { fullName: "Ada", line1: "1 Way", city: "London", region: "LDN", postalCode: "N1", country: "GB" };
    for (const phone of ["1234567", "123456", "555-CALL-NOW", " (555) 123-4567 "]) {
      const parsed = parseAddressInput({ ...base, phone });
      const expected = validatePhone(phone.trim());
      if (expected === null) expect(parsed.ok && parsed.value.phone).toBe(phone.trim());
      else expect(parsed.ok ? null : (parsed.error.details?.fields as Record<string, unknown>).phone).toEqual(expected);
    }
  });
});
