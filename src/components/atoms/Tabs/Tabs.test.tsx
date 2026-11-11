import { describe, expect, mock, test } from "bun:test";
import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tab, TabList, TabPanel, Tabs, idFragment } from "./Tabs";
import type { TabsActivationMode, TabsOrientation } from "./Tabs";
import { expectFocused } from "@/test/dom-assertions";

function Example({
  orientation,
  activationMode,
  onValueChange,
  disabledB = false,
}: {
  orientation?: TabsOrientation;
  activationMode?: TabsActivationMode;
  onValueChange?: (v: string) => void;
  disabledB?: boolean;
}) {
  return (
    <Tabs
      defaultValue="desc"
      orientation={orientation}
      activationMode={activationMode}
      onValueChange={onValueChange}
    >
      <TabList aria-label="Product information">
        <Tab value="desc">Description</Tab>
        <Tab value="specs" disabled={disabledB}>
          Specs
        </Tab>
        <Tab value="reviews">Reviews</Tab>
      </TabList>
      <TabPanel value="desc">Description panel</TabPanel>
      <TabPanel value="specs">Specs panel</TabPanel>
      <TabPanel value="reviews">Reviews panel</TabPanel>
    </Tabs>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("Tabs", () => {
  test("renders tablist, tabs and panels with linked ARIA", () => {
    render(<Example />);
    const list = screen.getByRole("tablist", { name: "Product information" });
    expect(list).toHaveAttribute("aria-orientation", "horizontal");
    const desc = tab("Description");
    expect(desc).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: "Description" });
    expect(desc).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", desc.id);
    expect(panel).toHaveTextContent("Description panel");
    expect(panel).toHaveAttribute("tabindex", "0");
  });

  test("inactive panels are hidden; roving tabindex on tabs", () => {
    render(<Example />);
    expect(screen.getByText("Specs panel")).not.toBeVisible();
    expect(screen.getByText("Specs panel")).toHaveAttribute("hidden");
    expect(tab("Description")).toHaveAttribute("tabindex", "0");
    expect(tab("Specs")).toHaveAttribute("tabindex", "-1");
    expect(tab("Reviews")).toHaveAttribute("aria-selected", "false");
  });

  test("click selects a tab", () => {
    const onValueChange = mock();
    render(<Example onValueChange={onValueChange} />);
    fireEvent.click(tab("Reviews"));
    expect(tab("Reviews")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Reviews panel")).toBeVisible();
    expect(onValueChange).toHaveBeenCalledWith("reviews");
  });

  test("automatic: ArrowRight/ArrowLeft move focus and select, wrapping", () => {
    render(<Example />);
    tab("Description").focus();
    fireEvent.keyDown(tab("Description"), { key: "ArrowRight" });
    expectFocused(tab("Specs"));
    expect(tab("Specs")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab("Specs"), { key: "ArrowRight" });
    fireEvent.keyDown(tab("Reviews"), { key: "ArrowRight" });
    expectFocused(tab("Description"));
    fireEvent.keyDown(tab("Description"), { key: "ArrowLeft" });
    expectFocused(tab("Reviews"));
    expect(tab("Reviews")).toHaveAttribute("aria-selected", "true");
  });

  test("Home and End jump to first and last tab", () => {
    render(<Example />);
    tab("Description").focus();
    fireEvent.keyDown(tab("Description"), { key: "End" });
    expectFocused(tab("Reviews"));
    fireEvent.keyDown(tab("Reviews"), { key: "Home" });
    expectFocused(tab("Description"));
  });

  test("manual: arrows move focus only; Enter (click) selects", () => {
    render(<Example activationMode="manual" />);
    tab("Description").focus();
    fireEvent.keyDown(tab("Description"), { key: "ArrowRight" });
    expectFocused(tab("Specs"));
    expect(tab("Specs")).toHaveAttribute("aria-selected", "false");
    expect(tab("Description")).toHaveAttribute("aria-selected", "true");
    // Native <button>: Enter/Space dispatch click.
    fireEvent.click(tab("Specs"));
    expect(tab("Specs")).toHaveAttribute("aria-selected", "true");
  });

  test("vertical orientation uses ArrowUp/ArrowDown and ignores Left/Right", () => {
    render(<Example orientation="vertical" />);
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    tab("Description").focus();
    fireEvent.keyDown(tab("Description"), { key: "ArrowRight" });
    expectFocused(tab("Description"));
    fireEvent.keyDown(tab("Description"), { key: "ArrowDown" });
    expectFocused(tab("Specs"));
    fireEvent.keyDown(tab("Specs"), { key: "ArrowUp" });
    expectFocused(tab("Description"));
  });

  test("disabled tabs are skipped by arrow keys", () => {
    render(<Example disabledB />);
    tab("Description").focus();
    fireEvent.keyDown(tab("Description"), { key: "ArrowRight" });
    expectFocused(tab("Reviews"));
  });

  test("controlled: value drives selection; onValueChange reports intent", () => {
    const onValueChange = mock();
    function Controlled() {
      const [value, setValue] = useState("b");
      return (
        <Tabs
          value={value}
          onValueChange={(v) => {
            onValueChange(v);
            setValue(v);
          }}
        >
          <TabList aria-label="x">
            <Tab value="a">A</Tab>
            <Tab value="b">B</Tab>
          </TabList>
          <TabPanel value="a">PA</TabPanel>
          <TabPanel value="b">PB</TabPanel>
        </Tabs>
      );
    }
    render(<Controlled />);
    expect(tab("B")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tab("A"));
    expect(onValueChange).toHaveBeenCalledWith("a");
    expect(tab("A")).toHaveAttribute("aria-selected", "true");
  });

  test("controlled without state update keeps the selection", () => {
    render(
      <Tabs value="a">
        <TabList aria-label="x">
          <Tab value="a">A</Tab>
          <Tab value="b">B</Tab>
        </TabList>
        <TabPanel value="a">PA</TabPanel>
        <TabPanel value="b">PB</TabPanel>
      </Tabs>,
    );
    fireEvent.click(tab("B"));
    expect(tab("A")).toHaveAttribute("aria-selected", "true");
  });

  test("selected tab has a non-colour indicator (bar + weight)", () => {
    render(<Example />);
    expect(tab("Description")).toHaveClass("border-b-2", "border-accent", "font-semibold");
    expect(tab("Specs")).toHaveClass("border-transparent", "min-h-touch");
  });

  test("values with spaces still produce valid, linked ids", () => {
    render(
      <Tabs defaultValue="Q & A">
        <TabList aria-label="x">
          <Tab value="Q & A">Questions</Tab>
        </TabList>
        <TabPanel value="Q & A">P</TabPanel>
      </Tabs>,
    );
    const t = tab("Questions");
    expect(t.id).not.toContain(" ");
    expect(screen.getByRole("tabpanel", { name: "Questions" })).toBeInTheDocument();
  });

  test("forwards refs and merges className last", () => {
    const rootRef = createRef<HTMLDivElement>();
    const tabRef = createRef<HTMLButtonElement>();
    render(
      <Tabs defaultValue="a" ref={rootRef} className="x-root">
        <TabList aria-label="x" className="x-list">
          <Tab value="a" ref={tabRef} className="x-tab">
            A
          </Tab>
        </TabList>
        <TabPanel value="a" className="x-panel">
          P
        </TabPanel>
      </Tabs>,
    );
    expect(rootRef.current?.className.endsWith("x-root")).toBe(true);
    expect(tabRef.current).toBe(tab("A") as HTMLButtonElement);
    expect(tab("A").className.endsWith("x-tab")).toBe(true);
    expect(screen.getByRole("tablist").className.endsWith("x-list")).toBe(true);
    expect(screen.getByRole("tabpanel").className.endsWith("x-panel")).toBe(true);
  });

  test("sub-components throw outside Tabs", () => {
    const spy = mock(() => {});
    const original = console.error;
    console.error = spy;
    expect(() => render(<Tab value="a">A</Tab>)).toThrow(/inside <Tabs>/);
    console.error = original;
  });

  test("stale defaultValue selects and focuses the first enabled tab", () => {
    render(
      <Tabs defaultValue="zzz">
        <TabList aria-label="x">
          <Tab value="a" disabled>
            A
          </Tab>
          <Tab value="b">B</Tab>
          <Tab value="c">C</Tab>
        </TabList>
        <TabPanel value="b">PB</TabPanel>
      </Tabs>,
    );
    const tabbable = screen.getAllByRole("tab").filter((t) => t.getAttribute("tabindex") === "0");
    expect(tabbable).toEqual([tab("B")]);
    expect(tab("B")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("PB")).toBeVisible();
  });

  test("controlled value on a disabled tab keeps selection but makes the first enabled tab tabbable", () => {
    render(
      <Tabs value="a">
        <TabList aria-label="x">
          <Tab value="a" disabled>
            A
          </Tab>
          <Tab value="b">B</Tab>
        </TabList>
      </Tabs>,
    );
    expect(tab("A")).toHaveAttribute("aria-selected", "true");
    expect(tab("A")).toHaveAttribute("tabindex", "-1");
    expect(tab("B")).toHaveAttribute("tabindex", "0");
  });

  test("id encoding is collision-free", () => {
    expect(idFragment("a b")).not.toBe(idFragment("a_20b"));
    expect(idFragment("a_b")).not.toBe(idFragment("a_5fb"));
    expect(idFragment("plain-Value9")).toBe("plain-Value9");
  });
});
