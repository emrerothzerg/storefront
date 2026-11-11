import type { Database } from "bun:sqlite";
import type { Answer, Question } from "@/lib/types";
import { appError, err, fail, ok, type AppError, type Result } from "@/lib/result";
import { getDatabase, withTransaction } from "@/server/db/client";
import { cleanText, countUrls } from "@/server/security/text-guard";
import { isSessionId } from "@/server/session/session-id";
import { SqliteQaRepository, type QaRepository, type VoteTarget } from "./qa-repository";

/**
 * Product questions and answers (server-only). All methods are synchronous
 * (bun:sqlite is sync and `withTransaction` needs a sync callback); server
 * actions wrap them and apply the rate limiter first. See README.md.
 *
 * `sessionId` parameters are OWNER KEYS (guest session id or a user's
 * owner_key, both UUID v4). Views never contain an author's key: ownership is
 * reported only as `isOwn` relative to the viewer. There is deliberately no
 * way to mark an answer as a store answer through this service.
 */

export const QA_PAGE_SIZE = 5;
export const QUESTION_MIN_LENGTH = 10;
export const QUESTION_MAX_LENGTH = 300;
export const ANSWER_MIN_LENGTH = 1;
export const ANSWER_MAX_LENGTH = 1000;
export const DISPLAY_NAME_MAX_LENGTH = 50;
/** Answers one owner key may post on one question. */
export const MAX_ANSWERS_PER_QUESTION = 3;
/** More URL-like tokens than this in a question or answer is treated as spam. */
export const MAX_URLS_PER_POST = 2;
export const DEFAULT_DISPLAY_NAME = "Anonymous shopper";

export interface AnswerView extends Answer {
  readonly votedByViewer?: boolean;
  readonly isOwn?: boolean;
}

export interface QuestionView extends Question {
  readonly answers: readonly AnswerView[];
  readonly votedByViewer?: boolean;
  readonly isOwn?: boolean;
}

export interface QaListResult {
  readonly items: readonly QuestionView[];
  readonly total: number;
  readonly page: number;
  readonly pageCount: number;
}

export interface QaService {
  ask(
    sessionId: string,
    input: { productId: string; body: unknown; displayName?: unknown },
    now?: number,
  ): Result<Question, AppError>;
  answer(
    sessionId: string,
    input: { questionId: string; body: unknown; displayName?: unknown },
    now?: number,
  ): Result<Answer, AppError>;
  voteQuestion(sessionId: string, questionId: string): Result<{ helpfulCount: number }, AppError>;
  voteAnswer(sessionId: string, answerId: string): Result<{ helpfulCount: number }, AppError>;
  list(productId: string, query?: { page?: number }, viewerSessionId?: string | null): Result<QaListResult, AppError>;
  count(productId: string): number;
  listMine(sessionId: string): { readonly questions: readonly Question[]; readonly answers: readonly Answer[] };
}

/** One of the owner's answers with the question it belongs to (`question.productId` names the product). */
export interface OwnAnswerView extends AnswerView {
  readonly question: Question;
}

export interface OwnQaDetail {
  /**
   * The owner's questions (any status), newest first, each with its answers:
   * every published answer (PDP order: store first, then helpful, newest)
   * followed by the owner's own unpublished answers. `isOwn` is always true
   * on the question; answers carry `isOwn` / `votedByViewer` for the owner.
   */
  readonly questions: readonly QuestionView[];
  /** The owner's answers (any status), newest first, each with its question (any status). */
  readonly answers: readonly OwnAnswerView[];
}

/**
 * Account-page read (consistency an), kept off `QaService` so existing
 * `QaService` fakes keep compiling. `createQaService` / `getQaService`
 * return both.
 */
export interface OwnQaReader {
  /** Bad owner key → empty lists, no SQL. One deferred read transaction. */
  listMineWithAnswers(sessionId: string): OwnQaDetail;
}

