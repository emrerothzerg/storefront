import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ContactActionState } from "@/components/molecules/_contracts/contact-actions";
import { CONTACT_FIELD } from "@/components/molecules/_contracts/contact-actions";
import { appError, type AppError, type Result } from "@/lib/result";
import { createContactService, type ContactInput, type ContactService } from "@/server/contact/contact-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  createRateLimiter,
  type RateLimiter,
  type RateLimitOk,
  type RateLimitRule,
} from "@/server/security/rate-limiter";
import {
  ACCOUNT_MESSAGES_PATH,
  CONTACT_ACTION_FAILED,
  CONTACT_MESSAGES,
  createContactActions,
  echoValues,
  fieldErrorState,
  parseContactForm,
  precheckContact,
  rateLimitedMessage,
  toErrorState,
  type ContactActionDeps,
} from "./contact-core";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const REF_RE = /^C-[0-9A-HJKMNP-TV-Z]{8}$/;

const VALID = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  topic: "shipping",
  message: "Where is my parcel? It has been a week.",
} as const;

type Fields = Record<string, string | Blob>;

function form(fields: Fields): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Builds FormData the way a browser serialises a multipart form post. */
async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryq8Xc2ZPf0aJ4Lm1T";
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  const request = new Request("http://localhost/contact", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return request.formData();
}

interface CountingLimiter extends RateLimiter {
  readonly calls: string[];
}

function counting(inner: RateLimiter): CountingLimiter {
  const calls: string[] = [];
  return {
    calls,
    check(key: string, rule: RateLimitRule): Result<RateLimitOk, AppError> {
      calls.push(key);
      return inner.check(key, rule);
    },
  };
}

interface Harness {
  readonly db: Database;
  readonly service: ContactService;
  readonly limiter: CountingLimiter;
  readonly getOrCreate: ReturnType<typeof mock<() => Promise<string>>>;
  readonly revalidatePath: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  readonly logger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  readonly send: ReturnType<typeof createContactActions>["sendContactMessage"];
  readonly session: { current: string | null; next: string };
  readonly clock: { ms: number };
}

function setup(overrides: Partial<ContactActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const getOrCreate = mock(async (): Promise<string> => {
    if (session.current === null) session.current = session.next;
    return session.current;
  });
  const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const service = createContactService({ db, logger: { error: () => undefined, warn: () => undefined } });
  const limiter = counting(createRateLimiter(db, { now: () => clock.ms }));
  const { sendContactMessage } = createContactActions({
    service,
    limiter,
    getOrCreateSessionId: getOrCreate,
    revalidatePath,
    now: () => clock.ms,
    logger,
    ...overrides,
  });
  return { db, service, limiter, getOrCreate, revalidatePath, logger, send: sendContactMessage, session, clock };
}

function rows(db: Database): { reference: string; session_id: string | null; message: string; order_id: string | null; product_slug: string | null }[] {
  return db.query("SELECT reference, session_id, message, order_id, product_slug FROM contact_messages ORDER BY created_at, rowid").all() as {
    reference: string;
    session_id: string | null;
    message: string;
    order_id: string | null;
    product_slug: string | null;
  }[];
}

function insertOrder(db: Database, id: string, sessionId: string): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key)
     VALUES (?, ?, 'paid', 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', ?)`,
  ).run(id, sessionId, `key-${id}`);
}

type Failure = Extract<ContactActionState, { ok: false }>;
type Success = Extract<ContactActionState, { ok: true }>;

