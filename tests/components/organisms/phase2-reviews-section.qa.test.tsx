// QA (QA-W4-organisms-A / T90): T76 ReviewsSection + buildReviewsHref.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewActionFn, VoteActionFn } from "@/components/molecules/_contracts/review-actions";
import { ALREADY_REVIEWED_MESSAGE } from "@/components/molecules/ReviewForm";
import {
  DEFAULT_REVIEWS_SORT,
  REVIEWS_EMPTY_MESSAGE,
  REVIEWS_NO_MATCH_MESSAGE,
  REVIEWS_PAGE_EMPTY_MESSAGE,
  REVIEWS_PAGE_SIZE,
  REVIEWS_PARAM,
  REVIEW_SORT_OPTIONS,
  ReviewsSection,
  buildReviewsHref,
  type ReviewsSectionProps,
} from "@/components/organisms/ReviewsSection";
import type { ReviewSummary as ReviewSummaryData } from "@/lib/types";
import {
  DEFAULT_REVIEW_PAGE_SIZE,
  DEFAULT_REVIEW_SORT,
  MAX_REVIEW_PAGE_SIZE,
  type ReviewListResult,
  type ReviewView,
} from "@/server/reviews/review-service";

const BASE = "/products/desk-lamp";
const submitReview: ReviewActionFn = async () => null;
const voteReviewHelpful: VoteActionFn = async () => null;

function review(n: number, over: Partial<ReviewView> = {}): ReviewView {
  return {
    id: `qa-rev-${n}`,
    productId: "prod-1",
    displayName: `QA Shopper ${n}`,
    rating: 5,
    title: `QA title ${n}`,
    body: `QA body ${n}`,
    verifiedPurchase: true,
    helpfulCount: 0,
    status: "published",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...over,
  };
}

const summary: ReviewSummaryData = { count: 30, avg: 4, histogram: { 5: 15, 4: 8, 3: 4, 2: 2, 1: 1 } };
const emptySummary: ReviewSummaryData = { count: 0, avg: 0, histogram: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } };

function list(over: Partial<ReviewListResult> = {}): ReviewListResult {
  return { items: [review(1), review(2), review(3)], total: 30, page: 1, pageCount: 3, summary, ...over };
}

function props(over: Partial<ReviewsSectionProps> = {}): ReviewsSectionProps {
  return {
    productId: "prod-1",
    productSlug: "desk-lamp",
    list: list(),
    query: { sort: "helpful" },
    basePath: BASE,
    actions: { submitReview, voteReviewHelpful },
    viewer: { signedInName: null, alreadyReviewed: false },
    ...over,
  };
}

type StateName = "populated" | "empty" | "filtered-to-zero" | "page-past-end" | "already-reviewed" | "empty+already-reviewed";
const STATES: Record<StateName, Partial<ReviewsSectionProps>> = {
  populated: {},
  empty: { list: list({ items: [], total: 0, pageCount: 0, summary: emptySummary }) },
  "filtered-to-zero": {
    list: list({ items: [], total: 0, pageCount: 0 }),
    query: { sort: "recent", stars: 1, verifiedOnly: true },
  },
  "page-past-end": { list: list({ items: [], total: 30, page: 9, pageCount: 3 }) },
  "already-reviewed": { viewer: { signedInName: "Ada", alreadyReviewed: true } },
  "empty+already-reviewed": {
    list: list({ items: [], total: 0, pageCount: 0, summary: emptySummary }),
    viewer: { signedInName: null, alreadyReviewed: true },
  },
};

function section(container: HTMLElement): HTMLElement {
  const el = container.querySelector("section#reviews");
  if (!(el instanceof HTMLElement)) throw new Error("no section#reviews");
  return el;
}

function ids(root: Element): string[] {
  return [...root.querySelectorAll("[id]")].map((el) => el.id);
}