export interface QaServiceDeps {
  readonly db: Database;
  /** Clock in epoch ms; defaults to `Date.now`. A per-call `now` argument wins. */
  readonly now?: () => number;
  /** Defaults to `SqliteQaRepository(db)`. */
  readonly repository?: QaRepository;
  /** Id generator; defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
}

/** Thrown inside a transaction to roll it back; converted to `Err` outside. */
class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

function invalidSession(): Result<never, AppError> {
  return fail("INVALID_INPUT", "Your session could not be verified. Refresh the page and try again.");
}

function withField(error: AppError, field: string, message: string): AppError {
  return appError(error.code, message, { ...error.details, field });
}

interface TextRules {
  readonly field: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly multiline: boolean;
}

/** Cleans a post body: missing counts as empty; non-strings are INVALID_INPUT; URL spam is VALIDATION_FAILED. */
function cleanBody(raw: unknown, rules: TextRules): Result<string, AppError> {
  const cleaned = cleanText(raw ?? "", { max: rules.max, min: rules.min, multiline: rules.multiline });
  if (!cleaned.ok) {
    const { code } = cleaned.error;
    const message =
      code === "TOO_LONG"
        ? `${rules.label} must be at most ${rules.max} characters.`
        : code === "VALIDATION_FAILED"
          ? rules.min > 1
            ? `${rules.label} must be at least ${rules.min} characters.`
            : `${rules.label} is required.`
          : `${rules.label} must be text.`;
    return err(withField(cleaned.error, rules.field, message));
  }
  if (countUrls(cleaned.value) > MAX_URLS_PER_POST) {
    return fail("VALIDATION_FAILED", `${rules.label} may contain at most ${MAX_URLS_PER_POST} links.`, {
      field: rules.field,
      reason: "TOO_MANY_URLS",
    });
  }
  return cleaned;
}

/** Missing, null or blank after cleaning -> the default name. */
function cleanDisplayName(raw: unknown): Result<string, AppError> {
  if (raw === undefined || raw === null) return ok(DEFAULT_DISPLAY_NAME);
  const cleaned = cleanText(raw, { max: DISPLAY_NAME_MAX_LENGTH });
  if (!cleaned.ok) {
    const message =
      cleaned.error.code === "TOO_LONG"
        ? `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`
        : "Display name must be text.";
    return err(withField(cleaned.error, "displayName", message));
  }
  return ok(cleaned.value === "" ? DEFAULT_DISPLAY_NAME : cleaned.value);
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Page from a query: non-integers and values below 1 become 1; values past the end clamp to the last page. */
function normalisePage(page: unknown, pageCount: number): number {
  const requested = typeof page === "number" && Number.isSafeInteger(page) && page >= 1 ? page : 1;
  return Math.min(requested, pageCount);
}

export class QaServiceImpl implements QaService, OwnQaReader {
  private readonly db: Database;
  private readonly repo: QaRepository;
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(deps: QaServiceDeps) {
    this.db = deps.db;
    this.repo = deps.repository ?? new SqliteQaRepository(deps.db);
    this.clock = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  ask(
    sessionId: string,
    input: { productId: string; body: unknown; displayName?: unknown },
    now?: number,
  ): Result<Question, AppError> {
    if (!isSessionId(sessionId)) return invalidSession();
    const body = cleanBody(input.body, {
      field: "body",
      label: "Question",
      min: QUESTION_MIN_LENGTH,
      max: QUESTION_MAX_LENGTH,
      multiline: false,
    });
    if (!body.ok) return body;
    const displayName = cleanDisplayName(input.displayName);
    if (!displayName.ok) return displayName;
    const productId: unknown = input.productId;
    if (typeof productId !== "string" || productId === "") {
      return fail("PRODUCT_NOT_FOUND", "This product could not be found.");
    }
    const createdAt = toIso(now ?? this.clock());

    return this.run(() => {
      if (!this.repo.isProductPublished(productId, createdAt)) {
        throw new Abort(appError("PRODUCT_NOT_FOUND", "This product could not be found."));
      }
      if (this.repo.hasQuestionWithBody(sessionId, productId, body.value)) {
        throw new Abort(appError("DUPLICATE", "You have already asked this question.", { field: "body" }));
      }
      return this.repo.insertQuestion({
        id: this.newId(),
        productId,
        sessionId,
        displayName: displayName.value,
        body: body.value,
        createdAt,
      });
    });
  }

  answer(
    sessionId: string,
    input: { questionId: string; body: unknown; displayName?: unknown },
    now?: number,
  ): Result<Answer, AppError> {
    if (!isSessionId(sessionId)) return invalidSession();
    const body = cleanBody(input.body, {
      field: "body",
      label: "Answer",
      min: ANSWER_MIN_LENGTH,
      max: ANSWER_MAX_LENGTH,
      multiline: true,
    });
    if (!body.ok) return body;
    const displayName = cleanDisplayName(input.displayName);
    if (!displayName.ok) return displayName;
    const questionId: unknown = input.questionId;
    if (typeof questionId !== "string" || questionId === "") {
      return fail("NOT_FOUND", "This question could not be found.");
    }
    const createdAt = toIso(now ?? this.clock());

    return this.run(() => {
      if (this.repo.getPublishedQuestion(questionId, createdAt) === null) {
        throw new Abort(appError("NOT_FOUND", "This question could not be found."));
      }
      if (this.repo.countAnswersBySession(sessionId, questionId) >= MAX_ANSWERS_PER_QUESTION) {
        throw new Abort(
          appError("LIMIT_REACHED", `You can post at most ${MAX_ANSWERS_PER_QUESTION} answers to one question.`, {
            limit: MAX_ANSWERS_PER_QUESTION,
          }),
        );
      }
      return this.repo.insertAnswer({
        id: this.newId(),
        questionId,
        sessionId,
        displayName: displayName.value,
        body: body.value,
        createdAt,
      });
    });
  }

  voteQuestion(sessionId: string, questionId: string): Result<{ helpfulCount: number }, AppError> {
    return this.vote(sessionId, questionId, "question");
  }

  voteAnswer(sessionId: string, answerId: string): Result<{ helpfulCount: number }, AppError> {
    return this.vote(sessionId, answerId, "answer");
  }

  list(productId: string, query?: { page?: number }, viewerSessionId?: string | null): Result<QaListResult, AppError> {
    const id: unknown = productId;
    if (typeof id !== "string" || !this.repo.isProductPublished(id, toIso(this.clock()))) {
      return fail("PRODUCT_NOT_FOUND", "This product could not be found.");
    }
    // One DEFERRED (read) transaction so total, page and nested answers are a
    // consistent snapshot without taking the write lock on a page render.
    const read = this.db.transaction(() => {
      const total = this.repo.countPublishedQuestions(id);
      const pageCount = Math.max(1, Math.ceil(total / QA_PAGE_SIZE));
      const page = normalisePage(query?.page, pageCount);
      const questions = this.repo.listPublishedQuestions(id, QA_PAGE_SIZE, (page - 1) * QA_PAGE_SIZE);
      const questionIds = questions.map((q) => q.id);
      const answers = this.repo.listPublishedAnswers(questionIds);
      const answerIds = answers.map((a) => a.id);

      const viewer = isSessionId(viewerSessionId) ? viewerSessionId : null;
      const flags =
        viewer === null
          ? null
          : {
              ownQ: this.repo.ownQuestionIds(viewer, questionIds),
              votedQ: this.repo.votedQuestionIds(viewer, questionIds),
              ownA: this.repo.ownAnswerIds(viewer, answerIds),
              votedA: this.repo.votedAnswerIds(viewer, answerIds),
            };

      const byQuestion = new Map<string, AnswerView[]>();
      for (const a of answers) {
        const view: AnswerView =
          flags === null ? a : { ...a, votedByViewer: flags.votedA.has(a.id), isOwn: flags.ownA.has(a.id) };
        const bucket = byQuestion.get(a.questionId);
        if (bucket === undefined) byQuestion.set(a.questionId, [view]);
        else bucket.push(view);
      }

      const items: QuestionView[] = questions.map((q) => {
        const nested = byQuestion.get(q.id) ?? [];
        return flags === null
          ? { ...q, answers: nested }
          : { ...q, answers: nested, votedByViewer: flags.votedQ.has(q.id), isOwn: flags.ownQ.has(q.id) };
      });
      const result: QaListResult = { items, total, page, pageCount };
      return result;
    });
    return ok(read.deferred());
  }

  count(productId: string): number {
    const id: unknown = productId;
    if (typeof id !== "string") return 0;
    return this.repo.countPublishedQuestions(id);
  }

  listMine(sessionId: string): { readonly questions: readonly Question[]; readonly answers: readonly Answer[] } {
    if (!isSessionId(sessionId)) return { questions: [], answers: [] };
    return {
      questions: this.repo.listQuestionsBySession(sessionId),
      answers: this.repo.listAnswersBySession(sessionId),
    };
  }

  listMineWithAnswers(sessionId: string): OwnQaDetail {
    if (!isSessionId(sessionId)) return { questions: [], answers: [] };
    const read = this.db.transaction((): OwnQaDetail => {
      const questions = this.repo.listQuestionsBySession(sessionId);
      const ownAnswers = this.repo.listAnswersBySession(sessionId);
      const questionIds = questions.map((q) => q.id);
      const ownQuestionIds = new Set(questionIds);
      const published = this.repo.listPublishedAnswers(questionIds);
      const publishedIds = new Set(published.map((a) => a.id));
      const ownUnpublished = ownAnswers
        .filter((a) => ownQuestionIds.has(a.questionId) && !publishedIds.has(a.id))
        .reverse(); // oldest first after the published ones
      const nested = [...published, ...ownUnpublished];
      const ownIds = new Set(ownAnswers.map((a) => a.id));
      const voted = this.repo.votedAnswerIds(
        sessionId,
        nested.map((a) => a.id),
      );

      const byQuestion = new Map<string, AnswerView[]>();
      for (const a of nested) {
        const view: AnswerView = { ...a, isOwn: ownIds.has(a.id), votedByViewer: voted.has(a.id) };
        const bucket = byQuestion.get(a.questionId);
        if (bucket === undefined) byQuestion.set(a.questionId, [view]);
        else bucket.push(view);
      }

      const parents = new Map(
        this.repo.getQuestionsByIds(ownAnswers.map((a) => a.questionId)).map((q) => [q.id, q] as const),
      );
      const answers: OwnAnswerView[] = [];
      for (const a of ownAnswers) {
        const question = parents.get(a.questionId);
        if (question !== undefined) answers.push({ ...a, isOwn: true, votedByViewer: voted.has(a.id), question });
      }

      return {
        questions: questions.map((q) => ({ ...q, answers: byQuestion.get(q.id) ?? [], isOwn: true, votedByViewer: false })),
        answers,
      };
    });
    return read.deferred();
  }

  private vote(sessionId: string, targetId: string, kind: "question" | "answer"): Result<{ helpfulCount: number }, AppError> {
    if (!isSessionId(sessionId)) return invalidSession();
    const notFound = appError("NOT_FOUND", `This ${kind} could not be found.`);
    const id: unknown = targetId;
    if (typeof id !== "string" || id === "") return err(notFound);
    const createdAt = toIso(this.clock());

    return this.run(() => {
      const target: VoteTarget | null =
        kind === "question" ? this.repo.getQuestionVoteTarget(id, sessionId) : this.repo.getAnswerVoteTarget(id, sessionId);
      if (target === null || !target.published) throw new Abort(notFound);
      if (target.isOwn) throw new Abort(appError("FORBIDDEN", `You cannot vote on your own ${kind}.`));
      const inserted =
        kind === "question"
          ? this.repo.insertQuestionVote(id, sessionId, createdAt)
          : this.repo.insertAnswerVote(id, sessionId, createdAt);
      if (!inserted) throw new Abort(appError("DUPLICATE", `You have already voted on this ${kind}.`));
      const helpfulCount =
        kind === "question" ? this.repo.getQuestionHelpfulCount(id) : this.repo.getAnswerHelpfulCount(id);
      return { helpfulCount };
    });
  }

  /** Runs `fn` in one transaction; an `Abort` rolls back and becomes `Err`. Other errors propagate. */
  private run<T>(fn: () => T): Result<T, AppError> {
    try {
      return ok(withTransaction(this.db, fn));
    } catch (error) {
      if (error instanceof Abort) return err(error.error);
      throw error;
    }
  }
}

export function createQaService(deps: QaServiceDeps): QaService & OwnQaReader {
  return new QaServiceImpl(deps);
}

const globalForQa = globalThis as typeof globalThis & {
  __storefrontQaService?: { readonly db: Database; readonly service: QaService & OwnQaReader };
};

/** Shared service over `getDatabase()`; rebuilt if the shared database was reopened. */
export function getQaService(): QaService & OwnQaReader {
  const db = getDatabase();
  const cached = globalForQa.__storefrontQaService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createQaService({ db });
  globalForQa.__storefrontQaService = { db, service };
  return service;
}
