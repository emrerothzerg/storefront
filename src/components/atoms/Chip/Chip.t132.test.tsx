import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { Chip } from "./Chip";

const FULL = "A very long popular search phrase that ChipRow truncates at forty characters";

describe("Chip title (request bu)", () => {
  test("link chip: title on the <a>, accessible name stays the visible label", () => {
    render(<Chip as="a" href="/search?q=x" label="A very long popular search phrase th…" title={FULL} />);
    const link = screen.getByRole("link", { name: "A very long popular search phrase th…" });
    expect(link.getAttribute("title")).toBe(FULL);
  });

  test("button chip: title on the <button>", () => {
    render(<Chip label="Lamps" title="Lamps and lighting" onToggle={() => {}} />);
    const b = screen.getByRole("button", { name: "Lamps" });
    expect(b.getAttribute("title")).toBe("Lamps and lighting");
    expect(b.getAttribute("aria-pressed")).toBe("false");
  });

  test("span chip: title on the span", () => {
    const html = renderToStaticMarkup(<Chip as="span" label="Acme" title="Brand: Acme" />);
    expect(html).toMatch(/^<span title="Brand: Acme" class="/);
  });

  test("removable chip: title on the main element, not on the wrapper or the remove button", () => {
    const { container } = render(
      <Chip as="a" href="/x" label="Acme" title="Brand: Acme" onRemove={() => {}} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.hasAttribute("title")).toBe(false);
    expect(screen.getByRole("link", { name: "Acme" }).getAttribute("title")).toBe("Brand: Acme");
    expect(screen.getByRole("button", { name: "Remove Acme" }).hasAttribute("title")).toBe(false);
  });

  test.each([undefined, "", "   "])("no title attribute when title is %j (default unchanged)", (title) => {
    const html = renderToStaticMarkup(<Chip as="a" href="/x" label="Acme" title={title} />);
    expect(html).not.toContain("title=");
  });

  test("hostile title is an escaped attribute value", () => {
    const html = renderToStaticMarkup(<Chip as="a" href="/x" label="Acme" title={'"><script>alert(1)</script>'} />);
    expect(html).not.toContain("<script");
    expect(html).toContain('title="&quot;&gt;&lt;script&gt;');
  });
});

describe("Chip 44px width (D-T131-3)", () => {
  test.each(["outline", "filled"] as const)("%s: link, button and span chips carry min-w-touch + min-h-touch, centred", (variant) => {
    const { container, unmount } = render(
      <>
        <Chip as="a" href="/search?q=s" label="S" variant={variant} />
        <Chip label="4+" variant={variant} onToggle={() => {}} />
        <Chip as="span" label="X" variant={variant} />
      </>,
    );
    const els = [container.querySelector("a")!, container.querySelector("button")!, container.querySelector(":scope > span")!];
    for (const el of els) {
      const c = (el.getAttribute("class") ?? "").split(" ");
      for (const k of ["min-w-touch", "min-h-touch", "justify-center"]) expect(c).toContain(k);
    }
    unmount();
  });

  test("removable chip: the main element and the outer pill both keep 44px minimums", () => {
    const { container } = render(<Chip as="a" href="/x" label="S" onRemove={() => {}} />);
    const outer = (container.firstElementChild!.getAttribute("class") ?? "").split(" ");
    const main = (container.querySelector("a")!.getAttribute("class") ?? "").split(" ");
    for (const c of ["min-w-touch", "min-h-touch"]) {
      expect(outer).toContain(c);
      expect(main).toContain(c);
    }
  });
});
