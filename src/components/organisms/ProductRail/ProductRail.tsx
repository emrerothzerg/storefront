import { useId } from "react";
import { Link } from "@/components/atoms/Link";
import { ScrollRail, type ScrollRailItemWidth } from "@/components/atoms/ScrollRail";
import { Heading, Text } from "@/components/atoms/Typography";
import { ProductCard, productHref, type ProductCardQuickAdd } from "@/components/molecules/ProductCard";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import { validRailTabs, type ProductRailTab } from "./rail-tabs";

export interface ProductRailProps {
  /** Section heading and accessible name of the section. */
  title: string;
  /** Products of the rail (of the active tab when `tabs` is set). Duplicates (by id) render once. */
  products: readonly Product[];
  /** Optional short line above the heading (text only). */
  eyebrow?: string;
  /** Outline level of the section heading. Defaults to 2; card names sit one level below. */
  headingLevel?: 2 | 3;
  /**
   * Validation hook: a product whose href fails `isAllowedInternalHref` (or
   * throws) is dropped. Cards always link to the canonical `/products/<slug>`
   * (ProductCard owns its link), so a different allowed href only logs a
   * development warning.
   */
  hrefForProduct?: (product: Product) => string;
  /** Card width: 160 / 224 / 288px. Defaults to "md". */
  itemWidth?: ScrollRailItemWidth;
  /** Optional "See all" link next to the heading (must pass `isAllowedInternalHref`). */
  seeAllHref?: string;
  /** "+ Add" one-unit form on each card (`addToCart` server action). Omitted: no quick add. */
  quickAdd?: ProductCardQuickAdd;
  /**
   * Link tabs (server-rendered, work without JS). Hrefs are built by the
   * caller, e.g. `/?rail=deals#top-picks`; invalid, empty or duplicate tabs
   * are dropped with a development warning.
   */
  tabs?: readonly ProductRailTab[];
  /** Current tab id; unknown or missing falls back to the first valid tab. */
  activeId?: string;
  /** Accessible name of the tab `nav`. Defaults to `railTabsLabel(title)`. */
  tabsLabel?: string;
  /**
   * The page's single clock (read once by its loader), forwarded to every
   * compact card for the "New" badge. Omitted: no "New" badge and nothing
   * reads the clock.
   */
  now?: Date;
  /** Section id (in-page anchors, e.g. `top-picks`). Also prefixes the heading id. */
  id?: string;
  className?: string;
}

/** Default card href (the link ProductCard renders). */
export function productRailHref(product: Product): string {
  return productHref(product.slug);
}

/**
 * Accessible name of the inner scroll region. Distinct from the section name
 * so the page never exposes two regions with the same label (SR6).
 */
export function railLabel(title: string): string {
  return `${title}, product list`;
}

/** Default accessible name of the tab `nav`. */
export function railTabsLabel(title: string): string {
  return `${title}, lists`;
}

/** Shown under the tabs when the active tab has no products. */
export const PRODUCT_RAIL_EMPTY_TAB_TEXT = "Nothing to show in this list right now. Try another one.";

function devWarn(message: string): void {
  if (process.env.NODE_ENV !== "production") console.warn(`[ProductRail] ${message}`);
}

function safeHref(product: Product, hrefFor: (p: Product) => string): string | null {
  let href: string;
  try {
    href = hrefFor(product);
  } catch {
    return null;
  }
  return isAllowedInternalHref(href) ? href : null;
}

