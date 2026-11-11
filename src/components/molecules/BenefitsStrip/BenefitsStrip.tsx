import { ICON_NAMES, Icon, type IconName } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { isAllowedInternalHref } from "@/content/routes";

/** One benefit in the strip. All copy comes from the caller (content module). */
export interface BenefitItem {
  /** Stable key; defaults to the label. */
  id?: string;
  /** Short visible text, rendered as plain text (never HTML). Blank items are dropped. */
  label: string;
  /** Decorative icon (`aria-hidden`); unknown names render no icon. */
  icon?: IconName;
  /**
   * Optional internal destination. It must pass `isAllowedInternalHref`;
   * otherwise the item renders as text without a link (and warns outside
   * production). Links are optional on the strip.
   */
  href?: string | null;
}

export interface BenefitsStripProps {
  items: readonly BenefitItem[];
  /** Accessible name of the list, e.g. "Store benefits" (from content, not hardcoded here). */
  label: string;
  className?: string;
}

export interface NormalisedBenefit {
  key: string;
  label: string;
  icon: IconName | null;
  href: string | null;
}

const ICON_SET: ReadonlySet<string> = new Set(ICON_NAMES);

function isIconName(value: unknown): value is IconName {
  return typeof value === "string" && ICON_SET.has(value);
}

/**
 * Returns `href` when it is an allowed internal route, else `null`. Rejected
 * hrefs warn outside production so the bad caller is easy to find.
 */
export function safeBenefitHref(href: string | null | undefined, component = "BenefitsStrip"): string | null {
  if (href === null || href === undefined || href === "") return null;
  if (isAllowedInternalHref(href)) return href;
  if (process.env.NODE_ENV !== "production") {
    console.warn(`${component}: href ${JSON.stringify(href)} is not an allowed internal route; rendering the item without a link.`);
  }
  return null;
}

/** Trims labels, drops blank items, validates hrefs and icons. Pure. */
export function normaliseBenefits(items: readonly BenefitItem[] | null | undefined): NormalisedBenefit[] {
  if (!Array.isArray(items)) return [];
  const out: NormalisedBenefit[] = [];
  items.forEach((item: BenefitItem | null | undefined, index) => {
    if (!item || typeof item.label !== "string") return;
    const label = item.label.trim();
    if (label === "") return;
    const id = typeof item.id === "string" && item.id.trim() !== "" ? item.id.trim() : label;
    out.push({
      key: `${index}:${id}`,
      label,
      icon: isIconName(item.icon) ? item.icon : null,
      href: safeBenefitHref(item.href),
    });
  });
  return out;
}

const SCROLLER_CLASSES = "w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain";
// w-max keeps every item on one line (no wrapping at any width); min-w-full lets
// lg:justify-between spread 3-4 items across the row. p-1 (4px) leaves room
// for the 2px focus outline + 2px offset inside the scroll container, so focus
// is never clipped.
const LIST_CLASSES =
  "flex w-max min-w-full flex-nowrap items-center gap-x-6 p-1 lg:justify-between lg:gap-x-8";
const ITEM_CLASSES = "flex shrink-0 items-center";
const CONTENT_CLASSES = "gap-2 whitespace-nowrap text-small";

function BenefitContent({ benefit }: { benefit: NormalisedBenefit }) {
  return (
    <>
      {benefit.icon ? <Icon name={benefit.icon} size="md" className="shrink-0 text-accent" /> : null}
      <span>{benefit.label}</span>
    </>
  );
}

/**
 * Single-row strip of 3-4 icon + text benefits (under the category nav).
 * Never wraps: at narrow widths the row scrolls horizontally inside its own
 * container (no page overflow). Server component; all copy comes from props.
 */
export function BenefitsStrip({ items, label, className }: BenefitsStripProps) {
  const benefits = normaliseBenefits(items);
  if (benefits.length === 0) return null;
  const hasLinks = benefits.some((b) => b.href !== null);
  // Without links nothing inside is focusable, so the scroll container itself
  // takes focus (keyboard users can still scroll it) and carries the name.
  const scrollerA11y = hasLinks
    ? {}
    : { role: "region" as const, "aria-label": label, tabIndex: 0 };

  return (
    <div {...scrollerA11y} className={[SCROLLER_CLASSES, className].filter(Boolean).join(" ")}>
      <ul role="list" aria-label={hasLinks ? label : undefined} className={LIST_CLASSES}>
        {benefits.map((benefit) => (
          <li key={benefit.key} className={ITEM_CLASSES}>
            {benefit.href ? (
              <Link href={benefit.href} variant="nav" className={CONTENT_CLASSES}>
                <BenefitContent benefit={benefit} />
              </Link>
            ) : (
              <span className={`inline-flex min-h-touch items-center text-text-primary ${CONTENT_CLASSES}`}>
                <BenefitContent benefit={benefit} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
