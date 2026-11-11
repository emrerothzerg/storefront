import type { Database } from "bun:sqlite";
import type { Answer, ContentStatus, Question } from "@/lib/types";
import { isSessionId } from "@/server/session/session-id";

/**
 * Q&A persistence (server-only): thin SQL over `questions`, `answers`,
 * `question_votes` and `answer_votes`. Bound parameters only. No business
 * rules live here (lengths, limits, ownership): those belong to `QaService`.
 *
 * Author `session_id`s are owner keys (bearer credentials). They are used in
 * WHERE clauses only and are never selected into a returned domain object.
 *
 * Session ids are checked with `isSessionId` before any query: reads with an
 * invalid id return empty results, writes throw a `TypeError` (a programmer
 * error, because the service validates first). `is_store` is always written
 * as 0: no method accepts it.
 */

export interface NewQuestionRow {
  readonly id: string;
  readonly productId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface NewAnswerRow {
  readonly id: string;
  readonly questionId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly body: string;
  readonly createdAt: string;
}

/** Visibility of a vote target plus whether `sessionId` authored it. */
export interface VoteTarget {
  /** False when the target or (for answers) its question is hidden. */
  readonly published: boolean;
  readonly isOwn: boolean;
}

export interface QaRepository {
  /** True when the product exists and `published_at <= nowIso`. */
  isProductPublished(productId: string, nowIso: string): boolean;
  /** True when this session already asked exactly `body` on this product (any status). */
  hasQuestionWithBody(sessionId: string, productId: string, body: string): boolean;
  insertQuestion(row: NewQuestionRow): Question;
  /** A published question whose product is published at `nowIso`; `null` otherwise. */
  getPublishedQuestion(questionId: string, nowIso: string): Question | null;
  /** Answers this session posted on the question (any status). */
  countAnswersBySession(sessionId: string, questionId: string): number;
  /** Inserts with `is_store = 0`. */
  insertAnswer(row: NewAnswerRow): Answer;
  /** `null` when the question does not exist. */
  getQuestionVoteTarget(questionId: string, sessionId: string): VoteTarget | null;
  /** `null` when the answer does not exist. */
  getAnswerVoteTarget(answerId: string, sessionId: string): VoteTarget | null;
  /** Inserts the vote; false when this session already voted (no change). */
  insertQuestionVote(questionId: string, sessionId: string, createdAt: string): boolean;
  insertAnswerVote(answerId: string, sessionId: string, createdAt: string): boolean;
  /** Current helpful count; 0 when the row is gone. */
  getQuestionHelpfulCount(questionId: string): number;
  getAnswerHelpfulCount(answerId: string): number;
  /** Published questions on the product. */
  countPublishedQuestions(productId: string): number;
  /** Published questions, helpful desc, newest first, id desc (stable). */
  listPublishedQuestions(productId: string, limit: number, offset: number): Question[];
  /** Published answers of the given questions: store first, helpful desc, newest first, id desc. */
  listPublishedAnswers(questionIds: readonly string[]): Answer[];
  /** Subset of `questionIds` authored by / voted by `sessionId`. */
  ownQuestionIds(sessionId: string, questionIds: readonly string[]): Set<string>;
  votedQuestionIds(sessionId: string, questionIds: readonly string[]): Set<string>;
  ownAnswerIds(sessionId: string, answerIds: readonly string[]): Set<string>;
  votedAnswerIds(sessionId: string, answerIds: readonly string[]): Set<string>;
  /** Everything the session wrote (any status), newest first. */
  listQuestionsBySession(sessionId: string): Question[];
  listAnswersBySession(sessionId: string): Answer[];
  /** Questions by id, ANY status, in no particular order; unknown ids are skipped. */
  getQuestionsByIds(questionIds: readonly string[]): Question[];
}

interface QuestionDbRow {
  id: string;
  product_id: string;
  display_name: string;
  body: string;
  helpful_count: number;
  status: string;
  created_at: string;
}

interface AnswerDbRow {
  id: string;
  question_id: string;
  display_name: string;
  body: string;
  is_store: number;
  helpful_count: number;
  status: string;
  created_at: string;
}

interface VoteTargetRow {
  published: number;
  is_own: number;
}

const QUESTION_COLUMNS = "q.id, q.product_id, q.display_name, q.body, q.helpful_count, q.status, q.created_at";
const ANSWER_COLUMNS = "a.id, a.question_id, a.display_name, a.body, a.is_store, a.helpful_count, a.status, a.created_at";

function toStatus(value: string): ContentStatus {
  return value === "hidden" ? "hidden" : "published";
}

function toQuestion(row: QuestionDbRow): Question {
  return {
    id: row.id,
    productId: row.product_id,
    displayName: row.display_name,
    body: row.body,
    helpfulCount: row.helpful_count,
    status: toStatus(row.status),
    createdAt: row.created_at,
  };
}

function toAnswer(row: AnswerDbRow): Answer {
  return {
    id: row.id,
    questionId: row.question_id,
    displayName: row.display_name,
    body: row.body,
    isStore: row.is_store === 1,
    helpfulCount: row.helpful_count,
    status: toStatus(row.status),
    createdAt: row.created_at,
  };
}

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) {
    throw new TypeError("QaRepository: invalid session id");
  }
}

