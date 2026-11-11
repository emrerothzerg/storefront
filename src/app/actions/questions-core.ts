import type {
  QaActionFn,
  QaActionState,
  QaEchoValues,
  QaVoteActionFn,
  QaVoteActionState,
} from "@/components/molecules/_contracts/qa-actions";
import { QA_FIELD } from "@/components/molecules/_contracts/qa-actions";
import { appError, fail, ok, type AppError, type Result } from "@/lib/result";
import {
  ANSWER_MAX_LENGTH,
  ANSWER_MIN_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  MAX_ANSWERS_PER_QUESTION,
  MAX_URLS_PER_POST,
  QUESTION_MAX_LENGTH,
  QUESTION_MIN_LENGTH,
  type QaService,
} from "@/server/qa/qa-service";
import { limitAction, type RateLimitedAction, type RateLimiter } from "@/server/security/rate-limiter";
import { cleanText, countUrls } from "@/server/security/text-guard";

/**
 * Framework-free Q&A action logic (T47). `questions.ts` wires it to Next.js
 * (`getOrCreateSessionId`, `readCurrentUser`, `getQaService()`,
 * `getRateLimiter()`, `revalidatePath`); tests inject fakes.
 *
 * Flow of `askQuestion` / `answerQuestion`:
 * 1. Read only the `QA_FIELD` strings (non-string = missing). `sessionId`,
 *    `isStore`, `status`, `helpfulCount`, ... are never read.
 * 2. `readCurrentUser()` (never sets cookies): signed in -> the account
 *    display name is used and the posted one is ignored and never echoed.
 * 3. Required id (`productId` / `questionId`): bad -> INVALID_INPUT; no
 *    session, limiter or service call.
 * 4. Local pre-check of the DB-free text rules (length, links). A failure
 *    returns field errors without creating a session or spending budget.
 * 5. `getOrCreateSessionId()` (lazy cookie), then `limitAction`.
 * 6. Service call (authoritative validation, duplicates, limits, insert).
 *    Success revalidates `/products/<slug>` when a valid slug was posted.
 *
 * Votes: id -> `getOrCreateSessionId()` -> `limitAction("vote")` -> service.
 *
 * Every outcome is a state; unexpected exceptions become a generic error
 * state and are logged as an error code + action name only.
 */

export interface QaActionDeps {
  readonly service: QaService;
  readonly limiter: RateLimiter;
  readonly getOrCreateSessionId: () => Promise<string>;
  readonly readCurrentUser: () => Promise<{ readonly displayName: string } | null>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Epoch milliseconds passed to `ask` / `answer`; service default when absent. */
  readonly now?: () => number;
  /** Receives only `QA_ACTION_FAILED action=<name>`; defaults to `console`. */
  readonly logger?: Pick<Console, "error">;
}

export interface QaActions {
  readonly askQuestion: QaActionFn;
  readonly answerQuestion: QaActionFn;
  readonly voteQuestion: QaVoteActionFn;
  readonly voteAnswer: QaVoteActionFn;
}

/** Longest accepted id (product / question / answer). */
export const QA_ID_MAX_LENGTH = 200;
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;

/** Logged (with the action name) when an action hits an unexpected exception. */
export const QA_ACTION_FAILED = "QA_ACTION_FAILED";

export const QA_MESSAGES = {
  asked: "Thanks, your question was posted.",
  answered: "Thanks, your answer was posted.",
  voted: "Thanks for your feedback.",
  invalidRequest: "Something was wrong with that request.",
  fixFields: "Please fix the highlighted fields.",
  duplicateQuestion: "You already asked this question.",
  duplicateVote: "You already marked this as helpful.",
  limitReached: "You have reached the answer limit for this question.",
  forbiddenVote: "You cannot vote on your own post.",
  productNotFound: "This product is no longer available.",
  questionNotFound: "This question could not be found. It may have been removed.",
  answerNotFound: "This answer could not be found. It may have been removed.",
  rateLimitedFallback: "Too many requests. Please try again later.",
  unavailable: "Something went wrong. Please try again.",
} as const;

export function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return QA_MESSAGES.rateLimitedFallback;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many requests. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type IdField = "productId" | "questionId" | "answerId";
type TextField = keyof QaEchoValues;

function readString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Reads a required id: a string, trimmed, 1..200 chars. Anything else is INVALID_INPUT with `details.field`. */
export function parseIdField(formData: FormData, field: IdField): Result<string> {
  const raw = readString(formData, QA_FIELD[field]);
  const invalid = fail("INVALID_INPUT", QA_MESSAGES.invalidRequest, { field: QA_FIELD[field] });
  // Length guard before trim so a huge value costs nothing.
  if (raw === undefined || raw.length > QA_ID_MAX_LENGTH * 4) return invalid;
  const value = raw.trim();
  if (value.length < 1 || value.length > QA_ID_MAX_LENGTH) return invalid;
  return ok(value);
}

