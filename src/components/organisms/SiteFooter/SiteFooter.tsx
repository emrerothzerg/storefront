import { Icon, type IconName } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { PaymentMark } from "@/components/atoms/PaymentMark";
import { StoreBadge } from "@/components/atoms/StoreBadge";
import { Text } from "@/components/atoms/Typography";
import type { FooterColumn, NavLink } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";
import { SITE_NAME } from "@/lib/seo/site";
import {
  FOOTER_APP_HEADING,
  FOOTER_PAYMENT_HEADING,
  FOOTER_PAYMENT_LABELS,
  FOOTER_QUICK_LINKS,
  LEGAL_HEADING,
  LEGAL_LINKS,
  SITE_FOOTER_COLUMNS,
} from "./footer-links";

export type { FooterColumn } from "@/content/navigation";

export interface SiteFooterLink {
  href: string;
  label: string;
  /** Off-site link; opens in a new tab with an sr-only notice. */
  external?: boolean;
}

export interface SiteFooterProps {
  /** Wordmark and copyright name. Defaults to `SITE_NAME` ("Northwind Goods"). */
  storeName?: string;
  /**
   * Clock for the copyright year (epoch ms or Date). Read once per render;
   * defaults to `Date.now()`. The year is the UTC year of this instant.
   */
  now?: number | Date;
  /** @deprecated Explicit copyright year; wins over `now`. Prefer `now`. */
  year?: number;
  /**
   * Link columns, each rendered as its own `<nav aria-label="Footer: <heading>">`.
   * Defaults to `SITE_FOOTER_COLUMNS` (Help, Orders & delivery, About, Legal).
   * The "Get the app" placeholder column is always added after them.
   */
  columns?: readonly FooterColumn[];
  /**
   * @deprecated MVP flat links. Used only when `columns` is not given; rendered
   * as one "Links" column. External links must be absolute http(s) URLs.
   */
  links?: ReadonlyArray<SiteFooterLink>;
  /** In-page target of the "Back to top" link. Defaults to `#main`. */
  backToTopHref?: string;
}

/** Kept for the MVP API; v3 default columns live in `SITE_FOOTER_COLUMNS`. */
export const DEFAULT_FOOTER_LINKS: ReadonlyArray<SiteFooterLink> = [
  { href: "/", label: "Catalog" },
  { href: "/cart", label: "Cart" },
];

export { FOOTER_QUICK_LINKS, LEGAL_LINKS, SITE_FOOTER_COLUMNS };

export const DEFAULT_BACK_TO_TOP_HREF = "#main";

const FLAT_LINKS_HEADING = "Links";
const QUICK_LINKS_NAME = "Footer: Quick links";
const QUICK_LINK_ICONS: Readonly<Record<string, IconName>> = { "/orders": "package", "/contact": "mail" };

const FRAGMENT_HREF = /^#[A-Za-z][\w-]*$/;
const EXTERNAL_HREF = /^https?:\/\/[^\s/]+/i;

interface ResolvedColumn {
  heading: string;
  /** Unique accessible name of the column's `<nav>`. */
  name: string;
  links: SiteFooterLink[];
}

function warn(message: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`SiteFooter: ${message}`);
  }
}

function isSafeLink(link: SiteFooterLink): boolean {
  const ok = link.external === true ? EXTERNAL_HREF.test(link.href) : isAllowedInternalHref(link.href);
  if (!ok) warn(`dropped link "${link.label}" with disallowed href "${link.href}".`);
  return ok;
}

/** Keeps safe links whose href is not already rendered elsewhere in the footer. */
function keepLinks(links: ReadonlyArray<SiteFooterLink>, seen: Set<string>): SiteFooterLink[] {
  const kept: SiteFooterLink[] = [];
  for (const link of links) {
    if (!isSafeLink(link)) continue;
    if (seen.has(link.href)) {
      warn(`dropped duplicate link "${link.label}" to "${link.href}".`);
      continue;
    }
    seen.add(link.href);
    kept.push(link);
  }
  return kept;
}

function uniqueName(heading: string, names: Set<string>): string {
  const base = `Footer: ${heading}`;
  let name = base;
  for (let n = 2; names.has(name); n += 1) name = `${base} ${n}`;
  names.add(name);
  return name;
}

/** Resolves the copyright year once: explicit year, else the UTC year of `now` (or Date.now()). */
export function footerYear(now?: number | Date, year?: number): number {
  if (year !== undefined && Number.isInteger(year)) return year;
  const instant = now instanceof Date ? now.getTime() : now;
  const ms = instant !== undefined && Number.isFinite(instant) ? instant : Date.now();
  return new Date(ms).getUTCFullYear();
}

