/**
 * QA adversarial tests for T35 (Q&A service), src/server/qa/**.
 * Owned by QA (QA-W1-T35). In-memory DB + seedDatabase; worker-thread races
 * and the lock test use a temp file under os.tmpdir() (never ./data).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppError, Result } from "@/lib/result";
import { closeDatabase, createDatabase, getDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  DEFAULT_DISPLAY_NAME,
  QA_PAGE_SIZE,
  createQaService,
  getQaService,
  type QaService,
} from "@/server/qa/qa-service";

const A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const B = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const C = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const D = "d4c3b2a1-0f9e-4d8c-a7b6-5a4f3e2d1c0b";
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const QA_DIR = join(import.meta.dir, "../../../src/server/qa");
const Q = "Does this come with a carrying case?";

const open: Database[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  closeDatabase();
});
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function addProduct(db: Database, id: string, publishedAt = "2020-01-01T00:00:00.000Z"): void {
  db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES (?, ?, ?, 1000, 'USD', '/x.svg', 5, ?)",
  ).run(id, `${id}-slug`, `QA ${id}`, publishedAt);
}

interface Harness {
  readonly db: Database;
  readonly svc: QaService;
  tick(ms?: number): void;
}

function harness(opts: { seed?: boolean; db?: Database } = {}): Harness {
  const db = opts.db ?? createDatabase(":memory:");
  if (opts.db === undefined) {
    runMigrations(db);
    if (opts.seed !== false) seedDatabase(db);
    open.push(db);
  }
  addProduct(db, "qa-p1");
  addProduct(db, "qa-p2");
  addProduct(db, "qa-future", "2099-01-01T00:00:00.000Z");
  let clock = T0;
  const svc = createQaService({ db, now: () => clock });
  return {
    db,
    svc,
    tick(ms = 1000) {
      clock += ms;
    },
  };
}

function unwrap<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.value)}`);
  return r.error;
}

function n(db: Database, sql: string, ...params: string[]): number {
  return db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params)!.n;
}

function ask(h: Harness, s: string, body = Q, productId = "qa-p1"): string {
  h.tick();
  return unwrap(h.svc.ask(s, { productId, body })).id;
}

function answer(h: Harness, s: string, questionId: string, body = "Yes, it does."): string {
  h.tick();
  return unwrap(h.svc.answer(s, { questionId, body })).id;
}

/** Proxy that records every SQL-running member access. */
function spyDb(db: Database): { db: Database; calls: string[] } {
  const calls: string[] = [];
  const SQL = new Set(["query", "prepare", "run", "exec", "transaction"]);
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && SQL.has(prop)) calls.push(prop);
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: proxy, calls };
}

