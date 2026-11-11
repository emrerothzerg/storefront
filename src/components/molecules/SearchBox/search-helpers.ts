/**
 * Pure helpers for SearchBox (T64). No React, no DOM globals at import time,
 * so they are testable with plain stubs. Every storage access is wrapped in
 * try/catch: a disabled, full or sandboxed `localStorage` (getter throws
 * SecurityError, setItem throws QuotaExceededError) never breaks the box (D7).
 */

/** localStorage key for recent searches (D7: recents live in the browser only). */
export const RECENT_SEARCHES_KEY = "sf_recent_searches";
/** Recent searches kept (criterion 4). */
export const MAX_RECENT_SEARCHES = 5;
/** Search query cap (Standing rules "Input limits"; criterion 6). */
export const MAX_QUERY_LENGTH = 100;
/** Suggestions shown from the suggest route (route caps at 8 too). */
export const MAX_REMOTE_SUGGESTIONS = 8;
/** Debounce before calling the suggest route. */
export const SUGGEST_DEBOUNCE_MS = 250;
/** Minimum query length (code points, trimmed) before calling the suggest route. */
export const MIN_SUGGEST_LENGTH = 2;

/** The subset of `Storage` the helpers use; `null`/`undefined` means "no storage". */
export type RecentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function codePoints(value: string): string[] {
  return Array.from(value);
}

/** Trims and cuts a query to {@link MAX_QUERY_LENGTH} code points. */
export function normalizeQuery(value: string): string {
  const trimmed = value.trim();
  const points = codePoints(trimmed);
  return points.length > MAX_QUERY_LENGTH ? points.slice(0, MAX_QUERY_LENGTH).join("").trim() : trimmed;
}

/** Trimmed, de-duplicated (case-insensitive, first wins), capped list of non-empty strings. */
function cleanList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= MAX_RECENT_SEARCHES) break;
    if (typeof value !== "string") continue;
    const q = normalizeQuery(value);
    if (q === "" || CONTROL_RE.test(q)) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** Parses a raw stored value. Anything malformed yields `[]`. */
export function parseRecentSearches(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? cleanList(parsed as readonly unknown[]) : [];
  } catch {
    return [];
  }
}

/** Reads recent searches; a missing or throwing storage yields `[]`. Never throws. */
export function readRecentSearches(storage: RecentStorage | null | undefined): string[] {
  if (!storage) return [];
  try {
    return parseRecentSearches(storage.getItem(RECENT_SEARCHES_KEY));
  } catch {
    return [];
  }
}

/**
 * Puts `q` (trimmed, cut to 100 chars) first, drops case-insensitive
 * duplicates, keeps 5, and writes the list. Returns the resulting list (also
 * when the write fails). An empty query changes nothing. Never throws.
 */
export function pushRecentSearch(storage: RecentStorage | null | undefined, q: string): string[] {
  const current = readRecentSearches(storage);
  const query = typeof q === "string" ? normalizeQuery(q) : "";
  if (query === "" || CONTROL_RE.test(query)) return current;
  const next = cleanList([query, ...current]);
  if (storage) {
    try {
      storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
    } catch {
      // Quota exceeded, storage disabled, SecurityError: recents are optional.
    }
  }
  return next;
}

/** Removes all recent searches. Never throws. */
export function clearRecentSearches(storage: RecentStorage | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(RECENT_SEARCHES_KEY);
  } catch {
    // Ignore: see pushRecentSearch.
  }
}

/**
 * `window.localStorage`, or `null` when there is no window or when reading
 * the property itself throws (sandboxed iframe, blocked cookies).
 */
export function getBrowserStorage(): RecentStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Suggestion hrefs must be internal paths: a string that starts with exactly
 * one `/` (not `//`), with no backslash (browsers treat `/\host` like `//host`)
 * and no control characters. Rejects `javascript:`, `https:`, `//evil`, `foo`.
 */
export function isSafeSuggestionHref(href: unknown): href is string {
  return (
    typeof href === "string" &&
    href.length > 0 &&
    href.length <= 2048 &&
    href.startsWith("/") &&
    !href.startsWith("//") &&
    !href.includes("\\") &&
    !CONTROL_RE.test(href)
  );
}

export type SuggestionKind = "product" | "category" | "brand" | "recent" | "popular";

/** One entry handed to SearchField, plus the query to record when it is chosen. */
export interface SearchBoxSuggestion {
  readonly id: string;
  /** Plain text label (rendered as a React text child by SearchField). */
  readonly label: string;
  readonly href: string;
  readonly kind: SuggestionKind;
  /** Query recorded in recent searches when chosen; `null` = record the typed query. */
  readonly query: string | null;
}

const REMOTE_KINDS: ReadonlySet<string> = new Set(["product", "category", "brand"]);

/**
 * Validates a suggest-route JSON body (`{ suggestions: [{ type, label, href }] }`).
 * Unknown shapes yield `[]`; items with unsafe hrefs or empty labels are
 * dropped; at most {@link MAX_REMOTE_SUGGESTIONS} are kept.
 */
export function parseSuggestBody(body: unknown): SearchBoxSuggestion[] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(list)) return [];
  const out: SearchBoxSuggestion[] = [];
  for (const item of list as readonly unknown[]) {
    if (out.length >= MAX_REMOTE_SUGGESTIONS) break;
    if (typeof item !== "object" || item === null) continue;
    const { type, label, href } = item as { type?: unknown; label?: unknown; href?: unknown };
    if (typeof label !== "string" || label.trim() === "") continue;
    if (!isSafeSuggestionHref(href)) continue;
    const kind: SuggestionKind = typeof type === "string" && REMOTE_KINDS.has(type) ? (type as SuggestionKind) : "product";
    out.push({ id: `suggest-${out.length}`, label: label.trim(), href, kind, query: null });
  }
  return out;
}

/** `/search?q=<encoded>` for a recent or popular query. */
export function searchHref(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}

/**
 * Suggestions for an empty, focused input: recents first (label prefixed
 * "Recent: "), then popular searches not already in the recents.
 */
export function buildEmptyStateSuggestions(
  recents: readonly string[],
  popular: readonly string[] = [],
): SearchBoxSuggestion[] {
  const out: SearchBoxSuggestion[] = recents.map((q, i) => ({
    id: `recent-${i}`,
    label: `Recent: ${q}`,
    href: searchHref(q),
    kind: "recent" as const,
    query: q,
  }));
  const seen = new Set(recents.map((q) => q.toLowerCase()));
  let index = 0;
  for (const raw of popular) {
    if (typeof raw !== "string") continue;
    const q = normalizeQuery(raw);
    if (q === "" || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push({ id: `popular-${index}`, label: q, href: searchHref(q), kind: "popular", query: q });
    index += 1;
  }
  return out;
}

/** Any Unicode control character (same class as the server text guard, `/\p{Cc}/u`). */
const SUGGEST_CONTROL_RE = /\p{Cc}/u;

/**
 * True when the (trimmed) query is long enough to ask the suggest route, within
 * the cap, and free of control characters (the route rejects those anyway, so
 * sending them would only spend a rate-limited request).
 */
export function shouldFetchSuggestions(query: string): boolean {
  if (SUGGEST_CONTROL_RE.test(query)) return false;
  const length = codePoints(query.trim()).length;
  return length >= MIN_SUGGEST_LENGTH && length <= MAX_QUERY_LENGTH;
}
