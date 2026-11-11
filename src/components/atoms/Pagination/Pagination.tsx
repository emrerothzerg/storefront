import NextLink from "next/link";
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { Icon } from "../Icon";

export type PaginationItem = number | "ellipsis-start" | "ellipsis-end";

/** Page count from untrusted input: non-finite or negative -> 0, otherwise floored. */
export function normalizePageCount(pageCount: number): number {
  return Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : 0;
}

/**
 * Current page from untrusted input (e.g. `Number(searchParams.page)`):
 * non-finite or non-integer -> 1, below 1 -> 1, above `pageCount` -> `pageCount`.
 */
export function normalizePage(page: number, pageCount: number): number {
  const count = normalizePageCount(pageCount);
  if (count < 1) return 1;
  if (!Number.isInteger(page)) return 1;
  return Math.min(Math.max(1, page), count);
}

function normalizeCount(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * Page numbers to show: `boundaryCount` pages at each end, `siblingCount`
 * around the current page, and an ellipsis where a gap of 2+ pages is hidden
 * (a gap of exactly one page shows that page instead). Pure; exported for tests.
 */
export function getPaginationItems(
  page: number,
  pageCount: number,
  siblingCountInput = 1,
  boundaryCountInput = 1,
): PaginationItem[] {
  pageCount = normalizePageCount(pageCount);
  if (pageCount < 1) return [];
  const siblingCount = normalizeCount(siblingCountInput, 1);
  const boundaryCount = normalizeCount(boundaryCountInput, 1);
  const current = normalizePage(page, pageCount);
  const range = (start: number, end: number) =>
    Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);

  const startPages = range(1, Math.min(boundaryCount, pageCount));
  const endPages = range(Math.max(pageCount - boundaryCount + 1, boundaryCount + 1), pageCount);

  const siblingsStart = Math.max(
    Math.min(current - siblingCount, pageCount - boundaryCount - siblingCount * 2 - 1),
    boundaryCount + 2,
  );
  const siblingsEnd = Math.min(
    Math.max(current + siblingCount, boundaryCount + siblingCount * 2 + 2),
    endPages.length > 0 ? (endPages[0] ?? pageCount) - 2 : pageCount - 1,
  );

  const items: PaginationItem[] = [...startPages];
  if (siblingsStart > boundaryCount + 2) items.push("ellipsis-start");
  else if (boundaryCount + 1 < pageCount - boundaryCount) items.push(boundaryCount + 1);
  items.push(...range(siblingsStart, siblingsEnd));
  if (siblingsEnd < pageCount - boundaryCount - 1) items.push("ellipsis-end");
  else if (pageCount - boundaryCount > boundaryCount) items.push(pageCount - boundaryCount);
  items.push(...endPages);

  // Dedupe while keeping order (small page counts overlap the formulas).
  const seen = new Set<PaginationItem>();
  return items.filter((item) => {
    if (typeof item === "number" && (item < 1 || item > pageCount)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

export interface PaginationProps extends Omit<ComponentPropsWithRef<"nav">, "children"> {
  /** Current page, 1-based. Non-finite/non-integer -> 1; out of range is clamped. */
  page: number;
  /** Total pages. Renders nothing when < 2. */
  pageCount: number;
  /** URL for a page, e.g. `(p) => \`/search?q=shoes&page=${p}\``. Every control is a real link, so it works without JS. */
  hrefFor: (page: number) => string;
  /**
   * Client-side handler (only usable from client components). When given,
   * plain left-clicks call it instead of navigating; modified clicks
   * (new tab etc.) still follow the href.
   */
  onPageChange?: (page: number) => void;
  /** Pages either side of the current one. Defaults to 1. */
  siblingCount?: number;
  /** Pages always shown at each end. Defaults to 1. */
  boundaryCount?: number;
  /** Landmark name. Defaults to "Pagination". */
  label?: string;
}

const itemBase =
  "inline-flex min-h-touch min-w-touch items-center justify-center gap-1 rounded-md px-2 text-body";
const linkClasses = `${itemBase} text-text-primary hover:bg-surface-sunken hover:text-accent hover:underline`;
const currentClasses = `${itemBase} border border-border-strong bg-accent-subtle font-semibold text-accent underline decoration-2 underline-offset-4`;
const disabledClasses = `${itemBase} cursor-not-allowed text-text-secondary`;

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  );
}

/**
 * Server-renderable pagination: `<nav aria-label="Pagination">` with real
 * links (`rel="prev"`/`rel="next"`), `aria-current="page"` on the current
 * page, and disabled prev/next rendered as non-links. Not a client component,
 * so server pages can pass `hrefFor` directly.
 */
export function Pagination({
  page,
  pageCount,
  hrefFor,
  onPageChange,
  siblingCount = 1,
  boundaryCount = 1,
  label = "Pagination",
  className,
  ref,
  ...rest
}: PaginationProps) {
  const count = normalizePageCount(pageCount);
  if (count < 2) return null;
  const current = normalizePage(page, count);
  const items = getPaginationItems(current, count, siblingCount, boundaryCount);

  const handleClick = (target: number) =>
    onPageChange
      ? (event: MouseEvent<HTMLAnchorElement>) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          onPageChange(target);
        }
      : undefined;

  const edge = (direction: "prev" | "next"): ReactNode => {
    const target = direction === "prev" ? current - 1 : current + 1;
    const disabled = target < 1 || target > count;
    const text = direction === "prev" ? "Previous" : "Next";
    const content = (
      <>
        {direction === "prev" ? <Icon name="chevron-left" size="sm" /> : null}
        <span className="sr-only sm:not-sr-only">{text}</span>
        {direction === "next" ? <Icon name="chevron-right" size="sm" /> : null}
      </>
    );
    if (disabled) {
      return (
        <span aria-disabled="true" data-edge={direction} className={disabledClasses}>
          {content}
          <span className="sr-only"> page</span>
        </span>
      );
    }
    return (
      <NextLink
        href={hrefFor(target)}
        rel={direction}
        aria-label={`${text} page`}
        onClick={handleClick(target)}
        className={linkClasses}
      >
        {content}
      </NextLink>
    );
  };

  return (
    <nav {...rest} ref={ref} aria-label={label} className={className}>
      <ul className="flex flex-wrap items-center justify-center gap-1">
        <li>{edge("prev")}</li>
        {items.map((item) =>
          typeof item === "number" ? (
            <li key={item}>
              <NextLink
                href={hrefFor(item)}
                aria-label={`Page ${item}`}
                aria-current={item === current ? "page" : undefined}
                rel={item === current - 1 ? "prev" : item === current + 1 ? "next" : undefined}
                onClick={item === current ? undefined : handleClick(item)}
                className={item === current ? currentClasses : linkClasses}
              >
                {item}
              </NextLink>
            </li>
          ) : (
            <li key={item} aria-hidden="true" className="inline-flex min-w-touch justify-center text-text-secondary">
              &hellip;
            </li>
          ),
        )}
        <li>{edge("next")}</li>
      </ul>
    </nav>
  );
}

export interface PaginationSummaryProps extends Omit<ComponentPropsWithRef<"p">, "children"> {
  page: number;
  pageSize: number;
  total: number;
  /** Plural noun after the total. Defaults to "results". */
  itemLabel?: string;
}

const numberFormat = new Intl.NumberFormat("en-US");

/**
 * "Showing 1–24 of 312 results". Pure text; server-component safe. Untrusted
 * input is sanitised and never prints "NaN": invalid total or page size ->
 * "No results", invalid page -> 1, out-of-range page -> clamped.
 */
export function formatPaginationSummary(
  pageInput: number,
  pageSizeInput: number,
  totalInput: number,
  itemLabel = "results",
): string {
  const total = Number.isFinite(totalInput) && totalInput > 0 ? Math.floor(totalInput) : 0;
  const pageSize =
    Number.isFinite(pageSizeInput) && pageSizeInput > 0 ? Math.floor(pageSizeInput) : 0;
  if (total <= 0 || pageSize <= 0) return `No ${itemLabel}`;
  const pageCount = Math.ceil(total / pageSize);
  const page = Number.isFinite(pageInput) ? Math.floor(pageInput) : 1;
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * pageSize + 1;
  const end = Math.min(total, current * pageSize);
  return `Showing ${numberFormat.format(start)}–${numberFormat.format(end)} of ${numberFormat.format(total)} ${itemLabel}`;
}

export function PaginationSummary({
  page,
  pageSize,
  total,
  itemLabel,
  className,
  ref,
  ...rest
}: PaginationSummaryProps) {
  return (
    <p
      {...rest}
      ref={ref}
      className={["text-small text-text-secondary", className].filter(Boolean).join(" ")}
    >
      {formatPaginationSummary(page, pageSize, total, itemLabel)}
    </p>
  );
}
