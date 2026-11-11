import { useId } from "react";
import { Card } from "@/components/atoms/Card";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import {
  PromoStrip,
  cleanPromoText,
  normalisePromoCta,
  normalisePromoHeadingLevel,
  promoToneStyle,
  type PromoCta,
  type PromoHeadingLevel,
  type PromoImage,
  type PromoStripImagePosition,
  type PromoTone,
} from "@/components/molecules/PromoStrip";
import { isAllowedInternalHref } from "@/content/routes";
import { cleanText, formatIsoDate, tryFormatMoney } from "../HomeHero/home-format";

/**
 * Promoted coupon. `ValidatedCoupon` from `couponService.listPromoted()`
 * (code, description) fits structurally; `minSubtotalCents` / `endsAt` are
 * optional extras shown as conditions when present and valid.
 */
export interface PromoBannerCoupon {
  code: string;
  description: string;
  minSubtotalCents?: number | null;
  /** ISO 8601; "Ends <date>" only when valid (`parseIsoDate`). */
  endsAt?: string | null;
  /** ISO 4217 for the minimum; defaults to "USD". */
  currency?: string;
}

/**
 * Content for the general banner mode (delivery promo, split lifestyle
 * banner, sign-up / "never miss a deal" strips, promo pair cards). All copy
 * comes from the home content module; nothing is hard-coded here.
 */
export interface PromoBannerContent {
  /** Headline (plain text). Blank → the banner is omitted. */
  heading: string;
  /** Supporting line (plain text). */
  blurb?: string;
  /** Required: a banner whose CTA fails `isAllowedInternalHref` is omitted (contract H-order 6). */
  cta: PromoCta;
  /** Optional art (`home-art.ts` entries fit as is; decorative by default). */
  image?: PromoImage | null;
  /** "start" = image on the left from md (split banner); default "end". */
  imagePosition?: PromoStripImagePosition;
  /** Token-backed tone; unknown → `neutral`. Defaults to `primary-subtle`. */
  tone?: PromoTone;
}

interface PromoBannerSharedProps {
  /** Root id (e.g. "home-shipping-promo"); the heading id is derived from it in coupon mode. */
  id?: string;
  className?: string;
}

/** Coupon mode (Phase 2 behaviour): code in `<code>`, conditions, "Go to cart". */
export interface PromoBannerCouponProps extends PromoBannerSharedProps {
  coupon: PromoBannerCoupon | null | undefined;
  promo?: never;
  /** Defaults to "/cart"; a disallowed href falls back to "/cart" (dev warning). */
  cartHref?: string;
  /** Defaults to "Coupon of the week". */
  title?: string;
  headingLevel?: 2 | 3;
  /** Token-backed tone; unknown → `neutral`. Defaults to `primary-subtle` (the Phase 2 tint). */
  tone?: PromoTone;
  priority?: never;
}

/** Banner mode: a `PromoStrip` driven by content props. */
export interface PromoBannerStripProps extends PromoBannerSharedProps {
  promo: PromoBannerContent | null | undefined;
  coupon?: never;
  cartHref?: never;
  title?: never;
  /** 2 (default), 3 or 4; never 1. */
  headingLevel?: PromoHeadingLevel;
  tone?: never;
  /** Eager-load the image (only above the fold). */
  priority?: boolean;
}

export type PromoBannerProps = PromoBannerCouponProps | PromoBannerStripProps;

export const PROMO_BANNER_DEFAULT_TITLE = "Coupon of the week";
const DEFAULT_CART_HREF = "/cart";
const DEFAULT_TONE: PromoTone = "primary-subtle";

/** Same charset/length as the coupon service's `normalizeCouponCode` (1-32 `[A-Za-z0-9_-]`, upper-cased). */
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Upper-cased code, or null when blank or outside the coupon charset. */
export function normalisePromoCode(code: unknown): string | null {
  const trimmed = cleanText(code);
  return CODE_PATTERN.test(trimmed) ? trimmed.toUpperCase() : null;
}

/** Visible condition lines ("Minimum order $25.00", "Ends Nov 30, 2026"). */
export function promoConditions(coupon: PromoBannerCoupon): {
  minimum: string | null;
  ends: { iso: string; label: string } | null;
} {
  const min = coupon.minSubtotalCents;
  const minimumText =
    typeof min === "number" && min > 0 ? tryFormatMoney(min, cleanText(coupon.currency) || "USD") : null;
  return {
    minimum: minimumText === null ? null : `Minimum order ${minimumText}`,
    ends: formatIsoDate(coupon.endsAt),
  };
}

