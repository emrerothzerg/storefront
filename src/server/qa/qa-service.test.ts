import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Answer, Question } from "@/lib/types";
import type { AppError, Result } from "@/lib/result";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  DEFAULT_DISPLAY_NAME,
  QA_PAGE_SIZE,
  createQaService,
  getQaService,
  type QaService,
} from "./qa-service";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const PRODUCT = "prod_test";
const OTHER_PRODUCT = "prod_other";
const QUESTION = "Does this come with a carrying case?";

function setup(options: { seed?: boolean } = {}) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  if (options.seed === true) seedDatabase(db);
  addProduct(db, PRODUCT);
  addProduct(db, OTHER_PRODUCT);
  let ids = 0;
  const service = createQaService({ db, now: () => T0, newId: () => `id_${String(++ids).padStart(4, "0")}` });
  return { db, service };
}

function addProduct(db: Database, id: string, publishedAt = "2020-01-01T00:00:00.000Z"): void {
  db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES (?, ?, ?, 1000, 'USD', ?, 5, ?)",
  ).run(id, `${id}-slug`, `Name ${id}`, `/images/${id}.svg`, publishedAt);
}

function unwrap<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function code<T>(r: Result<T, AppError>): string {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.value)}`);
  return r.error.code;
}

function ask(service: QaService, session: string, body: unknown = QUESTION, productId = PRODUCT, now?: number): Question {
  return unwrap(service.ask(session, { productId, body }, now));
}

function insertStoreAnswer(db: Database, id: string, questionId: string, helpful = 0, createdAt = "2026-10-01T00:00:00.000Z"): void {
  db.query(
    "INSERT INTO answers (id, question_id, session_id, display_name, body, is_store, helpful_count, created_at) VALUES (?, ?, 'seed_store', 'Store', 'Official answer', 1, ?, ?)",
  ).run(id, questionId, helpful, createdAt);
}

afterEach(() => {
  closeDatabase();
});

describe("ask", () => {
  test("creates a published question with cleaned text, default name, no author key", () => {
    const { db, service } = setup();
    const q = ask(service, S1, "  Is it\u0000 dishwasher​   safe?  ");
    expect(q).toEqual({
      id: "id_0001",
      productId: PRODUCT,
      displayName: DEFAULT_DISPLAY_NAME,
      body: "Is it dishwasher safe?",
      helpfulCount: 0,
      status: "published",
      createdAt: new Date(T0).toISOString(),
    });
    expect(Object.keys(q)).not.toContain("sessionId");
    const row = db.query<{ session_id: string }, []>("SELECT session_id FROM questions WHERE id = 'id_0001'").get();
    expect(row?.session_id).toBe(S1);
  });

  test("uses a given display name (cleaned) and falls back to the default for blank names", () => {
    const { service } = setup();
    expect(unwrap(service.ask(S1, { productId: PRODUCT, body: QUESTION, displayName: "  Ana \t B " })).displayName).toBe("Ana B");
    expect(unwrap(service.ask(S1, { productId: PRODUCT, body: `${QUESTION} 2`, displayName: "  ​ " })).displayName).toBe(
      DEFAULT_DISPLAY_NAME,
    );
    expect(unwrap(service.ask(S1, { productId: PRODUCT, body: `${QUESTION} 3`, displayName: null })).displayName).toBe(
      DEFAULT_DISPLAY_NAME,
    );
  });

  test("length limits: 10..300 after cleaning", () => {
    const { service } = setup();
    expect(code(service.ask(S1, { productId: PRODUCT, body: "short q?" }))).toBe("VALIDATION_FAILED");
    expect(code(service.ask(S1, { productId: PRODUCT, body: `   ${"a".repeat(9)}\u0001\u0002   ` }))).toBe("VALIDATION_FAILED");
    expect(code(service.ask(S1, { productId: PRODUCT, body: undefined }))).toBe("VALIDATION_FAILED");
    expect(code(service.ask(S1, { productId: PRODUCT, body: "" }))).toBe("VALIDATION_FAILED");
    expect(unwrap(service.ask(S1, { productId: PRODUCT, body: "a".repeat(10) })).body).toBe("a".repeat(10));
    expect(unwrap(service.ask(S1, { productId: PRODUCT, body: "b".repeat(300) })).body).toHaveLength(300);
    const tooLong = service.ask(S1, { productId: PRODUCT, body: "c".repeat(301) });
    expect(code(tooLong)).toBe("TOO_LONG");
    if (!tooLong.ok) expect(tooLong.error.details?.field).toBe("body");
    expect(code(service.ask(S1, { productId: PRODUCT, body: "d".repeat(5000) }))).toBe("TOO_LONG");
  });

  test("display name over 50 is TOO_LONG; non-string inputs are INVALID_INPUT", () => {
    const { service } = setup();
    const r = service.ask(S1, { productId: PRODUCT, body: QUESTION, displayName: "n".repeat(51) });
    expect(code(r)).toBe("TOO_LONG");
    if (!r.ok) expect(r.error.details?.field).toBe("displayName");
    expect(unwrap(service.ask(S1, { productId: PRODUCT, body: QUESTION, displayName: "n".repeat(50) })).displayName).toHaveLength(50);
    expect(code(service.ask(S1, { productId: PRODUCT, body: 42 }))).toBe("INVALID_INPUT");
    expect(code(service.ask(S1, { productId: PRODUCT, body: `${QUESTION}!`, displayName: { x: 1 } }))).toBe("INVALID_INPUT");
  });

  test("URL spam: more than 2 links is VALIDATION_FAILED, 2 are fine", () => {
    const { service } = setup();
    const r = service.ask(S1, { productId: PRODUCT, body: "see http://a.example http://b.example www.c.example" });
    expect(code(r)).toBe("VALIDATION_FAILED");
    if (!r.ok) expect(r.error.details?.reason).toBe("TOO_MANY_URLS");
    expect(service.ask(S1, { productId: PRODUCT, body: "compare http://a.example and www.b.example" }).ok).toBe(true);
  });

  test("invalid session ids are INVALID_INPUT and write nothing", () => {
    const { db, service } = setup();
    for (const bad of ["", "not-a-uuid", "seed_session_01", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "11111111-1111-1111-8111-111111111111"]) {
      expect(code(service.ask(bad, { productId: PRODUCT, body: QUESTION }))).toBe("INVALID_INPUT");
    }
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM questions").get()?.n).toBe(0);
  });

  test("unknown, unpublished or malformed product is PRODUCT_NOT_FOUND", () => {
    const { db, service } = setup();
    addProduct(db, "prod_future", "2099-01-01T00:00:00.000Z");
    expect(code(service.ask(S1, { productId: "prod_nope", body: QUESTION }))).toBe("PRODUCT_NOT_FOUND");
    expect(code(service.ask(S1, { productId: "prod_future", body: QUESTION }))).toBe("PRODUCT_NOT_FOUND");
    expect(code(service.ask(S1, { productId: 7 as unknown as string, body: QUESTION }))).toBe("PRODUCT_NOT_FOUND");
    expect(code(service.ask(S1, { productId: "", body: QUESTION }))).toBe("PRODUCT_NOT_FOUND");
  });

  test("DUPLICATE only for the same cleaned text, same session, same product", () => {
    const { service } = setup();
    ask(service, S1, QUESTION);
    const dup = service.ask(S1, { productId: PRODUCT, body: `  ${QUESTION.replace(" ", "\t\t")}\u0007 ` });
    expect(code(dup)).toBe("DUPLICATE");
    expect(service.ask(S2, { productId: PRODUCT, body: QUESTION }).ok).toBe(true);
    expect(service.ask(S1, { productId: OTHER_PRODUCT, body: QUESTION }).ok).toBe(true);
    expect(service.ask(S1, { productId: PRODUCT, body: `${QUESTION}?` }).ok).toBe(true);
  });

  test("DUPLICATE also covers a hidden earlier question", () => {
    const { db, service } = setup();
    const q = ask(service, S1);
    db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(q.id);
    expect(code(service.ask(S1, { productId: PRODUCT, body: QUESTION }))).toBe("DUPLICATE");
  });

  test("concurrent identical asks create one row", async () => {
    const { db, service } = setup();
    const results = await Promise.all(
      [0, 1, 2].map(async () => service.ask(S1, { productId: PRODUCT, body: QUESTION })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map(code)).toEqual(["DUPLICATE", "DUPLICATE"]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM questions").get()?.n).toBe(1);
  });

  test("hostile HTML is stored verbatim as text", () => {
    const { db, service } = setup();
    const hostile = `<script>alert("x")</script><img src=x onerror=alert(1)> & "quotes"`;
    const q = ask(service, S1, hostile);
    expect(q.body).toBe(hostile);
    expect(db.query<{ body: string }, [string]>("SELECT body FROM questions WHERE id = ?").get(q.id)?.body).toBe(hostile);
  });

  test("per-call now sets createdAt", () => {
    const { service } = setup();
    const at = Date.parse("2026-11-05T10:00:00.000Z");
    expect(ask(service, S1, QUESTION, PRODUCT, at).createdAt).toBe("2026-11-05T10:00:00.000Z");
  });
});

describe("answer", () => {
  test("creates a community answer (is_store = 0), multiline kept, controls stripped", () => {
    const { db, service } = setup();
    const q = ask(service, S1);
    const a = unwrap(service.answer(S2, { questionId: q.id, body: "Yes.\r\n\r\n\r\nIt does\u0000.", displayName: "Kim" }));
    expect(a).toEqual({
      id: "id_0002",
      questionId: q.id,
      displayName: "Kim",
      body: "Yes.\n\nIt does.",
      isStore: false,
      helpfulCount: 0,
      status: "published",
      createdAt: new Date(T0).toISOString(),
    });
    expect(db.query<{ is_store: number }, [string]>("SELECT is_store FROM answers WHERE id = ?").get(a.id)?.is_store).toBe(0);
  });

  test("is_store cannot be set through the public API", () => {
    const { db, service } = setup();
    const q = ask(service, S1);
    const input = { questionId: q.id, body: "Store says yes", displayName: "Store", isStore: true, is_store: 1 };
    const a = unwrap(service.answer(S2, input));
    expect(a.isStore).toBe(false);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM answers WHERE is_store = 1").get()?.n).toBe(0);
    // The method takes exactly (sessionId, input, now?) and the input type has no store flag.
    expect(service.answer.length).toBeLessThanOrEqual(3);
    type AnswerInput = Parameters<QaService["answer"]>[1];
    type HasStoreKey = "isStore" extends keyof AnswerInput ? true : "is_store" extends keyof AnswerInput ? true : false;
    const noStoreKey: HasStoreKey = false;
    expect(noStoreKey).toBe(false);
  });

  test("length limits 1..1000", () => {
    const { service } = setup();
    const q = ask(service, S1);
    expect(code(service.answer(S2, { questionId: q.id, body: "  ​\u0001 " }))).toBe("VALIDATION_FAILED");
    expect(code(service.answer(S2, { questionId: q.id, body: null }))).toBe("VALIDATION_FAILED");
    expect(unwrap(service.answer(S2, { questionId: q.id, body: "y" })).body).toBe("y");
    expect(unwrap(service.answer(S2, { questionId: q.id, body: "z".repeat(1000) })).body).toHaveLength(1000);
    expect(code(service.answer(S3, { questionId: q.id, body: "z".repeat(1001) }))).toBe("TOO_LONG");
    expect(code(service.answer(S3, { questionId: q.id, body: ["x"] }))).toBe("INVALID_INPUT");
    expect(code(service.answer(S3, { questionId: q.id, body: "ok", displayName: "n".repeat(51) }))).toBe("TOO_LONG");
    expect(code(service.answer(S3, { questionId: q.id, body: "http://a.x http://b.x http://c.x" }))).toBe("VALIDATION_FAILED");
  });

  test("unknown or hidden question is NOT_FOUND", () => {
    const { db, service } = setup();
    expect(code(service.answer(S2, { questionId: "q_nope", body: "hi" }))).toBe("NOT_FOUND");
    expect(code(service.answer(S2, { questionId: 5 as unknown as string, body: "hi" }))).toBe("NOT_FOUND");
    const q = ask(service, S1);
    db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(q.id);
    expect(code(service.answer(S2, { questionId: q.id, body: "hi" }))).toBe("NOT_FOUND");
  });

  test("4th answer by the same session on one question is LIMIT_REACHED (hidden ones count)", () => {
    const { db, service } = setup();
    const q = ask(service, S1);
    const first = unwrap(service.answer(S2, { questionId: q.id, body: "one" }));
    unwrap(service.answer(S2, { questionId: q.id, body: "two" }));
    db.query("UPDATE answers SET status = 'hidden' WHERE id = ?").run(first.id);
    unwrap(service.answer(S2, { questionId: q.id, body: "three" }));
    expect(code(service.answer(S2, { questionId: q.id, body: "four" }))).toBe("LIMIT_REACHED");
    expect(service.answer(S3, { questionId: q.id, body: "other session" }).ok).toBe(true);
    const q2 = ask(service, S1, "A different question here?");
    expect(service.answer(S2, { questionId: q2.id, body: "other question" }).ok).toBe(true);
  });

  test("invalid session is INVALID_INPUT", () => {
    const { service } = setup();
    const q = ask(service, S1);
    expect(code(service.answer("x", { questionId: q.id, body: "hi" }))).toBe("INVALID_INPUT");
  });
});

describe("votes", () => {
  test("voteQuestion increments once per session and returns the count", () => {
    const { service } = setup();
    const q = ask(service, S1);
    expect(unwrap(service.voteQuestion(S2, q.id))).toEqual({ helpfulCount: 1 });
    expect(unwrap(service.voteQuestion(S3, q.id))).toEqual({ helpfulCount: 2 });
    expect(code(service.voteQuestion(S2, q.id))).toBe("DUPLICATE");
  });

  test("own content cannot be voted (FORBIDDEN)", () => {
    const { service } = setup();
    const q = ask(service, S1);
    const a = unwrap(service.answer(S2, { questionId: q.id, body: "yes" }));
    expect(code(service.voteQuestion(S1, q.id))).toBe("FORBIDDEN");
    expect(code(service.voteAnswer(S2, a.id))).toBe("FORBIDDEN");
  });

  test("unknown or hidden targets are NOT_FOUND; answers of hidden questions too", () => {
    const { db, service } = setup();
    expect(code(service.voteQuestion(S2, "nope"))).toBe("NOT_FOUND");
    expect(code(service.voteAnswer(S2, "nope"))).toBe("NOT_FOUND");
    expect(code(service.voteAnswer(S2, ""))).toBe("NOT_FOUND");
    const q = ask(service, S1);
    const a = unwrap(service.answer(S1, { questionId: q.id, body: "yes" }));
    db.query("UPDATE answers SET status = 'hidden' WHERE id = ?").run(a.id);
    expect(code(service.voteAnswer(S2, a.id))).toBe("NOT_FOUND");
    db.query("UPDATE answers SET status = 'published' WHERE id = ?").run(a.id);
    db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(q.id);
    expect(code(service.voteAnswer(S2, a.id))).toBe("NOT_FOUND");
    expect(code(service.voteQuestion(S2, q.id))).toBe("NOT_FOUND");
  });

  test("voteAnswer increments once per session; store answers can be voted", () => {
    const { db, service } = setup();
    const q = ask(service, S1);
    insertStoreAnswer(db, "a_store", q.id, 4);
    expect(unwrap(service.voteAnswer(S2, "a_store"))).toEqual({ helpfulCount: 5 });
    expect(code(service.voteAnswer(S2, "a_store"))).toBe("DUPLICATE");
  });

  test("concurrent Promise.all double vote counts once", async () => {
    const { db, service } = setup();
    const q = ask(service, S1);
    const a = unwrap(service.answer(S1, { questionId: q.id, body: "yes" }));
    const qResults = await Promise.all([
      Promise.resolve().then(() => service.voteQuestion(S2, q.id)),
      Promise.resolve().then(() => service.voteQuestion(S2, q.id)),
    ]);
    const aResults = await Promise.all([
      Promise.resolve().then(() => service.voteAnswer(S2, a.id)),
      Promise.resolve().then(() => service.voteAnswer(S2, a.id)),
    ]);
    for (const results of [qResults, aResults]) {
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map(code)).toEqual(["DUPLICATE"]);
    }
    expect(db.query<{ n: number }, [string]>("SELECT helpful_count AS n FROM questions WHERE id = ?").get(q.id)?.n).toBe(1);
    expect(db.query<{ n: number }, [string]>("SELECT helpful_count AS n FROM answers WHERE id = ?").get(a.id)?.n).toBe(1);
  });

  test("invalid session is INVALID_INPUT and writes nothing", () => {
    const { db, service } = setup();
    const q = ask(service, S1);
    expect(code(service.voteQuestion("seed_voter_01", q.id))).toBe("INVALID_INPUT");
    expect(code(service.voteAnswer("", "x"))).toBe("INVALID_INPUT");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM question_votes").get()?.n).toBe(0);
  });
});

describe("list and count", () => {
  test("questions by helpful desc then recency; hidden excluded; counts correct", () => {
    const { db, service } = setup();
    const older = ask(service, S1, "Older question here?", PRODUCT, T0 - 2000);
    const newer = ask(service, S1, "Newer question here?", PRODUCT, T0 - 1000);
    const popular = ask(service, S1, "Popular question here?", PRODUCT, T0 - 5000);
    const hidden = ask(service, S1, "Hidden question here?", PRODUCT, T0);
    ask(service, S1, "Other product question?", OTHER_PRODUCT);
    unwrap(service.voteQuestion(S2, popular.id));
    db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(hidden.id);

    const r = unwrap(service.list(PRODUCT));
    expect(r.items.map((q) => q.id)).toEqual([popular.id, newer.id, older.id]);
    expect(r).toMatchObject({ total: 3, page: 1, pageCount: 1 });
    expect(service.count(PRODUCT)).toBe(3);
    expect(service.count(OTHER_PRODUCT)).toBe(1);
    expect(service.count("prod_nope")).toBe(0);
  });

  test("answers nested: store first, then helpful desc, then recency; hidden excluded", () => {
    const { db, service } = setup();
    const q = ask(service, S1);
    const old = unwrap(service.answer(S2, { questionId: q.id, body: "old" }, T0 - 3000));
    const recent = unwrap(service.answer(S2, { questionId: q.id, body: "recent" }, T0 - 1000));
    const helpful = unwrap(service.answer(S3, { questionId: q.id, body: "helpful" }, T0 - 9000));
    const hidden = unwrap(service.answer(S3, { questionId: q.id, body: "hidden" }, T0));
    unwrap(service.voteAnswer(S1, helpful.id));
    unwrap(service.voteAnswer(S2, helpful.id));
    insertStoreAnswer(db, "a_store_low", q.id, 0, "2026-01-01T00:00:00.000Z");
    db.query("UPDATE answers SET status = 'hidden' WHERE id = ?").run(hidden.id);

    const [item] = unwrap(service.list(PRODUCT)).items;
    expect(item?.answers.map((a) => a.id)).toEqual(["a_store_low", helpful.id, recent.id, old.id]);
    expect(item?.answers[0]?.isStore).toBe(true);
  });

  test("pagination over 12 questions: 3 pages, no gaps or duplicates, stable under ties", () => {
    const { service } = setup();
    const created: string[] = [];
    for (let i = 0; i < 12; i++) {
      // Pairs share a timestamp so the id tie-breaker is exercised.
      created.push(ask(service, S1, `Question number ${i} here?`, PRODUCT, T0 - Math.floor(i / 2) * 1000).id);
    }
    const pages = [1, 2, 3].map((page) => unwrap(service.list(PRODUCT, { page })));
    expect(pages.map((p) => p.items.length)).toEqual([QA_PAGE_SIZE, QA_PAGE_SIZE, 2]);
    for (const p of pages) expect(p).toMatchObject({ total: 12, pageCount: 3 });
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    const seen = pages.flatMap((p) => p.items.map((q) => q.id));
    expect(new Set(seen).size).toBe(12);
    expect([...seen].sort()).toEqual([...created].sort());
  });

  test("page normalisation: invalid -> 1, past the end -> last page; empty product -> 1 of 1", () => {
    const { service } = setup();
    for (let i = 0; i < 7; i++) ask(service, S1, `Question number ${i} here?`);
    expect(unwrap(service.list(PRODUCT, { page: 0 })).page).toBe(1);
    expect(unwrap(service.list(PRODUCT, { page: -3 })).page).toBe(1);
    expect(unwrap(service.list(PRODUCT, { page: 1.5 })).page).toBe(1);
    expect(unwrap(service.list(PRODUCT, { page: Number.NaN })).page).toBe(1);
    const last = unwrap(service.list(PRODUCT, { page: 99 }));
    expect(last).toMatchObject({ page: 2, pageCount: 2 });
    expect(last.items).toHaveLength(2);
    expect(unwrap(service.list(OTHER_PRODUCT))).toEqual({ items: [], total: 0, page: 1, pageCount: 1 });
  });

  test("unknown or unpublished product is PRODUCT_NOT_FOUND", () => {
    const { db, service } = setup();
    addProduct(db, "prod_future", "2099-01-01T00:00:00.000Z");
    expect(code(service.list("prod_nope"))).toBe("PRODUCT_NOT_FOUND");
    expect(code(service.list("prod_future"))).toBe("PRODUCT_NOT_FOUND");
  });

  test("viewer flags: isOwn / votedByViewer present for a valid viewer, absent otherwise", () => {
    const { service } = setup();
    const mine = ask(service, S1, "My own question here?", PRODUCT, T0 - 1000);
    const theirs = ask(service, S2, "Their question here?", PRODUCT, T0);
    const myAnswer = unwrap(service.answer(S1, { questionId: theirs.id, body: "mine" }));
    const theirAnswer = unwrap(service.answer(S3, { questionId: theirs.id, body: "theirs" }));
    unwrap(service.voteQuestion(S1, theirs.id));
    unwrap(service.voteAnswer(S1, theirAnswer.id));

    const viewed = unwrap(service.list(PRODUCT, {}, S1)).items;
    const t = viewed.find((q) => q.id === theirs.id);
    const m = viewed.find((q) => q.id === mine.id);
    expect(t).toMatchObject({ isOwn: false, votedByViewer: true });
    expect(m).toMatchObject({ isOwn: true, votedByViewer: false });
    expect(t?.answers.find((a) => a.id === myAnswer.id)).toMatchObject({ isOwn: true, votedByViewer: false });
    expect(t?.answers.find((a) => a.id === theirAnswer.id)).toMatchObject({ isOwn: false, votedByViewer: true });

    for (const viewer of [undefined, null, "not-a-uuid"]) {
      const anon = unwrap(service.list(PRODUCT, {}, viewer)).items;
      for (const q of anon) {
        expect("isOwn" in q).toBe(false);
        expect("votedByViewer" in q).toBe(false);
        for (const a of q.answers) expect("isOwn" in a || "votedByViewer" in a).toBe(false);
      }
    }
  });

  test("views never contain author session ids", () => {
    const { service } = setup();
    const q = ask(service, S1);
    unwrap(service.answer(S2, { questionId: q.id, body: "yes" }));
    const json = JSON.stringify([unwrap(service.list(PRODUCT, {}, S3)), service.listMine(S1), service.listMine(S2)]);
    expect(json).not.toContain(S1);
    expect(json).not.toContain(S2);
    expect(json).not.toContain(S3);
    expect(json).not.toMatch(/session/i);
  });

  test("seeded data: store answers listed first for every seeded question and no seed keys leak", () => {
    // Seed timestamps are relative to the real clock, so this test uses it too.
    const { db } = setup({ seed: true });
    const service = createQaService({ db });
    const products = db
      .query<{ product_id: string }, []>("SELECT DISTINCT product_id FROM questions WHERE id LIKE 'q_seed%'")
      .all()
      .map((r) => r.product_id);
    expect(products.length).toBeGreaterThan(0);
    let storeAnswers = 0;
    for (const productId of products) {
      const r = unwrap(service.list(productId));
      expect(r.total).toBe(service.count(productId));
      expect(JSON.stringify(r)).not.toMatch(/seed_(session|voter|store)/);
      for (const q of r.items) {
        const flags = q.answers.map((a) => a.isStore);
        storeAnswers += flags.filter(Boolean).length;
        expect(flags).toEqual([...flags].sort((x, y) => Number(y) - Number(x)));
      }
    }
    expect(storeAnswers).toBeGreaterThan(0);
  });
});

describe("listMine", () => {
  test("returns only the session's questions and answers, newest first, any status", () => {
    const { db, service } = setup();
    const q1 = ask(service, S1, "First question by one?", PRODUCT, T0 - 2000);
    const q2 = ask(service, S1, "Second question by one?", OTHER_PRODUCT, T0 - 1000);
    const other = ask(service, S2, "Question by two here?");
    const a1 = unwrap(service.answer(S1, { questionId: other.id, body: "answer by one" }));
    unwrap(service.answer(S2, { questionId: q1.id, body: "answer by two" }));
    db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(q1.id);

    const mine = service.listMine(S1);
    expect(mine.questions.map((q) => q.id)).toEqual([q2.id, q1.id]);
    expect(mine.questions[1]?.status).toBe("hidden");
    expect(mine.answers.map((a) => a.id)).toEqual([a1.id]);
    expect(service.listMine(S3)).toEqual({ questions: [], answers: [] });
    expect(service.listMine("bogus")).toEqual({ questions: [], answers: [] });
  });
});

describe("listMineWithAnswers", () => {
  test("own questions carry their answers; own answers carry their question; any status", () => {
    const { db, service } = setup();
    const q1 = ask(service, S1, "First question by one?", PRODUCT, T0 - 2000);
    const q2 = ask(service, S1, "Second question by one?", OTHER_PRODUCT, T0 - 1000);
    const other = ask(service, S2, "Question by two here?");
    const mineOnOther = unwrap(service.answer(S1, { questionId: other.id, body: "answer by one" }, T0 + 10));
    const byTwo = unwrap(service.answer(S2, { questionId: q1.id, body: "answer by two" }, T0 + 20));
    const hiddenByTwo = unwrap(service.answer(S2, { questionId: q1.id, body: "hidden by two" }, T0 + 30));
    const ownHidden = unwrap(service.answer(S1, { questionId: q1.id, body: "own hidden" }, T0 + 40));
    insertStoreAnswer(db, "store_1", q1.id);
    unwrap(service.voteAnswer(S1, byTwo.id));
    db.query("UPDATE answers SET status = 'hidden' WHERE id IN (?, ?)").run(hiddenByTwo.id, ownHidden.id);
    db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(q1.id);
    db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(other.id);

    const mine = service.listMineWithAnswers(S1);
    expect(mine.questions.map((q) => [q.id, q.status, q.isOwn])).toEqual([
      [q2.id, "published", true],
      [q1.id, "hidden", true],
    ]);
    expect(mine.questions[0]?.answers).toEqual([]);
    const nested = mine.questions[1]?.answers ?? [];
    // published answers in PDP order (store first), then own unpublished; others' hidden answers never shown
    expect(nested.map((a) => a.id)).toEqual(["store_1", byTwo.id, ownHidden.id]);
    expect(nested.map((a) => a.isOwn)).toEqual([false, false, true]);
    expect(nested.find((a) => a.id === byTwo.id)?.votedByViewer).toBe(true);
    expect(nested.map((a) => a.id)).not.toContain(hiddenByTwo.id);

    expect(mine.answers.map((a) => a.id)).toEqual([ownHidden.id, mineOnOther.id]);
    expect(mine.answers[0]?.question.id).toBe(q1.id);
    expect(mine.answers[1]?.question).toMatchObject({ id: other.id, productId: PRODUCT, status: "hidden" });
    expect(mine.answers.every((a) => a.isOwn === true)).toBe(true);
    // listMine keeps its flat shape (no nested answers)
    expect(service.listMine(S1).questions.every((q) => q.answers === undefined)).toBe(true);
  });

  test("other owners and bad keys get nothing; no owner keys in the output", () => {
    const { service } = setup();
    const q = ask(service, S1);
    unwrap(service.answer(S2, { questionId: q.id, body: "yes" }));
    expect(service.listMineWithAnswers(S3)).toEqual({ questions: [], answers: [] });
    expect(service.listMineWithAnswers("bogus")).toEqual({ questions: [], answers: [] });
    const json = JSON.stringify([service.listMineWithAnswers(S1), service.listMineWithAnswers(S2)]);
    for (const key of [S1, S2, S3]) expect(json).not.toContain(key);
    expect(json).not.toMatch(/session/i);
  });

  test("bad owner key runs no SQL", () => {
    const db = new Proxy({}, {
      get: () => () => {
        throw new Error("SQL must not run");
      },
    }) as unknown as Database;
    const service = createQaService({ db });
    expect(service.listMineWithAnswers("")).toEqual({ questions: [], answers: [] });
    expect(service.listMineWithAnswers(`${S1} `)).toEqual({ questions: [], answers: [] });
  });
});

describe("transactions and singleton", () => {
  test("a repository failure mid-write rolls back and propagates", () => {
    const { db } = setup();
    const service = createQaService({ db, now: () => T0, newId: () => "fixed" });
    unwrap(service.ask(S1, { productId: PRODUCT, body: QUESTION }));
    // Same id again -> PRIMARY KEY violation inside the transaction.
    expect(() => service.ask(S1, { productId: PRODUCT, body: "Another question here?" })).toThrow();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM questions").get()?.n).toBe(1);
  });

  test("getQaService is a singleton over the shared database", () => {
    const prev = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ":memory:";
    try {
      const a = getQaService();
      expect(getQaService()).toBe(a);
      closeDatabase();
      expect(getQaService()).not.toBe(a);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = prev;
    }
  });
});

// Type-level: the result types are the domain types (no author keys).
const _typecheck: (s: QaService) => [Result<Question, AppError>, Result<Answer, AppError>] = (s) => [
  s.ask(S1, { productId: PRODUCT, body: "" }),
  s.answer(S1, { questionId: "", body: "" }),
];
void _typecheck;
