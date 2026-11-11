import { useId } from "react";
import { ICON_NAMES, Icon, type IconName } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Heading } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { isAllowedInternalHref } from "@/content/routes";

/** One service tile. All copy comes from the caller (content module). */
export interface ServiceTileItem {
  /** Stable key; defaults to the href. */
  id?: string;
  /** Visible tile text, rendered as plain text. Blank tiles are dropped. */
  label: string;
  /** Internal destination; must pass `isAllowedInternalHref` or the tile is dropped. */
  href: string;
  /** Decorative icon (`aria-hidden`); unknown names render no icon. */
  icon?: IconName;
}

/** Band background: `accent-subtle` (primary-subtle band, default) or `sunken` (light grey). */
export type ServiceTilesTone = "accent-subtle" | "sunken";

export interface ServiceTilesProps {
  tiles: readonly ServiceTileItem[];
  /** Optional heading text (from content), e.g. "Customer services". */
  heading?: string;
  /** Heading element level. Defaults to 2. */
  headingLevel?: 2 | 3;
  /** Keep the heading for screen readers only. Defaults to false. */
  headingVisuallyHidden?: boolean;
  /** Id of the heading (defaults to a generated id). */
  headingId?: string;
  tone?: ServiceTilesTone;
  /** Id on the band element, e.g. "home-services". */
  id?: string;
  className?: string;
}

export interface NormalisedServiceTile {
  key: string;
  label: string;
  href: string;
  icon: IconName | null;
}

const ICON_SET: ReadonlySet<string> = new Set(ICON_NAMES);

function isIconName(value: unknown): value is IconName {
  return typeof value === "string" && ICON_SET.has(value);
}

/** Returns `href` when it is an allowed internal route, else `null` (warns outside production). */
export function safeServiceHref(href: unknown): string | null {
  if (typeof href === "string" && isAllowedInternalHref(href)) return href;
  if (process.env.NODE_ENV !== "production") {
    console.warn(`ServiceTiles: href ${JSON.stringify(href)} is not an allowed internal route; dropping the tile.`);
  }
  return null;
}

/** Trims labels; drops blank tiles and tiles whose href fails the allowlist. Pure. */
export function normaliseServiceTiles(
  tiles: readonly ServiceTileItem[] | null | undefined,
): NormalisedServiceTile[] {
  if (!Array.isArray(tiles)) return [];
  const out: NormalisedServiceTile[] = [];
  tiles.forEach((tile: ServiceTileItem | null | undefined, index) => {
    if (!tile || typeof tile.label !== "string") return;
    const label = tile.label.trim();
    if (label === "") return;
    const href = safeServiceHref(tile.href);
    if (href === null) return;
    const id = typeof tile.id === "string" && tile.id.trim() !== "" ? tile.id.trim() : href;
    out.push({ key: `${index}:${id}`, label, href, icon: isIconName(tile.icon) ? tile.icon : null });
  });
  return out;
}

const TONE_CLASSES: Record<ServiceTilesTone, string> = {
  "accent-subtle": "bg-accent-subtle text-text-primary",
  sunken: "bg-surface-sunken text-text-primary",
};

/** 2 columns below 640px, 3 from 640px (`sm`), 6 from 1024px (`lg`). */
export const SERVICE_TILES_GRID_CLASSES = "grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6";

// The Link `nav` variant already gives min-h-touch / min-w-touch (44px); the
// whole white tile is the link, so the hit area is the full tile.
const TILE_LINK_CLASSES =
  "h-full w-full flex-col justify-center gap-2 rounded-lg border border-border-default bg-surface-raised p-4 text-center text-small font-medium shadow-sm transition-shadow hover:shadow-md";

/**
 * Band of icon tiles linking to customer-service pages (track order, returns,
 * shipping, help, FAQ, contact). Server component; all copy comes from props.
 */
export function ServiceTiles({
  tiles,
  heading,
  headingLevel = 2,
  headingVisuallyHidden = false,
  headingId,
  tone = "accent-subtle",
  id,
  className,
}: ServiceTilesProps) {
  const generatedId = useId();
  const items = normaliseServiceTiles(tiles);
  if (items.length === 0) return null;

  const headingText = typeof heading === "string" ? heading.trim() : "";
  const hId = headingId ?? `${generatedId}-heading`;
  const toneClass = TONE_CLASSES[tone] ?? TONE_CLASSES["accent-subtle"];
  const bandClasses = ["w-full px-4 py-8 sm:px-6 lg:py-10", toneClass, className].filter(Boolean).join(" ");

  const list = (
    <ul role="list" className={SERVICE_TILES_GRID_CLASSES}>
      {items.map((tile) => (
        <li key={tile.key} className="flex min-w-0">
          <Link href={tile.href} variant="nav" className={TILE_LINK_CLASSES}>
            {tile.icon ? (
              <span className="flex size-touch shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
                <Icon name={tile.icon} size="lg" />
              </span>
            ) : null}
            <span className="min-w-0 break-words">{tile.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );

  if (headingText === "") {
    return (
      <div id={id} className={bandClasses}>
        {list}
      </div>
    );
  }

  return (
    <section id={id} aria-labelledby={hId} className={bandClasses}>
      {headingVisuallyHidden ? (
        <VisuallyHidden as={headingLevel === 3 ? "h3" : "h2"} id={hId}>
          {headingText}
        </VisuallyHidden>
      ) : (
        <Heading level={headingLevel} size="h3" id={hId} className="mb-4">
          {headingText}
        </Heading>
      )}
      {list}
    </section>
  );
}