export class SqliteQaRepository implements QaRepository {
  constructor(private readonly db: Database) {}

  isProductPublished(productId: string, nowIso: string): boolean {
    return (
      this.db
        .query<{ one: number }, [string, string]>("SELECT 1 AS one FROM products WHERE id = ? AND published_at <= ?")
        .get(productId, nowIso) !== null
    );
  }

  hasQuestionWithBody(sessionId: string, productId: string, body: string): boolean {
    if (!isSessionId(sessionId)) return false;
    return (
      this.db
        .query<{ one: number }, [string, string, string]>(
          "SELECT 1 AS one FROM questions WHERE session_id = ? AND product_id = ? AND body = ? LIMIT 1",
        )
        .get(sessionId, productId, body) !== null
    );
  }

  insertQuestion(row: NewQuestionRow): Question {
    assertSessionId(row.sessionId);
    this.db
      .query<unknown, [string, string, string, string, string, string]>(
        `INSERT INTO questions (id, product_id, session_id, display_name, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.productId, row.sessionId, row.displayName, row.body, row.createdAt);
    const inserted = this.db
      .query<QuestionDbRow, [string]>(`SELECT ${QUESTION_COLUMNS} FROM questions q WHERE q.id = ?`)
      .get(row.id);
    if (inserted === null) throw new Error("QaRepository: inserted question not found");
    return toQuestion(inserted);
  }

  getPublishedQuestion(questionId: string, nowIso: string): Question | null {
    const row = this.db
      .query<QuestionDbRow, [string, string]>(
        `SELECT ${QUESTION_COLUMNS} FROM questions q
           JOIN products p ON p.id = q.product_id
          WHERE q.id = ? AND q.status = 'published' AND p.published_at <= ?`,
      )
      .get(questionId, nowIso);
    return row === null ? null : toQuestion(row);
  }

  countAnswersBySession(sessionId: string, questionId: string): number {
    if (!isSessionId(sessionId)) return 0;
    const row = this.db
      .query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM answers WHERE session_id = ? AND question_id = ?")
      .get(sessionId, questionId);
    return row?.n ?? 0;
  }

  insertAnswer(row: NewAnswerRow): Answer {
    assertSessionId(row.sessionId);
    this.db
      .query<unknown, [string, string, string, string, string, string]>(
        `INSERT INTO answers (id, question_id, session_id, display_name, body, is_store, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(row.id, row.questionId, row.sessionId, row.displayName, row.body, row.createdAt);
    const inserted = this.db
      .query<AnswerDbRow, [string]>(`SELECT ${ANSWER_COLUMNS} FROM answers a WHERE a.id = ?`)
      .get(row.id);
    if (inserted === null) throw new Error("QaRepository: inserted answer not found");
    return toAnswer(inserted);
  }

  getQuestionVoteTarget(questionId: string, sessionId: string): VoteTarget | null {
    const row = this.db
      .query<VoteTargetRow, [string, string]>(
        `SELECT (q.status = 'published') AS published, (q.session_id = ?) AS is_own
           FROM questions q WHERE q.id = ?`,
      )
      .get(sessionId, questionId);
    return row === null ? null : { published: row.published === 1, isOwn: row.is_own === 1 };
  }

  getAnswerVoteTarget(answerId: string, sessionId: string): VoteTarget | null {
    const row = this.db
      .query<VoteTargetRow, [string, string]>(
        `SELECT (a.status = 'published' AND q.status = 'published') AS published, (a.session_id = ?) AS is_own
           FROM answers a JOIN questions q ON q.id = a.question_id
          WHERE a.id = ?`,
      )
      .get(sessionId, answerId);
    return row === null ? null : { published: row.published === 1, isOwn: row.is_own === 1 };
  }

  insertQuestionVote(questionId: string, sessionId: string, createdAt: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string, string]>(
        "INSERT INTO question_votes (question_id, session_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(questionId, sessionId, createdAt);
    return result.changes > 0;
  }

  insertAnswerVote(answerId: string, sessionId: string, createdAt: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string, string]>(
        "INSERT INTO answer_votes (answer_id, session_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(answerId, sessionId, createdAt);
    return result.changes > 0;
  }

  getQuestionHelpfulCount(questionId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>("SELECT helpful_count AS n FROM questions WHERE id = ?")
      .get(questionId);
    return row?.n ?? 0;
  }

  getAnswerHelpfulCount(answerId: string): number {
    const row = this.db.query<{ n: number }, [string]>("SELECT helpful_count AS n FROM answers WHERE id = ?").get(answerId);
    return row?.n ?? 0;
  }

  countPublishedQuestions(productId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM questions WHERE product_id = ? AND status = 'published'",
      )
      .get(productId);
    return row?.n ?? 0;
  }

  listPublishedQuestions(productId: string, limit: number, offset: number): Question[] {
    return this.db
      .query<QuestionDbRow, [string, number, number]>(
        `SELECT ${QUESTION_COLUMNS} FROM questions q
          WHERE q.product_id = ? AND q.status = 'published'
          ORDER BY q.helpful_count DESC, q.created_at DESC, q.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(productId, limit, offset)
      .map(toQuestion);
  }

  listPublishedAnswers(questionIds: readonly string[]): Answer[] {
    if (questionIds.length === 0) return [];
    // One bound JSON parameter instead of N placeholders: no SQL built from input.
    return this.db
      .query<AnswerDbRow, [string]>(
        `SELECT ${ANSWER_COLUMNS} FROM answers a
          WHERE a.question_id IN (SELECT value FROM json_each(?)) AND a.status = 'published'
          ORDER BY a.is_store DESC, a.helpful_count DESC, a.created_at DESC, a.id DESC`,
      )
      .all(JSON.stringify(questionIds))
      .map(toAnswer);
  }

  ownQuestionIds(sessionId: string, questionIds: readonly string[]): Set<string> {
    return this.idSubset("SELECT id FROM questions WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))", sessionId, questionIds);
  }

  votedQuestionIds(sessionId: string, questionIds: readonly string[]): Set<string> {
    return this.idSubset(
      "SELECT question_id AS id FROM question_votes WHERE session_id = ? AND question_id IN (SELECT value FROM json_each(?))",
      sessionId,
      questionIds,
    );
  }

  ownAnswerIds(sessionId: string, answerIds: readonly string[]): Set<string> {
    return this.idSubset("SELECT id FROM answers WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))", sessionId, answerIds);
  }

  votedAnswerIds(sessionId: string, answerIds: readonly string[]): Set<string> {
    return this.idSubset(
      "SELECT answer_id AS id FROM answer_votes WHERE session_id = ? AND answer_id IN (SELECT value FROM json_each(?))",
      sessionId,
      answerIds,
    );
  }

  listQuestionsBySession(sessionId: string): Question[] {
    if (!isSessionId(sessionId)) return [];
    return this.db
      .query<QuestionDbRow, [string]>(
        `SELECT ${QUESTION_COLUMNS} FROM questions q WHERE q.session_id = ? ORDER BY q.created_at DESC, q.id DESC`,
      )
      .all(sessionId)
      .map(toQuestion);
  }

  listAnswersBySession(sessionId: string): Answer[] {
    if (!isSessionId(sessionId)) return [];
    return this.db
      .query<AnswerDbRow, [string]>(
        `SELECT ${ANSWER_COLUMNS} FROM answers a WHERE a.session_id = ? ORDER BY a.created_at DESC, a.id DESC`,
      )
      .all(sessionId)
      .map(toAnswer);
  }

  getQuestionsByIds(questionIds: readonly string[]): Question[] {
    if (questionIds.length === 0) return [];
    return this.db
      .query<QuestionDbRow, [string]>(
        `SELECT ${QUESTION_COLUMNS} FROM questions q WHERE q.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify([...new Set(questionIds)]))
      .map(toQuestion);
  }

  /** `sql` must select one `id` column and take (sessionId, JSON array of ids). */
  private idSubset(sql: string, sessionId: string, ids: readonly string[]): Set<string> {
    if (!isSessionId(sessionId) || ids.length === 0) return new Set();
    const rows = this.db.query<{ id: string }, [string, string]>(sql).all(sessionId, JSON.stringify(ids));
    return new Set(rows.map((row) => row.id));
  }
}
