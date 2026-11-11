import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AddressActionState } from "@/components/molecules/_contracts/address-actions";
import {
  ADDRESS_DELETE_CONFIRM_VALUE,
  ADDRESS_FIELD,
  ADDRESS_MAX_LENGTH,
  initialAddressActionState,
} from "@/components/molecules/_contracts/address-actions";
import { appError, type AppError, type Result } from "@/lib/result";
import {
  ADDRESS_FIELD_MAX,
  AddressStorageError,
  LABEL_MAX,
  MAX_ADDRESSES_PER_SESSION,
  PHONE_MAX,
  createAddressService,
  type AddressService,
} from "@/server/addresses/address-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import {
  createRateLimiter,
  type RateLimiter,
  type RateLimitOk,
  type RateLimitRule,
} from "@/server/security/rate-limiter";
import {
  ACCOUNT_ADDRESSES_PATH,
  ADDRESS_ACTION_FAILED,
  ADDRESS_ID_MAX,
  ADDRESS_MESSAGES,
  CHECKOUT_PATH,
  createAddressActions,
  echoValues,
  fieldErrorState,
  parseAddressForm,
  rateLimitedMessage,
  toAddressInput,
  toErrorState,
  type AddressActionDeps,
} from "./addresses-core";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

const PII = {
  fullName: "Zelda Quartermain",
  phone: "+44 (0)20 7946 0958",
  line1: "742 Evergreen Terrace",
  line2: "Flat 9Q",
  city: "Springfieldton",
  region: "Westshire",
  postalCode: "ZX9 8QW",
} as const;

const VALID: Readonly<Record<string, string>> = {
  label: "Home",
  fullName: PII.fullName,
  phone: PII.phone,
  line1: PII.line1,
  line2: PII.line2,
  city: PII.city,
  region: PII.region,
  postalCode: PII.postalCode,
  country: "gb",
};

type Fields = Record<string, string | Blob>;

function form(fields: Fields): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Distinct valid address `n` (different line1, never a duplicate). */
function nth(n: number, extra: Fields = {}): FormData {
  return form({ ...VALID, line1: `${n} Engine Street`, ...extra });
}

