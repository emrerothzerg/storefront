import { useId } from "react";
import { Link } from "@/components/atoms/Link";
import { Heading } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import {
  ServiceTiles,
  normaliseServiceTiles,
  type ServiceTileItem,
  type ServiceTilesTone,
} from "@/components/molecules/ServiceTiles";
import { isAllowedInternalHref, type PlannedRoute } from "@/content/routes";

/** Static (non-dynamic) entries of the route allow-list; defaults may only use these. */
export type StaticPlannedRoute = Exclude<PlannedRoute, `${string}[${string}`>;

/** Default tile: like `ServiceTileItem`, but the href is checked against the allow-list at compile time. */
export interface ServicesBandDefaultTile extends ServiceTileItem {
  readonly href: StaticPlannedRoute;
}

/** One-line notice under (or above) the band, e.g. the returns/refunds pointer (contract H-21). */
export interface ServicesBandNotice {
  /** Plain text before the link. Blank drops the whole notice. */
  text: string;
  /** Link text. Blank drops the link (the text stays). */
  linkLabel?: string;
  /** Internal route; must pass `isAllowedInternalHref`, else the link is dropped (dev warning). */
  href?: string;
}

export interface ServicesBandProps {
  /** Tiles (from a content module). Defaults to `SERVICES_BAND_DEFAULT_TILES`. Invalid tiles are dropped; none left renders nothing. */
  tiles?: readonly ServiceTileItem[];
  /** Section heading text. Defaults to `SERVICES_BAND_DEFAULT_HEADING`; blank falls back to it. */
  heading?: string;
  /** Heading element level. Defaults to 2. */
  headingLevel?: 2 | 3;
  /** Keep the heading for screen readers only (the reference shows no visible title). Defaults to true. */
  headingVisuallyHidden?: boolean;
  /** `undefined` = `SERVICES_BAND_DEFAULT_NOTICE`; `null` = no notice. */
  notice?: ServicesBandNotice | null;
  /** Where the notice sits relative to the tile band. Defaults to "after". */
  noticePlacement?: "before" | "after";
  /** Band background (passed to `ServiceTiles`). Defaults to "accent-subtle". */
  tone?: ServiceTilesTone;
  /** Section id, e.g. "home-services" (contract H-21). The heading id is `<id>-heading`. */
  id?: string;
  className?: string;
}

export const SERVICES_BAND_DEFAULT_HEADING = "Customer services";

/**
 * Safe default tiles. Every href is a static `PlannedRoute` (type-checked) and
 * has a page under `src/app` (asserted by the colocated test). Only services
 * that exist: no click and collect, same-day or express-pickup tiles (R10).
 */
export const SERVICES_BAND_DEFAULT_TILES: readonly ServicesBandDefaultTile[] = [
  { id: "track-order", label: "Track my order", href: "/orders", icon: "package" },
  { id: "returns", label: "Returns and refunds", href: "/returns", icon: "refresh" },
  { id: "shipping", label: "Shipping and delivery", href: "/shipping", icon: "truck" },
  { id: "help", label: "Help centre", href: "/help", icon: "info" },
  { id: "faq", label: "FAQ", href: "/faq", icon: "question-circle" },
  { id: "contact", label: "Contact us", href: "/contact", icon: "mail" },
];

export const SERVICES_BAND_DEFAULT_NOTICE: Readonly<ServicesBandNotice> & { readonly href: StaticPlannedRoute } = {
  text: "Thinking about a return or refund?",
  linkLabel: "Read our returns and refunds policy",
  href: "/returns",
};

export interface ResolvedServicesBandNotice {
  text: string;
  link: { label: string; href: string } | null;
}

/** Trims and validates a notice. Blank text gives `null`; a blank label or rejected href drops only the link. Pure apart from the dev warning. */
export function resolveServicesBandNotice(
  notice: ServicesBandNotice | null | undefined,
): ResolvedServicesBandNotice | null {
  if (notice === null || notice === undefined || typeof notice !== "object") return null;
  const text = typeof notice.text === "string" ? notice.text.trim() : "";
  if (text === "") return null;
  const label = typeof notice.linkLabel === "string" ? notice.linkLabel.trim() : "";
  if (label === "" || notice.href === undefined) return { text, link: null };
  if (typeof notice.href !== "string" || !isAllowedInternalHref(notice.href)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`ServicesBand: notice href ${JSON.stringify(notice.href)} is not an allowed internal route; dropping the link.`);
    }
    return { text, link: null };
  }
  return { text, link: { label, href: notice.href } };
}

/**
 * "Customer services" band (home reference H22/H23): a section with an `h2`
 * (visually hidden by default), the `ServiceTiles` molecule on the
 * primary-subtle band, and an optional one-line notice with a link (contract
 * H-21: returns policy). Server component; renders nothing without valid tiles.
 */
export function ServicesBand({
  tiles = SERVICES_BAND_DEFAULT_TILES,
  heading,
  headingLevel = 2,
  headingVisuallyHidden = true,
  notice,
  noticePlacement = "after",
  tone = "accent-subtle",
  id,
  className,
}: ServicesBandProps) {
  const autoId = useId();
  // Normalised once here (drops invalid tiles, warns once); the molecule receives only valid tiles.
  const valid = normaliseServiceTiles(tiles);
  if (valid.length === 0) return null;
  const items: ServiceTileItem[] = valid.map((tile) => ({
    id: tile.key,
    label: tile.label,
    href: tile.href,
    ...(tile.icon !== null ? { icon: tile.icon } : {}),
  }));

  const headingText =
    typeof heading === "string" && heading.trim() !== "" ? heading.trim() : SERVICES_BAND_DEFAULT_HEADING;
  const headingId = `${id ?? `services-band-${autoId}`}-heading`;
  const resolved = resolveServicesBandNotice(notice === undefined ? SERVICES_BAND_DEFAULT_NOTICE : notice);

  const noticeLine =
    resolved === null ? null : (
      <p className="w-full bg-surface-sunken px-4 py-2 text-center text-small text-text-primary break-words sm:px-6">
        {resolved.text}
        {resolved.link !== null ? (
          <>
            {" "}
            <Link href={resolved.link.href} variant="nav" className="font-semibold underline">
              {resolved.link.label}
            </Link>
          </>
        ) : null}
      </p>
    );

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={["flex w-full min-w-0 flex-col", className].filter(Boolean).join(" ")}
    >
      {headingVisuallyHidden ? (
        <VisuallyHidden as={headingLevel === 3 ? "h3" : "h2"} id={headingId}>
          {headingText}
        </VisuallyHidden>
      ) : (
        <Heading level={headingLevel} size={headingLevel === 2 ? "h3" : "h4"} id={headingId} className="mb-4 break-words">
          {headingText}
        </Heading>
      )}
      {noticePlacement === "before" ? noticeLine : null}
      <ServiceTiles tiles={items} tone={tone} />
      {noticePlacement === "after" ? noticeLine : null}
    </section>
  );
}