export interface NormalisedPromoBannerContent {
  heading: string;
  blurb: string;
  cta: PromoCta;
  image: PromoImage | null;
  imagePosition: PromoStripImagePosition;
  tone: PromoTone;
}

/**
 * Valid banner content or `null` (missing, non-object, blank heading, or a
 * CTA that is missing / blank / not an allowed internal href). Never throws.
 */
export function normalisePromoBannerContent(
  promo: PromoBannerContent | null | undefined,
  component = "PromoBanner",
): NormalisedPromoBannerContent | null {
  if (promo === null || promo === undefined || typeof promo !== "object") return null;
  const heading = cleanPromoText(promo.heading);
  if (heading === "") return null;
  const cta = normalisePromoCta(promo.cta, component);
  if (cta === null) return null;
  return {
    heading,
    blurb: cleanPromoText(promo.blurb),
    cta,
    image: promo.image ?? null,
    imagePosition: promo.imagePosition === "start" ? "start" : "end",
    tone: promo.tone ?? DEFAULT_TONE,
  };
}

function cleanId(id: unknown): string | undefined {
  const value = cleanText(id);
  return value === "" ? undefined : value;
}

/**
 * Promo banner organism (Phase 3, T154). Two modes, both server-safe:
 *
 * - **Coupon** (`coupon`): the Phase 2 promoted-coupon banner on the
 *   PromoStrip surface (`Card radius="xl"`, promo tone styles): an
 *   `<aside aria-labelledby>` with the code in `<code>`, description,
 *   conditions (minimum order, end date) and a "Go to cart" link. No
 *   stretched link, so the code stays selectable. Null when the coupon is
 *   missing or its code is blank/invalid.
 * - **Banner** (`promo`): a `PromoStrip` (delivery promo, split lifestyle
 *   banner, sign-up strip). Null when the heading is blank or the CTA is not
 *   an allowed internal href.
 */
export function PromoBanner(props: PromoBannerProps) {
  if (isBannerModeProps(props)) {
    const { promo, headingLevel, id, priority, className } = props;
    return <BannerMode promo={promo} headingLevel={headingLevel} id={id} priority={priority} className={className} />;
  }
  return <CouponMode {...props} />;
}

/** Banner mode when a `promo` prop is passed (even null/undefined); coupon mode otherwise. */
function isBannerModeProps(props: PromoBannerProps): props is PromoBannerStripProps {
  return Object.hasOwn(props, "promo");
}

function BannerMode({ promo, headingLevel = 2, id, priority = false, className }: PromoBannerStripProps) {
  const content = normalisePromoBannerContent(promo);
  if (content === null) return null;
  return (
    <PromoStrip
      heading={content.heading}
      blurb={content.blurb === "" ? undefined : content.blurb}
      cta={content.cta}
      image={content.image}
      imagePosition={content.imagePosition}
      tone={content.tone}
      headingLevel={normalisePromoHeadingLevel(headingLevel)}
      id={cleanId(id)}
      priority={priority}
      className={className}
    />
  );
}