/** Builds FormData the way a browser serialises a multipart form post. */
async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryA9dd31Lk2pQe7xZ0";
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  const request = new Request("http://localhost/account/addresses", {
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

type LogSpy = ReturnType<typeof mock<(...args: unknown[]) => void>>;

interface Harness {
  readonly db: Database;
  readonly service: AddressService;
  readonly limiter: CountingLimiter;
  readonly getOrCreate: ReturnType<typeof mock<() => Promise<string>>>;
  readonly read: ReturnType<typeof mock<() => Promise<string | null>>>;
  readonly revalidatePath: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  readonly logger: { error: LogSpy };
  readonly serviceLogger: { error: LogSpy; warn: LogSpy };
  readonly actions: ReturnType<typeof createAddressActions>;
  readonly session: { current: string | null; next: string };
  readonly clock: { ms: number };
}

function setup(overrides: Partial<AddressActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const getOrCreate = mock(async (): Promise<string> => {
    if (session.current === null) session.current = session.next;
    return session.current;
  });
  const read = mock(async (): Promise<string | null> => session.current);
  const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const serviceLogger = {
    error: mock<(...args: unknown[]) => void>(() => undefined),
    warn: mock<(...args: unknown[]) => void>(() => undefined),
  };
  const service = createAddressService({ db, logger: serviceLogger });
  const limiter = counting(createRateLimiter(db, { now: () => clock.ms }));
  const actions = createAddressActions({
    service,
    limiter,
    getOrCreateSessionId: getOrCreate,
    readSessionId: read,
    revalidatePath,
    now: () => clock.ms,
    logger,
    ...overrides,
  });
  return { db, service, limiter, getOrCreate, read, revalidatePath, logger, serviceLogger, actions, session, clock };
}

type Failure = Extract<NonNullable<AddressActionState>, { ok: false }>;
type Success = Extract<NonNullable<AddressActionState>, { ok: true }>;

function failure(state: AddressActionState): Failure {
  if (state === null || state.ok) throw new Error(`expected failure, got ${JSON.stringify(state)}`);
  return state;
}

function success(state: AddressActionState): Success {
  if (state === null || !state.ok) throw new Error(`expected success, got ${JSON.stringify(state)}`);
  return state;
}

function count(db: Database, sessionId: string = S1): number {
  return (db.query("SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?").get(sessionId) as { n: number }).n;
}

function assertNoPii(calls: readonly unknown[][]): void {
  const text = calls.map((c) => c.map(String).join(" ")).join("\n");
  for (const value of Object.values(PII)) expect(text).not.toContain(value);
  expect(text).not.toContain(S1);
  expect(text).not.toContain(S2);
}

async function seedOne(h: Harness, extra: Fields = {}): Promise<string> {
  const state = success(await h.actions.saveAddress(null, form({ ...VALID, ...extra })));
  if (state.addressId === undefined) throw new Error("missing addressId");
  return state.addressId;
}

// ---------------------------------------------------------------------------

describe("contract", () => {
  test("field names align with the MVP AddressFields names and the service input keys", () => {
    for (const [key, name] of Object.entries(ADDRESS_FIELD)) expect<string>(name).toBe(key);
    expect(initialAddressActionState).toBeNull();
    expect(ADDRESS_DELETE_CONFIRM_VALUE).toBe("yes");
  });

  test("ADDRESS_MAX_LENGTH mirrors the service caps", () => {
    expect(ADDRESS_MAX_LENGTH.label).toBe(LABEL_MAX);
    expect(ADDRESS_MAX_LENGTH.phone).toBe(PHONE_MAX);
    for (const key of ["fullName", "line1", "line2", "city", "region", "postalCode", "country"] as const) {
      expect(ADDRESS_MAX_LENGTH[key]).toBe(ADDRESS_FIELD_MAX);
    }
  });
});

describe("parseAddressForm / echoValues / toAddressInput", () => {
  test("reads only contract fields; File entries count as missing", () => {
    const parsed = parseAddressForm(
      form({ ...VALID, fullName: new Blob(["x"]), email: "a@example.com", sessionId: S2, isDefault: "on", confirm: "yes" }),
    );
    expect(parsed.fields.fullName).toBeUndefined();
    expect(parsed.fields.city).toBe(PII.city);
    expect(parsed.isDefault).toBe("on");
    expect(parsed.confirm).toBe("yes");
    expect(parsed.addressId).toBeUndefined();
    expect(parsed.addressIdMalformed).toBe(false);
    expect(Object.keys(parsed.fields)).not.toContain("email");
  });

  test("addressId: absent/blank = create; File or over-long = malformed; otherwise forwarded verbatim", () => {
    expect(parseAddressForm(form({ addressId: "" })).addressId).toBeUndefined();
    expect(parseAddressForm(form({ addressId: "   " })).addressId).toBeUndefined();
    expect(parseAddressForm(form({ addressId: new Blob(["id"]) })).addressIdMalformed).toBe(true);
    expect(parseAddressForm(form({ addressId: "a".repeat(ADDRESS_ID_MAX + 1) })).addressIdMalformed).toBe(true);
    expect(parseAddressForm(form({ addressId: "a".repeat(ADDRESS_ID_MAX) })).addressId).toBe("a".repeat(ADDRESS_ID_MAX));
  });

  test("echo truncates to caps, keeps typed values (incl. phone), isDefault only when ticked", () => {
    const values = echoValues(
      parseAddressForm(
        form({ ...VALID, label: "L".repeat(500), line1: "x".repeat(5000), phone: "1".repeat(99), isDefault: "on" }),
      ),
    );
    expect(values.label).toHaveLength(LABEL_MAX);
    expect(values.line1).toHaveLength(ADDRESS_FIELD_MAX);
    expect(values.phone).toHaveLength(PHONE_MAX);
    expect(values.fullName).toBe(PII.fullName);
    expect(values.isDefault).toBe("on");
    expect(echoValues(parseAddressForm(form({ isDefault: "no" }))).isDefault).toBeUndefined();
  });

  test("echo truncation never leaves a dangling high surrogate", () => {
    const values = echoValues(parseAddressForm(form({ label: `${"a".repeat(LABEL_MAX - 1)}\u{1F600}` })));
    expect(values.label).toBe("a".repeat(LABEL_MAX - 1));
  });

  test("toAddressInput passes email/line2 as undefined when absent", () => {
    const input = toAddressInput(parseAddressForm(form({ fullName: "A" })));
    expect(Object.keys(input)).toContain("email");
    expect(Object.keys(input)).toContain("line2");
    expect(input.email).toBeUndefined();
    expect(input.line2).toBeUndefined();
  });
});

describe("error mapping", () => {
  test("fieldErrorState keeps only known fields with string messages; details carry codes only", () => {
    const state = failure(
      fieldErrorState(
        {
          fullName: { code: "REQUIRED", message: "Full name is required." },
          email: { code: "REQUIRED", message: "x" },
          city: { code: "lower", message: "y" },
          region: "nope",
        },
        {},
      ),
    );
    expect(state.fieldErrors).toEqual({ fullName: "Full name is required." });
    expect(state.error).toEqual(appError("VALIDATION_FAILED", ADDRESS_MESSAGES.invalid, { fields: { fullName: "REQUIRED" } }));
  });

  test("all TOO_LONG field errors -> TOO_LONG code", () => {
    const state = failure(fieldErrorState({ label: { code: "TOO_LONG", message: "Label must be at most 40 characters." } }, {}));
    expect(state.error.code).toBe("TOO_LONG");
  });

  test("unknown service code -> generic unavailable state, no raw details", () => {
    const state = failure(toErrorState(appError("FORBIDDEN", "secret detail", { sql: "SELECT" }), { city: "x" }));
    expect(state.error).toEqual(appError("INVALID_INPUT", ADDRESS_MESSAGES.unavailable, { reason: "unavailable" }));
    expect(state.values).toEqual({ city: "x" });
  });

  test("rate-limit messages", () => {
    expect(rateLimitedMessage(undefined)).toBe(ADDRESS_MESSAGES.rateLimitedFallback);
    expect(rateLimitedMessage(30)).toContain("1 minute.");
    expect(rateLimitedMessage(600)).toContain("10 minutes.");
    expect(rateLimitedMessage(86_400)).toContain("24 hours.");
  });
});

describe("criterion 1: per-field validation with echoed values, never throws", () => {
  test("empty form: field errors for every required field, values echoed, nothing touched", async () => {
    const h = setup();
    const state = failure(await h.actions.saveAddress(null, new FormData()));
    expect(state.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["city", "country", "fullName", "line1", "postalCode", "region"]);
    expect(state.values).toEqual({});
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(count(h.db)).toBe(0);
  });

  test("bad phone and country: field messages, all typed values echoed", async () => {
    const h = setup();
    const state = failure(await h.actions.saveAddress(null, form({ ...VALID, phone: "call me", country: "Narnia" })));
    expect(state.fieldErrors.phone).toBeString();
    expect(state.fieldErrors.country).toBeString();
    expect(state.values).toMatchObject({ fullName: PII.fullName, phone: "call me", country: "Narnia", line2: PII.line2 });
    expect(state.message).toBe(ADDRESS_MESSAGES.invalid);
    expect(h.limiter.calls).toEqual([]);
  });

  test("label over cap -> TOO_LONG field error", async () => {
    const h = setup();
    const state = failure(await h.actions.saveAddress(null, form({ ...VALID, label: "L".repeat(LABEL_MAX + 1) })));
    expect(state.error.code).toBe("TOO_LONG");
    expect(state.fieldErrors.label).toBe(`Label must be at most ${LABEL_MAX} characters.`);
  });

  test("raw value over 4x its cap -> TOO_LONG on that field, echo truncated", async () => {
    const h = setup();
    const state = failure(await h.actions.saveAddress(null, form({ ...VALID, line1: "x".repeat(ADDRESS_FIELD_MAX * 4 + 1) })));
    expect(state.error.code).toBe("TOO_LONG");
    expect(state.fieldErrors).toEqual({ line1: `Address line 1 must be at most ${ADDRESS_FIELD_MAX} characters.` });
    expect(state.values.line1).toHaveLength(ADDRESS_FIELD_MAX);
  });

  test("hostile forms all settle with a state", async () => {
    const h = setup();
    const hostile: FormData[] = [
      new FormData(),
      form({ fullName: new Blob(["x"]), country: new Blob(["GB"]) }),
      form({ addressId: new Blob(["x"]) }),
      form({ ...VALID, line1: "\u0000​‮" }),
      form({ ...VALID, fullName: "<script>alert(1)</script>" }),
      form({ addressId: "' OR 1=1 --", confirm: "yes" }),
    ];
    for (const fd of hostile) {
      for (const action of [h.actions.saveAddress, h.actions.deleteAddress, h.actions.setDefaultAddress]) {
        const state = await action(null, fd);
        expect(state).not.toBeNull();
      }
    }
  });

  test("markup is stored as typed text", async () => {
    const h = setup();
    await seedOne(h, { fullName: "<b>Ada</b>" });
    expect(h.service.list(S1)[0]?.fullName).toBe("<b>Ada</b>");
  });
});

describe("create / update", () => {
  test("cold visitor: first save creates the session, saves, revalidates both paths", async () => {
    const h = setup();
    const state = success(await h.actions.saveAddress(null, form(VALID)));
    expect(state).toMatchObject({ ok: true, kind: "saved", message: ADDRESS_MESSAGES.created });
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_ADDRESSES_PATH], [CHECKOUT_PATH]]);
    const saved = h.service.list(S1);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: state.addressId, label: "Home", country: "GB", isDefault: true, phone: PII.phone });
  });

  test("forged sessionId / email / isDefault-ish fields are ignored", async () => {
    const h = setup();
    await h.actions.saveAddress(null, form({ ...VALID, sessionId: S2, session_id: S2, email: "x@example.com" }));
    expect(count(h.db, S1)).toBe(1);
    expect(count(h.db, S2)).toBe(0);
  });

  test("prevState is ignored", async () => {
    const h = setup();
    const bogus: AddressActionState = { ok: true, kind: "deleted", message: "x", addressId: "y" };
    expect(success(await h.actions.saveAddress(bogus, form(VALID))).kind).toBe("saved");
  });

  test("update: never creates a session; no cookie -> NOT_FOUND", async () => {
    const h = setup();
    const state = failure(await h.actions.saveAddress(null, form({ ...VALID, addressId: crypto.randomUUID() })));
    expect(state.error).toEqual(appError("NOT_FOUND", "Address not found."));
    expect(state.values.fullName).toBe(PII.fullName);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
  });

  test("update own address -> 'Address updated.'; isDefault checkbox moves the default", async () => {
    const h = setup();
    const a = await seedOne(h);
    h.getOrCreate.mockClear();
    const b = success(await h.actions.saveAddress(null, nth(2))).addressId ?? "";
    const state = success(await h.actions.saveAddress(null, nth(2, { addressId: b, city: "Newtown", isDefault: "on" })));
    expect(state).toEqual({ ok: true, kind: "saved", message: ADDRESS_MESSAGES.updated, addressId: b });
    const list = h.service.list(S1);
    expect(list[0]).toMatchObject({ id: b, city: "Newtown", isDefault: true });
    expect(list.find((x) => x.id === a)?.isDefault).toBe(false);
  });

  test("update of a foreign or unknown id -> NOT_FOUND, foreign row untouched", async () => {
    const h = setup();
    h.session.next = S2;
    const foreign = await seedOne(h);
    h.session.current = S1;
    const state = failure(await h.actions.saveAddress(null, form({ ...VALID, city: "Hijack", addressId: foreign })));
    expect(state.message).toBe("Address not found.");
    expect(h.service.list(S2)[0]?.city).toBe(PII.city);
    const unknown = failure(await h.actions.saveAddress(null, form({ ...VALID, addressId: "no-such-id" })));
    expect(unknown.error.code).toBe("NOT_FOUND");
  });

  test("malformed ids (File, over-long) -> NOT_FOUND without touching session or limiter", async () => {
    const h = setup();
    h.session.current = S1;
    for (const addressId of [new Blob(["x"]), "a".repeat(ADDRESS_ID_MAX + 1)]) {
      const state = failure(await h.actions.saveAddress(null, form({ ...VALID, addressId })));
      expect(state.error.code).toBe("NOT_FOUND");
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
  });
});