/** Optional `productSlug`: returned only when it matches `^[a-z0-9-]{1,100}$`, else null (never an error). */
export function parseProductSlug(formData: FormData): string | null {
  const raw = readString(formData, QA_FIELD.productSlug);
  if (raw === undefined || raw.length > 100) return null;
  return PRODUCT_SLUG_PATTERN.test(raw) ? raw : null;
}

/** Cuts to `max` UTF-16 units without leaving a dangling high surrogate. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

interface PostRules {
  readonly label: "Question" | "Answer";
  readonly min: number;
  readonly max: number;
  readonly multiline: boolean;
}

const QUESTION_RULES: PostRules = { label: "Question", min: QUESTION_MIN_LENGTH, max: QUESTION_MAX_LENGTH, multiline: false };
const ANSWER_RULES: PostRules = { label: "Answer", min: ANSWER_MIN_LENGTH, max: ANSWER_MAX_LENGTH, multiline: true };

interface FieldProblem {
  readonly code: "VALIDATION_FAILED" | "TOO_LONG";
  readonly message: string;
  readonly reason?: "TOO_MANY_URLS";
}

/** Mirrors the service's body rules (cleaned length, link count). Null when it passes. */
export function precheckBody(raw: string | undefined, rules: PostRules): FieldProblem | null {
  const cleaned = cleanText(raw ?? "", { max: rules.max, multiline: rules.multiline });
  if (!cleaned.ok) {
    return cleaned.error.code === "TOO_LONG"
      ? { code: "TOO_LONG", message: `${rules.label} must be at most ${rules.max} characters.` }
      : { code: "VALIDATION_FAILED", message: `Enter your ${rules.label.toLowerCase()}.` };
  }
  if (cleaned.value.length === 0) return { code: "VALIDATION_FAILED", message: `Enter your ${rules.label.toLowerCase()}.` };
  if (cleaned.value.length < rules.min) {
    return { code: "VALIDATION_FAILED", message: `${rules.label} must be at least ${rules.min} characters.` };
  }
  if (countUrls(cleaned.value) > MAX_URLS_PER_POST) {
    return {
      code: "VALIDATION_FAILED",
      message: `${rules.label} may contain at most ${MAX_URLS_PER_POST} links.`,
      reason: "TOO_MANY_URLS",
    };
  }
  return null;
}

/** Mirrors the service's display-name rule (max 50 after cleaning). Null when it passes. */
export function precheckDisplayName(raw: string | undefined): FieldProblem | null {
  if (raw === undefined) return null;
  const cleaned = cleanText(raw, { max: DISPLAY_NAME_MAX_LENGTH });
  if (cleaned.ok) return null;
  return { code: "TOO_LONG", message: `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.` };
}

export type QaPostTarget = "question" | "answer";

/**
 * Values echoed back to the form: `body` (cap 300 for questions, 1000 for
 * answers) and, for guests only, `displayName` (cap 50). Never ids. A
 * non-string entry is omitted. Used on every failure path, including the
 * wrapper's "unavailable" state when the DB cannot open.
 */