function expectError(state: ContactActionState, code: AppError["code"]): Failure {
  if (state === null || state.ok) throw new Error(`expected error ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code);
  expect(state.message).toBe(state.error.message);
  return state;
}

function expectSuccess(state: ContactActionState): Success {
  if (state === null || !state.ok) throw new Error(`expected success, got ${JSON.stringify(state)}`);
  expect(state.reference).toMatch(REF_RE);
  expect(state.message).toContain(state.reference);
  return state;
}

describe("sendContactMessage: success", () => {
  test("plain browser multipart post stores one row under the lazily created session", async () => {
    const h = setup();
    const fd = await browserMultipart([
      [CONTACT_FIELD.name, VALID.name],
      [CONTACT_FIELD.email, VALID.email],
      [CONTACT_FIELD.topic, VALID.topic],
      [CONTACT_FIELD.message, VALID.message],
      [CONTACT_FIELD.orderId, ""],
      [CONTACT_FIELD.productSlug, ""],
      [CONTACT_FIELD.website, ""],
      ["$ACTION_ID_abc123", ""],
    ]);
    const ok = expectSuccess(await h.send(null, fd));
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(rows(h.db)).toEqual([
      { reference: ok.reference, session_id: S1, message: VALID.message, order_id: null, product_slug: null },
    ]);
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_MESSAGES_PATH]]);
    // Session rule (3) + global rule.
    expect(h.limiter.calls).toEqual([`contact.submit:${S1}`, `contact.submit:${S1}`, "contact.submit:*"]);
  });

  test("forged sessionId / reference / status fields are ignored", async () => {
    const h = setup();
    const ok = expectSuccess(
      await h.send(null, form({ ...VALID, sessionId: S2, reference: "C-AAAAAAAA", status: "answered" })),
    );
    expect(ok.reference).not.toBe("C-AAAAAAAA");
    const [row] = rows(h.db);
    expect(row?.session_id).toBe(S1);
    expect(row?.reference).toBe(ok.reference);
  });

  test("valid productSlug is stored; unknown slug is dropped silently", async () => {
    const h = setup();
    expectSuccess(await h.send(null, form({ ...VALID, topic: "product", productSlug: "ceramic-pour-over" })));
    expectSuccess(await h.send(null, form({ ...VALID, message: "Another question here.", productSlug: "nope" })));
    expect(rows(h.db).map((r) => r.product_slug)).toEqual(["ceramic-pour-over", null]);
  });

  test("never redirects: the result is a plain JSON-serializable state with no PII", async () => {
    const h = setup();
    const state = await h.send(null, form({ ...VALID }));
    const json = JSON.stringify(state);
    expect(JSON.parse(json)).toEqual(state);
    expect(json).not.toContain(VALID.email);
    expect(json).not.toContain(VALID.name);
  });
});

describe("sendContactMessage: field errors (criterion 1)", () => {
  test("each invalid field gets its own message; nothing stored, no session, no limiter", async () => {
    const h = setup();
    const state = expectError(
      await h.send(null, form({ name: "   ", email: "", topic: "gossip", message: "short" })),
      "VALIDATION_FAILED",
    );
    expect(state.fieldErrors).toEqual({
      name: "Name is required.",
      email: "Email is required.",
      topic: "Choose a topic.",
      message: "Message must be at least 10 characters.",
    });
    expect(state.error.details).toEqual({
      fields: { name: "REQUIRED", email: "REQUIRED", topic: "INVALID_TOPIC", message: "TOO_SHORT" },
    });
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(rows(h.db)).toEqual([]);
  });

  test("oversize fields -> TOO_LONG with per-field messages", async () => {
    const h = setup();
    const state = expectError(
      await h.send(null, form({ ...VALID, name: "n".repeat(81), message: "m".repeat(2001) })),
      "TOO_LONG",
    );
    expect(state.fieldErrors).toEqual({
      name: "Name must be at most 80 characters.",
      message: "Message must be at most 2000 characters.",
    });
    expect(h.limiter.calls).toEqual([]);
    expect(rows(h.db)).toEqual([]);
  });

  test("mixed too-long and invalid -> VALIDATION_FAILED", async () => {
    const h = setup();
    const state = expectError(await h.send(null, form({ ...VALID, name: "n".repeat(81), topic: "" })), "VALIDATION_FAILED");
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["name", "topic"]);
  });

  test("URL spam -> VALIDATION_FAILED on message", async () => {
    const h = setup();
    const spam = "Buy now https://a.example https://b.example https://c.example https://d.example";
    const state = expectError(await h.send(null, form({ ...VALID, message: spam })), "VALIDATION_FAILED");
    expect(state.fieldErrors).toEqual({ message: "Messages can include at most 3 links." });
    expect(h.limiter.calls).toEqual([]);
  });

  test("invalid email pattern is caught locally: no session, no limiter", async () => {
    const h = setup();
    const state = expectError(await h.send(null, form({ ...VALID, email: "not-an-email" })), "VALIDATION_FAILED");
    expect(state.fieldErrors).toEqual({ email: "Enter a valid email address." });
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
    expect(rows(h.db)).toEqual([]);
  });

  test("all DB-free errors are reported in one response (blank name + bad email + blank message)", async () => {
    const h = setup();
    const state = expectError(
      await h.send(null, form({ ...VALID, name: "", email: "not-an-email", message: "   \n\n  " })),
      "VALIDATION_FAILED",
    );
    expect(state.fieldErrors).toEqual({
      name: "Name is required.",
      email: "Enter a valid email address.",
      message: "Message is required.",
    });
    expect(h.limiter.calls).toEqual([]);
  });

  test("own-order check still runs after the limiter (needs the DB)", async () => {
    const h = setup();
    const state = expectError(await h.send(null, form({ ...VALID, orderId: "ord_nope" })), "VALIDATION_FAILED");
    expect(Object.keys(state.fieldErrors)).toEqual(["orderId"]);
    expect(h.limiter.calls.length).toBeGreaterThan(0);
  });

  test("File entries count as missing", async () => {
    const h = setup();
    const blob = new Blob(["x".repeat(20)], { type: "text/plain" });
    const state = expectError(
      await h.send(null, form({ name: blob, email: VALID.email, topic: VALID.topic, message: blob })),
      "VALIDATION_FAILED",
    );
    expect(state.fieldErrors).toEqual({ name: "Name is required.", message: "Message is required." });
    expect(state.values).toEqual({ email: VALID.email, topic: VALID.topic });
    expect(h.limiter.calls).toEqual([]);
  });

  test("an empty FormData settles with errors and never creates a session", async () => {
    const h = setup();
    const state = expectError(await h.send(null, new FormData()), "VALIDATION_FAILED");
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["email", "message", "name", "topic"]);
    expect(state.values).toEqual({});
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("echoed values are truncated to caps and never include the honeypot or productSlug", async () => {
    const h = setup();
    const state = expectError(
      await h.send(
        null,
        form({
          name: "n".repeat(500),
          email: "e".repeat(400),
          topic: "t".repeat(65),
          message: "m".repeat(2500),
          orderId: "o".repeat(65),
          productSlug: "ceramic-pour-over",
          website: "",
        }),
      ),
      "VALIDATION_FAILED",
    );
    expect(state.values).toEqual({ name: "n".repeat(80), email: "e".repeat(254), message: "m".repeat(2000) });
    expect(Object.keys(state.values)).not.toContain("website");
  });
});

describe("sendContactMessage: honeypot (criterion 4)", () => {
  test("non-empty website: success-looking, stores nothing, no session, no limiter, no revalidate", async () => {
    const h = setup();
    for (const website of ["http://spam.example", " ", "x"]) {
      const ok = expectSuccess(await h.send(null, form({ ...VALID, website })));
      expect(ok.message).toBe(`${CONTACT_MESSAGES.sent} Your reference number is ${ok.reference}.`);
    }
    expect(rows(h.db)).toEqual([]);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("honeypot wins even when the rest of the form is invalid", async () => {
    const h = setup();
    expectSuccess(await h.send(null, form({ website: "bot" })));
    expect(h.limiter.calls).toEqual([]);
  });

  test("empty or non-string website is not a trap", async () => {
    const h = setup();
    expectSuccess(await h.send(null, form({ ...VALID, website: new Blob(["bot"]) })));
    expect(rows(h.db)).toHaveLength(1);
  });
});

describe("sendContactMessage: rate limits (criterion 2)", () => {
  test("3 per hour per session, then RATE_LIMITED with retryAfterSeconds; next hour works", async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) {
      expectSuccess(await h.send(null, form({ ...VALID, message: `${VALID.message} #${i}` })));
    }
    const state = expectError(await h.send(null, form({ ...VALID, message: `${VALID.message} #3` })), "RATE_LIMITED");
    expect(state.retryAfterSeconds).toBe(3600);
    expect(state.error.details).toEqual({ retryAfterSeconds: 3600 });
    expect(state.message).toBe("You have sent several messages recently. Please try again in 60 minutes.");
    expect(state.values.message).toBe(`${VALID.message} #3`);
    expect(rows(h.db)).toHaveLength(3);

    h.clock.ms += HOUR_MS;
    expectSuccess(await h.send(null, form({ ...VALID, message: `${VALID.message} #4` })));
  });

  test("another session is not affected by one session's hourly limit", async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) expectSuccess(await h.send(null, form({ ...VALID, message: `${VALID.message} #${i}` })));
    h.session.current = S2;
    expectSuccess(await h.send(null, form({ ...VALID, message: `${VALID.message} other` })));
  });

  test("10 per day per session", async () => {
    const h = setup();
    let sent = 0;
    for (let hour = 0; hour < 4; hour++) {
      for (let i = 0; i < 3; i++) {
        const state = await h.send(null, form({ ...VALID, message: `${VALID.message} h${hour} #${i}` }));
        if (sent < 10) {
          expectSuccess(state);
          sent++;
        } else {
          const limited = expectError(state, "RATE_LIMITED");
          expect(limited.retryAfterSeconds).toBeGreaterThan(3600);
        }
      }
      h.clock.ms += HOUR_MS;
    }
    expect(rows(h.db)).toHaveLength(10);
  });

  test("200 per hour global backstop", async () => {
    const h = setup();
    const raw = createRateLimiter(h.db, { now: () => h.clock.ms });
    for (let i = 0; i < 200; i++) raw.check("contact.submit:*", { limit: 200, windowSeconds: 3600 });
    const state = expectError(await h.send(null, form({ ...VALID })), "RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(rows(h.db)).toEqual([]);
  });
});

