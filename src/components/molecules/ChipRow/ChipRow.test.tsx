import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChipRow } from "./ChipRow";
import type { ChipRowItem } from "./chip-row-helpers";

const POPULAR: ChipRowItem[] = [{ query: "lego" }, { query: "board games" }, { query: "desk lamp" }];

function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

describe("ChipRow structure", () => {
  test("nav named by label containing a ul of link chips with text", () => {
    render(<ChipRow label="Popular searches" items={POPULAR} />);
    const nav = screen.getByRole("navigation", { name: "Popular searches" });
    const list = within(nav).getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const links = within(list).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["lego", "board games", "desk lamp"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/search?q=lego",
      "/search?q=board%20games",
      "/search?q=desk%20lamp",
    ]);
  });

  test("empty list, or no valid items, renders nothing (no empty nav)", () => {
    const empty = render(<ChipRow label="Related searches" items={[]} />);
    expect(empty.container.innerHTML).toBe("");
    const invalid = render(
      <ChipRow label="Related searches" items={[{ query: "  " }, { label: "Evil", href: "https://evil.example" }]} />,
    );
    expect(invalid.container.innerHTML).toBe("");
    expect(renderToStaticMarkup(<ChipRow label="x" items={[]} />)).toBe("");
  });

  test("adds no headings, forms or buttons (CONTRACTS L-5, works without JS)", () => {
    const { container } = render(<ChipRow label="Popular searches" items={POPULAR} showLabel more={{ href: "/search", label: "All searches" }} />);
    expect(container.querySelectorAll("h1, h2, h3, h4, h5, h6, form, input, button")).toHaveLength(0);
  });

  test("server-rendered HTML already contains every link (no JS needed)", () => {
    const html = renderToStaticMarkup(<ChipRow label="Popular searches" items={POPULAR} />);
    expect(html).toContain('<nav aria-label="Popular searches"');
    expect(html).toContain('href="/search?q=board%20games"');
    expect(html).not.toContain("<script");
  });

  test("link chips keep allow-listed internal hrefs and drop the rest", () => {
    const { container } = render(
      <ChipRow
        label="Related searches"
        items={[
          { label: "Toys", href: "/category/toys" },
          { label: "Acme", href: "/brand/acme" },
          { label: "Bad", href: "javascript:alert(1)" },
          { label: "Bad2", href: "//evil.example/x" },
          { label: "Bad3", href: "/admin" },
        ]}
      />,
    );
    expect(hrefs(container)).toEqual(["/category/toys", "/brand/acme"]);
  });

  test("at most 12 chips by default; maxItems lowers it", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ query: `t${i}` }));
    const a = render(<ChipRow label="A" items={many} />);
    expect(within(a.container).getAllByRole("link")).toHaveLength(12);
    a.unmount();
    const b = render(<ChipRow label="B" items={many} maxItems={4} />);
    expect(within(b.container).getAllByRole("link")).toHaveLength(4);
  });
});

describe("ChipRow labels", () => {
  test("labels are trimmed; long labels truncated to 40 with the full text in title and the name", () => {
    const long = "Extra large wooden building blocks set for toddlers and kids";
    const { container } = render(<ChipRow label="Popular searches" items={[{ query: "  lego  " }, { query: long }]} />);
    const [short, cut] = within(container).getAllByRole("link");
    expect(short?.textContent).toBe("lego");
    expect(short?.closest("li")?.hasAttribute("title")).toBe(false);
    expect(cut?.textContent?.endsWith("…")).toBe(true);
    expect(Array.from(cut?.textContent ?? "").length).toBeLessThanOrEqual(40);
    expect(cut?.closest("li")?.getAttribute("title")).toBe(long);
    expect(cut?.getAttribute("aria-label")).toBe(long);
    // the href carries the full (<= 100) query, not the truncated label
    expect(cut?.getAttribute("href")).toBe(`/search?q=${encodeURIComponent(long)}`);
  });

  test("HTML in labels and queries renders as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <ChipRow label={"<b>Popular</b>"} items={[{ query: evil }, { label: "<script>x</script>", href: "/deals" }]} />,
    );
    expect(container.querySelector("img, script, b")).toBeNull();
    const links = within(container).getAllByRole("link");
    expect(links[0]?.textContent).toBe(evil);
    expect(links[1]?.textContent).toBe("<script>x</script>");
    expect(links[0]?.getAttribute("href")).toBe(`/search?q=${encodeURIComponent(evil)}`);
    expect(screen.getByRole("navigation", { name: "<b>Popular</b>" })).toBeInTheDocument();
  });

  test("hostile 101+ character query: href query cut at 100, label at 40", () => {
    const q = `${"z".repeat(120)}`;
    const { container } = render(<ChipRow label="Related searches" items={[{ query: q }]} />);
    const link = within(container).getByRole("link");
    expect(link.getAttribute("href")).toBe(`/search?q=${"z".repeat(100)}`);
    expect(link.textContent).toBe(`${"z".repeat(39)}…`);
    expect(link.closest("li")?.getAttribute("title")).toBe("z".repeat(100));
  });

  test("blank nav label falls back to a generic name", () => {
    render(<ChipRow label="   " items={POPULAR} />);
    expect(screen.getByRole("navigation", { name: "Searches" })).toBeInTheDocument();
  });

  test("showLabel renders visible text (not a heading) that names the nav", () => {
    render(<ChipRow label="Related searches" items={POPULAR} showLabel />);
    const nav = screen.getByRole("navigation", { name: "Related searches" });
    expect(nav.hasAttribute("aria-label")).toBe(false);
    const labelledBy = nav.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.tagName).toBe("P");
    expect(document.getElementById(labelledBy)?.textContent).toBe("Related searches");
  });
});

