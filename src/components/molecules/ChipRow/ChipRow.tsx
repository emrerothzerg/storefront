import { useId } from "react";
import { Chip } from "@/components/atoms/Chip";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { isAllowedInternalHref } from "@/content/routes";
import { CHIP_ROW_MAX_ITEMS, chipLabel, resolveChips, type ChipRowItem } from "./chip-row-helpers";

export type ChipRowLayout = "scroll" | "wrap";
export type ChipRowSearchIcon = "leading" | "trailing";

export interface ChipRowMoreLink {
  /** Allow-listed internal route; the arrow is omitted otherwise. */
  readonly href: string;
  /** Accessible name of the round arrow link, e.g. "More popular searches". */
  readonly label: string;
}

export interface ChipRowProps {
  /** Accessible name of the `<nav>` (e.g. "Popular searches", "Related searches"). Required and unique on the page. */
  label: string;
  /** Search chips (`{ query }`) and/or link chips (`{ label, href }`). Nothing renders when none survive validation. */
  items: ReadonlyArray<ChipRowItem>;
  /** Shows `label` as visible text above the chips (not a heading) and names the nav by it. Default false. */
  showLabel?: boolean;
  /** Decorative search icon on every chip. Default: none. */
  searchIcon?: ChipRowSearchIcon;
  /** Trailing round arrow link after the chips (e.g. to the full search page). */
  more?: ChipRowMoreLink;
  /** `scroll` (default): one row scrolling inside its own container. `wrap`: chips wrap onto new lines. */
  layout?: ChipRowLayout;
  /** At most this many chips (default 12). */
  maxItems?: number;
  id?: string;
  className?: string;
}

function join(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Labelled row of link chips ("Everyone's looking for", "Related searches").
 * Server component, works without JS: `<nav>` + `<ul>` of `Chip as="a"`
 * links. Labels are cleaned, trimmed and cut at 40 characters (full text in
 * `title` and the accessible name); search hrefs are `/search?q=` +
 * `encodeURIComponent` of the query cut at 100; every href must pass the
 * route allow-list. Adds no headings (CONTRACTS L-5).
 */
export function ChipRow({
  label,
  items,
  showLabel = false,
  searchIcon,
  more,
  layout = "scroll",
  maxItems = CHIP_ROW_MAX_ITEMS,
  id,
  className,
}: ChipRowProps) {
  const labelId = useId();
  const chips = resolveChips(items, maxItems);
  if (chips.length === 0) return null;

  const name = chipLabel(label, 80)?.full ?? "Searches";
  const moreName = more ? chipLabel(more.label, 80) : null;
  const showMore = more !== undefined && moreName !== null && isAllowedInternalHref(more.href);
  const icon = <Icon name="search" size="sm" />;
  const scroll = layout === "scroll";

  return (
    <nav
      id={id}
      aria-label={showLabel ? undefined : name}
      aria-labelledby={showLabel ? labelId : undefined}
      className={join("min-w-0 max-w-full", className)}
    >
      {showLabel ? (
        <Text as="p" id={labelId} className="mb-2 font-semibold">
          {name}
        </Text>
      ) : null}
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <ul
          className={join(
            "flex min-w-0 flex-1 gap-2 p-1",
            scroll ? "flex-nowrap overflow-x-auto" : "flex-wrap",
          )}
        >
          {chips.map((chip) => (
            <li
              key={chip.href}
              title={chip.label.truncated ? chip.label.full : undefined}
              className={scroll ? "shrink-0" : "min-w-0 max-w-full"}
            >
              <Chip
                as="a"
                href={chip.href}
                label={chip.label.text}
                variant="filled"
                aria-label={chip.label.truncated ? chip.label.full : undefined}
                leading={searchIcon === "leading" ? icon : undefined}
                trailingIcon={searchIcon === "trailing" ? "search" : undefined}
                className={scroll ? "whitespace-nowrap" : "max-w-full wrap-anywhere"}
              />
            </li>
          ))}
        </ul>
        {showMore ? (
          <Link
            href={more.href}
            variant="button"
            buttonSize="sm"
            title={moreName.full}
            className="shrink-0"
          >
            <Icon name="arrow-right" size="sm" />
            <VisuallyHidden>{moreName.full}</VisuallyHidden>
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
