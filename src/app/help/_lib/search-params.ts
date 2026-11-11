/**
 * Query-string parsing shared by the help centre, FAQ and contact pages
 * (T101). Every value from the URL is untrusted: these helpers never throw,
 * never build a RegExp from input, and bound the work done on huge values
 * before any per-character processing (Page-parser rule, STATE.md).
 */

/** Raw `searchParams` value as the App Router passes it. */
export type RawSearchParam = string | readonly string[] | undefined;

/** Resolved `searchParams` object (the page awaits the promise first). */
export type RawSearchParams = Readonly<Record<string, RawSearchParam>>;

/** Hard cap applied before any regex work, so an over-long value costs O(cap). */
export const RAW_PARAM_SCAN_LIMIT = 1024;

/**
 * The first string for a param (`?a=1&a=2` -> "1"), or null when absent or
 * not a string (defensive: the runtime type is not guaranteed in tests).
 */
export function firstParam(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === "string" ? first : null;
  }
  return null;
}

/** True when the param key is present at all (even as `?q=`). */
export function hasParam(params: RawSearchParams | undefined, key: string): boolean {
  if (params === undefined || params === null || typeof params !== "object") return false;
  return Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined;
}

// Control (Cc), format (Cf: zero-width space/joiners, BOM, bidi controls) and
// lone surrogates (Cs). Static pattern; input never becomes part of a RegExp.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const LINE_SEPARATORS = /[\p{Zl}\p{Zp}]/gu;
const WHITESPACE_RUN = /\s+/g;

/**
 * Plain-text cleanup for a free-text param: cut to `RAW_PARAM_SCAN_LIMIT`
 * code units, drop control/zero-width/format characters, collapse whitespace,
 * trim, then cap at `max` code points (never splits a surrogate pair).
 * Returns null when nothing usable is left.
 */
export function cleanTextParam(value: unknown, max: number): string | null {
  const raw = firstParam(value);
  if (raw === null) return null;
  const cleaned = raw
    .slice(0, RAW_PARAM_SCAN_LIMIT)
    .replace(INVISIBLE, "")
    .replace(LINE_SEPARATORS, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim();
  const capped = Array.from(cleaned).slice(0, Math.max(0, max)).join("").trim();
  return capped === "" ? null : capped;
}

/** Longest token-like param (slug, topic) worth looking at. */
export const MAX_TOKEN_PARAM_LENGTH = 128;

/**
 * A short token param (slug, topic, id) exactly as given, or null when
 * absent, empty or longer than `MAX_TOKEN_PARAM_LENGTH`. Callers then check
 * it against an allowlist or a strict shape.
 */
export function tokenParam(value: unknown): string | null {
  const raw = firstParam(value);
  if (raw === null || raw.length === 0 || raw.length > MAX_TOKEN_PARAM_LENGTH) return null;
  return raw;
}

/**
 * The `?open=<slug>` value when it names one of `slugs` (else undefined), so
 * FaqList only ever receives a slug it renders.
 */
export function parseOpenSlug(value: unknown, slugs: readonly string[]): string | undefined {
  const raw = tokenParam(value);
  if (raw === null) return undefined;
  return slugs.includes(raw) ? raw : undefined;
}
