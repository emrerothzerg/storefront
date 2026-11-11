import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { QaActionState, QaVoteActionState } from "@/components/molecules/_contracts/qa-actions";
import { QA_FIELD } from "@/components/molecules/_contracts/qa-actions";
import { appError, type AppError, type Result } from "@/lib/result";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createQaService, DEFAULT_DISPLAY_NAME, type QaService } from "@/server/qa/qa-service";
import {
  createRateLimiter,
  RATE_LIMIT_RULES,
  type RateLimiter,
  type RateLimitOk,
  type RateLimitRule,
} from "@/server/security/rate-limiter";
import {
  createQaActions,
  echoQaValues,
  parseIdField,
  parseProductSlug,
  QA_ACTION_FAILED,
  QA_MESSAGES,
  rateLimitedMessage,
  toPostErrorState,
  toVoteErrorState,
  truncate,
  type QaActionDeps,
} from "./questions-core";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const FORGED = "44444444-4444-4444-8444-444444444444";
const QUESTION = "Does this come with a carrying case?";

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
  const request = new Request("http://localhost/products/x", {
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

/** Wraps a real service and counts calls per method. */
function spyService(inner: QaService): QaService & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ask: (...a) => (calls.push("ask"), inner.ask(...a)),
    answer: (...a) => (calls.push("answer"), inner.answer(...a)),
    voteQuestion: (...a) => (calls.push("voteQuestion"), inner.voteQuestion(...a)),
    voteAnswer: (...a) => (calls.push("voteAnswer"), inner.voteAnswer(...a)),
    list: (...a) => inner.list(...a),
    count: (...a) => inner.count(...a),
    listMine: (...a) => inner.listMine(...a),
  };
}

interface Seeded {
  readonly productId: string;
  readonly slug: string;
  readonly questionId: string;
  readonly answerId: string;
}

function seeded(db: Database): Seeded {
  const product = db
    .query<{ id: string; slug: string }, []>(
      "SELECT id, slug FROM products WHERE published_at IS NOT NULL AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY id LIMIT 1",
    )
    .get();
  const answer = db
    .query<{ id: string; question_id: string }, []>(
      `SELECT a.id, a.question_id FROM answers a JOIN questions q ON q.id = a.question_id
       JOIN products p ON p.id = q.product_id
       WHERE a.status = 'published' AND q.status = 'published' AND p.published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
       ORDER BY a.id LIMIT 1`,
    )
    .get();
  if (product === null || answer === null) throw new Error("seed is missing Q&A data");
  return { productId: product.id, slug: product.slug, questionId: answer.question_id, answerId: answer.id };
}

interface Harness {
  readonly db: Database;
  readonly data: Seeded;
  readonly service: ReturnType<typeof spyService>;
  readonly limiter: CountingLimiter;
  readonly getOrCreate: ReturnType<typeof mock<() => Promise<string>>>;
  readonly readCurrentUser: ReturnType<typeof mock<() => Promise<{ readonly displayName: string } | null>>>;
  readonly revalidatePath: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  readonly logger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  readonly actions: ReturnType<typeof createQaActions>;
  readonly session: { current: string | null; next: string };
  readonly user: { current: { readonly displayName: string } | null };
}

function setup(overrides: Partial<QaActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const data = seeded(db);
  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const user: { current: { readonly displayName: string } | null } = { current: null };
  const clock = Date.now();
  const getOrCreate = mock(async (): Promise<string> => {
    if (session.current === null) session.current = session.next;
    return session.current;
  });
  const readCurrentUser = mock(async () => user.current);
  const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const service = spyService(createQaService({ db }));
  const limiter = counting(createRateLimiter(db, { now: () => clock }));
  const actions = createQaActions({
    service,
    limiter,
    getOrCreateSessionId: getOrCreate,
    readCurrentUser,
    revalidatePath,
    now: () => clock,
    logger,
    ...overrides,
  });
  return { db, data, service, limiter, getOrCreate, readCurrentUser, revalidatePath, logger, actions, session, user };
}

type PostFailure = Extract<QaActionState, { ok: false }>;
type VoteFailure = Extract<QaVoteActionState, { ok: false }>;