// ---------------------------------------------------------------------------
describe("crit 1: ask", () => {
  test("length bounds measured after cleaning: 9 -> VALIDATION_FAILED, 10 ok, 300 ok, 301 -> TOO_LONG, details.field body", () => {
    const h = harness();
    const short = errorOf(h.svc.ask(A, { productId: "qa-p1", body: "  123456789​\u0000  " }));
    expect(short.code).toBe("VALIDATION_FAILED");
    expect(short.details?.field).toBe("body");
    expect(unwrap(h.svc.ask(A, { productId: "qa-p1", body: "   1234567890   " })).body).toBe("1234567890");
    const max = "x".repeat(300);
    expect(unwrap(h.svc.ask(A, { productId: "qa-p1", body: `  ${max}\n\n` })).body).toBe(max);
    const long = errorOf(h.svc.ask(A, { productId: "qa-p1", body: "y".repeat(301) }));
    expect(long.code).toBe("TOO_LONG");
    expect(long.details?.field).toBe("body");
    // 300 visible chars padded with whitespace and zero-widths (raw < 4x) is still accepted.
    const padded = "z".repeat(300).split("").join("​");
    expect(unwrap(h.svc.ask(B, { productId: "qa-p1", body: padded })).body).toBe("z".repeat(300));
  });

  test("questions are single-line: newlines collapse to one space", () => {
    const h = harness();
    const r = unwrap(h.svc.ask(A, { productId: "qa-p1", body: "Line one\n\n\nline two\r\nthree" }));
    expect(r.body).toBe("Line one line two three");
  });

  test("missing / empty / whitespace body -> VALIDATION_FAILED; non-string -> INVALID_INPUT", () => {
    const h = harness();
    for (const body of [undefined, null, "", "   \n\t ", "​​"]) {
      expect(errorOf(h.svc.ask(A, { productId: "qa-p1", body })).code).toBe("VALIDATION_FAILED");
    }
    for (const body of [42, {}, [], true, { toString: () => Q }]) {
      expect(errorOf(h.svc.ask(A, { productId: "qa-p1", body })).code).toBe("INVALID_INPUT");
    }
    expect(n(h.db, "questions WHERE product_id = 'qa-p1'")).toBe(0);
  });

  test("display name: default, cleaned, 50 ok, 51 -> TOO_LONG details.field displayName, non-string -> INVALID_INPUT", () => {
    const h = harness();
    for (const displayName of [undefined, null, "", "   ", "​"]) {
      h.tick();
      const q = unwrap(h.svc.ask(A, { productId: "qa-p1", body: `${Q} ${h.svc.count("qa-p1")}`, displayName }));
      expect(q.displayName).toBe(DEFAULT_DISPLAY_NAME);
    }
    expect(DEFAULT_DISPLAY_NAME).toBe("Anonymous shopper");
    expect(unwrap(h.svc.ask(B, { productId: "qa-p1", body: Q, displayName: "  Ann\n  B\u0000 " })).displayName).toBe("Ann B");
    expect(unwrap(h.svc.ask(C, { productId: "qa-p1", body: Q, displayName: "n".repeat(50) })).displayName).toBe("n".repeat(50));
    const long = errorOf(h.svc.ask(D, { productId: "qa-p1", body: Q, displayName: "n".repeat(51) }));
    expect(long.code).toBe("TOO_LONG");
    expect(long.details?.field).toBe("displayName");
    const bad = errorOf(h.svc.ask(D, { productId: "qa-p1", body: Q, displayName: 7 }));
    expect(bad.code).toBe("INVALID_INPUT");
    expect(bad.details?.field).toBe("displayName");
  });

  test("countUrls > 2 -> VALIDATION_FAILED reason TOO_MANY_URLS; exactly 2 ok (ask and answer)", () => {
    const h = harness();
    const two = "See http://a.example and www.b.example ok";
    expect(unwrap(h.svc.ask(A, { productId: "qa-p1", body: two })).body).toBe(two);
    const three = errorOf(h.svc.ask(A, { productId: "qa-p1", body: `${two} https://c.example` }));
    expect(three.code).toBe("VALIDATION_FAILED");
    expect(three.details?.reason).toBe("TOO_MANY_URLS");
    expect(three.details?.field).toBe("body");
    const qid = ask(h, B);
    const a3 = errorOf(h.svc.answer(A, { questionId: qid, body: "http://x.io\nhttp://y.io\nHTTPS://Z.IO" }));
    expect(a3.code).toBe("VALIDATION_FAILED");
    expect(a3.details?.reason).toBe("TOO_MANY_URLS");
  });

  test("DUPLICATE on identical cleaned text, same owner + product; hidden earlier question counts; other owner/product ok", () => {
    const h = harness();
    const first = ask(h, A, "Is it   safe for kids?");
    const dup = errorOf(h.svc.ask(A, { productId: "qa-p1", body: " Is it safe​ for kids? " }));
    expect(dup.code).toBe("DUPLICATE");
    h.db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(first);
    expect(errorOf(h.svc.ask(A, { productId: "qa-p1", body: "Is it safe for kids?" })).code).toBe("DUPLICATE");
    ask(h, B, "Is it safe for kids?");
    ask(h, A, "Is it safe for kids?", "qa-p2");
    expect(n(h.db, "questions WHERE session_id = ?", A)).toBe(2);
  });

  test("PRODUCT_NOT_FOUND for unknown, unpublished, hostile and non-string ids; nothing inserted", () => {
    const h = harness();
    const before = n(h.db, "questions");
    for (const productId of ["nope", "qa-future", "' OR 1=1 --", "%", "", "p".repeat(5000), 5, null, {}]) {
      expect(errorOf(h.svc.ask(A, { productId: productId as string, body: Q })).code).toBe("PRODUCT_NOT_FOUND");
    }
    expect(n(h.db, "questions")).toBe(before);
  });

  test("future product becomes askable once its published_at passes (per-call now)", () => {
    const h = harness();
    expect(errorOf(h.svc.ask(A, { productId: "qa-future", body: Q })).code).toBe("PRODUCT_NOT_FOUND");
    expect(unwrap(h.svc.ask(A, { productId: "qa-future", body: Q }, Date.parse("2099-06-01T00:00:00Z"))).productId).toBe(
      "qa-future",
    );
  });
});

