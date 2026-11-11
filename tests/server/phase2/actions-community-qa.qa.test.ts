import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA-W2-T46-T47 (part 2 of 2): Q&A server actions (T47).
//
// Part A drives `createQaActions` (questions-core) with the REAL Q&A service
// + REAL T31 limiter over in-memory SQLite and recording fakes, so call ORDER
// can be asserted. Part B drives the `'use server'` wrappers with
// `next/headers` + `next/cache` mocked and a REAL signed-in user (fast hasher,
// real `sf_auth` token in the mocked cookie store).
// No test touches ./data.
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
type QaActionState = import("@/components/molecules/_contracts/qa-actions").QaActionState;
type QaVoteActionState = import("@/components/molecules/_contracts/qa-actions").QaVoteActionState;
const core = await import("@/app/actions/questions-core");
const { createQaActions, QA_MESSAGES } = core;
type QaActionDeps = import("@/app/actions/questions-core").QaActionDeps;
const { createQaService } = await import("@/server/qa/qa-service");
type QaService = import("@/server/qa/qa-service").QaService;
const { createRateLimiter, limitAction } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME, AUTH_COOKIE_NAME } = await import("@/server/session/session");
const { createAuthService } = await import("@/server/auth/auth-service");

const ROOT = join(import.meta.dir, "..", "..", "..");
const wired = await import("@/app/actions/questions");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const PIN = "prod_enamel-pin-set";
const PIN_SLUG = "enamel-pin-set";
const SEED_Q = "q_seed_002_01"; // on PIN, by seed_session_10
const SEED_A = "a_seed_003_01_01"; // community answer (is_store 0)
const SECRET = "qa-secret-pii-jane@example.com";
const Q_TEXT = "Does the pin set come with locking backs?";

type Entry = readonly [string, string | Blob];