function resolveColumns(
  source: ReadonlyArray<{ heading: string; links: ReadonlyArray<SiteFooterLink> }>,
  seen: Set<string>,
): ResolvedColumn[] {
  const names = new Set<string>([QUICK_LINKS_NAME]);
  const columns: ResolvedColumn[] = [];
  for (const column of source) {
    const links = keepLinks(column.links, seen);
    if (links.length > 0) columns.push({ heading: column.heading, name: uniqueName(column.heading, names), links });
  }
  // Legal links are always reachable: append any the given columns left out.
  const missingLegal = LEGAL_LINKS.filter((l) => !seen.has(l.href));
  const legal = keepLinks(missingLegal, seen);
  if (legal.length > 0) columns.push({ heading: LEGAL_HEADING, name: uniqueName(LEGAL_HEADING, names), links: legal });
  return columns;
}

function FooterLink({ link }: { link: SiteFooterLink }) {
  return (
    <Link href={link.href} external={link.external} variant="subtle" tone="default">
      {link.label}
    </Link>
  );
}

function QuickLink({ link }: { link: NavLink }) {
  const icon = QUICK_LINK_ICONS[link.href];
  return (
    <Link href={link.href} variant="nav" tone="default" className="gap-2 font-semibold">
      {icon !== undefined ? <Icon name={icon} size="md" aria-hidden="true" /> : null}
      {link.label}
    </Link>
  );
}

/**
 * Site footer v3 (T150). Server component, light surfaces only:
 * back to top -> "Footer: Quick links" nav -> one named nav per link column
 * plus the "Get the app" placeholder column -> "Ways to pay" placeholder row
 * -> light bottom bar with the wordmark and copyright. No social links.
 */
export function SiteFooter({
  storeName = SITE_NAME,
  now,
  year: yearProp,
  columns,
  links,
  backToTopHref = DEFAULT_BACK_TO_TOP_HREF,
}: SiteFooterProps) {
  const year = footerYear(now, yearProp);

  let topHref = backToTopHref;
  if (!FRAGMENT_HREF.test(topHref)) {
    warn(`backToTopHref "${backToTopHref}" is not an in-page #id; using "${DEFAULT_BACK_TO_TOP_HREF}".`);
    topHref = DEFAULT_BACK_TO_TOP_HREF;
  }

  const seen = new Set<string>();
  const quickLinks = keepLinks(FOOTER_QUICK_LINKS, seen);
  const source =
    columns !== undefined
      ? columns
      : links !== undefined
        ? [{ heading: FLAT_LINKS_HEADING, links }]
        : SITE_FOOTER_COLUMNS;
  const visibleColumns = resolveColumns(source, seen);
  const paymentLabels = FOOTER_PAYMENT_LABELS.filter((label) => label.trim() !== "");

  return (
    <footer className="border-t border-border-default bg-surface-page text-text-primary">
      <div className="flex min-w-0 justify-center bg-surface-sunken px-4 py-2">
        <Link href={topHref} variant="subtle" tone="default" className="w-full justify-center gap-2 font-semibold">
          <Icon name="arrow-up" size="sm" aria-hidden="true" />
          Back to top
        </Link>
      </div>
      <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-8 px-4 py-8">
        {quickLinks.length > 0 ? (
          <nav aria-label={QUICK_LINKS_NAME} className="min-w-0 border-b border-border-default pb-4">
            <ul className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-2">
              {quickLinks.map((link) => (
                <li key={link.href} className="min-w-0">
                  <QuickLink link={link} />
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <div className="grid min-w-0 grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-5" data-footer-columns="">
          {visibleColumns.map((column) => (
            <nav key={column.name} aria-label={column.name} className="min-w-0">
              <h2 className="text-small font-semibold">{column.heading}</h2>
              <ul className="mt-2 flex min-w-0 flex-col">
                {column.links.map((link) => (
                  <li key={link.href} className="min-w-0">
                    <FooterLink link={link} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
          <div className="min-w-0" data-footer-app="">
            <h2 className="text-small font-semibold">{FOOTER_APP_HEADING}</h2>
            <ul className="mt-2 flex min-w-0 flex-wrap gap-2">
              <li className="min-w-0">
                <StoreBadge />
              </li>
            </ul>
          </div>
        </div>
        {paymentLabels.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-2 border-t border-border-default pt-6" data-footer-payments="">
            <h2 className="text-small font-semibold">{FOOTER_PAYMENT_HEADING}</h2>
            <ul className="flex min-w-0 flex-wrap gap-2">
              {paymentLabels.map((label) => (
                <li key={label} className="min-w-0">
                  <PaymentMark label={label} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="border-t border-border-default bg-surface-sunken" data-footer-bottom-bar="">
        <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-2 px-4 py-6 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <p className="min-w-0 text-h4 font-bold text-accent wrap-anywhere" data-footer-wordmark="">
            {storeName}
          </p>
          <div className="flex min-w-0 flex-col gap-1">
            <Text variant="small">{`© ${year} ${storeName}. All rights reserved.`}</Text>
            <Text variant="small" tone="secondary">
              This is a demo store; policies are sample text.
            </Text>
          </div>
        </div>
      </div>
    </footer>
  );
}