function expectPostError(state: QaActionState, code: AppError["code"]): PostFailure {
  if (state === null || state.ok) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code);
  expect(state.message).toBe(state.error.message);
  return state;
}

function expectVoteError(state: QaVoteActionState, code: AppError["code"]): VoteFailure {
  if (state === null || state.ok) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code);
  expect(state.message).toBe(state.error.message);
  return state;
}

function questionRow(db: Database, id: string) {
  return db
    .query<{ session_id: string; display_name: string; body: string; helpful_count: number; status: string }, [string]>(
      "SELECT session_id, display_name, body, helpful_count, status FROM questions WHERE id = ?",
    )
    .get(id);
}

function answerRow(db: Database, id: string) {
  return db
    .query<
      { session_id: string; display_name: string; body: string; helpful_count: number; status: string; is_store: number },
      [string]
    >("SELECT session_id, display_name, body, helpful_count, status, is_store FROM answers WHERE id = ?")
    .get(id);
}

function countQuestions(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM questions").get()?.n ?? 0;
}

function countAnswers(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM answers").get()?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

describe("parsing helpers", () => {
  test("parseIdField: trims; rejects missing, File, blank, > 200, huge", () => {
    expect(parseIdField(form({ productId: "  p1 " }), "productId")).toEqual({ ok: true, value: "p1" });
    expect(parseIdField(form({ productId: "x".repeat(200) }), "productId").ok).toBe(true);
    for (const fd of [
      form({}),
      form({ productId: new Blob(["p1"]) }),
      form({ productId: "   " }),
      form({ productId: "x".repeat(201) }),
      form({ productId: "x".repeat(10_000) }),
    ]) {
      const r = parseIdField(fd, "productId");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual(appError("INVALID_INPUT", QA_MESSAGES.invalidRequest, { field: "productId" }));
    }
  });

  test("parseProductSlug accepts only ^[a-z0-9-]{1,100}$", () => {
    expect(parseProductSlug(form({ productSlug: "canvas-tote-bag" }))).toBe("canvas-tote-bag");
    for (const bad of ["", "../admin", "Tote", "a/b", "a b", "a?x=1", "x".repeat(101)]) {
      expect(parseProductSlug(form({ productSlug: bad }))).toBeNull();
    }
    expect(parseProductSlug(form({ productSlug: new Blob(["ok"]) }))).toBeNull();
    expect(parseProductSlug(form({}))).toBeNull();
  });

  test("truncate never leaves a dangling high surrogate", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("ab\u{1F600}", 3)).toBe("ab");
    expect(truncate("abcdef", 3)).toBe("abc");
  });

  test("rateLimitedMessage", () => {
    expect(rateLimitedMessage(undefined)).toBe(QA_MESSAGES.rateLimitedFallback);
    expect(rateLimitedMessage(30)).toBe("Too many requests. Please try again in 1 minute.");
    expect(rateLimitedMessage(1800)).toBe("Too many requests. Please try again in 30 minutes.");
  });

  test("error mapping rebuilds details from a whitelist and hides unknown codes", () => {
    const raw = appError("INVALID_INPUT", "raw <script>", { field: "sessionId", input: "secret" });
    expect(toPostErrorState(raw, {})).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: QA_MESSAGES.invalidRequest },
    });
    const mapped = toPostErrorState(raw, {});
    if (mapped === null || mapped.ok) throw new Error("expected error");
    expect(mapped.error.details).toBeUndefined();
    expect(toPostErrorState(appError("PAYMENT_FAILED", "x"), { body: "b" })).toMatchObject({
      error: { code: "INVALID_INPUT", details: { reason: "unavailable" } },
      values: { body: "b" },
    });
    expect(toVoteErrorState(appError("EMPTY_CART", "x"), "answer")).toMatchObject({
      error: { code: "INVALID_INPUT", details: { reason: "unavailable" } },
    });
    expect(toVoteErrorState(appError("NOT_FOUND", "x"), "answer")).toMatchObject({
      message: QA_MESSAGES.answerNotFound,
    });
    expect(toPostErrorState(appError("VALIDATION_FAILED", "Question must be at least 10 characters.", { field: "body" }), {})).toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { field: "body" } },
      fieldErrors: { body: "Question must be at least 10 characters." },
    });
  });
});

