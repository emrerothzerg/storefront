import type {
  ContactActionFn,
  ContactActionState,
  ContactEchoValues,
} from "@/components/molecules/_contracts/contact-actions";
import { CONTACT_FIELD } from "@/components/molecules/_contracts/contact-actions";
import { appError, type AppError } from "@/lib/result";
import {
  CONTACT_EMAIL_MAX,
  CONTACT_MESSAGE_MAX,
  CONTACT_NAME_MAX,
  generateReference,
  validateContactFields,
  type ContactField,
  type ContactFieldError,
  type ContactFieldErrorCode,
  type ContactService,
} from "@/server/contact/contact-service";
import { limitAction, type RateLimiter } from "@/server/security/rate-limiter";

/**
 * Framework-free contact action logic (T51). `contact.ts` wires it to Next.js
 * (`getOrCreateSessionId`, `getContactService()`, `getRateLimiter()`,
 * `revalidatePath`); tests inject fakes.
 *
 * Flow of `sendContactMessage`:
 * 1. Read the `CONTACT_FIELD` strings (non-string = missing; extra fields such
 *    as `sessionId`, `reference`, `status` are never read).
 * 2. Honeypot (`website` non-empty): return a success-looking state with a
 *    fake reference from `generateReference()`. Stores nothing, sets no
 *    cookie, calls no limiter, revalidates nothing (D14, T51 criterion 4).
 * 3. Local pre-check via the service's `validateContactFields` (all DB-free
 *    rules: required, lengths, email pattern, topic, link count). A failure
 *    returns EVERY failing field at once, without creating a session or
 *    spending a rate-limit token, so a typo does not eat into the 3/hour budget.
 * 4. `getOrCreateSessionId()` (lazy cookie), then `limitAction("contact.submit")`.
 * 5. `service.submit` (re-validates, checks order ownership and duplicates,
 *    inserts). Success revalidates `/account/messages`.
 *
 * Every outcome is a state; unexpected exceptions become a generic error state
 * and are logged as an error code only (no ids, no input, no PII).
 */

export interface ContactActionDeps {
  readonly service: ContactService;
  readonly limiter: RateLimiter;
  readonly getOrCreateSessionId: () => Promise<string>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Epoch milliseconds passed to the service; service default when absent. */
  readonly now?: () => number;
  /** Receives only `CONTACT_ACTION_FAILED`; defaults to `console`. */
  readonly logger?: Pick<Console, "error">;
}

export interface ContactActions {
  readonly sendContactMessage: ContactActionFn;
}

export const ACCOUNT_MESSAGES_PATH = "/account/messages";

/** Logged when the action hits an unexpected exception. */
export const CONTACT_ACTION_FAILED = "CONTACT_ACTION_FAILED";

/** Echo caps for `ContactEchoValues` (topic/orderId are echoed only when within `ECHO_REF_MAX`). */
export const ECHO_REF_MAX = 64;

export const CONTACT_MESSAGES = {
  sent: "Thanks, we received your message.",
  invalid: "Some fields are invalid.",
  tooLong: "Some fields are too long.",
  duplicate: "We already received this message. Reference numbers were shown on your previous submission.",
  unavailable: "We could not send your message. Please try again.",
  rateLimitedFallback: "You have sent several messages recently. Please try again later.",
} as const;

export function successMessage(reference: string): string {
  return `${CONTACT_MESSAGES.sent} Your reference number is ${reference}.`;
}

