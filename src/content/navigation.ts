/**
 * Header, account and footer link maps. Every `href` is root-relative and
 * passes `isAllowedInternalHref` (asserted by the colocated tests). Render the
 * store name from `SITE_NAME` in `@/lib/seo/site`; it is not repeated here.
 */

export interface NavLink {
  readonly label: string;
  readonly href: string;
}

export interface FooterColumn {
  readonly heading: string;
  readonly links: readonly NavLink[];
}

/** Header strip below the search bar. */
export const PRIMARY_NAV: readonly NavLink[] = [
  { label: "Deals", href: "/deals" },
  { label: "Best Sellers", href: "/best-sellers" },
  { label: "New Arrivals", href: "/new-arrivals" },
  { label: "Lists", href: "/lists" },
  { label: "Orders", href: "/orders" },
  { label: "Help", href: "/help" },
];

export interface DepartmentNavLink {
  /** Department category slug; the page is `/category/<slug>`. */
  readonly slug: string;
  readonly label: string;
}

/**
 * Top-level departments in taxonomy order, for pages that must not touch the
 * database (the 404 page). Must match the taxonomy seed
 * (`SEED_DEPARTMENTS` slugs and names, same order); a test keeps them in sync.
 */
export const DEPARTMENT_NAV: readonly DepartmentNavLink[] = [
  { slug: "home-kitchen", label: "Home & Kitchen" },
  { slug: "electronics", label: "Electronics" },
  { slug: "books", label: "Books" },
  { slug: "clothing", label: "Clothing" },
  { slug: "sports-outdoors", label: "Sports & Outdoors" },
  { slug: "beauty-personal-care", label: "Beauty & Personal Care" },
  { slug: "toys-games", label: "Toys & Games" },
  { slug: "office", label: "Office" },
];

/** "Your account" hub and header account menu, in display order. */
export const ACCOUNT_NAV: readonly NavLink[] = [
  { label: "Your account", href: "/account" },
  { label: "Your orders", href: "/orders" },
  { label: "Your addresses", href: "/account/addresses" },
  { label: "Your lists", href: "/lists" },
  { label: "Browsing history", href: "/account/history" },
  { label: "Reviews and questions", href: "/account/contributions" },
  { label: "Stock alerts", href: "/account/alerts" },
  { label: "Messages", href: "/account/messages" },
  { label: "Settings", href: "/account/settings" },
];

/**
 * Header links for signed-out visitors. Signed-in visitors see `ACCOUNT_NAV`
 * instead (sign-out is a POST form, so it is not a link here).
 */
export const AUTH_NAV: readonly NavLink[] = [
  { label: "Sign in", href: "/signin" },
  { label: "Create account", href: "/signup" },
];

/** Footer top quick-links row (SiteFooter v3). Its hrefs are not repeated in `FOOTER_COLUMNS`. */
export const FOOTER_QUICK_LINKS: readonly NavLink[] = [
  { label: "Track order", href: "/orders" },
  { label: "Contact us", href: "/contact" },
];

/** Legal links; also the footer's "Legal" column. */
export const LEGAL_LINKS: readonly NavLink[] = [
  { label: "Privacy notice", href: "/privacy" },
  { label: "Terms of use", href: "/terms" },
  { label: "Accessibility", href: "/accessibility" },
];

/**
 * Footer link columns (SiteFooter v3), in display order. The footer adds a
 * fifth "Get the app" placeholder column itself. No href repeats across
 * `FOOTER_QUICK_LINKS` and these columns.
 */
export const FOOTER_COLUMNS: readonly FooterColumn[] = [
  {
    heading: "Help",
    links: [
      { label: "Help center", href: "/help" },
      { label: "FAQ", href: "/faq" },
      { label: "Payments", href: "/help/payments" },
      { label: "Your account", href: "/account" },
      ...AUTH_NAV,
      { label: "Settings", href: "/account/settings" },
    ],
  },
  {
    heading: "Orders & delivery",
    links: [
      { label: "Shipping", href: "/shipping" },
      { label: "Returns and refunds", href: "/returns" },
      { label: "Ordering help", href: "/help/ordering" },
      { label: "Your cart", href: "/cart" },
      { label: "Your lists", href: "/lists" },
    ],
  },
  {
    heading: "About",
    links: [
      { label: "About us", href: "/about" },
      { label: "All products", href: "/products" },
      { label: "Deals", href: "/deals" },
      { label: "Best Sellers", href: "/best-sellers" },
      { label: "New Arrivals", href: "/new-arrivals" },
      { label: "Top rated", href: "/top-rated" },
      { label: "Brands", href: "/brands" },
      { label: "Compare products", href: "/compare" },
    ],
  },
  { heading: "Legal", links: LEGAL_LINKS },
];
