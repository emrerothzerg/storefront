import { Badge } from "@/components/atoms/Badge";
import { Icon } from "@/components/atoms/Icon";
import type { IconName } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import type { BenefitItem } from "@/components/molecules/BenefitsStrip";
import { CategoryNav, buildCategoryNavModel } from "@/components/molecules/CategoryNav";
import type { CategoryNavItem, CategoryNavLeading } from "@/components/molecules/CategoryNav";
import { DepartmentMenu } from "@/components/molecules/DepartmentMenu";
import type { DepartmentInput } from "@/components/molecules/DepartmentMenu";
import { SearchBox } from "@/components/molecules/SearchBox";
import { ACCOUNT_NAV, AUTH_NAV } from "@/content/navigation";
import { ACCOUNT_LINK_HREF, AccountMenu, SIGN_IN_HREF } from "./AccountMenu";
import { HeaderBenefitsRow } from "./HeaderBenefitsRow";
import type { HeaderAccount } from "./AccountMenu";
import {
  MAX_VISIBLE_CART_COUNT,
  allowedLinks,
  cartAccessibleName,
  categorySlugFromPath,
  cleanDisplayName,
  couponPromoParts,
  isCurrentPath,
  normalizeCartCount,
  visibleCartCount,
} from "./header-model";
import type { HeaderLink, PromoCoupon } from "./header-model";

export { MAX_VISIBLE_CART_COUNT, normalizeCartCount };

/** A row-1 link (e.g. Lists). With `icon`, the label is visually hidden below `sm` (icon only, name kept). */
export interface HeaderNavLink extends HeaderLink {
  readonly icon?: IconName;
}

export interface HeaderPromo {
  /** Static message. */
  readonly message?: string;
  /** Promoted coupon, rendered as "Use code CODE for <description>" (text only). */
  readonly coupon?: PromoCoupon | null;
}

/** Row 3 of the v3 header: the benefits strip (copy from `src/content/header-benefits.ts`, built by the shell). */
export interface HeaderBenefits {
  /** Accessible name of the strip's list, e.g. "Store benefits". */
  readonly label: string;
  readonly items: readonly BenefitItem[];
}

export interface SiteHeaderProps {
  /** Number of items in the cart. Negative or non-integer values are treated as 0. */
  cartCount: number;
  /**
   * Current pathname, when the caller knows it (the root layout does not).
   * Marks matching row-1 links with `aria-current="page"`, and the CategoryNav
   * department for `/category/<slug>`.
   */
  currentPath?: string;
  /** Wordmark text, linked to `/`. Defaults to "Storefront" (MVP contract); the layout passes `SITE_NAME`. */
  storeName?: string;
  /**
   * Departments with children (`getListingService().categoryTree()`). When
   * given (even `[]`), the header shows the SearchBox and, below `md`, the
   * DepartmentMenu ("All") drawer. Omitted = no search, no drawer.
   */
  departments?: readonly DepartmentInput[];
  /** Shown in the empty SearchBox (after recent searches). */
  popularSearches?: readonly string[];
  /** Account block state. Omitted = no account block (MVP). */
  account?: HeaderAccount;
  /** Signed-in flyout links. Defaults to `ACCOUNT_NAV`. */
  accountNav?: readonly HeaderLink[];
  /** Guest flyout links. Defaults to `AUTH_NAV`. */
  authNav?: readonly HeaderLink[];
  /**
   * Row-1 links between the account block and the cart (v3 shell: Lists).
   * Defaults to the MVP `[{ label: "Catalog", href: "/" }]`. Hrefs failing
   * `isAllowedInternalHref` are dropped.
   */
  utilityLinks?: readonly HeaderNavLink[];
  /**
   * Row 2 (from `md`): CategoryNav `<nav aria-label="Primary">` with these
   * departments (v3 shell: `DEPARTMENT_NAV`). Omitted, or nothing valid = no row.
   */
  categoryNav?: readonly CategoryNavItem[];
  /**
   * Optional non-department link first in the CategoryNav row (v3 shell:
   * Deals -> `/deals`). Allow-listed; not counted toward the row's 9 links.
   */
  categoryNavLeading?: CategoryNavLeading | null;
  /** Row 3: benefits strip. Omitted, or no valid item = no row. */
  benefits?: HeaderBenefits;
  /**
   * Optional extra link row, `<nav aria-label="Shop">` (T80). The v3 shell no
   * longer passes it (the reference has no such row; the drawer and footer
   * carry these links). Allowlist-filtered; hrefs already in row 1 are skipped.
   */
  primaryNav?: readonly HeaderLink[];
  /** Optional text-only promo strip (T80). The v3 shell puts the coupon in `benefits` instead. */
  promo?: HeaderPromo;
}

