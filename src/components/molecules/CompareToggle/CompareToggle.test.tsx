import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompareToggle } from "./CompareToggle";

function hiddenValues(form: Element, name = "p"): string[] {
  return [...form.querySelectorAll<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)].map((i) => i.value);
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector("form");
  if (!form) throw new Error("form not found");
  return form;
}

/** What a browser would submit (checkbox included only when checked & enabled). */
function submittedSlugs(form: HTMLFormElement): string[] {
  return new FormData(form).getAll("p").map(String);
}

describe("CompareToggle form mode (criterion 3, no JS)", () => {
  test("static markup is a GET form to /compare with p checkbox, hidden p inputs and submit", () => {
    const html = renderToStaticMarkup(
      <CompareToggle productSlug="lamp" productName="Desk Lamp" selected={["mug", "chair"]} />,
    );
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/compare"');
    expect(html).toContain('<input type="hidden" name="p" value="mug"/>');
    expect(html).toContain('<input type="hidden" name="p" value="chair"/>');
    expect(html).toMatch(/<input[^>]*name="p"[^>]*value="lamp"[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*name="p"[^>]*value="lamp"/);
    expect(html).toContain("Compare Desk Lamp");
    expect(html).toMatch(/type="submit"/);
    expect(html).toContain("Compare (2)");
    expect(html).not.toContain("<script");
  });

  test("checking this product submits /compare?p=mug&p=chair&p=lamp", () => {
    const { container } = render(
      <CompareToggle productSlug="lamp" productName="Desk Lamp" selected={["mug", "chair"]} />,
    );
    const box = screen.getByRole("checkbox", { name: "Compare Desk Lamp" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    const form = getForm(container);
    expect(submittedSlugs(form)).toEqual(["mug", "chair", "lamp"]);
    expect(`/compare?${new URLSearchParams(new FormData(form) as unknown as [string, string][]).toString()}`).toBe(
      "/compare?p=mug&p=chair&p=lamp",
    );
  });

  test("selected product: checkbox checked, no duplicate hidden input; unchecking removes it", () => {
    const { container } = render(
      <CompareToggle productSlug="lamp" productName="Desk Lamp" selected={["lamp", "mug", "lamp"]} />,
    );
    const form = getForm(container);
    expect(hiddenValues(form)).toEqual(["mug"]);
    const box = screen.getByRole("checkbox", { name: "Compare Desk Lamp" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(submittedSlugs(form)).toEqual(["mug", "lamp"]);
    box.checked = false;
    expect(submittedSlugs(form)).toEqual(["mug"]);
    expect(screen.getByRole("button", { name: /Compare \(2\)/ })).toBeInTheDocument();
  });

  test("5th selection is blocked: disabled checkbox + message linked by aria-describedby", () => {
    const { container } = render(
      <CompareToggle productSlug="lamp" productName="Desk Lamp" selected={["a", "b", "c", "d"]} />,
    );
    const box = screen.getByRole("checkbox", { name: "Compare Desk Lamp" });
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription("You can compare up to 4 products");
    expect(screen.getByText("You can compare up to 4 products")).toBeInTheDocument();
    // Even if forced checked, a disabled control is not submitted.
    (box as HTMLInputElement).checked = true;
    expect(submittedSlugs(getForm(container))).toEqual(["a", "b", "c", "d"]);
  });

  test("at the cap a selected product stays enabled and shows no message", () => {
    render(<CompareToggle productSlug="b" productName="B" selected={["a", "b", "c", "d"]} />);
    expect(screen.getByRole("checkbox", { name: "Compare B" })).toBeEnabled();
    expect(screen.queryByText(/You can compare up to/)).toBeNull();
  });

  test("oversized and duplicated URL selection is deduped and capped", () => {
    const { container } = render(
      <CompareToggle productSlug="z" productName="Z" selected={["a", "a", "b", "c", "d", "e", ""]} />,
    );
    expect(hiddenValues(getForm(container))).toEqual(["a", "b", "c", "d"]);
    expect(screen.getByRole("checkbox", { name: "Compare Z" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Compare \(4\)/ })).toBeInTheDocument();
  });

  test("custom max changes the cap and the message", () => {
    render(<CompareToggle productSlug="c" productName="C" selected={["a", "b"]} max={2} />);
    expect(screen.getByRole("checkbox", { name: "Compare C" })).toBeDisabled();
    expect(screen.getByText("You can compare up to 2 products")).toBeInTheDocument();
  });

  test("basePath adds 'Add to selection' submitting to the listing with its params replayed", () => {
    const { container } = render(
      <CompareToggle
        productSlug="lamp"
        productName="Lamp"
        selected={["mug"]}
        basePath="/search?q=desk+lamp&sort=price&p=stale"
      />,
    );
    const form = getForm(container);
    const add = screen.getByRole("button", { name: "Add to selection" });
    expect(add).toHaveAttribute("type", "submit");
    expect(add).toHaveAttribute("formaction", "/search");
    expect(form.querySelector('input[type="hidden"][name="q"]')).toHaveAttribute("value", "desk lamp");
    expect(form.querySelector('input[type="hidden"][name="sort"]')).toHaveAttribute("value", "price");
    // The listing's own stale p is not replayed; selection comes from `selected`.
    expect(hiddenValues(form)).toEqual(["mug"]);
  });

  test("off-site or malformed basePath is ignored", () => {
    for (const bad of ["https://evil.example/x", "//evil.example/x", "javascript:alert(1)", "search"]) {
      const { unmount } = render(<CompareToggle productSlug="l" productName="L" selected={[]} basePath={bad} />);
      expect(screen.queryByRole("button", { name: "Add to selection" })).toBeNull();
      unmount();
    }
  });

  test("hostile name and slug render as text / attribute values", () => {
    const html = renderToStaticMarkup(
      <CompareToggle
        productSlug={'x"><script>alert(1)</script>'}
        productName={"<img src=x onerror=alert(1)>"}
        selected={['"><b>y</b>']}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("Compare &lt;img src=x onerror=alert(1)&gt;");
  });

  test("empty slug renders nothing", () => {
    expect(renderToStaticMarkup(<CompareToggle productSlug="  " productName="X" selected={[]} />)).toBe("");
  });
});

describe("CompareToggle link mode", () => {
  test("'Add to compare' links to /compare with the slug appended", () => {
    render(<CompareToggle mode="link" productSlug="lamp" productName="Lamp" selected={["mug"]} />);
    const link = screen.getByRole("link", { name: /Add to compare/ });
    expect(link).toHaveAttribute("href", "/compare?p=mug&p=lamp");
    expect(link).toHaveAccessibleName(/^Add to compare\s*: Lamp$/);
  });

  test("'Remove from compare' when selected", () => {
    render(<CompareToggle mode="link" productSlug="lamp" productName="Lamp" selected={["lamp", "mug"]} />);
    expect(screen.getByRole("link", { name: /Remove from compare/ })).toHaveAttribute("href", "/compare?p=mug");
  });

  test("at the cap shows the message instead of a link", () => {
    render(<CompareToggle mode="link" productSlug="e" productName="E" selected={["a", "b", "c", "d"]} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("You can compare up to 4 products")).toBeInTheDocument();
  });

  test("icons are decorative", () => {
    const { container } = render(<CompareToggle mode="link" productSlug="a" productName="A" selected={[]} />);
    for (const svg of container.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("CompareToggle Phase 3 look (T145)", () => {
  test("form mode: 44px checkbox row and secondary pill submits; GET shape unchanged", () => {
    const html = renderToStaticMarkup(
      <CompareToggle productSlug="oak-desk" productName="Oak Desk" selected={["a"]} basePath="/search?q=desk" />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/compare");
    expect(doc.querySelector('input[type="checkbox"]')?.closest("label")?.className).toMatch(/\bmin-h-touch\b/);
    for (const b of doc.querySelectorAll("button")) {
      expect(b.className).toMatch(/\brounded-full\b/);
      expect(b.className).toMatch(/\bmin-h-touch\b/);
    }
  });
});