describe("sendContactMessage: duplicates and orders (criteria 3, 5)", () => {
  test("double submit within 10 minutes -> DUPLICATE, one row", async () => {
    const h = setup();
    expectSuccess(await h.send(null, form({ ...VALID })));
    h.clock.ms += 9 * 60_000;
    const state = expectError(await h.send(null, form({ ...VALID, topic: "other" })), "DUPLICATE");
    expect(state.message).toBe(
      "We already received this message. Reference numbers were shown on your previous submission.",
    );
    expect(state.fieldErrors).toEqual({});
    expect(rows(h.db)).toHaveLength(1);
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
  });

  test("own order id is accepted; a foreign or unknown one is a field error", async () => {
    const h = setup();
    insertOrder(h.db, "ord_mine", S1);
    insertOrder(h.db, "ord_theirs", S2);
    expectSuccess(await h.send(null, form({ ...VALID, topic: "ordering", orderId: "ord_mine" })));
    expect(rows(h.db)[0]?.order_id).toBe("ord_mine");
    for (const orderId of ["ord_theirs", "ord_missing"]) {
      const state = expectError(
        await h.send(null, form({ ...VALID, message: `Order question ${orderId}`, orderId })),
        "VALIDATION_FAILED",
      );
      expect(state.fieldErrors).toEqual({ orderId: "We could not find that order in your order history." });
      expect(state.values.orderId).toBe(orderId);
    }
    expect(rows(h.db)).toHaveLength(1);
  });
});

