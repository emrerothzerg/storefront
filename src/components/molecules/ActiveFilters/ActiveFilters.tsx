import { Chip } from "@/components/atoms/Chip";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import {
  buildListingHref,
  formatWholeDollars,
  listingEntries,
  mergeListingParams,
  type ListingHrefOptions,
  type ListingParams,
  type ListingSortValue,
} from "../_listing-url";

export interface ActiveFilterLabels {
  /** Brand slug -> display name. */
  brand?: Readonly<Record<string, string>>;
  /** Category slug -> display name. */
  category?: Readonly<Record<string, string>>;
}

export interface ActiveFiltersProps {
  params: ListingParams;
  base: string;
  labels?: ActiveFilterLabels;
  /** Optional result count shown as text next to the heading. */
  resultCount?: number;
  /**
   * Route default sort (e.g. `best_selling` on /best-sellers): only this sort
   * is omitted from the remove-chip and "Clear all" links, so a user-chosen
   * `featured` survives. Absent = `defaultSortFor(q)`.
   */
  defaultSort?: ListingSortValue;
  className?: string;
}

export interface ActiveFilterChip {
  /** Stable key. */
  key: string;
  /** Visible text, e.g. "Brand: Acme". */
  text: string;
  /** Accessible name, e.g. "Remove filter: Brand Acme". */
  removeLabel: string;
  /** URL with only this filter removed (and `page` dropped). */
  href: string;
}

function lookup(map: Readonly<Record<string, string>> | undefined, slug: string): string {
  if (map !== undefined && Object.prototype.hasOwnProperty.call(map, slug)) {
    const name = map[slug];
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return slug;
}

/** "Price: $25–$49", "Price: $25 & above", "Price: Up to $49". */
export function priceChipText(min: number | undefined, max: number | undefined): string | null {
  if (min !== undefined && max !== undefined) return `Price: ${formatWholeDollars(min)}–${formatWholeDollars(max)}`;
  if (min !== undefined) return `Price: ${formatWholeDollars(min)} & above`;
  if (max !== undefined) return `Price: Up to ${formatWholeDollars(max)}`;
  return null;
}

/** "4 stars & up" / "1 star & up". */
export function ratingChipText(rating: number): string {
  return `${rating} ${rating === 1 ? "star" : "stars"} & up`;
}

/**
 * Chips for every applied filter, from the NORMALISED params (invalid values
 * the URL builder would drop never produce a chip).
 */
export function activeFilterChips(
  params: ListingParams,
  base: string,
  labels: ActiveFilterLabels = {},
  opts: ListingHrefOptions = {},
): ActiveFilterChip[] {
  const entries = listingEntries(params, {}, opts);
  const get = (key: string) => entries.find(([k]) => k === key)?.[1];
  const brands = entries.filter(([k]) => k === "brand").map(([, v]) => v);
  const chips: ActiveFilterChip[] = [];

  const category = get("category");
  if (category !== undefined) {
    const name = lookup(labels.category, category);
    chips.push({
      key: `category:${category}`,
      text: `Category: ${name}`,
      removeLabel: `Remove filter: Category ${name}`,
      href: buildListingHref(base, params, { category: undefined }, opts),
    });
  }
  for (const slug of brands) {
    const name = lookup(labels.brand, slug);
    chips.push({
      key: `brand:${slug}`,
      text: `Brand: ${name}`,
      removeLabel: `Remove filter: Brand ${name}`,
      href: buildListingHref(base, params, { brand: brands.filter((b) => b !== slug) }, opts),
    });
  }
  const minRaw = get("min");
  const maxRaw = get("max");
  const price = priceChipText(
    minRaw === undefined ? undefined : Number(minRaw),
    maxRaw === undefined ? undefined : Number(maxRaw),
  );
  if (price !== null) {
    chips.push({
      key: "price",
      text: price,
      removeLabel: `Remove filter: ${price.replace(/^Price: /, "Price ")}`,
      href: buildListingHref(base, params, { min: undefined, max: undefined }, opts),
    });
  }
  const rating = get("rating");
  if (rating !== undefined) {
    const text = ratingChipText(Number(rating));
    chips.push({
      key: "rating",
      text,
      removeLabel: `Remove filter: Rating ${text}`,
      href: buildListingHref(base, params, { rating: undefined }, opts),
    });
  }
  if (get("instock") !== undefined) {
    chips.push({
      key: "instock",
      text: "In stock only",
      removeLabel: "Remove filter: In stock only",
      href: buildListingHref(base, params, { instock: undefined }, opts),
    });
  }
  if (get("deals") !== undefined) {
    chips.push({
      key: "deals",
      text: "Deals only",
      removeLabel: "Remove filter: Deals only",
      href: buildListingHref(base, params, { deals: undefined }, opts),
    });
  }
  return chips;
}

/** "Clear all": keeps `q`, `sort`, `view`, `dept` and the preserved unknown params (`extra`); drops filters and `page`. */
export function clearAllHref(base: string, params: ListingParams, opts: ListingHrefOptions = {}): string {
  const kept = mergeListingParams({ q: params.q, dept: params.dept, sort: params.sort, view: params.view, extra: params.extra });
  return buildListingHref(base, kept, {}, opts);
}

/**
 * Applied-filter chips. Each chip is a plain link to the current URL with
 * that one filter removed; "Clear all" keeps the search query, sort, view
 * and department. Renders nothing when no filter is applied. Server-safe.
 */
export function ActiveFilters({ params, base, labels, resultCount, defaultSort, className }: ActiveFiltersProps) {
  const hrefOpts: ListingHrefOptions = defaultSort !== undefined ? { defaultSort } : {};
  const chips = activeFilterChips(params, base, labels, hrefOpts);
  if (chips.length === 0) return null;
  const count =
    resultCount !== undefined && Number.isSafeInteger(resultCount) && resultCount >= 0 ? resultCount : undefined;

  return (
    <div className={["flex min-w-0 flex-col gap-2", className].filter(Boolean).join(" ")}>
      <p className="m-0 inline-flex flex-wrap items-center gap-1 text-small font-semibold text-text-primary">
        <Icon name="filter" size="sm" />
        <span>Active filters</span>
        {count !== undefined ? (
          <span className="font-normal text-text-secondary">
            ({count.toLocaleString("en-US")} {count === 1 ? "result" : "results"})
          </span>
        ) : null}
      </p>
      <ul role="list" aria-label="Active filters" className="m-0 flex list-none flex-wrap items-center gap-2 p-0">
        {chips.map((chip) => (
          <li key={chip.key} className="max-w-full">
            <Chip
              as="a"
              href={chip.href}
              label={chip.text}
              aria-label={chip.removeLabel}
              size="sm"
              trailingIcon="close"
              className="max-w-full wrap-anywhere"
            />
          </li>
        ))}
        <li>
          <Link variant="nav" href={clearAllHref(base, params, hrefOpts)} className="text-small underline">
            Clear all
          </Link>
        </li>
      </ul>
    </div>
  );
}