export function echoQaValues(formData: FormData, target: QaPostTarget, signedIn: boolean): QaEchoValues {
  const rawBody = readString(formData, QA_FIELD.body);
  const rawName = signedIn ? undefined : readString(formData, QA_FIELD.displayName);
  const max = target === "question" ? QUESTION_MAX_LENGTH : ANSWER_MAX_LENGTH;
  return {
    ...(rawBody === undefined ? {} : { body: truncate(rawBody, max) }),
    ...(rawName === undefined ? {} : { displayName: truncate(rawName, DISPLAY_NAME_MAX_LENGTH) }),
  };
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function readPositiveInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

function postError(
  error: AppError,
  values: QaEchoValues,
  fieldErrors: Partial<Record<TextField, string>> = {},
  retryAfterSeconds?: number,
): QaActionState {
  const base = { ok: false as const, error, message: error.message, fieldErrors, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

function voteError(error: AppError, retryAfterSeconds?: number): QaVoteActionState {
  return retryAfterSeconds === undefined
    ? { ok: false, error, message: error.message }
    : { ok: false, error, message: error.message, retryAfterSeconds };
}

/** Builds the field-error state. One failing field -> its message is the headline; two -> a generic one. */
export function fieldErrorState(problems: Partial<Record<TextField, FieldProblem>>, values: QaEchoValues): QaActionState {
  const entries = (["body", "displayName"] as const).flatMap((field) => {
    const problem = problems[field];
    return problem === undefined ? [] : [{ field, problem }];
  });
  const fieldErrors: Partial<Record<TextField, string>> = {};
  for (const { field, problem } of entries) fieldErrors[field] = problem.message;
  const first = entries[0];
  if (first === undefined) return unexpectedQaState(values);
  const allTooLong = entries.every((e) => e.problem.code === "TOO_LONG");
  const code = allTooLong ? "TOO_LONG" : "VALIDATION_FAILED";
  const message = entries.length === 1 ? first.problem.message : QA_MESSAGES.fixFields;
  const details: Record<string, unknown> = { field: first.field };
  if (entries.length === 1 && first.problem.reason !== undefined) details.reason = first.problem.reason;
  return postError(appError(code, message, details), values, fieldErrors);
}

/** Generic state for unexpected failures. No internal detail leaves the server. */
export function unexpectedQaState(values: QaEchoValues = {}): QaActionState {
  return postError(appError("INVALID_INPUT", QA_MESSAGES.unavailable, { reason: "unavailable" }), values);
}

/** Generic vote state for unexpected failures. */
export function unexpectedVoteState(): QaVoteActionState {
  return voteError(appError("INVALID_INPUT", QA_MESSAGES.unavailable, { reason: "unavailable" }));
}

function rateLimited(error: AppError): { readonly error: AppError; readonly retryAfterSeconds?: number } {
  const retryAfterSeconds = readPositiveInt(error.details, "retryAfterSeconds");
  const message = rateLimitedMessage(retryAfterSeconds);
  return retryAfterSeconds === undefined
    ? { error: appError("RATE_LIMITED", message) }
    : { error: appError("RATE_LIMITED", message, { retryAfterSeconds }), retryAfterSeconds };
}

const ID_FIELDS: ReadonlySet<unknown> = new Set([QA_FIELD.productId, QA_FIELD.questionId, QA_FIELD.answerId]);

function invalidInput(details: AppError["details"]): AppError {
  const field = details?.field;
  return ID_FIELDS.has(field)
    ? appError("INVALID_INPUT", QA_MESSAGES.invalidRequest, { field })
    : appError("INVALID_INPUT", QA_MESSAGES.invalidRequest);
}

function textField(details: AppError["details"]): TextField | null {
  const field = details?.field;
  return field === "body" || field === "displayName" ? field : null;
}

/**
 * Maps a service/limiter error from ask/answer to a user-safe state. `details`
 * is rebuilt from a whitelist so raw input never reaches the client; the
 * service's field messages are built from constants only and are passed on.
 */
export function toPostErrorState(error: AppError, values: QaEchoValues): QaActionState {
  switch (error.code) {
    case "VALIDATION_FAILED":
    case "TOO_LONG": {
      const field = textField(error.details);
      if (field === null) return postError(appError(error.code, QA_MESSAGES.invalidRequest), values);
      const reason = error.details?.reason === "TOO_MANY_URLS" ? "TOO_MANY_URLS" : undefined;
      const problem: FieldProblem = reason === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, reason };
      return fieldErrorState({ [field]: problem }, values);
    }
    case "RATE_LIMITED": {
      const limited = rateLimited(error);
      return postError(limited.error, values, {}, limited.retryAfterSeconds);
    }
    case "DUPLICATE":
      return postError(appError("DUPLICATE", QA_MESSAGES.duplicateQuestion, { field: "body" }), values, {
        body: QA_MESSAGES.duplicateQuestion,
      });
    case "LIMIT_REACHED":
      return postError(appError("LIMIT_REACHED", QA_MESSAGES.limitReached, { limit: MAX_ANSWERS_PER_QUESTION }), values);
    case "PRODUCT_NOT_FOUND":
      return postError(appError("PRODUCT_NOT_FOUND", QA_MESSAGES.productNotFound), values);
    case "NOT_FOUND":
      return postError(appError("NOT_FOUND", QA_MESSAGES.questionNotFound), values);
    case "INVALID_INPUT":
      return postError(invalidInput(error.details), values);
    default:
      return unexpectedQaState(values);
  }
}

/** Maps a service/limiter error from a vote to a user-safe state. */
export function toVoteErrorState(error: AppError, target: "question" | "answer"): QaVoteActionState {
  switch (error.code) {
    case "RATE_LIMITED": {
      const limited = rateLimited(error);
      return voteError(limited.error, limited.retryAfterSeconds);
    }
    case "DUPLICATE":
      return voteError(appError("DUPLICATE", QA_MESSAGES.duplicateVote));
    case "FORBIDDEN":
      return voteError(appError("FORBIDDEN", QA_MESSAGES.forbiddenVote));
    case "NOT_FOUND":
      return voteError(
        appError("NOT_FOUND", target === "question" ? QA_MESSAGES.questionNotFound : QA_MESSAGES.answerNotFound),
      );
    case "INVALID_INPUT":
      return voteError(invalidInput(error.details));
    default:
      return unexpectedVoteState();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type ActionName = "ask" | "answer" | "voteQuestion" | "voteAnswer";

interface PostSpec {
  readonly name: "ask" | "answer";
  readonly target: QaPostTarget;
  readonly idField: "productId" | "questionId";
  readonly rules: PostRules;
  readonly limit: RateLimitedAction;
  readonly kind: "asked" | "answered";
  readonly message: string;
  readonly call: (service: QaService, sessionId: string, id: string, body: string, displayName: string | undefined, now: number | undefined) => Result<{ readonly id: string }, AppError>;
}

const ASK: PostSpec = {
  name: "ask",
  target: "question",
  idField: "productId",
  rules: QUESTION_RULES,
  limit: "question.ask",
  kind: "asked",
  message: QA_MESSAGES.asked,
  call: (service, sessionId, productId, body, displayName, now) => service.ask(sessionId, { productId, body, displayName }, now),
};

const ANSWER: PostSpec = {
  name: "answer",
  target: "answer",
  idField: "questionId",
  rules: ANSWER_RULES,
  limit: "answer.post",
  kind: "answered",
  message: QA_MESSAGES.answered,
  call: (service, sessionId, questionId, body, displayName, now) =>
    service.answer(sessionId, { questionId, body, displayName }, now),
};

export function createQaActions(deps: QaActionDeps): QaActions {
  const { service, limiter, getOrCreateSessionId, readCurrentUser, revalidatePath, now } = deps;
  const logger = deps.logger ?? console;

  function revalidate(slug: string | null): void {
    if (slug !== null) revalidatePath(`/products/${slug}`);
  }

  function logFailure(name: ActionName): void {
    // Error code + action name only: the exception may carry ids or submitted text.
    logger.error(`[qa] ${QA_ACTION_FAILED} action=${name}`);
  }

  function post(spec: PostSpec): QaActionFn {
    return async (_prevState, formData) => {
      let values: QaEchoValues = {};
      try {
        // Viewer first, so `values` never carries a posted displayName for a
        // signed-in shopper on any path (readCurrentUser never sets cookies).
        // Until the viewer is known, echo the body only (safe if the lookup throws).
        values = echoQaValues(formData, spec.target, true);
        const user = await readCurrentUser();
        values = echoQaValues(formData, spec.target, user !== null);
        const rawBody = readString(formData, QA_FIELD.body);
        const rawName = readString(formData, QA_FIELD.displayName);

        const id = parseIdField(formData, spec.idField);
        if (!id.ok) return postError(id.error, values);
        const slug = parseProductSlug(formData);
        const displayName = user !== null ? user.displayName : rawName;

        const problems: Partial<Record<TextField, FieldProblem>> = {};
        const bodyProblem = precheckBody(rawBody, spec.rules);
        if (bodyProblem !== null) problems.body = bodyProblem;
        const nameProblem = user === null ? precheckDisplayName(rawName) : null;
        if (nameProblem !== null) problems.displayName = nameProblem;
        if (bodyProblem !== null || nameProblem !== null) return fieldErrorState(problems, values);

        const sessionId = await getOrCreateSessionId();
        const limited = limitAction(limiter, spec.limit, sessionId);
        if (!limited.ok) return toPostErrorState(limited.error, values);

        const result = spec.call(service, sessionId, id.value, rawBody ?? "", displayName, now?.());
        if (!result.ok) return toPostErrorState(result.error, values);

        revalidate(slug);
        return { ok: true, kind: spec.kind, id: result.value.id, message: spec.message };
      } catch {
        logFailure(spec.name);
        return unexpectedQaState(values);
      }
    };
  }

  function vote(name: "voteQuestion" | "voteAnswer"): QaVoteActionFn {
    const target = name === "voteQuestion" ? "question" : "answer";
    const idField = name === "voteQuestion" ? "questionId" : "answerId";
    return async (_prevState, formData) => {
      try {
        const id = parseIdField(formData, idField);
        if (!id.ok) return voteError(id.error);
        const slug = parseProductSlug(formData);

        const sessionId = await getOrCreateSessionId();
        const limited = limitAction(limiter, "vote", sessionId);
        if (!limited.ok) return toVoteErrorState(limited.error, target);

        const result =
          target === "question" ? service.voteQuestion(sessionId, id.value) : service.voteAnswer(sessionId, id.value);
        if (!result.ok) return toVoteErrorState(result.error, target);

        revalidate(slug);
        return { ok: true, helpfulCount: result.value.helpfulCount, message: QA_MESSAGES.voted };
      } catch {
        logFailure(name);
        return unexpectedVoteState();
      }
    };
  }

  return {
    askQuestion: post(ASK),
    answerQuestion: post(ANSWER),
    voteQuestion: vote("voteQuestion"),
    voteAnswer: vote("voteAnswer"),
  };
}
