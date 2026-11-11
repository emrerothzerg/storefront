import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewActionFn, VoteActionFn } from "@/components/molecules/_contracts/review-actions";
import type { ReviewSummary as ReviewSummaryData } from "@/lib/types";
import { DEFAULT_REVIEW_PAGE_SIZE, type ReviewListResult, type ReviewView } from "@/server/reviews/review-service";
import {
  REVIEWS_EMPTY_MESSAGE,
  REVIEWS_NO_MATCH_MESSAGE,
  REVIEWS_PAGE_SIZE,
  ReviewsSection,
  type ReviewsSectionProps,
} from "./ReviewsSection";

const submitReview: ReviewActionFn = async () => null;
const voteReviewHelpful: VoteActionFn = async () => null;

function review(n: number, over: Partial<ReviewView> = {}): ReviewView {
  return {
    id: `rev-${n}`,
    productId: "prod-1",
    displayName: `Shopper ${n}`,
    rating: 4,
    title: `Review title ${n}`,
    body: `Body ${n}`,
    verifiedPurchase: n % 2 === 0,
    helpfulCount: n,
    status: "published",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...over,
  };
}

const summary: ReviewSummaryData = { count: 23, avg: 4.2, histogram: { 5: 12, 4: 6, 3: 3, 2: 1, 1: 1 } };
const emptySummary: ReviewSummaryData = { count: 0, avg: 0, histogram: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } };

function list(over: Partial<ReviewListResult> = {}): ReviewListResult {
  return {
    items: Array.from({ length: 10 }, (_, i) => review(i + 1)),
    total: 23,
    page: 1,
    pageCount: 3,
    summary,
    ...over,
  };
}

function props(over: Partial<ReviewsSectionProps> = {}): ReviewsSectionProps {
  return {
    productId: "prod-1",
    productSlug: "desk-lamp",
    list: list(),
    query: { sort: "helpful" },
    basePath: "/products/desk-lamp",
    actions: { submitReview, voteReviewHelpful },
    viewer: { signedInName: null, alreadyReviewed: false },
    ...over,
  };
}

function writeDetails(container: HTMLElement): HTMLDetailsElement {
  const el = container.querySelector("#write-review-disclosure");
  if (!(el instanceof HTMLDetailsElement)) throw new Error("no write-review disclosure");
  return el;
}