// ---------------------------------------------------------------------------
// Criterion 1: invalid ids / text -> per-field errors, TOO_LONG, no throw
// ---------------------------------------------------------------------------

describe("criterion 1: invalid ids or text", () => {
  test("missing/invalid ids return INVALID_INPUT with details.field; no session, limiter or service", async () => {
    const h = setup();
    const cases: readonly [Promise<QaActionState | QaVoteActionState>, string][] = [
      [h.actions.askQuestion(null, form({ body: QUESTION })), "productId"],
      [h.actions.askQuestion(null, form({ productId: new Blob(["x"]), body: QUESTION })), "productId"],
      [h.actions.answerQuestion(null, form({ body: "Yes." })), "questionId"],
      [h.actions.answerQuestion(null, form({ questionId: "   ", body: "Yes." })), "questionId"],
      [h.actions.voteQuestion(null, form({})), "questionId"],
      [h.actions.voteAnswer(null, form({ answerId: "x".repeat(201) })), "answerId"],
    ];
    for (const [pending, field] of cases) {
      const state = await pending;
      if (state === null || state.ok) throw new Error("expected error");
      expect(state.error).toEqual(appError("INVALID_INPUT", QA_MESSAGES.invalidRequest, { field }));
    }
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
    expect(h.service.calls).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("missing / short question body -> VALIDATION_FAILED on body; nothing created", async () => {
    const h = setup();
    const missing = expectPostError(await h.actions.askQuestion(null, form({ productId: h.data.productId })), "VALIDATION_FAILED");
    expect(missing.fieldErrors).toEqual({ body: "Enter your question." });
    expect(missing.error.details).toEqual({ field: "body" });
    const short = expectPostError(
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: "  Why?   " })),
      "VALIDATION_FAILED",
    );
    expect(short.fieldErrors).toEqual({ body: "Question must be at least 10 characters." });
    expect(short.values).toEqual({ body: "  Why?   " });
    const fileBody = expectPostError(
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: new Blob([QUESTION]) })),
      "VALIDATION_FAILED",
    );
    expect(fileBody.values).toEqual({});
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
    expect(h.service.calls).toEqual([]);
  });

  test("oversize question -> TOO_LONG, echo truncated to 300", async () => {
    const h = setup();
    const long = "a".repeat(5000);
    const state = expectPostError(await h.actions.askQuestion(null, form({ productId: h.data.productId, body: long })), "TOO_LONG");
    expect(state.fieldErrors).toEqual({ body: "Question must be at most 300 characters." });
    expect(state.values.body).toBe("a".repeat(300));
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("oversize answer -> TOO_LONG, echo truncated to 1000; oversize name -> TOO_LONG on displayName", async () => {
    const h = setup();
    const a = expectPostError(
      await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: "b".repeat(1001) })),
      "TOO_LONG",
    );
    expect(a.fieldErrors).toEqual({ body: "Answer must be at most 1000 characters." });
    expect(a.values.body).toBe("b".repeat(1000));
    const n = expectPostError(
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION, displayName: "n".repeat(80) })),
      "TOO_LONG",
    );
    expect(n.fieldErrors).toEqual({ displayName: "Display name must be at most 50 characters." });
    expect(n.error.details).toEqual({ field: "displayName" });
    expect(n.values).toEqual({ body: QUESTION, displayName: "n".repeat(50) });
    expect(h.service.calls).toEqual([]);
  });

  test("two failing fields -> both field errors and a generic headline", async () => {
    const h = setup();
    const state = expectPostError(
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: "short", displayName: "n".repeat(51) })),
      "VALIDATION_FAILED",
    );
    expect(state.message).toBe(QA_MESSAGES.fixFields);
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["body", "displayName"]);
  });

  test("link spam -> VALIDATION_FAILED with reason TOO_MANY_URLS", async () => {
    const h = setup();
    const state = expectPostError(
      await h.actions.answerQuestion(
        null,
        form({ questionId: h.data.questionId, body: "see http://a.example http://b.example www.c.example" }),
      ),
      "VALIDATION_FAILED",
    );
    expect(state.error.details).toEqual({ field: "body", reason: "TOO_MANY_URLS" });
    expect(state.fieldErrors.body).toBe("Answer may contain at most 2 links.");
  });

  test("unknown product / question -> PRODUCT_NOT_FOUND / NOT_FOUND from the service", async () => {
    const h = setup();
    expectPostError(await h.actions.askQuestion(null, form({ productId: "prod_nope", body: QUESTION })), "PRODUCT_NOT_FOUND");
    const nf = expectPostError(await h.actions.answerQuestion(null, form({ questionId: "q_nope", body: "Yes." })), "NOT_FOUND");
    expect(nf.message).toBe(QA_MESSAGES.questionNotFound);
    expect(nf.values).toEqual({ body: "Yes." });
    expectVoteError(await h.actions.voteQuestion(null, form({ questionId: "q_nope" })), "NOT_FOUND");
    expectVoteError(await h.actions.voteAnswer(null, form({ answerId: "a_nope" })), "NOT_FOUND");
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("hostile forms never throw (all settle)", async () => {
    const h = setup();
    const hostile: Fields[] = [
      {},
      { productId: "'; DROP TABLE questions; --", body: QUESTION },
      { productId: h.data.productId, body: "\u0000​".repeat(100) },
      { productId: h.data.productId, body: "<script>alert(1)</script> is it safe?", displayName: "<b>x</b>" },
      { questionId: h.data.questionId, answerId: h.data.answerId, body: "\r\n".repeat(50) },
    ];
    for (const fields of hostile) {
      for (const fn of [h.actions.askQuestion, h.actions.answerQuestion]) {
        await expect(fn(null, form(fields))).resolves.not.toBeNull();
      }
      for (const fn of [h.actions.voteQuestion, h.actions.voteAnswer]) {
        await expect(fn(null, form(fields))).resolves.not.toBeNull();
      }
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM questions WHERE body LIKE '%DROP%'").get()).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: rate limits (per session + global) before the service
// ---------------------------------------------------------------------------

describe("criterion 2: rate limits", () => {
  test("ask: 6th in an hour is RATE_LIMITED with retryAfterSeconds; service not called", async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) {
      const s = await h.actions.askQuestion(null, form({ productId: h.data.productId, body: `${QUESTION} variant ${i}` }));
      expect(s).toMatchObject({ ok: true, kind: "asked" });
    }
    expect(h.limiter.calls.slice(0, 2)).toEqual([`question.ask:${S1}`, "question.ask:*"]);
    const before = h.service.calls.length;
    const state = expectPostError(
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: `${QUESTION} variant 5` })),
      "RATE_LIMITED",
    );
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.error.details).toEqual({ retryAfterSeconds: state.retryAfterSeconds });
    expect(state.message).toMatch(/^Too many requests\. Please try again in \d+ minutes?\.$/);
    expect(state.values).toEqual({ body: `${QUESTION} variant 5` });
    expect(h.service.calls.length).toBe(before);
    expect(countQuestions(h.db)).toBeGreaterThan(0);
  });

  test("answer: 11th in an hour is RATE_LIMITED (10/h)", async () => {
    const h = setup();
    const qids = h.db
      .query<{ id: string }, []>(
        "SELECT q.id FROM questions q JOIN products p ON p.id = q.product_id WHERE q.status = 'published' AND p.published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY q.id LIMIT 4",
      )
      .all()
      .map((r) => r.id);
    expect(qids.length).toBe(4);
    let posted = 0;
    for (const qid of qids) {
      for (let i = 0; i < 3 && posted < 10; i++, posted++) {
        expect(await h.actions.answerQuestion(null, form({ questionId: qid, body: `Answer ${posted}` }))).toMatchObject({ ok: true });
      }
    }
    const before = h.service.calls.length;
    const state = expectPostError(
      await h.actions.answerQuestion(null, form({ questionId: qids[3] ?? "", body: "One more" })),
      "RATE_LIMITED",
    );
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.service.calls.length).toBe(before);
  });

  test("vote: 61st in an hour is RATE_LIMITED (60/h); failed votes count too", async () => {
    const h = setup();
    for (let i = 0; i < 60; i++) {
      await h.actions.voteQuestion(null, form({ questionId: `q_missing_${i}` }));
    }
    const before = h.service.calls.length;
    const state = expectVoteError(await h.actions.voteAnswer(null, form({ answerId: h.data.answerId })), "RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.service.calls.length).toBe(before);
  });

  test("global backstops: a fresh session is limited once the action's global bucket is full", async () => {
    const h = setup();
    const exhaust = (action: "question.ask" | "answer.post" | "vote"): void => {
      const rule = RATE_LIMIT_RULES[action].global;
      if (rule === null) throw new Error("expected a global rule");
      for (let i = 0; i < rule.limit; i++) h.limiter.check(`${action}:*`, rule);
    };
    exhaust("question.ask");
    exhaust("answer.post");
    exhaust("vote");
    h.session.next = S2;
    expectPostError(await h.actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION })), "RATE_LIMITED");
    expectPostError(await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: "Yes." })), "RATE_LIMITED");
    expectVoteError(await h.actions.voteQuestion(null, form({ questionId: h.data.questionId })), "RATE_LIMITED");
    expectVoteError(await h.actions.voteAnswer(null, form({ answerId: h.data.answerId })), "RATE_LIMITED");
    expect(h.service.calls).toEqual([]);
  });

  test("ask and answer budgets are separate", async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) {
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: `${QUESTION} n${i}` }));
    }
    expect(await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: "Yes." }))).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: client cannot set isStore / status / counts / session
