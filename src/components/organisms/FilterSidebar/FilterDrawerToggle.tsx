"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Drawer } from "@/components/atoms/Drawer";

export interface FilterDrawerToggleProps {
  /** Pill content inside `<summary>` (icon, "Filter", count badge). Phrasing content only. */
  summary: ReactNode;
  /** Classes for the `<summary>` pill. */
  summaryClassName?: string;
  /** Optional heading shown at the top of the inline panel only (the Drawer has its own "Filters" title). */
  heading?: ReactNode;
  /** The filter panel (one GET form). Rendered in the details panel, and inside the Drawer while open. */
  children: ReactNode;
  /** Content after the Filter control in the same row (sort select, view toggle). */
  toolbarEnd?: ReactNode;
}

/** Tailwind `lg` (64rem). From here up the `<details>` panel opens in place; below it the Drawer opens. */
export const FILTER_PANEL_DESKTOP_QUERY = "(min-width: 64rem)";

const noopSubscribe = () => () => {};

function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** True when the viewport is `lg` or wider, or when `matchMedia` is unavailable (native details then). */
export function isDesktopViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(FILTER_PANEL_DESKTOP_QUERY).matches;
}

/**
 * The Filter pill and its panel. Server HTML / no JS: a native `<details>`
 * (closed by default) whose `<summary>` is the pill; expanding it shows the
 * panel (`<aside aria-label="Filters">` with the GET form) under the toolbar
 * row at every width. After hydration:
 * - `lg` and up: the same details toggles natively; Escape inside it closes
 *   it and returns focus to the summary.
 * - below `lg`: activating the summary keeps the details closed and opens a
 *   left `Drawer` titled "Filters" with the same panel, mounted only while
 *   open (ids come from `useId`, so the two instances never share ids). The
 *   Drawer closes on Escape / Close / backdrop and returns focus to the pill.
 */
export function FilterDrawerToggle({ summary, summaryClassName, heading, children, toolbarEnd }: FilterDrawerToggleProps) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLElement | null>(null);

  const handleSummaryClick = (event: MouseEvent<HTMLElement>) => {
    if (isDesktopViewport()) return;
    event.preventDefault();
    // Keep the inline panel closed (also when it was opened at a wider size).
    const details = event.currentTarget.parentElement;
    if (details instanceof HTMLDetailsElement) details.open = false;
    // Focus first so the Drawer captures the pill as its opener (Safari does not focus on click).
    event.currentTarget.focus();
    setOpen(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape") return;
    const details = event.currentTarget;
    if (!details.open) return;
    event.preventDefault();
    details.open = false;
    summaryRef.current?.focus();
  };

  return (
    <div className="relative flex min-w-0 flex-wrap items-center gap-3">
      <details className="group/filter min-w-0" onKeyDown={handleKeyDown} data-filter-panel="">
        <summary ref={summaryRef} className={summaryClassName} onClick={handleSummaryClick}>
          {summary}
        </summary>
        <div className="absolute inset-x-0 top-full z-dropdown mt-2 min-w-0 rounded-lg border border-border-default bg-surface-raised p-4 shadow-lg lg:right-auto lg:w-96">
          <aside aria-label="Filters" className="flex min-w-0 flex-col gap-4">
            {heading}
            {children}
          </aside>
        </div>
      </details>
      {toolbarEnd !== undefined && toolbarEnd !== null ? (
        <div className="ms-auto flex min-w-0 flex-wrap items-center gap-3">{toolbarEnd}</div>
      ) : null}
      {hydrated ? (
        <Drawer open={open} onClose={() => setOpen(false)} title="Filters" side="left">
          {open ? children : null}
        </Drawer>
      ) : null}
    </div>
  );
}