// ---------------------------------------------------------------------------
describe("crit 2: answer", () => {
  test("1..1000 after cleaning; line breaks kept; 1001 -> TOO_LONG; empty -> VALIDATION_FAILED; details.field", () => {
    const h = harness();
    const qid = ask(h, A);
    expect(unwrap(h.svc.answer(B, { questionId: qid, body: " y " })).body).toBe("y");
    expect(unwrap(h.svc.answer(B, { questionId: qid, body: "Line 1\r\nLine 2\n\n\n\nLine 3" })).body).toBe(
      "Line 1\nLine 2\n\nLine 3",
    );
    expect(unwrap(h.svc.answer(B, { questionId: qid, body: "a".repeat(1000) })).body.length).toBe(1000);
    const long = errorOf(h.svc.answer(C, { questionId: qid, body: "a".repeat(1001) }));
    expect(long.code).toBe("TOO_LONG");
    expect(long.details?.field).toBe("body");
    const empty = errorOf(h.svc.answer(C, { questionId: qid, body: " \n​ " }));
    expect(empty.code).toBe("VALIDATION_FAILED");
    expect(empty.details?.field).toBe("body");
    expect(errorOf(h.svc.answer(C, { questionId: qid, body: "ok", displayName: "x".repeat(51) })).details?.field).toBe(
      "displayName",
    );
  });

  test("NOT_FOUND for unknown, hidden question, or unpublished product", () => {
    const h = harness();
    const qid = ask(h, A);
    for (const questionId of ["nope", "", "' OR 1=1 --", 3, null]) {
      expect(errorOf(h.svc.answer(B, { questionId: questionId as string, body: "x" })).code).toBe("NOT_FOUND");
    }
    h.db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(qid);
    expect(errorOf(h.svc.answer(B, { questionId: qid, body: "x" })).code).toBe("NOT_FOUND");
    const q2 = ask(h, A, Q, "qa-p2");
    h.db.query("UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE id = 'qa-p2'").run();
    expect(errorOf(h.svc.answer(B, { questionId: q2, body: "x" })).code).toBe("NOT_FOUND");
    expect(n(h.db, "answers WHERE session_id = ?", B)).toBe(0);
  });

  test("4th answer by the same owner -> LIMIT_REACHED (hidden answers count); other owners unaffected", () => {
    const h = harness();
    const qid = ask(h, A);
    const ids = [answer(h, B, qid, "one"), answer(h, B, qid, "two"), answer(h, B, qid, "three")];
    const fourth = errorOf(h.svc.answer(B, { questionId: qid, body: "four" }));
    expect(fourth.code).toBe("LIMIT_REACHED");
    expect(fourth.details?.limit).toBe(3);
    h.db.query("UPDATE answers SET status = 'hidden' WHERE id = ?").run(ids[0]!);
    expect(errorOf(h.svc.answer(B, { questionId: qid, body: "four" })).code).toBe("LIMIT_REACHED");
    answer(h, C, qid);
    answer(h, A, qid, "own question, own answer is allowed");
    expect(n(h.db, "answers WHERE question_id = ? AND session_id = ?", qid, B)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe("crit 3: is_store can never be set", () => {
  test("type level: isStore is not an accepted key", () => {
    const h = harness();
    const qid = ask(h, A);
    // @ts-expect-error isStore is not part of the answer input type
    const r = h.svc.answer(B, { questionId: qid, body: "Official!", isStore: true });
    expect(unwrap(r).isStore).toBe(false);
  });

  test("runtime: extra keys (isStore, is_store, status, helpfulCount, sessionId, id) ignored; rows have is_store=0", () => {
    const h = harness();
    const qid = ask(h, A);
    const hostile = {
      questionId: qid,
      body: "From the store",
      isStore: true,
      is_store: 1,
      status: "hidden",
      helpfulCount: 999,
      helpful_count: 999,
      sessionId: "seed_store",
      session_id: "seed_store",
      id: "a_forged",
    };
    const a = unwrap(h.svc.answer(B, hostile as { questionId: string; body: unknown }));
    expect(a.isStore).toBe(false);
    expect(a.helpfulCount).toBe(0);
    expect(a.status).toBe("published");
    expect(a.id).not.toBe("a_forged");
    const row = h.db
      .query<{ is_store: number; session_id: string }, [string]>("SELECT is_store, session_id FROM answers WHERE id = ?")
      .get(a.id)!;
    expect(row).toEqual({ is_store: 0, session_id: B });
    const qHostile = { productId: "qa-p1", body: "Another question here", helpfulCount: 50, status: "hidden", id: "q_forged" };
    const q = unwrap(h.svc.ask(C, qHostile as { productId: string; body: unknown }));
    expect(q.helpfulCount).toBe(0);
    expect(q.status).toBe("published");
    expect(q.id).not.toBe("q_forged");
  });

  test("source: no is_store parameter anywhere; only literal 0 is written", () => {
    const repo = readFileSync(join(QA_DIR, "qa-repository.ts"), "utf8");
    const svc = readFileSync(join(QA_DIR, "qa-service.ts"), "utf8");
    expect(repo).toMatch(/is_store, created_at\)\s*VALUES \(\?, \?, \?, \?, \?, 0, \?\)/);
    expect(svc).not.toMatch(/isStore\s*[:=]/);
    const newAnswerRow = repo.slice(repo.indexOf("export interface NewAnswerRow"), repo.indexOf("}", repo.indexOf("export interface NewAnswerRow")));
    expect(newAnswerRow).not.toMatch(/isStore|is_store/);
  });
});

// ---------------------------------------------------------------------------
describe("crit 4: votes", () => {
  test("one vote per owner per target -> DUPLICATE; own -> FORBIDDEN; hidden -> NOT_FOUND; counts fresh", () => {
    const h = harness();
    const qid = ask(h, A);
    const aid = answer(h, B, qid);
    expect(unwrap(h.svc.voteQuestion(B, qid)).helpfulCount).toBe(1);
    expect(unwrap(h.svc.voteQuestion(C, qid)).helpfulCount).toBe(2);
    expect(errorOf(h.svc.voteQuestion(B, qid)).code).toBe("DUPLICATE");
    expect(errorOf(h.svc.voteQuestion(A, qid)).code).toBe("FORBIDDEN");
    expect(unwrap(h.svc.voteAnswer(A, aid)).helpfulCount).toBe(1);
    expect(errorOf(h.svc.voteAnswer(A, aid)).code).toBe("DUPLICATE");
    expect(errorOf(h.svc.voteAnswer(B, aid)).code).toBe("FORBIDDEN");
    expect(n(h.db, "question_votes WHERE question_id = ?", qid)).toBe(2);
    expect(n(h.db, "answer_votes WHERE answer_id = ?", aid)).toBe(1);

    // hidden answer, and answer under a hidden question
    h.db.query("UPDATE answers SET status = 'hidden' WHERE id = ?").run(aid);
    expect(errorOf(h.svc.voteAnswer(C, aid)).code).toBe("NOT_FOUND");
    h.db.query("UPDATE answers SET status = 'published' WHERE id = ?").run(aid);
    h.db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(qid);
    expect(errorOf(h.svc.voteQuestion(D, qid)).code).toBe("NOT_FOUND");
    expect(errorOf(h.svc.voteAnswer(D, aid)).code).toBe("NOT_FOUND");
    for (const id of ["nope", "", "' OR 1=1 --", 5, null]) {
      expect(errorOf(h.svc.voteQuestion(D, id as string)).code).toBe("NOT_FOUND");
      expect(errorOf(h.svc.voteAnswer(D, id as string)).code).toBe("NOT_FOUND");
    }
  });

  test("seeded store answers can be voted by a real owner (seed_store is never a real key)", () => {
    const h = harness();
    const store = h.db
      .query<{ id: string }, []>("SELECT id FROM answers WHERE is_store = 1 AND status = 'published' LIMIT 1")
      .get();
    expect(store).not.toBeNull();
    const before = h.db.query<{ h: number }, [string]>("SELECT helpful_count AS h FROM answers WHERE id = ?").get(store!.id)!.h;
    expect(unwrap(h.svc.voteAnswer(A, store!.id)).helpfulCount).toBe(before + 1);
  });

  test("helpful_count equals vote rows after 200 random vote ops (seeded db + fresh content)", () => {
    const h = harness();
    const owners = [A, B, C, D];
    const qids = owners.map((o, i) => ask(h, o, `${Q} number ${i}`, i % 2 === 0 ? "qa-p1" : "qa-p2"));
    const aids = qids.flatMap((qid, i) => [answer(h, owners[(i + 1) % 4]!, qid), answer(h, owners[(i + 2) % 4]!, qid)]);
    const seededQ = h.db.query<{ id: string }, []>("SELECT id FROM questions WHERE id LIKE 'q_seed_%' LIMIT 6").all().map((r) => r.id);
    const seededA = h.db.query<{ id: string }, []>("SELECT id FROM answers WHERE id LIKE 'a_seed_%' LIMIT 6").all().map((r) => r.id);
    const allQ = [...qids, ...seededQ];
    const allA = [...aids, ...seededA];
    let seed = 12345;
    const rnd = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % max;
    };
    const tally: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      const owner = owners[rnd(owners.length)]!;
      const isQ = rnd(2) === 0;
      const target = isQ ? allQ[rnd(allQ.length)]! : allA[rnd(allA.length)]!;
      const r = isQ ? h.svc.voteQuestion(owner, target) : h.svc.voteAnswer(owner, target);
      if (r.ok) tally.ok = (tally.ok ?? 0) + 1;
      else tally[r.error.code] = (tally[r.error.code] ?? 0) + 1;
    }
    expect(tally.ok ?? 0).toBeGreaterThan(0);
    expect(tally.DUPLICATE ?? 0).toBeGreaterThan(0);
    expect(tally.FORBIDDEN ?? 0).toBeGreaterThan(0);
    const qDrift = h.db
      .query<{ id: string }, []>(
        "SELECT q.id FROM questions q WHERE q.helpful_count <> (SELECT COUNT(*) FROM question_votes v WHERE v.question_id = q.id)",
      )
      .all();
    const aDrift = h.db
      .query<{ id: string }, []>(
        "SELECT a.id FROM answers a WHERE a.helpful_count <> (SELECT COUNT(*) FROM answer_votes v WHERE v.answer_id = a.id)",
      )
      .all();
    expect(qDrift).toEqual([]);
    expect(aDrift).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("concurrency: worker threads on separate connections", () => {
  test(
    "10 double-votes -> 1 vote; 10 identical asks -> 1 row; 10 answers by one owner -> 3 rows",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "qa-t35-"));
      tmpDirs.push(dir);
      const dbPath = join(dir, "qa.sqlite");
      const db = createDatabase(dbPath);
      runMigrations(db);
      const h = harness({ db });
      const qid = ask(h, A);
      db.close();

      const workerSrc = join(dir, "worker.ts");
      writeFileSync(
        workerSrc,
        `import { createDatabase } from ${JSON.stringify(join(QA_DIR, "../db/client.ts"))};
import { createQaService } from ${JSON.stringify(join(QA_DIR, "qa-service.ts"))};
declare const self: Worker;
self.onmessage = (e: MessageEvent) => {
  const { dbPath, kind, session, qid, i } = e.data as { dbPath: string; kind: string; session: string; qid: string; i: number };
  const db = createDatabase(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");
  const svc = createQaService({ db, now: () => ${T0 + 60_000} });
  const r = kind === "vote" ? svc.voteQuestion(session, qid)
    : kind === "ask" ? svc.ask(session, { productId: "qa-p2", body: "Same racing question text" })
    : svc.answer(session, { questionId: qid, body: "racing answer " + i });
  db.close();
  postMessage(r.ok ? "ok" : r.error.code);
};
`,
      );
      const run = (kind: string, session: string, i: number) =>
        new Promise<string>((resolve, reject) => {
          const w = new Worker(workerSrc);
          w.onmessage = (e: MessageEvent) => {
            resolve(e.data as string);
            w.terminate();
          };
          w.onerror = (e) => reject(e);
          w.postMessage({ dbPath, kind, session, qid, i });
        });
      const out = await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => run("vote", B, i)),
        ...Array.from({ length: 10 }, (_, i) => run("ask", C, i)),
        ...Array.from({ length: 10 }, (_, i) => run("answer", D, i)),
      ]);
      const [votes, asks, answers] = [out.slice(0, 10), out.slice(10, 20), out.slice(20)];
      expect(votes.filter((x) => x === "ok").length).toBe(1);
      expect(votes.filter((x) => x === "DUPLICATE").length).toBe(9);
      expect(asks.filter((x) => x === "ok").length).toBe(1);
      expect(asks.filter((x) => x === "DUPLICATE").length).toBe(9);
      expect(answers.filter((x) => x === "ok").length).toBe(3);
      expect(answers.filter((x) => x === "LIMIT_REACHED").length).toBe(7);
      const check = createDatabase(dbPath);
      open.push(check);
      expect(check.query<{ h: number }, [string]>("SELECT helpful_count AS h FROM questions WHERE id = ?").get(qid)!.h).toBe(1);
      expect(n(check, "question_votes WHERE question_id = ?", qid)).toBe(1);
      expect(n(check, "questions WHERE session_id = ?", C)).toBe(1);
      expect(n(check, "answers WHERE session_id = ?", D)).toBe(3);
    },
    30_000,
  );

  test("list reads in a DEFERRED transaction: succeeds while another connection holds the write lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-t35-lock-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "qa.sqlite");
    const db = createDatabase(dbPath);
    runMigrations(db);
    open.push(db);
    const h = harness({ db });
    ask(h, A);
    const writer = createDatabase(dbPath);
    open.push(writer);
    db.exec("PRAGMA busy_timeout = 0");
    writer.exec("BEGIN IMMEDIATE");
    try {
      const r = unwrap(h.svc.list("qa-p1"));
      expect(r.total).toBe(1);
      // control: a write on the reader connection does fail while the lock is held
      expect(() => h.svc.ask(B, { productId: "qa-p1", body: "Will this be blocked?" })).toThrow();
    } finally {
      writer.exec("ROLLBACK");
    }
  });

  test("list uses db.transaction(...).deferred(), not immediate/exclusive", () => {
    const h = harness();
    const used: string[] = [];
    const proxy = new Proxy(h.db, {
      get(target, prop, receiver) {
        const v: unknown = Reflect.get(target, prop, receiver);
        if (prop === "transaction") {
          return (fn: (...args: unknown[]) => unknown) => {
            const tx = target.transaction(fn);
            return new Proxy(tx, {
              get(t, p, r) {
                const inner: unknown = Reflect.get(t, p, r);
                if (typeof p === "string" && ["deferred", "immediate", "exclusive"].includes(p)) used.push(p);
                return inner;
              },
              apply(t, thisArg, args) {
                used.push("default");
                return Reflect.apply(t, thisArg, args);
              },
            });
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const svc = createQaService({ db: proxy, now: () => T0 });
    unwrap(svc.list("qa-p1"));
    expect(used).toEqual(["deferred"]);
  });
});

// ---------------------------------------------------------------------------
describe("crit 5: list", () => {
  test("3 pages of 12 equal-rank questions: no gaps/duplicates, id DESC tiebreak, page past end -> last, bad page -> 1", () => {
    const h = harness();
    const ids: string[] = [];
    let i = 0;
    const svc = createQaService({ db: h.db, now: () => T0, newId: () => `qa-id-${String((i++ * 7) % 12).padStart(2, "0")}` });
    for (let k = 0; k < 12; k++) ids.push(unwrap(svc.ask(A, { productId: "qa-p1", body: `${Q} variant ${k}` })).id);
    const pages = [1, 2, 3].map((p) => unwrap(svc.list("qa-p1", { page: p })));
    for (const p of pages) {
      expect(p.total).toBe(12);
      expect(p.pageCount).toBe(3);
    }
    expect(pages.map((p) => p.items.length)).toEqual([5, 5, 2]);
    const seen = pages.flatMap((p) => p.items.map((q) => q.id));
    expect(new Set(seen).size).toBe(12);
    expect(seen).toEqual([...ids].sort().reverse());
    expect(unwrap(svc.list("qa-p1", { page: 99 })).page).toBe(3);
    expect(unwrap(svc.list("qa-p1", { page: 99 })).items.map((q) => q.id)).toEqual(seen.slice(10));
    for (const page of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2" as unknown as number, undefined]) {
      expect(unwrap(svc.list("qa-p1", { page })).page).toBe(1);
    }
    expect(QA_PAGE_SIZE).toBe(5);
  });

  test("helpful desc then recency; answers store-first, then helpful, then recency; hidden excluded; counts", () => {
    const h = harness();
    const q1 = ask(h, A, "Oldest but most helpful?");
    const q2 = ask(h, A, "Middle question with none?");
    const q3 = ask(h, A, "Newest question with none?");
    const hiddenQ = ask(h, A, "Hidden question here ok?");
    h.svc.voteQuestion(B, q1);
    h.db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(hiddenQ);
    const aOld = answer(h, B, q1, "old community");
    const aHelpful = answer(h, C, q1, "helpful community");
    const aNew = answer(h, D, q1, "new community");
    const aHidden = answer(h, B, q1, "hidden community");
    h.db.query("UPDATE answers SET status = 'hidden' WHERE id = ?").run(aHidden);
    h.svc.voteAnswer(A, aHelpful);
    h.db
      .query(
        "INSERT INTO answers (id, question_id, session_id, display_name, body, is_store, created_at) VALUES ('qa-store', ?, 'seed_store', 'Store', 'Official', 1, '2001-01-01T00:00:00.000Z')",
      )
      .run(q1);
    const r = unwrap(h.svc.list("qa-p1"));
    expect(r.total).toBe(3);
    expect(r.items.map((q) => q.id)).toEqual([q1, q3, q2]);
    expect(r.items[0]!.answers.map((a) => a.id)).toEqual(["qa-store", aHelpful, aNew, aOld]);
    expect(r.items[1]!.answers).toEqual([]);
    expect(h.svc.count("qa-p1")).toBe(3);
  });

  test("empty product: page 1 of 1, total 0; unknown/unpublished product -> PRODUCT_NOT_FOUND", () => {
    const h = harness();
    expect(unwrap(h.svc.list("qa-p2", { page: 4 }))).toEqual({ items: [], total: 0, page: 1, pageCount: 1 });
    for (const id of ["nope", "qa-future", "' OR 1=1 --", 5 as unknown as string]) {
      expect(errorOf(h.svc.list(id)).code).toBe("PRODUCT_NOT_FOUND");
    }
  });

  test("viewer flags only with a valid viewer key; isOwn/votedByViewer correct per viewer (two-session isolation)", () => {
    const h = harness();
    const qa = ask(h, A, "Asked by owner A here?");
    const qb = ask(h, B, "Asked by owner B here?");
    const ab = answer(h, B, qa);
    h.svc.voteQuestion(B, qa);
    h.svc.voteAnswer(A, ab);
    for (const viewer of [undefined, null, "", "not-a-uuid", "seed_store", A.toUpperCase() + "x", ` ${A}`]) {
      const r = unwrap(h.svc.list("qa-p1", {}, viewer));
      for (const q of r.items) {
        expect("isOwn" in q).toBe(false);
        expect("votedByViewer" in q).toBe(false);
        for (const a of q.answers) {
          expect("isOwn" in a).toBe(false);
          expect("votedByViewer" in a).toBe(false);
        }
      }
    }
    const asA = unwrap(h.svc.list("qa-p1", {}, A)).items;
    const asB = unwrap(h.svc.list("qa-p1", {}, B)).items;
    const byId = (items: typeof asA, id: string) => items.find((q) => q.id === id)!;
    expect([byId(asA, qa).isOwn, byId(asA, qa).votedByViewer, byId(asA, qb).isOwn]).toEqual([true, false, false]);
    expect([byId(asB, qa).isOwn, byId(asB, qa).votedByViewer, byId(asB, qb).isOwn]).toEqual([false, true, true]);
    expect(byId(asA, qa).answers[0]).toMatchObject({ id: ab, isOwn: false, votedByViewer: true });
    expect(byId(asB, qa).answers[0]).toMatchObject({ id: ab, isOwn: true, votedByViewer: false });
    const asC = unwrap(h.svc.list("qa-p1", {}, C)).items;
    expect(asC.every((q) => q.isOwn === false && q.votedByViewer === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("crit 7: listMine", () => {
  test("only the owner's questions/answers, includes hidden with status, newest first, no answers nested", () => {
    const h = harness();
    const q1 = ask(h, A, "First question by A ok?");
    const q2 = ask(h, A, "Second question by A ok?", "qa-p2");
    ask(h, B, "Question by B here ok?");
    const a1 = answer(h, A, q1, "A answers own");
    answer(h, B, q1, "B answers");
    h.db.query("UPDATE questions SET status = 'hidden' WHERE id = ?").run(q1);
    const mine = h.svc.listMine(A);
    expect(mine.questions.map((q) => [q.id, q.status])).toEqual([
      [q2, "published"],
      [q1, "hidden"],
    ]);
    expect(mine.questions.every((q) => q.answers === undefined)).toBe(true);
    expect(mine.answers.map((a) => a.id)).toEqual([a1]);
    expect(h.svc.listMine(C)).toEqual({ questions: [], answers: [] });
    // seed rows are never returned for real keys
    expect(h.svc.listMine(B).questions.every((q) => !q.id.startsWith("q_seed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("owner keys never leak", () => {
  test("serialised list (every seeded product, with and without viewer) and listMine never contain keys or seed ids", () => {
    const h = harness();
    const qid = ask(h, A);
    answer(h, B, qid);
    h.svc.voteQuestion(C, qid);
    const products = h.db.query<{ id: string }, []>("SELECT DISTINCT product_id AS id FROM questions").all();
    expect(products.length).toBeGreaterThan(10);
    const blobs: string[] = [];
    for (const { id } of products) {
      for (const viewer of [undefined, A, B, C]) {
        const r = h.svc.list(id, {}, viewer);
        if (r.ok) blobs.push(JSON.stringify(r.value));
      }
    }
    for (const k of [A, B, C]) blobs.push(JSON.stringify(h.svc.listMine(k)));
    const all = blobs.join("\n");
    expect(all).toContain("\"isStore\":true"); // sanity: store answers are in the output
    for (const secret of [A, B, C, "seed_store", "seed_voter", "seed_session", "session_id", "sessionId"]) {
      expect(all).not.toContain(secret);
    }
  });

  test("ask/answer/vote results contain no owner key", () => {
    const h = harness();
    const q = unwrap(h.svc.ask(A, { productId: "qa-p1", body: Q }));
    const a = unwrap(h.svc.answer(B, { questionId: q.id, body: "yes" }));
    const v = unwrap(h.svc.voteAnswer(A, a.id));
    const s = JSON.stringify([q, a, v]);
    expect(s).not.toContain(A);
    expect(s).not.toContain(B);
  });
});

// ---------------------------------------------------------------------------
describe("invalid owner key -> INVALID_INPUT / empty, no SQL", () => {
  test("ask/answer/vote/listMine never touch the db with a bad key (Proxy)", () => {
    const base = harness();
    const qid = ask(base, A);
    const spy = spyDb(base.db);
    const svc = createQaService({ db: spy.db, now: () => T0 });
    spy.calls.length = 0;
    const bad: unknown[] = [
      "",
      "abc",
      `${A} `,
      ` ${A}`,
      A.replace(/-/g, ""),
      "seed_store",
      "seed_voter_01",
      "' OR 1=1 --",
      "00000000-0000-0000-0000-000000000000",
      null,
      undefined,
      1,
      {},
      [],
      "x".repeat(10_000),
    ];
    for (const s of bad) {
      const key = s as string;
      expect(errorOf(svc.ask(key, { productId: "qa-p1", body: Q })).code).toBe("INVALID_INPUT");
      expect(errorOf(svc.answer(key, { questionId: qid, body: "x" })).code).toBe("INVALID_INPUT");
      expect(errorOf(svc.voteQuestion(key, qid)).code).toBe("INVALID_INPUT");
      expect(errorOf(svc.voteAnswer(key, "whatever")).code).toBe("INVALID_INPUT");
      expect(svc.listMine(key)).toEqual({ questions: [], answers: [] });
    }
    expect(spy.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("crit 6: hostile text stored as cleaned text, never throws", () => {
  const HOSTILE: Array<[string, string, string]> = [
    ["html", "<script>alert('x')</script><img src=x onerror=alert(1)>", "<script>alert('x')</script><img src=x onerror=alert(1)>"],
    ["rtl override", "Is this ‮gnp.exe‬ safe to open?", "Is this gnp.exe safe to open?"],
    ["rtl script", "هل هذا المنتج مناسب للأطفال؟", "هل هذا المنتج مناسب للأطفال؟"],
    ["zero-width", "Does​‌‍﻿ it fit well?", "Does it fit well?"],
    ["NUL + controls", "Is\u0000 it\u0007 \u001bwaterproof\u007f?", "Is it waterproof?"],
    ["__proto__", "__proto__ constructor prototype", "__proto__ constructor prototype"],
    ["sql", "'; DROP TABLE questions; -- ok", "'; DROP TABLE questions; -- ok"],
    ["emoji astral", "Is it \u{1F600} cute enough?", "Is it \u{1F600} cute enough?"],
  ];

  test.each(HOSTILE)("%s: question and answer stored verbatim after cleaning", (_label, raw, expected) => {
    const h = harness();
    const q = unwrap(h.svc.ask(A, { productId: "qa-p1", body: raw, displayName: raw.slice(0, 40) }));
    expect(q.body).toBe(expected);
    const row = h.db.query<{ body: string }, [string]>("SELECT body FROM questions WHERE id = ?").get(q.id)!;
    expect(row.body).toBe(expected);
    const a = unwrap(h.svc.answer(B, { questionId: q.id, body: raw }));
    expect(a.body).toBe(expected);
    const listed = unwrap(h.svc.list("qa-p1")).items[0]!;
    expect(listed.body).toBe(expected);
    expect(listed.answers[0]!.body).toBe(expected);
    expect(n(h.db, "questions")).toBeGreaterThan(0);
  });

  test("10k chars -> TOO_LONG (no throw); __proto__ display name stays a plain string", () => {
    const h = harness();
    expect(errorOf(h.svc.ask(A, { productId: "qa-p1", body: "a".repeat(10_000) })).code).toBe("TOO_LONG");
    const qid = ask(h, A);
    expect(errorOf(h.svc.answer(B, { questionId: qid, body: "<b>".repeat(10_000) })).code).toBe("TOO_LONG");
    expect(errorOf(h.svc.ask(A, { productId: "qa-p1", body: Q, displayName: "​".repeat(10_000) })).code).toBe("TOO_LONG");
    const q = unwrap(h.svc.ask(C, { productId: "qa-p1", body: Q, displayName: "__proto__" }));
    expect(q.displayName).toBe("__proto__");
    expect(Object.getPrototypeOf(q)).toBe(Object.prototype);
  });

  test("fuzz: 300 random strings never throw", () => {
    const h = harness();
    const qid = ask(h, A);
    let seed = 99;
    const rnd = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % max;
    };
    const alphabet = ["a", " ", "\n", "\u0000", "​", "‮", "<", ">", "&", "\ud83d", "\ude00", "é", "\t", "http://x.y ", "www.z "];
    for (let i = 0; i < 300; i++) {
      const s = Array.from({ length: rnd(400) }, () => alphabet[rnd(alphabet.length)]).join("");
      const r1 = h.svc.ask(B, { productId: "qa-p1", body: s, displayName: s.slice(0, 60) });
      const r2 = h.svc.answer(C, { questionId: qid, body: s });
      for (const r of [r1, r2]) {
        if (!r.ok) expect(["VALIDATION_FAILED", "TOO_LONG", "DUPLICATE", "LIMIT_REACHED"]).toContain(r.error.code);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("SQL parameterisation + singleton", () => {
  test("every interpolation in SQL strings is a column-list constant", () => {
    const repo = readFileSync(join(QA_DIR, "qa-repository.ts"), "utf8");
    const interpolations = [...repo.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
    expect(new Set(interpolations)).toEqual(new Set(["QUESTION_COLUMNS", "ANSWER_COLUMNS"]));
    const svc = readFileSync(join(QA_DIR, "qa-service.ts"), "utf8");
    expect(svc).not.toMatch(/db\.(query|prepare|run|exec)\(/);
  });

  test("getQaService() reuses the instance and rebuilds after the shared db is reopened", () => {
    process.env.DATABASE_PATH = ":memory:";
    const a = getQaService();
    expect(getQaService()).toBe(a);
    const db1 = getDatabase();
    closeDatabase();
    const b = getQaService();
    expect(getDatabase()).not.toBe(db1);
    expect(b).not.toBe(a);
    expect(getQaService()).toBe(b);
  });
});