describe("sendContactMessage: always settles", () => {
  test("service throwing -> generic state, logs only the error code", async () => {
    const throwing: ContactService = {
      submit: () => {
        throw new Error(`boom ${VALID.email}`);
      },
      listForSession: () => [],
      getByReference: () => ({ ok: false, error: appError("NOT_FOUND", "x") }),
    };
    const h = setup({ service: throwing });
    const state = expectError(await h.send(null, form({ ...VALID })), "INVALID_INPUT");
    expect(state.message).toBe(CONTACT_MESSAGES.unavailable);
    expect(state.error.details).toEqual({ reason: "unavailable" });
    expect(state.values).toEqual({ ...VALID });
    expect(h.logger.error.mock.calls).toEqual([[`[contact] ${CONTACT_ACTION_FAILED}`]]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("session creation failing -> generic state", async () => {
    const h = setup({
      getOrCreateSessionId: async () => {
        throw new Error("cookies unavailable");
      },
    });
    expectError(await h.send(null, form({ ...VALID })), "INVALID_INPUT");
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  test("a non-FormData argument still settles", async () => {
    const h = setup();
    const state = await h.send(null, {} as unknown as FormData);
    expectError(state, "INVALID_INPUT");
  });

  test("service INVALID_INPUT (DB fault) -> unavailable message", async () => {
    const failing: ContactService = {
      submit: () => ({ ok: false, error: appError("INVALID_INPUT", "We could not send your message. Please try again.") }),
      listForSession: () => [],
      getByReference: () => ({ ok: false, error: appError("NOT_FOUND", "x") }),
    };
    const h = setup({ service: failing });
    const state = expectError(await h.send(null, form({ ...VALID })), "INVALID_INPUT");
    expect(state.message).toBe(CONTACT_MESSAGES.unavailable);
  });
});

describe("helpers", () => {
  test("action fieldErrors equal the service's field messages for 10 invalid inputs (no drift, no filtering)", async () => {
    const tooLong = { name: "n".repeat(81), email: `${"e".repeat(250)}@x.io`, topic: VALID.topic, message: "m".repeat(2001) };
    const cases: Partial<Record<keyof ContactInput, string>>[] = [
      {},
      { ...VALID, message: "" },
      { ...VALID, message: "   \n\n  " },
      { ...VALID, message: "123456789" },
      { ...VALID, email: "not-an-email" },
      { ...VALID, name: "", email: "not-an-email" },
      { name: "", email: " ", topic: " shipping ", message: "123456789" },
      tooLong,
      { ...VALID, message: "see http://a.io http://b.io http://c.io http://d.io now" },
      { ...VALID, topic: "x".repeat(40), message: "\u200b\u200b\u200b   \n\n  hi  " },
    ];
    for (const c of cases) {
      const h = setup();
      const state = expectError(await h.send(null, form(c)), c === tooLong ? "TOO_LONG" : "VALIDATION_FAILED");
      const result = h.service.submit(S2, { name: c.name, email: c.email, topic: c.topic, message: c.message }, T0);
      if (result.ok) throw new Error("expected service validation failure");
      const serviceFields = (result.error.details?.fields ?? {}) as Record<string, { message: string }>;
      const serviceMessages = Object.fromEntries(Object.entries(serviceFields).map(([k, v]) => [k, v.message]));
      expect(state.fieldErrors).toEqual(serviceMessages);
      expect(state.error.code).toBe(result.error.code);
      expect(precheckContact(parseContactForm(form(c)))).toEqual(serviceFields);
      expect(h.limiter.calls).toEqual([]);
      expect(rows(h.db)).toEqual([]);
    }
  });

  test("fieldErrorState keeps only known fields with known codes and string messages", () => {
    const state = fieldErrorState(
      {
        name: { code: "REQUIRED", message: "Name is required." },
        website: { code: "REQUIRED", message: "x" },
        email: { code: "WHATEVER", message: "x" },
        topic: { code: "INVALID_TOPIC", message: 42 },
        message: "nope",
      },
      {},
    );
    const failure = expectError(state, "VALIDATION_FAILED");
    expect(failure.fieldErrors).toEqual({ name: "Name is required." });
  });

  test("toErrorState: RATE_LIMITED without retryAfterSeconds and unknown codes", () => {
    const limited = expectError(toErrorState(appError("RATE_LIMITED", "raw"), {}), "RATE_LIMITED");
    expect(limited.retryAfterSeconds).toBeUndefined();
    expect(limited.message).toBe(CONTACT_MESSAGES.rateLimitedFallback);
    const other = expectError(toErrorState(appError("NOT_FOUND", "raw secret"), {}), "INVALID_INPUT");
    expect(other.message).toBe(CONTACT_MESSAGES.unavailable);
  });

  test("rateLimitedMessage formats minutes and hours", () => {
    expect(rateLimitedMessage(30)).toContain("1 minute.");
    expect(rateLimitedMessage(3600)).toContain("60 minutes.");
    expect(rateLimitedMessage(86_400)).toContain("24 hours.");
  });

  test("echoValues does not split a surrogate pair", () => {
    const name = `${"a".repeat(79)}\u{1F600}`;
    const values = echoValues(parseContactForm(form({ name })));
    expect(values.name).toBe("a".repeat(79));
  });
});
