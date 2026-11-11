import type { AppError } from "@/lib/result";

/**
 * Contract between the contact UI (ContactForm T66, contact page T101) and the
 * contact server action (T51, `src/app/actions/contact.ts`).
 *
 * `sendContactMessage` (implements `ContactActionFn`):
 * - Reads ONLY the `CONTACT_FIELD` names below; every other field
 *   (`sessionId`, `reference`, `status`, `$ACTION_*`, ...) is ignored.
 *   Non-string entries (a `File`) count as missing.
 * - Takes the owner key from the server-side cookie, never from the form. The
 *   session cookie is created lazily, only after the input passes the
 *   DB-free checks (required fields, lengths, email format, topic, link
 *   count). Those failures are all reported in one response and spend no
 *   rate-limit token; order-id and duplicate errors come after the limiter.
 * - Honeypot: `website` is a hidden input that people never fill. ANY
 *   non-empty value returns a success-looking state with a fake but
 *   well-formed reference (`C-XXXXXXXX`). Nothing is stored, no cookie is set,
 *   the rate limiter is not touched and nothing is revalidated. Render the
 *   input visually hidden, `tabIndex={-1}`, `autoComplete="off"`, with a label
 *   such as "Leave this field empty".
 * - Rate limited (3/hour and 10/day per session, 200/hour global) before the
 *   message is stored: `RATE_LIMITED` with `retryAfterSeconds`.
 * - Never redirects and never puts submitted values in a URL. On success it
 *   revalidates `/account/messages`.
 * - Always settles with a plain, JSON-serializable state; `message` and the
 *   `fieldErrors` strings are user-safe and may be shown verbatim.
 *
 * Error codes a form should expect (`error.code`):
 * - VALIDATION_FAILED / TOO_LONG: see `fieldErrors` (one message per field;
 *   `TOO_LONG` when every failing field is too long). `error.details.fields`
 *   holds the per-field codes (REQUIRED, TOO_SHORT, TOO_LONG, INVALID_EMAIL,
 *   INVALID_TOPIC, TOO_MANY_URLS, INVALID_ORDER).
 * - DUPLICATE: the same message was sent from this session in the last 10 minutes.
 * - RATE_LIMITED: `retryAfterSeconds` is set.
 * - INVALID_INPUT with `details.reason === "unavailable"`: the message could
 *   not be stored (server fault); `values` are echoed so the user can retry.
 */

/** Form field names posted by the contact form. */
export const CONTACT_FIELD = {
  name: "name",
  email: "email",
  topic: "topic",
  message: "message",
  orderId: "orderId",
  productSlug: "productSlug",
  /** Honeypot: hidden, must stay empty. */
  website: "website",
} as const;

export type ContactFieldName = (typeof CONTACT_FIELD)[keyof typeof CONTACT_FIELD];

/**
 * Values echoed back on failure so the form can re-fill itself without
 * JavaScript. Truncated to the input caps (name 80, email 254, message 2000;
 * topic/orderId only when at most 64 chars). Never contains the honeypot.
 */
export interface ContactEchoValues {
  readonly name?: string;
  readonly email?: string;
  readonly topic?: string;
  readonly message?: string;
  readonly orderId?: string;
}

/** `null` = not yet submitted. */
export type ContactActionState =
  | null
  | { readonly ok: true; readonly reference: string; readonly message: string }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      readonly fieldErrors: Readonly<Partial<Record<keyof ContactEchoValues, string>>>;
      readonly values: ContactEchoValues;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>`. */
export type ContactActionFn = (prevState: ContactActionState, formData: FormData) => Promise<ContactActionState>;

export const initialContactActionState: ContactActionState = null;
