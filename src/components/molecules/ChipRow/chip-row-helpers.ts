import { isAllowedInternalHref } from "@/content/routes";

/**
 * Pure helpers for ChipRow (T142). No React, no `src/server/**` imports.
 * The query limit mirrors `MAX_QUERY_LENGTH` (src/app/_listing/parse-params.ts,
 * src/server/catalog/search-service.ts); the colocated test pins them equal.
 */

/** Longest visible chip label in code points, ellipsis included. */
export const CHIP_LABEL_MAX = 40;
/** Longest search query put into a chip href (code units, never mid surrogate pair). */
export const CHIP_QUERY_MAX = 100;
/** Default cap on rendered chips (CONTRACTS H-18 / L-4: at most 12). */
export const CHIP_ROW_MAX_ITEMS = 12;
/** Base path of search chips. */
export const CHIP_SEARCH_PATH = "/search";

const ELLIPSIS = "…";
// C0/C1 controls -> space; zero-width/bidi format chars and lone surrogates removed.
const CONTROL_RE = /\p{Cc}/gu;
const FORMAT_RE = /\p{Cf}/gu;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Control/format characters stripped, whitespace collapsed, trimmed. */
export function cleanChipText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .slice(0, 4000)
    .replace(CONTROL_RE, " ")
    .replace(FORMAT_RE, "")
    .replace(LONE_SURROGATE_RE, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export interface ChipLabel {
  /** Visible text: at most {@link CHIP_LABEL_MAX} code points (ellipsis included). */
  readonly text: string;
  /** Cleaned full label (equals `text` when not truncated). */
  readonly full: string;
  readonly truncated: boolean;
}

/** Cleaned, trimmed chip label truncated with an ellipsis; `null` when empty. */
export function chipLabel(raw: unknown, max: number = CHIP_LABEL_MAX): ChipLabel | null {
  const full = cleanChipText(raw);
  if (full === "") return null;
  const points = Array.from(full);
  if (points.length <= max) return { text: full, full, truncated: false };
  const text = `${points.slice(0, Math.max(1, max - 1)).join("").trimEnd()}${ELLIPSIS}`;
  return { text, full, truncated: true };
}

/** Cuts to at most `max` code units without splitting a surrogate pair. */
function cutCodeUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** The query as it goes into the href: cleaned and cut to {@link CHIP_QUERY_MAX}; `null` when empty. */
export function chipSearchQuery(raw: unknown): string | null {
  const cut = cutCodeUnits(cleanChipText(raw), CHIP_QUERY_MAX).trim();
  return cut === "" ? null : cut;
}

/** `/search?q=<encodeURIComponent(query)>`, or `null` for an empty query. */
export function chipSearchHref(rawQuery: unknown): string | null {
  const query = chipSearchQuery(rawQuery);
  return query === null ? null : `${CHIP_SEARCH_PATH}?q=${encodeURIComponent(query)}`;
}

/** A chip that links to any allow-listed internal route (category, brand...). */
export interface ChipRowLinkItem {
  readonly label: string;
  readonly href: string;
  readonly query?: never;
}

/** A search chip: href built from `query`; `label` defaults to the query. */
export interface ChipRowSearchItem {
  readonly query: string;
  readonly label?: string;
  readonly href?: never;
}

export type ChipRowItem = ChipRowLinkItem | ChipRowSearchItem;

export interface ResolvedChip {
  readonly href: string;
  readonly label: ChipLabel;
}

function resolveOne(item: ChipRowItem): ResolvedChip | null {
  if (item === null || typeof item !== "object") return null;
  let href: string | null;
  let rawLabel: unknown;
  if (typeof item.query === "string") {
    href = chipSearchHref(item.query);
    rawLabel = typeof item.label === "string" && cleanChipText(item.label) !== "" ? item.label : chipSearchQuery(item.query);
  } else {
    href = typeof item.href === "string" ? item.href : null;
    rawLabel = item.label;
  }
  if (href === null || !isAllowedInternalHref(href)) return null;
  const label = chipLabel(rawLabel);
  return label === null ? null : { href, label };
}

/**
 * Chips ready to render: invalid items (empty label/query, href not on the
 * route allow-list) dropped, duplicates by href dropped (first wins), at most
 * `max` kept.
 */
export function resolveChips(
  items: ReadonlyArray<ChipRowItem> | null | undefined,
  max: number = CHIP_ROW_MAX_ITEMS,
): ResolvedChip[] {
  const list: ReadonlyArray<ChipRowItem> = Array.isArray(items as unknown) ? (items as ReadonlyArray<ChipRowItem>) : [];
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : CHIP_ROW_MAX_ITEMS;
  const seen = new Set<string>();
  const out: ResolvedChip[] = [];
  for (const item of list) {
    if (out.length >= limit) break;
    const chip = resolveOne(item);
    if (chip === null || seen.has(chip.href)) continue;
    seen.add(chip.href);
    out.push(chip);
  }
  return out;
}
