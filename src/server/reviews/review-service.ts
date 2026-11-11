import type { Database } from "bun:sqlite";
import type { Review, ReviewSummary, StarRating } from "@/lib/types";
import { appError, err, fail, ok, type AppError, type Result } from "@/lib/result";
import { getDatabase, withTransaction } from "@/server/db/client";
import { ratingAverage, recomputeProductRating } from "@/server/catalog/product-repository";
import { cleanText, countUrls } from "@/server/security/text-guard";
import { isSessionId } from "@/server/session/session-id";
import { SqliteReviewRepository, type ReviewRepository, type ReviewSortKey } from "./review-repository";

/**
 * Reviews (server-only). All methods are synchronous (bun:sqlite is sync and
 * `withTransaction` needs a sync callback); server actions wrap them.
 *
 * `sessionId` everywhere is an OWNER KEY (guest session id or a user's
 * `owner_key`, both UUID v4). It is validated before any SQL and never
 * returned to callers. Review text is stored verbatim after `cleanText`
 * (no HTML handling: the UI renders it as React text). See README.md.
 */

export type ReviewSort = "helpful" | "recent";

export interface ReviewListQuery {
  /** Unknown strings fall back to `DEFAULT_REVIEW_SORT`. */
  readonly sort?: ReviewSort | string;
  readonly stars?: 1 | 2 | 3 | 4 | 5;
  readonly verifiedOnly?: boolean;
  /** 1-based; invalid values become 1. */
  readonly page?: number;
  /** Clamped to 1..20; default 10. */
  readonly pageSize?: number;
}

/** A listed review plus per-viewer flags. Never includes the author's owner key. */
export interface ReviewView extends Review {
  readonly votedByViewer?: boolean;
  readonly isOwn?: boolean;
}

export interface ReviewListResult {
  readonly items: readonly ReviewView[];
  /** Matching published reviews (after the star / verified filters). */
  readonly total: number;
  readonly page: number;
  /** `ceil(total / pageSize)`; 0 when nothing matches. */
  readonly pageCount: number;
  /** Unfiltered summary over all published reviews of the product. */
  readonly summary: ReviewSummary;
}

export interface CreateReviewInput {
  readonly productId: string;
  readonly rating: unknown;
  readonly title: unknown;
  readonly body: unknown;
  readonly displayName?: unknown;
}

export interface ReviewService {
  create(sessionId: string, input: CreateReviewInput, now?: number): Result<Review, AppError>;
  list(productId: string, query?: ReviewListQuery, viewerSessionId?: string | null): Result<ReviewListResult, AppError>;
  summary(productId: string): ReviewSummary;
  voteHelpful(sessionId: string, reviewId: string): Result<{ helpfulCount: number }, AppError>;
  listMine(sessionId: string): readonly Review[];
  hasReviewed(sessionId: string, productId: string): boolean;
}

export interface ReviewServiceDeps {
  readonly db: Database;
  /** Clock in epoch ms (tests); defaults to `Date.now`. A `now` argument to `create` wins. */
  readonly now?: () => number;
  /** Review id generator (tests); defaults to `crypto.randomUUID`. */
  readonly idGenerator?: () => string;
}

export const REVIEW_TITLE_MAX = 100;
export const REVIEW_BODY_MAX = 2000;
export const REVIEW_DISPLAY_NAME_MAX = 50;
/** Bodies with more URLs than this are rejected as spam. */
export const REVIEW_MAX_URLS = 2;
export const DEFAULT_DISPLAY_NAME = "Anonymous shopper";
export const DEFAULT_REVIEW_SORT: ReviewSort = "helpful";
export const DEFAULT_REVIEW_PAGE_SIZE = 10;
export const MAX_REVIEW_PAGE_SIZE = 20;
/** Upper bound for `page` so `offset` stays a safe integer. */
export const MAX_REVIEW_PAGE = 1_000_000;
/** Ids longer than this cannot exist (seed and app ids are short); rejected without SQL. */
const MAX_ID_LENGTH = 200;

export type ReviewField = "rating" | "title" | "body" | "displayName";
export type ReviewFieldErrorCode = "REQUIRED" | "INVALID" | "TOO_LONG" | "TOO_MANY_URLS";
export interface ReviewFieldError {
  readonly code: ReviewFieldErrorCode;
  readonly message: string;
}
export type ReviewFieldErrors = Readonly<Partial<Record<ReviewField, ReviewFieldError>>>;

const STARS: readonly StarRating[] = [1, 2, 3, 4, 5];

/** Thrown inside a transaction to roll it back; converted to `Err` outside. */
class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