function join(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

interface RailTabsProps {
  label: string;
  tabs: readonly ProductRailTab[];
  activeId: string | null;
}

/**
 * Tabs as a `nav` list of plain links (no `role="tab"`): each one reloads the
 * page with the caller's href, so they work without JavaScript. The current
 * one has `aria-current="page"` and an underline bar (not colour alone).
 * The list scrolls horizontally inside the nav on narrow screens.
 */
function RailTabs({ label, tabs, activeId }: RailTabsProps) {
  return (
    <nav aria-label={label} className="min-w-0 overflow-x-auto overscroll-x-contain">
      <ul role="list" className="m-0 flex w-max min-w-full list-none gap-2 border-b border-border-default p-1">
        {tabs.map((tab) => {
          const current = tab.id === activeId;
          return (
            <li key={tab.id} className="shrink-0">
              <Link
                href={tab.href}
                variant="nav"
                isCurrent={current}
                scroll={false}
                className={join(
                  "-mb-px whitespace-nowrap border-b-2 px-3 text-small font-medium no-underline hover:no-underline",
                  current ? "border-accent" : "border-transparent hover:border-border-strong",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Titled horizontal rail of compact product cards (recommendations, recently
 * viewed, best sellers, the home "Top picks"). Server component.
 *
 * - No tabs and no card left: renders nothing (no empty heading).
 * - With tabs: heading, tab links, then the active tab's rail; an empty
 *   active tab keeps the tabs and shows a short text instead of the rail.
 * - Cards are `ProductCard variant="compact"`, with "+ Add" when `quickAdd`
 *   is given. Without JS the ScrollRail is a native snap scroller and the
 *   "Previous"/"Next" buttons stay hidden; with JS they appear only while
 *   there is content in that direction.
 */
export function ProductRail({
  title,
  products,
  eyebrow,
  headingLevel = 2,
  hrefForProduct = productRailHref,
  itemWidth = "md",
  seeAllHref,
  quickAdd,
  tabs,
  activeId,
  tabsLabel,
  now,
  id,
  className,
}: ProductRailProps) {
  const autoId = useId();
  const headingId = `${id ?? `product-rail-${autoId}`}-heading`;

  const seen = new Set<string>();
  const cards: Product[] = [];
  for (const product of products) {
    if (seen.has(product.id)) continue;
    const href = safeHref(product, hrefForProduct);
    if (href === null) {
      devWarn(`dropped product ${JSON.stringify(product.id)}: href is not an allowed internal link.`);
      continue;
    }
    if (href !== productRailHref(product)) {
      devWarn(`product ${JSON.stringify(product.id)}: custom href is not supported by ProductCard; using the product page.`);
    }
    seen.add(product.id);
    cards.push(product);
  }

  const tabState = validRailTabs(tabs, activeId);
  for (const reason of tabState.dropped) devWarn(`dropped ${reason}.`);
  const hasTabs = tabState.tabs.length > 0;

  if (cards.length === 0 && !hasTabs) return null;

  let seeAll: string | null = null;
  if (seeAllHref !== undefined) {
    if (isAllowedInternalHref(seeAllHref)) seeAll = seeAllHref;
    else devWarn("seeAllHref is not an allowed internal link; omitted.");
  }

  const eyebrowText = typeof eyebrow === "string" ? eyebrow.trim() : "";
  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeId);
  const scrollerName = railLabel(activeTab !== undefined ? `${title}: ${activeTab.label}` : title);
  const cardHeadingLevel = headingLevel === 2 ? 3 : 4;

  return (
    <section id={id} aria-labelledby={headingId} className={join("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-1">
          {eyebrowText !== "" ? (
            <Text variant="small" tone="secondary" data-eyebrow="" className="break-words">
              {eyebrowText}
            </Text>
          ) : null}
          <Heading level={headingLevel} size={headingLevel === 2 ? "h3" : "h4"} id={headingId} className="break-words">
            {title}
          </Heading>
        </div>
        {seeAll !== null ? (
          <Link href={seeAll} variant="inline" className="inline-flex min-h-touch items-center">
            See all<span className="sr-only">{` ${title}`}</span>
          </Link>
        ) : null}
      </div>
      {hasTabs ? (
        <RailTabs label={tabsLabel?.trim() || railTabsLabel(title)} tabs={tabState.tabs} activeId={tabState.activeId} />
      ) : null}
      {cards.length > 0 ? (
        <ScrollRail label={scrollerName} itemWidth={itemWidth} prevLabel="Previous" nextLabel="Next">
          {cards.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              variant="compact"
              headingLevel={cardHeadingLevel}
              quickAdd={quickAdd}
              now={now}
              className="h-full"
            />
          ))}
        </ScrollRail>
      ) : (
        <Text variant="small" tone="secondary" role="status">
          {PRODUCT_RAIL_EMPTY_TAB_TEXT}
        </Text>
      )}
    </section>
  );
}