function fd(entries: readonly Entry[]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

function askForm(body: string = Q_TEXT, extra: readonly Entry[] = [], productId: string = PIN): FormData {
  return fd([["productId", productId], ["productSlug", PIN_SLUG], ["body", body], ["displayName", "Guest Gus"], ...extra]);
}

function answerForm(body = "Yes, rubber clutches.", extra: readonly Entry[] = [], questionId: string = SEED_Q): FormData {
  return fd([["questionId", questionId], ["productSlug", PIN_SLUG], ["body", body], ["displayName", "Guest Gus"], ...extra]);
}

function spyFormData(entries: readonly Entry[]): { form: FormData; reads: string[] } {
  const target = fd(entries);
  const reads: string[] = [];
  const form = new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        reads.push(`${String(prop)}:${args.map(String).join(",")}`);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { form, reads };
}

async function browserMultipart(fields: readonly (readonly [string, string])[], boundary: string): Promise<FormData> {
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  return new Request(`http://localhost:3000/products/${PIN_SLUG}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, origin: "http://localhost:3000" },
    body,
  }).formData();
}

interface QRow {
  id: string;
  product_id: string;
  session_id: string;
  display_name: string;
  body: string;
  helpful_count: number;
  status: string;
}
interface ARow {
  id: string;
  question_id: string;
  session_id: string;
  display_name: string;
  body: string;
  is_store: number;
  helpful_count: number;
  status: string;
}

function newQuestions(db: Database): QRow[] {
  return db.query("SELECT id, product_id, session_id, display_name, body, helpful_count, status FROM questions WHERE id NOT LIKE 'q_seed_%' ORDER BY rowid").all() as QRow[];
}
function newAnswers(db: Database): ARow[] {
  return db.query("SELECT id, question_id, session_id, display_name, body, is_store, helpful_count, status FROM answers WHERE id NOT LIKE 'a_seed_%' ORDER BY rowid").all() as ARow[];
}
function helpful(db: Database, table: "questions" | "answers", id: string): number {
  return (db.query(`SELECT helpful_count AS c FROM ${table} WHERE id = ?`).get(id) as { c: number } | null)?.c ?? -1;
}
function productIds(db: Database, n: number): string[] {
  return (db.query("SELECT id FROM products ORDER BY id LIMIT ?").all(n) as { id: string }[]).map((r) => r.id);
}

type PostErr = Extract<NonNullable<QaActionState>, { ok: false }>;
type VoteErr = Extract<NonNullable<QaVoteActionState>, { ok: false }>;

function errOf(state: QaActionState): PostErr {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  expect(state.message).toBe(state.error.message);
  return state;
}
function voteErrOf(state: QaVoteActionState): VoteErr {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  expect(state.message).toBe(state.error.message);
  return state;
}

interface Harness {
  db: Database;
  calls: string[];
  session: { current: string | null; next: string; minted: number };
  user: { current: { displayName: string } | null };
  clock: { ms: number };
  revalidate: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  logger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  limiter: RateLimiter;
  actions: ReturnType<typeof createQaActions>;
}

function setup(overrides: Partial<QaActionDeps> = {}, db?: Database): Harness {
  const database = db ?? createDatabase(":memory:");
  if (db === undefined) {
    runMigrations(database);
    seedDatabase(database);
  }
  const calls: string[] = [];
  const session = { current: null as string | null, next: S1, minted: 0 };
  const user = { current: null as { displayName: string } | null };
  const clock = { ms: T0 };
  const real = createQaService({ db: database, now: () => clock.ms });
  const service: QaService = {
    ...real,
    ask: (s, input, now) => {
      calls.push("service.ask");
      return real.ask(s, input, now);
    },
    answer: (s, input, now) => {
      calls.push("service.answer");
      return real.answer(s, input, now);
    },
    voteQuestion: (s, id) => {
      calls.push("service.voteQuestion");
      return real.voteQuestion(s, id);
    },
    voteAnswer: (s, id) => {
      calls.push("service.voteAnswer");
      return real.voteAnswer(s, id);
    },
  };
  const realLimiter = createRateLimiter(database, { now: () => clock.ms });
  const limiter: RateLimiter = {
    check: (key, rule) => {
      calls.push(`limiter:${key.replace(/:[0-9a-f-]{36}$/, ":<sid>")}`);
      return realLimiter.check(key, rule);
    },
  };
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>((path) => {
    calls.push(`revalidate:${path}`);
  });
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const deps: QaActionDeps = {
    service,
    limiter,
    getOrCreateSessionId: async () => {
      calls.push("getOrCreateSessionId");
      if (session.current === null) {
        session.current = session.next;
        session.minted += 1;
      }
      return session.current;
    },
    readCurrentUser: async () => {
      calls.push("readCurrentUser");
      return user.current;
    },
    revalidatePath: revalidate,
    now: () => clock.ms,
    logger,
    ...overrides,
  };
  return { db: database, calls, session, user, clock, revalidate, logger, limiter: realLimiter, actions: createQaActions(deps) };
}

function untouched(h: Harness): void {
  expect(h.calls.filter((c) => c === "getOrCreateSessionId" || c.startsWith("limiter:") || c.startsWith("service."))).toEqual([]);
  expect(h.session.minted).toBe(0);
  expect(h.revalidate).not.toHaveBeenCalled();
  expect(newQuestions(h.db)).toEqual([]);
  expect(newAnswers(h.db)).toEqual([]);
}

// ---------------------------------------------------------------------------
// Part A: core
// ---------------------------------------------------------------------------

describe("QA T47 order of steps", () => {
  test("ask: readCurrentUser -> session -> limiter (session, global) -> service -> revalidate", async () => {
    const h = setup();
    expect(await h.actions.askQuestion(null, askForm())).toMatchObject({ ok: true, kind: "asked", message: QA_MESSAGES.asked });
    expect(h.calls).toEqual([
      "readCurrentUser",
      "getOrCreateSessionId",
      "limiter:question.ask:<sid>",
      "limiter:question.ask:*",
      "service.ask",
      `revalidate:/products/${PIN_SLUG}`,
    ]);
  });

  test("answer: same order with answer.post", async () => {
    const h = setup();
    expect(await h.actions.answerQuestion(null, answerForm())).toMatchObject({ ok: true, kind: "answered" });
    expect(h.calls).toEqual([
      "readCurrentUser",
      "getOrCreateSessionId",
      "limiter:answer.post:<sid>",
      "limiter:answer.post:*",
      "service.answer",
      `revalidate:/products/${PIN_SLUG}`,
    ]);
  });

  test("votes: session -> vote limiter -> service -> revalidate", async () => {
    const h = setup();
    await h.actions.voteQuestion(null, fd([["questionId", SEED_Q], ["productSlug", PIN_SLUG]]));
    await h.actions.voteAnswer(null, fd([["answerId", SEED_A], ["productSlug", PIN_SLUG]]));
    expect(h.calls).toEqual([
      "getOrCreateSessionId",
      "limiter:vote:<sid>",
      "limiter:vote:*",
      "service.voteQuestion",
      `revalidate:/products/${PIN_SLUG}`,
      "getOrCreateSessionId",
      "limiter:vote:<sid>",
      "limiter:vote:*",
      "service.voteAnswer",
      `revalidate:/products/${PIN_SLUG}`,
    ]);
  });
});

describe("QA T47 criterion 1: invalid ids / text -> field errors, TOO_LONG, no throw, no side effects", () => {
  test("missing/blank/oversize/File ids -> INVALID_INPUT details.field", async () => {
    const cases: readonly (readonly ["ask" | "answer" | "voteQuestion" | "voteAnswer", string])[] = [
      ["ask", "productId"],
      ["answer", "questionId"],
      ["voteQuestion", "questionId"],
      ["voteAnswer", "answerId"],
    ];
    for (const [action, field] of cases) {
      for (const bad of [undefined, "", "   ", "x".repeat(201), "x".repeat(1_000_000), new Blob(["id"])]) {
        const h = setup();
        const entries: Entry[] = [["body", Q_TEXT]];
        if (bad !== undefined) entries.push([field, bad]);
        const form = fd(entries);
        const state =
          action === "ask"
            ? await h.actions.askQuestion(null, form)
            : action === "answer"
              ? await h.actions.answerQuestion(null, form)
              : action === "voteQuestion"
                ? await h.actions.voteQuestion(null, form)
                : await h.actions.voteAnswer(null, form);
        if (state === null || state.ok) throw new Error(`${action}: expected error`);
        expect(state.error).toEqual({ code: "INVALID_INPUT", message: QA_MESSAGES.invalidRequest, details: { field } });
        untouched(h);
      }
    }
  });

  test("question too short / blank / single-line rules -> VALIDATION_FAILED fieldErrors.body", async () => {
    for (const body of ["", "   ", "short?", "​​​​​​​​​​​"]) {
      const h = setup();
      const err = errOf(await h.actions.askQuestion(null, askForm(body)));
      expect(err.error.code).toBe("VALIDATION_FAILED");
      expect(err.error.details).toEqual({ field: "body" });
      expect(typeof err.fieldErrors.body).toBe("string");
      untouched(h);
    }
  });

  test("oversize -> TOO_LONG: question 301, answer 1001, name 51, and 1 MB bodies", async () => {
    const h = setup();
    const a = errOf(await h.actions.askQuestion(null, askForm("q".repeat(301))));
    expect(a.error).toMatchObject({ code: "TOO_LONG", details: { field: "body" } });
    const b = errOf(await h.actions.answerQuestion(null, answerForm("a".repeat(1001))));
    expect(b.error.code).toBe("TOO_LONG");
    untouched(h);
    const h2 = setup();
    const f = askForm();
    f.set("displayName", "n".repeat(51));
    const d = errOf(await h2.actions.askQuestion(null, f));
    expect(d.error).toMatchObject({ code: "TOO_LONG", details: { field: "displayName" } });
    const h3 = setup();
    const e = errOf(await h3.actions.answerQuestion(null, answerForm("a".repeat(1_000_000))));
    expect(e.error.code).toBe("TOO_LONG");
    expect(e.values.body).toBe("a".repeat(1000));
    untouched(h2);
    untouched(h3);
  });

  test("both body and name bad -> generic 'fix fields' headline, both fieldErrors", async () => {
    const h = setup();
    const f = askForm("x");
    f.set("displayName", "n".repeat(60));
    const err = errOf(await h.actions.askQuestion(null, f));
    expect(err.message).toBe(QA_MESSAGES.fixFields);
    expect(Object.keys(err.fieldErrors).sort()).toEqual(["body", "displayName"]);
    untouched(h);
  });

  test("3 links -> VALIDATION_FAILED reason TOO_MANY_URLS, nothing spent", async () => {
    const h = setup();
    const err = errOf(await h.actions.answerQuestion(null, answerForm("https://a.example https://b.example https://c.example")));
    expect(err.error).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "body", reason: "TOO_MANY_URLS" } });
    untouched(h);
  });

  test("field error messages never echo submitted text", async () => {
    const h = setup();
    const err = errOf(await h.actions.askQuestion(null, askForm(`${SECRET} `.repeat(30))));
    expect(err.message).not.toContain(SECRET);
    expect(JSON.stringify(err.fieldErrors)).not.toContain(SECRET);
    expect(JSON.stringify(err.error)).not.toContain(SECRET);
  });

  test("unknown product / question -> PRODUCT_NOT_FOUND / NOT_FOUND; unknown vote targets -> NOT_FOUND", async () => {
    const h = setup();
    expect(errOf(await h.actions.askQuestion(null, askForm(Q_TEXT, [], "prod_nope"))).error).toEqual({ code: "PRODUCT_NOT_FOUND", message: QA_MESSAGES.productNotFound });
    expect(errOf(await h.actions.answerQuestion(null, answerForm("Yes", [], "q_nope"))).error).toEqual({ code: "NOT_FOUND", message: QA_MESSAGES.questionNotFound });
    expect(voteErrOf(await h.actions.voteQuestion(null, fd([["questionId", "q_nope"]]))).error).toEqual({ code: "NOT_FOUND", message: QA_MESSAGES.questionNotFound });
    expect(voteErrOf(await h.actions.voteAnswer(null, fd([["answerId", "a_nope"]]))).error).toEqual({ code: "NOT_FOUND", message: QA_MESSAGES.answerNotFound });
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("hidden question: answer + vote -> NOT_FOUND", async () => {
    const h = setup();
    h.db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(SEED_Q);
    expect(errOf(await h.actions.answerQuestion(null, answerForm())).error.code).toBe("NOT_FOUND");
    expect(voteErrOf(await h.actions.voteQuestion(null, fd([["questionId", SEED_Q]]))).error.code).toBe("NOT_FOUND");
  });
});

describe("QA T47 criterion 2: rate limits", () => {
  test("6th question in an hour: RATE_LIMITED + retryAfterSeconds, service not called, values echoed", async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) expect((await h.actions.askQuestion(null, askForm(`${Q_TEXT} variant ${i}`)))?.ok).toBe(true);
    h.calls.length = 0;
    h.revalidate.mockClear();
    const err = errOf(await h.actions.askQuestion(null, askForm(`${Q_TEXT} variant 6`)));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.message).toMatch(/^Too many requests\. Please try again in \d+ minutes?\.$/);
    expect(err.values).toEqual({ body: `${Q_TEXT} variant 6`, displayName: "Guest Gus" });
    expect(h.calls).not.toContain("service.ask");
    expect(h.revalidate).not.toHaveBeenCalled();
    expect(newQuestions(h.db)).toHaveLength(5);
    h.clock.ms += HOUR_MS;
    expect((await h.actions.askQuestion(null, askForm(`${Q_TEXT} variant 7`)))?.ok).toBe(true);
  });

  test("11th answer in an hour: RATE_LIMITED, service not called", async () => {
    const h = setup();
    const qs = (h.db.query("SELECT id FROM questions ORDER BY id LIMIT 4").all() as { id: string }[]).map((r) => r.id);
    let n = 0;
    for (const q of qs) {
      for (let i = 0; i < 3 && n < 10; i++, n++) {
        expect((await h.actions.answerQuestion(null, answerForm(`Answer ${n}`, [], q)))?.ok).toBe(true);
      }
    }
    h.calls.length = 0;
    const err = errOf(await h.actions.answerQuestion(null, answerForm("Answer 11", [], qs[3])));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.calls).not.toContain("service.answer");
    expect(newAnswers(h.db)).toHaveLength(10);
  });

  test("61st vote in an hour across question+answer votes: RATE_LIMITED, service not called", async () => {
    const h = setup();
    for (let i = 0; i < 30; i++) await h.actions.voteQuestion(null, fd([["questionId", `q_x${i}`]]));
    for (let i = 0; i < 30; i++) await h.actions.voteAnswer(null, fd([["answerId", `a_x${i}`]]));
    h.calls.length = 0;
    const before = helpful(h.db, "questions", SEED_Q);
    const err = voteErrOf(await h.actions.voteQuestion(null, fd([["questionId", SEED_Q]])));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.calls).not.toContain("service.voteQuestion");
    expect(helpful(h.db, "questions", SEED_Q)).toBe(before);
    const err2 = voteErrOf(await h.actions.voteAnswer(null, fd([["answerId", SEED_A]])));
    expect(err2.error.code).toBe("RATE_LIMITED");
  });

  test("invalid ask/answer do not spend budget (20 invalid then 5 valid asks succeed)", async () => {
    const h = setup();
    for (let i = 0; i < 20; i++) await h.actions.askQuestion(null, askForm("tiny"));
    for (let i = 0; i < 20; i++) await h.actions.answerQuestion(null, answerForm("a".repeat(2000)));
    for (let i = 0; i < 5; i++) expect((await h.actions.askQuestion(null, askForm(`${Q_TEXT} #${i}`)))?.ok).toBe(true);
  });

  test("global backstop question.ask (300/h): 60 sessions x 5 real asks, then a fresh session is blocked before the service", async () => {
    const h = setup();
    const products = productIds(h.db, 5);
    for (let s = 0; s < 60; s++) {
      h.session.current = `${String(s).padStart(8, "0")}-0000-4000-8000-000000000000`;
      for (const p of products) {
        const state = await h.actions.askQuestion(null, askForm(Q_TEXT, [], p));
        if (state === null || !state.ok) throw new Error(`unexpected at ${s}: ${JSON.stringify(state)}`);
      }
    }
    h.session.current = S3;
    h.calls.length = 0;
    const err = errOf(await h.actions.askQuestion(null, askForm()));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(h.calls).toEqual(["readCurrentUser", "getOrCreateSessionId", "limiter:question.ask:<sid>", "limiter:question.ask:*"]);
    expect(newQuestions(h.db)).toHaveLength(300);
  });

  test("global backstops answer.post (300/h) and vote (3000/h) trip for a fresh owner key", async () => {
    const h = setup();
    for (let i = 0; i < 300; i++) limitAction(h.limiter, "answer.post", `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    for (let i = 0; i < 3000; i++) limitAction(h.limiter, "vote", `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    h.session.current = S3;
    h.calls.length = 0;
    expect(errOf(await h.actions.answerQuestion(null, answerForm())).error.code).toBe("RATE_LIMITED");
    expect(voteErrOf(await h.actions.voteQuestion(null, fd([["questionId", SEED_Q]]))).error.code).toBe("RATE_LIMITED");
    expect(voteErrOf(await h.actions.voteAnswer(null, fd([["answerId", SEED_A]]))).error.code).toBe("RATE_LIMITED");
    expect(h.calls.filter((c) => c.startsWith("service."))).toEqual([]);
  });

  test("limiter error without retryAfterSeconds -> fallback message and no retryAfterSeconds key", async () => {
    const h = setup({ limiter: { check: () => ({ ok: false, error: { code: "RATE_LIMITED", message: SECRET } }) } });
    const a = errOf(await h.actions.askQuestion(null, askForm()));
    expect(a.message).toBe(QA_MESSAGES.rateLimitedFallback);
    expect("retryAfterSeconds" in a).toBe(false);
    const v = voteErrOf(await h.actions.voteAnswer(null, fd([["answerId", SEED_A]])));
    expect(v.message).toBe(QA_MESSAGES.rateLimitedFallback);
    expect(JSON.stringify([a, v])).not.toContain(SECRET);
  });
});

