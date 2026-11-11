import type { ReactNode } from "react";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Link } from "@/components/atoms/Link";
import { Radio, RadioGroup } from "@/components/atoms/Radio";
import type { FacetBucket, ListingSort } from "@/server/catalog/listing-service";
import { buildListingHref, type ListingHrefOptions, type ListingParams } from "../_listing-url";

export type FacetName = "brand" | "category" | "rating" | "instock" | "deals";
export type FacetKind = "checkbox" | "radio" | "links";

export interface FacetGroupProps {
  /** Visible group name (`<legend>`), e.g. "Brand". */
  legend: string;
  /** Listing param the controls post / the links set. */
  name: FacetName;
  kind: FacetKind;
  buckets: readonly FacetBucket<string | number>[];
  /** Listing path the links point to, e.g. "/search". */
  base: string;
  /** Current listing state (links keep it, minus `page`). */
  params: ListingParams;
  /** Buckets shown before "Show N more". Defaults to 6. */
  maxVisible?: number;
  /** Initial state of the "Show N more" disclosure (forced open when a hidden bucket is selected). */
  defaultOpen?: boolean;
  /** Radio kind: label of the "no filter" option (posts an empty value). Defaults to "Any". */
  anyLabel?: string;
  /**
   * Route default sort (e.g. `best_selling` on /best-sellers): only this sort
   * is omitted from the facet links, so a user-chosen `featured` survives.
   * Absent = `defaultSortFor(q)`.
   */
  defaultSort?: ListingSort;
  className?: string;
}

export const DEFAULT_MAX_VISIBLE = 6;

/** "Acme (12)". Counts are plain text. */
export function facetOptionLabel(label: string, count: number): string {
  const safe = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return `${label} (${safe.toLocaleString("en-US")})`;
}

/** Zero-count buckets that are not selected cannot be chosen (criterion 1). */
export function isBucketDisabled<T>(bucket: FacetBucket<T>): boolean {
  return !bucket.selected && !(Number.isSafeInteger(bucket.count) && bucket.count > 0);
}

function normaliseMaxVisible(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_VISIBLE;
  return Math.max(1, Math.floor(value));
}

/** The patch a link for this bucket applies. Brand links add the brand to the selection. */
export function facetLinkPatch(name: FacetName, value: string | number, params: ListingParams): Partial<ListingParams> {
  switch (name) {
    case "brand": {
      const slug = String(value);
      const current = params.brand ?? [];
      return { brand: current.includes(slug) ? current : [...current, slug] };
    }
    case "category":
      return { category: String(value) };
    case "rating": {
      const n = typeof value === "number" ? value : Number.parseInt(value, 10);
      return { rating: Number.isFinite(n) ? n : undefined };
    }
    case "instock":
      return { instock: true };
    case "deals":
      return { deals: true };
  }
}

function ShowMore({ hidden, open, children }: { hidden: number; open: boolean; children: ReactNode }) {
  return (
    <Disclosure
      defaultOpen={open}
      className="border-b-0"
      summaryClassName="text-small font-normal text-accent"
      summary={
        <>
          <span className="group-open/disclosure:hidden">Show {hidden} more</span>
          <span className="hidden group-open/disclosure:inline">Show fewer</span>
        </>
      }
    >
      {children}
    </Disclosure>
  );
}

/**
 * One facet dimension inside the listing's single GET form (T79 owns the
 * `<form method="get">` and its Apply button; FacetGroup never renders a form).
 *
 * - `checkbox`: native checkboxes `name={name} value={bucket.value}`.
 * - `radio`: `RadioGroup` (fieldset + legend) with an "Any" option posting "".
 * - `links`: plain links built with `buildListingHref` (category / rating).
 *
 * Labels are "<label> (<count>)" text; unselected zero-count buckets are
 * disabled ("(0)", plain text for links). Server-safe (no "use client").
 */
export function FacetGroup({
  legend,
  name,
  kind,
  buckets,
  base,
  params,
  maxVisible,
  defaultOpen = false,
  anyLabel = "Any",
  defaultSort,
  className,
}: FacetGroupProps) {
  if (buckets.length === 0) return null;
  const hrefOpts: ListingHrefOptions = defaultSort !== undefined ? { defaultSort } : {};
  const limit = normaliseMaxVisible(maxVisible);
  const visible = buckets.slice(0, limit);
  const overflow = buckets.slice(limit);
  const overflowOpen = defaultOpen || overflow.some((b) => b.selected);

  const renderBucket = (bucket: FacetBucket<string | number>): ReactNode => {
    const value = String(bucket.value);
    const text = facetOptionLabel(bucket.label, bucket.count);
    const disabled = isBucketDisabled(bucket);
    if (kind === "checkbox") {
      return (
        <li key={value}>
          <Checkbox name={name} value={value} label={text} defaultChecked={bucket.selected} disabled={disabled} />
        </li>
      );
    }
    if (kind === "radio") {
      return (
        <li key={value}>
          <Radio value={value} label={text} disabled={disabled} />
        </li>
      );
    }
    return (
      <li key={value}>
        {disabled ? (
          <span className="inline-flex min-h-touch items-center text-small text-text-secondary">{text}</span>
        ) : (
          <Link
            variant="nav"
            href={buildListingHref(base, params, facetLinkPatch(name, bucket.value, params), hrefOpts)}
            isCurrent={bucket.selected}
            className={`text-small break-words${bucket.selected ? " font-semibold" : ""}`}
          >
            {text}
          </Link>
        )}
      </li>
    );
  };

  const list = (
    <>
      <ul role="list" className="m-0 flex list-none flex-col p-0">
        {kind === "radio" ? (
          <li key="__any">
            <Radio value="" label={anyLabel} />
          </li>
        ) : null}
        {visible.map(renderBucket)}
      </ul>
      {overflow.length > 0 ? (
        <ShowMore hidden={overflow.length} open={overflowOpen}>
          <ul role="list" className="m-0 flex list-none flex-col p-0">
            {overflow.map(renderBucket)}
          </ul>
        </ShowMore>
      ) : null}
    </>
  );

  const rootClass = ["m-0 min-w-0 border-0 p-0", className].filter(Boolean).join(" ");

  if (kind === "radio") {
    const selected = buckets.find((b) => b.selected);
    return (
      <RadioGroup
        label={legend}
        name={name}
        defaultValue={selected === undefined ? "" : String(selected.value)}
        className={rootClass}
      >
        {list}
      </RadioGroup>
    );
  }

  return (
    <fieldset className={rootClass}>
      <legend className="mb-1 text-small font-semibold text-text-primary">{legend}</legend>
      {list}
    </fieldset>
  );
}