function emptySummary(): ReviewSummary {
  return { count: 0, avg: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
}

function isPlausibleId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isStar(value: unknown): value is StarRating {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** Integer 1..5, or a string of exactly one such digit (FormData), surrounding ASCII spaces allowed. */
function parseRating(raw: unknown): Result<StarRating, ReviewFieldError> {
  if (raw === undefined || raw === null || raw === "") {
    return err({ code: "REQUIRED", message: "Choose a rating from 1 to 5 stars." });
  }
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    value = trimmed.length === 1 ? Number(trimmed) : Number.NaN;
  }
  if (isStar(value)) return ok(value);
  return err({ code: "INVALID", message: "Rating must be a whole number from 1 to 5." });
}

function textField(
  raw: unknown,
  max: number,
  label: string,
  options: { required: boolean; multiline: boolean },
): Result<string, ReviewFieldError> {
  if (raw === undefined || raw === null) {
    return options.required ? err({ code: "REQUIRED", message: `${label} is required.` }) : ok("");
  }
  const cleaned = cleanText(raw, { max, multiline: options.multiline });
  if (!cleaned.ok) {
    if (cleaned.error.code === "TOO_LONG") {
      return err({ code: "TOO_LONG", message: `${label} must be at most ${max} characters.` });
    }
    return err({ code: "INVALID", message: `${label} must be text.` });
  }
  if (options.required && cleaned.value.length === 0) {
    return err({ code: "REQUIRED", message: `${label} is required.` });
  }
  return ok(cleaned.value);
}

interface ValidReview {
  readonly rating: StarRating;
  readonly title: string;
  readonly body: string;
  readonly displayName: string;
}

/**
 * Validates every field and reports all problems at once in `details.fields`.
 * Top-level code is `TOO_LONG` when every failing field is too long, else
 * `VALIDATION_FAILED`.
 */
export function validateReviewInput(input: CreateReviewInput): Result<ValidReview, AppError> {
  const fields: Partial<Record<ReviewField, ReviewFieldError>> = {};
  const rating = parseRating(input.rating);
  if (!rating.ok) fields.rating = rating.error;
  const title = textField(input.title, REVIEW_TITLE_MAX, "Title", { required: true, multiline: false });
  if (!title.ok) fields.title = title.error;
  const body = textField(input.body, REVIEW_BODY_MAX, "Review", { required: true, multiline: true });
  if (!body.ok) fields.body = body.error;
  else if (countUrls(body.value) > REVIEW_MAX_URLS) {
    fields.body = { code: "TOO_MANY_URLS", message: `Reviews can contain at most ${REVIEW_MAX_URLS} links.` };
  }
  const name = textField(input.displayName, REVIEW_DISPLAY_NAME_MAX, "Display name", {
    required: false,
    multiline: false,
  });
  if (!name.ok) fields.displayName = name.error;

  const errors = Object.values(fields);
  if (errors.length > 0 || !rating.ok || !title.ok || !body.ok || !name.ok) {
    const allTooLong = errors.every((e) => e.code === "TOO_LONG");
    return allTooLong
      ? fail("TOO_LONG", "Some fields are too long.", { fields })
      : fail("VALIDATION_FAILED", "Some fields are invalid.", { fields });
  }
  return ok({
    rating: rating.value,
    title: title.value,
    body: body.value,
    displayName: name.value.length > 0 ? name.value : DEFAULT_DISPLAY_NAME,
  });
}

function normaliseSort(sort: unknown): ReviewSortKey {
  return sort === "helpful" || sort === "recent" ? sort : DEFAULT_REVIEW_SORT;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isoFromEpochMs(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

class SqliteReviewService implements ReviewService {
  private readonly db: Database;
  private readonly repo: ReviewRepository;
  private readonly clock: () => number;
  private readonly idGenerator: () => string;

  constructor(deps: ReviewServiceDeps) {
    this.db = deps.db;
    this.repo = new SqliteReviewRepository(deps.db);
    this.clock = deps.now ?? Date.now;
    this.idGenerator = deps.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  create(sessionId: string, input: CreateReviewInput, now?: number): Result<Review, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "A valid session is required.");
    const valid = validateReviewInput(input);
    if (!valid.ok) return valid;
    const productId: unknown = input.productId;
    if (!isPlausibleId(productId)) return fail("PRODUCT_NOT_FOUND", "Product not found.");
    const createdAt = isoFromEpochMs(now ?? this.clock());
    if (createdAt === null) return fail("INVALID_INPUT", "Invalid timestamp.");

    try {
      return withTransaction(this.db, () => {
        if (!this.repo.productExists(productId)) throw new Abort(appError("PRODUCT_NOT_FOUND", "Product not found."));
        const id = this.idGenerator();
        const inserted = this.repo.insert({
          id,
          productId,
          sessionId,
          displayName: valid.value.displayName,
          rating: valid.value.rating,
          title: valid.value.title,
          body: valid.value.body,
          verifiedPurchase: this.repo.hasPurchased(sessionId, productId),
          createdAt,
        });
        if (!inserted) throw new Abort(appError("DUPLICATE", "You have already reviewed this product."));
        this.ensureAggregates(productId);
        const review = this.repo.getById(id);
        if (review === null) throw new Error("ReviewService: inserted review not found");
        return ok(review);
      });
    } catch (e) {
      if (e instanceof Abort) return err(e.error);
      throw e;
    }
  }

  /** Trigger-maintained aggregates must equal a fresh aggregate; recompute if they ever drift. */
  private ensureAggregates(productId: string): void {
    const stored = this.repo.storedAggregate(productId);
    const fresh = this.repo.aggregate(productId);
    if (stored === null || stored.count !== fresh.count || stored.sum !== fresh.sum) {
      recomputeProductRating(this.db, productId);
    }
  }

  list(productId: string, query: ReviewListQuery = {}, viewerSessionId: string | null = null): Result<ReviewListResult, AppError> {
    if (!isPlausibleId(productId) || !this.repo.productExists(productId)) {
      return fail("PRODUCT_NOT_FOUND", "Product not found.");
    }
    const sort = normaliseSort(query.sort);
    const pageSize = clampInt(query.pageSize, 1, MAX_REVIEW_PAGE_SIZE, DEFAULT_REVIEW_PAGE_SIZE);
    const page = clampInt(query.page, 1, MAX_REVIEW_PAGE, 1);
    const filter = {
      ...(isStar(query.stars) ? { stars: query.stars } : {}),
      ...(query.verifiedOnly === true ? { verifiedOnly: true } : {}),
    };
    const viewer = isSessionId(viewerSessionId) ? viewerSessionId : null;

    const total = this.repo.countPublished(productId, filter);
    const pageCount = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const rows = offset >= total ? [] : this.repo.listPublished(productId, { ...filter, sort, limit: pageSize, offset, viewer });
    const items: ReviewView[] = rows.map((row) =>
      viewer === null ? row.review : { ...row.review, votedByViewer: row.votedByViewer === true, isOwn: row.isOwn === true },
    );
    return ok({ items, total, page, pageCount, summary: this.summary(productId) });
  }

  summary(productId: string): ReviewSummary {
    if (!isPlausibleId(productId)) return emptySummary();
    const counts = this.repo.histogram(productId);
    const histogram: Record<StarRating, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let sum = 0;
    for (const star of STARS) {
      const n = counts.get(star) ?? 0;
      histogram[star] = n;
      count += n;
      sum += n * star;
    }
    return { count, avg: ratingAverage(sum, count), histogram };
  }

  voteHelpful(sessionId: string, reviewId: string): Result<{ helpfulCount: number }, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "A valid session is required.");
    if (!isPlausibleId(reviewId)) return fail("NOT_FOUND", "Review not found.");
    try {
      return withTransaction(this.db, () => {
        const target = this.repo.getVoteTarget(reviewId);
        if (target === null || target.status !== "published") throw new Abort(appError("NOT_FOUND", "Review not found."));
        if (target.authorSessionId === sessionId) {
          throw new Abort(appError("FORBIDDEN", "You cannot vote on your own review."));
        }
        if (!this.repo.insertVote(reviewId, sessionId)) {
          throw new Abort(appError("DUPLICATE", "You already marked this review as helpful."));
        }
        const helpfulCount = this.repo.helpfulCount(reviewId);
        if (helpfulCount === null) throw new Error("ReviewService: voted review not found");
        return ok({ helpfulCount });
      });
    } catch (e) {
      if (e instanceof Abort) return err(e.error);
      throw e;
    }
  }

  listMine(sessionId: string): readonly Review[] {
    return isSessionId(sessionId) ? this.repo.listBySession(sessionId) : [];
  }

  hasReviewed(sessionId: string, productId: string): boolean {
    if (!isSessionId(sessionId) || !isPlausibleId(productId)) return false;
    return this.repo.existsForSession(sessionId, productId);
  }
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  return new SqliteReviewService(deps);
}

interface ReviewServiceCache {
  readonly db: Database;
  readonly service: ReviewService;
}

const globalForReviews = globalThis as typeof globalThis & {
  __storefrontReviewService?: ReviewServiceCache;
};

/** App-wide service over `getDatabase()`, cached on `globalThis` (dev HMR safe); rebuilt if the DB handle changes. */
export function getReviewService(): ReviewService {
  const db = getDatabase();
  const cached = globalForReviews.__storefrontReviewService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createReviewService({ db });
  globalForReviews.__storefrontReviewService = { db, service };
  return service;
}
