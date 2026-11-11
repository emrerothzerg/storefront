import type { Database } from "bun:sqlite";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import { getDatabase } from "@/server/db/client";
import { SqliteSearchRepository, type SearchRepository, type SearchTextRow } from "./search-repository";

/**
 * Product search (server-only, T32): FTS5 full-text search over published
 * products, typeahead suggestions and "did you mean" spelling hints.
 *
 * Safety model: user input is normalised into plain lower-case terms
 * (`normalizeSearchQuery`), every term is emitted as a double-quoted FTS5
 * string (`buildMatchExpression`), and the expression is bound as a SQL
 * parameter. A quoted string is always a valid FTS5 phrase, so FTS syntax
 * errors cannot be produced from user input.
 */

export interface SearchOptions {
  readonly inStockOnly?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
  readonly now?: number;
}

export interface SearchResult {
  /** Product ids in rank order (bm25, then product id). Browse-all is ordered by id. */
  readonly ids: readonly string[];
  readonly total: number;
  readonly normalizedQuery: string;
  readonly terms: readonly string[];
  readonly didYouMean: string | null;
  /** True when the query is empty after normalisation. */
  readonly browseAll: boolean;
}

export interface Suggestion {
  readonly type: "product" | "category" | "brand";
  readonly label: string;
  /** /products/<slug> | /category/<slug> | /brand/<slug> */
  readonly href: string;
}

export interface SearchService {
  /** `options` may be omitted or `null`; malformed fields fall back to defaults. */
  search(query: unknown, options?: SearchOptions | null): Result<SearchResult, AppError>;
  /** Never throws; `[]` for empty or 1-character prefixes. */
  suggest(prefix: unknown, limit?: number): readonly Suggestion[];
  didYouMean(query: string): string | null;
}

export const MAX_QUERY_LENGTH = 100;
export const MAX_QUERY_TERMS = 8;
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 48;
export const MAX_SUGGESTIONS = 8;
/** Raw input beyond this many code units is ignored before any regex runs. */
const RAW_INPUT_CAP = 1000;
const MAX_EDIT_DISTANCE = 2;
/** Category and brand suggestions get at most this many slots each; products fill the rest. */
const RESERVED_TAXONOMY_SLOTS = 2;

