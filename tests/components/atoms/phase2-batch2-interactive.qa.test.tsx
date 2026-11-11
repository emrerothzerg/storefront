// QA (QA-W0-D2, criteria 4, 5, 8, 11): Tabs, Disclosure/Accordion, Tooltip, SearchField.
import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { act, createRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { Tab, TabList, TabPanel, Tabs } from "@/components/atoms/Tabs";
import { Accordion, Disclosure } from "@/components/atoms/Disclosure";
import { Tooltip } from "@/components/atoms/Tooltip";
import { SearchField, type SearchSuggestion } from "@/components/atoms/SearchField";
import { expectFocused } from "@/test/dom-assertions";

// -------------------------------------------------------------------- 4 Tabs
type TabsHarnessProps = {
  orientation?: "horizontal" | "vertical";
  activationMode?: "automatic" | "manual";
  defaultValue?: string;
  disabled?: string[];
  onValueChange?: (v: string) => void;
};

function TabsHarness({ orientation, activationMode, defaultValue = "a", disabled = [], onValueChange }: TabsHarnessProps) {
  return (
    <Tabs defaultValue={defaultValue} orientation={orientation} activationMode={activationMode} onValueChange={onValueChange}>
      <TabList aria-label="Product info">
        {["a", "b", "c", "d"].map((v) => (
          <Tab key={v} value={v} disabled={disabled.includes(v)}>
            Tab {v.toUpperCase()}
          </Tab>
        ))}
      </TabList>
      {["a", "b", "c", "d"].map((v) => (
        <TabPanel key={v} value={v}>
          Panel {v.toUpperCase()}
        </TabPanel>
      ))}
    </Tabs>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });
const key = (k: string) => fireEvent.keyDown(document.activeElement as Element, { key: k });

describe("Tabs (criterion 4)", () => {
  test("roving tabindex: only the selected tab is in tab order; aria-selected matches", () => {
    render(<TabsHarness defaultValue="b" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "horizontal");
  });

  test("aria-controls / aria-labelledby wire each tab to its panel; inactive panels hidden", () => {
    const { container } = render(<TabsHarness />);
    for (const t of screen.getAllByRole("tab")) {
      const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", t.id);
    }
    const panels = Array.from(container.querySelectorAll("[role=tabpanel]"));
    expect(panels.map((p) => p.hasAttribute("hidden"))).toEqual([false, true, true, true]);
  });

  test("horizontal automatic: ArrowRight/Left move focus + select, wrap; Up/Down ignored", () => {
    const onValueChange = mock<(v: string) => void>(() => {});
    render(<TabsHarness onValueChange={onValueChange} />);
    tab("Tab A").focus();
    key("ArrowRight");
    expectFocused(tab("Tab B"));
    expect(tab("Tab B")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Panel B")).toBeVisible();
    key("ArrowLeft");
    key("ArrowLeft");
    expectFocused(tab("Tab D"));
    key("ArrowRight");
    expectFocused(tab("Tab A"));
    key("ArrowDown");
    expectFocused(tab("Tab A"));
    expect(onValueChange.mock.calls.map((c) => c[0])).toEqual(["b", "a", "d", "a"]);
  });

  test("vertical: ArrowDown/Up move; Left/Right ignored; aria-orientation vertical", () => {
    render(<TabsHarness orientation="vertical" />);
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    tab("Tab A").focus();
    key("ArrowRight");
    expectFocused(tab("Tab A"));
    key("ArrowDown");
    expectFocused(tab("Tab B"));
    key("ArrowUp");
    key("ArrowUp");
    expectFocused(tab("Tab D"));
  });

  test("Home/End jump; disabled tabs skipped by arrows, Home and End", () => {
    render(<TabsHarness defaultValue="b" disabled={["a", "d"]} />);
    tab("Tab B").focus();
    key("End");
    expectFocused(tab("Tab C"));
    key("Home");
    expectFocused(tab("Tab B"));
    key("ArrowLeft");
    expectFocused(tab("Tab C"));
    key("ArrowRight");
    expectFocused(tab("Tab B"));
  });

  test("handled keys are preventDefault-ed (no page scroll); other keys are not", () => {
    render(<TabsHarness />);
    tab("Tab A").focus();
    expect(fireEvent.keyDown(tab("Tab A"), { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(tab("Tab B"), { key: "a" })).toBe(true);
  });

  test("manual activation: arrows move focus only; click (Enter/Space on a native button) selects", () => {
    render(<TabsHarness activationMode="manual" />);
    tab("Tab A").focus();
    key("ArrowRight");
    expectFocused(tab("Tab B"));
    expect(tab("Tab A")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Panel B", { ignore: false })).not.toBeVisible();
    expect(tab("Tab B").tagName).toBe("BUTTON");
    expect(tab("Tab B")).toHaveAttribute("type", "button");
    fireEvent.click(tab("Tab B"));
    expect(tab("Tab B")).toHaveAttribute("aria-selected", "true");
    expect(tab("Tab B")).toHaveAttribute("tabindex", "0");
  });

  test("controlled: selection follows the value prop, not the click", () => {
    const onValueChange = mock<(v: string) => void>(() => {});
    function Controlled() {
      return (
        <Tabs value="a" onValueChange={onValueChange}>
          <TabList aria-label="x">
            <Tab value="a">One</Tab>
            <Tab value="b">Two</Tab>
          </TabList>
          <TabPanel value="a">P1</TabPanel>
          <TabPanel value="b">P2</TabPanel>
        </Tabs>
      );
    }
    render(<Controlled />);
    fireEvent.click(tab("Two"));
    expect(onValueChange).toHaveBeenCalledWith("b");
    expect(tab("One")).toHaveAttribute("aria-selected", "true");

    function Driven() {
      const [v, setV] = useState("a");
      return (
        <Tabs value={v} onValueChange={setV}>
          <TabList aria-label="y">
            <Tab value="a">Uno</Tab>
            <Tab value="b">Dos</Tab>
          </TabList>
          <TabPanel value="a">Q1</TabPanel>
          <TabPanel value="b">Q2</TabPanel>
        </Tabs>
      );
    }
    render(<Driven />);
    tab("Uno").focus();
    key("ArrowRight");
    expect(tab("Dos")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Q2")).toBeVisible();
  });

  test("clicking the selected tab does not fire onValueChange", () => {
    const onValueChange = mock<(v: string) => void>(() => {});
    render(<TabsHarness onValueChange={onValueChange} />);
    fireEvent.click(tab("Tab A"));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test("touch target + className last + refs", () => {
    const tabRef = createRef<HTMLButtonElement>();
    const listRef = createRef<HTMLDivElement>();
    const panelRef = createRef<HTMLDivElement>();
    const rootRef = createRef<HTMLDivElement>();
    render(
      <Tabs defaultValue="a" ref={rootRef} className="qa-root">
        <TabList aria-label="l" ref={listRef} className="qa-list">
          <Tab value="a" ref={tabRef} className="qa-tab">
            A
          </Tab>
        </TabList>
        <TabPanel value="a" ref={panelRef} className="qa-panel">
          p
        </TabPanel>
      </Tabs>,
    );
    expect(tabRef.current?.className.split(" ")).toContain("min-h-touch");
    expect(tabRef.current?.className.split(" ").at(-1)).toBe("qa-tab");
    expect(listRef.current?.className.split(" ").at(-1)).toBe("qa-list");
    expect(panelRef.current?.className.split(" ").at(-1)).toBe("qa-panel");
    expect(rootRef.current?.className.split(" ").at(-1)).toBe("qa-root");
  });

  test("no-JS shape: only the default panel is visible in server markup", () => {
    const html = renderToStaticMarkup(<TabsHarness defaultValue="c" />);
    expect(html.match(/role="tabpanel"[^>]*hidden=""/g) ?? []).toHaveLength(3);
    expect(html).toMatch(/role="tablist"/);
  });

  test("hydration of server markup produces no id mismatch", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(<TabsHarness />);
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <TabsHarness />, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    await act(async () => root?.unmount());
    container.remove();
  });

  // D2-6: if defaultValue/value matches no enabled tab (stale value, disabled default), every
  // tab gets tabIndex=-1 and the tablist cannot be reached with Tab at all.
  test("DEFECT D2-6: tablist stays keyboard-reachable when the value matches no enabled tab", () => {
    const { unmount } = render(<TabsHarness defaultValue="zzz" />);
    expect(screen.getAllByRole("tab").filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    unmount();
    render(<TabsHarness defaultValue="a" disabled={["a"]} />);
    const reachable = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("tabindex") === "0" && !t.hasAttribute("disabled"));
    expect(reachable).toHaveLength(1);
  });

  // D2-7: idFragment escapes " " to "_20" but leaves "_" as-is, so "a b" and "a_20b" collide.
  test("DEFECT D2-7: distinct tab values never produce duplicate element ids", () => {
    render(
      <Tabs defaultValue="a b">
        <TabList aria-label="ids">
          <Tab value="a b">Space</Tab>
          <Tab value="a_20b">Underscore</Tab>
        </TabList>
        <TabPanel value="a b">s</TabPanel>
        <TabPanel value="a_20b">u</TabPanel>
      </Tabs>,
    );
    expect(tab("Space").id).not.toBe(tab("Underscore").id);
  });
});

// -------------------------------------------------------------- 5 Disclosure
describe("Disclosure / Accordion (criterion 5)", () => {
  test("no-JS: native details/summary; defaultOpen -> open attribute; summary is first child", () => {
    const closed = renderToStaticMarkup(<Disclosure summary="Shipping">Free over $35</Disclosure>);
    expect(closed).toMatch(/^<details(?![^>]*\sopen)[^>]*><summary/);
    const open = renderToStaticMarkup(
      <Disclosure summary="Shipping" defaultOpen>
        x
      </Disclosure>,
    );
    expect(open).toMatch(/^<details[^>]*\sopen=""[^>]*><summary/);
    // no buttons, no scripts needed
    expect(open).not.toContain("<button");
  });

  test("no-JS: exclusive Accordion shares one generated name; non-exclusive has none", () => {
    const items = [
      { id: "a", summary: "A", content: "a" },
      { id: "b", summary: "B", content: "b" },
      { id: "c", summary: "C", content: "c" },
    ];
    const ex = renderToStaticMarkup(<Accordion exclusive items={items} />);
    const names = [...ex.matchAll(/<details[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(1);
    expect(names[0]?.length).toBeGreaterThan(0);
    const plain = renderToStaticMarkup(<Accordion items={items} />);
    expect(plain).not.toMatch(/<details[^>]*name=/);
  });

  test("two exclusive accordions on one page get different group names", () => {
    const items = [{ id: "a", summary: "A", content: "a" }];
    const { container } = render(
      <>
        <Accordion exclusive items={items} />
        <Accordion exclusive items={items} />
      </>,
    );
    const names = Array.from(container.querySelectorAll("details")).map((d) => d.getAttribute("name"));
    expect(names[0]).not.toBe(names[1]);
  });

  test("controlled: open prop drives the attribute; native toggle reports onOpenChange once", async () => {
    const onOpenChange = mock<(v: boolean) => void>(() => {});
    function C() {
      const [open, setOpen] = useState(false);
      return (
        <Disclosure
          summary="Specs"
          open={open}
          onOpenChange={(o) => {
            onOpenChange(o);
            setOpen(o);
          }}
        >
          body
        </Disclosure>
      );
    }
    const { container } = render(<C />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(container.querySelector("summary") as HTMLElement);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
    expect(details.open).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  test("variant plain vs bordered; summary has touch target; className/summaryClassName last; ref", () => {
    const ref = createRef<HTMLDetailsElement>();
    const { container, rerender } = render(
      <Disclosure summary="S" ref={ref} className="qa-root" summaryClassName="qa-sum">
        x
      </Disclosure>,
    );
    expect(ref.current?.tagName).toBe("DETAILS");
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-root");
    expect(ref.current?.className).toContain("border-b");
    const summary = container.querySelector("summary") as HTMLElement;
    expect(summary.className.split(" ")).toContain("min-h-touch");
    expect(summary.className.split(" ").at(-1)).toBe("qa-sum");
    rerender(
      <Disclosure summary="S" variant="bordered">
        x
      </Disclosure>,
    );
    expect(container.querySelector("details")?.className).toContain("rounded-lg");
  });

  test("chevron is decorative (aria-hidden)", () => {
    render(<Disclosure summary="S">x</Disclosure>);
    expect(screen.getByTestId("disclosure-chevron")).toHaveAttribute("aria-hidden", "true");
  });

  test("Accordion with 0 items renders an empty container; onItemToggle receives id", async () => {
    const { container, unmount } = render(<Accordion items={[]} />);
    expect(container.querySelectorAll("details")).toHaveLength(0);
    unmount();
    const onItemToggle = mock<(id: string, o: boolean) => void>(() => {});
    const r = render(
      <Accordion items={[{ id: "faq-1", summary: "Q1", content: "A1" }]} onItemToggle={onItemToggle} />,
    );
    fireEvent.click(r.container.querySelector("summary") as HTMLElement);
    await waitFor(() => expect(onItemToggle).toHaveBeenCalledWith("faq-1", true));
  });
});

// ----------------------------------------------------------------- 8 Tooltip
describe("Tooltip (criterion 8)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const advance = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  test("trigger gets aria-describedby (merged with existing); bubble in DOM, hidden, z-dropdown", () => {
    render(
      <Tooltip content="Ships in 2 days">
        <button type="button" aria-describedby="other">
          Info
        </button>
      </Tooltip>,
    );
    const btn = screen.getByRole("button", { name: "Info" });
    const bubble = document.querySelector("[role=tooltip]") as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveAttribute("hidden");
    expect(bubble.className.split(" ")).toContain("z-dropdown");
    expect(btn.getAttribute("aria-describedby")?.split(" ")).toEqual(["other", bubble.id]);
  });

  test("hover shows only after the delay; leave hides", () => {
    const { container } = render(
      <Tooltip content="Tip" delayMs={300}>
        <button type="button">T</button>
      </Tooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    const bubble = screen.getByRole("tooltip", { hidden: true });
    fireEvent.mouseEnter(wrapper);
    advance(299);
    expect(bubble).toHaveAttribute("hidden");
    advance(1);
    expect(bubble).not.toHaveAttribute("hidden");
    fireEvent.mouseLeave(wrapper);
    advance(200);
    expect(bubble).toHaveAttribute("hidden");
  });

  test("hover in and out before the delay never shows", () => {
    const { container } = render(
      <Tooltip content="Tip">
        <button type="button">T</button>
      </Tooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    advance(100);
    fireEvent.mouseLeave(wrapper);
    advance(1000);
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveAttribute("hidden");
  });

  test("keyboard: focus shows immediately; Escape dismisses; blur hides; refocus reshows", () => {
    render(
      <>
        <Tooltip content="Tip">
          <button type="button">T</button>
        </Tooltip>
        <button type="button">After</button>
      </>,
    );
    const btn = screen.getByRole("button", { name: "T" });
    const bubble = screen.getByRole("tooltip", { hidden: true });
    act(() => btn.focus());
    expect(bubble).not.toHaveAttribute("hidden");
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(bubble).toHaveAttribute("hidden");
    act(() => screen.getByRole("button", { name: "After" }).focus());
    act(() => btn.focus());
    expect(bubble).not.toHaveAttribute("hidden");
    act(() => screen.getByRole("button", { name: "After" }).focus());
    expect(bubble).toHaveAttribute("hidden");
  });

  test("Escape while only hovered (focus elsewhere) dismisses", () => {
    const { container } = render(
      <Tooltip content="Tip" delayMs={0}>
        <button type="button">T</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement);
    advance(0);
    const bubble = screen.getByRole("tooltip", { hidden: true });
    expect(bubble).not.toHaveAttribute("hidden");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(bubble).toHaveAttribute("hidden");
  });

  test("bubble is hoverable: moving onto it keeps it open (it lives inside the hover wrapper)", () => {
    const { container } = render(
      <Tooltip content="Tip" delayMs={0}>
        <button type="button">T</button>
      </Tooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    advance(0);
    const bubble = screen.getByRole("tooltip");
    expect(wrapper.contains(bubble)).toBe(true);
    fireEvent.mouseOver(bubble);
    advance(1000);
    expect(bubble).not.toHaveAttribute("hidden");
    expect(bubble.className).not.toContain("pointer-events-none");
  });

  test("render-prop trigger receives the tooltip id", () => {
    render(
      <Tooltip content="Tip">
        {(p) => (
          <a href="/help" {...p}>
            Help
          </a>
        )}
      </Tooltip>,
    );
    const link = screen.getByRole("link", { name: "Help" });
    expect(link).toHaveAttribute("aria-describedby", screen.getByRole("tooltip", { hidden: true }).id);
  });

  test("accessible description resolves even while hidden", () => {
    render(
      <Tooltip content="Ships in 2 days">
        <button type="button">Info</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Info" })).toHaveAccessibleDescription("Ships in 2 days");
  });

  test("className merged last, ref to wrapper; hostile delayMs (negative/NaN) does not crash", () => {
    const ref = createRef<HTMLSpanElement>();
    render(
      <Tooltip content="t" ref={ref} className="qa-last" delayMs={-50}>
        <button type="button">X</button>
      </Tooltip>,
    );
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
    fireEvent.mouseEnter(ref.current as HTMLElement);
    advance(0);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------- 11 SearchField
const sugg: SearchSuggestion[] = [
  { id: "1", label: "mug", href: "/search?q=mug" },
  { id: "2", label: "mug warmer", href: "/search?q=mug+warmer" },
  { id: "3", label: "mug tree", href: "/search?q=mug+tree" },
];

describe("SearchField (criterion 11)", () => {
  test("no-JS: GET form to /search, input name=q, label for=input & visually hidden, submit button", () => {
    const html = renderToStaticMarkup(<SearchField suggestions={sugg} />);
    const form = html.match(/<form[^>]*>/)?.[0] ?? "";
    expect(form).toContain('role="search"');
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/search"');
    const input = html.match(/<input[^>]*>/)?.[0] ?? "";
    expect(input).toContain('name="q"');
    const id = input.match(/id="([^"]+)"/)?.[1];
    expect(html).toMatch(new RegExp(`<label for="${id}" class="sr-only">Search</label>`));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*aria-label="Submit search"|<button[^>]*aria-label="Submit search"[^>]*type="submit"/);
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain("Clear search");
  });

  test("showLabel renders a visible label; label association works", () => {
    render(<SearchField label="Search products" showLabel />);
    const input = screen.getByLabelText("Search products");
    expect(input).toHaveAttribute("name", "q");
    expect(screen.getByText("Search products").className).not.toContain("sr-only");
  });

  test("hydration with defaultValue: no mismatch, then clear button appears", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(<SearchField defaultValue="mug" inputId="s1" />);
    expect(container.querySelector("[aria-label='Clear search']")).toBeNull();
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <SearchField defaultValue="mug" inputId="s1" />, {
        onRecoverableError: (e) => errors.push(e),
      });
    });
    expect(errors).toEqual([]);
    expect(container.querySelector("[aria-label='Clear search']")).not.toBeNull();
    expect(container.querySelector("input")?.getAttribute("role")).toBe("combobox");
    await act(async () => root?.unmount());
    container.remove();
  });

  test("clear button only when non-empty; clears, refocuses, fires onChange('')", () => {
    const onChange = mock<(v: string) => void>(() => {});
    render(<SearchField onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Search" }) as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(input, { target: { value: "a" } });
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear.className.split(" ")).toContain("size-touch");
    expect(clear).toHaveAttribute("type", "button");
    fireEvent.click(clear);
    expect(input.value).toBe("");
    expectFocused(input);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["a", ""]);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  test("combobox ARIA: collapsed until focus; listbox/options; aria-controls points at listbox", () => {
    render(<SearchField suggestions={sugg} />);
    const input = screen.getByRole("combobox", { name: "Search" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    const listbox = document.getElementById(input.getAttribute("aria-controls") ?? "");
    expect(listbox).toHaveAttribute("role", "listbox");
    expect(listbox).toHaveAttribute("hidden");
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(listbox).not.toHaveAttribute("hidden");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    for (const o of screen.getAllByRole("option")) expect(o.className.split(" ")).toContain("min-h-touch");
  });

  test("keyboard: ArrowDown/Up move aria-activedescendant with wrap; Enter selects via onSelect and does not submit", () => {
    const onSelect = mock<(s: SearchSuggestion) => void>(() => {});
    const onSubmit = mock((e: { preventDefault(): void }) => e.preventDefault());
    render(<SearchField suggestions={sugg} onSelect={onSelect} onSubmit={onSubmit} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    const active = () => input.getAttribute("aria-activedescendant");
    expect(active()).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const opts = screen.getAllByRole("option");
    expect(active()).toBe(opts[0]!.id);
    expect(opts[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(active()).toBe(opts[2]!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toBe(opts[0]!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toBe(opts[1]!.id);
    const notPrevented = fireEvent.keyDown(input, { key: "Enter" });
    expect(notPrevented).toBe(false);
    expect(onSelect).toHaveBeenCalledWith(sugg[1]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("mug warmer");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes the list first, then clears the input", () => {
    render(<SearchField suggestions={sugg} defaultValue="mu" />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(input.value).toBe("mu");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    // ArrowDown re-opens after Escape
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-expanded", "true");
  });

  test("click on an option selects it (mousedown prevented so the input keeps focus)", () => {
    const onSelect = mock<(s: SearchSuggestion) => void>(() => {});
    render(<SearchField suggestions={sugg} onSelect={onSelect} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    const opt = screen.getByRole("option", { name: "mug tree" });
    expect(fireEvent.mouseDown(opt)).toBe(false);
    fireEvent.click(opt);
    expect(onSelect).toHaveBeenCalledWith(sugg[2]);
  });

  test("without onSelect: Enter on a suggestion navigates to its href", () => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      render(<SearchField suggestions={sugg} />);
      const input = screen.getByRole("combobox");
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(assign).toHaveBeenCalledWith("/search?q=mug");
    } finally {
      assign.mockRestore();
    }
  });

  test("Enter with no active option submits the form with the query", () => {
    const onSubmit = mock<(e: { preventDefault(): void }, q: string) => void>((e) => e.preventDefault());
    render(<SearchField suggestions={sugg} defaultValue="mug" onSubmit={onSubmit} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    fireEvent.submit(screen.getByRole("search"));
    expect(onSubmit.mock.calls[0]?.[1]).toBe("mug");
  });

  test("no suggestions: never expanded, arrows are no-ops", () => {
    render(<SearchField />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(true);
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  test("suggestions shrinking under an active index never point aria-activedescendant at a missing option", () => {
    const { rerender } = render(<SearchField suggestions={sugg} inputId="sx" />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowUp" }); // index 2
    rerender(<SearchField suggestions={sugg.slice(0, 1)} inputId="sx" />);
    const id = input.getAttribute("aria-activedescendant");
    if (id !== null) expect(document.getElementById(id)).not.toBeNull();
  });

  test("10k suggestions render; blur collapses", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), label: `s${i}`, href: `/s/${i}` }));
    const { container } = render(<SearchField suggestions={many} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    // querySelectorAll instead of getAllByRole: the role query allocates ~525 MB on 10k options (TEST-MEM).
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(10_000);
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  test("status region announces count while expanded", () => {
    render(<SearchField suggestions={sugg} />);
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.getByRole("status")).toHaveTextContent("3 suggestions available");
  });

  test("ref to form, inputRef to input, className merged last, custom name/action", () => {
    const ref = createRef<HTMLFormElement>();
    const inputRef = createRef<HTMLInputElement>();
    render(<SearchField ref={ref} inputRef={inputRef} className="qa-last" name="query" action="/find" />);
    expect(ref.current?.tagName).toBe("FORM");
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
    expect(ref.current).toHaveAttribute("action", "/find");
    expect(inputRef.current).toHaveAttribute("name", "query");
  });
});
