import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  Pagination,
  PaginationSummary,
  formatPaginationSummary,
  getPaginationItems,
  normalizePage,
  normalizePageCount,
} from "./Pagination";

const hrefFor = (p: number) => `/search?q=shoes&page=${p}`;

describe("getPaginationItems", () => {
  test.each([
    [1, 1, [1]],
    [3, 7, [1, 2, 3, 4, 5, 6, 7]],
    [1, 10, [1, 2, 3, 4, 5, "ellipsis-end", 10]],
    [5, 10, [1, "ellipsis-start", 4, 5, 6, "ellipsis-end", 10]],
    [10, 10, [1, "ellipsis-start", 6, 7, 8, 9, 10]],
  ] as const)("page %i of %i", (page, count, expected) => {
    expect(getPaginationItems(page, count)).toEqual([...expected]);
  });

  test("honours sibling and boundary counts", () => {
    expect(getPaginationItems(10, 20, 2, 2)).toEqual([
      1, 2, "ellipsis-start", 8, 9, 10, 11, 12, "ellipsis-end", 19, 20,
    ]);
  });

  test("empty for zero pages", () => {
    expect(getPaginationItems(1, 0)).toEqual([]);
  });
});

describe("Pagination", () => {
  test("renders a labelled nav with real links", () => {
    render(<Pagination page={5} pageCount={10} hrefFor={hrefFor} />);
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(within(nav).getByRole("link", { name: "Page 4" })).toHaveAttribute(
      "href",
      "/search?q=shoes&page=4",
    );
  });

  test("current page has aria-current and a non-colour indicator", () => {
    render(<Pagination page={5} pageCount={10} hrefFor={hrefFor} />);
    const current = screen.getByRole("link", { name: "Page 5" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveClass("border", "font-semibold", "underline");
    expect(screen.getByRole("link", { name: "Page 6" })).not.toHaveAttribute("aria-current");
  });

  test("prev/next carry rel and point to adjacent pages", () => {
    render(<Pagination page={5} pageCount={10} hrefFor={hrefFor} />);
    const prev = screen.getByRole("link", { name: "Previous page" });
    const next = screen.getByRole("link", { name: "Next page" });
    expect(prev).toHaveAttribute("rel", "prev");
    expect(prev).toHaveAttribute("href", hrefFor(4));
    expect(next).toHaveAttribute("rel", "next");
    expect(next).toHaveAttribute("href", hrefFor(6));
    expect(prev).toHaveClass("min-h-touch", "min-w-touch");
  });

  test("prev is disabled (not a link) on page 1; next on the last page", () => {
    const { rerender } = render(<Pagination page={1} pageCount={10} hrefFor={hrefFor} />);
    expect(screen.queryByRole("link", { name: "Previous page" })).toBeNull();
    const prev = document.querySelector('[data-edge="prev"]') as HTMLElement;
    expect(prev).toHaveAttribute("aria-disabled", "true");
    expect(prev.tagName).toBe("SPAN");
    rerender(<Pagination page={10} pageCount={10} hrefFor={hrefFor} />);
    expect(screen.queryByRole("link", { name: "Next page" })).toBeNull();
    expect(document.querySelector('[data-edge="next"]')).toHaveAttribute("aria-disabled", "true");
  });

  test("ellipses are hidden from assistive tech", () => {
    render(<Pagination page={5} pageCount={10} hrefFor={hrefFor} />);
    const ellipses = screen.getAllByText("…");
    expect(ellipses).toHaveLength(2);
    for (const e of ellipses) expect(e).toHaveAttribute("aria-hidden", "true");
  });

  test("clamps an out-of-range page", () => {
    render(<Pagination page={99} pageCount={3} hrefFor={hrefFor} />);
    expect(screen.getByRole("link", { name: "Page 3" })).toHaveAttribute("aria-current", "page");
  });

  test("renders nothing for a single page", () => {
    const { container } = render(<Pagination page={1} pageCount={1} hrefFor={hrefFor} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("no-JS: server HTML is plain anchors with hrefs and rel", () => {
    const html = renderToStaticMarkup(<Pagination page={2} pageCount={5} hrefFor={hrefFor} />);
    expect(html).toContain('<nav aria-label="Pagination"');
    expect(html).toContain('href="/search?q=shoes&amp;page=1"');
    expect(html).toMatch(/rel="prev"/);
    expect(html).toMatch(/rel="next"/);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("<button");
  });

  test("onPageChange intercepts plain clicks but not modified clicks", () => {
    const onPageChange = mock();
    render(<Pagination page={2} pageCount={5} hrefFor={hrefFor} onPageChange={onPageChange} />);
    const page3 = screen.getByRole("link", { name: "Page 3" });
    const plain = fireEvent.click(page3);
    expect(plain).toBe(false); // default prevented
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("link", { name: "Next page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    onPageChange.mockClear();
    fireEvent.click(page3, { metaKey: true });
    expect(onPageChange).not.toHaveBeenCalled();
  });

  test("links are keyboard reachable in order prev, pages, next", () => {
    render(<Pagination page={2} pageCount={3} hrefFor={hrefFor} />);
    const names = screen.getAllByRole("link").map((a) => a.getAttribute("aria-label"));
    expect(names).toEqual(["Previous page", "Page 1", "Page 2", "Page 3", "Next page"]);
  });

  test("custom label, ref and className", () => {
    const ref = createRef<HTMLElement>();
    render(
      <Pagination page={1} pageCount={2} hrefFor={hrefFor} label="Reviews pages" ref={ref} className="x-pg" />,
    );
    const nav = screen.getByRole("navigation", { name: "Reviews pages" });
    expect(ref.current).toBe(nav);
    expect(nav.className.endsWith("x-pg")).toBe(true);
  });
});

describe("PaginationSummary", () => {
  test("formats the visible range", () => {
    expect(formatPaginationSummary(1, 24, 312)).toBe("Showing 1–24 of 312 results");
    expect(formatPaginationSummary(13, 24, 312)).toBe("Showing 289–312 of 312 results");
    expect(formatPaginationSummary(2, 10, 1500, "reviews")).toBe("Showing 11–20 of 1,500 reviews");
    expect(formatPaginationSummary(1, 24, 0)).toBe("No results");
  });

  test("renders a paragraph and merges className", () => {
    render(<PaginationSummary page={1} pageSize={24} total={312} className="x-sum" />);
    const p = screen.getByText("Showing 1–24 of 312 results");
    expect(p.tagName).toBe("P");
    expect(p.className.endsWith("x-sum")).toBe(true);
  });

describe("hostile input", () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5, -3])("page=%p normalises to page 1", (page) => {
    const { container } = render(<Pagination page={page} pageCount={5} hrefFor={hrefFor} />);
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.innerHTML).not.toContain("Infinity");
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Page 1");
  });

  test("normalizePage / normalizePageCount", () => {
    expect(normalizePage(Number.NaN, 5)).toBe(1);
    expect(normalizePage(9, 5)).toBe(5);
    expect(normalizePage(0, 5)).toBe(1);
    expect(normalizePage(3, 5)).toBe(3);
    expect(normalizePageCount(Number.NaN)).toBe(0);
    expect(normalizePageCount(4.9)).toBe(4);
  });

  test("pageCount NaN/Infinity renders nothing", () => {
    const a = render(<Pagination page={1} pageCount={Number.NaN} hrefFor={hrefFor} />);
    expect(a.container).toBeEmptyDOMElement();
    const b = render(<Pagination page={1} pageCount={Number.POSITIVE_INFINITY} hrefFor={hrefFor} />);
    expect(b.container).toBeEmptyDOMElement();
  });

  test("getPaginationItems survives NaN sibling/boundary counts", () => {
    expect(getPaginationItems(5, 10, Number.NaN, Number.NaN)).toEqual([
      1, "ellipsis-start", 4, 5, 6, "ellipsis-end", 10,
    ]);
  });

  test("formatPaginationSummary never prints NaN", () => {
    expect(formatPaginationSummary(Number.NaN, 24, 312)).toBe("Showing 1\u201324 of 312 results");
    expect(formatPaginationSummary(1, Number.NaN, 312)).toBe("No results");
    expect(formatPaginationSummary(1, 24, Number.NaN)).toBe("No results");
    expect(formatPaginationSummary(Number.POSITIVE_INFINITY, 24, 312)).toBe("Showing 1\u201324 of 312 results");
  });
});
});
