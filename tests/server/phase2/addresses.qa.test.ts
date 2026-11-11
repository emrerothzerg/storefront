/**
 * QA adversarial tests for T40 (address book service), src/server/addresses/**.
 * Owned by QA (QA-W1-T40). In-memory DB only (one worker-thread test uses a
 * temp file under os.tmpdir()); never touches ./data/.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppError, Result } from "@/lib/result";
import type { SavedAddress } from "@/lib/types";
import { closeDatabase, createDatabase, getDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import {
  AddressStorageError,
  MAX_ADDRESSES_PER_SESSION,
  createAddressService,
  getAddressService,
  type AddressInput,
  type AddressService,
} from "@/server/addresses/address-service";

const A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const B = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const C = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const ADDR_DIR = join(import.meta.dir, "../../../src/server/addresses");

const BAD_OWNER_KEYS: readonly unknown[] = [
  "",
  "not-a-uuid",
  "' OR 1=1 --",
  A.toUpperCase().replace("4E6F", "1E6F"), // v1
  `${A} `,
  ` ${A}`,
  `${A}\u0000`,
  "00000000-0000-0000-0000-000000000000",
  "x".repeat(100_000),
  null,
  undefined,
  42,
  {},
  [A],
];

const MALFORMED_IDS: readonly unknown[] = [
  "",
  " ",
  "x".repeat(65),
  "x".repeat(100_000),
  "' OR 1=1 --",
  "'; DROP TABLE addresses; --",
  "%",
  "_",
  "*",
  "\u0000",
  "\u{1F600}\u202E",
  null,
  undefined,
  42,
  {},
  [],
];

type Logger = { error: ReturnType<typeof mock>; warn: ReturnType<typeof mock> };

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

function harness(clock?: () => number): { db: Database; svc: AddressService; logger: Logger } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  open.push(db);
  const logger: Logger = { error: mock(() => undefined), warn: mock(() => undefined) };
  const svc = createAddressService({ db, logger, ...(clock ? { now: clock } : {}) });
  return { db, svc, logger };
}

function addr(overrides: Partial<Record<keyof AddressInput, unknown>> = {}): AddressInput {
  return {
    fullName: "Grace Hopper",
    email: undefined,
    line1: "1 Compiler Way",
    line2: undefined,
    city: "Arlington",
    region: "VA",
    postalCode: "22201",
    country: "us",
    ...overrides,
  };
}
const nth = (n: number, o: Partial<Record<keyof AddressInput, unknown>> = {}) => addr({ line1: `${n} Cobol Street`, ...o });

function ok<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
function errOf<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.value)}`);
  return r.error;
}
function fields<T>(r: Result<T, AppError>): Record<string, { code: string; message: string }> {
  const e = errOf(r);
  expect(e.code).toBe("VALIDATION_FAILED");
  return (e.details as { fields: Record<string, { code: string; message: string }> }).fields;
}
function rows(db: Database, s?: string): number {
  return s === undefined
    ? (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM addresses").get()?.n ?? 0)
    : (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?").get(s)?.n ?? 0);
}
function defaults(db: Database, s: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM addresses WHERE session_id = ? AND is_default = 1").get(s)?.n ?? 0;
}
function snapshot(db: Database): string {
  return JSON.stringify(db.query("SELECT * FROM addresses ORDER BY id").all());
}

// ---------------------------------------------------------------------------
// Criterion 1: validation
// ---------------------------------------------------------------------------

describe("AC1 create validation", () => {
  test("missing required fields: per-field REQUIRED in details.fields, no email key, no row", () => {
    const { db, svc } = harness();
    const f = fields(svc.create(A, { fullName: undefined, email: undefined, line1: undefined, line2: undefined, city: undefined, region: undefined, postalCode: undefined, country: undefined }));
    for (const k of ["fullName", "line1", "city", "region", "postalCode", "country"]) expect(f[k]?.code).toBe("REQUIRED");
    expect(f.line2).toBeUndefined();
    expect(f.email).toBeUndefined();
    expect(rows(db)).toBe(0);
  });

  test("whitespace / zero-width only counts as REQUIRED; bad country is INVALID_COUNTRY; all errors reported together", () => {
    const { svc } = harness();
    const f = fields(svc.create(A, addr({ fullName: " \u200B\t ", city: "\u0000\u0007", country: "USA", label: "x".repeat(41), phone: "abc" })));
    expect(f.fullName?.code).toBe("REQUIRED");
    expect(f.city?.code).toBe("REQUIRED");
    expect(f.country?.code).toBe("INVALID_COUNTRY");
    expect(f.label?.code).toBe("TOO_LONG");
    expect(f.phone?.code).toBe("INVALID_CHARACTERS");
  });

  test("country is trimmed and upper-cased; empty line2 dropped", () => {
    const { svc } = harness();
    const a = ok(svc.create(A, addr({ country: "  gb ", line2: "   " })));
    expect(a.country).toBe("GB");
    expect(a.line2).toBeUndefined();
  });

  test("label: 40 cleaned chars ok, 41 TOO_LONG (field-level), empty ok", () => {
    const { svc } = harness();
    expect(ok(svc.create(A, nth(1, { label: "L".repeat(40) }))).label).toBe("L".repeat(40));
    expect(fields(svc.create(A, nth(2, { label: "L".repeat(41) }))).label?.code).toBe("TOO_LONG");
    expect(ok(svc.create(A, nth(3, { label: "" }))).label).toBe("");
    expect(ok(svc.create(A, nth(4, { label: "   " }))).label).toBe("");
  });

  test("phone: allowed charset 0-9 + - ( ) space; others INVALID_CHARACTERS", () => {
    const { svc } = harness();
    expect(ok(svc.create(A, nth(1, { phone: "+1 (555) 123-4567" }))).phone).toBe("+1 (555) 123-4567");
    for (const bad of ["555.123.4567", "555-123-4567 x12", "+1 555 1234567#", "\u0665\u0665\u0665\u0661\u0662\u0663\u0664\u0665\u0666\u0667", "\uFF15\uFF15\uFF15\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17", "555/1234567", "<5551234567>", "5551234567;"]) {
      expect(fields(svc.create(A, nth(2, { phone: bad }))).phone?.code).toBe("INVALID_CHARACTERS");
    }
  });

  test("phone: <= 20 cleaned chars (21 TOO_LONG), >= 7 digits (6 INVALID_LENGTH), blank = absent", () => {
    const { svc } = harness();
    expect(ok(svc.create(A, nth(1, { phone: "1".repeat(20) }))).phone).toBe("1".repeat(20));
    expect(fields(svc.create(A, nth(2, { phone: "1".repeat(21) }))).phone?.code).toBe("TOO_LONG");
    expect(fields(svc.create(A, nth(2, { phone: "(+) 123-456" }))).phone?.code).toBe("INVALID_LENGTH");
    expect(fields(svc.create(A, nth(2, { phone: "+" }))).phone?.code).toBe("INVALID_LENGTH");
    expect(ok(svc.create(A, nth(2, { phone: "1234567" }))).phone).toBe("1234567");
    expect(ok(svc.create(A, nth(3, { phone: "   " }))).phone).toBeUndefined();
    expect(ok(svc.create(A, nth(4, { phone: "" }))).phone).toBeUndefined();
    expect(ok(svc.create(A, nth(5, { phone: null }))).phone).toBeUndefined();
  });

  test("top-level TOO_LONG only for raw strings > 4x cap; at 4x cap it is cleaned and validated normally", () => {
    const { svc } = harness();
    const cases: Array<[keyof AddressInput, number]> = [
      ["fullName", 200],
      ["line1", 200],
      ["line2", 200],
      ["city", 200],
      ["region", 200],
      ["postalCode", 200],
      ["country", 200],
      ["label", 40],
      ["phone", 20],
    ];
    let n = 0;
    for (const [field, cap] of cases) {
      const over = errOf(svc.create(A, nth(100, { [field]: "x".repeat(cap * 4 + 1) })));
      expect(over.code).toBe("TOO_LONG");
      expect(over.details).toEqual({ field, max: cap });
      // exactly 4x cap of padding that cleans down within the cap: accepted (country/phone get valid content)
      const content = field === "country" ? "us" : field === "phone" ? "5551234" : "ok";
      const padded = content + " ".repeat(cap * 4 - content.length);
      const r = svc.create(A, nth(n++, { [field]: padded }));
      expect(r.ok).toBe(true);
      // 4x cap of real characters: field-level TOO_LONG inside VALIDATION_FAILED, not top-level
      expect(fields(svc.create(A, nth(200, { [field]: "1".repeat(cap * 4) })))[field]?.code).toBe("TOO_LONG");
      if (n >= MAX_ADDRESSES_PER_SESSION - 1) {
        for (const a of svc.list(A)) ok(svc.remove(A, a.id));
      }
    }
  });

  test("field-level TOO_LONG: 201 cleaned chars in an address field", () => {
    const { svc } = harness();
    for (const field of ["fullName", "line1", "line2", "city", "region", "postalCode"] as const) {
      expect(fields(svc.create(A, nth(1, { [field]: "a".repeat(201) })))[field]?.code).toBe("TOO_LONG");
    }
    expect(fields(svc.create(A, nth(1, { country: "a".repeat(201) }))).country?.code).toBe("TOO_LONG");
  });

  test("non-string field values -> INVALID_TYPE (incl. label and phone)", () => {
    const { db, svc } = harness();
    for (const bad of [42, true, {}, [], ["x"], 5551234567n, Symbol("s"), () => "x"]) {
      for (const field of ["fullName", "line1", "line2", "city", "region", "postalCode", "country", "label", "phone"] as const) {
        expect(fields(svc.create(A, nth(1, { [field]: bad })))[field]?.code).toBe("INVALID_TYPE");
      }
    }
    expect(rows(db)).toBe(0);
  });

  test("non-object input -> INVALID_INPUT", () => {
    const { db, svc } = harness();
    for (const bad of [null, undefined, "addr", 1, [], [addr()], true]) {
      expect(errOf(svc.create(A, bad as unknown as AddressInput)).code).toBe("INVALID_INPUT");
    }
    expect(rows(db)).toBe(0);
  });

  test("email is ignored: invalid, non-string, or huge emails never error and are not stored", () => {
    const { db, svc } = harness();
    let i = 0;
    for (const email of ["not-an-email", 42, {}, "x".repeat(50_000), "", null]) {
      const a = ok(svc.create(A, nth(i++, { email })));
      expect(JSON.stringify(a)).not.toContain("not-an-email");
      expect("email" in a).toBe(false);
    }
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(addresses)").all().map((c) => c.name);
    expect(cols).not.toContain("email");
  });

  test("isDefault accepts true / 1 / 'on' / 'true' / '1' and nothing else", () => {
    for (const yes of [true, 1, "on", "true", "1"]) {
      const { svc } = harness();
      const first = ok(svc.create(A, nth(1)));
      const second = ok(svc.create(A, nth(2, { isDefault: yes })));
      expect(second.isDefault).toBe(true);
      expect(ok(svc.get(A, first.id)).isDefault).toBe(false);
    }
    for (const no of [false, 0, "off", "false", "0", "yes", "TRUE", "On", " on", 2, {}, [], null, undefined, "x"]) {
      const { svc, db } = harness();
      const first = ok(svc.create(A, nth(1)));
      const second = ok(svc.create(A, nth(2, { isDefault: no })));
      expect(second.isDefault).toBe(false);
      expect(ok(svc.get(A, first.id)).isDefault).toBe(true);
      expect(defaults(db, A)).toBe(1);
    }
  });

  test("update applies the same validation (INVALID_TYPE, TOO_LONG, phone, label) and leaves the row untouched", () => {
    const { db, svc } = harness();
    const a = ok(svc.create(A, addr({ phone: "5551234567", label: "Home" })));
    const before = snapshot(db);
    expect(fields(svc.update(A, a.id, addr({ phone: "555" }))).phone?.code).toBe("INVALID_LENGTH");
    expect(fields(svc.update(A, a.id, addr({ label: "x".repeat(41) }))).label?.code).toBe("TOO_LONG");
    expect(fields(svc.update(A, a.id, addr({ city: 7 }))).city?.code).toBe("INVALID_TYPE");
    expect(errOf(svc.update(A, a.id, addr({ city: "c".repeat(801) }))).code).toBe("TOO_LONG");
    expect(errOf(svc.update(A, a.id, null as unknown as AddressInput)).code).toBe("INVALID_INPUT");
    expect(snapshot(db)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: limit + default
// ---------------------------------------------------------------------------

describe("AC2 limit and default", () => {
  test("first address is default automatically even with isDefault false", () => {
    const { svc } = harness();
    expect(ok(svc.create(A, addr({ isDefault: false }))).isDefault).toBe(true);
  });

  test("11th -> LIMIT_REACHED (details.max 10), nothing written; isDefault on the 11th does not move the default", () => {
    const { db, svc } = harness();
    for (let i = 0; i < 10; i++) ok(svc.create(A, nth(i)));
    const before = snapshot(db);
    const e = errOf(svc.create(A, nth(10, { isDefault: true })));
    expect(e.code).toBe("LIMIT_REACHED");
    expect(e.details).toEqual({ max: 10 });
    expect(snapshot(db)).toBe(before);
    expect(rows(db, A)).toBe(10);
    // limit is per owner
    expect(ok(svc.create(B, nth(10))).isDefault).toBe(true);
  });

  test("DUPLICATE is checked BEFORE the limit (full book + duplicate input -> DUPLICATE)", () => {
    const { svc } = harness();
    for (let i = 0; i < 10; i++) ok(svc.create(A, nth(i)));
    expect(errOf(svc.create(A, nth(3, { fullName: "GRACE  hopper!" }))).code).toBe("DUPLICATE");
  });

  test("setDefault / create isDefault / update isDefault keep exactly one default", () => {
    const { db, svc } = harness();
    const a = ok(svc.create(A, nth(1)));
    const b = ok(svc.create(A, nth(2)));
    const c = ok(svc.create(A, nth(3, { isDefault: "on" })));
    expect(defaults(db, A)).toBe(1);
    expect(svc.getDefault(A)?.id).toBe(c.id);
    ok(svc.setDefault(A, b.id));
    expect(defaults(db, A)).toBe(1);
    expect(svc.getDefault(A)?.id).toBe(b.id);
    ok(svc.update(A, a.id, nth(1, { isDefault: "1" })));
    expect(defaults(db, A)).toBe(1);
    expect(svc.getDefault(A)?.id).toBe(a.id);
    expect(svc.list(A)[0]?.id).toBe(a.id);
  });

  test("isDefault: false on update of the default never removes it", () => {
    const { db, svc } = harness();
    const a = ok(svc.create(A, nth(1)));
    ok(svc.create(A, nth(2)));
    const u = ok(svc.update(A, a.id, nth(1, { city: "Elsewhere", isDefault: false })));
    expect(u.isDefault).toBe(true);
    for (const no of [0, "off", "false", undefined]) {
      expect(ok(svc.update(A, a.id, nth(1, { city: "Elsewhere", isDefault: no }))).isDefault).toBe(true);
    }
    expect(defaults(db, A)).toBe(1);
  });

  test("setDefault on a fresh rollback-forced failure keeps the old default (transactional)", () => {
    const { db, svc } = harness();
    const a = ok(svc.create(A, nth(1)));
    const b = ok(svc.create(A, nth(2)));
    // Fail the second statement (markDefault) of the switch
    db.run(`CREATE TRIGGER qa_fail_mark BEFORE UPDATE OF is_default ON addresses WHEN NEW.is_default = 1 BEGIN SELECT RAISE(ABORT, 'Grace Hopper 1 Cobol Street'); END`);
    expect(() => svc.setDefault(A, b.id)).toThrow(AddressStorageError);
    expect(svc.getDefault(A)?.id).toBe(a.id);
    expect(defaults(db, A)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Property test: 200 random ops
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: exactly one default after any sequence (200 ops, several seeds)", () => {
  for (const seed of [1, 7, 42, 1337, 20261107]) {
    test(`seed ${seed}`, () => {
      let clock = T0;
      const { db, svc } = harness(() => (clock += 1000));
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(r() * xs.length)]);
      const flags: readonly unknown[] = [true, false, 1, 0, "on", "off", "true", "1", undefined];
      // model: created order of live ids (by created clock)
      const created = new Map<string, number>();
      for (let op = 0; op < 200; op++) {
        const live = svc.list(A);
        const ids = live.map((a) => a.id);
        const choice = r();
        const owner = r() < 0.1 ? B : A;
        if (choice < 0.35) {
          const res = svc.create(owner, nth(Math.floor(r() * 14), { isDefault: pick(flags) }));
          if (res.ok && owner === A) created.set(res.value.id, Date.parse(res.value.createdAt));
          if (!res.ok) expect(["DUPLICATE", "LIMIT_REACHED"]).toContain(res.error.code);
        } else if (choice < 0.55) {
          const id = pick(ids) ?? "missing";
          const prevDefault = svc.getDefault(A);
          const res = svc.remove(A, id);
          if (res.ok) {
            created.delete(id);
            if (prevDefault?.id === id && created.size > 0) {
              const newest = [...created.entries()].sort((x, y) => y[1] - x[1])[0]![0];
              expect(svc.getDefault(A)?.id).toBe(newest);
            }
          } else expect(res.error.code).toBe("NOT_FOUND");
        } else if (choice < 0.75) {
          const id = pick(ids) ?? "missing";
          const res = svc.setDefault(owner, id);
          if (owner === A && ids.includes(id)) expect(ok(res).isDefault).toBe(true);
          else expect(errOf(res).code).toBe("NOT_FOUND");
        } else {
          const id = pick(ids) ?? "missing";
          const flag = pick(flags);
          const wasDefault = live.find((a) => a.id === id)?.isDefault ?? false;
          const res = svc.update(A, id, nth(Math.floor(r() * 14), { isDefault: flag, city: r() < 0.5 ? "Arlington" : "Reston" }));
          if (res.ok && wasDefault) expect(res.value.isDefault).toBe(true);
          if (!res.ok) expect(["DUPLICATE", "NOT_FOUND"]).toContain(res.error.code);
        }
        for (const s of [A, B]) {
          const n = rows(db, s);
          expect(n).toBeLessThanOrEqual(MAX_ADDRESSES_PER_SESSION);
          expect(defaults(db, s)).toBe(n > 0 ? 1 : 0);
          const list = svc.list(s);
          if (list.length > 0) expect(list[0]!.isDefault).toBe(true);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Criterion 3: delete promotes most recent
// ---------------------------------------------------------------------------

describe("AC3 removing the default", () => {
  test("promotes the most recently CREATED remaining (not most recently updated / defaulted), then none", () => {
    let clock = T0;
    const { db, svc } = harness(() => (clock += 1000));
    const a = ok(svc.create(A, nth(1)));
    const b = ok(svc.create(A, nth(2)));
    const c = ok(svc.create(A, nth(3)));
    // touch a so its updated_at is newest; make b default
    ok(svc.update(A, a.id, nth(1, { city: "Touched" })));
    ok(svc.setDefault(A, b.id));
    ok(svc.remove(A, b.id));
    expect(svc.getDefault(A)?.id).toBe(c.id);
    ok(svc.remove(A, c.id));
    expect(svc.getDefault(A)?.id).toBe(a.id);
    ok(svc.remove(A, a.id));
    expect(svc.getDefault(A)).toBeNull();
    expect(svc.list(A)).toEqual([]);
    expect(rows(db)).toBe(0);
    // next create is default again
    expect(ok(svc.create(A, nth(9))).isDefault).toBe(true);
  });

  test("same-millisecond creates: promotion picks the last inserted", () => {
    const { svc } = harness(() => T0);
    const a = ok(svc.create(A, nth(1)));
    ok(svc.create(A, nth(2)));
    const c = ok(svc.create(A, nth(3)));
    ok(svc.remove(A, a.id));
    expect(svc.getDefault(A)?.id).toBe(c.id);
  });

  test("removing a non-default leaves the default alone", () => {
    const { svc } = harness();
    const a = ok(svc.create(A, nth(1)));
    const b = ok(svc.create(A, nth(2)));
    ok(svc.remove(A, b.id));
    expect(svc.getDefault(A)?.id).toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: NOT_FOUND + isolation + invalid owner key
// ---------------------------------------------------------------------------

describe("AC4 ownership", () => {
  test("foreign, unknown and malformed ids -> NOT_FOUND with identical error for get/update/remove/setDefault; nothing changes", () => {
    const { db, svc } = harness();
    const mine = ok(svc.create(A, nth(1)));
    const theirs = ok(svc.create(B, nth(1)));
    const before = snapshot(db);
    const errors: AppError[] = [];
    for (const id of [theirs.id, crypto.randomUUID(), ...MALFORMED_IDS]) {
      const sid = id as string;
      errors.push(errOf(svc.get(A, sid)));
      errors.push(errOf(svc.update(A, sid, nth(5))));
      errors.push(errOf(svc.remove(A, sid)));
      errors.push(errOf(svc.setDefault(A, sid)));
    }
    const first = JSON.stringify(errors[0]);
    expect(errors[0]?.code).toBe("NOT_FOUND");
    for (const e of errors) expect(JSON.stringify(e)).toBe(first);
    expect(snapshot(db)).toBe(before);
    expect(ok(svc.get(A, mine.id)).id).toBe(mine.id);
  });

  test("isolation matrix across three owners: list/get/getDefault/countFor/mutations never cross", () => {
    const { db, svc } = harness();
    const owners = [A, B, C];
    const made = new Map<string, SavedAddress[]>();
    for (const [i, s] of owners.entries()) {
      // identical address content in every owner is allowed (dedupe is per owner)
      made.set(s, [ok(svc.create(s, nth(1))), ok(svc.create(s, nth(2 + i)))]);
    }
    for (const viewer of owners) {
      const listIds = svc.list(viewer).map((a) => a.id).sort();
      expect(listIds).toEqual(made.get(viewer)!.map((a) => a.id).sort());
      expect(svc.countFor(viewer)).toBe(2);
      expect(made.get(viewer)!.map((a) => a.id)).toContain(svc.getDefault(viewer)!.id);
      for (const target of owners) {
        if (target === viewer) continue;
        for (const a of made.get(target)!) {
          expect(errOf(svc.get(viewer, a.id)).code).toBe("NOT_FOUND");
          expect(errOf(svc.setDefault(viewer, a.id)).code).toBe("NOT_FOUND");
          expect(errOf(svc.update(viewer, a.id, nth(50))).code).toBe("NOT_FOUND");
          expect(errOf(svc.remove(viewer, a.id)).code).toBe("NOT_FOUND");
        }
      }
    }
    expect(rows(db)).toBe(6);
    // removing A's default never promotes into B
    ok(svc.remove(A, svc.getDefault(A)!.id));
    expect(defaults(db, B)).toBe(1);
    expect(svc.getDefault(B)!.id).toBe(made.get(B)![0]!.id);
  });

  test("invalid owner key: reads empty, mutations INVALID_INPUT, and the DB is never touched (Proxy)", () => {
    const real = createDatabase(":memory:");
    runMigrations(real);
    open.push(real);
    const touched: string[] = [];
    const proxy = new Proxy(real, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            touched.push(String(prop));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    const logger: Logger = { error: mock(() => undefined), warn: mock(() => undefined) };
    const svc = createAddressService({ db: proxy, logger });
    for (const key of BAD_OWNER_KEYS) {
      const s = key as string;
      expect(svc.list(s)).toEqual([]);
      expect(svc.getDefault(s)).toBeNull();
      expect(svc.countFor(s)).toBe(0);
      expect(errOf(svc.get(s, "abc")).code).toBe("INVALID_INPUT");
      expect(errOf(svc.create(s, addr())).code).toBe("INVALID_INPUT");
      expect(errOf(svc.update(s, "abc", addr())).code).toBe("INVALID_INPUT");
      expect(errOf(svc.remove(s, "abc")).code).toBe("INVALID_INPUT");
      expect(errOf(svc.setDefault(s, "abc")).code).toBe("INVALID_INPUT");
    }
    expect(touched).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    // sanity: the proxy does record real use
    ok(svc.create(A, addr()));
    expect(touched.length).toBeGreaterThan(0);
  });

  test("malformed address ids (> 64 chars, non-strings) are NOT_FOUND without SQL", () => {
    const real = createDatabase(":memory:");
    runMigrations(real);
    open.push(real);
    let calls = 0;
    const proxy = new Proxy(real, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            calls++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    const svc = createAddressService({ db: proxy });
    for (const id of ["x".repeat(65), "", null, 42, {}]) {
      expect(errOf(svc.get(A, id as string)).code).toBe("NOT_FOUND");
      expect(errOf(svc.remove(A, id as string)).code).toBe("NOT_FOUND");
      expect(errOf(svc.setDefault(A, id as string)).code).toBe("NOT_FOUND");
    }
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: duplicates
// ---------------------------------------------------------------------------

describe("AC5 duplicates", () => {
  test("normalisation variants of name + line1 + postal (same country) are DUPLICATE, no second row", () => {
    const { db, svc } = harness();
    ok(svc.create(A, addr({ fullName: "Grace Hopper", line1: "1 Compiler Way", postalCode: "22201-1234" })));
    const variants: Array<Partial<Record<keyof AddressInput, unknown>>> = [
      { fullName: "GRACE HOPPER", line1: "1 Compiler Way", postalCode: "22201-1234" },
      { fullName: "grace   hopper", line1: "1, Compiler Way.", postalCode: "222011234" },
      { fullName: "Grace-Hopper", line1: "1 COMPILER WAY", postalCode: "22201 1234" },
      { fullName: " Grace\tHopper ", line1: "1\u00A0Compiler \u200BWay", postalCode: "22201\u20131234" },
      { fullName: "Grace Hopper", line1: "1 Compiler Way", postalCode: "22201-1234", country: "US" },
      // fields outside the key don't matter
      { fullName: "Grace Hopper", line1: "1 Compiler Way", postalCode: "22201-1234", city: "Other", region: "MD", line2: "Suite 9", label: "Work", phone: "5551234567" },
    ];
    for (const v of variants) {
      const e = errOf(svc.create(A, addr({ ...v, isDefault: true })));
      expect(e.code).toBe("DUPLICATE");
    }
    expect(rows(db, A)).toBe(1);
  });

  test("different country, name, line1 or postal is NOT a duplicate; another owner may save the same address", () => {
    const { db, svc } = harness();
    ok(svc.create(A, addr()));
    ok(svc.create(A, addr({ country: "CA" })));
    ok(svc.create(A, addr({ fullName: "Grace B Hopper" })));
    ok(svc.create(A, addr({ line1: "2 Compiler Way" })));
    ok(svc.create(A, addr({ postalCode: "22202" })));
    ok(svc.create(B, addr()));
    expect(rows(db, A)).toBe(5);
    expect(rows(db, B)).toBe(1);
  });

  test("update into another row's key -> DUPLICATE, row untouched; updating a row onto its own key is fine", () => {
    const { db, svc } = harness();
    const a = ok(svc.create(A, nth(1)));
    ok(svc.create(A, nth(2)));
    const before = snapshot(db);
    expect(errOf(svc.update(A, a.id, nth(2, { fullName: "grace hopper" }))).code).toBe("DUPLICATE");
    expect(errOf(svc.update(A, a.id, nth(2, { isDefault: true }))).code).toBe("DUPLICATE");
    expect(snapshot(db)).toBe(before);
    expect(ok(svc.update(A, a.id, nth(1, { fullName: "GRACE HOPPER" }))).fullName).toBe("GRACE HOPPER");
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: text, controls, SQL, PII
// ---------------------------------------------------------------------------

describe("AC6 text storage, hostile strings and PII", () => {
  test("< and > are stored verbatim; control/zero-width/bidi chars stripped; whitespace collapsed", () => {
    const { db, svc } = harness();
    const a = ok(
      svc.create(
        A,
        addr({
          fullName: "<script>alert('x')</script>",
          line1: "1 <b>Bold</b> & \"Quoted\" St",
          line2: "a\u0000b\u0007c\u001Bd\u007Fe\u0085f",
          city: "Ar\u200Bling\u202Eton\uFEFF",
          region: "V\tA\n\r  x",
          label: "<img src=x onerror=alert(1)>",
        }),
      ),
    );
    expect(a.fullName).toBe("<script>alert('x')</script>");
    expect(a.line1).toBe("1 <b>Bold</b> & \"Quoted\" St");
    expect(a.line2).toBe("abcdef");
    expect(a.city).toBe("Arlington");
    expect(a.region).toBe("V A x");
    expect(a.label).toBe("<img src=x onerror=alert(1)>");
    const raw = db.query<{ full_name: string; line2: string }, [string]>("SELECT full_name, line2 FROM addresses WHERE id = ?").get(a.id);
    expect(raw?.full_name).toBe("<script>alert('x')</script>");
    expect(raw?.line2).toBe("abcdef");
    const stored = db.query<Record<string, unknown>, []>("SELECT * FROM addresses").all();
    for (const row of stored) {
      for (const v of Object.values(row)) {
        if (typeof v !== "string") continue;
        for (let i = 0; i < v.length; i++) {
          const code = v.charCodeAt(i);
          expect(code <= 0x1f || (code >= 0x7f && code <= 0x9f)).toBe(false);
        }
      }
    }
  });

  test("hostile SQL strings in every field are stored as data (bound parameters); table intact", () => {
    const { db, svc } = harness();
    const hostile = [
      "'; DROP TABLE addresses; --",
      "\" OR \"1\"=\"1",
      "Robert'); DELETE FROM addresses WHERE ('1'='1",
      "?1 ?2 :name @x $y",
      "%_\\",
      "1 UNION SELECT * FROM users --",
    ];
    for (const [i, h] of hostile.entries()) {
      const a = ok(svc.create(A, addr({ fullName: h, line1: `${i} ${h}`, line2: h, city: h, region: h, postalCode: h.slice(0, 30), label: h.slice(0, 40) })));
      expect(ok(svc.get(A, a.id)).fullName).toBe(h);
      expect(ok(svc.get(A, a.id)).line2).toBe(h);
      ok(svc.update(A, a.id, addr({ fullName: h, line1: `${i} ${h} upd`, city: h })));
    }
    expect(rows(db, A)).toBe(hostile.length);
    expect(svc.list(B)).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'addresses'").get()).not.toBeNull();
  });

  const PII = {
    fullName: "Xanthippe Qwerty-Uniqueperson",
    line1: "404 Classified Close",
    line2: "Flat Sekret",
    city: "Hushville",
    region: "Mumshire",
    postalCode: "QQ1 2QQ",
    label: "Hideout Label",
    phone: "+44 (20) 7946-0999",
  };
  const pii = (o: Partial<Record<keyof AddressInput, unknown>> = {}) => addr({ ...PII, country: "GB", ...o });

  function loggedText(logger: Logger): string {
    return [...logger.error.mock.calls, ...logger.warn.mock.calls]
      .map((args) => (args as unknown[]).map((x) => (typeof x === "string" ? x : (JSON.stringify(x) ?? String(x)))).join(" "))
      .join("\n");
  }
  function assertClean(text: string): void {
    for (const v of Object.values(PII)) expect(text).not.toContain(v);
    expect(text).not.toContain(A);
  }

  test("spy logger + console spy: expected errors and happy paths log nothing", () => {
    const { svc, logger } = harness();
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => undefined));
    try {
      const a = ok(svc.create(A, pii()));
      svc.create(A, pii()); // DUPLICATE
      svc.create(A, pii({ phone: "12" })); // VALIDATION_FAILED
      svc.create(A, pii({ city: "c".repeat(900) })); // TOO_LONG
      for (let i = 0; i < 12; i++) svc.create(A, pii({ line1: `${i} ${PII.line1}` })); // incl LIMIT_REACHED
      svc.update(A, a.id, pii({ city: "Elsewhere" }));
      svc.update(B, a.id, pii());
      svc.get(B, a.id);
      svc.remove(B, a.id);
      svc.setDefault(A, a.id);
      svc.remove(A, a.id);
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  test("failing triggers whose RAISE message contains PII: log is a code only; AddressStorageError carries no input/message/cause", () => {
    const { db, svc, logger } = harness();
    const a = ok(svc.create(A, pii()));
    const b = ok(svc.create(A, pii({ line1: "2 Other Rd" })));
    const msg = `${PII.fullName} ${PII.line1} ${PII.phone}`;
    db.run(`CREATE TRIGGER qa_i BEFORE INSERT ON addresses BEGIN SELECT RAISE(ABORT, '${msg}'); END`);
    db.run(`CREATE TRIGGER qa_u BEFORE UPDATE ON addresses BEGIN SELECT RAISE(ABORT, '${msg}'); END`);
    db.run(`CREATE TRIGGER qa_d BEFORE DELETE ON addresses BEGIN SELECT RAISE(ABORT, '${msg}'); END`);
    const attempts: Array<() => unknown> = [
      () => svc.create(A, pii({ line1: "3 New St" })),
      () => svc.update(A, a.id, pii({ city: "Moved" })),
      () => svc.remove(A, a.id),
      () => svc.setDefault(A, b.id),
    ];
    for (const attempt of attempts) {
      let thrown: unknown;
      try {
        attempt();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AddressStorageError);
      const e = thrown as AddressStorageError;
      expect(e.code).toMatch(/^SQLITE_[A-Z_]+$/);
      expect(e.cause).toBeUndefined();
      const serial = `${e.message} ${String(e.stack)} ${JSON.stringify(e)} ${Object.keys(e).join(",")}`;
      assertClean(serial);
      for (const k of Object.keys(e)) expect(["operation", "code", "name"]).toContain(k);
    }
    expect(logger.error).toHaveBeenCalledTimes(4);
    for (const call of logger.error.mock.calls) {
      expect(call).toHaveLength(1);
      expect(String(call[0])).toMatch(/^\[addresses\] (create|update|remove|setDefault) failed: SQLITE_[A-Z_]+$/);
    }
    assertClean(loggedText(logger));
    expect(rows(db, A)).toBe(2);
    expect(defaults(db, A)).toBe(1);
  });

  test("closed DB: every operation throws AddressStorageError (no PII), logs a code only", () => {
    const { db, svc, logger } = harness();
    const a = ok(svc.create(A, pii()));
    db.close();
    const ops: Array<() => unknown> = [
      () => svc.list(A),
      () => svc.get(A, a.id),
      () => svc.getDefault(A),
      () => svc.countFor(A),
      () => svc.create(A, pii({ line1: "9 Z St" })),
      () => svc.update(A, a.id, pii({ city: "Q" })),
      () => svc.remove(A, a.id),
      () => svc.setDefault(A, a.id),
    ];
    for (const op of ops) {
      let thrown: unknown;
      try {
        op();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AddressStorageError);
      assertClean(`${(thrown as Error).message} ${JSON.stringify(thrown)}`);
      expect((thrown as Error).cause).toBeUndefined();
    }
    expect(logger.error).toHaveBeenCalledTimes(ops.length);
    for (const call of logger.error.mock.calls) expect(String(call[0])).toMatch(/^\[addresses\] [A-Za-z]+ failed: [A-Za-z0-9_]+$/);
    assertClean(loggedText(logger));
  });
});

// ---------------------------------------------------------------------------
// Criterion 7: no-op update
// ---------------------------------------------------------------------------

describe("AC7 no-op update", () => {
  test("identical values (incl. formatting differences that clean to the same) -> success, updated_at unchanged, no write", () => {
    let clock = T0;
    const { db, svc } = harness(() => (clock += 60_000));
    const a = ok(svc.create(A, addr({ label: "Home", phone: "5551234567", line2: "Apt 1" })));
    const before = snapshot(db);
    let writes = 0;
    db.run("CREATE TABLE qa_audit (n INTEGER)");
    db.run("CREATE TRIGGER qa_audit_u AFTER UPDATE ON addresses BEGIN INSERT INTO qa_audit VALUES (1); END");
    const same = [
      addr({ label: "Home", phone: "5551234567", line2: "Apt 1" }),
      addr({ label: "  Home ", phone: " 5551234567 ", line2: "Apt\u200B 1", country: "US", city: " Arlington\u0000" }),
      addr({ label: "Home", phone: "5551234567", line2: "Apt 1", isDefault: true }), // already default
      addr({ label: "Home", phone: "5551234567", line2: "Apt 1", isDefault: false }),
      addr({ label: "Home", phone: "5551234567", line2: "Apt 1", email: "changed@example.com" }),
    ];
    for (const input of same) {
      const r = ok(svc.update(A, a.id, input, T0 + 999_999_999));
      expect(r.updatedAt).toBe(a.updatedAt);
      expect(r).toEqual(a);
    }
    writes = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM qa_audit").get()?.n ?? 0;
    expect(writes).toBe(0);
    expect(snapshot(db)).toBe(before);
  });

  test("no-op on a non-default without isDefault stays non-default; a real change bumps updated_at only", () => {
    let clock = T0;
    const { svc } = harness(() => (clock += 60_000));
    const a = ok(svc.create(A, nth(1)));
    const b = ok(svc.create(A, nth(2)));
    const same = ok(svc.update(A, b.id, nth(2)));
    expect(same).toEqual(b);
    const changed = ok(svc.update(A, b.id, nth(2, { city: "Reston" })));
    expect(changed.updatedAt > b.updatedAt).toBe(true);
    expect(changed.createdAt).toBe(b.createdAt);
    expect(ok(svc.get(A, a.id)).isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  test("in-process: 15 parallel creates -> exactly 10 rows, one default; 10 ok + 5 LIMIT_REACHED", async () => {
    const { db, svc } = harness();
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => Promise.resolve().then(() => svc.create(A, nth(i)))));
    expect(results.filter((r) => r.ok).length).toBe(10);
    expect(results.filter((r) => !r.ok && r.error.code === "LIMIT_REACHED").length).toBe(5);
    expect(rows(db, A)).toBe(10);
    expect(defaults(db, A)).toBe(1);
  });

  test("in-process: 20 parallel identical creates -> one row", async () => {
    const { db, svc } = harness();
    const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => svc.create(A, addr()))));
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(rows(db, A)).toBe(1);
  });

  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test(
    "worker threads on separate connections (temp-file DB): 15 creates -> 10 rows, one default; dup race -> 1 row",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "qa-t40-"));
      tmpDirs.push(dir);
      const dbPath = join(dir, "addresses.sqlite");
      const setup = createDatabase(dbPath);
      runMigrations(setup);
      setup.close();
      const workerSrc = join(dir, "worker.ts");
      writeFileSync(
        workerSrc,
        `import { createDatabase } from ${JSON.stringify(join(ADDR_DIR, "../db/client.ts"))};
import { createAddressService } from ${JSON.stringify(join(ADDR_DIR, "address-service.ts"))};
declare const self: Worker;
self.onmessage = (e: MessageEvent) => {
  const { dbPath, session, line1, start } = e.data as { dbPath: string; session: string; line1: string; start: Int32Array };
  const db = createDatabase(dbPath);
  const svc = createAddressService({ db, logger: { error: () => undefined, warn: () => undefined } });
  Atomics.add(start, 1, 1);
  Atomics.wait(start, 0, 0, 5000);
  let out: string;
  try {
    const r = svc.create(session, { fullName: "Grace Hopper", email: undefined, line1, line2: undefined, city: "Arlington", region: "VA", postalCode: "22201", country: "US" });
    out = r.ok ? "OK" : r.error.code;
  } catch (err) {
    out = "THROW:" + String((err as { code?: string }).code ?? err);
  }
  db.close();
  postMessage(out);
};
`,
      );
      const start = new Int32Array(new SharedArrayBuffer(8));
      const jobs: Array<{ session: string; line1: string }> = [
        ...Array.from({ length: 15 }, (_, i) => ({ session: A, line1: `${i} Race Street` })),
        ...Array.from({ length: 8 }, () => ({ session: B, line1: "1 Same Street" })),
      ];
      const promises = jobs.map(
        (job) =>
          new Promise<string>((resolve, reject) => {
            const w = new Worker(workerSrc);
            w.onmessage = (e: MessageEvent) => {
              resolve(e.data as string);
              w.terminate();
            };
            w.onerror = (e) => reject(e);
            w.postMessage({ dbPath, ...job, start });
          }),
      );
      const deadline = Date.now() + 15_000;
      while (Atomics.load(start, 1) < jobs.length && Date.now() < deadline) await Bun.sleep(10);
      Atomics.store(start, 0, 1);
      Atomics.notify(start, 0);
      const out = await Promise.all(promises);
      const check = createDatabase(dbPath);
      open.push(check);
      expect(out.filter((x) => x.startsWith("THROW")).length).toBe(0);
      expect(rows(check, A)).toBe(10);
      expect(defaults(check, A)).toBe(1);
      expect(rows(check, B)).toBe(1);
      expect(defaults(check, B)).toBe(1);
      expect(out.slice(0, 15).filter((x) => x === "OK").length).toBe(10);
      expect(out.slice(0, 15).filter((x) => x === "LIMIT_REACHED").length).toBe(5);
      expect(out.slice(15).filter((x) => x === "DUPLICATE").length).toBe(7);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("getAddressService singleton", () => {
  const saved = process.env.DATABASE_PATH;
  beforeAll(() => {
    closeDatabase();
    process.env.DATABASE_PATH = ":memory:";
  });
  afterEach(() => closeDatabase());
  afterAll(() => {
    closeDatabase();
    if (saved === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = saved;
  });

  test("reused per DB handle, rebuilt on a new handle, operates on the shared handle", () => {
    const s1 = getAddressService();
    expect(getAddressService()).toBe(s1);
    const db1 = getDatabase();
    ok(s1.create(A, addr()));
    expect(rows(db1, A)).toBe(1);
    expect(getAddressService()).toBe(s1);
    closeDatabase();
    const s2 = getAddressService();
    expect(s2).not.toBe(s1);
    expect(getDatabase()).not.toBe(db1);
    expect(s2.countFor(A)).toBe(0);
    expect(getAddressService()).toBe(s2);
  });
});
