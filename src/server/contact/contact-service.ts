import type { Database } from "bun:sqlite";
import type { ContactMessage, IsoDateTimeString } from "@/lib/types";
import { err, fail, ok, type AppError, type Result } from "@/lib/result";
import { getDatabase, withTransaction } from "@/server/db/client";
import { cleanText, countUrls } from "@/server/security/text-guard";
import { isSessionId } from "@/server/session/session-id";
import { SqliteContactRepository, type ContactRepository } from "./contact-repository";

/**
 * Contact messages (server-only, synchronous). See README.md in this folder.
 * PII rule: name, email and message are never passed to the logger.
 */

export const CONTACT_TOPICS = [
  "ordering",
  "payments",
  "shipping",
  "returns",
  "lists",
  "reviews",
  "account",
  "accessibility",
  "product",
  "feedback",
  "other",
] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export const CONTACT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/** Input limits (BACKLOG-phase2.md, Input limits table). */
export const CONTACT_NAME_MAX = 80;
export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_MESSAGE_MIN = 10;
export const CONTACT_MESSAGE_MAX = 2000;
export const CONTACT_MAX_URLS = 3;
export const CONTACT_EXCERPT_LENGTH = 80;
/** Longest accepted order id / product slug reference (longer values are rejected / dropped). */
export const CONTACT_REF_MAX = 128;
/** `listForSession` returns at most this many messages. */
export const CONTACT_LIST_LIMIT = 200;
export const REFERENCE_PREFIX = "C-";
export const REFERENCE_BODY_LENGTH = 8;
/** Crockford base32: digits and upper-case letters without I, L, O, U. */
export const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_REFERENCE_ATTEMPTS = 5;

export interface ContactInput {
  readonly name: unknown;
  readonly email: unknown;
  readonly topic: unknown;
  readonly message: unknown;
  readonly orderId?: unknown;
  readonly productSlug?: unknown;
}

export interface ContactReceipt {
  readonly reference: string;
  readonly createdAt: IsoDateTimeString;
}

export interface ContactMessageView {
  readonly reference: string;
  readonly topic: ContactTopic;
  readonly createdAt: IsoDateTimeString;
  readonly orderId: string | null;
  readonly productSlug: string | null;
  /** First 80 characters (code points) of the stored message. */
  readonly excerpt: string;
}

export type ContactField = "name" | "email" | "topic" | "message" | "orderId";
export type ContactFieldErrorCode =
  | "REQUIRED"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "INVALID_EMAIL"
  | "INVALID_TOPIC"
  | "TOO_MANY_URLS"
  | "INVALID_ORDER";
export interface ContactFieldError {
  readonly code: ContactFieldErrorCode;
  readonly message: string;
}
export type ContactFieldErrors = Readonly<Partial<Record<ContactField, ContactFieldError>>>;

export interface ContactService {
  submit(sessionId: string | null, input: ContactInput, now?: number): Result<ContactReceipt, AppError>;
  listForSession(sessionId: string): readonly ContactMessageView[];
  getByReference(sessionId: string, reference: string): Result<ContactMessage, AppError>;
}

export interface ContactServiceDeps {
  readonly db: Database;
  readonly logger?: Pick<Console, "error" | "warn">;
  /** Test seam: random source for references (defaults to crypto). Additive to the T42 contract. */
  readonly random?: () => number;
}

/** Same rule as `validateAddress` in src/lib/validation.ts (not exported there). Linear; run on <= 254 chars. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const TOPIC_SET: ReadonlySet<string> = new Set(CONTACT_TOPICS);

/**
 * `"C-"` + 8 characters from `REFERENCE_ALPHABET`. Default source:
 * `crypto.getRandomValues` (byte & 31 is unbiased since 256 % 32 === 0).
 * `random` must return values in [0, 1); out-of-range values are clamped.
 */
export function generateReference(random?: () => number): string {
  let body = "";
  if (random === undefined) {
    const bytes = new Uint8Array(REFERENCE_BODY_LENGTH);
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) body += REFERENCE_ALPHABET[b & 31];
  } else {
    for (let i = 0; i < REFERENCE_BODY_LENGTH; i++) {
      const r = random();
      const idx = Number.isFinite(r) ? Math.min(31, Math.max(0, Math.floor(r * 32))) : 0;
      body += REFERENCE_ALPHABET[idx];
    }
  }
  return REFERENCE_PREFIX + body;
}

const REFERENCE_RE = /^C-[0-9A-HJKMNP-TV-Z]{8}$/;

function isContactTopic(value: string): value is ContactTopic {
  return TOPIC_SET.has(value);
}

function excerptOf(message: string): string {
  const points = Array.from(message.slice(0, CONTACT_EXCERPT_LENGTH * 2));
  return points.length <= CONTACT_EXCERPT_LENGTH ? points.join("") : points.slice(0, CONTACT_EXCERPT_LENGTH).join("");
}