describe("QA T47 criterion 3: client cannot set isStore / status / counts", () => {
  test("ask/answer read only contract fields; stored rows are server-derived", async () => {
    const h = setup();
    const forged: Entry[] = [
      ["isStore", "true"],
      ["is_store", "1"],
      ["status", "hidden"],
      ["helpfulCount", "999"],
      ["helpful_count", "999"],
      ["sessionId", S2],
      ["session_id", S2],
      ["id", "forged-id"],
    ];
    const ask = spyFormData([["productId", PIN], ["productSlug", PIN_SLUG], ["body", Q_TEXT], ["displayName", "Gus"], ...forged]);
    const askState = await h.actions.askQuestion(null, ask.form);
    expect(askState).toMatchObject({ ok: true });
    const ans = spyFormData([["questionId", SEED_Q], ["body", "Yes they do."], ...forged]);
    expect(await h.actions.answerQuestion(null, ans.form)).toMatchObject({ ok: true });
    const keys = [...ask.reads, ...ans.reads].map((r) => r.split(":")[1]);
    for (const k of ["isStore", "is_store", "status", "helpfulCount", "helpful_count", "sessionId", "session_id", "id"]) expect(keys).not.toContain(k);
    expect([...ask.reads, ...ans.reads].every((r) => r.startsWith("get:"))).toBe(true);
    expect(newQuestions(h.db)[0]).toMatchObject({ session_id: S1, status: "published", helpful_count: 0 });
    expect(newQuestions(h.db)[0]?.id).not.toBe("forged-id");
    expect(newAnswers(h.db)[0]).toMatchObject({ session_id: S1, is_store: 0, status: "published", helpful_count: 0 });
  });

  test("votes read only the id + productSlug", async () => {
    const h = setup();
    const v = spyFormData([["questionId", SEED_Q], ["helpfulCount", "50"], ["sessionId", "seed_session_10"]]);
    await h.actions.voteQuestion(null, v.form);
    expect(v.reads.map((r) => r.split(":")[1]).sort()).toEqual(["productSlug", "questionId"]);
  });
});

