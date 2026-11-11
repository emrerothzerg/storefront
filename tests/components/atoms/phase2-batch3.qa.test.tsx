// QA (QA-W1-T30): Steps, Drawer, ScrollRail adversarial checks.
// Independent of the colocated implementer tests; does not import from them.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode, createRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Steps, type StepItem, type StepStatus } from "@/components/atoms/Steps";
import { Drawer, type DrawerProps } from "@/components/atoms/Drawer";
import { ScrollRail } from "@/components/atoms/ScrollRail";
import { expectFocused } from "@/test/dom-assertions";

const ATOMS = join(import.meta.dir, "../../../src/components/atoms");
const src = (rel: string) => readFileSync(join(ATOMS, rel), "utf8");

// ---------------------------------------------------------------- Steps
const ALL: StepItem[] = [
  { id: "a", label: "Ordered", status: "complete", timestamp: "Nov 3, 9:00 AM" },
  { id: "b", label: "Shipped", status: "current", description: "In transit" },
  { id: "c", label: "Delivered", status: "upcoming" },
  { id: "d", label: "Refund", status: "cancelled", description: "Cancelled by you" },
];

const PREFIX: Record<StepStatus, string> = {
  complete: "Completed: ",
  current: "Current step: ",
  upcoming: "Upcoming: ",
  cancelled: "Cancelled: ",
};

function indicatorSignature(li: Element): string {
  // Describe the shape (not colour) of the indicator box.
  const box = li.firstElementChild!.firstElementChild!;
  if (box.tagName.toLowerCase() === "svg") return `svg:${box.innerHTML}`;
  return `${box.getAttribute("data-indicator")}:${box.children.length}`;
}

