import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// QA-W2-T51: adversarial tests for the contact server action (T51).
//
// Part 1 drives `createContactActions` (contact-core.ts) with a REAL
// ContactService + RateLimiter over an in-memory SQLite DB, wrapped in spies.
// Part 2 wires `@/app/actions/contact` with next/headers + next/cache mocked
// (mock.module is process-wide, so the mocks are registered before imports).
// Part 3 checks the 'use server' module in a subprocess (no DB at import).
// Known defects are pinned with `test.failing` (they flip when fixed).
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: unknown;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
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
const wiredRevalidate = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
mock.module("next/headers", () => ({ cookies: async (): Promise<FakeCookieStore> => fakeStore }));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidate }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { CONTACT_FIELD } = await import("@/components/molecules/_contracts/contact-actions");
type ContactActionState = import("@/components/molecules/_contracts/contact-actions").ContactActionState;
const { appError } = await import("@/lib/result");
type AppError = import("@/lib/result").AppError;
const { createContactService } = await import("@/server/contact/contact-service");
type ContactService = import("@/server/contact/contact-service").ContactService;
type ContactInput = import("@/server/contact/contact-service").ContactInput;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedDatabase } = await import("@/server/db/seed");
const { createRateLimiter } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { createContactActions, CONTACT_MESSAGES } = await import("@/app/actions/contact-core");
type ContactActionDeps = import("@/app/actions/contact-core").ContactActionDeps;
const wired = await import("@/app/actions/contact");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const ROOT = resolve(import.meta.dir, "../../..");
const S1 = "aaaaaaaa-1111-4111-8111-111111111111";
const S2 = "bbbbbbbb-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z"); // hour + day boundary
const MIN = 60_000;
const HOUR = 3_600_000;
const REF_RE = /^C-[0-9A-HJKMNP-TV-Z]{8}$/;
const DUP_MSG = "We already received this message. Reference numbers were shown on your previous submission.";
const VALID = {
  name: "Grace Hopper",
  email: "grace@example.com",
  topic: "returns",
  message: "Please help me return the tote bag I bought.",
} as const;
const PII = [VALID.name, VALID.email, VALID.message];

type Entry = readonly [string, string | Blob];
function fd(entries: readonly Entry[]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}
function form(fields: Record<string, string | Blob>): FormData {
  return fd(Object.entries(fields));
}

type Failure = Extract<ContactActionState, { ok: false }>;
type Success = Extract<ContactActionState, { ok: true }>;
function expectFail(state: ContactActionState, code: string): Failure {
  if (state === null || state.ok) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code as string).toBe(code);
  expect(state.message).toBe(state.error.message);
  return state;
}
function expectOk(state: ContactActionState): Success {
  if (state === null || !state.ok) throw new Error(`expected success, got ${JSON.stringify(state)}`);
  expect(state.reference).toMatch(REF_RE);
  return state;
}

function insertOrder(db: Database, id: string, sessionId: string): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key)
     VALUES (?, ?, 'paid', 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', ?)`,
  ).run(id, sessionId, `key-${id}`);
}
function rowCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM contact_messages").get() as { n: number }).n;
}

function freshDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  return db;
}

interface Harness {
  readonly db: Database;
  readonly log: string[];
  readonly submit: ReturnType<typeof mock<ContactService["submit"]>>;
  readonly check: ReturnType<typeof mock<RateLimiter["check"]>>;
  readonly getOrCreate: ReturnType<typeof mock<() => Promise<string>>>;
  readonly revalidate: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  readonly logger: { error: ReturnType<typeof mock<(...a: unknown[]) => void>> };
  readonly session: { id: string };
  readonly clock: { ms: number };
  readonly send: (f: FormData) => Promise<ContactActionState>;
  readonly service: ContactService;
}

function setup(over: Partial<ContactActionDeps> = {}, db: Database = freshDb()): Harness {
  const log: string[] = [];
  const clock = { ms: T0 };
  const session = { id: S1 };
  const real = createContactService({ db, logger: { error: () => undefined, warn: () => undefined } });
  const realLimiter = createRateLimiter(db, { now: () => clock.ms, logger: { error: () => undefined } });
  const submit = mock<ContactService["submit"]>((...a) => {
    log.push("service");
    return real.submit(...a);
  });
  const service: ContactService = {
    submit,
    listForSession: (s) => real.listForSession(s),
    getByReference: (s, r) => real.getByReference(s, r),
  };
  const check = mock<RateLimiter["check"]>((key, rule) => {
    log.push(`limiter:${key}`);
    return realLimiter.check(key, rule);
  });
  const getOrCreate = mock(async (): Promise<string> => {
    log.push("session");
    return session.id;
  });
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>((p) => {
    log.push(`revalidate:${p}`);
  });
  const logger = { error: mock<(...a: unknown[]) => void>(() => undefined) };
  const { sendContactMessage } = createContactActions({
    service,
    limiter: { check },
    getOrCreateSessionId: getOrCreate,
    revalidatePath: revalidate,
    now: () => clock.ms,
    logger,
    ...over,
  });
  return {
    db,
    log,
    submit,
    check,
    getOrCreate,
    revalidate,
    logger,
    session,
    clock,
    service: real,
    send: (f) => sendContactMessage(null, f),
  };
}

