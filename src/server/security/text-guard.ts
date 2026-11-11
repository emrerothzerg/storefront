import { fail, ok, type AppError, type Result } from "@/lib/result";

/**
 * Text guard for user-supplied free text (reviews, Q&A, contact messages,
 * list names, notes, search queries).
 *
 * Every function here runs in linear time with a single pass over the input
 * and no backtracking regular expressions, and rejects oversized input from
 * its `length` alone before looking at any character. It never parses or
 * encodes HTML: the UI renders user text as React text children (SR3), so
 * `<script>` is stored as typed and escaped on output.
 */

export interface CleanTextOptions {
  /** Maximum cleaned length in UTF-16 code units (matches the HTML `maxLength` attribute). */
  readonly max: number;
  /** Minimum cleaned length; 0 (the default) allows the empty string. */
  readonly min?: number;
  /** Keep line breaks (normalised to `\n`, at most one blank line in a row). */
  readonly multiline?: boolean;
}

/** Raw input longer than `max * RAW_LENGTH_FACTOR` is rejected before it is scanned. */
export const RAW_LENGTH_FACTOR = 4;

/** Character classes for the single cleaning pass (plain constants; the repo uses no enums). */
const Kind = { Keep: 0, Drop: 1, Space: 2, Newline: 3 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

/**
 * Unicode White_Space code points other than line breaks. U+0085 (NEL) is
 * White_Space too, but it is a C1 control and the contract strips all of
 * U+007F-U+009F, so it is dropped rather than turned into a space.
 */
function isInlineWhitespace(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Invisible characters that are dropped outright (zero-width, bidi controls, fillers). */
function isInvisible(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) || // ZWSP, ZWNJ, ZWJ, LRM, RLM
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings / overrides
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates
    code === 0x2060 || // word joiner
    code === 0xfeff || // BOM / ZWNBSP
    code === 0x3164 || // Hangul filler
    code === 0xffa0 // halfwidth Hangul filler
  );
}

function classify(code: number): Kind {
  if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return Kind.Newline;
  // Whitespace becomes a space (instead of being deleted) so "a\tb" does not merge into "ab".
  if (isInlineWhitespace(code)) return Kind.Space;
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return Kind.Drop; // C0 / DEL / C1 controls
  if (isInvisible(code)) return Kind.Drop;
  return Kind.Keep;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Cleans one free-text field.
 *
 * - `INVALID_INPUT` when `raw` is not a string.
 * - `TOO_LONG` when `raw.length > max * 4` (checked before any scanning) or
 *   when the cleaned text is longer than `max`.
 * - `VALIDATION_FAILED` when the cleaned text is shorter than `min` (default 0).
 *
 * Cleaning: strips C0/C1 control characters (U+0000-U+001F, U+007F-U+009F),
 * zero-width characters (U+200B-U+200F, U+2060, U+FEFF), bidi controls
 * (U+202A-U+202E, U+2066-U+2069) and Hangul fillers (U+3164, U+FFA0);
 * collapses runs of Unicode White_Space (tab, space, NBSP, U+1680,
 * U+2000-U+200A, U+202F, U+205F, U+3000) to one ASCII space; trims. With `multiline`, `\r\n`, lone `\r`, U+2028 and U+2029
 * become `\n`, spaces around line breaks are dropped and 3+ line breaks
 * collapse to 2. Without `multiline`, line breaks count as spaces.
 */
export function cleanText(raw: unknown, options: CleanTextOptions): Result<string, AppError> {
  const { max, multiline = false } = options;
  const min = options.min ?? 0;
  if (!isPositiveInteger(max) || !Number.isSafeInteger(min) || min < 0 || min > max) {
    throw new RangeError("cleanText: max must be a positive integer and 0 <= min <= max");
  }
  if (typeof raw !== "string") return fail("INVALID_INPUT", "Text is required.");
  if (raw.length > max * RAW_LENGTH_FACTOR) {
    return fail("TOO_LONG", `Text must be at most ${max} characters.`, { max });
  }

  const out: string[] = [];
  let outLength = 0;
  let pendingSpace = false;
  let pendingNewlines = 0;

  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const kind = classify(code);
    if (kind === Kind.Drop) continue;
    if (kind === Kind.Space || (kind === Kind.Newline && !multiline)) {
      if (code === 0x0d && raw.charCodeAt(i + 1) === 0x0a) i++; // \r\n is one break
      pendingSpace = true;
      continue;
    }
    if (kind === Kind.Newline) {
      if (code === 0x0d && raw.charCodeAt(i + 1) === 0x0a) i++;
      pendingNewlines++;
      continue;
    }
    // Leading whitespace is never flushed (out is empty) and trailing
    // whitespace is never followed by a kept character: that is the trim.
    if (outLength > 0) {
      if (pendingNewlines > 0) {
        const breaks = pendingNewlines >= 2 ? "\n\n" : "\n";
        out.push(breaks);
        outLength += breaks.length;
      } else if (pendingSpace) {
        out.push(" ");
        outLength += 1;
      }
    }
    pendingSpace = false;
    pendingNewlines = 0;
    out.push(raw[i] as string);
    outLength += 1;
    if (outLength > max) {
      return fail("TOO_LONG", `Text must be at most ${max} characters.`, { max });
    }
  }

  if (outLength < min) {
    return fail("VALIDATION_FAILED", `Text must be at least ${min} characters.`, { min });
  }
  return ok(out.join(""));
}