describe("criterion 2: LIMIT_REACHED and DUPLICATE", () => {
  test("11th address -> LIMIT_REACHED message, no row", async () => {
    const h = setup();
    for (let i = 1; i <= MAX_ADDRESSES_PER_SESSION; i++) success(await h.actions.saveAddress(null, nth(i)));
    h.revalidatePath.mockClear();
    const state = failure(await h.actions.saveAddress(null, nth(11)));
    expect(state.error).toEqual(appError("LIMIT_REACHED", ADDRESS_MESSAGES.limitReached, { max: MAX_ADDRESSES_PER_SESSION }));
    expect(state.message).toBe("You can save up to 10 addresses. Delete one to add another.");
    expect(state.values.line1).toBe("11 Engine Street");
    expect(count(h.db)).toBe(MAX_ADDRESSES_PER_SESSION);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("duplicate -> 'You already saved this address.'", async () => {
    const h = setup();
    await seedOne(h);
    const state = failure(await h.actions.saveAddress(null, form({ ...VALID, fullName: PII.fullName.toUpperCase(), label: "Other" })));
    expect(state.error).toEqual(appError("DUPLICATE", "You already saved this address."));
    expect(count(h.db)).toBe(1);
  });

  test("concurrent creates cannot overshoot the limit", async () => {
    const h = setup();
    h.session.current = S1;
    const states = await Promise.all(Array.from({ length: 12 }, (_, i) => h.actions.saveAddress(null, nth(i + 1))));
    const ok = states.filter((s) => s !== null && s.ok).length;
    const limited = states.filter((s) => s !== null && !s.ok && s.error.code === "LIMIT_REACHED").length;
    expect(ok).toBe(MAX_ADDRESSES_PER_SESSION);
    expect(limited).toBe(2);
    expect(count(h.db)).toBe(MAX_ADDRESSES_PER_SESSION);
  });
});

describe("criterion 3: delete / set default", () => {
  test("delete requires confirm=yes exactly; nothing touched otherwise", async () => {
    const h = setup();
    const id = await seedOne(h);
    h.read.mockClear();
    const before = h.limiter.calls.length;
    for (const confirm of [undefined, "", "no", "YES", " yes", "true", "on"]) {
      const fields: Fields = { addressId: id };
      if (confirm !== undefined) fields.confirm = confirm;
      const state = failure(await h.actions.deleteAddress(null, form(fields)));
      expect(state.error).toEqual(appError("VALIDATION_FAILED", ADDRESS_MESSAGES.confirmRequired, { reason: "confirm_required" }));
      expect(state.fieldErrors).toEqual({});
    }
    expect(failure(await h.actions.deleteAddress(null, form({ addressId: id, confirm: new Blob(["yes"]) }))).error.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(h.read).not.toHaveBeenCalled();
    expect(h.limiter.calls.length).toBe(before);
    expect(count(h.db)).toBe(1);
  });

  test("delete own address with confirm=yes", async () => {
    const h = setup();
    const id = await seedOne(h);
    h.revalidatePath.mockClear();
    const state = success(await h.actions.deleteAddress(null, form({ addressId: id, confirm: "yes" })));
    expect(state).toEqual({ ok: true, kind: "deleted", message: ADDRESS_MESSAGES.deleted, addressId: id });
    expect(count(h.db)).toBe(0);
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_ADDRESSES_PATH], [CHECKOUT_PATH]]);
  });

  test("delete: missing/malformed/foreign id or no session -> NOT_FOUND; never creates a session", async () => {
    const h = setup();
    h.session.next = S2;
    const foreign = await seedOne(h);
    h.getOrCreate.mockClear();
    h.session.current = null;
    expect(failure(await h.actions.deleteAddress(null, form({ addressId: foreign, confirm: "yes" }))).error.code).toBe("NOT_FOUND");
    h.session.current = S1;
    const cases: Fields[] = [
      { confirm: "yes" },
      { addressId: "", confirm: "yes" },
      { addressId: new Blob(["x"]), confirm: "yes" },
      { addressId: foreign, confirm: "yes" },
      { addressId: "x".repeat(65), confirm: "yes" },
    ];
    for (const fields of cases) {
      const state = failure(await h.actions.deleteAddress(null, form(fields)));
      expect(state.error).toEqual(appError("NOT_FOUND", "Address not found."));
    }
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(count(h.db, S2)).toBe(1);
  });

  test("setDefault own address; foreign / no session -> NOT_FOUND", async () => {
    const h = setup();
    await seedOne(h);
    const b = success(await h.actions.saveAddress(null, nth(2))).addressId ?? "";
    h.revalidatePath.mockClear();
    const state = success(await h.actions.setDefaultAddress(null, form({ addressId: b })));
    expect(state).toEqual({ ok: true, kind: "default_set", message: ADDRESS_MESSAGES.defaultSet, addressId: b });
    expect(h.service.getDefault(S1)?.id).toBe(b);
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_ADDRESSES_PATH], [CHECKOUT_PATH]]);

    h.session.current = S2;
    expect(failure(await h.actions.setDefaultAddress(null, form({ addressId: b }))).error.code).toBe("NOT_FOUND");
    h.session.current = null;
    expect(failure(await h.actions.setDefaultAddress(null, form({ addressId: b }))).error.code).toBe("NOT_FOUND");
    expect(failure(await h.actions.setDefaultAddress(null, new FormData())).error.code).toBe("NOT_FOUND");
    expect(h.getOrCreate).toHaveBeenCalledTimes(2);
  });
});

