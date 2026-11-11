// QA (QA-W0-D2, criteria 1, 2, 3, 9, 10): Skeleton, ProgressBar, Table, Breadcrumb, Pagination.
// Adversarial re-check of P2-D2; does not import the implementer's colocated tests.
import { describe, expect, test } from "bun:test";
import { act, createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { Skeleton } from "@/components/atoms/Skeleton";
import { ProgressBar, clampProgress } from "@/components/atoms/ProgressBar";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/atoms/Table";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import {
  Pagination,
  PaginationSummary,
  formatPaginationSummary,
  getPaginationItems,
} from "@/components/atoms/Pagination";
import { expectFocused } from "@/test/dom-assertions";

const ARBITRARY = /(^|\s)[a-z0-9:-]*-\[[^\]]+\]/;

function allClasses(root: Element): string[] {
  return [root, ...Array.from(root.querySelectorAll("*"))].flatMap((el) =>
    (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
  );
}

// ---------------------------------------------------------------- 1 Skeleton
describe("Skeleton (criterion 1)", () => {
  test("text/rect/circle all aria-hidden, pulse only under motion-safe, no arbitrary values", () => {
    for (const variant of ["text", "rect", "circle"] as const) {
      const { container, unmount } = render(<Skeleton variant={variant} />);
      const root = container.firstElementChild as HTMLElement;
      expect(root).toHaveAttribute("aria-hidden", "true");
      expect(root.dataset.variant).toBe(variant);
      const classes = allClasses(root);
      expect(classes).toContain("motion-safe:animate-pulse");
      expect(classes).toContain("bg-skeleton");
      expect(classes).not.toContain("animate-pulse");
      expect(classes.some((c) => ARBITRARY.test(` ${c}`))).toBe(false);
      unmount();
    }
  });

  test("circle uses rounded-full; rect uses rounded-md", () => {
    const { container } = render(
      <>
        <Skeleton variant="circle" data-testid="c" />
        <Skeleton variant="rect" data-testid="r" />
      </>,
    );
    expect(container.querySelector("[data-testid=c]")?.className).toContain("rounded-full");
    expect(container.querySelector("[data-testid=r]")?.className).toContain("rounded-md");
  });

  test.each([
    [3, 3],
    [1, 1],
    [0, 1],
    [-5, 1],
    [2.9, 2],
  ])("lines=%p renders %p line(s)", (lines, expected) => {
    const { container } = render(<Skeleton lines={lines} />);
    expect(container.querySelectorAll("[data-skeleton-line]")).toHaveLength(expected);
  });

  test("multi-line: last line is 2/3 wide, single line is full", () => {
    const { container, rerender } = render(<Skeleton lines={3} />);
    const lines = container.querySelectorAll("[data-skeleton-line]");
    expect(lines[2]?.className).toContain("w-2/3");
    expect(lines[0]?.className).toContain("w-full");
    rerender(<Skeleton lines={1} />);
    expect(container.querySelector("[data-skeleton-line]")?.className).toContain("w-full");
  });

  test("className merged last, ref forwarded (text and rect)", () => {
    const ref = createRef<HTMLDivElement>();
    const { container, rerender } = render(<Skeleton ref={ref} className="qa-last" />);
    expect(ref.current).toBe(container.firstElementChild as HTMLDivElement);
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
    rerender(<Skeleton variant="rect" ref={ref} className="qa-last" />);
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
  });

  // D2-1: NaN -> Math.max(1, NaN) = NaN -> zero lines; doc says "min 1".
  test("DEFECT D2-1: lines=NaN still renders at least 1 line", () => {
    const { container } = render(<Skeleton lines={Number.NaN} />);
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBeGreaterThanOrEqual(1);
  });

  // D2-1: lines=Infinity -> Array.from({ length: Infinity }) throws RangeError, crashing the tree.
  test("DEFECT D2-1: lines=Infinity does not throw", () => {
    expect(() => render(<Skeleton lines={Number.POSITIVE_INFINITY} />)).not.toThrow();
  });
});

// ------------------------------------------------------------- 2 ProgressBar
describe("ProgressBar (criterion 2)", () => {
  test.each([
    [50, 100, 50, "50%"],
    [-10, 100, 0, "0%"],
    [150, 100, 100, "100%"],
    [Number.NaN, 100, 0, "0%"],
    [Number.POSITIVE_INFINITY, 100, 0, "0%"],
    [3, 4, 3, "75%"],
  ])("value=%p max=%p -> valuenow %p, width %p", (value, max, now, width) => {
    render(<ProgressBar label="Progress" value={value} max={max} />);
    const bar = screen.getByRole("progressbar", { name: "Progress" });
    expect(bar).toHaveAttribute("aria-valuenow", String(now));
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", String(max));
    expect(bar).toHaveAttribute("aria-valuetext", width);
    expect(screen.getByTestId("progress-fill").style.width).toBe(width);
  });

  test.each([0, -1, Number.NaN])("max=%p falls back to 100", (max) => {
    render(<ProgressBar label="P" value={20} max={max} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
  });

  test("clampProgress pure helper", () => {
    expect(clampProgress(-1, 10)).toBe(0);
    expect(clampProgress(11, 10)).toBe(10);
    expect(clampProgress(Number.NaN, 10)).toBe(0);
  });

  test("visible label wires aria-labelledby; hideLabel uses aria-label and renders no visible label", () => {
    const { unmount } = render(<ProgressBar label="Free shipping" value={10} />);
    const bar = screen.getByRole("progressbar", { name: "Free shipping" });
    expect(bar).toHaveAttribute("aria-labelledby");
    expect(bar).not.toHaveAttribute("aria-label");
    expect(screen.getByText("Free shipping")).toBeVisible();
    unmount();
    render(<ProgressBar label="Free shipping" value={10} hideLabel />);
    const hidden = screen.getByRole("progressbar", { name: "Free shipping" });
    expect(hidden).toHaveAttribute("aria-label", "Free shipping");
    expect(hidden).not.toHaveAttribute("aria-labelledby");
    expect(screen.queryByText("Free shipping")).toBeNull();
  });

  test("valueText overrides aria-valuetext and its visible copy is aria-hidden", () => {
    render(<ProgressBar label="Ship" value={40} valueText="$12.50 away from free shipping" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "$12.50 away from free shipping",
    );
    expect(screen.getByText("$12.50 away from free shipping")).toHaveAttribute("aria-hidden", "true");
  });

  test("tones map to accent/success/warning fills", () => {
    for (const [tone, cls] of [
      ["accent", "bg-accent"],
      ["success", "bg-success"],
      ["warning", "bg-warning"],
    ] as const) {
      const { unmount } = render(<ProgressBar label="t" value={1} tone={tone} />);
      expect(screen.getByTestId("progress-fill").className.split(" ")).toContain(cls);
      unmount();
    }
  });

  test("indeterminate omits valuenow/min/max, sets aria-busy, no inline style, pulse motion-safe", () => {
    render(<ProgressBar label="Loading" indeterminate value={70} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).not.toHaveAttribute("aria-valuemin");
    expect(bar).not.toHaveAttribute("aria-valuemax");
    expect(bar).toHaveAttribute("aria-busy", "true");
    const fill = screen.getByTestId("progress-fill");
    expect(fill.getAttribute("style")).toBeNull();
    expect(fill.className).toContain("motion-safe:animate-pulse");
  });

  test("the fill width is the ONLY inline style in the rendered tree", () => {
    const html = renderToStaticMarkup(
      <ProgressBar label="x" value={33} valueText="v" showValue tone="warning" size="sm" />,
    );
    const styles = html.match(/style="[^"]*"/g) ?? [];
    expect(styles).toEqual(['style="width:33%"']);
  });

  test("ref goes to role=progressbar; className merged last on wrapper", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<ProgressBar label="r" ref={ref} className="qa-last" />);
    expect(ref.current).toBe(screen.getByRole("progressbar") as HTMLDivElement);
    expect((container.firstElementChild as HTMLElement).className.split(" ").at(-1)).toBe("qa-last");
  });

  // D2-2: label is typed `string`, but "" passes the type check and leaves the progressbar unnamed.
  test("DEFECT D2-2: label='' must not produce an unnamed progressbar", () => {
    render(<ProgressBar label="" value={10} hideLabel />);
    const bar = screen.getByRole("progressbar");
    const name = bar.getAttribute("aria-label") ?? "";
    expect(name.trim().length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------- 3 Table
function SampleTable(props: { striped?: boolean; compact?: boolean; caption?: boolean; hidden?: boolean }) {
  return (
    <Table
      label="Order lines"
      striped={props.striped}
      density={props.compact ? "compact" : "regular"}
      className="qa-last"
      wrapperClassName="qa-wrap"
    >
      {props.caption ? <TableCaption visuallyHidden={props.hidden}>Your orders</TableCaption> : null}
      <TableHead>
        <TableRow>
          <TableHeaderCell sort="asc">Item</TableHeaderCell>
          <TableHeaderCell sort="desc">Date</TableHeaderCell>
          <TableHeaderCell sort="none">Status</TableHeaderCell>
          <TableHeaderCell numeric>Price</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          <TableHeaderCell scope="row">Mug</TableHeaderCell>
          <TableCell>Nov 1</TableCell>
          <TableCell>Shipped</TableCell>
          <TableCell numeric>$12.00</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe("Table (criterion 3)", () => {
  test("scroll wrapper: role=region, aria-label, tabIndex=0, overflow-x-auto, wrapperClassName last", () => {
    render(<SampleTable />);
    const region = screen.getByRole("region", { name: "Order lines" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className.split(" ")).toContain("overflow-x-auto");
    expect(region.className.split(" ").at(-1)).toBe("qa-wrap");
    expect(within(region).getByRole("table").className.split(" ").at(-1)).toBe("qa-last");
  });

  test("region is reachable by keyboard focus", () => {
    render(<SampleTable />);
    const region = screen.getByRole("region", { name: "Order lines" });
    region.focus();
    expectFocused(region);
  });

  test("header scope defaults to col; scope=row honoured; sort -> aria-sort; none -> 'none', no arrow", () => {
    render(<SampleTable />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.getAttribute("scope"))).toEqual(["col", "col", "col", "col"]);
    expect(headers[0]).toHaveAttribute("aria-sort", "ascending");
    expect(headers[1]).toHaveAttribute("aria-sort", "descending");
    expect(headers[2]).toHaveAttribute("aria-sort", "none");
    expect(headers[3]).not.toHaveAttribute("aria-sort");
    expect(within(headers[2] as HTMLElement).queryByTestId("sort-indicator")).toBeNull();
    const arrow = within(headers[0] as HTMLElement).getByTestId("sort-indicator");
    expect(arrow).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("rowheader", { name: "Mug" })).toHaveAttribute("scope", "row");
  });

  test("numeric cells/headers are end-aligned with tabular-nums; explicit align wins", () => {
    render(
      <table>
        <tbody>
          <tr>
            <TableCell numeric data-testid="n">1</TableCell>
            <TableCell numeric align="center" data-testid="nc">2</TableCell>
            <TableCell data-testid="s">x</TableCell>
          </tr>
        </tbody>
      </table>,
    );
    const n = screen.getByTestId("n").className.split(" ");
    expect(n).toContain("text-end");
    expect(n).toContain("tabular-nums");
    expect(screen.getByTestId("nc").className.split(" ")).toContain("text-center");
    expect(screen.getByTestId("s").className.split(" ")).toContain("text-start");
  });

  test("density + striped set the group data attributes the cell/row variants read", () => {
    const { rerender } = render(<SampleTable striped compact />);
    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("data-compact");
    expect(table).toHaveAttribute("data-striped");
    expect(table.className).toContain("group/table");
    expect(screen.getAllByRole("row")[0]?.className).toContain("group-data-striped/table:even:bg-surface-sunken");
    expect(screen.getByRole("cell", { name: "Nov 1" }).className).toContain("group-data-compact/table:py-1");
    rerender(<SampleTable />);
    expect(table).not.toHaveAttribute("data-compact");
    expect(table).not.toHaveAttribute("data-striped");
  });

  test("caption optional; visuallyHidden caption still names the table", () => {
    const { unmount } = render(<SampleTable />);
    expect(screen.getByRole("table").querySelector("caption")).toBeNull();
    unmount();
    render(<SampleTable caption hidden />);
    const cap = screen.getByText("Your orders");
    expect(cap.tagName).toBe("CAPTION");
    expect(cap.className.split(" ")).toContain("sr-only");
    expect(screen.getByRole("table", { name: "Your orders" })).toBeInTheDocument();
  });

  test("refs forwarded on every Table part", () => {
    const refs = {
      table: createRef<HTMLTableElement>(),
      thead: createRef<HTMLTableSectionElement>(),
      tbody: createRef<HTMLTableSectionElement>(),
      tr: createRef<HTMLTableRowElement>(),
      th: createRef<HTMLTableCellElement>(),
      td: createRef<HTMLTableCellElement>(),
      cap: createRef<HTMLTableCaptionElement>(),
    };
    render(
      <Table label="r" ref={refs.table}>
        <TableCaption ref={refs.cap}>c</TableCaption>
        <TableHead ref={refs.thead}>
          <TableRow ref={refs.tr}>
            <TableHeaderCell ref={refs.th}>h</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody ref={refs.tbody}>
          <tr>
            <TableCell ref={refs.td}>d</TableCell>
          </tr>
        </TableBody>
      </Table>,
    );
    expect(refs.table.current?.tagName).toBe("TABLE");
    expect(refs.cap.current?.tagName).toBe("CAPTION");
    expect(refs.thead.current?.tagName).toBe("THEAD");
    expect(refs.tbody.current?.tagName).toBe("TBODY");
    expect(refs.tr.current?.tagName).toBe("TR");
    expect(refs.th.current?.tagName).toBe("TH");
    expect(refs.td.current?.tagName).toBe("TD");
  });

  test("10k rows render without error", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => i);
    const { container } = render(
      <Table label="big">
        <TableBody>
          {rows.map((i) => (
            <TableRow key={i}>
              <TableCell numeric>{i}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>,
    );
    // querySelectorAll instead of getAllByRole: the role query allocates ~680 MB on 10k rows (TEST-MEM).
    expect(container.querySelectorAll("tbody tr")).toHaveLength(10_000);
  });
});

// -------------------------------------------------------------- 9 Breadcrumb
const crumbs = [
  { label: "Home", href: "/" },
  { label: "Kitchen", href: "/c/kitchen" },
  { label: "Coffee", href: "/c/kitchen/coffee" },
  { label: "Drippers", href: "/c/kitchen/coffee/drippers" },
  { label: "Ceramic Pour-Over" },
];

describe("Breadcrumb (criterion 9)", () => {
  test("nav landmark + ol, last item aria-current=page, separators aria-hidden", () => {
    render(<Breadcrumb items={crumbs} />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    const list = nav.querySelector("ol");
    expect(list).not.toBeNull();
    expect(within(nav).getAllByRole("listitem")).toHaveLength(5);
    const current = within(nav).getByText("Ceramic Pour-Over");
    expect(current).toHaveAttribute("aria-current", "page");
    const seps = nav.querySelectorAll("[data-breadcrumb-separator]");
    expect(seps).toHaveLength(4);
    for (const s of Array.from(seps)) expect(s).toHaveAttribute("aria-hidden", "true");
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
  });

  test("last item with href still gets aria-current=page (via Link isCurrent)", () => {
    render(<Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Here", href: "/here" }]} />);
    expect(screen.getByRole("link", { name: "Here" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  test("server markup (no JS) contains ALL items even with maxItems=2", () => {
    const html = renderToStaticMarkup(<Breadcrumb items={crumbs} maxItems={2} />);
    for (const c of crumbs) expect(html).toContain(c.label);
    expect(html).not.toContain("<button");
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("<ol");
  });

  test("hydration: SSR shows all, then collapses after hydrating without mismatch", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(<Breadcrumb items={crumbs} maxItems={3} />);
    expect(container.querySelectorAll("li")).toHaveLength(5);
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <Breadcrumb items={crumbs} maxItems={3} />, {
        onRecoverableError: (e) => errors.push(e),
      });
    });
    expect(errors).toEqual([]);
    // first + ellipsis + last 2
    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(container.querySelector("button")).not.toBeNull();
    await act(async () => root?.unmount());
    container.remove();
  });

  test("keyboard: activating ellipsis reveals items and moves focus to first revealed link", () => {
    render(<Breadcrumb items={crumbs} maxItems={3} />);
    const btn = screen.getByRole("button", { name: "Show 2 more breadcrumb levels" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    btn.focus();
    fireEvent.click(btn);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expectFocused(screen.getByRole("link", { name: "Kitchen" }));
  });

  test("hostile maxItems: 0, -1, NaN do not crash; values below 2 treated as 2", () => {
    for (const maxItems of [0, -1, 1]) {
      const { unmount } = render(<Breadcrumb items={crumbs} maxItems={maxItems} />);
      expect(screen.getAllByRole("listitem")).toHaveLength(3); // first + ellipsis + last
      unmount();
    }
    const { unmount } = render(<Breadcrumb items={crumbs} maxItems={Number.NaN} />);
    // NaN: documents behaviour - must at least render every label or a working collapse
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    unmount();
  });

  test("empty items and single item do not crash; single item is current", () => {
    const { unmount } = render(<Breadcrumb items={[]} />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    unmount();
    render(<Breadcrumb items={[{ label: "Home", href: "/" }]} />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });

  test("className merged last, ref forwarded to nav", () => {
    const ref = createRef<HTMLElement>();
    render(<Breadcrumb items={crumbs} ref={ref} className="qa-last" />);
    expect(ref.current?.tagName).toBe("NAV");
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
  });

  // D2-3: when the first revealed item has no href it is a plain <span> (not focusable), so
  // expanding removes the focused button and focus falls to <body>.
  test("DEFECT D2-3: expanding keeps focus inside the nav when the first revealed item has no href", () => {
    const items = [
      { label: "Home", href: "/" },
      { label: "Department" },
      { label: "Aisle", href: "/a" },
      { label: "Shelf", href: "/s" },
      { label: "Product" },
    ];
    render(<Breadcrumb items={items} maxItems={3} />);
    const btn = screen.getByRole("button");
    btn.focus();
    fireEvent.click(btn);
    const nav = screen.getByRole("navigation");
    expect(nav.contains(document.activeElement)).toBe(true);
  });
});

// -------------------------------------------------------------- 10 Pagination
const hrefFor = (p: number) => `/search?q=mug&page=${p}`;

describe("Pagination (criterion 10)", () => {
  test("nav landmark, real links via hrefFor, current aria-current, rel prev/next", () => {
    render(<Pagination page={5} pageCount={10} hrefFor={hrefFor} />);
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    const current = within(nav).getByRole("link", { name: "Page 5" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("href", "/search?q=mug&page=5");
    const prev = within(nav).getByRole("link", { name: "Previous page" });
    const next = within(nav).getByRole("link", { name: "Next page" });
    expect(prev).toHaveAttribute("rel", "prev");
    expect(prev).toHaveAttribute("href", hrefFor(4));
    expect(next).toHaveAttribute("rel", "next");
    expect(next).toHaveAttribute("href", hrefFor(6));
    expect(within(nav).getAllByRole("link").filter((a) => a.getAttribute("aria-current"))).toHaveLength(1);
  });

  test("first page: Previous is a non-link with aria-disabled; last page: Next likewise", () => {
    const { container, unmount } = render(<Pagination page={1} pageCount={4} hrefFor={hrefFor} />);
    expect(screen.queryByRole("link", { name: "Previous page" })).toBeNull();
    const prev = container.querySelector("[data-edge=prev]");
    expect(prev?.tagName).toBe("SPAN");
    expect(prev).toHaveAttribute("aria-disabled", "true");
    expect(prev?.hasAttribute("href")).toBe(false);
    unmount();
    const r = render(<Pagination page={4} pageCount={4} hrefFor={hrefFor} />);
    expect(screen.queryByRole("link", { name: "Next page" })).toBeNull();
    expect(r.container.querySelector("[data-edge=next]")).toHaveAttribute("aria-disabled", "true");
  });

  test.each([1, 0, -3, Number.NaN, Number.POSITIVE_INFINITY])("pageCount=%p renders nothing", (pageCount) => {
    const { container } = render(<Pagination page={1} pageCount={pageCount} hrefFor={hrefFor} />);
    expect(container.innerHTML).toBe("");
  });

  test("ellipses: boundary + siblings, gaps of exactly one page show the page", () => {
    expect(getPaginationItems(1, 10)).toEqual([1, 2, 3, 4, 5, "ellipsis-end", 10]);
    expect(getPaginationItems(5, 10)).toEqual([1, "ellipsis-start", 4, 5, 6, "ellipsis-end", 10]);
    expect(getPaginationItems(10, 10)).toEqual([1, "ellipsis-start", 6, 7, 8, 9, 10]);
    expect(getPaginationItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(getPaginationItems(1, 2)).toEqual([1, 2]);
    // no ellipsis may hide only a single page
    for (let pc = 1; pc <= 30; pc++) {
      for (let p = 1; p <= pc; p++) {
        const items = getPaginationItems(p, pc);
        const nums = items.filter((i): i is number => typeof i === "number");
        expect(nums).toContain(1);
        expect(nums).toContain(pc);
        expect(nums).toContain(p);
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (typeof it === "string") {
            const before = items[i - 1] as number;
            const after = items[i + 1] as number;
            expect(after - before).toBeGreaterThan(2);
          }
        }
        // strictly increasing numbers
        for (let i = 1; i < nums.length; i++) expect(nums[i]! > nums[i - 1]!).toBe(true);
      }
    }
  });

  test("ellipses rendered aria-hidden; 10k pages renders a bounded number of links", () => {
    render(<Pagination page={5000} pageCount={10_000} hrefFor={hrefFor} />);
    const nav = screen.getByRole("navigation");
    expect(within(nav).getAllByRole("link").length).toBeLessThanOrEqual(9);
    const ellipses = Array.from(nav.querySelectorAll("li")).filter((li) => li.textContent === "…");
    expect(ellipses).toHaveLength(2);
    for (const e of ellipses) expect(e).toHaveAttribute("aria-hidden", "true");
  });

  test("page out of range is clamped (page 99 of 5 -> current 5; page -2 -> 1)", () => {
    const { unmount } = render(<Pagination page={99} pageCount={5} hrefFor={hrefFor} />);
    expect(screen.getByRole("link", { name: "Page 5" })).toHaveAttribute("aria-current", "page");
    unmount();
    render(<Pagination page={-2} pageCount={5} hrefFor={hrefFor} />);
    expect(screen.getByRole("link", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
  });

  test("no-JS HTML shape: static markup has anchors with href and rel", () => {
    const html = renderToStaticMarkup(<Pagination page={2} pageCount={3} hrefFor={hrefFor} />);
    expect(html).toContain('<nav aria-label="Pagination"');
    expect(html).toMatch(/<a [^>]*href="\/search\?q=mug&amp;page=1"[^>]*rel="prev"|<a [^>]*rel="prev"[^>]*href="\/search\?q=mug&amp;page=1"/);
    expect(html).toMatch(/aria-current="page"/);
  });

  test("touch targets: links and disabled edges carry min-h-touch min-w-touch", () => {
    const { container } = render(<Pagination page={1} pageCount={3} hrefFor={hrefFor} />);
    for (const el of Array.from(container.querySelectorAll("a, [data-edge]"))) {
      const cls = (el.getAttribute("class") ?? "").split(" ");
      expect(cls).toContain("min-h-touch");
      expect(cls).toContain("min-w-touch");
    }
  });

  test("onPageChange: plain click intercepted, modified click not", () => {
    const calls: number[] = [];
    render(<Pagination page={1} pageCount={3} hrefFor={hrefFor} onPageChange={(p) => calls.push(p)} />);
    const link = screen.getByRole("link", { name: "Page 2" });
    const plain = fireEvent.click(link, { button: 0 });
    expect(plain).toBe(false); // default prevented
    expect(calls).toEqual([2]);
    fireEvent.click(link, { button: 0, metaKey: true });
    expect(calls).toEqual([2]);
  });

  test("className merged last, ref forwarded", () => {
    const ref = createRef<HTMLElement>();
    render(<Pagination page={1} pageCount={3} hrefFor={hrefFor} ref={ref} className="qa-last" />);
    expect(ref.current?.tagName).toBe("NAV");
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
  });

  // D2-4: page=NaN -> current=NaN; no aria-current, and Previous/Next become links to hrefFor(NaN).
  test("DEFECT D2-4: page=NaN is treated as page 1 (no 'page=NaN' hrefs, one current page)", () => {
    const { container } = render(<Pagination page={Number.NaN} pageCount={5} hrefFor={hrefFor} />);
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });
});

describe("PaginationSummary (criterion 10)", () => {
  test.each([
    [1, 24, 312, "Showing 1–24 of 312 results"],
    [2, 24, 312, "Showing 25–48 of 312 results"],
    [13, 24, 312, "Showing 289–312 of 312 results"],
    [99, 24, 312, "Showing 289–312 of 312 results"],
    [0, 24, 312, "Showing 1–24 of 312 results"],
    [1, 24, 0, "No results"],
    [1, 50, 10, "Showing 1–10 of 10 results"],
    [1, 24, 1, "Showing 1–1 of 1 results"],
    [1, 1000, 12345, "Showing 1–1,000 of 12,345 results"],
    [1, 0, 10, "No results"],
    [1, 24, -5, "No results"],
  ])("page %p, size %p, total %p -> %p", (page, size, total, text) => {
    expect(formatPaginationSummary(page, size, total)).toBe(text);
  });

  test("component renders the text, merges className last, forwards ref", () => {
    const ref = createRef<HTMLParagraphElement>();
    render(<PaginationSummary page={1} pageSize={24} total={312} itemLabel="products" ref={ref} className="qa-last" />);
    expect(screen.getByText("Showing 1–24 of 312 products")).toBe(ref.current as HTMLParagraphElement);
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
  });

  // D2-5: NaN inputs leak into user-visible text ("Showing NaN–NaN of 312 results").
  test("DEFECT D2-5: NaN page/pageSize/total never produce 'NaN' text", () => {
    expect(formatPaginationSummary(Number.NaN, 24, 312)).not.toContain("NaN");
    expect(formatPaginationSummary(1, Number.NaN, 312)).not.toContain("NaN");
    expect(formatPaginationSummary(1, 24, Number.NaN)).not.toContain("NaN");
  });
});
