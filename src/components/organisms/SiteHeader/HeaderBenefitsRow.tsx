import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { normaliseBenefits } from "@/components/molecules/BenefitsStrip";
import type { BenefitItem, NormalisedBenefit } from "@/components/molecules/BenefitsStrip";
import { HEADER_BENEFIT_COMPACT_IDS } from "@/content/header-benefits";

export interface HeaderBenefitsRowProps {
  readonly items: readonly BenefitItem[];
  /** Accessible name of the list, e.g. "Store benefits". */
  readonly label: string;
  /** Item ids kept below `md`. Defaults to `HEADER_BENEFIT_COMPACT_IDS` (free shipping + coupon). */
  readonly compactIds?: readonly string[];
}

export interface HeaderBenefitRowItem extends NormalisedBenefit {
  /** Shown below `md` too (otherwise from `md` only). */
  readonly compact: boolean;
}

/**
 * Normalises the strip items (same rules as `BenefitsStrip`: blank labels
 * dropped, hrefs allow-listed, unknown icons removed) and marks the ones kept
 * below `md`. When no item matches `compactIds`, the first item is kept so the
 * phone strip is never empty. Pure.
 */
export function headerBenefitRowItems(
  items: readonly BenefitItem[] | null | undefined,
  compactIds: readonly string[] = HEADER_BENEFIT_COMPACT_IDS,
): HeaderBenefitRowItem[] {
  if (!Array.isArray(items)) return [];
  const compactSet = new Set(compactIds);
  const out: HeaderBenefitRowItem[] = [];
  items.forEach((item: BenefitItem | null | undefined, index) => {
    const [benefit] = normaliseBenefits(item ? [item] : []);
    if (benefit === undefined) return;
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    out.push({ ...benefit, key: `${index}:${benefit.key.slice(2)}`, compact: id !== "" && compactSet.has(id) });
  });
  const first = out[0];
  if (first !== undefined && !out.some((b) => b.compact)) out[0] = { ...first, compact: true };
  return out;
}

// Below md: one compact wrapping row (caption text); the scroller only scrolls from md.
const SCROLLER_CLASSES = "w-full min-w-0 max-w-full md:overflow-x-auto md:overscroll-x-contain";
// From md the row matches BenefitsStrip: one line (w-max, nowrap) that scrolls
// inside its container; p-1 keeps the focus outline inside the scroller.
const LIST_CLASSES =
  "flex min-w-0 flex-wrap items-center gap-x-4 py-1 md:w-max md:min-w-full md:flex-nowrap md:gap-x-6 md:p-1 lg:justify-between lg:gap-x-8";
const COMPACT_ITEM_CLASSES = "flex min-w-0 items-center md:shrink-0";
const WIDE_ITEM_CLASSES = "hidden items-center md:flex md:shrink-0";
const CONTENT_CLASSES = "gap-2 text-caption break-words md:whitespace-nowrap md:text-small";

function BenefitContent({ benefit }: { benefit: NormalisedBenefit }) {
  return (
    <>
      {benefit.icon ? <Icon name={benefit.icon} size="md" className="shrink-0 text-accent" /> : null}
      <span className="min-w-0">{benefit.label}</span>
    </>
  );
}

/**
 * Header row 3 (U20): the benefits strip. Below `md` only the compact items
 * (free shipping and the promoted coupon) show, wrapping in one small row;
 * from `md` every item shows on one line that scrolls inside its own
 * container, like `BenefitsStrip`. Server component; all copy from props.
 */
export function HeaderBenefitsRow({ items, label, compactIds }: HeaderBenefitsRowProps) {
  const benefits = headerBenefitRowItems(items, compactIds);
  if (benefits.length === 0) return null;
  const hasLinks = benefits.some((b) => b.href !== null);
  // Without links nothing inside is focusable, so the scroller takes focus
  // (keyboard users can still scroll it from md) and carries the name.
  const scrollerA11y = hasLinks ? {} : { role: "region" as const, "aria-label": label, tabIndex: 0 };

  return (
    <div {...scrollerA11y} className={SCROLLER_CLASSES}>
      <ul role="list" aria-label={hasLinks ? label : undefined} className={LIST_CLASSES}>
        {benefits.map((benefit) => (
          <li
            key={benefit.key}
            className={benefit.compact ? COMPACT_ITEM_CLASSES : WIDE_ITEM_CLASSES}
            data-compact={benefit.compact ? "true" : undefined}
          >
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
