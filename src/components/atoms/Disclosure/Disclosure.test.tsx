import { describe, expect, mock, test } from "bun:test";
import { createRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Accordion, Disclosure } from "./Disclosure";

const summaryOf = (container: HTMLElement) => container.querySelector("summary") as HTMLElement;
const detailsOf = (container: HTMLElement) =>
  container.querySelector("details") as HTMLDetailsElement;

describe("Disclosure", () => {
  test("no-JS: server HTML is native details/summary with the open attribute", () => {
    const closed = renderToStaticMarkup(<Disclosure summary="Shipping">Ships free</Disclosure>);
    expect(closed).toMatch(/^<details[^>]*>/);
    expect(closed).not.toMatch(/<details[^>]*\sopen/);
    expect(closed).toContain("<summary");
    expect(closed).toContain("Ships free");

    const open = renderToStaticMarkup(
      <Disclosure summary="Shipping" defaultOpen>
        Ships free
      </Disclosure>,
    );
    expect(open).toMatch(/<details[^>]*\sopen=""/);
  });

  test("no-JS: exclusive Accordion renders a shared name attribute", () => {
    const html = renderToStaticMarkup(
      <Accordion
        exclusive
        name="faq"
        items={[
          { id: "a", summary: "A", content: "a" },
          { id: "b", summary: "B", content: "b" },
        ]}
      />,
    );
    expect(html.match(/<details[^>]*name="faq"/g)).toHaveLength(2);
  });

  test("summary toggles content natively (click)", async () => {
    const { container } = render(<Disclosure summary="Details">Hidden text</Disclosure>);
    const details = detailsOf(container);
    expect(details.open).toBe(false);
    fireEvent.click(summaryOf(container));
    await waitFor(() => expect(details.open).toBe(true));
  });

  test("summary is the keyboard-focusable control and has a touch target", () => {
    const { container } = render(<Disclosure summary="Details">x</Disclosure>);
    const summary = summaryOf(container);
    summary.focus();
    expect(summary).toHaveClass("min-h-touch", "cursor-pointer", "list-none");
  });

  test("defaultOpen renders open; uncontrolled state survives re-render", async () => {
    const { container, rerender } = render(
      <Disclosure summary="S" defaultOpen>
        x
      </Disclosure>,
    );
    const details = detailsOf(container);
    expect(details.open).toBe(true);
    fireEvent.click(summaryOf(container));
    await waitFor(() => expect(details.open).toBe(false));
    rerender(
      <Disclosure summary="S" defaultOpen>
        y
      </Disclosure>,
    );
    expect(details.open).toBe(false);
  });

  test("onOpenChange fires from the toggle event", async () => {
    const onOpenChange = mock();
    const { container } = render(
      <Disclosure summary="S" onOpenChange={onOpenChange}>
        x
      </Disclosure>,
    );
    fireEvent.click(summaryOf(container));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
  });

  test("controlled: open prop drives the element and changes are reported", async () => {
    const onOpenChange = mock();
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Expand
          </button>
          <Disclosure
            summary="S"
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
          >
            x
          </Disclosure>
        </>
      );
    }
    const { container } = render(<Controlled />);
    const details = detailsOf(container);
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    await waitFor(() => expect(details.open).toBe(true));
    // React-driven change is not echoed back as a user change.
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(summaryOf(container));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(details.open).toBe(false);
  });

  test("chevron is decorative and rotates via the open attribute", () => {
    render(<Disclosure summary="S">x</Disclosure>);
    const chevron = screen.getByTestId("disclosure-chevron");
    expect(chevron).toHaveAttribute("aria-hidden", "true");
    expect(chevron).toHaveClass("group-open/disclosure:rotate-180");
  });

  test.each([
    ["plain", "border-b"],
    ["bordered", "rounded-lg"],
  ] as const)("variant %s", (variant, cls) => {
    const { container } = render(
      <Disclosure summary="S" variant={variant}>
        x
      </Disclosure>,
    );
    expect(detailsOf(container)).toHaveClass(cls);
  });

  test("forwards ref and merges className last", () => {
    const ref = createRef<HTMLDetailsElement>();
    const { container } = render(
      <Disclosure summary="S" ref={ref} className="mt-2" summaryClassName="x-sum">
        x
      </Disclosure>,
    );
    expect(ref.current).toBe(detailsOf(container));
    expect(ref.current?.className.endsWith("mt-2")).toBe(true);
    expect(summaryOf(container).className.endsWith("x-sum")).toBe(true);
  });
});

describe("Accordion", () => {
  const items = [
    { id: "ret", summary: "Returns", content: "30 days", defaultOpen: true },
    { id: "ship", summary: "Shipping", content: "2 days" },
  ];

  test("renders one Disclosure per item", () => {
    const { container } = render(<Accordion items={items} />);
    const all = container.querySelectorAll("details");
    expect(all).toHaveLength(2);
    expect((all[0] as HTMLDetailsElement).open).toBe(true);
    expect(all[0]).not.toHaveAttribute("name");
  });

  test("exclusive gives every item the same generated name", () => {
    const { container } = render(<Accordion items={items} exclusive />);
    const names = Array.from(container.querySelectorAll("details")).map((d) =>
      d.getAttribute("name"),
    );
    expect(names[0]).toBeTruthy();
    expect(names[0]).toBe(names[1] ?? "");
  });

  test("onItemToggle reports the item id", async () => {
    const onItemToggle = mock();
    const { container } = render(<Accordion items={items} onItemToggle={onItemToggle} />);
    const summaries = container.querySelectorAll("summary");
    fireEvent.click(summaries[1] as HTMLElement);
    await waitFor(() => expect(onItemToggle).toHaveBeenCalledWith("ship", true));
  });

  test("bordered variant spaces items; ref and className on wrapper", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <Accordion items={items} variant="bordered" ref={ref} className="x-acc" />,
    );
    expect(ref.current).toBe(container.firstElementChild as HTMLDivElement);
    expect(ref.current).toHaveClass("gap-2");
    expect(ref.current?.className.endsWith("x-acc")).toBe(true);
  });
});
