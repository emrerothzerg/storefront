/**
 * Display-name helpers shared by the header (SiteHeader / AccountMenu), the
 * DepartmentMenu molecule and the server-side display-name normaliser
 * (`normalizeDisplayName` in src/server/auth/password-policy.ts). Pure: no
 * React, no server imports, safe in client and server bundles.
 */

/** Visible display-name cap in the account link (T80 criterion 7); the full name stays in the accessible name. */
export const MAX_VISIBLE_NAME_LENGTH = 20;

/**
 * Format characters a display name keeps: U+200C ZERO WIDTH NON-JOINER
 * (required by Persian and other scripts) and U+200D ZERO WIDTH JOINER
 * (combined emoji such as a family or a skin-tone profession). They are only
 * meaningful between two visible characters; a joiner next to a space or at
 * either end is dropped.
 */
export const KEPT_JOINERS = ["\u200C", "\u200D"] as const;

/** Every format character (`\p{Cf}`) except the two joiners; dropped outright. */
const FORMAT_CHAR = /(?![\u200C\u200D])\p{Cf}/gu;
/** Runs of control characters (`\p{Cc}`, C0 and C1) or whitespace; each run becomes one space. */
const CONTROL_OR_SPACE_RUN = /[\p{Cc}\s]+/gu;
/** A joiner run directly before a space or the end. */
const JOINERS_BEFORE_SPACE = /[\u200C\u200D]+(?= |$)/gu;
/** A joiner run directly after a space or the start. */
const JOINERS_AFTER_SPACE = /(^| )[\u200C\u200D]+/gu;
const SPACE_RUN = / {2,}/g;

/**
 * Normalises a display name for rendering (D-T80-1, CONS-B4 bi):
 *
 * - format characters (`\p{Cf}`: bidi embeddings and overrides
 *   U+202A–U+202E, isolates U+2066–U+2069, marks U+200E/U+200F and U+061C,
 *   zero-width space, word joiner, BOM, soft hyphen, …) are removed, except
 *   ZWNJ/ZWJ, which stay when they join two visible characters;
 * - every run of C0/C1 controls (`\p{Cc}`) and whitespace becomes one space;
 * - the result is trimmed. Non-strings become "".
 *
 * Parity with the server: `normalizeDisplayName` (sign-up / settings) removes
 * the same format characters and keeps the joiners under the same rule, so a
 * stored name passes through this function unchanged. The one intended
 * difference: the server's `cleanText` deletes control characters where this
 * function turns them into a space (only reachable for names that did not go
 * through the server, e.g. legacy rows or tests).
 *
 * Each pattern is one character class with one quantifier, so the scan is
 * linear in the input length.
 */
export function cleanDisplayName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name
    .replace(FORMAT_CHAR, "")
    .replace(CONTROL_OR_SPACE_RUN, " ")
    .replace(JOINERS_BEFORE_SPACE, "")
    .replace(JOINERS_AFTER_SPACE, "$1")
    .replace(SPACE_RUN, " ")
    .trim();
}

/**
 * Truncates to `max` code points (a surrogate pair is never split) and
 * appends an ellipsis when shortened. A joiner left dangling at the cut is
 * removed so the visible text never ends in an invisible character.
 */
export function truncateDisplayName(name: string, max: number = MAX_VISIBLE_NAME_LENGTH): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  return `${chars.slice(0, max).join("").replace(/[\u200C\u200D]+$/u, "").trimEnd()}…`;
}