describe("Steps (criterion 1)", () => {
  test("source has no 'use client' and renders with renderToStaticMarkup as an <ol>", () => {
    expect(src("Steps/Steps.tsx")).not.toMatch(/["']use client["']/);
    const html = renderToStaticMarkup(<Steps steps={ALL} aria-label="Order progress" />);
    expect(html.startsWith("<ol")).toBe(true);
    expect(html).toContain('aria-label="Order progress"');
    expect((html.match(/<li/g) ?? []).length).toBe(4);
    expect((html.match(/aria-current="step"/g) ?? []).length).toBe(1);
    for (const s of ALL) expect(html).toContain(`${PREFIX[s.status]}</span>${s.label}`);
  });

  test("each status: exact hidden prefix text in an sr-only element", () => {
    render(<Steps steps={ALL} />);
    const items = screen.getAllByRole("listitem");
    items.forEach((li, i) => {
      const status = ALL[i]!.status;
      const hidden = Array.from(li.querySelectorAll(".sr-only")).map((n) => n.textContent);
      expect(hidden).toEqual([PREFIX[status]]);
      expect(li.textContent).toContain(`${PREFIX[status]}${ALL[i]!.label}`);
    });
  });

  test("each status has a distinct indicator shape (not colour alone), decorative to AT", () => {
    render(<Steps steps={ALL} />);
    const items = screen.getAllByRole("listitem");
    const sigs = items.map(indicatorSignature);
    expect(new Set(sigs).size).toBe(4);
    for (const li of items) {
      const box = li.firstElementChild!.firstElementChild!;
      expect(box.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("aria-current='step' on exactly the current item", () => {
    render(<Steps steps={ALL} />);
    const items = screen.getAllByRole("listitem");
    const marked = items.filter((li) => li.getAttribute("aria-current") === "step");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("Shipped");
    expect(items.filter((li) => li.hasAttribute("aria-current"))).toHaveLength(1);
  });

  test("no current step -> no aria-current anywhere", () => {
    render(<Steps steps={ALL.filter((s) => s.status !== "current")} />);
    expect(document.querySelectorAll("[aria-current]")).toHaveLength(0);
  });

  test("documents behaviour: two 'current' steps both get aria-current (caller data error)", () => {
    render(
      <Steps
        steps={[
          { id: "x", label: "A", status: "current" },
          { id: "y", label: "B", status: "current" },
        ]}
      />,
    );
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(2);
  });

  test("0 steps renders nothing (client and server)", () => {
    const { container } = render(<Steps steps={[]} aria-label="x" />);
    expect(container.innerHTML).toBe("");
    expect(renderToStaticMarkup(<Steps steps={[]} />)).toBe("");
  });

  test("1 step: one item, no connector", () => {
    render(<Steps steps={[{ id: "only", label: "Ordered", status: "complete" }]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryAllByTestId("step-connector")).toHaveLength(0);
  });

  test("50 steps: 50 items, 49 connectors, one aria-current", () => {
    const steps: StepItem[] = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      label: `Step ${i}`,
      status: i < 20 ? "complete" : i === 20 ? "current" : "upcoming",
    }));
    render(<Steps steps={steps} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getAllByTestId("step-connector")).toHaveLength(49);
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  test("duplicate ids still render every step (React warns about keys)", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <Steps
          steps={[
            { id: "dup", label: "One", status: "complete" },
            { id: "dup", label: "Two", status: "current" },
          ]}
        />,
      );
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    } finally {
      err.mockRestore();
    }
  });

  test("timestamp and description are rendered as escaped text; missing ones add no nodes", () => {
    const html = renderToStaticMarkup(
      <Steps
        steps={[
          { id: "a", label: "A", status: "complete", timestamp: "<b>t</b>", description: "<i>d</i>" },
          { id: "b", label: "B", status: "upcoming" },
        ]}
      />,
    );
    expect(html).toContain("&lt;b&gt;t&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;d&lt;/i&gt;");
    expect(html).not.toContain("<b>");
    render(<Steps steps={[{ id: "b", label: "B", status: "upcoming" }]} />);
    const textBlock = screen.getByRole("listitem").children[1]!;
    expect(textBlock.children).toHaveLength(1); // label only
  });

  test("orientation: vertical default, horizontal adds md:flex-row; ref + className last", () => {
    const ref = createRef<HTMLOListElement>();
    const { rerender } = render(<Steps ref={ref} steps={ALL} className="mt-4" />);
    const ol = screen.getByRole("list");
    expect(ol).toBe(ref.current!);
    expect(ol).toHaveAttribute("data-orientation", "vertical");
    expect(ol).not.toHaveClass("md:flex-row");
    expect(ol.className.split(" ").at(-1)).toBe("mt-4");
    rerender(<Steps ref={ref} steps={ALL} orientation="horizontal" className="mt-4" />);
    expect(ol).toHaveAttribute("data-orientation", "horizontal");
    expect(ol).toHaveClass("md:flex-row");
    expect(ol.className.split(" ").at(-1)).toBe("mt-4");
  });

  // Safari/VoiceOver drops list semantics for list-style:none lists unless
  // role="list" is explicit (ScrollRail does this; Steps does not).
  test("D-T30-1: list-none <ol> carries role='list' so Safari keeps list semantics", () => {
    render(<Steps steps={ALL} />);
    const ol = document.querySelector("ol")!;
    expect(ol).toHaveClass("list-none");
    expect(ol.getAttribute("role")).toBe("list");
  });
});

// ---------------------------------------------------------------- Drawer
function pressEscape(dialog: HTMLDialogElement): boolean {
  let prevented = false;
  act(() => {
    const ev = new Event("cancel", { cancelable: true });
    prevented = !dialog.dispatchEvent(ev);
    if (!prevented) dialog.close();
  });
  return prevented;
}

function Host(props: Partial<DrawerProps> & { spy?: () => void; initiallyOpen?: boolean }) {
  const { spy, initiallyOpen = false, ...rest } = props;
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Opener
      </button>
      <Drawer
        title="Filters"
        {...rest}
        open={open}
        onClose={() => {
          spy?.();
          setOpen(false);
        }}
      >
        <button type="button">Inside</button>
      </Drawer>
    </>
  );
}

const dlg = () => document.querySelector("dialog") as HTMLDialogElement;
function openIt() {
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("Drawer (criterion 2)", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  test("native <dialog>; closed: not open, no open attr, not exposed; SSR also closed", () => {
    render(<Host />);
    expect(dlg().tagName).toBe("DIALOG");
    expect(dlg().open).toBe(false);
    expect(dlg()).not.toHaveAttribute("open");
    expect(screen.queryByRole("dialog")).toBeNull();
    const html = renderToStaticMarkup(
      <Drawer open title="T" onClose={() => {}}>
        x
      </Drawer>,
    );
    expect(html).toMatch(/^<dialog/);
    expect(html).not.toMatch(/<dialog[^>]*\sopen[=\s>]/);
  });

  test("showModal() on open and close() on close (spied)", () => {
    const show = spyOn(HTMLDialogElement.prototype, "showModal");
    const close = spyOn(HTMLDialogElement.prototype, "close");
    try {
      render(<Host />);
      openIt();
      expect(show).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(0);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(close).toHaveBeenCalledTimes(1);
      expect(dlg().open).toBe(false);
    } finally {
      show.mockRestore();
      close.mockRestore();
    }
  });

  test("title -> aria-labelledby pointing at the visible heading", () => {
    render(<Host title="Shop by department" />);
    openIt();
    const d = screen.getByRole("dialog", { name: "Shop by department" });
    const id = d.getAttribute("aria-labelledby")!;
    expect(document.getElementById(id)).toHaveTextContent("Shop by department");
    expect(document.getElementById(id)!.tagName).toBe("H2");
  });

  test("title is required at the type level", () => {
    // @ts-expect-error title is required
    const el = <Drawer open={false} onClose={() => {}} />;
    expect(el).toBeTruthy();
  });

  test("documents behaviour: title='' compiles and leaves the dialog unnamed", () => {
    render(<Host title="" />);
    openIt();
    const d = dlg();
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)!.textContent).toBe("");
  });

  test("Escape (cancel) is prevented and calls onClose once; parent closes it", () => {
    const spy = mock();
    render(<Host spy={spy} />);
    const opener = openIt();
    expect(pressEscape(dlg())).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(dlg().open).toBe(false);
    expectFocused(opener);
  });

  test("controlled: Escape with a parent that ignores onClose keeps it open", () => {
    const onClose = mock();
    render(
      <Drawer open title="T" onClose={onClose}>
        x
      </Drawer>,
    );
    pressEscape(dlg());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dlg().open).toBe(true);
  });

  test("backdrop click calls onClose; click inside panel does not; closeOnBackdrop=false does not", () => {
    const spy = mock();
    const { unmount } = render(<Host spy={spy} />);
    openIt();
    fireEvent.click(screen.getByRole("button", { name: "Inside" }));
    fireEvent.click(screen.getByRole("heading", { name: "Filters" }));
    expect(spy).toHaveBeenCalledTimes(0);
    fireEvent.click(dlg());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(dlg().open).toBe(false);
    unmount();

    const spy2 = mock();
    render(<Host spy={spy2} closeOnBackdrop={false} />);
    openIt();
    fireEvent.click(dlg());
    expect(spy2).toHaveBeenCalledTimes(0);
    expect(dlg().open).toBe(true);
    // Escape still works with closeOnBackdrop=false.
    pressEscape(dlg());
    expect(spy2).toHaveBeenCalledTimes(1);
  });

  test("user onClick is still called alongside backdrop handling", () => {
    const onClick = mock();
    render(<Host onClick={onClick} />);
    openIt();
    fireEvent.click(dlg());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("a native close() while open calls onClose exactly once and restores state", () => {
    const spy = mock();
    document.body.style.overflow = "scroll";
    render(<Host spy={spy} />);
    const opener = openIt();
    act(() => dlg().close());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe("scroll");
    expectFocused(opener);
  });

  test("closing via the prop does not call onClose (no double notification)", () => {
    const onClose = mock();
    const { rerender } = render(
      <Drawer open title="T" onClose={onClose}>
        x
      </Drawer>,
    );
    rerender(
      <Drawer open={false} title="T" onClose={onClose}>
        x
      </Drawer>,
    );
    expect(dlg().open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("Close button: IconButton named 'Close', 44px (size-touch), keyboard-native; closeLabel overrides", () => {
    const spy = mock();
    const { unmount } = render(<Host spy={spy} />);
    const opener = openIt();
    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("type", "button");
    expect(btn).toHaveClass("size-touch");
    expect(btn.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    btn.focus();
    fireEvent.click(btn);
    expect(spy).toHaveBeenCalledTimes(1);
    expectFocused(opener);
    unmount();
    render(<Host closeLabel="Close filters" />);
    openIt();
    expect(screen.getByRole("button", { name: "Close filters" })).toBeInTheDocument();
  });

  test("body overflow hidden while open; restored (to previous value) on close", () => {
    document.body.style.overflow = "auto";
    render(<Host />);
    openIt();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.body.style.overflow).toBe("auto");
  });

  test("unmount while open restores overflow and returns focus to the opener", () => {
    document.body.style.overflow = "";
    function Outer() {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setMounted(false)}>
            Unmount
          </button>
          {mounted ? <Host /> : null}
        </>
      );
    }
    render(<Outer />);
    const opener = openIt();
    expect(document.body.style.overflow).toBe("hidden");
    // Unmount without moving focus through the drawer's own close path.
    act(() => fireEvent.click(screen.getByRole("button", { name: "Unmount" })));
    expect(document.body.style.overflow).toBe("");
    expect(opener.isConnected).toBe(false);
  });

  test("unmount (plain) while open restores overflow", () => {
    document.body.style.overflow = "clip";
    const { unmount } = render(
      <Drawer open title="T" onClose={() => {}}>
        x
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("clip");
  });

  test("reopen cycle x3 keeps showModal/lock/restore balanced", () => {
    document.body.style.overflow = "";
    render(<Host />);
    for (let i = 0; i < 3; i++) {
      openIt();
      expect(dlg().open).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");
      pressEscape(dlg());
      expect(dlg().open).toBe(false);
      expect(document.body.style.overflow).toBe("");
    }
  });

  // StrictMode (Next dev default) double-runs effects on mount. A drawer
  // mounted with open=true loses its scroll lock: the simulated unmount
  // restores overflow, and the re-run skips because dialog.open is true.
  test("D-T30-2: StrictMode + mounted open keeps body overflow hidden", () => {
    document.body.style.overflow = "";
    render(
      <StrictMode>
        <Drawer open title="T" onClose={() => {}}>
          x
        </Drawer>
      </StrictMode>,
    );
    expect(dlg().open).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
  });

  test.each([
    ["left", ["left-0", "-translate-x-full", "open:translate-x-0", "max-w-full", "h-dvh"]],
    ["right", ["right-0", "translate-x-full", "open:translate-x-0", "max-w-full", "h-dvh"]],
    ["bottom", ["bottom-0", "translate-y-full", "open:translate-y-0", "w-full", "max-w-full"]],
  ] as const)("side=%s token classes", (side, classes) => {
    render(
      <Drawer open={false} title="T" onClose={() => {}} side={side}>
        x
      </Drawer>,
    );
    expect(dlg()).toHaveClass(...classes);
    expect(dlg()).toHaveAttribute("data-side", side);
  });

  test.each([
    ["left", "sm", "w-72"],
    ["left", "md", "w-80"],
    ["right", "lg", "w-96"],
    ["bottom", "sm", "max-h-1/2"],
    ["bottom", "md", "max-h-3/4"],
    ["bottom", "lg", "max-h-dvh"],
  ] as const)("side=%s size=%s -> %s", (side, size, cls) => {
    render(
      <Drawer open={false} title="T" onClose={() => {}} side={side} size={size}>
        x
      </Drawer>,
    );
    expect(dlg()).toHaveClass(cls);
  });

  test("z-modal, reduced-motion class, ref (object + callback), className last, no style attr", () => {
    const ref = createRef<HTMLDialogElement>();
    const cb = mock();
    const { unmount } = render(
      <Drawer ref={ref} open={false} title="T" onClose={() => {}} className="custom-x">
        x
      </Drawer>,
    );
    expect(ref.current).toBe(dlg());
    expect(dlg()).toHaveClass("z-modal", "motion-reduce:transition-none");
    expect(dlg().className.split(" ").at(-1)).toBe("custom-x");
    expect(dlg()).not.toHaveAttribute("style");
    unmount();
    render(
      <Drawer ref={cb} open={false} title="T" onClose={() => {}}>
        x
      </Drawer>,
    );
    expect(cb).toHaveBeenCalledWith(dlg());
  });

  test("footer renders only when given", () => {
    const { rerender } = render(
      <Drawer open title="T" onClose={() => {}}>
        body
      </Drawer>,
    );
    expect(screen.queryByText("Apply")).toBeNull();
    rerender(
      <Drawer open title="T" onClose={() => {}} footer={<button type="button">Apply</button>}>
        body
      </Drawer>,
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- ScrollRail
function metrics(el: HTMLElement, m: { left?: number; sw: number; cw: number }) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: m.sw });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: m.cw });
  Object.defineProperty(el, "scrollLeft", { configurable: true, writable: true, value: m.left ?? 0 });
}
function scrollEvent(el: HTMLElement, left: number) {
  act(() => {
    Object.defineProperty(el, "scrollLeft", { configurable: true, writable: true, value: left });
    el.dispatchEvent(new Event("scroll"));
  });
}

const roCallbacks: Array<() => void> = [];
class RO {
  constructor(private cb: () => void) {
    roCallbacks.push(() => this.cb());
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
const realRO = globalThis.ResizeObserver;
const realMM = window.matchMedia;
function mm(reduce: boolean) {
  window.matchMedia = ((q: string) =>
    ({
      matches: reduce && q.includes("reduce"),
      media: q,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}
function relayout(el: HTMLElement, m: { left?: number; sw: number; cw: number }) {
  metrics(el, m);
  act(() => roCallbacks.forEach((f) => f()));
}

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => (
    <a key={`k${i}`} href={`/p/${i}`}>
      P{i}
    </a>
  ));
const rail = () => screen.getByRole("region", { name: "Rail" });
const btn = (name: string) =>
  document.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;

describe("ScrollRail (criterion 3)", () => {
  beforeEach(() => {
    roCallbacks.length = 0;
    globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = realRO;
    window.matchMedia = realMM;
  });

  // T181 (U01): unavailable arrows are no longer rendered with `hidden`; they are not rendered at all.
  test("no-JS HTML: region + aria-label + tabindex=0 + overflow/snap, ul[role=list] of li, no buttons", () => {
    expect(src("ScrollRail/ScrollRail.tsx")).toMatch(/^"use client";/);
    const html = renderToStaticMarkup(<ScrollRail label="Rail">{items(3)}</ScrollRail>);
    const host = document.createElement("div");
    host.innerHTML = html;
    const region = host.querySelector('[role="region"]')!;
    expect(region.getAttribute("aria-label")).toBe("Rail");
    expect(region.getAttribute("tabindex")).toBe("0");
    for (const c of ["overflow-x-auto", "snap-x", "snap-mandatory"]) expect(region.classList.contains(c)).toBe(true);
    const ul = region.querySelector(":scope > ul")!;
    expect(ul.getAttribute("role")).toBe("list");
    expect(ul.querySelectorAll(":scope > li")).toHaveLength(3);
    ul.querySelectorAll("li").forEach((li) => expect(li.classList.contains("snap-start")).toBe(true));
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(html).not.toContain("style=");
  });

  test("no buttons before any measurement on the client too", () => {
    render(<ScrollRail label="Rail">{items(3)}</ScrollRail>);
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("0 children: empty list, buttons hidden, no crash", () => {
    render(<ScrollRail label="Rail" />);
    expect(rail().querySelectorAll("li")).toHaveLength(0);
    relayout(rail(), { sw: 0, cw: 0 });
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("100 children: 100 list items; keys from children preserved", () => {
    render(<ScrollRail label="Rail">{items(100)}</ScrollRail>);
    expect(rail().querySelectorAll(":scope > ul > li")).toHaveLength(100);
    expect(screen.getByRole("link", { name: "P99" })).toBeInTheDocument();
  });

  test("null/false children are dropped; strings become items", () => {
    render(
      <ScrollRail label="Rail">
        {null}
        {false}
        {"text"}
        <span>x</span>
      </ScrollRail>,
    );
    expect(rail().querySelectorAll("li")).toHaveLength(2);
  });

  test("documents behaviour: empty label leaves the region unnamed", () => {
    render(<ScrollRail label="">{items(2)}</ScrollRail>);
    const r = document.querySelector('[role="region"]')!;
    expect(r.getAttribute("aria-label")).toBe("");
  });

  test("visibility per direction: none / start / middle / end", () => {
    render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
    const present = (name: string) => screen.queryByRole("button", { name }) !== null;
    relayout(rail(), { sw: 300, cw: 300 });
    expect([present("Scroll left"), present("Scroll right")]).toEqual([false, false]);
    relayout(rail(), { sw: 900, cw: 300, left: 0 });
    expect([present("Scroll left"), present("Scroll right")]).toEqual([false, true]);
    scrollEvent(rail(), 300);
    expect([present("Scroll left"), present("Scroll right")]).toEqual([true, true]);
    scrollEvent(rail(), 599.5); // sub-pixel end
    expect([present("Scroll left"), present("Scroll right")]).toEqual([true, false]);
  });

  test("names overridable; buttons are native type=button in tab order", () => {
    render(
      <ScrollRail label="Rail" prevLabel="Previous products" nextLabel="More products">
        {items(10)}
      </ScrollRail>,
    );
    relayout(rail(), { sw: 900, cw: 300, left: 300 });
    for (const name of ["Previous products", "More products"]) {
      const b = screen.getByRole("button", { name });
      expect(b.tagName).toBe("BUTTON");
      expect(b).toHaveAttribute("type", "button");
      expect(b).not.toHaveAttribute("tabindex", "-1");
      expect(b).not.toBeDisabled();
    }
  });

  test("keyboard path: focus next, activate -> scrollBy(clientWidth, smooth); prev -> negative", () => {
    mm(false);
    render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
    relayout(rail(), { sw: 1000, cw: 250, left: 250 });
    const sb = mock();
    rail().scrollBy = sb as unknown as HTMLElement["scrollBy"];
    const next = screen.getByRole("button", { name: "Scroll right" });
    next.focus();
    expectFocused(next);
    fireEvent.click(next);
    expect(sb).toHaveBeenCalledTimes(1);
    expect(sb).toHaveBeenLastCalledWith({ left: 250, behavior: "smooth" });
    fireEvent.click(screen.getByRole("button", { name: "Scroll left" }));
    expect(sb).toHaveBeenLastCalledWith({ left: -250, behavior: "smooth" });
  });

  test("reduced motion -> behavior auto; matchMedia missing -> smooth, no throw", () => {
    mm(true);
    const { unmount } = render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
    relayout(rail(), { sw: 900, cw: 300 });
    const sb = mock();
    rail().scrollBy = sb as unknown as HTMLElement["scrollBy"];
    fireEvent.click(screen.getByRole("button", { name: "Scroll right" }));
    expect(sb).toHaveBeenLastCalledWith({ left: 300, behavior: "auto" });
    unmount();

    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
    relayout(rail(), { sw: 900, cw: 300 });
    const sb2 = mock();
    rail().scrollBy = sb2 as unknown as HTMLElement["scrollBy"];
    fireEvent.click(screen.getByRole("button", { name: "Scroll right" }));
    expect(sb2).toHaveBeenLastCalledWith({ left: 300, behavior: "smooth" });
  });

  test("focused 'Scroll left' that hides moves focus to the region", () => {
    render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
    relayout(rail(), { sw: 900, cw: 300, left: 300 });
    screen.getByRole("button", { name: "Scroll left" }).focus();
    scrollEvent(rail(), 0);
    expect(screen.queryByRole("button", { name: "Scroll left" })).toBeNull();
    expectFocused(rail());
  });

  test("focused button hidden by a resize (no scroll event) also moves focus to the region", () => {
    render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
    relayout(rail(), { sw: 900, cw: 300, left: 0 });
    screen.getByRole("button", { name: "Scroll right" }).focus();
    relayout(rail(), { sw: 900, cw: 900, left: 0 });
    expect(screen.queryByRole("button", { name: "Scroll right" })).toBeNull();
    expectFocused(rail());
  });

  test("a visible focused button keeps focus", () => {
    render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
    relayout(rail(), { sw: 900, cw: 300, left: 0 });
    const next = screen.getByRole("button", { name: "Scroll right" });
    next.focus();
    scrollEvent(rail(), 300);
    expectFocused(next);
  });

  test("ResizeObserver undefined: mounts, measures on mount and on window resize; unmount clean", () => {
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    const { unmount } = render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
    metrics(rail(), { sw: 900, cw: 300 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(btn("Scroll right")).not.toHaveAttribute("hidden");
    unmount();
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
  });

  test("adding children re-measures without a resize callback", () => {
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    const { rerender } = render(<ScrollRail label="Rail">{items(1)}</ScrollRail>);
    metrics(rail(), { sw: 900, cw: 300 });
    rerender(<ScrollRail label="Rail">{items(5)}</ScrollRail>);
    expect(btn("Scroll right")).not.toHaveAttribute("hidden");
  });

  test("never auto-scrolls: mount, resize, scroll events, rerender, unmount -> zero scroll calls", () => {
    const calls = mock();
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const saved = { scrollBy: proto.scrollBy, scrollTo: proto.scrollTo, scrollIntoView: proto.scrollIntoView };
    proto.scrollBy = calls;
    proto.scrollTo = calls;
    proto.scrollIntoView = calls;
    try {
      const { rerender, unmount } = render(<ScrollRail label="Rail">{items(10)}</ScrollRail>);
      relayout(rail(), { sw: 900, cw: 300 });
      scrollEvent(rail(), 300);
      relayout(rail(), { sw: 1200, cw: 300, left: 300 });
      rerender(<ScrollRail label="Rail">{items(20)}</ScrollRail>);
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      unmount();
      expect(calls).not.toHaveBeenCalled();
    } finally {
      Object.assign(proto, saved);
    }
  });

  test("ref forwarded to the outer wrapper; className merged last; no style attr", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <ScrollRail ref={ref} label="Rail" className="mt-8">
        {items(2)}
      </ScrollRail>,
    );
    const outer = container.firstElementChild as HTMLDivElement;
    expect(ref.current).toBe(outer);
    expect(outer.className.split(" ").at(-1)).toBe("mt-8");
    expect(container.querySelector("[style]")).toBeNull();
  });
});

// ---------------------------------------------------------------- Cross-cutting
describe("cross-cutting (criterion 4)", () => {
  const files = [
    "Steps/Steps.tsx",
    "Steps/index.ts",
    "Drawer/Drawer.tsx",
    "Drawer/index.ts",
    "ScrollRail/ScrollRail.tsx",
    "ScrollRail/index.ts",
  ];

  test.each(files)("%s: no any / ts-ignore / inline style / arbitrary values / raw hex", (f) => {
    const s = src(f);
    expect(s).not.toMatch(/:\s*any\b|\bas any\b|<any>/);
    expect(s).not.toMatch(/@ts-(ignore|nocheck|expect-error)/);
    expect(s).not.toMatch(/\bstyle=\{/);
    expect(s).not.toMatch(/\b[a-z:-]+-\[[^\]]+\]/);
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
