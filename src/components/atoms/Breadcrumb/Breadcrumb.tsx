"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../Icon";
import { Link } from "../Link";

export interface BreadcrumbItem {
  label: string;
  /** Omit for the current page (the last item is always the current page). */
  href?: string;
}

export interface BreadcrumbProps extends Omit<ComponentPropsWithRef<"nav">, "children"> {
  /** Ordered from the root (e.g. Home) to the current page. */
  items: BreadcrumbItem[];
  /**
   * When there are more items than this, the middle ones collapse behind an
   * ellipsis button (first item + last `maxItems - 1` stay visible). Applies
   * only after hydration: server HTML and no-JS users always get every item.
   * Values below 2 are treated as 2. Omit to never collapse.
   */
  maxItems?: number;
  /** Landmark name. Defaults to "Breadcrumb". */
  label?: string;
}

const subscribe = () => () => {};

/** false during SSR and hydration, true afterwards. */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

const linkClasses = "min-w-0 text-small";

/**
 * Breadcrumb trail: `<nav aria-label="Breadcrumb">` + `<ol>`; the last item
 * has `aria-current="page"`; chevron separators are decorative. Pair with the
 * BreadcrumbList JSON-LD on the page.
 */
export function Breadcrumb({
  items,
  maxItems,
  label = "Breadcrumb",
  className,
  ref,
  ...rest
}: BreadcrumbProps) {
  const hydrated = useIsHydrated();
  const [expanded, setExpanded] = useState(false);
  const firstRevealedRef = useRef<HTMLLIElement | null>(null);
  const focusAfterExpand = useRef(false);

  const limit = maxItems === undefined ? undefined : Math.max(2, Math.floor(maxItems));
  const collapsible = limit !== undefined && items.length > limit;
  const collapsed = hydrated && collapsible && !expanded;
  // Items hidden while collapsed: indices [1, hiddenEnd).
  const hiddenEnd = limit !== undefined ? items.length - (limit - 1) : 1;

  useEffect(() => {
    if (expanded && focusAfterExpand.current) {
      focusAfterExpand.current = false;
      // Links, or the tabIndex=-1 spans for href-less items, so focus never drops to <body>.
      firstRevealedRef.current?.querySelector<HTMLElement>("a, [tabindex]")?.focus();
    }
  }, [expanded]);

  const lastIndex = items.length - 1;

  return (
    <nav
      {...rest}
      ref={ref}
      aria-label={label}
      className={["text-small", className].filter(Boolean).join(" ")}
    >
      <ol className="flex flex-wrap items-center gap-x-1">
        {items.map((item, index) => {
          if (collapsed && index >= 1 && index < hiddenEnd) {
            if (index !== 1) return null;
            const hiddenCount = hiddenEnd - 1;
            return (
              <li key="ellipsis" className="flex items-center gap-1">
                <Separator />
                <button
                  type="button"
                  aria-expanded={false}
                  aria-label={`Show ${hiddenCount} more breadcrumb ${hiddenCount === 1 ? "level" : "levels"}`}
                  onClick={() => {
                    focusAfterExpand.current = true;
                    setExpanded(true);
                  }}
                  className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-secondary hover:bg-surface-sunken hover:text-text-primary"
                >
                  <span aria-hidden="true">&hellip;</span>
                </button>
              </li>
            );
          }

          const isCurrent = index === lastIndex;
          return (
            <li
              key={`${index}-${item.label}`}
              ref={expanded && index === 1 ? firstRevealedRef : undefined}
              className="flex min-w-0 items-center gap-1"
            >
              {index > 0 ? <Separator /> : null}
              {isCurrent ? (
                item.href ? (
                  <Link href={item.href} variant="subtle" isCurrent className={linkClasses}>
                    {item.label}
                  </Link>
                ) : (
                  <span
                    aria-current="page"
                    tabIndex={-1}
                    className="inline-flex min-h-touch items-center font-semibold text-text-primary"
                  >
                    {item.label}
                  </span>
                )
              ) : item.href ? (
                <Link href={item.href} variant="subtle" className={linkClasses}>
                  {item.label}
                </Link>
              ) : (
                <span tabIndex={-1} className="inline-flex min-h-touch items-center text-text-secondary">
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Separator() {
  return (
    <span aria-hidden="true" data-breadcrumb-separator="" className="inline-flex text-text-secondary">
      <Icon name="chevron-right" size="sm" />
    </span>
  );
}
