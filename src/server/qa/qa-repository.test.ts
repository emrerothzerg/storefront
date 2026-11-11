import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteQaRepository } from "./qa-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const AT = "2026-11-01T00:00:00.000Z";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES ('p1', 'p1', 'P1', 100, 'USD', '/p1.svg', 1, '2020-01-01T00:00:00.000Z')",
  ).run();
  db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES ('p2', 'p2', 'P2', 100, 'USD', '/p2.svg', 1, '2099-01-01T00:00:00.000Z')",
  ).run();
  const repo = new SqliteQaRepository(db);
  const q = repo.insertQuestion({ id: "q1", productId: "p1", sessionId: S1, displayName: "A", body: "Question one?", createdAt: AT });
  return { db, repo, q };
}

describe("SqliteQaRepository", () => {
  test("insertQuestion returns the domain row without the session id", () => {
    const { q } = setup();
    expect(q).toEqual({
      id: "q1",
      productId: "p1",
      displayName: "A",
      body: "Question one?",
      helpfulCount: 0,
      status: "published",
      createdAt: AT,
    });
  });

  test("isProductPublished respects published_at", () => {
    const { repo } = setup();
    expect(repo.isProductPublished("p1", AT)).toBe(true);
    expect(repo.isProductPublished("p2", AT)).toBe(false);
    expect(repo.isProductPublished("p2", "2099-01-01T00:00:00.000Z")).toBe(true);
    expect(repo.isProductPublished("nope", AT)).toBe(false);
  });

  test("writes with an invalid session id throw TypeError; reads return empty", () => {
    const { repo } = setup();
    expect(() =>
      repo.insertQuestion({ id: "q2", productId: "p1", sessionId: "bad", displayName: "A", body: "x", createdAt: AT }),
    ).toThrow(TypeError);
    expect(() =>
      repo.insertAnswer({ id: "a1", questionId: "q1", sessionId: "bad", displayName: "A", body: "x", createdAt: AT }),
    ).toThrow(TypeError);
    expect(() => repo.insertQuestionVote("q1", "bad", AT)).toThrow(TypeError);
    expect(() => repo.insertAnswerVote("a1", "bad", AT)).toThrow(TypeError);
    expect(repo.hasQuestionWithBody("bad", "p1", "Question one?")).toBe(false);
    expect(repo.countAnswersBySession("bad", "q1")).toBe(0);
    expect(repo.listQuestionsBySession("bad")).toEqual([]);
    expect(repo.listAnswersBySession("bad")).toEqual([]);
    expect(repo.ownQuestionIds("bad", ["q1"]).size).toBe(0);
  });

  test("insertAnswer always stores is_store = 0", () => {
    const { db, repo } = setup();
    const a = repo.insertAnswer({ id: "a1", questionId: "q1", sessionId: S2, displayName: "B", body: "Yes", createdAt: AT });
    expect(a.isStore).toBe(false);
    expect(db.query<{ is_store: number }, []>("SELECT is_store FROM answers WHERE id = 'a1'").get()?.is_store).toBe(0);
  });

  test("votes: one per session, triggers maintain helpful_count", () => {
    const { repo } = setup();
    repo.insertAnswer({ id: "a1", questionId: "q1", sessionId: S1, displayName: "B", body: "Yes", createdAt: AT });
    expect(repo.insertQuestionVote("q1", S2, AT)).toBe(true);
    expect(repo.insertQuestionVote("q1", S2, AT)).toBe(false);
    expect(repo.getQuestionHelpfulCount("q1")).toBe(1);
    expect(repo.insertAnswerVote("a1", S2, AT)).toBe(true);
    expect(repo.insertAnswerVote("a1", S2, AT)).toBe(false);
    expect(repo.getAnswerHelpfulCount("a1")).toBe(1);
    expect(repo.getQuestionHelpfulCount("nope")).toBe(0);
    expect(repo.votedQuestionIds(S2, ["q1", "nope"])).toEqual(new Set(["q1"]));
    expect(repo.votedAnswerIds(S2, ["a1"])).toEqual(new Set(["a1"]));
    expect(repo.votedAnswerIds(S1, ["a1"]).size).toBe(0);
  });

  test("vote targets report visibility and ownership", () => {
    const { db, repo } = setup();
    repo.insertAnswer({ id: "a1", questionId: "q1", sessionId: S2, displayName: "B", body: "Yes", createdAt: AT });
    expect(repo.getQuestionVoteTarget("q1", S1)).toEqual({ published: true, isOwn: true });
    expect(repo.getQuestionVoteTarget("q1", S2)).toEqual({ published: true, isOwn: false });
    expect(repo.getAnswerVoteTarget("a1", S2)).toEqual({ published: true, isOwn: true });
    expect(repo.getQuestionVoteTarget("nope", S1)).toBeNull();
    expect(repo.getAnswerVoteTarget("nope", S1)).toBeNull();
    db.query("UPDATE questions SET status = 'hidden'").run();
    expect(repo.getAnswerVoteTarget("a1", S1)).toEqual({ published: false, isOwn: false });
  });

  test("getPublishedQuestion excludes hidden questions and unpublished products", () => {
    const { db, repo } = setup();
    repo.insertQuestion({ id: "q2", productId: "p2", sessionId: S1, displayName: "A", body: "Future?", createdAt: AT });
    expect(repo.getPublishedQuestion("q1", AT)?.id).toBe("q1");
    expect(repo.getPublishedQuestion("q2", AT)).toBeNull();
    db.query("UPDATE questions SET status = 'hidden' WHERE id = 'q1'").run();
    expect(repo.getPublishedQuestion("q1", AT)).toBeNull();
  });

  test("ID lists are bound as one JSON parameter (quotes and SQL in ids are inert)", () => {
    const { repo } = setup();
    expect(repo.listPublishedAnswers([])).toEqual([]);
    expect(repo.listPublishedAnswers(["q1') OR 1=1 --", "\"x\""])).toEqual([]);
    expect(repo.ownQuestionIds(S1, [])).toEqual(new Set());
    expect(repo.ownQuestionIds(S1, ["q1", "' OR '1'='1"])).toEqual(new Set(["q1"]));
  });

  test("counts and session listings", () => {
    const { db, repo } = setup();
    repo.insertQuestion({ id: "q2", productId: "p1", sessionId: S2, displayName: "B", body: "Two?", createdAt: AT });
    repo.insertAnswer({ id: "a1", questionId: "q2", sessionId: S1, displayName: "A", body: "Yes", createdAt: AT });
    expect(repo.countPublishedQuestions("p1")).toBe(2);
    db.query("UPDATE questions SET status = 'hidden' WHERE id = 'q2'").run();
    expect(repo.countPublishedQuestions("p1")).toBe(1);
    expect(repo.listPublishedQuestions("p1", 5, 0).map((q) => q.id)).toEqual(["q1"]);
    expect(repo.hasQuestionWithBody(S1, "p1", "Question one?")).toBe(true);
    expect(repo.hasQuestionWithBody(S1, "p1", "question one?")).toBe(false);
    expect(repo.countAnswersBySession(S1, "q2")).toBe(1);
    expect(repo.listQuestionsBySession(S1).map((q) => q.id)).toEqual(["q1"]);
    expect(repo.listAnswersBySession(S1).map((a) => a.id)).toEqual(["a1"]);
    expect(repo.ownAnswerIds(S1, ["a1"])).toEqual(new Set(["a1"]));
  });

  test("getQuestionsByIds returns any status, skips unknown ids, binds one JSON parameter", () => {
    const { db, repo } = setup();
    repo.insertQuestion({ id: "q2", productId: "p2", sessionId: S2, displayName: "B", body: "Two?", createdAt: AT });
    db.query("UPDATE questions SET status = 'hidden' WHERE id = 'q2'").run();
    expect(repo.getQuestionsByIds([])).toEqual([]);
    const found = repo.getQuestionsByIds(["q2", "q1", "q1", "nope", "q1') OR 1=1 --"]);
    expect(found.map((q) => [q.id, q.status]).sort()).toEqual([
      ["q1", "published"],
      ["q2", "hidden"],
    ]);
    expect(JSON.stringify(found)).not.toContain(S2);
  });
});