describe("QA T47 criterion 4: duplicate question / own-content vote typed errors", () => {
  test("duplicate question (same owner, same product, same cleaned text) -> DUPLICATE in fieldErrors.body", async () => {
    const h = setup();
    expect((await h.actions.askQuestion(null, askForm()))?.ok).toBe(true);
    h.revalidate.mockClear();
    const err = errOf(await h.actions.askQuestion(null, askForm(`  ${Q_TEXT}  `)));
    expect(err.error).toEqual({ code: "DUPLICATE", message: QA_MESSAGES.duplicateQuestion, details: { field: "body" } });
    expect(err.fieldErrors).toEqual({ body: QA_MESSAGES.duplicateQuestion });
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("duplicate rule per owner key: guest S1 and signed-in S2 may ask the same question", async () => {
    const h = setup();
    expect((await h.actions.askQuestion(null, askForm()))?.ok).toBe(true);
    h.session.current = S2;
    h.user.current = { displayName: "Account Ada" };
    expect((await h.actions.askQuestion(null, askForm()))?.ok).toBe(true);
    expect(errOf(await h.actions.askQuestion(null, askForm())).error.code).toBe("DUPLICATE");
    expect(newQuestions(h.db).map((q) => [q.session_id, q.display_name]).sort()).toEqual([
      [S1, "Guest Gus"],
      [S2, "Account Ada"],
    ]);
  });

  test("own question / own answer vote -> FORBIDDEN; repeat vote -> DUPLICATE; counts once", async () => {
    const h = setup();
    const q = await h.actions.askQuestion(null, askForm());
    const a = await h.actions.answerQuestion(null, answerForm());
    if (q === null || !q.ok || a === null || !a.ok) throw new Error("setup");
    expect(voteErrOf(await h.actions.voteQuestion(null, fd([["questionId", q.id]]))).error).toEqual({ code: "FORBIDDEN", message: QA_MESSAGES.forbiddenVote });
    expect(voteErrOf(await h.actions.voteAnswer(null, fd([["answerId", a.id]]))).error).toEqual({ code: "FORBIDDEN", message: QA_MESSAGES.forbiddenVote });
    const before = helpful(h.db, "answers", SEED_A);
    expect(await h.actions.voteAnswer(null, fd([["answerId", SEED_A]]))).toEqual({ ok: true, helpfulCount: before + 1, message: QA_MESSAGES.voted });
    expect(voteErrOf(await h.actions.voteAnswer(null, fd([["answerId", SEED_A]]))).error).toEqual({ code: "DUPLICATE", message: QA_MESSAGES.duplicateVote });
    expect(helpful(h.db, "answers", SEED_A)).toBe(before + 1);
  });

  test("4th answer on one question -> LIMIT_REACHED with details.limit 3", async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) expect((await h.actions.answerQuestion(null, answerForm(`Answer ${i}`)))?.ok).toBe(true);
    const err = errOf(await h.actions.answerQuestion(null, answerForm("Answer 4")));
    expect(err.error).toEqual({ code: "LIMIT_REACHED", message: QA_MESSAGES.limitReached, details: { limit: 3 } });
  });

  test("concurrent double vote / double ask (same owner key) count once", async () => {
    const h = setup();
    h.session.current = S2;
    const before = helpful(h.db, "questions", SEED_Q);
    const votes = await Promise.all(Array.from({ length: 10 }, () => h.actions.voteQuestion(null, fd([["questionId", SEED_Q]]))));
    expect(votes.filter((v) => v?.ok === true)).toHaveLength(1);
    expect(helpful(h.db, "questions", SEED_Q)).toBe(before + 1);
    const asks = await Promise.all([h.actions.askQuestion(null, askForm()), h.actions.askQuestion(null, askForm())]);
    expect(asks.map((s) => (s === null || s.ok ? "ok" : s.error.code)).sort()).toEqual(["DUPLICATE", "ok"]);
    expect(newQuestions(h.db)).toHaveLength(1);
  });
});

