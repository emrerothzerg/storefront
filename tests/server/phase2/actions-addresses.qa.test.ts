import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA-W2-T49 (T54 part 1): adversarial tests for the address server actions.
//
// Part 1 drives `createAddressActions` (addresses-core) with the real
// AddressService and real T31 limiter over in-memory SQLite plus recording
// fakes for the session helpers. Part 2 drives the `'use server'` wrappers
// with `next/headers` and `next/cache` mocked. No test touches ./data.
// ---------------------------------------------------------------------------

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: { name: string; value: string; options: unknown }[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  getAll(): { name: string; value: string }[] {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }
  has(name: string): boolean {
    return this.jar.has(name);
  }
  set(name: string, value: string, options?: unknown): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }
  delete(name: string): void {
    this.jar.delete(name);
  }
}

let fakeStore = new FakeCookieStore();
const wiredRevalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
type AddressActionState = import("@/components/molecules/_contracts/address-actions").AddressActionState;
const { ADDRESS_FIELD, ADDRESS_MAX_LENGTH } = await import("@/components/molecules/_contracts/address-actions");
const { createAddressActions, ADDRESS_MESSAGES } = await import("@/app/actions/addresses-core");
type AddressActionDeps = import("@/app/actions/addresses-core").AddressActionDeps;
type AddressActions = import("@/app/actions/addresses-core").AddressActions;
const { createAddressService, AddressStorageError } = await import("@/server/addresses/address-service");
type AddressService = import("@/server/addresses/address-service").AddressService;
const { createRateLimiter } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");

const wired = await import("@/app/actions/addresses");

const ROOT = join(import.meta.dir, "..", "..", "..");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const DAY_MS = 86_400_000;

const PII = {
  fullName: "Quillon Vexmoor",
  phone: "+1 (555) 013-4477",
  line1: "88 Obsidian Wharf",
  line2: "Unit 7J",
  city: "Larkspur Hollow",
  region: "Northmarch",
  postalCode: "QX4 2ZZ",
} as const;

const VALID: Readonly<Record<string, string>> = { label: "Home", ...PII, country: "gb" };

type Entry = readonly [string, string | Blob];

function fd(fields: Readonly<Record<string, string | Blob>>, extra: readonly Entry[] = []): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const [k, v] of extra) f.append(k, v);
  return f;
}

function nth(n: number, extra: Readonly<Record<string, string | Blob>> = {}): FormData {
  return fd({ ...VALID, line1: `${n} Engine Street`, ...extra });
}

function spyFormData(form: FormData): { form: FormData; reads: string[] } {
  const reads: string[] = [];
  const proxy = new Proxy(form, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        reads.push(`prop:${String(prop)}`);
        return value;
      }
      return (...args: unknown[]) => {
        reads.push(`${String(prop)}:${args.map(String).join(",")}`);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { form: proxy, reads };
}

async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryQaAddr9Z";
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  return new Request("http://localhost:3000/account/addresses", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, origin: "http://localhost:3000" },
    body,
  }).formData();
}

type Failure = Extract<NonNullable<AddressActionState>, { ok: false }>;
type Success = Extract<NonNullable<AddressActionState>, { ok: true }>;

function errorOf(state: AddressActionState): Failure {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  expect(state.message).toBe(state.error.message);
  return state;
}

function okOf(state: AddressActionState): Success {
  if (state === null || !state.ok) throw new Error(`expected ok state, got ${JSON.stringify(state)}`);
  return state;
}

function rows(db: Database): { id: string; session_id: string; line1: string; is_default: number }[] {
  return db
    .query<{ id: string; session_id: string; line1: string; is_default: number }, []>(
      "SELECT id, session_id, line1, is_default FROM addresses ORDER BY created_at, id",
    )
    .all();
}

interface Harness {
  db: Database;
  service: AddressService;
  calls: string[];
  session: { current: string | null; next: string };
  clock: { ms: number };
  logger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  serviceLogger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>>; warn: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  revalidate: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  actions: AddressActions;
}