const LOWER_H = 0x68;
const LOWER_W = 0x77;

function isAsciiAlnum(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * Counts URL-like tokens: every occurrence of `http://` or `https://`
 * (case-insensitive, anywhere, so `visithttp://x` counts), and every `www.`
 * at a word boundary (start of text or after a non-letter/digit, so `awww.`
 * does not count). A `www.` directly after a scheme is part of that URL:
 * `https://www.example.com` counts once. URLs separated only by punctuation
 * (`http://a,http://b`) each count. Linear time: one forward pass.
 */
export function countUrls(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  let i = 0;
  while (i < lower.length) {
    const code = lower.charCodeAt(i);
    if (code === LOWER_H) {
      const matched = lower.startsWith("http://", i) ? 7 : lower.startsWith("https://", i) ? 8 : 0;
      if (matched > 0) {
        count++;
        i += matched;
        if (lower.startsWith("www.", i)) i += 4;
        continue;
      }
    } else if (code === LOWER_W && lower.startsWith("www.", i) && (i === 0 || !isAsciiAlnum(lower.charCodeAt(i - 1)))) {
      count++;
      i += 4;
      continue;
    }
    i++;
  }
  return count;
}

/** Longest coupon code, from the Input limits table. */
export const COUPON_CODE_MAX_LENGTH = 32;
const COUPON_RAW_MAX_LENGTH = COUPON_CODE_MAX_LENGTH * RAW_LENGTH_FACTOR;
const COUPON_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Normalises a coupon code: trims, checks `[A-Za-z0-9_-]{1,32}`, upper-cases.
 * The character check runs BEFORE upper-casing, because `toUpperCase` maps
 * look-alikes into ASCII (`ı` -> `I`, `ſ` -> `S`, `ß` -> `SS`). Input
 * containing an invisible character (zero-width, BOM, bidi control, filler)
 * is rejected before trimming, because `trim()` would silently drop a BOM.
 * Returns
 * `COUPON_INVALID` for anything else; no DB lookup.
 */
export function normalizeCouponCode(raw: unknown): Result<string, AppError> {
  if (typeof raw !== "string" || raw.length > COUPON_RAW_MAX_LENGTH) {
    return fail("COUPON_INVALID", "That promo code is not valid.");
  }
  for (let i = 0; i < raw.length; i++) {
    if (isInvisible(raw.charCodeAt(i))) return fail("COUPON_INVALID", "That promo code is not valid.");
  }
  const trimmed = raw.trim();
  if (!COUPON_RE.test(trimmed)) return fail("COUPON_INVALID", "That promo code is not valid.");
  return ok(trimmed.toUpperCase());
}