export const DEFAULT_UTILITY_LINKS: readonly HeaderNavLink[] = [{ label: "Catalog", href: "/" }];

export const SKIP_LINK_LABEL = "Skip to content";

/** Accessible names of the phone-only account icon link (T148 ruling). */
export const MOBILE_SIGN_IN_LABEL = "Sign in";
export const MOBILE_ACCOUNT_LABEL = "Your account";

const CART_HREF = "/cart";

function UtilityLink({ link, currentPath }: { link: HeaderNavLink; currentPath: string | undefined }) {
  return (
    <Link
      href={link.href}
      variant="nav"
      isCurrent={isCurrentPath(link.href, currentPath)}
      className={link.icon ? "gap-1 rounded-full px-3 break-words hover:bg-surface-sunken" : "break-words"}
    >
      {link.icon ? (
        <>
          <Icon name={link.icon} size="md" />
          <span className="sr-only sm:not-sr-only">{link.label}</span>
        </>
      ) : (
        link.label
      )}
    </Link>
  );
}

/**
 * Site header (T17, v2 T80, v3 T148). Presentational and server-safe: the
 * `src/app/_layout/HeaderShell` server component reads the session, user,
 * cart count, departments, shipping threshold and promoted coupon and passes
 * them in. Interactive parts are client molecules (DepartmentMenu, SearchBox)
 * and the AccountMenu flyout; all of them render useful links/forms in the
 * server HTML, so the header works without JavaScript.
 *
 * Structure: skip link (first focusable, before the banner) -> `<header>`:
 * - row 1: wordmark link (`/`), pill SearchBox (landmark "Site search"; full
 *   width on its own line below `md`; no department select), a list with the
 *   account block, utility links, a phone-only account icon link and the cart, then the "All" DepartmentMenu (below `md` only; its
 *   drawer holds `<nav aria-label="Departments">`). Below `md` the account
 *   block and utility links are hidden (the drawer lists them), so row 1 is
 *   wordmark, cart, menu button and row 2 is the search;
 * - CategoryNav row (from `md`), `<nav aria-label="Primary">`;
 * - optional legacy Shop row / promo strip;
 * - benefits strip (HeaderBenefitsRow): below `md` only the free-shipping and
 *   coupon items, wrapping; from `md` every item on one line that scrolls
 *   inside its own container.
 * Sticky (U02): the MVP header is `sticky top-0`. The extended header is
 * static below `lg`; from `lg` the `<header>` box is `display: contents` so
 * only row 1 (wordmark, search, account, cart) sticks to the viewport while
 * the category row and benefits strip scroll away. The landmark and DOM
 * order are unchanged.
 * Every rendered href passes `isAllowedInternalHref`.
 */