function setup(overrides: Partial<AddressActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const calls: string[] = [];
  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const serviceLogger = {
    error: mock<(...args: unknown[]) => void>(() => undefined),
    warn: mock<(...args: unknown[]) => void>(() => undefined),
  };
  const real = createAddressService({ db, logger: serviceLogger, now: () => clock.ms });
  const service = new Proxy(real, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`service.${String(prop)}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const realLimiter = createRateLimiter(db, { now: () => clock.ms });
  const limiter: RateLimiter = {
    check: (key, rule) => {
      calls.push(`limiter:${key}`);
      return realLimiter.check(key, rule);
    },
  };
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>((path) => {
    calls.push(`revalidate:${path}`);
  });
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const deps: AddressActionDeps = {
    service,
    limiter,
    getOrCreateSessionId: async () => {
      calls.push("getOrCreateSessionId");
      if (session.current === null) session.current = session.next;
      return session.current;
    },
    readSessionId: async () => {
      calls.push("readSessionId");
      return session.current;
    },
    revalidatePath: revalidate,
    now: () => clock.ms,
    logger,
    ...overrides,
  };
  return { db, service: real, calls, session, clock, logger, serviceLogger, revalidate, actions: createAddressActions(deps) };
}

async function created(h: Harness, form: FormData = fd(VALID)): Promise<string> {
  const id = okOf(await h.actions.saveAddress(null, form)).addressId ?? "";
  h.calls.length = 0;
  h.revalidate.mockClear();
  return id;
}

let consoleSpies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  for (const s of consoleSpies) s.mockRestore();
});

function allLogs(h?: Harness): string {
  const parts: unknown[] = [];
  for (const s of consoleSpies) parts.push(...s.mock.calls.flat());
  if (h !== undefined) {
    parts.push(...h.logger.error.mock.calls.flat(), ...h.serviceLogger.error.mock.calls.flat(), ...h.serviceLogger.warn.mock.calls.flat());
  }
  return parts.map((p) => (p instanceof Error ? `${p.message} ${p.stack ?? ""}` : String(p))).join("\n");
}

function expectNoPii(text: string): void {
  for (const v of Object.values(PII)) expect(text).not.toContain(v);
  expect(text).not.toContain("Engine Street");
}

// ---------------------------------------------------------------------------
// Part 1: core
// ---------------------------------------------------------------------------

describe("QA T49 session rules", () => {
  test("create mints a session only after local validation passes; order: session -> limiter -> service -> revalidate", async () => {
    const h = setup();
    errorOf(await h.actions.saveAddress(null, fd({ ...VALID, fullName: "" })));
    expect(h.calls).toEqual([]);
    expect(h.session.current).toBeNull();
    okOf(await h.actions.saveAddress(null, fd(VALID)));
    expect(h.calls).toEqual([
      "getOrCreateSessionId",
      `limiter:address.write:${S1}`,
      "service.create",
      "revalidate:/account/addresses",
      "revalidate:/checkout",
    ]);
  });

  const nonMinting: readonly [keyof AddressActions, (id: string) => FormData][] = [
    ["saveAddress", (id) => fd({ ...VALID, addressId: id })],
    ["deleteAddress", (id) => fd({ addressId: id, confirm: "yes" })],
    ["setDefaultAddress", (id) => fd({ addressId: id })],
  ];
  for (const [name, build] of nonMinting) {
    test(`${name} (update path) without a cookie: NOT_FOUND, never mints, no limiter/service`, async () => {
      const h = setup();
      const err = errorOf(await h.actions[name](null, build("00000000-0000-4000-8000-000000000001")));
      expect(err.error).toEqual({ code: "NOT_FOUND", message: ADDRESS_MESSAGES.notFound });
      expect(h.calls).toEqual(["readSessionId"]);
      expect(h.session.current).toBeNull();
    });
  }
});

describe("QA T49 criterion 1: per-field validation", () => {
  test("empty FormData does not throw: per-field REQUIRED errors, no cookie, no token", async () => {
    const h = setup();
    const err = errorOf(await h.actions.saveAddress(null, new FormData()));
    expect(err.error.code).toBe("VALIDATION_FAILED");
    for (const f of ["fullName", "line1", "city", "postalCode", "country"]) expect(typeof err.fieldErrors[f as keyof typeof err.fieldErrors]).toBe("string");
    expect(err.values).toEqual({});
    expect(h.calls).toEqual([]);
  });

  for (const [field, max] of Object.entries(ADDRESS_MAX_LENGTH)) {
    test(`${field}: cap+1 rejected with a field error, echo truncated to ${max}; nothing written`, async () => {
      const h = setup();
      const value = field === "phone" ? "5".repeat(max + 1) : field === "country" ? "g".repeat(max + 1) : "a".repeat(max + 1);
      const err = errorOf(await h.actions.saveAddress(null, fd({ ...VALID, [field]: value })));
      expect(["VALIDATION_FAILED", "TOO_LONG"]).toContain(err.error.code);
      expect(typeof err.fieldErrors[field as keyof typeof err.fieldErrors]).toBe("string");
      expect(err.values[field as keyof typeof err.values]?.length).toBe(max);
      expect(rows(h.db)).toEqual([]);
      expect(h.calls).toEqual([]);
    });
  }

  test("1 MB field: TOO_LONG quickly, echo truncated", async () => {
    const h = setup();
    const t = performance.now();
    const err = errorOf(await h.actions.saveAddress(null, fd({ ...VALID, line1: "x".repeat(1_000_000) })));
    expect(performance.now() - t).toBeLessThan(500);
    expect(err.error.code).toBe("TOO_LONG");
    expect(err.values.line1?.length).toBe(200);
  });

  test("File entries count as missing; non-sensitive values are echoed; checkbox echo is 'on' only", async () => {
    const h = setup();
    const err = errorOf(await h.actions.saveAddress(null, fd({ ...VALID, fullName: new File(["x"], "x.txt"), isDefault: "true" })));
    expect(err.fieldErrors.fullName).toBeDefined();
    expect(err.values.fullName).toBeUndefined();
    expect(err.values.city).toBe(PII.city);
    expect(err.values.isDefault).toBe("on");
  });

  test("HTML, RTL override and zero-width text are stored as plain text (no markup), invisibles stripped", async () => {
    const h = setup();
    const id = await created(h, fd({ ...VALID, label: "<b>Work</b>", line2: "‮Flat​ 2" }));
    const saved = h.service.get(S1, id);
    expect(saved.ok && saved.value.label).toBe("<b>Work</b>");
    expect(saved.ok && saved.value.line2).toBe("Flat 2");
  });
});

describe("QA T49 criterion 2: limit + duplicate", () => {
  test("10 addresses ok, 11th LIMIT_REACHED (details.max 10) with the limit message; duplicate -> DUPLICATE", async () => {
    const h = setup();
    for (let i = 1; i <= 10; i++) okOf(await h.actions.saveAddress(null, nth(i)));
    const limit = errorOf(await h.actions.saveAddress(null, nth(11)));
    expect(limit.error).toEqual({ code: "LIMIT_REACHED", message: ADDRESS_MESSAGES.limitReached, details: { max: 10 } });
    expect(limit.message).toContain("10");
    expect(rows(h.db)).toHaveLength(10);
    // Duplicate (normalised: case, punctuation, spacing) at 10/10 is DUPLICATE per service order (duplicate before limit).
    const dup = errorOf(await h.actions.saveAddress(null, nth(3, { fullName: "  quillon   VEXMOOR ", line1: "3 engine street." })));
    expect(dup.error).toEqual({ code: "DUPLICATE", message: ADDRESS_MESSAGES.duplicate });
  });

  test("same address in another session is not a duplicate", async () => {
    const h = setup();
    await created(h);
    h.session.current = S2;
    okOf(await h.actions.saveAddress(null, fd(VALID)));
  });
});

describe("QA T49 criterion 3: NOT_FOUND oracle, delete confirm, cross-session matrix", () => {
  test("foreign, unknown, malformed and no-cookie ids all give one identical NOT_FOUND state; A's rows untouched", async () => {
    const h = setup();
    const aId = await created(h);
    const before = rows(h.db);
    h.session.current = S2;
    const ids = [aId, "00000000-0000-4000-8000-0000000000ff", "x".repeat(65), "' OR 1=1 --", "../../etc"];
    const actions: readonly [keyof AddressActions, (id: string) => FormData][] = [
      ["saveAddress", (id) => fd({ ...VALID, addressId: id, line1: "1 Hijack Road" })],
      ["deleteAddress", (id) => fd({ addressId: id, confirm: "yes" })],
      ["setDefaultAddress", (id) => fd({ addressId: id })],
    ];
    for (const [name, build] of actions) {
      const states = [];
      for (const id of ids) states.push(errorOf(await h.actions[name](null, build(id))));
      const first = states[0];
      for (const s of states) {
        expect(s.error).toEqual({ code: "NOT_FOUND", message: ADDRESS_MESSAGES.notFound });
        expect(s.error).toEqual(first?.error ?? { code: "NOT_FOUND", message: "unreachable" });
      }
      expect(JSON.stringify(states)).not.toContain(aId);
    }
    h.session.current = null;
    for (const [name, build] of actions) {
      expect(errorOf(await h.actions[name](null, build(aId))).error).toEqual({ code: "NOT_FOUND", message: ADDRESS_MESSAGES.notFound });
    }
    expect(rows(h.db)).toEqual(before);
    expect(h.service.list(S2)).toEqual([]);
  });

  for (const confirm of [null, "", "YES", "yes ", "true", "1", "on"]) {
    test(`deleteAddress confirm=${JSON.stringify(confirm)}: VALIDATION_FAILED confirm_required, row kept, no token`, async () => {
      const h = setup();
      const id = await created(h);
      const f = fd({ addressId: id });
      if (confirm !== null) f.append("confirm", confirm);
      const err = errorOf(await h.actions.deleteAddress(null, f));
      expect(err.error).toEqual({ code: "VALIDATION_FAILED", message: ADDRESS_MESSAGES.confirmRequired, details: { reason: "confirm_required" } });
      expect(err.fieldErrors).toEqual({});
      expect(rows(h.db)).toHaveLength(1);
      expect(h.calls).toEqual([]);
    });
  }

  test("delete with confirm=yes removes only the owner's row; setDefault flips the default", async () => {
    const h = setup();
    const a = await created(h, nth(1));
    const b = await created(h, nth(2));
    okOf(await h.actions.setDefaultAddress(null, fd({ addressId: b })));
    expect(h.service.getDefault(S1)?.id).toBe(b);
    okOf(await h.actions.deleteAddress(null, fd({ addressId: a, confirm: "yes" })));
    expect(rows(h.db).map((r) => r.id)).toEqual([b]);
  });
});

describe("QA T49 criterion 4: rate limit 20/day shared across all three actions", () => {
  test("20 mixed writes pass; the 21st of EACH action is RATE_LIMITED without touching the service; next day works", async () => {
    const h = setup();
    const ids: string[] = [];
    for (let i = 1; i <= 8; i++) ids.push(okOf(await h.actions.saveAddress(null, nth(i))).addressId ?? "");
    for (let i = 0; i < 6; i++) okOf(await h.actions.setDefaultAddress(null, fd({ addressId: ids[i % 8] ?? "" })));
    for (let i = 0; i < 3; i++) okOf(await h.actions.saveAddress(null, fd({ ...VALID, line1: `${i + 1} Engine Street`, addressId: ids[i] ?? "", label: `L${i}` })));
    for (let i = 5; i < 8; i++) okOf(await h.actions.deleteAddress(null, fd({ addressId: ids[i] ?? "", confirm: "yes" })));
    // 8 + 6 + 3 + 3 = 20 tokens spent. Validation failures do not spend any:
    for (let i = 0; i < 5; i++) errorOf(await h.actions.saveAddress(null, fd({ ...VALID, fullName: "" })));
    h.calls.length = 0;
    const blocked = [
      await h.actions.saveAddress(null, nth(50)),
      await h.actions.saveAddress(null, fd({ ...VALID, line1: "1 Engine Street", addressId: ids[0] ?? "", label: "Z" })),
      await h.actions.setDefaultAddress(null, fd({ addressId: ids[1] ?? "" })),
      await h.actions.deleteAddress(null, fd({ addressId: ids[2] ?? "", confirm: "yes" })),
    ];
    for (const s of blocked) {
      const err = errorOf(s);
      expect(err.error.code).toBe("RATE_LIMITED");
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
      expect(err.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    }
    expect(h.calls.filter((c) => c.startsWith("service."))).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("revalidate:"))).toEqual([]);
    // Echo survives the rate-limit state so the form can re-fill.
    expect(errorOf(blocked[0] ?? null).values.city).toBe(PII.city);
    // Another session has its own budget.
    h.session.current = S2;
    okOf(await h.actions.saveAddress(null, fd(VALID)));
    h.session.current = S1;
    h.clock.ms += DAY_MS;
    okOf(await h.actions.setDefaultAddress(null, fd({ addressId: ids[1] ?? "" })));
  });
});

describe("QA T49 criterion 5: no PII in logs, redirects or cookies; storage errors settle", () => {
  test("AddressStorageError from the real service (table dropped) -> generic settled state, PII-free logs, values echoed", async () => {
    const h = setup();
    const id = await created(h);
    h.db.run("DROP TABLE addresses");
    const states = [
      await h.actions.saveAddress(null, nth(2)),
      await h.actions.saveAddress(null, fd({ ...VALID, addressId: id })),
      await h.actions.deleteAddress(null, fd({ addressId: id, confirm: "yes" })),
      await h.actions.setDefaultAddress(null, fd({ addressId: id })),
    ];
    for (const s of states) {
      const err = errorOf(s);
      expect(err.error).toEqual({ code: "INVALID_INPUT", message: ADDRESS_MESSAGES.unavailable, details: { reason: "unavailable" } });
      expect(JSON.parse(JSON.stringify(err))).toEqual(err);
    }
    expect(errorOf(states[0] ?? null).values.city).toBe(PII.city);
    const text = allLogs(h);
    expect(text.length).toBeGreaterThan(0);
    expectNoPii(text);
    expect(text).not.toContain(id);
    expect(text).not.toContain(S1);
    for (const call of h.logger.error.mock.calls) {
      expect(String(call[0])).toMatch(/^\[addresses\] ADDRESS_ACTION_FAILED action=(save|delete|setDefault) code=[A-Z][A-Z0-9_]*$/);
    }
  });

  test("a thrown non-storage error carrying PII in its message is logged as code=UNEXPECTED only", async () => {
    const h = setup();
    const boom = new Proxy(h.service, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return () => {
          throw new Error(`failed for ${PII.fullName} at ${PII.line1}`);
        };
      },
    });
    const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
    const actions = createAddressActions({
      service: boom,
      limiter: createRateLimiter(h.db, { now: () => T0 }),
      getOrCreateSessionId: async () => S1,
      readSessionId: async () => S1,
      revalidatePath: () => undefined,
      logger,
    });
    errorOf(await actions.saveAddress(null, fd(VALID)));
    errorOf(await actions.saveAddress(null, fd({ ...VALID, addressId: "abc" })));
    expect(logger.error.mock.calls.map((c) => String(c[0]))).toEqual([
      "[addresses] ADDRESS_ACTION_FAILED action=save code=UNEXPECTED",
      "[addresses] ADDRESS_ACTION_FAILED action=save code=UNEXPECTED",
    ]);
    // An AddressStorageError with a code is surfaced as its code only.
    const storage = createAddressActions({
      service: { ...h.service, create: () => { throw new AddressStorageError("create", "SQLITE_BUSY"); } } as AddressService,
      limiter: createRateLimiter(h.db, { now: () => T0 }),
      getOrCreateSessionId: async () => S2,
      readSessionId: async () => S2,
      revalidatePath: () => undefined,
      logger,
    });
    errorOf(await storage.saveAddress(null, fd(VALID)));
    expect(String(logger.error.mock.calls.at(-1)?.[0])).toBe("[addresses] ADDRESS_ACTION_FAILED action=save code=SQLITE_BUSY");
    expectNoPii(allLogs());
  });

  test("happy paths log nothing; states and revalidate args carry no PII; no redirect in the source", async () => {
    const h = setup();
    const id = await created(h);
    okOf(await h.actions.saveAddress(null, fd({ ...VALID, addressId: id, label: "Work" })));
    okOf(await h.actions.setDefaultAddress(null, fd({ addressId: id })));
    const s = okOf(await h.actions.deleteAddress(null, fd({ addressId: id, confirm: "yes" })));
    expectNoPii(JSON.stringify(s));
    expect(allLogs(h)).toBe("");
    expectNoPii(JSON.stringify(h.revalidate.mock.calls));
    for (const f of ["src/app/actions/addresses.ts", "src/app/actions/addresses-core.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src).not.toMatch(/\bredirect\s*\(/);
      expect(src).not.toMatch(/from "next\/navigation"/);
    }
  });
});

describe("QA T49 criterion 6: revalidation", () => {
  test("each successful action revalidates exactly /account/addresses and /checkout; failures revalidate nothing", async () => {
    const h = setup();
    okOf(await h.actions.saveAddress(null, fd(VALID)));
    const id = rows(h.db)[0]?.id ?? "";
    okOf(await h.actions.saveAddress(null, fd({ ...VALID, addressId: id, label: "W" })));
    okOf(await h.actions.setDefaultAddress(null, fd({ addressId: id })));
    okOf(await h.actions.deleteAddress(null, fd({ addressId: id, confirm: "yes" })));
    expect(h.revalidate.mock.calls).toEqual([
      ["/account/addresses"], ["/checkout"],
      ["/account/addresses"], ["/checkout"],
      ["/account/addresses"], ["/checkout"],
      ["/account/addresses"], ["/checkout"],
    ]);
    h.revalidate.mockClear();
    errorOf(await h.actions.deleteAddress(null, fd({ addressId: id, confirm: "yes" })));
    errorOf(await h.actions.saveAddress(null, fd({ ...VALID, country: "" })));
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});

describe("QA T49 forged fields ignored", () => {
  test("only contract fields are read; forged sessionId/email/id/userId/isVerified have no effect", async () => {
    const h = setup();
    const { form, reads } = spyFormData(
      fd(VALID, [["sessionId", S2], ["email", "victim@example.com"], ["id", "forced-id"], ["userId", "u1"], ["verified", "true"], ["price", "1"], ["$ACTION_ID_x", ""]]),
    );
    const s = okOf(await h.actions.saveAddress(null, form));
    const allowed = new Set(Object.values(ADDRESS_FIELD).map((f) => `get:${f}`));
    for (const r of reads) expect(allowed.has(r)).toBe(true);
    expect(s.addressId).not.toBe("forced-id");
    expect(rows(h.db).map((r) => r.session_id)).toEqual([S1]);
    expect(JSON.stringify(h.db.query("SELECT * FROM addresses").all())).not.toContain("victim");
  });
});

// ---------------------------------------------------------------------------
// Part 2: wired 'use server' module
// ---------------------------------------------------------------------------

describe("QA T49 'use server' module", () => {
  test("starts with 'use server' and exports exactly three async functions", () => {
    const src = readFileSync(join(ROOT, "src/app/actions/addresses.ts"), "utf8");
    expect(src.trimStart().startsWith('"use server";')).toBe(true);
    const exportLines = src.split("\n").filter((l) => /^export\b/.test(l));
    expect(exportLines).toHaveLength(3);
    for (const l of exportLines) expect(l).toMatch(/^export async function \w+\(/);
    expect(Object.keys(wired).sort()).toEqual(["deleteAddress", "saveAddress", "setDefaultAddress"]);
    for (const v of Object.values(wired)) expect((v as () => unknown).constructor.name).toBe("AsyncFunction");
  });

  test("importing the module in a fresh process opens no database", async () => {
    const probeDb = join(import.meta.dir, `.qa-t49-probe-${process.pid}.sqlite`);
    const script = [
      `const before = globalThis.__storefrontDb;`,
      `await import(${JSON.stringify(join(ROOT, "src/app/actions/addresses.ts"))});`,
      `console.log(JSON.stringify({ before: before === undefined, after: globalThis.__storefrontDb === undefined }));`,
    ].join("\n");
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, env: { ...process.env, DATABASE_PATH: probeDb }, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString().trim().split("\n").pop() ?? "")).toEqual({ before: true, after: true });
    expect(await Bun.file(probeDb).exists()).toBe(false);
  });
});

describe("QA T49 wired actions (browser multipart, cookies)", () => {
  beforeEach(() => {
    env.DATABASE_PATH = ":memory:";
    closeDatabase();
    getDatabase();
    fakeStore = new FakeCookieStore();
    wiredRevalidatePath.mockClear();
  });

  const extras: [string, string][] = [["$ACTION_REF_1", ""], ["$ACTION_1:0", '{"id":"abc","bound":"$@1"}'], ["$ACTION_KEY", "k1"], ["sessionId", S2]];

  test("all three actions via browser-shaped multipart; create sets exactly one UUID sf_session cookie with no PII", async () => {
    const save = okOf(await wired.saveAddress(null, await browserMultipart([...extras, ...Object.entries(VALID), ["isDefault", "on"]])));
    expect(fakeStore.setCalls).toHaveLength(1);
    const cookie = fakeStore.setCalls[0];
    expect(cookie?.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie?.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(cookie?.value).not.toBe(S2);
    expectNoPii(JSON.stringify(fakeStore.setCalls));
    const id = save.addressId ?? "";
    okOf(await wired.saveAddress(null, await browserMultipart([...extras, ...Object.entries(VALID), ["addressId", id], ["label", "Office"]])));
    okOf(await wired.setDefaultAddress(null, await browserMultipart([...extras, ["addressId", id]])));
    okOf(await wired.deleteAddress(null, await browserMultipart([...extras, ["addressId", id], ["confirm", "yes"]])));
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(wiredRevalidatePath.mock.calls.map((c) => c.join(":"))).toEqual(Array.from({ length: 4 }, () => ["/account/addresses", "/checkout"]).flat());
  });

  test("no cookie: update/delete/setDefault return NOT_FOUND and set no cookie; invalid create sets no cookie", async () => {
    expect(errorOf(await wired.saveAddress(null, fd({ ...VALID, addressId: "a1" }))).error.code).toBe("NOT_FOUND");
    expect(errorOf(await wired.deleteAddress(null, fd({ addressId: "a1", confirm: "yes" }))).error.code).toBe("NOT_FOUND");
    expect(errorOf(await wired.setDefaultAddress(null, fd({ addressId: "a1" }))).error.code).toBe("NOT_FOUND");
    expect(errorOf(await wired.saveAddress(null, fd({ ...VALID, city: "" }))).error.code).toBe("VALIDATION_FAILED");
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("cross-session through the wrappers: cookie B cannot read/modify cookie A's address", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    const id = okOf(await wired.saveAddress(null, fd(VALID))).addressId ?? "";
    fakeStore.jar.set(SESSION_COOKIE_NAME, S2);
    expect(errorOf(await wired.saveAddress(null, fd({ ...VALID, addressId: id, line1: "9 Taken Lane" }))).error.code).toBe("NOT_FOUND");
    expect(errorOf(await wired.setDefaultAddress(null, fd({ addressId: id }))).error.code).toBe("NOT_FOUND");
    expect(errorOf(await wired.deleteAddress(null, fd({ addressId: id, confirm: "yes" }))).error.code).toBe("NOT_FOUND");
    const row = getDatabase().query<{ line1: string; session_id: string }, [string]>("SELECT line1, session_id FROM addresses WHERE id = ?").get(id);
    expect(row).toEqual({ line1: PII.line1, session_id: S1 });
  });

  test("database cannot open: wrappers settle with the generic state (save echoes values), PII-free logs", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/qa-t49/cannot.sqlite";
    try {
      fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
      const save = errorOf(await wired.saveAddress(null, fd(VALID)));
      expect(save.error.details).toEqual({ reason: "unavailable" });
      expect(save.values.city).toBe(PII.city);
      expect(errorOf(await wired.deleteAddress(null, fd({ addressId: "a", confirm: "yes" }))).error.details).toEqual({ reason: "unavailable" });
      expect(errorOf(await wired.setDefaultAddress(null, fd({ addressId: "a" }))).error.details).toEqual({ reason: "unavailable" });
      expectNoPii(allLogs());
    } finally {
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});
