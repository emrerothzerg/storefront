import { COMPARE_MAX, COMPARE_PARAM } from "@/components/molecules/CompareToggle/compare-path";
import { COMPARE_DIFF_PARAM } from "@/components/organisms/CompareTable/compare-table-helpers";

/** Next's `searchParams` shape; values are treated as untrusted (`unknown`) when parsed. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** A product slug as it may appear in `?p=`: lower-case ASCII letters, digits and hyphens, 1–64 chars. */
export const COMPARE_SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

/** Longest accepted slug; checked before the regex so huge values cost nothing. */
const MAX_SLUG_LENGTH = 64;

/**
 * Upper bound on distinct slug-shaped candidates looked up in the catalog.
 * Unknown/unpublished slugs are dropped before the cap of 4, so a few spares
 * are allowed; a URL with hundreds of slug-shaped values never turns into
 * hundreds of queries.
 */
export const MAX_COMPARE_CANDIDATES = COMPARE_MAX * 4;

/**
 * Upper bound on raw `p` pieces inspected across all values (comma lists are
 * split first), so a request with thousands of `p=` or commas stays cheap.
 */
export const MAX_RAW_VALUES = 500;

/** Separator for the compact form `?p=a,b` (also accepted: repeated `?p=a&p=b`). */
const LIST_SEPARATOR = ",";

export interface CompareParams {
  /** Distinct slug-shaped candidates in URL order (first occurrence wins), at most `MAX_COMPARE_CANDIDATES`. */
  readonly candidates: readonly string[];
  /** `diff=1` (exactly "1"; for repeated params the first value counts). */
  readonly differencesOnly: boolean;
  /** At least one non-empty `p` value was malformed (wrong type, not slug-shaped) and dropped. */
  readonly rejected: boolean;
  /** More distinct candidates were present than `MAX_COMPARE_CANDIDATES` (or than `MAX_RAW_VALUES` pieces). */
  readonly overflow: boolean;
}

/** True for a string that looks like a product slug. Never throws. */
export function isCompareSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && COMPARE_SLUG_PATTERN.test(value);
}

function readParam(params: unknown, name: string): unknown {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(params, name)) return undefined;
  return (params as Record<string, unknown>)[name];
}

interface RawPieces {
  readonly pieces: readonly unknown[];
  readonly overflow: boolean;
}

/**
 * `p` as a flat list of at most `MAX_RAW_VALUES` pieces: a single value
 * becomes a one-item list, arrays are read in order, and string values are
 * split on commas (`split` with a limit stops early, so a huge value costs at
 * most one bounded scan). Non-string entries are kept as-is so the caller can
 * reject them.
 */
function rawPieces(value: unknown): RawPieces {
  if (value === undefined) return { pieces: [], overflow: false };
  const values: readonly unknown[] = Array.isArray(value) ? value : [value];
  const pieces: unknown[] = [];
  for (const entry of values) {
    const room = MAX_RAW_VALUES - pieces.length;
    if (room <= 0) return { pieces, overflow: true };
    if (typeof entry !== "string") {
      pieces.push(entry);
      continue;
    }
    const parts = entry.split(LIST_SEPARATOR, room + 1);
    if (parts.length > room) return { pieces: [...pieces, ...parts.slice(0, room)], overflow: true };
    pieces.push(...parts);
  }
  return { pieces, overflow: false };
}

/**
 * Validates the compare query (page-parser rule): accepts `?p=a&p=b` and
 * `?p=a,b`, keeps slug-shaped values in order, dedupes (first wins), and reads `diff`. Malformed values
 * (wrong type, nested arrays, path tricks, over-long strings) are dropped.
 * Never throws.
 */
export function parseCompareParams(params: unknown): CompareParams {
  const raw = rawPieces(readParam(params, COMPARE_PARAM));
  const candidates: string[] = [];
  let rejected = false;
  let overflow = raw.overflow;
  for (const value of raw.pieces) {
    if (value === "") continue; // `?p=` or a trailing comma: nothing was asked for
    if (!isCompareSlug(value)) {
      rejected = true;
      continue;
    }
    if (candidates.includes(value)) continue;
    if (candidates.length >= MAX_COMPARE_CANDIDATES) {
      overflow = true;
      break;
    }
    candidates.push(value);
  }
  const diff = readParam(params, COMPARE_DIFF_PARAM);
  const firstDiff: unknown = Array.isArray(diff) ? diff[0] : diff;
  return { candidates, differencesOnly: firstDiff === "1", rejected, overflow };
}