describe("ReviewsSection", () => {
  test("page size mirrors the service default", () => {
    expect(REVIEWS_PAGE_SIZE).toBe(DEFAULT_REVIEW_PAGE_SIZE);
  });

  test("section #reviews is labelled by the 'Customer reviews' heading; #write-review exists", () => {
    const { container } = render(<ReviewsSection {...props()} />);
    const section = container.querySelector("section#reviews");
    expect(section).not.toBeNull();
    const heading = screen.getByRole("heading", { level: 2, name: "Customer reviews" });
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
    expect(screen.getByRole("region", { name: "Customer reviews" })).toBe(section as HTMLElement);
    expect(container.querySelector("form#write-review")).not.toBeNull();
    expect(writeDetails(container).open).toBe(false);
  });

  test("reviews are a semantic list of ReviewCards with titles one level below", () => {
    render(<ReviewsSection {...props()} />);
    const listEl = screen.getByRole("list", { name: "Reviews" });
    expect(listEl.tagName).toBe("UL");
    const items = within(listEl).getAllByRole("listitem");
    expect(items).toHaveLength(10);
    expect(within(listEl).getAllByRole("heading", { level: 3 })).toHaveLength(10);
    expect(screen.getByText("Showing 1–10 of 23 reviews")).toBeInTheDocument();
  });

  test("headingLevel 3 -> h3 section heading and h4 review titles", () => {
    render(<ReviewsSection {...props({ headingLevel: 3 })} />);
    expect(screen.getByRole("heading", { level: 3, name: "Customer reviews" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Reviews" })).getAllByRole("heading", { level: 4 })).toHaveLength(10);
  });

  test("histogram rows link to star filters (page dropped); active row has aria-current=page", () => {
    render(<ReviewsSection {...props({ query: { sort: "recent", stars: 4 }, list: list({ page: 2 }) })} />);
    expect(screen.getByRole("link", { name: "5 star: 52%" })).toHaveAttribute(
      "href",
      "/products/desk-lamp?sort=recent&stars=5#reviews",
    );
    expect(screen.getByRole("link", { name: "4 star: 26%" })).toHaveAttribute("aria-current", "page");
  });

  test("filter chips: All stars current with no filter; verified toggle link", () => {
    render(<ReviewsSection {...props({ list: list({ page: 2 }) })} />);
    const filters = screen.getByRole("list", { name: "Review filters" });
    const all = within(filters).getByRole("link", { name: "All stars" });
    expect(all).toHaveAttribute("aria-current");
    expect(all).toHaveAttribute("href", "/products/desk-lamp#reviews");
    const verified = within(filters).getByRole("link", { name: "Verified purchase only" });
    expect(verified).not.toHaveAttribute("aria-current");
    expect(verified).toHaveAttribute("href", "/products/desk-lamp?verified=1#reviews");
    expect(within(filters).queryByRole("link", { name: /Remove filter/ })).toBeNull();
  });

  test("active star filter shows a removal chip; verified on toggles off; All stars not current", () => {
    render(<ReviewsSection {...props({ query: { sort: "recent", stars: 4, verifiedOnly: true } })} />);
    const filters = screen.getByRole("list", { name: "Review filters" });
    expect(within(filters).getByRole("link", { name: "All stars" })).not.toHaveAttribute("aria-current");
    expect(within(filters).getByRole("link", { name: "Remove filter: 4 stars" })).toHaveAttribute(
      "href",
      "/products/desk-lamp?sort=recent&verified=1#reviews",
    );
    const verified = within(filters).getByRole("link", { name: "Verified purchase only" });
    expect(verified).toHaveAttribute("aria-current");
    expect(verified).toHaveAttribute("href", "/products/desk-lamp?sort=recent&stars=4#reviews");
  });

  test("1-star filter label is singular", () => {
    render(<ReviewsSection {...props({ query: { sort: "helpful", stars: 1 } })} />);
    expect(screen.getByRole("link", { name: "Remove filter: 1 star" })).toBeInTheDocument();
  });

  test("sort is a GET form to basePath#reviews with hidden filters, labelled Select and visible Apply", () => {
    render(<ReviewsSection {...props({ query: { sort: "recent", stars: 2, verifiedOnly: true } })} />);
    const form = screen.getByRole("form", { name: "Sort reviews" });
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/products/desk-lamp#reviews");
    const select = within(form).getByLabelText("Sort by");
    expect(select).toHaveAttribute("name", "sort");
    expect((select as HTMLSelectElement).value).toBe("recent");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Top reviews", "Most recent"]);
    const hidden = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')).map((i) => [i.name, i.value]);
    expect(hidden).toEqual([
      ["stars", "2"],
      ["verified", "1"],
    ]);
    expect(form.querySelector('input[name="rpage"]')).toBeNull();
    expect(within(form).getByRole("button", { name: "Apply" })).toHaveAttribute("type", "submit");
  });

  test("pagination links keep filters and set rpage; current page aria-current; unique landmark name", () => {
    render(<ReviewsSection {...props({ query: { sort: "recent", stars: 5 }, list: list({ page: 2 }) })} />);
    const nav = screen.getByRole("navigation", { name: "Reviews pagination" });
    expect(within(nav).getByRole("link", { name: "Page 3" })).toHaveAttribute(
      "href",
      "/products/desk-lamp?sort=recent&stars=5&rpage=3#reviews",
    );
    expect(within(nav).getByRole("link", { name: "Page 1" })).toHaveAttribute(
      "href",
      "/products/desk-lamp?sort=recent&stars=5#reviews",
    );
    expect(within(nav).getByRole("link", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Showing 11–20 of 23 reviews")).toBeInTheDocument();
  });

  test("pageCount 0 or 1 -> no pagination", () => {
    const { unmount } = render(<ReviewsSection {...props({ list: list({ items: [review(1)], total: 1, pageCount: 1 }) })} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    unmount();
    render(<ReviewsSection {...props({ list: list({ items: [], total: 0, pageCount: 0 }) })} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  test("no reviews at all: 'Be the first' empty state, form OPEN, no controls/list/pagination", () => {
    const { container } = render(
      <ReviewsSection
        {...props({ list: { items: [], total: 0, page: 1, pageCount: 0, summary: emptySummary } })}
      />,
    );
    expect(screen.getByText(REVIEWS_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(writeDetails(container).open).toBe(true);
    expect(container.querySelector("form#write-review")).not.toBeNull();
    expect(screen.queryByTestId("reviews-controls")).toBeNull();
    expect(screen.queryByRole("list", { name: "Reviews" })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  test("filters with zero matches: 'No reviews match' + Clear filters (keeps sort), form collapsed", () => {
    const { container } = render(
      <ReviewsSection
        {...props({
          query: { sort: "recent", stars: 1, verifiedOnly: true },
          list: list({ items: [], total: 0, pageCount: 0 }),
        })}
      />,
    );
    expect(screen.getByText(REVIEWS_NO_MATCH_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/products/desk-lamp?sort=recent#reviews",
    );
    expect(screen.queryByText(REVIEWS_EMPTY_MESSAGE)).toBeNull();
    expect(screen.queryByRole("list", { name: "Reviews" })).toBeNull();
    expect(screen.getByTestId("reviews-controls")).toBeInTheDocument();
    expect(writeDetails(container).open).toBe(false);
  });

  test("page beyond the last page: explains and links to page 1", () => {
    render(<ReviewsSection {...props({ query: { sort: "recent" }, list: list({ items: [], page: 9 }) })} />);
    expect(screen.getByRole("link", { name: "Go to the first page of reviews" })).toHaveAttribute(
      "href",
      "/products/desk-lamp?sort=recent#reviews",
    );
    expect(screen.queryByText(REVIEWS_NO_MATCH_MESSAGE)).toBeNull();
  });

  test("already reviewed: form replaced by the notice, #write-review anchor kept, no disclosure", () => {
    const { container } = render(
      <ReviewsSection {...props({ viewer: { signedInName: "Ann", alreadyReviewed: true } })} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("You already reviewed this product.");
    expect(container.querySelector("#write-review")).not.toBeNull();
    expect(container.querySelector("form#write-review")).toBeNull();
    expect(container.querySelector("#write-review-disclosure")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();
  });

  test("signed-in name is passed to the form", () => {
    render(<ReviewsSection {...props({ viewer: { signedInName: "Ann", alreadyReviewed: false } })} />);
    expect(screen.getByText("Posting as Ann")).toBeInTheDocument();
  });

  test("hostile review content renders as text only", () => {
    const hostile = review(1, {
      displayName: '<img src=x onerror="alert(1)">',
      title: "<b>bold</b>",
      body: '<script>alert("xss")</script>',
    });
    const markup = renderToStaticMarkup(
      <ReviewsSection {...props({ list: list({ items: [hostile], total: 1, pageCount: 1 }) })} />,
    );
    // React appends its own form-replay <script> for action forms; the review body must not add one.
    expect(markup).not.toContain("<script>alert");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("&lt;script&gt;");
    const { container } = render(
      <ReviewsSection {...props({ list: list({ items: [hostile], total: 1, pageCount: 1 }) })} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
  });

  test("renderToStaticMarkup: GET links/forms and both ids, no JS needed", () => {
    const markup = renderToStaticMarkup(
      <ReviewsSection {...props({ query: { sort: "recent", stars: 4 }, list: list({ page: 2 }) })} />,
    );
    expect(markup).toContain('id="reviews"');
    expect(markup).toContain('id="write-review"');
    expect(markup).toContain('method="get"');
    expect(markup).toContain('action="/products/desk-lamp#reviews"');
    expect(markup).toContain('href="/products/desk-lamp?sort=recent&amp;stars=4&amp;rpage=3#reviews"');
    expect(markup).toContain('href="/products/desk-lamp?sort=recent#reviews"');
    expect(markup).toContain('aria-current="page"');
  });

  test("320px-safe: wrapping controls and shrinkable containers", () => {
    const { container } = render(<ReviewsSection {...props()} />);
    expect(container.querySelector("section#reviews")).toHaveClass("min-w-0");
    expect(screen.getByRole("list", { name: "Review filters" })).toHaveClass("flex-wrap", "min-w-0");
    expect(screen.getByRole("form", { name: "Sort reviews" })).toHaveClass("flex-wrap", "min-w-0");
    expect(container.innerHTML).not.toMatch(/\b(w|min-w)-\d{3,}\b/);
  });
});

describe("ReviewsSection: Phase 3 restyle (T160)", () => {
  const classesOf = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

  test("summary sits on a white card; controls on a light-grey band; review list on a white card", () => {
    const { container } = render(<ReviewsSection {...props()} />);
    const summaryCard = container.querySelector('[data-testid="reviews-summary-card"]');
    expect(summaryCard).toHaveClass("bg-surface-raised", "border", "border-border-default", "rounded-lg", "shadow-sm");
    // The heading still names the section and lives inside the card.
    expect(summaryCard?.querySelector("#reviews-heading")).not.toBeNull();
    expect(container.querySelector("section#reviews")).toHaveAttribute("aria-labelledby", "reviews-heading");

    const controls = container.querySelector('[data-testid="reviews-controls"]');
    expect(controls).toHaveClass("bg-surface-sunken", "rounded-lg");

    const listCard = container.querySelector('[data-testid="reviews-list-card"]');
    expect(listCard).toHaveClass("bg-surface-raised", "rounded-lg");
    expect(listCard?.querySelector('ul[aria-label="Reviews"]')).not.toBeNull();
  });

  test("Apply is a pill button with a 44px target; the sort form is still a plain GET form", () => {
    render(<ReviewsSection {...props()} />);
    const form = screen.getByRole("form", { name: "Sort reviews" });
    expect(form).toHaveAttribute("method", "get");
    const apply = within(form).getByRole("button", { name: "Apply" });
    expect(apply).toHaveClass("rounded-full", "min-h-touch");
  });

  test("histogram: token-coloured bars and the percentage as visible text", () => {
    const { container } = render(<ReviewsSection {...props()} />);
    const fills = container.querySelectorAll('[data-testid="progress-fill"]');
    expect(fills).toHaveLength(5);
    for (const fill of fills) expect(fill).toHaveClass("bg-accent");
    // 12 of 23 five-star ratings -> 52%, shown as text (not colour only).
    const fiveStar = screen.getByRole("link", { name: "5 star: 52%" });
    expect(fiveStar).toHaveTextContent("52%");
    expect(fiveStar.getAttribute("href")).toBe("/products/desk-lamp?stars=5#reviews");
  });

  test("empty and recovery states use a grey band; recovery links are pill buttons with unchanged hrefs", () => {
    const empty = render(<ReviewsSection {...props({ list: list({ items: [], total: 0, pageCount: 0, summary: emptySummary }) })} />);
    expect(empty.container.querySelector('[data-testid="reviews-empty"]')?.closest(".bg-surface-sunken")).not.toBeNull();
    empty.unmount();

    const noMatch = render(
      <ReviewsSection
        {...props({ query: { sort: "recent", stars: 1 }, list: list({ items: [], total: 0, pageCount: 0 }) })}
      />,
    );
    const clear = screen.getByRole("link", { name: "Clear filters" });
    expect(clear).toHaveAttribute("href", "/products/desk-lamp?sort=recent#reviews");
    expect(clear).toHaveClass("rounded-full", "min-h-touch");
    expect(noMatch.container.querySelector('[data-testid="reviews-no-match"]')).toHaveClass("bg-surface-sunken");
    noMatch.unmount();

    render(<ReviewsSection {...props({ list: list({ items: [], page: 9 }) })} />);
    const first = screen.getByRole("link", { name: "Go to the first page of reviews" });
    expect(first).toHaveAttribute("href", "/products/desk-lamp#reviews");
    expect(first).toHaveClass("rounded-full", "min-h-touch");
  });

  test("write-review panel: white card disclosure, #write-review form still inside, Posting as shown", () => {
    const { container } = render(
      <ReviewsSection {...props({ viewer: { signedInName: "Ada", alreadyReviewed: false } })} />,
    );
    const details = writeDetails(container);
    expect(details).toHaveClass("rounded-lg", "bg-surface-raised", "shadow-sm");
    expect(details.querySelector("#write-review")).not.toBeNull();
    expect(details).toHaveTextContent("Posting as Ada");
  });

  test("hostile review text stays text inside the restyled list card", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <ReviewsSection {...props({ list: list({ items: [review(1, { title: evil, body: evil, displayName: evil })] }) })} />,
    );
    const listCard = container.querySelector('[data-testid="reviews-list-card"]');
    expect(listCard?.querySelector("img[onerror]")).toBeNull();
    expect(listCard).toHaveTextContent(evil);
  });

  test("tokens only: no arbitrary values, palette colours or theme-variant utilities in the section", () => {
    const { container } = render(<ReviewsSection {...props({ query: { sort: "helpful", stars: 3 } })} />);
    const section = container.querySelector("section#reviews");
    const all = [section, ...(section?.querySelectorAll("*") ?? [])].flatMap((el) => classesOf(el));
    // Built from pieces so no source file contains the theme-variant literal (guard G02).
    const forbidden = new RegExp(["\\[", "^" + "da" + "rk" + ":", "-(red|blue|gray|slate|zinc|neutral)-\\d"].join("|"));
    expect(all.filter((c) => forbidden.test(c))).toEqual([]);
  });
});
