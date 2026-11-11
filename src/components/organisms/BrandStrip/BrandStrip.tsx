import { useId } from "react";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Heading } from "@/components/atoms/Typography";
import { isAllowedInternalHref } from "@/content/routes";

/** Structural subset of `Brand` / `BrandWithCount` plus an optional logo. */
export interface BrandStripItem {
  slug: string;
  name: string;
  logo?: string | null;
}

export interface BrandStripProps {
  brands: readonly BrandStripItem[];
  /** Defaults to "Featured brands". */
  title?: string;
  headingLevel?: 2 | 3;
  /** Section id; heading id is `<id>-heading` (else `useId`). */
  id?: string;
  className?: string;
}

export const BRAND_STRIP_DEFAULT_TITLE = "Featured brands";

/** `/brand/<encoded slug>`. */
export function brandHref(slug: string): string {
  return `/brand/${encodeURIComponent(slug)}`;
}

interface StripBrand {
  slug: string;
  name: string;
  logo: string | null;
  href: string;
}

/** Valid, de-duplicated brands in input order (blank name/slug or disallowed href dropped). */
export function brandStripItems(brands: readonly BrandStripItem[]): StripBrand[] {
  if (!Array.isArray(brands)) return [];
  const seen = new Set<string>();
  const items: StripBrand[] = [];
  for (const brand of brands) {
    if (brand === null || typeof brand !== "object") continue;
    const slug = typeof brand.slug === "string" ? brand.slug.trim() : "";
    const name = typeof brand.name === "string" ? brand.name.trim() : "";
    if (slug === "" || name === "" || seen.has(slug)) continue;
    const href = brandHref(slug);
    if (!isAllowedInternalHref(href)) continue;
    seen.add(slug);
    const logo = typeof brand.logo === "string" && brand.logo.trim() !== "" ? brand.logo.trim() : null;
    items.push({ slug, name, logo, href });
  }
  return items;
}

/**
 * Scroll container: one no-wrap row that scrolls inside itself below 640px
 * (no page scroll at 320px), wrapping from `sm`. `p-1` on the list leaves room
 * for the focus outline so it is not clipped by the overflow box.
 */
export const BRAND_STRIP_SCROLLER_CLASSES = "max-w-full overflow-x-auto sm:overflow-visible";
export const BRAND_STRIP_LIST_CLASSES = "flex w-max min-w-full flex-nowrap gap-3 p-1 sm:w-auto sm:flex-wrap";

/** Rounded white tile; the Link `nav` variant supplies the 44px min height/width. */
const BRAND_LINK_CLASSES =
  "max-w-full justify-center rounded-lg border border-border-default bg-surface-raised px-5 py-2 text-small font-semibold shadow-sm break-words transition-shadow hover:border-border-strong hover:shadow-md";

/**
 * "Featured brands": a row of rounded brand tiles (logo with alt = name, or
 * the name as text) linking to `/brand/<slug>`. Server-safe. Returns null when
 * no valid brand is left.
 */
export function BrandStrip({
  brands,
  title = BRAND_STRIP_DEFAULT_TITLE,
  headingLevel = 2,
  id,
  className,
}: BrandStripProps) {
  const autoId = useId();
  const items = brandStripItems(brands);
  if (items.length === 0) return null;
  const heading = title.trim() === "" ? BRAND_STRIP_DEFAULT_TITLE : title.trim();
  const headingId = `${id ?? `brand-strip-${autoId}`}-heading`;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <Heading level={headingLevel} size={headingLevel === 2 ? "h3" : "h4"} id={headingId} className="break-words">
        {heading}
      </Heading>
      <div className={BRAND_STRIP_SCROLLER_CLASSES}>
        <ul role="list" className={BRAND_STRIP_LIST_CLASSES}>
          {items.map((brand) => (
            <li key={brand.slug} className="flex min-w-0 max-w-xs shrink-0">
              <Link href={brand.href} variant="nav" className={BRAND_LINK_CLASSES}>
                {brand.logo !== null ? (
                  <Image src={brand.logo} alt={brand.name} width={120} height={48} className="block h-10 w-auto" />
                ) : (
                  brand.name
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