describe("criterion 4: rate limit 20/day/session before the service", () => {
  test("21st write in a day -> RATE_LIMITED with retryAfterSeconds; next day allowed", async () => {
    const h = setup();
    const id = await seedOne(h);
    for (let i = 0; i < 19; i++) success(await h.actions.setDefaultAddress(null, form({ addressId: id })));
    const state = failure(await h.actions.saveAddress(null, nth(2)));
    expect(state.error.code).toBe("RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    expect(state.message).toBe(rateLimitedMessage(state.retryAfterSeconds));
    expect(state.values.line1).toBe("2 Engine Street");
    expect(count(h.db)).toBe(1);
    expect(failure(await h.actions.deleteAddress(null, form({ addressId: id, confirm: "yes" }))).error.code).toBe("RATE_LIMITED");
    expect(count(h.db)).toBe(1);
    // Another session is unaffected (no global backstop for address.write).
    h.session.current = S2;
    success(await h.actions.saveAddress(null, nth(3)));
    h.session.current = S1;
    h.clock.ms += 86_400_000;
    success(await h.actions.saveAddress(null, nth(2)));
  });

  test("limiter keyed address.write:<session> and the service is never called when limited", async () => {
    const denied: RateLimiter = {
      check: () => ({ ok: false, error: appError("RATE_LIMITED", "raw", { retryAfterSeconds: 120 }) }),
    };
    const calls: string[] = [];
    const service: AddressService = new Proxy({} as AddressService, {
      get: (_t, prop) => () => {
        calls.push(String(prop));
        throw new Error("service must not be called");
      },
    });
    const h = setup({ limiter: denied, service });
    h.session.current = S1;
    for (const state of [
      await h.actions.saveAddress(null, form(VALID)),
      await h.actions.saveAddress(null, form({ ...VALID, addressId: "abc" })),
      await h.actions.deleteAddress(null, form({ addressId: "abc", confirm: "yes" })),
      await h.actions.setDefaultAddress(null, form({ addressId: "abc" })),
    ]) {
      const f = failure(state);
      expect(f.error).toEqual(appError("RATE_LIMITED", rateLimitedMessage(120), { retryAfterSeconds: 120 }));
      expect(f.retryAfterSeconds).toBe(120);
    }
    expect(calls).toEqual([]);

    const real = setup();
    await seedOne(real);
    expect(real.limiter.calls).toEqual([`address.write:${S1}`]);
  });
});

describe("criterion 5: no PII in logs; storage failures settle generically", () => {
  test("AddressStorageError on create/update/delete/setDefault -> generic state, one code-only log line", async () => {
    const h = setup();
    const a = await seedOne(h);
    const b = success(await h.actions.saveAddress(null, nth(2))).addressId ?? "";
    h.revalidatePath.mockClear();
    h.db.run(`CREATE TRIGGER fail_i BEFORE INSERT ON addresses BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    h.db.run(`CREATE TRIGGER fail_u BEFORE UPDATE ON addresses BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    h.db.run(`CREATE TRIGGER fail_d BEFORE DELETE ON addresses BEGIN SELECT RAISE(ABORT, 'blocked'); END`);

    const save = failure(await h.actions.saveAddress(null, nth(3)));
    expect(save.error).toEqual(appError("INVALID_INPUT", ADDRESS_MESSAGES.unavailable, { reason: "unavailable" }));
    expect(save.values.fullName).toBe(PII.fullName);
    failure(await h.actions.saveAddress(null, form({ ...VALID, addressId: a, city: "Elsewhere" })));
    failure(await h.actions.deleteAddress(null, form({ addressId: a, confirm: "yes" })));
    failure(await h.actions.setDefaultAddress(null, form({ addressId: b })));

    expect(h.logger.error).toHaveBeenCalledTimes(4);
    const lines = h.logger.error.mock.calls.map((c) => {
      expect(c).toHaveLength(1);
      return String(c[0]);
    });
    expect(lines[0]).toMatch(/^\[addresses\] ADDRESS_ACTION_FAILED action=save code=SQLITE_[A-Z_]+$/);
    expect(lines[2]).toMatch(/action=delete code=SQLITE_/);
    expect(lines[3]).toMatch(/action=setDefault code=SQLITE_/);
    assertNoPii(h.logger.error.mock.calls);
    assertNoPii(h.serviceLogger.error.mock.calls);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("a non-storage exception (cookie failure) settles and logs code=UNEXPECTED only", async () => {
    const h = setup({
      getOrCreateSessionId: async () => {
        throw new Error(`cookie store failed for ${PII.fullName}`);
      },
      readSessionId: async () => {
        throw new Error(`read failed ${S1}`);
      },
    });
    expect(failure(await h.actions.saveAddress(null, form(VALID))).error.code).toBe("INVALID_INPUT");
    expect(failure(await h.actions.setDefaultAddress(null, form({ addressId: "x" }))).error.code).toBe("INVALID_INPUT");
    expect(failure(await h.actions.deleteAddress(null, form({ addressId: "x", confirm: "yes" }))).error.code).toBe(
      "INVALID_INPUT",
    );
    expect(h.logger.error.mock.calls.map((c) => String(c[0]))).toEqual([
      `[addresses] ${ADDRESS_ACTION_FAILED} action=save code=UNEXPECTED`,
      `[addresses] ${ADDRESS_ACTION_FAILED} action=setDefault code=UNEXPECTED`,
      `[addresses] ${ADDRESS_ACTION_FAILED} action=delete code=UNEXPECTED`,
    ]);
  });

  test("a storage error with a non-code-shaped code is logged as UNEXPECTED", async () => {
    const throwing = new Proxy({} as AddressService, {
      get: () => () => {
        throw new AddressStorageError("create", "bad code with spaces");
      },
    });
    const h = setup({ service: throwing });
    failure(await h.actions.saveAddress(null, form(VALID)));
    expect(String(h.logger.error.mock.calls[0]?.[0])).toBe(`[addresses] ${ADDRESS_ACTION_FAILED} action=save code=UNEXPECTED`);
  });

  test("expected failures and successes log nothing", async () => {
    const h = setup();
    const id = await seedOne(h);
    await h.actions.saveAddress(null, form({ ...VALID }));
    await h.actions.saveAddress(null, form({ ...VALID, phone: "nope" }));
    await h.actions.deleteAddress(null, form({ addressId: id }));
    await h.actions.setDefaultAddress(null, form({ addressId: "nope" }));
    await h.actions.deleteAddress(null, form({ addressId: id, confirm: "yes" }));
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.serviceLogger.error).not.toHaveBeenCalled();
  });

  test("states are JSON-serializable and success states carry no address values", async () => {
    const h = setup();
    const ok = success(await h.actions.saveAddress(null, form(VALID)));
    const text = JSON.stringify(ok);
    for (const value of Object.values(PII)) expect(text).not.toContain(value);
    const bad = await h.actions.saveAddress(null, form({ ...VALID, country: "??" }));
    expect(JSON.parse(JSON.stringify(bad))).toEqual(bad);
  });
});

describe("multipart FormData (no-JS replay)", () => {
  test("browser multipart post creates the address; Next $ACTION fields ignored", async () => {
    const h = setup();
    const fd = await browserMultipart([
      ["$ACTION_ID_abc123", ""],
      ...Object.entries(VALID),
      [ADDRESS_FIELD.addressId, ""],
      [ADDRESS_FIELD.isDefault, "on"],
    ]);
    const state = success(await h.actions.saveAddress(null, fd));
    expect(state.kind).toBe("saved");
    expect(h.service.list(S1)[0]).toMatchObject({ fullName: PII.fullName, isDefault: true });

    const del = await browserMultipart([
      [ADDRESS_FIELD.addressId, state.addressId ?? ""],
      [ADDRESS_FIELD.confirm, "yes"],
    ]);
    expect(success(await h.actions.deleteAddress(null, del)).kind).toBe("deleted");
  });
});