export function SiteHeader({
  cartCount,
  currentPath,
  storeName = "Storefront",
  departments,
  popularSearches,
  account,
  accountNav = ACCOUNT_NAV,
  authNav = AUTH_NAV,
  utilityLinks = DEFAULT_UTILITY_LINKS,
  categoryNav,
  categoryNavLeading,
  benefits,
  primaryNav,
  promo,
}: SiteHeaderProps) {
  const count = normalizeCartCount(cartCount);
  const utilities = allowedLinks(utilityLinks);
  const rowOneHrefs = new Set([...utilities.map((l) => l.href), CART_HREF]);
  const shopLinks = allowedLinks(primaryNav).filter((l) => !rowOneHrefs.has(l.href));
  const hasDrawer = departments !== undefined;
  const extended =
    hasDrawer ||
    account !== undefined ||
    primaryNav !== undefined ||
    promo !== undefined ||
    categoryNav !== undefined ||
    benefits !== undefined;
  const signedInName = account?.status === "signed-in" ? cleanDisplayName(account.displayName) : null;
  const couponParts = couponPromoParts(promo?.coupon);
  const promoMessage = typeof promo?.message === "string" ? promo.message.trim() : "";
  const showPromo = promoMessage !== "" || couponParts !== null;
  const currentSlug = categorySlugFromPath(currentPath);
  const showCategoryNav =
    categoryNav !== undefined &&
    (() => {
      const model = buildCategoryNavModel({ departments: categoryNav, leading: categoryNavLeading });
      return model.visible.length > 0 || model.leading !== null;
    })();
  // Same "has a non-blank label" rule as BenefitsStrip (which validates hrefs and warns once itself).
  const showBenefits =
    benefits !== undefined &&
    Array.isArray(benefits.items) &&
    benefits.items.some((item) => typeof item?.label === "string" && item.label.trim() !== "");
  // With the drawer present, row-1 extras move into it below md (row 1 = wordmark, cart, menu).
  const desktopOnly = hasDrawer ? "hidden md:block" : "";

  // MVP header: the whole (one-row) header sticks. Extended header: static
  // below lg; from lg the <header> box dissolves (`lg:contents`) so row 1
  // can stick to the viewport on its own and rows 2+ scroll away (U02).
  const headerClasses = extended
    ? "z-sticky border-b border-border-default bg-surface-page lg:contents"
    : "sticky top-0 z-sticky border-b border-border-default bg-surface-page";
  // With `lg:contents` the header border is gone from lg: row 1 draws the
  // separator under itself (it stays visible while stuck), the first lower
  // row drops its top border and the last lower row draws the bottom border.
  const lowerRows = [
    showCategoryNav ? "category" : null,
    shopLinks.length > 0 ? "shop" : null,
    showPromo ? "promo" : null,
    showBenefits ? "benefits" : null,
  ].filter((row): row is string => row !== null);
  const rowEdges = (row: string): string =>
    extended
      ? [
          lowerRows[0] === row ? "lg:border-t-0" : "",
          lowerRows[lowerRows.length - 1] === row ? "lg:border-b lg:border-border-default" : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";
  const rowOneSticky = extended
    ? " bg-surface-page lg:sticky lg:top-0 lg:z-sticky lg:border-b lg:border-border-default"
    : "";
  const withEdges = (base: string, row: string): string => [base, rowEdges(row)].filter(Boolean).join(" ");

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-toast focus:inline-flex focus:min-h-touch focus:items-center focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-text-primary focus:shadow-md"
      >
        {SKIP_LINK_LABEL}
      </a>
      <header className={headerClasses}>
        <div className={`relative flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2${rowOneSticky}`}>
          <Link
            href="/"
            variant="nav"
            className={
              hasDrawer
                ? // v3 (U08): one line; smaller below sm so "Northwind Goods" fits at 320-390px.
                  "min-w-0 flex-1 text-body font-bold whitespace-nowrap sm:text-h4 md:flex-none"
                : // MVP header: a long caller-supplied name wraps instead of overflowing.
                  "min-w-0 flex-1 text-h4 font-bold break-words md:flex-none"
            }
            data-testid="header-wordmark"
          >
            <span className="text-accent">{storeName}</span>
          </Link>
          {hasDrawer ? (
            <div
              className="order-last min-w-0 basis-full md:order-none md:basis-0 md:grow"
              data-testid="header-search"
            >
              {/* No department select in the header (T143 ruling): `departments` is not passed. */}
              <SearchBox popularSearches={popularSearches} />
            </div>
          ) : null}
          <ul role="list" className="flex min-w-0 flex-wrap items-center gap-2 md:gap-4" data-testid="header-actions">
            {account !== undefined ? (
              <li className={`min-w-0 ${desktopOnly}`.trim()}>
                <AccountMenu account={account} accountNav={allowedLinks(accountNav)} authNav={allowedLinks(authNav)} />
              </li>
            ) : null}
            {utilities.map((link) => (
              <li key={link.href} className={desktopOnly || undefined}>
                <UtilityLink link={link} currentPath={currentPath} />
              </li>
            ))}
            {account !== undefined && hasDrawer ? (
              // Phones: the account menu is hidden, so this 44px icon link keeps
              // Sign in / Your account reachable from the header without JS.
              <li className="md:hidden" data-testid="header-mobile-account">
                <Link
                  href={account.status === "signed-in" ? ACCOUNT_LINK_HREF : SIGN_IN_HREF}
                  variant="nav"
                  className="justify-center rounded-full hover:bg-surface-sunken"
                >
                  <Icon name="user" size="md" />
                  <span className="sr-only">
                    {account.status === "signed-in" ? MOBILE_ACCOUNT_LABEL : MOBILE_SIGN_IN_LABEL}
                  </span>
                </Link>
              </li>
            ) : null}
            <li>
              <Link
                href={CART_HREF}
                variant="nav"
                isCurrent={isCurrentPath(CART_HREF, currentPath)}
                className="gap-2 rounded-full px-2 hover:bg-surface-sunken"
              >
                {/* One sr-only text node gives an exact name ("Cart, 3 items") in
                    every engine; the icon, visible label and capped badge are hidden. */}
                <span className="sr-only">{cartAccessibleName(count)}</span>
                <Icon name="cart" size="md" />
                <span aria-hidden="true" className={hasDrawer ? "hidden sm:inline" : undefined}>
                  Cart
                </span>
                <Badge tone="neutral" aria-hidden="true" data-testid="cart-count">
                  {visibleCartCount(count)}
                </Badge>
              </Link>
            </li>
          </ul>
          {hasDrawer ? (
            <div className="md:hidden" data-testid="header-menu">
              <DepartmentMenu
                departments={departments}
                accountNav={accountNav}
                authNav={authNav}
                signedInName={signedInName}
              />
            </div>
          ) : null}
        </div>
        {showCategoryNav ? (
          <div
            className={withEdges("hidden min-w-0 border-t border-border-default px-4 md:block", "category")}
            data-testid="header-category-row"
          >
            <CategoryNav departments={categoryNav} currentSlug={currentSlug} leading={categoryNavLeading} />
          </div>
        ) : null}
        {shopLinks.length > 0 ? (
          <nav aria-label="Shop" className={withEdges("min-w-0 border-t border-border-default", "shop")}>
            <ul className="flex min-w-0 flex-wrap items-center gap-x-4 px-4">
              {shopLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    variant="nav"
                    isCurrent={isCurrentPath(link.href, currentPath)}
                    className="text-small break-words"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        {showPromo ? (
          <div
            className={withEdges("border-t border-border-default bg-surface-sunken px-4 py-2", "promo")}
            data-testid="promo-strip"
          >
            <p className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-small text-text-primary break-words">
              {promoMessage !== "" ? <span>{promoMessage}</span> : null}
              {couponParts !== null ? (
                <span>
                  Use code <strong className="font-semibold">{couponParts.code}</strong>
                  {couponParts.tail}
                </span>
              ) : null}
            </p>
          </div>
        ) : null}
        {showBenefits ? (
          <div
            className={withEdges("min-w-0 border-t border-border-default bg-surface-sunken px-4", "benefits")}
            data-testid="header-benefits"
          >
            <HeaderBenefitsRow items={benefits.items} label={benefits.label} />
          </div>
        ) : null}
      </header>
    </>
  );
}
