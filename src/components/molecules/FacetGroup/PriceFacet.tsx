import { Link } from "@/components/atoms/Link";
import type { FacetBucket, ListingSort } from "@/server/catalog/listing-service";
import { buildListingHref, priceBucketToParams, type ListingHrefOptions, type ListingParams } from "../_listing-url";
import { facetOptionLabel, isBucketDisabled } from "./FacetGroup";
import { PriceInputs } from "./PriceInputs";

export type PricePresetValue = { readonly minCents: number; readonly maxCents: number | null };

export interface PriceFacetProps {
  /** Defaults to "Price". */
  legend?: string;
  /** Price buckets from `FacetCounts.price` (cents); rendered as preset links. */
  presets?: readonly FacetBucket<PricePresetValue>[];
  base: string;
  /** Current state; `params.min` / `params.max` (whole dollars) prefill the inputs. */
  params: ListingParams;
  /**
   * Route default sort (e.g. `best_selling` on /best-sellers): only this sort
   * is omitted from the preset links. Absent = `defaultSortFor(q)`.
   */
  defaultSort?: ListingSort;
  className?: string;
}

/**
 * Price facet: preset links (each sets `min`/`max` in whole dollars and drops
 * `page`) plus Min/Max numeric inputs that post with the parent GET form
 * (T79 owns the form and Apply button). URL values are whole dollars; the
 * page converts to cents (min * 100, max * 100 + 99). Server-safe; the inputs
 * are a small client component only for the live "min > max" hint.
 */
export function PriceFacet({ legend = "Price", presets = [], base, params, defaultSort, className }: PriceFacetProps) {
  const hrefOpts: ListingHrefOptions = defaultSort !== undefined ? { defaultSort } : {};
  return (
    <fieldset className={["m-0 min-w-0 border-0 p-0", className].filter(Boolean).join(" ")}>
      <legend className="mb-1 text-small font-semibold text-text-primary">{legend}</legend>
      {presets.length > 0 ? (
        <ul role="list" className="m-0 flex list-none flex-col p-0">
          {presets.map((preset) => {
            const key = `${preset.value.minCents}-${preset.value.maxCents ?? "up"}`;
            const text = facetOptionLabel(preset.label, preset.count);
            return (
              <li key={key}>
                {isBucketDisabled(preset) ? (
                  <span className="inline-flex min-h-touch items-center text-small text-text-secondary">{text}</span>
                ) : (
                  <Link
                    variant="nav"
                    href={buildListingHref(base, params, priceBucketToParams(preset.value), hrefOpts)}
                    isCurrent={preset.selected}
                    className={`text-small break-words${preset.selected ? " font-semibold" : ""}`}
                  >
                    {text}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <PriceInputs min={params.min} max={params.max} />
    </fieldset>
  );
}
