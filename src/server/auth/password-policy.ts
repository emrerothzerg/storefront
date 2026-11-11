import { createHash } from "node:crypto";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import { RAW_LENGTH_FACTOR, cleanText } from "@/server/security/text-guard";
import { WEAK_PASSWORDS } from "./weak-passwords";

/**
 * Account input policy (T116, AR3 as amended by rulings K-10 and R-11):
 * password rules + hasher, email and display-name normalisation, and the
 * opaque per-email limiter key. Server-only, pure (no DB), never logs.
 *
 * Every failure is `VALIDATION_FAILED` with
 * `details.fields[<field>] = { code, message }`, the shape forms render
 * next to the matching input. Messages never echo the input.
 */

/** Password length bounds in UTF-16 code units (ruling K-10, matches `maxLength`). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
/** Longest accepted email after normalisation. */
export const EMAIL_MAX = 254;
/** Display name bounds after `cleanText`. */
export const DISPLAY_NAME_MAX = 50;

export type AuthField = "email" | "password" | "displayName";
export type AuthFieldErrorCode = "REQUIRED" | "TOO_SHORT" | "TOO_LONG" | "WEAK" | "INVALID";

export interface AuthFieldError {
  readonly code: AuthFieldErrorCode;
  readonly message: string;
}

export type AuthFieldErrors = Readonly<Partial<Record<AuthField, AuthFieldError>>>;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/** Production hasher: Bun's built-in argon2id with its default cost (no dependency). */
export const argon2idHasher: PasswordHasher = Object.freeze({
  hash: (password: string) => Bun.password.hash(password, { algorithm: "argon2id" }),
  verify: (password: string, hash: string) => Bun.password.verify(password, hash),
});

/** Top-level message of every policy `VALIDATION_FAILED`. */
export const VALIDATION_MESSAGE = "Some fields are invalid.";

/** `VALIDATION_FAILED` carrying the given per-field errors. */
export function fieldErrors(fields: AuthFieldErrors): Result<never, AppError> {
  return fail("VALIDATION_FAILED", VALIDATION_MESSAGE, { fields });
}

function fieldError(field: AuthField, code: AuthFieldErrorCode, message: string): Result<never, AppError> {
  return fieldErrors({ [field]: { code, message } });
}

/**
 * Checks a new password (sign-up, password change). The returned value is
 * `raw` exactly: never trimmed, normalised or altered.
 * WEAK: case-insensitively in WEAK_PASSWORDS, or equal to the email or its
 * local part (`context.email`, compared after trim + lower-case).
 */
export function validatePassword(raw: unknown, context: { email?: string }): Result<string, AppError> {
  if (typeof raw !== "string" || raw === "") return fieldError("password", "REQUIRED", "Enter a password.");
  if (raw.length < PASSWORD_MIN) {
    return fieldError("password", "TOO_SHORT", `Password must be at least ${PASSWORD_MIN} characters.`);
  }
  if (raw.length > PASSWORD_MAX) {
    return fieldError("password", "TOO_LONG", `Password must be at most ${PASSWORD_MAX} characters.`);
  }
  const lower = raw.toLowerCase();
  let weak = WEAK_PASSWORDS.has(lower);
  if (!weak && typeof context.email === "string") {
    const email = context.email.trim().toLowerCase();
    const at = email.indexOf("@");
    const local = at === -1 ? email : email.slice(0, at);
    weak = (email !== "" && lower === email) || (local !== "" && lower === local);
  }
  if (weak) {
    return fieldError("password", "WEAK", "This password is too easy to guess. Choose a less common one.");
  }
  return ok(raw);
}

/** Raw input longer than this is rejected before NFC normalisation runs. */
const EMAIL_RAW_MAX = EMAIL_MAX * 4;
/** Control, format (zero-width, bidi, BOM) and separator (any space, line/paragraph separators). */
const FORBIDDEN_EMAIL_CHAR = /[\p{Cc}\p{Cf}\p{Z}]/u;

/** Strips leading/trailing U+0020 only; every other space or control is rejected, not trimmed. */
function trimAsciiSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) === 0x20) end--;
  return value.slice(start, end);
}

/**
 * Ruling R-11: string -> NFC -> trim -> lower-case. Rejects: non-string or
 * empty (REQUIRED), longer than 254 (TOO_LONG), not exactly one "@", empty
 * local part or domain, or any \p{Cc} \p{Cf} \p{Z} character left after
 * trimming (INVALID). Trimming removes U+0020 only, so a trailing "\n",
 * tab, NBSP or BOM is rejected rather than silently dropped (PLAN A-102).
 * `toLowerCase` is locale independent.
 */
