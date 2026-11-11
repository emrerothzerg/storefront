import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ScrollRail } from "./ScrollRail";
import { expectFocused } from "@/test/dom-assertions";

// happy-dom does no layout, so scroll metrics are stubbed per element.
function setMetrics(
  el: HTMLElement,
  m: { scrollLeft?: number; scrollWidth: number; clientWidth: number },
) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: m.scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: m.clientWidth });
  el.scrollLeft = m.scrollLeft ?? 0;
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    writable: true,
    value: m.scrollLeft ?? 0,
  });
}

function scrollTo(el: HTMLElement, left: number) {
  act(() => {
    Object.defineProperty(el, "scrollLeft", { configurable: true, writable: true, value: left });
    el.dispatchEvent(new Event("scroll"));
  });
}

// Captures ResizeObserver callbacks so tests can trigger a "resize".
const observers: Array<() => void> = [];
class FakeResizeObserver {
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    observers.push(() => this.cb());
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
const originalRO = globalThis.ResizeObserver;
const originalMatchMedia = window.matchMedia;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query.includes("reduce"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

beforeEach(() => {
  observers.length = 0;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = originalRO;
  window.matchMedia = originalMatchMedia;
});

function renderRail(props: Partial<Parameters<typeof ScrollRail>[0]> = {}) {
  return render(
    <ScrollRail label="Customers also viewed" {...props}>
      <a href="/p/1">Product 1</a>
      <a href="/p/2">Product 2</a>
      <a href="/p/3">Product 3</a>
    </ScrollRail>,
  );
}

const region = () => screen.getByRole("region", { name: "Customers also viewed" });
const prev = () => screen.queryByRole("button", { name: "Scroll left" });
const next = () => screen.queryByRole("button", { name: "Scroll right" });

/** Lays out the region, then fires the observer so the component re-measures. */
function layout(m: { scrollLeft?: number; scrollWidth: number; clientWidth: number }) {
  setMetrics(region(), m);
  act(() => observers.forEach((fire) => fire()));
}

describe("ScrollRail", () => {
  test("native scroll region: named, focusable, horizontal snap, list of items", () => {
    renderRail();
    const r = region();
    expect(r).toHaveAttribute("tabindex", "0");
    expect(r).toHaveClass("overflow-x-auto", "snap-x", "snap-mandatory");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    items.forEach((li) => expect(li).toHaveClass("snap-start", "shrink-0", "w-56"));
  });

  test("no buttons when nothing overflows (and none before measuring)", () => {
    renderRail();
    layout({ scrollWidth: 300, clientWidth: 300 });
    expect(prev()).toBeNull();
    expect(next()).toBeNull();
  });

  test("at the start only 'Scroll right' is shown; in the middle both; at the end only left", () => {
    renderRail();
    layout({ scrollLeft: 0, scrollWidth: 900, clientWidth: 300 });
    expect(prev()).toBeNull();
    expect(next()).toBeInTheDocument();

    scrollTo(region(), 300);
    expect(prev()).toBeInTheDocument();
    expect(next()).toBeInTheDocument();

    scrollTo(region(), 600);
    expect(prev()).toBeInTheDocument();
    expect(next()).toBeNull();
  });

  test("unavailable arrows are not rendered at all (not merely hidden by attribute)", () => {
    renderRail();
    layout({ scrollWidth: 900, clientWidth: 300 });
    expect(document.querySelector('button[aria-label="Scroll left"]')).toBeNull();
    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(document.querySelector("button[hidden]")).toBeNull();
  });

  test("snapping offset: scroll padding matches the list padding so load parks at 0", () => {
    // Regression (U01): mandatory snap aligned the first item 4px in, so the
    // rail loaded at scrollLeft 4 and showed "Scroll left" at the start.
    renderRail();
    expect(region()).toHaveClass("scroll-px-1");
    expect(screen.getByRole("list")).toHaveClass("p-1");
  });

  test("a 1-2px sub-pixel offset at either end does not show an arrow", () => {
    renderRail();
    layout({ scrollLeft: 1.5, scrollWidth: 900, clientWidth: 300 });
    expect(prev()).toBeNull();
    scrollTo(region(), 598.5);
    expect(next()).toBeNull();
    expect(prev()).toBeInTheDocument();
  });

  test("arrows sit in a reserved gutter (md+) and are not rendered visibly below md", () => {
    const { container } = renderRail();
    layout({ scrollLeft: 300, scrollWidth: 900, clientWidth: 300 });
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveClass("relative", "md:px-12", "rail:-mx-12");
    for (const button of [prev()!, next()!]) {
      expect(button).toHaveClass("absolute", "max-md:hidden", "z-raised");
      // Outside the scroll region, so they can never cover a card control.
      expect(region().contains(button)).toBe(false);
    }
    expect(prev()).toHaveClass("left-0");
    expect(next()).toHaveClass("right-0");
  });

  test("buttons scroll by one visible width, smooth by default", () => {
    setReducedMotion(false);
    renderRail();
    layout({ scrollLeft: 300, scrollWidth: 900, clientWidth: 300 });
    const scrollBy = mock();
    region().scrollBy = scrollBy as unknown as HTMLElement["scrollBy"];
    fireEvent.click(next()!);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 300, behavior: "smooth" });
    fireEvent.click(prev()!);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -300, behavior: "smooth" });
  });

  test("reduced motion scrolls instantly", () => {
    setReducedMotion(true);
    renderRail();
    layout({ scrollWidth: 900, clientWidth: 300 });
    const scrollBy = mock();
    region().scrollBy = scrollBy as unknown as HTMLElement["scrollBy"];
    fireEvent.click(next()!);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 300, behavior: "auto" });
  });

  test("buttons are native, keyboard operable, 44px IconButtons with chevrons", () => {
    renderRail();
    layout({ scrollLeft: 300, scrollWidth: 900, clientWidth: 300 });
    for (const button of [prev()!, next()!]) {
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveClass("size-touch");
      expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });

  test("a focused button that disappears hands focus to the region", () => {
    renderRail();
    layout({ scrollLeft: 300, scrollWidth: 900, clientWidth: 300 });
    next()!.focus();
    scrollTo(region(), 600);
    expect(next()).toBeNull();
    expectFocused(region());
  });

  test("works without ResizeObserver (falls back to window resize)", () => {
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    renderRail();
    setMetrics(region(), { scrollWidth: 900, clientWidth: 300 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(next()).toBeInTheDocument();
  });

  test("never auto-scrolls", () => {
    renderRail();
    const r = region();
    const scrollBy = mock();
    const scrollToSpy = mock();
    r.scrollBy = scrollBy as unknown as HTMLElement["scrollBy"];
    r.scrollTo = scrollToSpy as unknown as HTMLElement["scrollTo"];
    layout({ scrollWidth: 900, clientWidth: 300 });
    expect(scrollBy).not.toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["sm", ["w-20", "md:w-40"]],
    ["md", ["w-56"]],
    ["lg", ["w-72"]],
  ] as const)("itemWidth %s -> %p", (itemWidth, cls) => {
    renderRail({ itemWidth });
    expect(screen.getAllByRole("listitem")[0]).toHaveClass(...cls);
  });

  test("itemWidth auto leaves the width to the child", () => {
    renderRail({ itemWidth: "auto" });
    const li = screen.getAllByRole("listitem")[0]!;
    expect(li).toHaveClass("shrink-0", "snap-start");
    expect(li.className.split(/\s+/).some((c) => /(^|:)w-/.test(c))).toBe(false);
  });

  test.each([
    ["sm", "gap-2"],
    ["md", "gap-4"],
    ["lg", "gap-6"],
  ] as const)("gap %s -> %s", (gap, cls) => {
    renderRail({ gap });
    expect(screen.getByRole("list")).toHaveClass(cls);
  });

  test("custom button labels", () => {
    renderRail({ prevLabel: "Previous products", nextLabel: "More products" });
    layout({ scrollLeft: 300, scrollWidth: 900, clientWidth: 300 });
    expect(screen.getByRole("button", { name: "Previous products" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More products" })).toBeInTheDocument();
  });

  test("forwards ref to the wrapper and merges className last", () => {
    const ref = createRef<HTMLDivElement>();
    renderRail({ ref, className: "x-rail" });
    expect(ref.current).toContainElement(region());
    expect(ref.current?.className.endsWith("x-rail")).toBe(true);
  });

  test.each([[""], ["  "]])("label=%p logs a development warning (region left unnamed)", (label) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderRail({ label });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("ScrollRail: `label` must be non-empty");
    } finally {
      warn.mockRestore();
    }
  });

  test("a real label does not warn", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderRail();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