/**
 * Validates one free-text field: `cleanText` with `min: 0`, then the length
 * rules here, so an empty cleaned value is `REQUIRED` and 1..min-1 is `TOO_SHORT`.
 */
function checkText(
  raw: unknown,
  label: string,
  max: number,
  min: number,
  multiline: boolean,
): Result<string, ContactFieldError> {
  const cleaned = cleanText(raw, { max, multiline });
  if (!cleaned.ok) {
    return cleaned.error.code === "TOO_LONG"
      ? err({ code: "TOO_LONG", message: `${label} must be at most ${max} characters.` })
      : err({ code: "REQUIRED", message: `${label} is required.` });
  }
  if (cleaned.value.length === 0) return err({ code: "REQUIRED", message: `${label} is required.` });
  if (cleaned.value.length < min) {
    return err({ code: "TOO_SHORT", message: `${label} must be at least ${min} characters.` });
  }
  return ok(cleaned.value);
}

/** Cleaned values of the four always-present fields. */
export interface ContactCleanedFields {
  readonly name: string;
  readonly email: string;
  readonly topic: ContactTopic;
  readonly message: string;
}

export interface ContactFieldsValidation {
  /** Field errors for name, email, topic and message (empty when valid). */
  readonly fields: ContactFieldErrors;
  /** Present exactly when `fields` is empty. */
  readonly cleaned?: ContactCleanedFields;
}

/**
 * Pure field validation shared by `submit` and the contact action's
 * pre-check: name, email, topic, message (incl. the URL limit). No DB access:
 * no orderId/productSlug, duplicate or rate-limit checks. Never throws.
 */
export function validateContactFields(input: unknown): ContactFieldsValidation {
  const raw: Readonly<Record<string, unknown>> =
    typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const fields: Partial<Record<ContactField, ContactFieldError>> = {};

  const name = checkText(raw.name, "Name", CONTACT_NAME_MAX, 1, false);
  if (!name.ok) fields.name = name.error;

  const email = checkText(raw.email, "Email", CONTACT_EMAIL_MAX, 1, false);
  if (!email.ok) fields.email = email.error;
  else if (!EMAIL_PATTERN.test(email.value)) {
    fields.email = { code: "INVALID_EMAIL", message: "Enter a valid email address." };
  }

  let topic: ContactTopic | null = null;
  const rawTopic = raw.topic;
  if (typeof rawTopic === "string" && rawTopic.length <= 32) {
    const t = rawTopic.trim();
    if (isContactTopic(t)) topic = t;
  }
  if (topic === null) fields.topic = { code: "INVALID_TOPIC", message: "Choose a topic." };

  const message = checkText(raw.message, "Message", CONTACT_MESSAGE_MAX, CONTACT_MESSAGE_MIN, true);
  if (!message.ok) fields.message = message.error;
  else if (countUrls(message.value) > CONTACT_MAX_URLS) {
    fields.message = { code: "TOO_MANY_URLS", message: `Messages can include at most ${CONTACT_MAX_URLS} links.` };
  }

  if (Object.keys(fields).length > 0 || !name.ok || !email.ok || !message.ok || topic === null) {
    return { fields };
  }
  return { fields, cleaned: { name: name.value, email: email.value, topic, message: message.value } };
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.code);
  }
}

/** Safe description of a thrown value: error name and SQLite code only, never its message (may echo values). */
function describeError(e: unknown): { name: string; code?: string } {
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    return typeof code === "string" ? { name: e.name, code } : { name: e.name };
  }
  return { name: typeof e };
}

interface Validated {
  readonly name: string;
  readonly email: string;
  readonly topic: ContactTopic;
  readonly message: string;
  readonly orderId: string | null;
  readonly productSlug: string | null;
}

export class SqliteContactService implements ContactService {
  private readonly repo: ContactRepository;
  private readonly logger: Pick<Console, "error" | "warn">;
  private readonly random: (() => number) | undefined;

  constructor(private readonly deps: ContactServiceDeps, repo?: ContactRepository) {
    this.repo = repo ?? new SqliteContactRepository(deps.db);
    this.logger = deps.logger ?? console;
    this.random = deps.random;
  }