// ---------------------------------------------------------------------------

describe("criterion 3: forged fields are ignored", () => {
  const FORGED_FIELDS = {
    isStore: "1",
    is_store: "true",
    status: "hidden",
    helpfulCount: "999",
    helpful_count: "999",
    sessionId: FORGED,
    session_id: FORGED,
  } as const;

  test("ask/answer store published, helpful 0, is_store 0, under the cookie session", async () => {
    const h = setup();
    const q = await h.actions.askQuestion(null, form({ ...FORGED_FIELDS, productId: h.data.productId, body: QUESTION }));
    if (q === null || !q.ok) throw new Error(JSON.stringify(q));
    expect(questionRow(h.db, q.id)).toEqual({
      session_id: S1,
      display_name: DEFAULT_DISPLAY_NAME,
      body: QUESTION,
      helpful_count: 0,
      status: "published",
    });
    const a = await h.actions.answerQuestion(null, form({ ...FORGED_FIELDS, questionId: h.data.questionId, body: "Yes, it does." }));
    if (a === null || !a.ok) throw new Error(JSON.stringify(a));
    expect(answerRow(h.db, a.id)).toEqual({
      session_id: S1,
      display_name: DEFAULT_DISPLAY_NAME,
      body: "Yes, it does.",
      helpful_count: 0,
      status: "published",
      is_store: 0,
    });
    expect(h.db.query("SELECT COUNT(*) AS n FROM questions WHERE session_id = ?").get(FORGED)).toEqual({ n: 0 });
  });

  test("vote returns the real count, not a posted helpfulCount", async () => {
    const h = setup();
    const before = h.db.query<{ helpful_count: number }, [string]>("SELECT helpful_count FROM answers WHERE id = ?").get(h.data.answerId);
    const state = await h.actions.voteAnswer(null, form({ ...FORGED_FIELDS, answerId: h.data.answerId }));
    expect(state).toEqual({ ok: true, helpfulCount: (before?.helpful_count ?? 0) + 1, message: QA_MESSAGES.voted });
    expect(h.db.query("SELECT COUNT(*) AS n FROM answer_votes WHERE session_id = ?").get(S1)).toEqual({ n: 1 });
  });

  test("only QA_FIELD names are read from the form (spy FormData)", async () => {
    const h = setup();
    const read: string[] = [];
    const allowed = new Set<string>(Object.values(QA_FIELD));
    const wrap = (fd: FormData): FormData =>
      new Proxy(fd, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            read.push(`${String(prop)}(${args.map(String).join(",")})`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const fields = { ...FORGED_FIELDS, productId: h.data.productId, questionId: h.data.questionId, answerId: h.data.answerId, body: QUESTION, productSlug: h.data.slug };
    await h.actions.askQuestion(null, wrap(form(fields)));
    await h.actions.answerQuestion(null, wrap(form(fields)));
    await h.actions.voteQuestion(null, wrap(form(fields)));
    await h.actions.voteAnswer(null, wrap(form(fields)));
    expect(read.length).toBeGreaterThan(0);
    for (const call of read) {
      const match = /^get\((.*)\)$/.exec(call);
      expect(match).not.toBeNull();
      expect(allowed.has(match?.[1] ?? "")).toBe(true);
    }
  });

  test("prevState is ignored", async () => {
    const h = setup();
    const bogus: QaActionState = { ok: true, kind: "answered", id: "forged", message: "x" };
    const state = await h.actions.askQuestion(bogus, form({ productId: h.data.productId, body: QUESTION }));
    expect(state).toMatchObject({ ok: true, kind: "asked" });
    if (state?.ok) expect(state.id).not.toBe("forged");
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: duplicate / own-content / limit typed errors
// ---------------------------------------------------------------------------

describe("criterion 4: typed service errors", () => {
  test("duplicate question -> DUPLICATE 'You already asked this question.' on body", async () => {
    const h = setup();
    expect(await h.actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION }))).toMatchObject({ ok: true });
    const dup = expectPostError(
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: `  ${QUESTION}  ` })),
      "DUPLICATE",
    );
    expect(dup.message).toBe("You already asked this question.");
    expect(dup.fieldErrors).toEqual({ body: "You already asked this question." });
    expect(dup.values).toEqual({ body: `  ${QUESTION}  ` });
  });

  test("own question / own answer vote -> FORBIDDEN 'You cannot vote on your own post.'", async () => {
    const h = setup();
    const q = await h.actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION }));
    const a = await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: "Mine." }));
    if (q === null || !q.ok || a === null || !a.ok) throw new Error("setup failed");
    const vq = expectVoteError(await h.actions.voteQuestion(null, form({ questionId: q.id })), "FORBIDDEN");
    expect(vq.message).toBe("You cannot vote on your own post.");
    expectVoteError(await h.actions.voteAnswer(null, form({ answerId: a.id })), "FORBIDDEN");
    expect(h.revalidatePath.mock.calls.length).toBe(0);
  });

  test("second vote -> DUPLICATE; count unchanged", async () => {
    const h = setup();
    const first = await h.actions.voteQuestion(null, form({ questionId: h.data.questionId }));
    if (first === null || !first.ok) throw new Error(JSON.stringify(first));
    const dup = expectVoteError(await h.actions.voteQuestion(null, form({ questionId: h.data.questionId })), "DUPLICATE");
    expect(dup.message).toBe(QA_MESSAGES.duplicateVote);
    const row = h.db.query<{ helpful_count: number }, [string]>("SELECT helpful_count FROM questions WHERE id = ?").get(h.data.questionId);
    expect(row?.helpful_count).toBe(first.helpfulCount);
  });

  test("4th answer on one question -> LIMIT_REACHED", async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) {
      expect(await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: `Answer ${i}` }))).toMatchObject({ ok: true });
    }
    const state = expectPostError(await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: "Answer 3" })), "LIMIT_REACHED");
    expect(state.message).toBe("You have reached the answer limit for this question.");
    expect(state.error.details).toEqual({ limit: 3 });
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: session on first write; revalidate PDP only
// ---------------------------------------------------------------------------

