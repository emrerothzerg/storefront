"use client";

import { Children, isValidElement, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { IconButton } from "../IconButton";

export type ScrollRailItemWidth = "sm" | "md" | "lg" | "auto";
export type ScrollRailGap = "sm" | "md" | "lg";

export interface ScrollRailProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  /**
   * Required accessible name of the scroll region, e.g. "Customers also
   * viewed". Must be non-empty text: an empty label leaves the region
   * unnamed and logs a development warning.
   */
  label: string;
  /** Rail items (typically product cards). Each one becomes a list item and a snap point. */
  children?: ReactNode;
  /**
   * Item width. `sm`: 80px below md, 160px from md (category circles, about
   * four per phone screen). `md`: 224px. `lg`: 288px. `auto`: no width on the
   * list item; the child sizes itself (use with atoms that carry their own
   * responsive width, e.g. CategoryTile). Defaults to "md".
   */
  itemWidth?: ScrollRailItemWidth;
  /** Space between items: 8 / 16 / 24px. Defaults to "md". */
  gap?: ScrollRailGap;
  /** Accessible names of the progressive scroll buttons. */
  prevLabel?: string;
  nextLabel?: string;
}

const itemWidthClasses: Record<ScrollRailItemWidth, string> = {
  sm: "w-20 md:w-40",
  md: "w-56",
  lg: "w-72",
  auto: "",
};

const gapClasses: Record<ScrollRailGap, string> = {
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
};

// Tolerance for sub-pixel / zoomed scroll positions.
const EPSILON = 2;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function join(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Horizontal product rail. Without JavaScript it is a native horizontal
 * scroller (`overflow-x-auto` + `scroll-snap-type: x mandatory`) and a
 * focusable, named `role="region"` (arrow keys scroll it). With JavaScript,
 * "Scroll left" / "Scroll right" buttons are rendered only while there is
 * content in that direction and scroll by one visible width (smooth unless
 * the user prefers reduced motion). Never auto-scrolls.
 *
 * Arrow placement (they must never cover a control inside the rail, e.g. a
 * card's quick-add button): below md there are no arrows (touch scrolling;
 * the region stays keyboard focusable). From md the wrapper reserves a 48px
 * gutter on each side (`md:px-12`) and the 44px arrows sit in it, outside
 * the scroll region (below 1360px, e.g. at 1024, the items are therefore
 * inset 48px from the section heading). From the `rail` breakpoint (1360px,
 * `--breakpoint-rail` in globals.css) the page container (max-w-7xl + px-4)
 * has at least 56px of side margin, so the wrapper pulls out by 48px
 * (`rail:-mx-12`): items line up with the heading and the arrows sit in the
 * page gutter.
 *
 * ```tsx
 * <ScrollRail label="Customers also viewed" itemWidth="md">
 *   {products.map((p) => <ProductCard key={p.id} product={p} />)}
 * </ScrollRail>
 * ```
 */
export function ScrollRail({
  label,
  children,
  itemWidth = "md",
  gap = "md",
  prevLabel = "Scroll left",
  nextLabel = "Scroll right",
  className,
  ref,
  ...rest
}: ScrollRailProps) {
  const labelMissing = label.trim() === "";
  useEffect(() => {
    if (labelMissing && process.env.NODE_ENV !== "production") {
      console.warn("ScrollRail: `label` must be non-empty text; it names the scroll region.");
    }
  }, [labelMissing]);

  const regionRef = useRef<HTMLDivElement | null>(null);
  const prevRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  // Both false on the server / before hydration: no buttons without JS.
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const update = useCallback(() => {
    const region = regionRef.current;
    if (!region) return;
    const { scrollLeft, scrollWidth, clientWidth } = region;
    const nextPrev = scrollLeft > EPSILON;
    const nextNext = scrollLeft + clientWidth < scrollWidth - EPSILON;
    // A focused button that is about to disappear would drop focus to
    // <body>; hand it to the region instead.
    const active = document.activeElement;
    if ((!nextPrev && active === prevRef.current) || (!nextNext && active === nextRef.current)) {
      region.focus({ preventScroll: true });
    }
    setCanPrev(nextPrev);
    setCanNext(nextNext);
  }, []);

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    update();
    region.addEventListener("scroll", update, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => update());
      observer.observe(region);
      if (region.firstElementChild) observer.observe(region.firstElementChild);
    } else {
      window.addEventListener("resize", update);
    }
    return () => {
      region.removeEventListener("scroll", update);
      if (observer) observer.disconnect();
      else window.removeEventListener("resize", update);
    };
  }, [update]);

  // Item count changes can change overflow even without a resize callback.
  const count = Children.count(children);
  useEffect(() => {
    update();
  }, [count, update]);

  const scrollByPage = (direction: -1 | 1) => {
    const region = regionRef.current;
    if (!region) return;
    region.scrollBy({
      left: direction * region.clientWidth,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  const items = Children.toArray(children);
  // max-md:hidden: a variant utility, so it wins over Button's inline-flex.
  const buttonClasses =
    "absolute top-1/2 z-raised -translate-y-1/2 rounded-full shadow-md max-md:hidden";

  return (
    <div
      {...rest}
      ref={ref}
      data-scroll-rail=""
      className={join("relative md:px-12 rail:-mx-12", className)}
    >
      {/* Conditionally rendered (not only the hidden attribute) so no
          stylesheet can ever show an arrow that has nothing to scroll to. */}
      {canPrev ? (
        <IconButton
          ref={prevRef}
          icon="chevron-left"
          label={prevLabel}
          variant="outline"
          onClick={() => scrollByPage(-1)}
          className={join(buttonClasses, "left-0")}
        />
      ) : null}
      <div
        ref={regionRef}
        role="region"
        aria-label={label}
        tabIndex={0}
        // scroll-px-1 matches the list's p-1: without it, mandatory snapping
        // aligns the first item's edge (4px in) and parks scrollLeft at 4 on
        // load, which read as "can scroll back" and showed the prev arrow.
        className="snap-x snap-mandatory scroll-px-1 overflow-x-auto overscroll-x-contain rounded-md"
      >
        <ul role="list" className={join("m-0 flex w-max list-none p-1", gapClasses[gap])}>
          {items.map((child, index) => (
            <li
              key={isValidElement(child) && child.key != null ? child.key : index}
              className={join("shrink-0 snap-start", itemWidthClasses[itemWidth])}
            >
              {child}
            </li>
          ))}
        </ul>
      </div>
      {canNext ? (
        <IconButton
          ref={nextRef}
          icon="chevron-right"
          label={nextLabel}
          variant="outline"
          onClick={() => scrollByPage(1)}
          className={join(buttonClasses, "right-0")}
        />
      ) : null}
    </div>
  );
}