describe("T76.3 ids, landmark and heading in every state", () => {
  for (const [name, over] of Object.entries(STATES)) {
    test(`${name}: labelled section#reviews, #write-review present, ids unique, headings do not skip`, () => {
      const { container } = render(<ReviewsSection {...props(over)} />);
      const sec = section(container);
      expect(screen.getByRole("region", { name: "Customer reviews" })).toBe(sec);
      expect(sec.querySelectorAll("#write-review")).toHaveLength(1);
      const all = ids(container);
      expect(new Set(all).size).toBe(all.length);
      const levels = [...sec.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
      expect(levels[0]).toBe(2);
      expect(levels.includes(1)).toBe(false);
      for (let i = 1; i < levels.length; i++) {
        expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
      }
    });
  }

  test("static markup (no JS) also has both ids in every state", () => {
    for (const over of Object.values(STATES)) {
      const html = renderToStaticMarkup(<ReviewsSection {...props(over)} />);
      expect(html).toContain('id="reviews"');
      expect(html).toContain('id="write-review"');
    }
  });
});

describe("T76.1 empty and no-match states", () => {
  test("empty: 'Be the first' message, form open, no controls/list/pagination", () => {
    const { container } = render(<ReviewsSection {...props(STATES.empty)} />);
    expect(screen.getByText(REVIEWS_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(REVIEWS_EMPTY_MESSAGE).toMatch(/^Be the first to review/);
    const details = container.querySelector("details");
    expect(details?.open).toBe(true);
    expect(details?.contains(container.querySelector("form#write-review"))).toBe(true);
    expect(screen.queryByRole("list", { name: "Review filters" })).toBeNull();
    expect(container.querySelector('form[method="get"]')).toBeNull();
    expect(screen.queryByRole("list", { name: "Reviews" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Reviews pagination" })).toBeNull();
  });

  test("empty: details rendered open in static markup (no JS)", () => {
    const html = renderToStaticMarkup(<ReviewsSection {...props(STATES.empty)} />);
    expect(html).toMatch(/<details[^>]*\sopen=""/);
  });

  test("populated: details closed by default", () => {
    const html = renderToStaticMarkup(<ReviewsSection {...props()} />);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  test("filtered-to-zero: message + Clear filters keeping sort; controls stay; no list/pagination", () => {
    render(<ReviewsSection {...props(STATES["filtered-to-zero"])} />);
    expect(screen.getByText(REVIEWS_NO_MATCH_MESSAGE)).toBeInTheDocument();
    expect(REVIEWS_NO_MATCH_MESSAGE).toBe("No reviews match your filters");
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", `${BASE}?sort=recent#reviews`);
    expect(screen.getByRole("list", { name: "Review filters" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Reviews" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Reviews pagination" })).toBeNull();
    expect(screen.queryByText(REVIEWS_EMPTY_MESSAGE)).toBeNull();
  });

  test("filtered-to-zero with default sort: Clear filters is the bare #reviews link", () => {
    render(
      <ReviewsSection {...props({ list: list({ items: [], total: 0, pageCount: 0 }), query: { sort: "helpful", stars: 2 } })} />,
    );
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", `${BASE}#reviews`);
  });

  test("page-past-end: explains and links to page 1 with filters kept", () => {
    render(<ReviewsSection {...props({ ...STATES["page-past-end"], query: { sort: "recent", stars: 5 } })} />);
    expect(screen.getByText(REVIEWS_PAGE_EMPTY_MESSAGE)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Go to the first page of reviews" });
    expect(link.getAttribute("href")).toBe(`${BASE}?sort=recent&stars=5#reviews`);
  });
});

describe("T76.2 plain GET controls + aria-current", () => {
  const filtered = props({ query: { sort: "recent", stars: 4, verifiedOnly: true }, list: list({ page: 2 }) });

  test("static markup: every link in the section outside the cards/form is a GET URL to basePath#reviews", () => {
    const { container } = render(<ReviewsSection {...filtered} />);
    const sec = section(container);
    const links = [...sec.querySelectorAll("a")].filter((a) => !a.closest("article") && !a.closest("form#write-review"));
    expect(links.length).toBeGreaterThan(8);
    for (const a of links) {
      const href = a.getAttribute("href") ?? "";
      expect(href.startsWith(BASE)).toBe(true);
      expect(href.endsWith("#reviews")).toBe(true);
      expect(a.getAttribute("target")).toBeNull();
    }
  });

  test("sort form: method get, action basePath#reviews, hidden stars+verified, no rpage, labelled select", () => {
    const html = renderToStaticMarkup(<ReviewsSection {...filtered} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector('form[method="get"]');
    expect(form?.getAttribute("action")).toBe(`${BASE}#reviews`);
    const hidden = [...(form?.querySelectorAll('input[type="hidden"]') ?? [])].map((i) => [
      i.getAttribute("name"),
      i.getAttribute("value"),
    ]);
    expect(hidden).toEqual([
      [REVIEWS_PARAM.stars, "4"],
      [REVIEWS_PARAM.verified, "1"],
    ]);
    expect(form?.querySelector(`[name="${REVIEWS_PARAM.page}"]`)).toBeNull();
    const select = form?.querySelector("select");
    expect(select?.getAttribute("name")).toBe("sort");
    expect(doc.querySelector(`label[for="${select?.id}"]`)?.textContent).toBe("Sort by");
    expect([...(select?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual([
      "helpful",
      "recent",
    ]);
    expect(form?.querySelector('button[type="submit"]')).not.toBeNull();
  });

  test("sort form without filters has no hidden inputs; action strips query/fragment from basePath", () => {
    const html = renderToStaticMarkup(<ReviewsSection {...props({ basePath: `${BASE}?x=1#top` })} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector('form[method="get"]');
    expect(form?.getAttribute("action")).toBe(`${BASE}#reviews`);
    expect(form?.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
  });

  test("histogram: active row aria-current=page, others none, links drop rpage", () => {
    render(<ReviewsSection {...filtered} />);
    for (const n of [5, 4, 3, 2, 1]) {
      const link = screen.getByRole("link", { name: new RegExp(`^${n} star: `) });
      expect(link.getAttribute("href")).toBe(`${BASE}?sort=recent&stars=${n}&verified=1#reviews`);
      if (n === 4) expect(link).toHaveAttribute("aria-current", "page");
      else expect(link).not.toHaveAttribute("aria-current");
    }
  });

  test("chips: aria-current='true' on selected (accepted deviation), none on unselected", () => {
    render(<ReviewsSection {...filtered} />);
    const chips = within(screen.getByRole("list", { name: "Review filters" }));
    const all = chips.getByRole("link", { name: "All stars" });
    expect(all).not.toHaveAttribute("aria-current");
    expect(all.getAttribute("href")).toBe(`${BASE}?sort=recent&verified=1#reviews`);
    const remove = chips.getByRole("link", { name: "Remove filter: 4 stars" });
    expect(remove.getAttribute("href")).toBe(`${BASE}?sort=recent&verified=1#reviews`);
    const verified = chips.getByRole("link", { name: "Verified purchase only" });
    expect(verified).toHaveAttribute("aria-current", "true");
    expect(verified.getAttribute("href")).toBe(`${BASE}?sort=recent&stars=4#reviews`);
  });

  test("chips with no filter: All stars aria-current='true'", () => {
    render(<ReviewsSection {...props()} />);
    expect(screen.getByRole("link", { name: "All stars" })).toHaveAttribute("aria-current", "true");
  });

  test("pagination: page links keep filters, aria-current=page on current, page 1 has no rpage", () => {
    render(<ReviewsSection {...filtered} />);
    const nav = screen.getByRole("navigation", { name: "Reviews pagination" });
    const p1 = within(nav).getByRole("link", { name: "Page 1" });
    expect(p1.getAttribute("href")).toBe(`${BASE}?sort=recent&stars=4&verified=1#reviews`);
    const p3 = within(nav).getByRole("link", { name: "Page 3" });
    expect(p3.getAttribute("href")).toBe(`${BASE}?sort=recent&stars=4&verified=1&rpage=3#reviews`);
    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("2");
  });

  test("pagination hidden at pageCount 0 and 1", () => {
    for (const pageCount of [0, 1]) {
      const { unmount } = render(<ReviewsSection {...props({ list: list({ pageCount, total: 3 }) })} />);
      expect(screen.queryByRole("navigation", { name: "Reviews pagination" })).toBeNull();
      unmount();
    }
  });

  test("controls are keyboard reachable: no positive tabindex, no tabindex=-1 on interactive controls", () => {
    const { container } = render(<ReviewsSection {...filtered} />);
    const interactive = section(container).querySelectorAll("a[href], button, select, input:not([type=hidden]), textarea, summary");
    expect(interactive.length).toBeGreaterThan(10);
    for (const el of interactive) {
      const ti = el.getAttribute("tabindex");
      expect(ti === null || ti === "0").toBe(true);
    }
  });
});

describe("T76.3 semantic list, max items, heading levels", () => {
  test("max page (service MAX_REVIEW_PAGE_SIZE) renders that many list items and card headings h3", () => {
    const items = Array.from({ length: MAX_REVIEW_PAGE_SIZE }, (_, i) => review(i + 1));
    render(<ReviewsSection {...props({ list: list({ items, total: 1_000_000, pageCount: 50_000, page: 25_000 }) })} />);
    const ul = screen.getByRole("list", { name: "Reviews" });
    expect(ul.tagName).toBe("UL");
    expect(within(ul).getAllByRole("listitem")).toHaveLength(MAX_REVIEW_PAGE_SIZE);
    expect(within(ul).getAllByRole("heading", { level: 3 })).toHaveLength(MAX_REVIEW_PAGE_SIZE);
    expect(within(ul).getAllByRole("article")).toHaveLength(MAX_REVIEW_PAGE_SIZE);
    const nav = screen.getByRole("navigation", { name: "Reviews pagination" });
    expect(within(nav).getByRole("link", { name: "Page 50000" }).getAttribute("href")).toBe(`${BASE}?rpage=50000#reviews`);
  });

  test("1 item: one list item, no pagination when pageCount 1", () => {
    render(<ReviewsSection {...props({ list: list({ items: [review(1)], total: 1, pageCount: 1, summary: { count: 1, avg: 5, histogram: { 5: 1, 4: 0, 3: 0, 2: 0, 1: 0 } } }) })} />);
    expect(within(screen.getByRole("list", { name: "Reviews" })).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("navigation", { name: "Reviews pagination" })).toBeNull();
  });

  test("headingLevel 3: section h3, cards h4", () => {
    render(<ReviewsSection {...props({ headingLevel: 3 })} />);
    expect(screen.getByRole("heading", { level: 3, name: "Customer reviews" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Reviews" })).getAllByRole("heading", { level: 4 })).toHaveLength(3);
  });
});

describe("T76.4 already reviewed", () => {
  test("form replaced by the notice; no review form fields, no disclosure", () => {
    const { container } = render(<ReviewsSection {...props(STATES["already-reviewed"])} />);
    const anchor = container.querySelector("#write-review");
    expect(anchor?.tagName).toBe("DIV");
    expect(anchor?.textContent).toContain(ALREADY_REVIEWED_MESSAGE);
    expect(container.querySelector("form#write-review")).toBeNull();
    expect(container.querySelector('textarea, input[name="title"]')).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText("Write a review")).toBeNull();
  });
});

describe("T76.5 hostile fixture renders as text", () => {
  const hostile = review(1, {
    title: "<script>window.__qaPwned=1</script>",
    body: '<img src=x onerror="window.__qaPwned=1"><b>bold</b> & "quotes"',
    displayName: "<b>Mallory</b>",
  });

  test("DOM: no script/img/b elements inside the reviews list; text preserved", () => {
    render(<ReviewsSection {...props({ list: list({ items: [hostile] }) })} />);
    const ul = screen.getByRole("list", { name: "Reviews" });
    expect(ul.querySelector("script, img, b, iframe")).toBeNull();
    expect(ul.textContent).toContain("<script>window.__qaPwned=1</script>");
    expect(ul.textContent).toContain("<b>Mallory</b>");
    expect(ul.textContent).toContain("<b>bold</b>");
    expect((globalThis as { __qaPwned?: number }).__qaPwned).toBeUndefined();
  });

  test("static markup escapes hostile text", () => {
    const html = renderToStaticMarkup(<ReviewsSection {...props({ list: list({ items: [hostile] }) })} />);
    // React appends its own form-replay <script> for function actions; only the hostile one matters.
    expect(html.includes("<script>window.__qaPwned")).toBe(false);
    expect(html.includes("<b>")).toBe(false);
    expect(/<img[^>]*onerror/.test(html)).toBe(false);
    expect(html.includes("&lt;script&gt;window.__qaPwned")).toBe(true);
  });

  test("source has no dangerouslySetInnerHTML", () => {
    const dir = join(import.meta.dir, "../../../src/components/organisms/ReviewsSection");
    for (const f of ["ReviewsSection.tsx", "reviews-href.ts"]) {
      expect(readFileSync(join(dir, f), "utf8")).not.toContain("dangerouslySetInnerHTML");
    }
  });
});

describe("buildReviewsHref", () => {
  test("all defaults -> bare path + #reviews", () => {
    expect(buildReviewsHref(BASE, { sort: "helpful" })).toBe(`${BASE}#reviews`);
    expect(buildReviewsHref(BASE, { sort: "helpful", rpage: 1, verifiedOnly: false })).toBe(`${BASE}#reviews`);
  });

  test("stable key order regardless of patch key order", () => {
    const a = buildReviewsHref(BASE, { sort: "helpful" }, { rpage: 4, verifiedOnly: true, stars: 3, sort: "recent" });
    expect(a).toBe(`${BASE}?sort=recent&stars=3&verified=1&rpage=4#reviews`);
    const b = buildReviewsHref(BASE, { rpage: 4, verifiedOnly: true, stars: 3, sort: "recent" });
    expect(b).toBe(a);
  });

  test("rpage dropped on sort/stars/verified change, kept otherwise", () => {
    const q = { sort: "recent" as const, stars: 2 as const, rpage: 5 };
    expect(buildReviewsHref(BASE, q)).toContain("rpage=5");
    expect(buildReviewsHref(BASE, q, { sort: "helpful" })).toBe(`${BASE}?stars=2#reviews`);
    expect(buildReviewsHref(BASE, q, { stars: 4 })).not.toContain("rpage");
    expect(buildReviewsHref(BASE, q, { verifiedOnly: true })).not.toContain("rpage");
    expect(buildReviewsHref(BASE, q, { stars: undefined })).toBe(`${BASE}?sort=recent#reviews`);
  });

  test("invalid values dropped", () => {
    const bad = [
      { sort: "evil" },
      { sort: "helpful", stars: 0 },
      { sort: "helpful", stars: 6 },
      { sort: "helpful", stars: 2.5 },
      { sort: "helpful", stars: Number.NaN },
      { sort: "helpful", stars: "3" },
      { sort: "helpful", verifiedOnly: "1" },
      { sort: "helpful", rpage: 0 },
      { sort: "helpful", rpage: -3 },
      { sort: "helpful", rpage: 1.5 },
      { sort: "helpful", rpage: Number.POSITIVE_INFINITY },
      { sort: "helpful", rpage: Number.MAX_SAFE_INTEGER + 2 },
      { sort: "helpful", rpage: "2" },
    ] as unknown as Parameters<typeof buildReviewsHref>[1][];
    for (const q of bad) expect(buildReviewsHref(BASE, q)).toBe(`${BASE}#reviews`);
  });

  test("strips query/fragment from basePath and output is URL-safe for hostile basePath tails", () => {
    expect(buildReviewsHref(`${BASE}?rpage=9&x=<script>#evil`, { sort: "recent" })).toBe(`${BASE}?sort=recent#reviews`);
    expect(buildReviewsHref(`${BASE}#a?b`, { sort: "helpful" })).toBe(`${BASE}#reviews`);
    const url = new URL(buildReviewsHref(BASE, { sort: "recent", stars: 1, verifiedOnly: true, rpage: 2 }), "https://qa.test");
    expect(url.pathname).toBe(BASE);
    expect([...url.searchParams.keys()]).toEqual(["sort", "stars", "verified", "rpage"]);
  });
});

describe("mirrored constants and server boundary", () => {
  test("page size and default sort equal the service", () => {
    expect(REVIEWS_PAGE_SIZE).toBe(DEFAULT_REVIEW_PAGE_SIZE);
    expect(DEFAULT_REVIEWS_SORT).toBe(DEFAULT_REVIEW_SORT);
    expect(REVIEW_SORT_OPTIONS.map((o) => o.value).sort()).toEqual(["helpful", "recent"]);
  });

  test("src/server imports are type-only; no 'use client'; no any / ts-ignore", () => {
    const dir = join(import.meta.dir, "../../../src/components/organisms/ReviewsSection");
    for (const f of ["ReviewsSection.tsx", "reviews-href.ts", "index.ts"]) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const line of src.split("\n").filter((l) => /from\s+["']@\/server\//.test(l))) {
        expect(line).toMatch(/^import type /);
      }
      expect(src).not.toMatch(/^["']use client["']/m);
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>|@ts-ignore|@ts-expect-error/);
    }
  });
});

describe("320px class audit", () => {
  test("no fixed widths without a breakpoint; wrapping control rows; chips and links 44px", () => {
    const { container } = render(<ReviewsSection {...props({ query: { sort: "helpful", stars: 3 } })} />);
    const sec = section(container);
    const classes = [sec, ...sec.querySelectorAll("*")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(classes.filter((c) => /^(w|min-w)-\[|^w-(\d{2,}|screen)$/.test(c))).toEqual([]);
    expect(classes.filter((c) => c.includes("!"))).toEqual([]);
    const controls = sec.querySelector('[data-testid="reviews-controls"]');
    expect(controls?.querySelector("ul")).toHaveClass("flex-wrap", "min-w-0");
    expect(controls?.querySelector("form")).toHaveClass("flex-wrap", "min-w-0");
    for (const chip of within(screen.getByRole("list", { name: "Review filters" })).getAllByRole("link")) {
      expect(chip).toHaveClass("min-h-touch");
    }
  });
});