describe("criterion 5: session + revalidation", () => {
  test("successful ask: one session call, revalidates exactly /products/<slug>", async () => {
    const h = setup();
    const state = await h.actions.askQuestion(null, form({ productId: h.data.productId, productSlug: h.data.slug, body: QUESTION }));
    expect(state).toMatchObject({ ok: true, kind: "asked", message: QA_MESSAGES.asked });
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath.mock.calls).toEqual([[`/products/${h.data.slug}`]]);
  });

  test("each action revalidates only the posted PDP; invalid or missing slug revalidates nothing", async () => {
    const h = setup();
    await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, productSlug: h.data.slug, body: "Yes." }));
    await h.actions.voteAnswer(null, form({ answerId: h.data.answerId, productSlug: h.data.slug }));
    await h.actions.voteQuestion(null, form({ questionId: h.data.questionId, productSlug: "../../admin" }));
    await h.actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION }));
    expect(h.revalidatePath.mock.calls).toEqual([[`/products/${h.data.slug}`], [`/products/${h.data.slug}`]]);
  });

  test("vote with no session creates one and counts once", async () => {
    const h = setup();
    const state = await h.actions.voteQuestion(null, form({ questionId: h.data.questionId }));
    expect(state).toMatchObject({ ok: true });
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.db.query("SELECT COUNT(*) AS n FROM question_votes WHERE session_id = ?").get(S1)).toEqual({ n: 1 });
  });

  test("failures revalidate nothing", async () => {
    const h = setup();
    await h.actions.askQuestion(null, form({ productId: "prod_nope", productSlug: h.data.slug, body: QUESTION }));
    await h.actions.askQuestion(null, form({ productId: h.data.productId, productSlug: h.data.slug, body: "short" }));
    await h.actions.voteAnswer(null, form({ answerId: "a_nope", productSlug: h.data.slug }));
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Display name (accounts amendment)
// ---------------------------------------------------------------------------

describe("display name", () => {
  test("guest: chosen name is stored; blank -> default", async () => {
    const h = setup();
    const named = await h.actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION, displayName: "  Ada  " }));
    if (named === null || !named.ok) throw new Error(JSON.stringify(named));
    expect(questionRow(h.db, named.id)?.display_name).toBe("Ada");
    const blank = await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: "Yes.", displayName: "   " }));
    if (blank === null || !blank.ok) throw new Error(JSON.stringify(blank));
    expect(answerRow(h.db, blank.id)?.display_name).toBe(DEFAULT_DISPLAY_NAME);
  });

  test("signed in: posted displayName is never echoed on any failure path (D-T47-1)", async () => {
    const h = setup();
    h.user.current = { displayName: "Ada Account" };
    const badId = expectPostError(
      await h.actions.askQuestion(null, form({ productId: "", body: QUESTION, displayName: "Posted" })),
      "INVALID_INPUT",
    );
    expect(badId.values).toEqual({ body: QUESTION });
    const badAnswerId = expectPostError(
      await h.actions.answerQuestion(null, form({ body: "Yes", displayName: "Posted" })),
      "INVALID_INPUT",
    );
    expect(badAnswerId.values).toEqual({ body: "Yes" });
    expect(h.readCurrentUser).toHaveBeenCalledTimes(2);
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("guest: bad id still echoes body and displayName (capped)", async () => {
    const h = setup();
    const state = expectPostError(
      await h.actions.askQuestion(null, form({ body: "q".repeat(400), displayName: "n".repeat(60) })),
      "INVALID_INPUT",
    );
    expect(state.values).toEqual({ body: "q".repeat(300), displayName: "n".repeat(50) });
  });

  test("readCurrentUser throwing -> unavailable state echoes body only", async () => {
    const h = setup({
      readCurrentUser: async () => {
        throw new Error("auth down");
      },
    });
    const state = expectPostError(
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION, displayName: "Posted" })),
      "INVALID_INPUT",
    );
    expect(state.values).toEqual({ body: QUESTION });
  });

  test("echoQaValues: caps per target, omits ids, File entries and (signed in) displayName", () => {
    const fd = form({ productId: "p1", questionId: "q1", body: "b".repeat(1200), displayName: "n".repeat(70) });
    expect(echoQaValues(fd, "question", false)).toEqual({ body: "b".repeat(300), displayName: "n".repeat(50) });
    expect(echoQaValues(fd, "answer", false)).toEqual({ body: "b".repeat(1000), displayName: "n".repeat(50) });
    expect(echoQaValues(fd, "answer", true)).toEqual({ body: "b".repeat(1000) });
    expect(echoQaValues(form({ body: new Blob(["x"]), displayName: new Blob(["y"]) }), "question", false)).toEqual({});
  });

  test("signed in: account display name is used; form name (even oversize) ignored and not echoed", async () => {
    const h = setup();
    h.user.current = { displayName: "Ada Account" };
    const q = await h.actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION, displayName: "Impostor" }));
    if (q === null || !q.ok) throw new Error(JSON.stringify(q));
    expect(questionRow(h.db, q.id)?.display_name).toBe("Ada Account");
    const a = await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: "Yes.", displayName: "x".repeat(500) }));
    if (a === null || !a.ok) throw new Error(JSON.stringify(a));
    expect(answerRow(h.db, a.id)?.display_name).toBe("Ada Account");
    const err = expectPostError(
      await h.actions.askQuestion(null, form({ productId: h.data.productId, body: "short", displayName: "Impostor" })),
      "VALIDATION_FAILED",
    );
    expect(err.values).toEqual({ body: "short" });
    expect(err.fieldErrors).toEqual({ body: "Question must be at least 10 characters." });
  });
});