describe("QA T47 criterion 5: session lazy, revalidate PDP only", () => {
  test("first write mints one session; invalid writes mint none", async () => {
    const h = setup();
    await h.actions.askQuestion(null, askForm("no"));
    await h.actions.voteQuestion(null, fd([]));
    expect(h.session.minted).toBe(0);
    await h.actions.voteAnswer(null, fd([["answerId", SEED_A]]));
    expect(h.session.minted).toBe(1);
  });

  test("bad slugs never revalidate; valid slug revalidates only /products/<slug> and only on success", async () => {
    for (const bad of ["", "Enamel", "../x", "a/b", "a b", "x".repeat(101), "pin%2F"]) {
      const h = setup();
      const f = askForm();
      f.set("productSlug", bad);
      expect((await h.actions.askQuestion(null, f))?.ok).toBe(true);
      expect((await h.actions.voteQuestion(null, fd([["questionId", SEED_Q], ["productSlug", bad]])))?.ok).toBe(true);
      expect(h.revalidate).not.toHaveBeenCalled();
    }
    const h = setup();
    await h.actions.answerQuestion(null, answerForm());
    expect(h.revalidate.mock.calls).toEqual([[`/products/${PIN_SLUG}`]]);
    h.revalidate.mockClear();
    await h.actions.voteAnswer(null, fd([["answerId", "a_nope"], ["productSlug", PIN_SLUG]]));
    await h.actions.askQuestion(null, askForm("tiny"));
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});

describe("QA T47 echo values and signed-in name", () => {
  test("echo truncated to 300 (question) / 1000 (answer) / 50 (name), never ids", async () => {
    const h = setup();
    const a = errOf(await h.actions.askQuestion(null, fd([["productId", "prod_secret"], ["body", "Q".repeat(400)], ["displayName", "N".repeat(80)]])));
    expect(a.values).toEqual({ body: "Q".repeat(300), displayName: "N".repeat(50) });
    const b = errOf(await h.actions.answerQuestion(null, fd([["questionId", ""], ["body", "A".repeat(1200)]])));
    expect(b.values).toEqual({ body: "A".repeat(1000) });
    expect(JSON.stringify([a, b])).not.toContain("prod_secret");
    const c = errOf(await h.actions.answerQuestion(null, answerForm("Yes", [], "q_secret_unknown")));
    expect(JSON.stringify(c)).not.toContain("q_secret_unknown");
  });

  test("signed in: account display name stored, posted name ignored (even if oversize), never echoed", async () => {
    const h = setup();
    h.session.current = S2;
    h.user.current = { displayName: "Account Ada" };
    const f = askForm();
    f.set("displayName", "z".repeat(400));
    expect((await h.actions.askQuestion(null, f))?.ok).toBe(true);
    expect((await h.actions.answerQuestion(null, answerForm("Sure.", [["displayName", "Impostor"]])))?.ok).toBe(true);
    expect(newQuestions(h.db)[0]?.display_name).toBe("Account Ada");
    expect(newAnswers(h.db).map((r) => r.display_name)).toContain("Account Ada");
    const err = errOf(await h.actions.askQuestion(null, askForm("tiny", [["displayName", "Impostor"]])));
    expect("displayName" in err.values).toBe(false);
    expect(JSON.stringify(err)).not.toContain("Account Ada");
    expect(JSON.stringify(err)).not.toContain("Impostor");
  });

  test("guest blank name -> 'Anonymous shopper'", async () => {
    const h = setup();
    const f = askForm();
    f.set("displayName", "   ");
    await h.actions.askQuestion(null, f);
    expect(newQuestions(h.db)[0]?.display_name).toBe("Anonymous shopper");
  });
});

describe("QA T47 browser multipart (SR2)", () => {
  test("multipart with $ACTION_* fields: ask, answer (CRLF kept as line break), votes", async () => {
    const h = setup();
    const ask = await browserMultipart(
      [["$ACTION_REF_1", ""], ["$ACTION_1:0", '{"id":"abc","bound":"$@1"}'], ["$ACTION_1:1", "[null]"], ["$ACTION_KEY", "k1"], ["productId", PIN], ["productSlug", PIN_SLUG], ["body", Q_TEXT], ["isStore", "1"]],
      "----WebKitFormBoundaryQaT47",
    );
    expect(await h.actions.askQuestion(null, ask)).toMatchObject({ ok: true, kind: "asked" });
    const ans = await browserMultipart([["$ACTION_ID_x", ""], ["questionId", SEED_Q], ["body", "Line one\r\nLine two"], ["is_store", "1"]], "----geckoformboundaryQaT47");
    expect(await h.actions.answerQuestion(null, ans)).toMatchObject({ ok: true, kind: "answered" });
    expect(newAnswers(h.db)[0]).toMatchObject({ is_store: 0 });
    expect(newAnswers(h.db)[0]?.body).toContain("\n");
    const vq = await browserMultipart([["$ACTION_KEY", "k"], ["questionId", SEED_Q]], "----b1");
    expect(await h.actions.voteQuestion(null, vq)).toMatchObject({ ok: true });
  });
});

describe("QA T47 unexpected failures settle with a PII-free log", () => {
  const throwing = (): never => {
    throw new Error(`boom ${SECRET} ${S1}`);
  };
  function assertClean(h: Harness): void {
    expect(h.logger.error).toHaveBeenCalled();
    for (const call of h.logger.error.mock.calls) {
      expect(call.map(String).join(" ")).toMatch(/^\[qa\] QA_ACTION_FAILED action=(ask|answer|voteQuestion|voteAnswer)$/);
    }
  }

  test("each dependency throwing settles every action with INVALID_INPUT/unavailable", async () => {
    const base = setup();
    const svc = createQaService({ db: base.db });
    const variants: readonly Partial<QaActionDeps>[] = [
      { readCurrentUser: async () => throwing() },
      { getOrCreateSessionId: async () => throwing() },
      { limiter: { check: throwing } },
      { now: throwing },
      { service: { ...svc, ask: throwing, answer: throwing, voteQuestion: throwing, voteAnswer: throwing } },
    ];
    for (const v of variants) {
      const h = setup(v, base.db);
      const states: unknown[] = [
        await h.actions.askQuestion(null, askForm(`${Q_TEXT} ${Math.random()}`)),
        await h.actions.answerQuestion(null, answerForm()),
      ];
      for (const s of states) {
        expect((s as PostErr).error).toEqual({ code: "INVALID_INPUT", message: QA_MESSAGES.unavailable, details: { reason: "unavailable" } });
      }
      if (v.readCurrentUser === undefined && v.now === undefined) {
        for (const s of [await h.actions.voteQuestion(null, fd([["questionId", SEED_Q]])), await h.actions.voteAnswer(null, fd([["answerId", SEED_A]]))]) {
          expect(voteErrOf(s).error).toEqual({ code: "INVALID_INPUT", message: QA_MESSAGES.unavailable, details: { reason: "unavailable" } });
        }
      }
      expect(JSON.stringify(states)).not.toContain(SECRET);
      assertClean(h);
    }
  });

  test("revalidatePath throwing after a stored write still settles", async () => {
    const h = setup({ revalidatePath: throwing });
    const s = await h.actions.askQuestion(null, askForm());
    expect(s).not.toBeNull();
    assertClean(h);
  });

  test("non-Error throws settle", async () => {
    for (const value of [SECRET, undefined, null, { email: SECRET }]) {
      const h = setup({
        getOrCreateSessionId: async () => {
          throw value;
        },
      });
      expect(errOf(await h.actions.askQuestion(null, askForm())).error.code).toBe("INVALID_INPUT");
      expect(voteErrOf(await h.actions.voteAnswer(null, fd([["answerId", SEED_A]]))).error.code).toBe("INVALID_INPUT");
      assertClean(h);
    }
  });

  test("service error with raw message / unknown code never leaks", async () => {
    const base = setup();
    const svc = createQaService({ db: base.db });
    const h = setup(
      {
        service: {
          ...svc,
          ask: () => ({ ok: false, error: { code: "MONEY_OVERFLOW", message: SECRET } }),
          answer: () => ({ ok: false, error: { code: "INVALID_INPUT", message: SECRET, details: { field: SECRET } } }),
          voteQuestion: () => ({ ok: false, error: { code: "VALIDATION_FAILED", message: SECRET } }),
        },
      },
      base.db,
    );
    const states = [
      await h.actions.askQuestion(null, askForm()),
      await h.actions.answerQuestion(null, answerForm()),
      await h.actions.voteQuestion(null, fd([["questionId", SEED_Q]])),
    ];
    expect(JSON.stringify(states)).not.toContain(SECRET);
  });
});

describe("QA T47 JSON round trip", () => {
  test("reachable states are plain JSON", async () => {
    const h = setup();
    const states: unknown[] = [
      await h.actions.askQuestion(null, fd([])),
      await h.actions.askQuestion(null, askForm("x")),
      await h.actions.askQuestion(null, askForm("q".repeat(301))),
      await h.actions.askQuestion(null, askForm()),
      await h.actions.askQuestion(null, askForm()),
      await h.actions.askQuestion(null, askForm(Q_TEXT, [], "prod_none")),
      await h.actions.answerQuestion(null, answerForm("1")),
      await h.actions.answerQuestion(null, answerForm("2")),
      await h.actions.answerQuestion(null, answerForm("3")),
      await h.actions.answerQuestion(null, answerForm("4")),
      await h.actions.voteQuestion(null, fd([["questionId", SEED_Q]])),
      await h.actions.voteQuestion(null, fd([["questionId", SEED_Q]])),
      await h.actions.voteAnswer(null, fd([["answerId", "nope"]])),
    ];
    for (const s of states) expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

// ---------------------------------------------------------------------------
// Part B: 'use server' wrapper
// ---------------------------------------------------------------------------

const fastHasher = {
  hash: async (p: string): Promise<string> => `qa-fast$${p}`,
  verify: async (p: string, hash: string): Promise<boolean> => hash === `qa-fast$${p}`,
};

async function signUpUser(email: string, displayName: string): Promise<string> {
  const auth = createAuthService({ db: getDatabase(), hasher: fastHasher });
  const result = await auth.signUp({ email, password: "correct horse battery qa 9", displayName }, { sessionKey: null });
  if (!result.ok) throw new Error(`signUp failed: ${result.error.code}`);
  return result.value.token;
}

function ownerKeyOf(email: string): string {
  const row = getDatabase().query("SELECT owner_key FROM users WHERE email = ?").get(email) as { owner_key: string } | null;
  if (row === null) throw new Error("no user");
  return row.owner_key;
}

describe("QA T47 'use server' module", () => {
  test("starts with 'use server' and exports exactly four async actions", () => {
    const src = readFileSync(join(ROOT, "src/app/actions/questions.ts"), "utf8");
    expect(src.trimStart().startsWith('"use server";')).toBe(true);
    const exportLines = src.split("\n").filter((l) => /^export\b/.test(l));
    expect(exportLines).toHaveLength(4);
    for (const l of exportLines) expect(l).toMatch(/^export async function (askQuestion|answerQuestion|voteQuestion|voteAnswer)\(/);
    expect(Object.keys(wired).sort()).toEqual(["answerQuestion", "askQuestion", "voteAnswer", "voteQuestion"]);
    for (const v of Object.values(wired)) expect((v as () => unknown).constructor.name).toBe("AsyncFunction");
  });

  test("importing the module in a fresh process opens no database", async () => {
    const probeDb = join(import.meta.dir, `.qa-t47-probe-${process.pid}.sqlite`);
    const script = [
      `const before = globalThis.__storefrontDb;`,
      `await import(${JSON.stringify(join(ROOT, "src/app/actions/questions.ts"))});`,
      `console.log(JSON.stringify({ before: before === undefined, after: globalThis.__storefrontDb === undefined }));`,
    ].join("\n");
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, env: { ...process.env, DATABASE_PATH: probeDb }, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString().trim().split("\n").pop() ?? "")).toEqual({ before: true, after: true });
    expect(await Bun.file(probeDb).exists()).toBe(false);
  });
});

describe("QA T47 wired actions", () => {
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
  beforeEach(() => {
    env.DATABASE_PATH = ":memory:";
    closeDatabase();
    seedDatabase(getDatabase());
    fakeStore = new FakeCookieStore();
    wiredRevalidatePath.mockClear();
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("invalid ids / text: no cookie, no limiter rows, no rows", async () => {
    await wired.askQuestion(null, askForm("tiny"));
    await wired.answerQuestion(null, fd([["body", "x"]]));
    await wired.voteQuestion(null, fd([]));
    await wired.voteAnswer(null, fd([["answerId", ""]]));
    expect(fakeStore.setCalls).toEqual([]);
    expect((getDatabase().query("SELECT count(*) AS c FROM rate_limits").get() as { c: number }).c).toBe(0);
    expect(newQuestions(getDatabase())).toEqual([]);
  });

  test("first guest ask sets one sf_session; row uses it; PDP revalidated", async () => {
    expect(await wired.askQuestion(null, askForm(Q_TEXT, [["sessionId", S2]]))).toMatchObject({ ok: true });
    expect(fakeStore.setCalls.map((c) => c.name)).toEqual([SESSION_COOKIE_NAME]);
    expect(newQuestions(getDatabase())[0]?.session_id).toBe(fakeStore.setCalls[0]?.value);
    expect(wiredRevalidatePath.mock.calls).toEqual([[`/products/${PIN_SLUG}`]]);
  });

  test("signed in (real sf_auth): account name stored on question and answer, form name ignored, no sf_session minted", async () => {
    const token = await signUpUser("ada.qa@example.com", "Ada Account");
    fakeStore.jar.set(AUTH_COOKIE_NAME, token);
    expect(await wired.askQuestion(null, askForm(Q_TEXT, [["displayName", "Forged"]]))).toMatchObject({ ok: true });
    expect(await wired.answerQuestion(null, answerForm("Yes indeed.", [["displayName", "Forged"]]))).toMatchObject({ ok: true });
    expect(fakeStore.setCalls).toEqual([]);
    const ownerKey = ownerKeyOf("ada.qa@example.com");
    expect(newQuestions(getDatabase())[0]).toMatchObject({ display_name: "Ada Account", session_id: ownerKey });
    expect(newAnswers(getDatabase())[0]).toMatchObject({ display_name: "Ada Account", session_id: ownerKey, is_store: 0 });
    const err = errOf(await wired.askQuestion(null, askForm("tiny", [["displayName", "Forged"]])));
    expect("displayName" in err.values).toBe(false);
  });

  test("6th wired ask in an hour -> RATE_LIMITED with retryAfterSeconds", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    for (let i = 0; i < 5; i++) expect((await wired.askQuestion(null, askForm(`${Q_TEXT} ${i}`)))?.ok).toBe(true);
    const err = errOf(await wired.askQuestion(null, askForm(`${Q_TEXT} 6`)));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("first vote with no cookie mints one session and counts once", async () => {
    const before = helpful(getDatabase(), "answers", SEED_A);
    expect(await wired.voteAnswer(null, fd([["answerId", SEED_A]]))).toMatchObject({ ok: true, helpfulCount: before + 1 });
    expect(voteErrOf(await wired.voteAnswer(null, fd([["answerId", SEED_A]]))).error.code).toBe("DUPLICATE");
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(helpful(getDatabase(), "answers", SEED_A)).toBe(before + 1);
  });

  test("database cannot open: all four wrappers settle with generic state + clean log", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/qa-t47/cannot.sqlite";
    try {
      fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
      expect(errOf(await wired.askQuestion(null, askForm())).error.code).toBe("INVALID_INPUT");
      expect(errOf(await wired.answerQuestion(null, answerForm())).error.code).toBe("INVALID_INPUT");
      expect(voteErrOf(await wired.voteQuestion(null, fd([["questionId", SEED_Q]]))).error.code).toBe("INVALID_INPUT");
      expect(voteErrOf(await wired.voteAnswer(null, fd([["answerId", SEED_A]]))).error.code).toBe("INVALID_INPUT");
      expect(errorSpy).toHaveBeenCalled();
      for (const call of errorSpy.mock.calls) expect(String(call[0])).toMatch(/^\[qa\] QA_ACTION_FAILED action=\w+( stage=init)?$/);
    } finally {
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});

// ---------------------------------------------------------------------------
// Defect probes. `test.failing` passes while the defect exists; when the
// implementation is fixed it starts failing: convert it to a plain `test`.
// ---------------------------------------------------------------------------

describe("QA T47 defect probes", () => {
  test("D-T47-1: signed-in shopper with a bad id gets the posted displayName echoed (contract: omitted for signed-in)", async () => {
    const h = setup();
    h.user.current = { displayName: "Account Ada" };
    const err = errOf(await h.actions.askQuestion(null, fd([["productId", ""], ["body", Q_TEXT], ["displayName", "Posted Name"]])));
    expect(err.error.code).toBe("INVALID_INPUT");
    expect("displayName" in err.values).toBe(false);
  });

  test("D-T46-T47-2 (Q&A): DB cannot open -> 'unavailable' state echoes the values (contract: values echoed so the user can retry)", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/qa-t47/cannot.sqlite";
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const err = errOf(await wired.askQuestion(null, askForm()));
      expect(err.error.details).toEqual({ reason: "unavailable" });
      expect(err.values).toEqual({ body: Q_TEXT, displayName: "Guest Gus" });
    } finally {
      spy.mockRestore();
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});