  submit(sessionId: string | null, input: ContactInput, now: number = Date.now()): Result<ContactReceipt, AppError> {
    const owner = isSessionId(sessionId) ? sessionId : null;
    if (!Number.isFinite(now)) return fail("INVALID_INPUT", "Invalid clock value.");
    const raw: Partial<ContactInput> =
      typeof input === "object" && input !== null ? input : ({} as Partial<ContactInput>);

    try {
      const createdAt = new Date(now).toISOString();
      const validated = this.validate(owner, raw, createdAt);
      if (!validated.ok) return validated;
      const v = validated.value;
      const since = new Date(now - CONTACT_DUPLICATE_WINDOW_MS).toISOString();

      return withTransaction(this.deps.db, () => {
        if (owner !== null && this.repo.hasRecentDuplicate(owner, v.message, since)) {
          throw new Abort({
            code: "DUPLICATE",
            message: "We already received this message. Our team will reply soon.",
          });
        }
        let reference: string | null = null;
        for (let i = 0; i < MAX_REFERENCE_ATTEMPTS; i++) {
          const candidate = generateReference(this.random);
          if (!this.repo.referenceExists(candidate)) {
            reference = candidate;
            break;
          }
        }
        if (reference === null) {
          this.logger.error("contact: could not generate a unique reference", { attempts: MAX_REFERENCE_ATTEMPTS });
          throw new Abort({ code: "INVALID_INPUT", message: "We could not send your message. Please try again." });
        }
        this.repo.insert({
          id: globalThis.crypto.randomUUID(),
          reference,
          sessionId: owner,
          name: v.name,
          email: v.email,
          topic: v.topic,
          orderId: v.orderId,
          productSlug: v.productSlug,
          message: v.message,
          createdAt,
        });
        return ok({ reference, createdAt });
      });
    } catch (e) {
      if (e instanceof Abort) return { ok: false, error: e.error };
      this.logger.error("contact: submit failed", describeError(e));
      return fail("INVALID_INPUT", "We could not send your message. Please try again.");
    }
  }

  listForSession(sessionId: string): readonly ContactMessageView[] {
    if (!isSessionId(sessionId)) return [];
    try {
      const views: ContactMessageView[] = [];
      for (const r of this.repo.listForSession(sessionId, CONTACT_LIST_LIMIT)) {
        views.push({
          reference: r.reference,
          topic: isContactTopic(r.topic) ? r.topic : "other",
          createdAt: r.createdAt,
          orderId: r.orderId,
          productSlug: r.productSlug,
          excerpt: excerptOf(r.message),
        });
      }
      return views;
    } catch (e) {
      this.logger.error("contact: list failed", describeError(e));
      return [];
    }
  }

  getByReference(sessionId: string, reference: string): Result<ContactMessage, AppError> {
    const notFound = fail("NOT_FOUND", "Message not found.");
    if (!isSessionId(sessionId) || typeof reference !== "string" || reference.length > 32) return notFound;
    const normalized = reference.trim().toUpperCase();
    if (!REFERENCE_RE.test(normalized)) return notFound;
    try {
      const found = this.repo.getOwnedByReference(sessionId, normalized);
      return found === null ? notFound : ok(found);
    } catch (e) {
      this.logger.error("contact: lookup failed", describeError(e));
      return notFound;
    }
  }

  private validate(owner: string | null, raw: Partial<ContactInput>, nowIso: string): Result<Validated, AppError> {
    const base = validateContactFields(raw);
    const fields: Partial<Record<ContactField, ContactFieldError>> = { ...base.fields };

    // Order reference: same answer for malformed, missing, foreign, or no session (no existence leak).
    let orderId: string | null = null;
    if (!isAbsent(raw.orderId)) {
      const candidate = typeof raw.orderId === "string" ? raw.orderId.trim() : "";
      const owned =
        owner !== null &&
        candidate.length > 0 &&
        candidate.length <= CONTACT_REF_MAX &&
        this.repo.isOrderOwnedBy(owner, candidate);
      if (owned) orderId = candidate;
      else fields.orderId = { code: "INVALID_ORDER", message: "We could not find that order in your order history." };
    }

    // Product reference: unknown, unpublished (at `now`) or malformed slugs are dropped silently.
    let productSlug: string | null = null;
    if (typeof raw.productSlug === "string") {
      const slug = raw.productSlug.trim();
      if (slug.length > 0 && slug.length <= CONTACT_REF_MAX && this.repo.productSlugExists(slug, nowIso)) {
        productSlug = slug;
      }
    }

    const errors = Object.values(fields);
    if (errors.length > 0 || base.cleaned === undefined) {
      const allTooLong = errors.length > 0 && errors.every((f) => f.code === "TOO_LONG");
      return fail(
        allTooLong ? "TOO_LONG" : "VALIDATION_FAILED",
        allTooLong ? "Some fields are too long." : "Some fields are invalid.",
        { fields: fields as ContactFieldErrors },
      );
    }
    return ok({ ...base.cleaned, orderId, productSlug });
  }
}

export function createContactService(deps: ContactServiceDeps): ContactService {
  return new SqliteContactService(deps);
}

const globalForContact = globalThis as typeof globalThis & {
  __storefrontContactService?: { db: Database; service: ContactService };
};

/** App-wide service over the shared database, cached on `globalThis` (rebuilt if the DB handle changes). */
export function getContactService(): ContactService {
  const db = getDatabase();
  const cached = globalForContact.__storefrontContactService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createContactService({ db });
  globalForContact.__storefrontContactService = { db, service };
  return service;
}