function spyFormData(entries: readonly Entry[]): { form: FormData; reads: string[] } {
  const target = fd(entries);
  const reads: string[] = [];
  const proxy = new Proxy(target, {
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

async function browserMultipart(parts: readonly (readonly [string, string, string?])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
  let body = "";
  for (const [name, value, filename] of parts) {
    body += `--${boundary}\r\n`;
    body +=
      filename === undefined
        ? `Content-Disposition: form-data; name="${name}"\r\n\r\n`
        : `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`;
    body += `${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  const req = new Request("http://localhost:3000/contact", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      accept: "text/x-component",
      "next-action": "abc123",
    },
    body: new TextEncoder().encode(body),
  });
  return req.formData();
}

// ===========================================================================
// Part 1: core
// ===========================================================================

describe("honeypot (criterion 4, D14)", () => {
  const traps = [" ", "\t", "0", "x", "http://spam.example", "a".repeat(10_000)];
  for (const website of traps) {
    test(`website=${JSON.stringify(website.slice(0, 20))} -> fake success, no row/session/limiter/service/revalidate`, async () => {
      const h = setup();
      const ok = expectOk(await h.send(form({ ...VALID, website })));
      expect(Object.keys(ok).sort()).toEqual(["message", "ok", "reference"]);
      expect(ok.message).toContain(ok.reference);
      expect(rowCount(h.db)).toBe(0);
      expect(h.getOrCreate).not.toHaveBeenCalled();
      expect(h.check).not.toHaveBeenCalled();
      expect(h.submit).not.toHaveBeenCalled();
      expect(h.revalidate).not.toHaveBeenCalled();
      expect(h.logger.error).not.toHaveBeenCalled();
      expect(JSON.stringify(ok)).not.toContain(VALID.email);
    });
  }

  test("honeypot with an otherwise invalid / empty form still looks successful", async () => {
    const h = setup();
    expectOk(await h.send(form({ website: " " })));
    expectOk(await h.send(form({ name: "n".repeat(500), website: "x" })));
    expect(h.log).toEqual([]);
  });

  test("fake references are random (not a constant a bot could fingerprint)", async () => {
    const h = setup();
    const refs = new Set<string>();
    for (let i = 0; i < 20; i++) refs.add(expectOk(await h.send(form({ ...VALID, website: "x" }))).reference);
    expect(refs.size).toBeGreaterThan(15);
  });

  test("honeypot success is indistinguishable in shape from a real success", async () => {
    const h = setup();
    const real = expectOk(await h.send(form({ ...VALID })));
    const fake = expectOk(await h.send(form({ ...VALID, message: `${VALID.message} 2`, website: "x" })));
    expect(Object.keys(fake).sort()).toEqual(Object.keys(real).sort());
    expect(fake.message.replace(fake.reference, "REF")).toBe(real.message.replace(real.reference, "REF"));
  });

  test("a File in website is not a trap (non-string = missing) and does not throw", async () => {
    const h = setup();
    expectOk(await h.send(form({ ...VALID, website: new File(["bot"], "w.txt") })));
    expect(rowCount(h.db)).toBe(1);
  });
});

describe("ordering: pre-check -> session -> limiter -> service -> revalidate", () => {
  test("happy path call order", async () => {
    const h = setup();
    expectOk(await h.send(form({ ...VALID })));
    expect(h.log).toEqual([
      "session",
      `limiter:contact.submit:${S1}`,
      `limiter:contact.submit:${S1}`,
      "limiter:contact.submit:*",
      "service",
      "revalidate:/account/messages",
    ]);
  });

  test("local pre-check failure creates no session and spends no token", async () => {
    const h = setup();
    for (const f of [
      form({}),
      form({ ...VALID, name: "" }),
      form({ ...VALID, topic: "nope" }),
      form({ ...VALID, message: "short" }),
      form({ ...VALID, message: "http://a.io http://b.io http://c.io http://d.io spam" }),
      form({ ...VALID, email: "e".repeat(255) }),
    ]) {
      const s = await h.send(f);
      if (s === null || s.ok) throw new Error("expected failure");
      expect(["VALIDATION_FAILED", "TOO_LONG"]).toContain(s.error.code);
    }
    expect(h.log).toEqual([]);
    expect(rowCount(h.db)).toBe(0);
  });
});

describe("rate limits (criterion 2) run BEFORE the service", () => {
  test("4th submit in an hour -> RATE_LIMITED + retryAfterSeconds; service called only 3 times", async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) expectOk(await h.send(form({ ...VALID, message: `${VALID.message} #${i}` })));
    h.clock.ms += 25 * MIN;
    const s = expectFail(await h.send(form({ ...VALID, message: `${VALID.message} #3` })), "RATE_LIMITED");
    expect(s.retryAfterSeconds).toBe(35 * 60);
    expect(s.error.details).toEqual({ retryAfterSeconds: 35 * 60 });
    expect(s.fieldErrors).toEqual({});
    expect(h.submit).toHaveBeenCalledTimes(3);
    expect(h.revalidate).toHaveBeenCalledTimes(3);
    expect(rowCount(h.db)).toBe(3);
  });

  test("rate-limited submit that would also be a DUPLICATE still reports RATE_LIMITED (service not consulted)", async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) expectOk(await h.send(form({ ...VALID, message: `${VALID.message} #${i}` })));
    expectFail(await h.send(form({ ...VALID, message: `${VALID.message} #0` })), "RATE_LIMITED");
    expect(h.submit).toHaveBeenCalledTimes(3);
  });

  test("11th submit in a day -> RATE_LIMITED (10/day), service not called", async () => {
    const h = setup();
    let n = 0;
    for (let hour = 0; hour < 4 && n < 10; hour++) {
      for (let i = 0; i < 3 && n < 10; i++) {
        expectOk(await h.send(form({ ...VALID, message: `${VALID.message} ${hour}/${i}` })));
        n++;
      }
      h.clock.ms = T0 + (hour + 1) * HOUR;
    }
    // Now in hour 4 with 10 accepted today (3+3+3+1); hourly budget is fresh.
    expect(n).toBe(10);
    const calls = h.submit.mock.calls.length;
    const s = expectFail(await h.send(form({ ...VALID, message: `${VALID.message} eleventh` })), "RATE_LIMITED");
    // Day windows align to UTC midnight; T0+4h = 14:00Z -> 10 h left.
    expect(s.retryAfterSeconds).toBe(10 * 3600);
    expect(h.submit.mock.calls.length).toBe(calls);
    expect(rowCount(h.db)).toBe(10);
    h.clock.ms = T0 + 24 * HOUR;
    expectOk(await h.send(form({ ...VALID, message: `${VALID.message} next day` })));
  });

  test("200/hour global backstop trips across 201 distinct sessions; 201st not stored", async () => {
    const h = setup();
    for (let i = 0; i < 200; i++) {
      h.session.id = `cccccccc-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      expectOk(await h.send(form({ ...VALID, message: `${VALID.message} from ${i}` })));
    }
    h.session.id = "dddddddd-0000-4000-8000-000000000201";
    const calls = h.submit.mock.calls.length;
    const s = expectFail(await h.send(form({ ...VALID, message: `${VALID.message} 201` })), "RATE_LIMITED");
    expect(s.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number.isInteger(s.retryAfterSeconds)).toBe(true);
    expect(h.submit.mock.calls.length).toBe(calls);
    expect(rowCount(h.db)).toBe(200);
  });

  test("limiter DB failure fails closed (RATE_LIMITED), never reaches the service", async () => {
    const h = setup({ limiter: { check: () => appErrorResult("RATE_LIMITED", { retryAfterSeconds: 3600 }) } });
    expectFail(await h.send(form({ ...VALID })), "RATE_LIMITED");
    expect(h.submit).not.toHaveBeenCalled();
  });
});

function appErrorResult(code: AppError["code"], details?: Record<string, unknown>): { ok: false; error: AppError } {
  return { ok: false, error: appError(code, "raw internal text", details as AppError["details"]) };
}

describe("field errors (criterion 1)", () => {
  function stubbed(error: AppError): Harness {
    return setup({
      service: {
        submit: () => ({ ok: false, error }),
        listForSession: () => [],
        getByReference: () => ({ ok: false, error: appError("NOT_FOUND", "x") }),
      },
    });
  }

  test("service details.fields map to fieldErrors per field; TOO_LONG only when all are length errors", async () => {
    const allLong = stubbed(
      appError("TOO_LONG", "x", {
        fields: {
          name: { code: "TOO_LONG", message: "Name must be at most 80 characters." },
          message: { code: "TOO_LONG", message: "Message must be at most 2000 characters." },
        },
      } as unknown as AppError["details"]),
    );
    const a = expectFail(await allLong.send(form({ ...VALID })), "TOO_LONG");
    expect(a.fieldErrors).toEqual({
      name: "Name must be at most 80 characters.",
      message: "Message must be at most 2000 characters.",
    });
    expect(a.error.details).toEqual({ fields: { name: "TOO_LONG", message: "TOO_LONG" } });

    const mixed = stubbed(
      appError("TOO_LONG", "x", {
        fields: {
          name: { code: "TOO_LONG", message: "Name must be at most 80 characters." },
          email: { code: "INVALID_EMAIL", message: "Enter a valid email address." },
        },
      } as unknown as AppError["details"]),
    );
    const m = expectFail(await mixed.send(form({ ...VALID })), "VALIDATION_FAILED");
    expect(m.fieldErrors).toEqual({ name: "Name must be at most 80 characters.", email: "Enter a valid email address." });
  });

  test("real oversize input (raw > 4x cap) -> TOO_LONG, echo truncated, no session", async () => {
    const h = setup();
    const s = expectFail(await h.send(form({ ...VALID, name: "n".repeat(10_000) })), "TOO_LONG");
    expect(s.fieldErrors).toEqual({ name: "Name must be at most 80 characters." });
    expect(s.values.name).toBe("n".repeat(80));
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("> 3 URLs -> VALIDATION_FAILED with fieldErrors.message; exactly 3 URLs is accepted", async () => {
    const h = setup();
    const s = expectFail(
      await h.send(form({ ...VALID, message: "see www.a.io, http://b.io https://c.io and HTTPS://d.io" })),
      "VALIDATION_FAILED",
    );
    expect(s.fieldErrors).toEqual({ message: "Messages can include at most 3 links." });
    expect(s.error.details).toEqual({ fields: { message: "TOO_MANY_URLS" } });
    expectOk(await h.send(form({ ...VALID, message: "see www.a.io, http://b.io and https://c.io please" })));
  });

  test("details never carry raw input (whitelisted codes only)", async () => {
    const h = setup();
    const s = expectFail(await h.send(form({ ...VALID, email: "not an email<script>" })), "VALIDATION_FAILED");
    expect(JSON.stringify(s.error)).not.toContain("<script>");
  });
});

describe("duplicates (criterion 3)", () => {
  test("same message within 10 min -> exact DUPLICATE message, one row, no second revalidate", async () => {
    const h = setup();
    expectOk(await h.send(form({ ...VALID })));
    h.clock.ms += 9 * MIN + 59_000;
    const s = expectFail(await h.send(form({ ...VALID, name: "Other", topic: "other" })), "DUPLICATE");
    expect(s.message).toBe(DUP_MSG);
    expect(s.error.message).toBe(DUP_MSG);
    expect(s.fieldErrors).toEqual({});
    expect(s.values).toEqual({ ...VALID, name: "Other", topic: "other" });
    expect(rowCount(h.db)).toBe(1);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
  });

  test("after the window the same message is accepted again", async () => {
    const h = setup();
    expectOk(await h.send(form({ ...VALID })));
    h.clock.ms += 10 * MIN + 1;
    expectOk(await h.send(form({ ...VALID })));
    expect(rowCount(h.db)).toBe(2);
  });

  test("two concurrent identical submits -> one row, one DUPLICATE", async () => {
    const h = setup();
    const [a, b] = await Promise.all([h.send(form({ ...VALID })), h.send(form({ ...VALID }))]);
    const codes = [a, b].map((s) => (s !== null && s.ok ? "OK" : (s as Failure).error.code)).sort();
    expect(codes).toEqual(["DUPLICATE", "OK"]);
    expect(rowCount(h.db)).toBe(1);
  });
});

describe("order ownership (criterion 5)", () => {
  async function stateFor(setupOrder: (db: Database) => void, orderId: string): Promise<Failure> {
    const db = freshDb();
    setupOrder(db);
    const h = setup({}, db);
    const s = expectFail(await h.send(form({ ...VALID, topic: "ordering", orderId })), "VALIDATION_FAILED");
    expect(rowCount(db)).toBe(0);
    expect(h.revalidate).not.toHaveBeenCalled();
    return s;
  }

  test("foreign order id gives the identical whole state as a missing one", async () => {
    const foreign = await stateFor((db) => insertOrder(db, "ord_123", S2), "ord_123");
    const missing = await stateFor(() => undefined, "ord_123");
    expect(foreign).toEqual(missing);
    expect(foreign.fieldErrors).toEqual({ orderId: "We could not find that order in your order history." });
    expect(foreign.error.details).toEqual({ fields: { orderId: "INVALID_ORDER" } });
  });

  test("malformed order ids (SQL-ish, 200 chars, whitespace-padded foreign) -> same fieldErrors, details", async () => {
    const ref = await stateFor(() => undefined, "ord_123");
    for (const orderId of ["' OR 1=1 --", "o".repeat(200), "%", "  ord_x  "]) {
      const s = await stateFor((db) => insertOrder(db, "ord_x", S2), orderId);
      expect(s.fieldErrors).toEqual(ref.fieldErrors);
      expect(s.error).toEqual(ref.error);
    }
  });

  test("own order is accepted; blank orderId is absent", async () => {
    const db = freshDb();
    insertOrder(db, "ord_mine", S1);
    const h = setup({}, db);
    expectOk(await h.send(form({ ...VALID, topic: "ordering", orderId: "ord_mine" })));
    expectOk(await h.send(form({ ...VALID, message: `${VALID.message} 2`, orderId: "   " })));
    expect(db.query("SELECT order_id FROM contact_messages ORDER BY created_at, rowid").all()).toEqual([
      { order_id: "ord_mine" },
      { order_id: null },
    ]);
  });
});

describe("echoed values", () => {
  test("truncated to caps without splitting surrogate pairs (name 80, email 254, message 2000)", async () => {
    const h = setup();
    const E = "\u{1F600}";
    const s = expectFail(
      await h.send(
        form({ name: `${"a".repeat(79)}${E}zz`, email: `${"b".repeat(253)}${E}`, topic: "bad", message: `${"c".repeat(1999)}${E}` }),
      ),
      "VALIDATION_FAILED",
    );
    expect(s.values.name).toBe("a".repeat(79));
    expect(s.values.email).toBe("b".repeat(253));
    expect(s.values.message).toBe("c".repeat(1999));
    for (const v of [s.values.name, s.values.email, s.values.message]) {
      expect(JSON.stringify(v)).not.toMatch(/\\ud[89ab]/i);
    }
  });

  test("a whole pair that fits exactly is kept", async () => {
    const h = setup();
    const s = expectFail(await h.send(form({ name: `${"a".repeat(78)}\u{1F600}x`, topic: "bad" })), "VALIDATION_FAILED");
    expect(s.values.name).toBe(`${"a".repeat(78)}\u{1F600}`);
  });

  test("honeypot and productSlug are never echoed", async () => {
    const h = setup();
    const s = expectFail(
      await h.send(form({ ...VALID, topic: "bad", productSlug: "zz-secret-slug-zz", website: "" })),
      "VALIDATION_FAILED",
    );
    const json = JSON.stringify(s);
    expect(json).not.toContain("zz-secret-slug-zz");
    expect(Object.keys(s.values).sort()).toEqual(["email", "message", "name", "topic"].sort());
    expect("website" in s.values).toBe(false);
    expect("productSlug" in s.values).toBe(false);
  });
});

describe("forged fields and FormData access", () => {
  test("only contract fields are read via get(); forged sessionId/reference/status/$ACTION_* never touched", async () => {
    const h = setup();
    const { form: f, reads } = spyFormData([
      ...Object.entries(VALID),
      ["sessionId", S2],
      ["session_id", S2],
      ["reference", "C-AAAAAAAA"],
      ["status", "answered"],
      ["$ACTION_ID_deadbeef", ""],
      ["$ACTION_REF_1", ""],
      ["$ACTION_1:0", '{"id":"x","bound":"$@1"}'],
      ["createdAt", "1999-01-01T00:00:00.000Z"],
    ]);
    const ok = expectOk(await h.send(f));
    expect(ok.reference).not.toBe("C-AAAAAAAA");
    const allowed = new Set(Object.values(CONTACT_FIELD).map((n) => `get:${n}`));
    for (const r of reads) expect(allowed.has(r)).toBe(true);
    const row = h.db.query("SELECT session_id, reference, created_at FROM contact_messages").get() as {
      session_id: string;
      reference: string;
      created_at: string;
    };
    expect(row.session_id).toBe(S1);
    expect(row.reference).toBe(ok.reference);
    expect(row.created_at).toBe(new Date(T0).toISOString());
  });

  test("File entries count as missing for every field (orderId File = absent)", async () => {
    const h = setup();
    const file = new File(["x".repeat(30)], "f.txt", { type: "text/plain" });
    const s = expectFail(
      await h.send(form({ name: file, email: file, topic: file, message: file, website: file })),
      "VALIDATION_FAILED",
    );
    expect(s.error.details).toEqual({
      fields: { name: "REQUIRED", email: "REQUIRED", topic: "INVALID_TOPIC", message: "REQUIRED" },
    });
    expect(s.values).toEqual({});
    expectOk(await h.send(form({ ...VALID, orderId: file, productSlug: file })));
  });
});

describe("revalidate only on success; no redirect", () => {
  test("no revalidate for any failure kind", async () => {
    const h = setup();
    expectFail(await h.send(form({ ...VALID, name: "" })), "VALIDATION_FAILED");
    expectFail(await h.send(form({ ...VALID, email: "nope" })), "VALIDATION_FAILED");
    expectFail(await h.send(form({ ...VALID, orderId: "ord_none" })), "VALIDATION_FAILED");
    expect(h.revalidate).not.toHaveBeenCalled();
    h.clock.ms += HOUR; // service-side failures spent hourly tokens
    expectOk(await h.send(form({ ...VALID })));
    expectFail(await h.send(form({ ...VALID })), "DUPLICATE");
    expect(h.revalidate.mock.calls).toEqual([["/account/messages"]]);
  });

  test("states are plain JSON and the module does not import next/navigation", async () => {
    const h = setup();
    const s = await h.send(form({ ...VALID }));
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    for (const file of ["src/app/actions/contact.ts", "src/app/actions/contact-core.ts"]) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/next\/navigation|redirect\(/);
    }
  });
});

describe("always settles; logs carry no PII", () => {
  const boom = (): never => {
    throw new Error(`boom ${VALID.name} ${VALID.email} ${VALID.message}`);
  };
  const cases: [string, Partial<ContactActionDeps>][] = [
    ["service throws", { service: { submit: boom, listForSession: () => [], getByReference: boom } }],
    ["limiter throws", { limiter: { check: boom } }],
    ["session throws", { getOrCreateSessionId: async () => boom() }],
    ["session rejects with non-Error", { getOrCreateSessionId: () => Promise.reject(VALID.email) }],
  ];
  for (const [label, over] of cases) {
    test(`${label} -> generic state; logger AND console free of name/email/message`, async () => {
      const consoleSpies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
        spyOn(console, m).mockImplementation(() => undefined),
      );
      try {
        const h = setup(over);
        const s = expectFail(await h.send(form({ ...VALID })), "INVALID_INPUT");
        expect(s.message).toBe(CONTACT_MESSAGES.unavailable);
        expect(s.error.details).toEqual({ reason: "unavailable" });
        expect(JSON.stringify(s.error)).not.toContain("boom");
        expect(h.logger.error).toHaveBeenCalledTimes(1);
        const logged = [
          ...h.logger.error.mock.calls,
          ...consoleSpies.flatMap((sp) => sp.mock.calls as unknown[][]),
        ]
          .map((c) => c.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x))).join(" "))
          .join("\n");
        for (const p of PII) expect(logged).not.toContain(p);
        expect(logged).not.toContain(S1);
        expect(h.revalidate).not.toHaveBeenCalled();
        expect(rowCount(h.db)).toBe(0);
      } finally {
        for (const sp of consoleSpies) sp.mockRestore();
      }
    });
  }

  test("default logger is console; console line has no PII", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const db = freshDb();
      const { sendContactMessage } = createContactActions({
        service: createContactService({ db }),
        limiter: { check: () => { throw new Error(VALID.email); } },
        getOrCreateSessionId: async () => S1,
        revalidatePath: () => undefined,
      });
      expectFail(await sendContactMessage(null, form({ ...VALID })), "INVALID_INPUT");
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(line).toContain("CONTACT_ACTION_FAILED");
      for (const p of PII) expect(line).not.toContain(p);
    } finally {
      spy.mockRestore();
    }
  });

  test("FormData whose get() throws still settles", async () => {
    const h = setup();
    const bad = { get: () => { throw new Error(VALID.email); } } as unknown as FormData;
    expectFail(await h.send(bad), "INVALID_INPUT");
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("revalidatePath throwing after the insert still settles (documented: row is stored)", async () => {
    const h = setup({ revalidatePath: () => { throw new Error("revalidate failed"); } });
    const s = await h.send(form({ ...VALID }));
    expect(s).not.toBeNull();
    expect(rowCount(h.db)).toBe(1);
  });

  test("service returning an unknown error code -> generic, raw text not leaked", async () => {
    const h = setup({
      service: {
        submit: () => appErrorResult("NOT_FOUND"),
        listForSession: () => [],
        getByReference: () => appErrorResult("NOT_FOUND"),
      },
    });
    const s = expectFail(await h.send(form({ ...VALID })), "INVALID_INPUT");
    expect(JSON.stringify(s)).not.toContain("raw internal text");
  });
});

describe("browser-shaped multipart bodies", () => {
  test("Chrome-style multipart with $ACTION fields, CRLF + UTF-8 message parses and stores", async () => {
    const h = setup();
    const message = "Hallo, ich möchte die Tasche zurückgeben.\r\nDanke! \u{1F600}";
    const f = await browserMultipart([
      ["$ACTION_REF_1", ""],
      ["$ACTION_1:0", '{"id":"abc123","bound":"$@1"}'],
      ["$ACTION_1:1", "[null]"],
      ["$ACTION_KEY", "k0"],
      [CONTACT_FIELD.name, "Zoë Ünal"],
      [CONTACT_FIELD.email, VALID.email],
      [CONTACT_FIELD.topic, "returns"],
      [CONTACT_FIELD.orderId, ""],
      [CONTACT_FIELD.productSlug, ""],
      [CONTACT_FIELD.message, message],
      [CONTACT_FIELD.website, ""],
    ]);
    expectOk(await h.send(f));
    const row = h.db.query("SELECT name, message FROM contact_messages").get() as { name: string; message: string };
    expect(row.name).toBe("Zoë Ünal");
    expect(row.message).toBe("Hallo, ich möchte die Tasche zurückgeben.\nDanke! \u{1F600}");
  });

  test("a file part (filename=) for message counts as missing", async () => {
    const h = setup();
    const f = await browserMultipart([
      [CONTACT_FIELD.name, VALID.name],
      [CONTACT_FIELD.email, VALID.email],
      [CONTACT_FIELD.topic, VALID.topic],
      [CONTACT_FIELD.message, "a long enough message body", "msg.txt"],
    ]);
    const s = expectFail(await h.send(f), "VALIDATION_FAILED");
    expect(s.fieldErrors).toEqual({ message: "Message is required." });
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("honeypot filled in a real multipart body", async () => {
    const h = setup();
    const f = await browserMultipart([...Object.entries(VALID), [CONTACT_FIELD.website, " "]]);
    expectOk(await h.send(f));
    expect(h.log).toEqual([]);
    expect(rowCount(h.db)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Drift guard: action fieldErrors must equal the service's details.fields
// messages for the same input (pre-check parity).
// ---------------------------------------------------------------------------

describe("pre-check parity (drift guard): action fieldErrors === service details.fields messages", () => {
  async function compare(input: Record<string, string>): Promise<{ action: unknown; service: unknown }> {
    const h = setup();
    const s = expectFail(await h.send(form(input)), (await (async () => {
      const r = h.service.submit(S2, input as unknown as ContactInput, T0);
      if (r.ok) throw new Error("case must be invalid for the service");
      return r.error.code === "TOO_LONG" ? "TOO_LONG" : "VALIDATION_FAILED";
    })()));
    const r = h.service.submit(S2, input as unknown as ContactInput, T0);
    if (r.ok) throw new Error("unreachable");
    const fields = (r.error.details?.fields ?? {}) as Record<string, { message: string }>;
    const serviceMessages = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.message]));
    return { action: s.fieldErrors, service: serviceMessages };
  }

  const PASSING: [string, Record<string, string>][] = [
    ["all missing", {}],
    ["blank name, whitespace email", { ...VALID, name: "   ", email: " \t " }],
    ["name too long", { ...VALID, name: "n".repeat(81) }],
    ["topic padded is OK, bad topic", { ...VALID, topic: "Returns" }],
    ["topic over 32 raw chars", { ...VALID, topic: `${" ".repeat(30)}returns` }],
    ["message 9 chars", { ...VALID, message: "123456789" }],
    ["message 4 urls", { ...VALID, message: "a http://a.io b http://b.io c www.c.io d https://d.io" }],
    ["bad email pattern only", { ...VALID, email: "user@localhost" }],
    ["invisible-only name", { ...VALID, name: "​​﻿" }],
    ["email too long", { ...VALID, email: `${"e".repeat(250)}@x.io` }],
  ];
  for (const [label, input] of PASSING) {
    test(label, async () => {
      const { action, service } = await compare(input);
      expect(action).toEqual(service);
    });
  }

  // DEFECT D-T51-1: empty / whitespace-only message -> pre-check says TOO_SHORT,
  // service says REQUIRED ("Message is required.").
  test("DEFECT D-T51-1: empty message string -> REQUIRED like the service", async () => {
    const { action, service } = await compare({ ...VALID, message: "" });
    expect(action).toEqual(service);
  });
  test("DEFECT D-T51-1: whitespace-only message -> REQUIRED like the service", async () => {
    const { action, service } = await compare({ ...VALID, message: "   \n\n  " });
    expect(action).toEqual(service);
  });

  // DEFECT D-T51-2: when the pre-check fails it returns ONLY the pre-check
  // errors, dropping the (DB-free) INVALID_EMAIL error the service reports.
  test("DEFECT D-T51-2: blank name + malformed email -> both errors like the service", async () => {
    const { action, service } = await compare({ ...VALID, name: "", email: "not-an-email" });
    expect(action).toEqual(service);
  });
});

// ===========================================================================
// Part 2: wired 'use server' module
// ===========================================================================

describe("wired sendContactMessage", () => {
  beforeEach(() => {
    closeDatabase();
    seedDatabase(getDatabase());
    fakeStore = new FakeCookieStore();
    wiredRevalidate.mockClear();
  });

  function count(): number {
    return rowCount(getDatabase());
  }

  test("honeypot: no cookie, no row, no revalidate, no rate_limits row", async () => {
    const s = await wired.sendContactMessage(null, form({ ...VALID, website: " " }));
    expectOk(s);
    expect(fakeStore.setCalls).toEqual([]);
    expect(count()).toBe(0);
    expect(wiredRevalidate).not.toHaveBeenCalled();
    expect((getDatabase().query("SELECT COUNT(*) AS n FROM rate_limits").get() as { n: number }).n).toBe(0);
  });

  test("pre-check failure: no cookie, no rate_limits row; valid: cookie set once and row stored under it", async () => {
    expectFail(await wired.sendContactMessage(null, form({ ...VALID, topic: "nope" })), "VALIDATION_FAILED");
    expect(fakeStore.setCalls).toEqual([]);
    expect((getDatabase().query("SELECT COUNT(*) AS n FROM rate_limits").get() as { n: number }).n).toBe(0);
    const ok = expectOk(await wired.sendContactMessage(null, form({ ...VALID, sessionId: S2 })));
    expect(fakeStore.setCalls.map((c) => c.name)).toEqual([SESSION_COOKIE_NAME]);
    const row = getDatabase().query("SELECT reference, session_id FROM contact_messages").get() as {
      reference: string;
      session_id: string;
    };
    expect(row).toEqual({ reference: ok.reference, session_id: fakeStore.setCalls[0]?.value ?? "" });
    expect(row.session_id).not.toBe(S2);
    expect(wiredRevalidate.mock.calls).toEqual([["/account/messages"]]);
  });

  test("4th wired submit in an hour is RATE_LIMITED", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    for (let i = 0; i < 3; i++) expectOk(await wired.sendContactMessage(null, form({ ...VALID, message: `${VALID.message} ${i}` })));
    const s = expectFail(await wired.sendContactMessage(null, form({ ...VALID, message: `${VALID.message} 3` })), "RATE_LIMITED");
    expect(s.retryAfterSeconds).toBeGreaterThan(0);
    expect(count()).toBe(3);
  });

  test("module exports exactly one async function", () => {
    expect(Object.keys(wired)).toEqual(["sendContactMessage"]);
    expect((wired.sendContactMessage as unknown as () => unknown).constructor.name).toBe("AsyncFunction");
    const src = readFileSync(join(ROOT, "src/app/actions/contact.ts"), "utf8");
    expect(src.trimStart().startsWith('"use server"')).toBe(true);
    expect(src.match(/^export /gm)).toHaveLength(1);
    expect(src).toMatch(/^export async function sendContactMessage\(/m);
  });
});

// ===========================================================================
// Part 3: importing the 'use server' module opens no DB (subprocess)
// ===========================================================================

describe("import side effects", () => {
  test("importing contact.ts creates no database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "contact-qa-"));
    const dbPath = join(dir, "probe.sqlite");
    try {
      const script = join(dir, "probe.ts");
      writeFileSync(
        script,
        `const m = await import(${JSON.stringify(join(ROOT, "src/app/actions/contact.ts"))});\nconsole.log(JSON.stringify(Object.keys(m)));\n`,
      );
      const proc = Bun.spawnSync([process.execPath, script], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: "test" },
      });
      const out = proc.stdout.toString();
      expect(proc.exitCode).toBe(0);
      expect(out).toContain('["sendContactMessage"]');
      expect(existsSync(dbPath)).toBe(false);
      expect(readdirSync(dir).filter((n) => n.startsWith("probe.sqlite"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