export function normalizeEmail(raw: unknown): Result<string, AppError> {
  if (typeof raw !== "string") return fieldError("email", "REQUIRED", "Enter your email address.");
  if (raw.length > EMAIL_RAW_MAX) {
    return fieldError("email", "TOO_LONG", `Email must be at most ${EMAIL_MAX} characters.`);
  }
  const email = trimAsciiSpaces(raw.normalize("NFC")).toLowerCase();
  if (email === "") return fieldError("email", "REQUIRED", "Enter your email address.");
  if (email.length > EMAIL_MAX) {
    return fieldError("email", "TOO_LONG", `Email must be at most ${EMAIL_MAX} characters.`);
  }
  const at = email.indexOf("@");
  const valid =
    at > 0 && at < email.length - 1 && email.indexOf("@", at + 1) === -1 && !FORBIDDEN_EMAIL_CHAR.test(email);
  if (!valid) return fieldError("email", "INVALID", "Enter a valid email address.");
  return ok(email);
}

/** Every format character (`\p{Cf}`) except ZWNJ U+200C / ZWJ U+200D; removed before `cleanText`. */
const DISPLAY_NAME_FORMAT_CHAR = /(?![\u200C\u200D])\p{Cf}/gu;
/** Characters that do not count as a visible neighbour of a joiner (what `cleanText` turns into space or drops). */
const NOT_A_JOIN_NEIGHBOUR = /[\s\p{Cc}\u3164\uFFA0]/u;

function isJoiner(ch: string | undefined): boolean {
  return ch === "\u200C" || ch === "\u200D";
}

/**
 * Splits `text` at every joiner run that sits between two visible
 * characters (kept, returned in `joiners`); other joiner runs are deleted.
 * `segments.length === joiners.length + 1`. Linear, no regex backtracking.
 */
function splitAtKeptJoiners(text: string): { readonly segments: readonly string[]; readonly joiners: readonly string[] } {
  const segments: string[] = [];
  const joiners: string[] = [];
  let current = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (!isJoiner(ch)) {
      current += ch;
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && isJoiner(text[j])) j++;
    const before = text[i - 1];
    const after = text[j];
    if (before !== undefined && after !== undefined && !NOT_A_JOIN_NEIGHBOUR.test(before) && !NOT_A_JOIN_NEIGHBOUR.test(after)) {
      segments.push(current);
      joiners.push(text.slice(i, j));
      current = "";
    }
    i = j;
  }
  segments.push(current);
  return { segments, joiners };
}

/**
 * `cleanText` with 1..50: control/invisible characters stripped, whitespace
 * collapsed, trimmed. CONS-B4 (bi), additive: every other `\p{Cf}` format
 * character (e.g. U+061C, U+00AD, U+180E, U+206A–U+206F, tag characters) is
 * removed too, and ZWNJ U+200C / ZWJ U+200D are KEPT when they join two
 * visible characters (Persian names, combined emoji such as a family), which
 * `cleanText` alone would delete. Names without format characters clean
 * exactly as before. Parity with the display cleaner (`cleanDisplayName` in
 * src/lib/display-name.ts) is pinned by password-policy.test.ts.
 */
export function normalizeDisplayName(raw: unknown): Result<string, AppError> {
  if (typeof raw !== "string") return fieldError("displayName", "REQUIRED", "Enter a display name.");
  if (raw.length > DISPLAY_NAME_MAX * RAW_LENGTH_FACTOR) {
    return fieldError("displayName", "TOO_LONG", `Display name must be at most ${DISPLAY_NAME_MAX} characters.`);
  }
  const { segments, joiners } = splitAtKeptJoiners(raw.replace(DISPLAY_NAME_FORMAT_CHAR, ""));
  let value = "";
  for (let k = 0; k < segments.length; k++) {
    // Segment lengths never exceed raw.length, so this max cannot be hit; the real bound is checked below.
    const cleaned = cleanText(segments[k] ?? "", { max: DISPLAY_NAME_MAX * RAW_LENGTH_FACTOR });
    if (!cleaned.ok) return fieldError("displayName", "REQUIRED", "Enter a display name.");
    value += cleaned.value + (joiners[k] ?? "");
  }
  if (value.length > DISPLAY_NAME_MAX) {
    return fieldError("displayName", "TOO_LONG", `Display name must be at most ${DISPLAY_NAME_MAX} characters.`);
  }
  if (value === "") return fieldError("displayName", "REQUIRED", "Enter a display name.");
  return ok(value);
}

/**
 * Opaque key for the `auth.signin.email` limiter: SHA-256 hex (lower case)
 * of the normalised email, so `rate_limits` never stores a plaintext email
 * (ruling K-9: unsalted is accepted).
 */
export function emailLimiterKey(normalizedEmail: string): string {
  return createHash("sha256").update(normalizedEmail, "utf8").digest("hex");
}