function CouponMode({
  coupon,
  cartHref = DEFAULT_CART_HREF,
  title = PROMO_BANNER_DEFAULT_TITLE,
  headingLevel = 2,
  tone = DEFAULT_TONE,
  id,
  className,
}: PromoBannerCouponProps) {
  const autoId = useId();
  if (coupon === null || coupon === undefined || typeof coupon !== "object") return null;
  const code = normalisePromoCode(coupon.code);
  if (code === null) return null;

  const style = promoToneStyle(tone);
  const description = cleanText(coupon.description);
  const { minimum, ends } = promoConditions(coupon);
  const heading = cleanText(title) === "" ? PROMO_BANNER_DEFAULT_TITLE : cleanText(title);
  const rootId = cleanId(id);
  const headingId = `${rootId ?? `promo-banner-${autoId}`}-heading`;
  const level = headingLevel === 3 ? 3 : 2;
  let href = DEFAULT_CART_HREF;
  if (isAllowedInternalHref(cartHref)) href = cartHref;
  else if (process.env.NODE_ENV !== "production") {
    console.warn(`[PromoBanner] cartHref is not an allowed internal link; using "${DEFAULT_CART_HREF}".`);
  }

  return (
    <Card
      as="aside"
      id={rootId}
      aria-labelledby={headingId}
      tone={style.card}
      radius="xl"
      padding="lg"
      className={[
        "flex w-full flex-col gap-4 md:flex-row md:items-center md:justify-between",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-promo-tone={style.card}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <Heading level={level} size={level === 2 ? "h2" : "h3"} tone={style.heading} id={headingId} className="break-words">
          {heading}
        </Heading>
        <p className="flex min-w-0 items-center gap-2 text-body">
          <Icon name="tag" size="sm" />
          <span className="min-w-0">
            Use code{" "}
            <code className="rounded-md border border-border-strong bg-surface-raised px-2 py-0.5 font-mono font-semibold break-all text-text-primary">
              {code}
            </code>{" "}
            at checkout
          </span>
        </p>
        {description !== "" ? (
          <Text tone={style.text} className="max-w-prose break-words">
            {description}
          </Text>
        ) : null}
        {minimum !== null || ends !== null ? (
          <ul role="list" className="flex flex-wrap gap-x-4 gap-y-1 text-small">
            {minimum !== null ? <li>{minimum}</li> : null}
            {ends !== null ? (
              <li>
                Ends <time dateTime={ends.iso}>{ends.label}</time>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      <Link
        href={href}
        variant="button"
        buttonVariant={style.cta}
        className="max-w-full shrink-0 self-start text-center md:self-center"
      >
        Go to cart<span className="sr-only">{` to use code ${code}`}</span>
      </Link>
    </Card>
  );
}

/** Number of cards in the promo pair (contract H-19). */
export const PROMO_PAIR_SIZE = 2;
export const PROMO_PAIR_DEFAULT_HEADING = "More to explore";

export interface PromoBannerPairProps {
  /** Candidate promos; invalid ones are dropped and the first two valid ones render. */
  promos: readonly PromoBannerContent[] | null | undefined;
  /** Section heading (an `h2`); visually hidden unless `showHeading`. Defaults to "More to explore". */
  heading?: string;
  showHeading?: boolean;
  /** Section id, e.g. "home-promo-pair". */
  id?: string;
  className?: string;
}

/** The first `PROMO_PAIR_SIZE` valid promos, or `[]` when fewer are valid. */
export function promoPairItems(promos: unknown): NormalisedPromoBannerContent[] {
  if (!Array.isArray(promos)) return [];
  const valid: NormalisedPromoBannerContent[] = [];
  for (const promo of promos as unknown[]) {
    const content = normalisePromoBannerContent(promo as PromoBannerContent | null, "PromoBannerPair");
    if (content !== null) valid.push(content);
    if (valid.length === PROMO_PAIR_SIZE) break;
  }
  return valid.length === PROMO_PAIR_SIZE ? valid : [];
}

/**
 * Two promo strips side by side from `lg` (stacked below), reference H20:
 * `<section aria-labelledby>` with an `h2` (visually hidden by default) and a
 * list of two `PromoStrip`s (`h3`). Omitted when fewer than two promos are
 * valid. Server component.
 */
export function PromoBannerPair({
  promos,
  heading = PROMO_PAIR_DEFAULT_HEADING,
  showHeading = false,
  id,
  className,
}: PromoBannerPairProps) {
  const autoId = useId();
  const items = promoPairItems(promos);
  if (items.length === 0) return null;
  const rootId = cleanId(id);
  const headingId = `${rootId ?? `promo-pair-${autoId}`}-heading`;
  const title = cleanText(heading) === "" ? PROMO_PAIR_DEFAULT_HEADING : cleanText(heading);

  return (
    <section
      id={rootId}
      aria-labelledby={headingId}
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <Heading level={2} size="h3" id={headingId} className={showHeading ? "break-words" : "sr-only"}>
        {title}
      </Heading>
      <ul role="list" className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        {items.map((item, index) => (
          <li key={`${index}-${item.cta.href}`} className="flex min-w-0">
            <PromoStrip
              heading={item.heading}
              blurb={item.blurb === "" ? undefined : item.blurb}
              cta={item.cta}
              image={item.image}
              imagePosition={item.imagePosition}
              tone={item.tone}
              headingLevel={3}
              className="h-full"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