describe("ChipRow icons and arrow", () => {
  test("no search icon by default; leading or trailing decorative icon per chip", () => {
    const none = render(<ChipRow label="A" items={POPULAR} />);
    expect(none.container.querySelectorAll("li svg")).toHaveLength(0);
    none.unmount();

    const leading = render(<ChipRow label="B" items={POPULAR} searchIcon="leading" />);
    const firstLeading = leading.container.querySelector("li a");
    expect(firstLeading?.querySelectorAll("svg")).toHaveLength(1);
    expect(firstLeading?.firstElementChild?.querySelector("svg")).not.toBeNull();
    expect(firstLeading?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(within(leading.container).getAllByRole("link")[0]).toHaveAccessibleName("lego");
    leading.unmount();

    const trailing = render(<ChipRow label="C" items={POPULAR} searchIcon="trailing" />);
    const firstTrailing = trailing.container.querySelector("li a");
    expect(firstTrailing?.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(within(trailing.container).getAllByRole("link")[0]).toHaveAccessibleName("lego");
  });

  test("trailing round arrow link is named, allow-listed and outside the list", () => {
    render(<ChipRow label="Popular searches" items={POPULAR} more={{ href: "/search", label: "See all searches" }} />);
    const nav = screen.getByRole("navigation", { name: "Popular searches" });
    const arrow = within(nav).getByRole("link", { name: "See all searches" });
    expect(arrow.getAttribute("href")).toBe("/search");
    expect(arrow.closest("ul")).toBeNull();
    expect(arrow.className).toContain("rounded-full");
    expect(arrow.className).toContain("min-w-touch");
    expect(arrow.querySelector("svg")).not.toBeNull();
  });

  test("arrow is omitted for an unsafe href or a blank label", () => {
    const a = render(<ChipRow label="A" items={POPULAR} more={{ href: "https://evil.example", label: "More" }} />);
    expect(within(a.container).queryByRole("link", { name: "More" })).toBeNull();
    a.unmount();
    const b = render(<ChipRow label="B" items={POPULAR} more={{ href: "/search", label: "  " }} />);
    expect(within(b.container).getAllByRole("link")).toHaveLength(3);
  });
});

describe("ChipRow 320px layout contract", () => {
  test("scroll layout scrolls inside its own list; the nav never exceeds its container", () => {
    const { container } = render(<ChipRow label="A" items={POPULAR} className="mt-4" />);
    const nav = container.querySelector("nav");
    expect(nav?.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "max-w-full", "mt-4"]));
    const ul = container.querySelector("ul");
    expect(ul?.className.split(" ")).toEqual(expect.arrayContaining(["overflow-x-auto", "flex-nowrap", "min-w-0"]));
    for (const li of Array.from(container.querySelectorAll("li"))) expect(li.className).toContain("shrink-0");
  });

  test("wrap layout wraps chips and lets long words break", () => {
    const { container } = render(<ChipRow label="A" items={POPULAR} layout="wrap" />);
    const ul = container.querySelector("ul");
    expect(ul?.className).toContain("flex-wrap");
    expect(ul?.className).not.toContain("overflow-x-auto");
    const chip = container.querySelector("li a");
    expect(chip?.className).toContain("max-w-full");
    expect(chip?.className).toContain("wrap-anywhere");
  });

  test("no fixed widths that could force page scroll at 320px", () => {
    const html = renderToStaticMarkup(<ChipRow label="A" items={POPULAR} more={{ href: "/search", label: "More" }} />);
    const classes = Array.from(html.matchAll(/class="([^"]*)"/g)).flatMap((m) => (m[1] ?? "").split(/\s+/));
    const fixed = classes.filter((c) => /^(w|min-w)-(?!0$|full$|touch$|auto$)/.test(c));
    expect(fixed).toEqual([]);
  });
});
