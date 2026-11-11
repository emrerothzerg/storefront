import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewSummary as ReviewSummaryData, StarRating } from "@/lib/types";
import { ReviewSummary, starPercent } from "./ReviewSummary";

const hrefForStars = (n: StarRating) => `?stars=${n}#reviews`;

const summary: ReviewSummaryData = {
  count: 8,
  avg: 4.1,
  histogram: { 5: 5, 4: 1, 3: 1, 2: 0, 1: 1 },
};

const empty: ReviewSummaryData = { count: 0, avg: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

describe("starPercent", () => {
  test("rounds and clamps; zero total never divides", () => {
    expect(starPercent(5, 8)).toBe(63);
    expect(starPercent(1, 3)).toBe(33);
    expect(starPercent(0, 0)).toBe(0);
    expect(starPercent(4, 0)).toBe(0);
    expect(starPercent(10, 5)).toBe(100);
    expect(starPercent(Number.NaN, 5)).toBe(0);
    expect(starPercent(-2, 5)).toBe(0);
    expect(starPercent(2, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("ReviewSummary", () => {
  test("shows the average, the global ratings count and a heading at the given level", () => {
    render(<ReviewSummary summary={summary} hrefForStars={hrefForStars} headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Customer reviews" })).toBeInTheDocument();
    expect(screen.getByText("4.1 out of 5 stars")).toBeInTheDocument();
    expect(screen.getByText("8 global ratings")).toBeInTheDocument();
  });

  test("defaults to an h2 and never renders an h1", () => {
    render(<ReviewSummary summary={summary} hrefForStars={hrefForStars} />);
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  test("singular 'global rating' for one review", () => {
    render(
      <ReviewSummary
        summary={{ count: 1, avg: 5, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } }}
        hrefForStars={hrefForStars}
      />,
    );
    expect(screen.getByText("1 global rating")).toBeInTheDocument();
  });

  test("five histogram rows, 5 star first, each a link named 'N star: X%' with its filter href", () => {
    render(<ReviewSummary summary={summary} hrefForStars={hrefForStars} />);
    const links = within(screen.getByRole("list")).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual([
      "5 star: 63%",
      "4 star: 13%",
      "3 star: 13%",
      "2 star: 0%",
      "1 star: 13%",
    ]);
    expect(screen.getByRole("link", { name: "5 star: 63%" })).toHaveAttribute("href", "?stars=5#reviews");
    expect(screen.getByRole("link", { name: "2 star: 0%" })).toHaveAttribute("href", "?stars=2#reviews");
    // Visible text is part of the name (label-in-name) and not colour-only.
    expect(links[0]).toHaveTextContent("5 star");
    expect(links[0]).toHaveTextContent("63%");
  });

  test("progress bars are decorative: hidden from assistive tech and not in the link name", () => {
    render(<ReviewSummary summary={summary} hrefForStars={hrefForStars} />);
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    const bars = document.querySelectorAll('[role="progressbar"]');
    expect(bars).toHaveLength(5);
    for (const bar of bars) {
      expect(bar).toHaveAttribute("aria-hidden", "true");
      expect(bar.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    const fill = within(screen.getByRole("link", { name: "5 star: 63%" }).parentElement as HTMLElement)
      .getByTestId("progress-fill");
    expect(fill.style.width).toBe("63%");
  });

  test("only the active row carries aria-current", () => {
    render(<ReviewSummary summary={summary} hrefForStars={hrefForStars} activeStars={4} />);
    const current = screen.getAllByRole("link").filter((l) => l.hasAttribute("aria-current"));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("4 star: 13%");
    expect(current[0]).not.toHaveAttribute("aria-current", "false");
  });

  test("no active row without activeStars (or an out-of-range value)", () => {
    const { rerender } = render(<ReviewSummary summary={summary} hrefForStars={hrefForStars} />);
    expect(document.querySelectorAll("[aria-current]")).toHaveLength(0);
    rerender(<ReviewSummary summary={summary} hrefForStars={hrefForStars} activeStars={9} />);
    expect(document.querySelectorAll("[aria-current]")).toHaveLength(0);
  });

  test("zero reviews: 'No reviews yet', no rows, no links, no NaN", () => {
    const { container } = render(<ReviewSummary summary={empty} hrefForStars={hrefForStars} />);
    expect(screen.getByText("No reviews yet")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("list")).toBeNull();
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).not.toContain("Infinity");
  });

  test("corrupt summary data (NaN/negative count) is treated as no reviews", () => {
    const { container } = render(
      <ReviewSummary
        summary={{ count: Number.NaN, avg: Number.NaN, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }}
        hrefForStars={hrefForStars}
      />,
    );
    expect(screen.getByText("No reviews yet")).toBeInTheDocument();
    expect(container.textContent).not.toContain("NaN");
  });

  test("server-safe: renders to static markup with real anchors (no JS needed)", () => {
    const html = renderToStaticMarkup(<ReviewSummary summary={summary} hrefForStars={hrefForStars} activeStars={5} />);
    expect(html.match(/<a /g)).toHaveLength(5);
    expect(html).toContain('href="?stars=1#reviews"');
    expect(html).toContain("8 global ratings");
  });

  test("token classes only and 320px-safe: wraps, no fixed widths; className merges", () => {
    const { container } = render(
      <ReviewSummary summary={summary} hrefForStars={hrefForStars} className="mt-4" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("mt-4", "min-w-0");
    const classes = Array.from(container.querySelectorAll("[class]"))
      .map((el) => el.getAttribute("class") ?? "")
      .join(" ");
    expect(classes).not.toMatch(/\[/);
    expect(classes).not.toMatch(/(^|\s)w-(?!full)\d/);
  });

  test("forwards ref to the root element", () => {
    let node: HTMLDivElement | null = null;
    render(
      <ReviewSummary
        summary={summary}
        hrefForStars={hrefForStars}
        ref={(el) => {
          node = el;
        }}
      />,
    );
    expect(node).toBeInstanceOf(HTMLDivElement);
  });
});

describe("ReviewSummary average display", () => {
  test("displayed average is clamped to [0, 5] like the stars", () => {
    const { rerender } = render(<ReviewSummary summary={{ ...summary, avg: 7.3 }} hrefForStars={hrefForStars} />);
    expect(screen.getByText("5.0 out of 5")).toBeInTheDocument();
    rerender(<ReviewSummary summary={{ ...summary, avg: -2 }} hrefForStars={hrefForStars} />);
    expect(screen.getByText("0.0 out of 5")).toBeInTheDocument();
  });

  test("non-finite average with a positive count shows 'No reviews yet'", () => {
    for (const avg of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { container, unmount } = render(<ReviewSummary summary={{ ...summary, avg }} hrefForStars={hrefForStars} />);
      expect(screen.getByText("No reviews yet")).toBeInTheDocument();
      expect(container.querySelector("ul")).toBeNull();
      expect(container.textContent).not.toMatch(/NaN|Infinity/);
      unmount();
    }
  });
});