export function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return CONTACT_MESSAGES.rateLimitedFallback;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  if (minutes < 120) {
    return `You have sent several messages recently. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  const hours = Math.ceil(minutes / 60);
  return `You have sent several messages recently. Please try again in ${hours} hours.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedContactForm {
  readonly name: string | undefined;
  readonly email: string | undefined;
  readonly topic: string | undefined;
  readonly message: string | undefined;
  readonly orderId: string | undefined;
  readonly productSlug: string | undefined;
  /** True when the honeypot holds any non-empty string. */
  readonly honeypot: boolean;
}

function readString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Reads only the contract fields. A non-string entry (a `File`) is treated as missing. */
export function parseContactForm(formData: FormData): ParsedContactForm {
  const website = readString(formData, CONTACT_FIELD.website);
  return {
    name: readString(formData, CONTACT_FIELD.name),
    email: readString(formData, CONTACT_FIELD.email),
    topic: readString(formData, CONTACT_FIELD.topic),
    message: readString(formData, CONTACT_FIELD.message),
    orderId: readString(formData, CONTACT_FIELD.orderId),
    productSlug: readString(formData, CONTACT_FIELD.productSlug),
    honeypot: website !== undefined && website.length > 0,
  };
}

/** Cuts to `max` UTF-16 units without leaving a dangling high surrogate. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Values to re-fill the form with. Never includes the honeypot or productSlug. */
export function echoValues(parsed: ParsedContactForm): ContactEchoValues {
  const out: { -readonly [K in keyof ContactEchoValues]: string } = {};
  if (parsed.name !== undefined) out.name = truncate(parsed.name, CONTACT_NAME_MAX);
  if (parsed.email !== undefined) out.email = truncate(parsed.email, CONTACT_EMAIL_MAX);
  if (parsed.message !== undefined) out.message = truncate(parsed.message, CONTACT_MESSAGE_MAX);
  if (parsed.topic !== undefined && parsed.topic.length <= ECHO_REF_MAX) out.topic = parsed.topic;
  if (parsed.orderId !== undefined && parsed.orderId.length <= ECHO_REF_MAX) out.orderId = parsed.orderId;
  return out;
}

// ---------------------------------------------------------------------------
// Local pre-check
// ---------------------------------------------------------------------------

/**
 * All DB-free field errors (name, email incl. pattern, topic, message incl.
 * the link limit), computed by the service's own `validateContactFields`, so
 * codes and messages are identical and every failing field is reported at
 * once. Order ownership and duplicates need the DB and stay in
 * `service.submit`, after the limiter. Empty object = everything passes.
 */
export function precheckContact(parsed: ParsedContactForm): Partial<Record<ContactField, ContactFieldError>> {
  return validateContactFields({
    name: parsed.name,
    email: parsed.email,
    topic: parsed.topic,
    message: parsed.message,
  }).fields;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const ECHO_FIELDS: readonly ContactField[] = ["name", "email", "topic", "message", "orderId"];
const FIELD_CODES: ReadonlySet<unknown> = new Set<ContactFieldErrorCode>([
  "REQUIRED",
  "TOO_SHORT",
  "TOO_LONG",
  "INVALID_EMAIL",
  "INVALID_TOPIC",
  "TOO_MANY_URLS",
  "INVALID_ORDER",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the field-error state from `{ [field]: { code, message } }` (service
 * `details.fields` or the local pre-check). Only known fields with a known
 * code and a string message are kept; `error.details.fields` carries codes only.
 */
export function fieldErrorState(source: unknown, values: ContactEchoValues): ContactActionState {
  const fieldErrors: Partial<Record<ContactField, string>> = {};
  const codes: Partial<Record<ContactField, ContactFieldErrorCode>> = {};
  if (isRecord(source)) {
    for (const field of ECHO_FIELDS) {
      const entry = source[field];
      if (!isRecord(entry)) continue;
      const code = entry.code;
      const message = entry.message;
      if (!FIELD_CODES.has(code) || typeof message !== "string") continue;
      fieldErrors[field] = message;
      codes[field] = code as ContactFieldErrorCode;
    }
  }
  const all = Object.values(codes);
  const allTooLong = all.length > 0 && all.every((c) => c === "TOO_LONG");
  const error = allTooLong
    ? appError("TOO_LONG", CONTACT_MESSAGES.tooLong, { fields: codes })
    : appError("VALIDATION_FAILED", CONTACT_MESSAGES.invalid, { fields: codes });
  return { ok: false, error, message: error.message, fieldErrors, values };
}

function readPositiveInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

function plainError(error: AppError, values: ContactEchoValues, retryAfterSeconds?: number): ContactActionState {
  const base = { ok: false as const, error, message: error.message, fieldErrors: {}, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

/** Generic state for unexpected failures. No internal detail leaves the server. */
export function unexpectedErrorState(values: ContactEchoValues = {}): ContactActionState {
  return plainError(appError("INVALID_INPUT", CONTACT_MESSAGES.unavailable, { reason: "unavailable" }), values);
}

/**
 * Maps any service/limiter error to a user-safe state. `details` is rebuilt
 * from a whitelist so raw input never reaches the client.
 */
export function toErrorState(error: AppError, values: ContactEchoValues): ContactActionState {
  switch (error.code) {
    case "VALIDATION_FAILED":
    case "TOO_LONG":
      return fieldErrorState(error.details?.fields, values);
    case "RATE_LIMITED": {
      const retryAfterSeconds = readPositiveInt(error.details, "retryAfterSeconds");
      const message = rateLimitedMessage(retryAfterSeconds);
      return retryAfterSeconds === undefined
        ? plainError(appError("RATE_LIMITED", message), values)
        : plainError(appError("RATE_LIMITED", message, { retryAfterSeconds }), values, retryAfterSeconds);
    }
    case "DUPLICATE":
      return plainError(appError("DUPLICATE", CONTACT_MESSAGES.duplicate), values);
    default:
      return unexpectedErrorState(values);
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export function createContactActions(deps: ContactActionDeps): ContactActions {
  const { service, limiter, getOrCreateSessionId, revalidatePath, now } = deps;
  const logger = deps.logger ?? console;

  const sendContactMessage: ContactActionFn = async (_prevState, formData) => {
    let values: ContactEchoValues = {};
    try {
      const parsed = parseContactForm(formData);

      // Honeypot (D14): a bot filled the hidden `website` input. Look exactly
      // like a success (well-formed fake reference) but store nothing, set no
      // cookie, spend no rate-limit token and revalidate nothing.
      if (parsed.honeypot) {
        const reference = generateReference();
        return { ok: true, reference, message: successMessage(reference) };
      }

      values = echoValues(parsed);
      const local = precheckContact(parsed);
      if (Object.keys(local).length > 0) return fieldErrorState(local, values);

      const sessionId = await getOrCreateSessionId();
      const limited = limitAction(limiter, "contact.submit", sessionId);
      if (!limited.ok) return toErrorState(limited.error, values);

      const result = service.submit(
        sessionId,
        {
          name: parsed.name,
          email: parsed.email,
          topic: parsed.topic,
          message: parsed.message,
          orderId: parsed.orderId,
          productSlug: parsed.productSlug,
        },
        now?.(),
      );
      if (!result.ok) return toErrorState(result.error, values);

      revalidatePath(ACCOUNT_MESSAGES_PATH);
      return { ok: true, reference: result.value.reference, message: successMessage(result.value.reference) };
    } catch {
      // Error code only: the exception may carry ids or submitted text.
      logger.error(`[contact] ${CONTACT_ACTION_FAILED}`);
      return unexpectedErrorState(values);
    }
  };

  return { sendContactMessage };
}