const FTS_OPERATOR_TOKENS: ReadonlySet<string> = new Set(["and", "or", "not", "near"]);
const CONTROL_CHARS = /\p{Cc}/gu;
const FORMAT_CHARS = /\p{Cf}/gu;
const OPERATOR_CHARS = /["*^:()]/g;
const WHITESPACE = /\s+/u;
const LEADING_HYPHENS = /^-+/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

// ---------------------------------------------------------------------------
// Normalisation and MATCH expression
// ---------------------------------------------------------------------------

/** Cuts `s` to at most `max` UTF-16 code units without splitting a surrogate pair. */
function cutCodeUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

function splitTerms(s: string): string[] {
  const terms: string[] = [];
  for (const piece of s.split(WHITESPACE)) {
    const term = piece.replace(LEADING_HYPHENS, "");
    if (term === "" || FTS_OPERATOR_TOKENS.has(term)) continue;
    terms.push(term);
  }
  return terms;
}

/**
 * Normalises raw user input into a display query and search terms.
 * Non-strings yield the empty query (browse all). Steps, in order: ignore input
 * past 1,000 code units, NFKC, control characters to spaces, zero-width/format
 * characters removed, FTS operator characters (`" * ^ : ( )`) to spaces,
 * lower-case, split on whitespace, leading `-` stripped per term, bare
 * AND/OR/NOT/NEAR dropped, first 8 terms kept, joined and capped at 100 chars
 * (a cut never splits a surrogate pair; the cut text is re-split).
 */
export function normalizeSearchQuery(raw: unknown): {
  readonly normalizedQuery: string;
  readonly terms: readonly string[];
} {
  if (typeof raw !== "string") return { normalizedQuery: "", terms: [] };
  const cleaned = cutCodeUnits(raw, RAW_INPUT_CAP)
    .normalize("NFKC")
    .replace(CONTROL_CHARS, " ")
    .replace(FORMAT_CHARS, "")
    .replace(OPERATOR_CHARS, " ")
    .toLowerCase();
  const limited = splitTerms(cleaned).slice(0, MAX_QUERY_TERMS).join(" ");
  const terms = splitTerms(cutCodeUnits(limited, MAX_QUERY_LENGTH));
  return { normalizedQuery: terms.join(" "), terms };
}

/**
 * Builds an FTS5 MATCH expression: each term double-quoted (inner quotes
 * doubled), the last one with a prefix `*`, joined by spaces (implicit AND).
 * Control characters become spaces; terms without any letter or digit are
 * skipped (the tokenizer would drop them anyway). Returns "" when nothing searchable remains.
 */
export function buildMatchExpression(terms: readonly string[]): string {
  // Control characters (NUL in particular ends the FTS5 parser's input, which
  // would leave an unterminated string) become spaces inside the phrase.
  const usable = terms.map((t) => t.replace(CONTROL_CHARS, " ")).filter((t) => HAS_WORD_CHAR.test(t));
  return usable
    .map((t, i) => `"${t.replaceAll('"', '""')}"${i === usable.length - 1 ? "*" : ""}`)
    .join(" ");
}

/** Exact-term expression (no prefix) used to check whether a single word matches. */
function exactTermExpression(term: string): string {
  const clean = term.replace(CONTROL_CHARS, " ");
  return HAS_WORD_CHAR.test(clean) ? `"${clean.replaceAll('"', '""')}"` : "";
}

// ---------------------------------------------------------------------------
// Edit distance
// ---------------------------------------------------------------------------

/**
 * Optimal-string-alignment Damerau–Levenshtein distance over code points,
 * bounded: returns `max + 1` as soon as the distance must exceed `max`.
 */
export function boundedDamerauLevenshtein(a: string, b: string, max: number): number {
  const s = Array.from(a);
  const t = Array.from(b);
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  const d = prev[t.length]!;
  return d > max ? max + 1 : d;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function nowIsoFrom(now: number | undefined): string {
  if (typeof now === "number" && Number.isFinite(now)) {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function clampPageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, value));
}

function normalizePage(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function clampSuggestionLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return MAX_SUGGESTIONS;
  return Math.min(MAX_SUGGESTIONS, Math.max(1, value));
}

function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(WORD_SPLIT).filter((w) => w !== "");
}

function bulletText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").join(" ") : "";
  } catch {
    return "";
  }
}

function rowText(row: SearchTextRow): string {
  return [row.name, row.brand_name, row.category_name, row.department_name, row.description, bulletText(row.bullets)].join(" ");
}

/** Every word token of the query matches the start of some word of the label. */
function labelMatches(label: string, queryTokens: readonly string[]): boolean {
  const labelWords = words(label);
  return queryTokens.every((q) => labelWords.some((w) => w.startsWith(q)));
}

function hrefFor(type: Suggestion["type"], slug: string): string {
  const base = type === "product" ? "/products/" : type === "category" ? "/category/" : "/brand/";
  return base + encodeURIComponent(slug);
}

/** Reads options defensively: `null` and non-objects behave like `{}`; wrongly typed fields are ignored. */
function readOptions(options: unknown): SearchOptions {
  if (typeof options !== "object" || options === null) return {};
  const o = options as Record<string, unknown>;
  return {
    inStockOnly: o.inStockOnly === true,
    page: typeof o.page === "number" ? o.page : undefined,
    pageSize: typeof o.pageSize === "number" ? o.pageSize : undefined,
    now: typeof o.now === "number" ? o.now : undefined,
  };
}