// ---------------------------------------------------------------------------
// Settling + progressive enhancement
// ---------------------------------------------------------------------------

describe("always settles", () => {
  test("service throw -> generic state with echoed values; logs code + action only", async () => {
    const h = setup();
    const throwing: QaService = {
      ...h.service,
      ask: () => {
        throw new Error(`SQLITE_BUSY ${S1} ${QUESTION}`);
      },
      voteAnswer: () => {
        throw new Error("boom");
      },
    };
    const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
    const actions = createQaActions({
      service: throwing,
      limiter: h.limiter,
      getOrCreateSessionId: h.getOrCreate,
      readCurrentUser: h.readCurrentUser,
      revalidatePath: h.revalidatePath,
      logger,
    });
    const state = expectPostError(await actions.askQuestion(null, form({ productId: h.data.productId, body: QUESTION })), "INVALID_INPUT");
    expect(state.error.details).toEqual({ reason: "unavailable" });
    expect(state.values).toEqual({ body: QUESTION });
    expectVoteError(await actions.voteAnswer(null, form({ answerId: h.data.answerId })), "INVALID_INPUT");
    const logged = logger.error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain(`${QA_ACTION_FAILED} action=ask`);
    expect(logged).toContain(`${QA_ACTION_FAILED} action=voteAnswer`);
    expect(logged).not.toContain(S1);
    expect(logged).not.toContain(QUESTION);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("session or user lookup rejecting -> generic state", async () => {
    const h = setup({
      getOrCreateSessionId: async () => {
        throw new Error("cookies unavailable");
      },
    });
    expectPostError(await h.actions.answerQuestion(null, form({ questionId: h.data.questionId, body: "Yes." })), "INVALID_INPUT");
    expectVoteError(await h.actions.voteQuestion(null, form({ questionId: h.data.questionId })), "INVALID_INPUT");
    const h2 = setup({
      readCurrentUser: async () => {
        throw new Error("auth down");
      },
    });
    expectPostError(await h2.actions.askQuestion(null, form({ productId: h2.data.productId, body: QUESTION })), "INVALID_INPUT");
    expect(countAnswers(h.db)).toBe(countAnswers(h2.db));
  });

  test("browser multipart FormData works end to end (no-JS post)", async () => {
    const h = setup();
    const fd = await browserMultipart([
      ["$ACTION_ID_abc", ""],
      [QA_FIELD.productId, h.data.productId],
      [QA_FIELD.productSlug, h.data.slug],
      [QA_FIELD.body, "Is it\r\nwaterproof?"],
      [QA_FIELD.displayName, "Grace"],
      ["isStore", "1"],
    ]);
    const state = await h.actions.askQuestion(null, fd);
    if (state === null || !state.ok) throw new Error(JSON.stringify(state));
    expect(questionRow(h.db, state.id)).toMatchObject({ body: "Is it waterproof?", display_name: "Grace", session_id: S1 });
    const answerFd = await browserMultipart([
      [QA_FIELD.questionId, state.id],
      [QA_FIELD.body, "Line one\r\nLine two"],
    ]);
    h.session.current = S2;
    const answered = await h.actions.answerQuestion(null, answerFd);
    if (answered === null || !answered.ok) throw new Error(JSON.stringify(answered));
    expect(answerRow(h.db, answered.id)?.body).toBe("Line one\nLine two");
  });
});