class DefaultSearchService implements SearchService {
  constructor(
    private readonly repo: SearchRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  /** ISO "now": the per-call override when valid, else the injected clock, else the real time. */
  private nowIso(override?: number): string {
    if (typeof override === "number" && Number.isFinite(override)) return nowIsoFrom(override);
    let t: number | undefined;
    try {
      t = this.clock();
    } catch {
      t = undefined;
    }
    return nowIsoFrom(t);
  }

  search(query: unknown, rawOptions?: SearchOptions | null): Result<SearchResult, AppError> {
    let normalizedQuery = "";
    let terms: readonly string[] = [];
    try {
      ({ normalizedQuery, terms } = normalizeSearchQuery(query));
      const options = readOptions(rawOptions);
      const pageSize = clampPageSize(options.pageSize);
      const page = normalizePage(options.page);
      const nowIso = this.nowIso(options.now);
      const inStockOnly = options.inStockOnly === true;
      const offset = (page - 1) * pageSize;
      if (terms.length === 0) {
        const filter = { nowIso, inStockOnly };
        const total = this.repo.countPublished(filter);
        const ids = offset < total ? this.repo.listPublishedIds(filter, pageSize, offset) : [];
        return ok({ ids, total, normalizedQuery, terms, didYouMean: null, browseAll: true });
      }
      const match = buildMatchExpression(terms);
      let total = 0;
      let ids: string[] = [];
      if (match !== "") {
        const filter = { match, nowIso, inStockOnly };
        total = this.repo.countMatches(filter);
        ids = offset < total ? this.repo.findMatchIds(filter, pageSize, offset) : [];
      }
      const didYouMean = total === 0 ? this.correct(terms, normalizedQuery, nowIso, inStockOnly) : null;
      return ok({ ids, total, normalizedQuery, terms, didYouMean, browseAll: false });
    } catch (e) {
      // Unreachable by construction (quoted terms, bound parameters); kept so search never throws.
      return fail("INTERNAL_ERROR", "Search could not be completed.", {
        reason: e instanceof Error ? e.message : "unknown",
        normalizedQuery,
        termCount: terms.length,
      });
    }
  }

  suggest(prefix: unknown, limit?: number): readonly Suggestion[] {
    try {
      const { normalizedQuery, terms } = normalizeSearchQuery(prefix);
      if (Array.from(normalizedQuery).length < 2) return [];
      const match = buildMatchExpression(terms);
      if (match === "") return [];
      const max = clampSuggestionLimit(limit);
      const nowIso = this.nowIso();
      const queryTokens = terms.flatMap(words);

      const products = this.repo.suggestProducts(match, nowIso, max);
      const categories = this.repo
        .listCategoriesWithPublished(nowIso)
        .filter((c) => labelMatches(c.name, queryTokens));
      const brands = this.repo.listBrandsWithPublished(nowIso).filter((b) => labelMatches(b.name, queryTokens));

      const catSlots = Math.min(categories.length, RESERVED_TAXONOMY_SLOTS);
      const brandSlots = Math.min(brands.length, RESERVED_TAXONOMY_SLOTS);
      const productSlots = Math.max(0, max - catSlots - brandSlots);

      const ordered: Suggestion[] = [
        ...products.slice(0, productSlots).map((p) => ({ type: "product" as const, slug: p.slug, label: p.name })),
        ...categories.slice(0, catSlots).map((c) => ({ type: "category" as const, slug: c.slug, label: c.name })),
        ...brands.slice(0, brandSlots).map((b) => ({ type: "brand" as const, slug: b.slug, label: b.name })),
        ...products.slice(productSlots).map((p) => ({ type: "product" as const, slug: p.slug, label: p.name })),
      ].map(({ type, slug, label }) => ({ type, label, href: hrefFor(type, slug) }));

      const out: Suggestion[] = [];
      const seen = new Set<string>();
      for (const s of ordered) {
        const labelKey = `${s.type}\u0000${s.label.toLowerCase()}`;
        if (seen.has(s.href) || seen.has(labelKey)) continue;
        seen.add(s.href);
        seen.add(labelKey);
        out.push(s);
        if (out.length >= max) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  didYouMean(query: string): string | null {
    try {
      const { normalizedQuery, terms } = normalizeSearchQuery(query);
      if (terms.length === 0) return null;
      const nowIso = this.nowIso();
      const match = buildMatchExpression(terms);
      if (match !== "" && this.repo.countMatches({ match, nowIso, inStockOnly: false }) > 0) return null;
      return this.correct(terms, normalizedQuery, nowIso, false);
    } catch {
      return null;
    }
  }

  /**
   * Per-term correction against the published vocabulary. Terms that match
   * on their own are kept; others are replaced by the closest published word
   * (distance <= 2, or <= 1 for terms of 4 characters or fewer; terms under 3
   * characters are never corrected), ties broken by higher vocabulary `doc`
   * then alphabetically. Returns null when nothing changed or the corrected
   * query still finds nothing.
   */
  private correct(terms: readonly string[], normalizedQuery: string, nowIso: string, inStockOnly: boolean): string | null {
    const lexicon = this.buildLexicon(nowIso);
    if (lexicon.size === 0) return null;
    let changed = false;
    const corrected = terms.map((term) => {
      const termLength = Array.from(term).length;
      if (termLength < 3 || !HAS_WORD_CHAR.test(term)) return term;
      const exact = exactTermExpression(term);
      if (exact !== "" && this.repo.countMatches({ match: exact, nowIso, inStockOnly: false }) > 0) return term;
      const maxDistance = termLength <= 4 ? 1 : MAX_EDIT_DISTANCE;
      let best: { word: string; distance: number; doc: number } | null = null;
      for (const [word, doc] of lexicon) {
        if (word === term) continue;
        const distance = boundedDamerauLevenshtein(term, word, maxDistance);
        if (distance > maxDistance) continue;
        if (
          best === null ||
          distance < best.distance ||
          (distance === best.distance && (doc > best.doc || (doc === best.doc && word < best.word)))
        ) {
          best = { word, distance, doc };
        }
      }
      if (best === null) return term;
      changed = true;
      return best.word;
    });
    if (!changed) return null;
    const suggestion = corrected.join(" ");
    if (suggestion === normalizedQuery) return null;
    const match = buildMatchExpression(corrected);
    if (match === "" || this.repo.countMatches({ match, nowIso, inStockOnly }) === 0) return null;
    return suggestion;
  }

  /**
   * Surface words of published products mapped to a document weight: the
   * `products_fts_vocab.doc` of the word's porter stem (the longest vocabulary
   * term that prefixes the word), else the local document count.
   */
  private buildLexicon(nowIso: string): Map<string, number> {
    const localDocs = new Map<string, number>();
    for (const row of this.repo.listPublishedText(nowIso)) {
      for (const w of new Set(words(rowText(row)))) {
        if (Array.from(w).length >= 3) localDocs.set(w, (localDocs.get(w) ?? 0) + 1);
      }
    }
    const vocab = new Map<string, number>();
    for (const v of this.repo.listVocabulary()) vocab.set(v.term, v.doc);
    const lexicon = new Map<string, number>();
    for (const [word, local] of localDocs) {
      let doc = local;
      for (let end = word.length; end >= 2; end--) {
        const stemDoc = vocab.get(word.slice(0, end));
        if (stemDoc !== undefined) {
          doc = stemDoc;
          break;
        }
      }
      lexicon.set(word, doc);
    }
    return lexicon;
  }
}

/**
 * `now` (epoch ms) is the clock for `suggest`/`didYouMean` and the default for
 * `search`; `SearchOptions.now` overrides it per call.
 */
export function createSearchService(deps: { db: Database; now?: () => number }): SearchService {
  return new DefaultSearchService(new SqliteSearchRepository(deps.db), deps.now);
}

/** Test seam: a service over any `SearchRepository` (e.g. a failing fake). */
export function createSearchServiceWithRepository(repo: SearchRepository, now?: () => number): SearchService {
  return new DefaultSearchService(repo, now);
}

const globalForSearch = globalThis as typeof globalThis & {
  __storefrontSearchService?: { readonly db: Database; readonly service: SearchService };
};

/**
 * App-wide search service over `getDatabase()`, cached on `globalThis`. Rebuilt
 * whenever `getDatabase()` returns a different handle (e.g. after `closeDatabase()`).
 */
export function getSearchService(): SearchService {
  const db = getDatabase();
  const cached = globalForSearch.__storefrontSearchService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createSearchService({ db });
  globalForSearch.__storefrontSearchService = { db, service };
  return service;
}
