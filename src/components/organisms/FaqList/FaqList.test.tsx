import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { FAQ_ENTRIES, type FaqEntry } from "@/content/faq";
import { isAllowedInternalHref } from "@/content/routes";
import { FAQ_RELATED_LABEL, FaqList, faqRelatedLinkLabel, safeRelatedHrefs } from "./index";

const HOSTILE = `<script>alert(1)</script><img src=x onerror="alert(2)">`;

function entry(slug: string, over: Partial<FaqEntry> = {}): FaqEntry {
  return {
    slug,
    question: `Question ${slug}?`,
    answer: [`Answer ${slug} one.`, `Answer ${slug} two.`],
    topic: "ordering",
    ...over,
  };
}

describe("faq-links", () => {
  test("labels come from navigation, else the humanized segment", () => {
    expect(faqRelatedLinkLabel("/signup")).toBe("Create account");
    expect(faqRelatedLinkLabel("/account/settings")).toBe("Settings");
    expect(faqRelatedLinkLabel("/returns")).toBe("Returns and refunds");
    expect(faqRelatedLinkLabel("/checkout")).toBe("Checkout");
    expect(faqRelatedLinkLabel("/help/shipping-and-delivery#x")).toBe("Shipping and delivery");
  });

  test("footer quick links label related links: /contact reads Contact us; /orders keeps the account label", () => {
    expect(faqRelatedLinkLabel("/contact")).toBe("Contact us");
    expect(faqRelatedLinkLabel("/contact?topic=feedback")).toBe("Contact us");
    expect(faqRelatedLinkLabel("/orders")).toBe("Your orders");
    expect(faqRelatedLinkLabel("/compare")).toBe("Compare products");
  });

  test("safeRelatedHrefs drops bad and duplicate hrefs", () => {
    expect(
      safeRelatedHrefs(["/cart", "javascript:alert(1)", "//evil.example", "https://evil.example", "/cart", "/nope-route", "/orders"]),
    ).toEqual(["/cart", "/orders"]);
    expect(safeRelatedHrefs(undefined)).toEqual([]);
  });
});

describe("FaqList", () => {
  test("renderToStaticMarkup: native details with ids, all collapsed by default", () => {
    const html = renderToStaticMarkup(<FaqList entries={[entry("a"), entry("b")]} />);
    expect(html).toContain('<details id="a"');
    expect(html).toContain('<details id="b"');
    expect(html).not.toContain(" open");
    expect(html).not.toMatch(/\shidden[\s=>]/);
  });

  test("each entry is a <details id=slug> with the question in <summary> and answers as <p>", () => {
    const { container } = render(<FaqList entries={[entry("first"), entry("second")]} />);
    const details = Array.from(container.querySelectorAll("details"));
    expect(details.map((d) => d.id)).toEqual(["first", "second"]);
    const first = details[0];
    if (!first) throw new Error("missing");
    expect(first.querySelector("summary")).toHaveTextContent("Question first?");
    expect(Array.from(first.querySelectorAll("p")).map((p) => p.textContent)).toEqual([
      "Answer first one.",
      "Answer first two.",
    ]);
    expect(first.open).toBe(false);
  });

  test("openSlug opens exactly the matching entry", () => {
    const { container } = render(<FaqList entries={[entry("a"), entry("b"), entry("c")]} openSlug="b" />);
    expect(Array.from(container.querySelectorAll("details")).map((d) => d.open)).toEqual([false, true, false]);
    const none = render(<FaqList entries={[entry("x")]} openSlug="nope" />);
    expect(none.container.querySelector("details")?.open).toBe(false);
  });

  test("summary is keyboard operable (native summary) and toggles on click", () => {
    const { container } = render(<FaqList entries={[entry("k")]} />);
    const summary = container.querySelector("summary");
    if (!summary) throw new Error("no summary");
    expect(summary.closest("details")?.id).toBe("k");
    // A <summary> is focusable and activated by Enter/Space natively; it has no tabindex override.
    expect(summary.hasAttribute("tabindex")).toBe(false);
    fireEvent.click(summary);
    expect(container.querySelector("details")?.open).toBe(true);
  });

  test("related links: label, valid ones only, allowlisted", () => {
    const { container } = render(
      <FaqList
        entries={[entry("r", { relatedHrefs: ["/cart", "javascript:alert(1)", "//evil.example", "/signup"] })]}
        openSlug="r"
      />,
    );
    const details = container.querySelector("details");
    if (!details) throw new Error("missing");
    expect(within(details).getByText(FAQ_RELATED_LABEL)).toBeInTheDocument();
    const links = within(details).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/cart", "/signup"]);
    expect(links.map((a) => a.textContent)).toEqual(["Your cart", "Create account"]);
  });

  test("no related block when there are no valid links; custom label", () => {
    const { container, rerender } = render(<FaqList entries={[entry("n", { relatedHrefs: ["https://x.example"] })]} />);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.queryByText(FAQ_RELATED_LABEL)).toBeNull();
    rerender(<FaqList entries={[entry("n", { relatedHrefs: ["/cart"] })]} relatedLabel="See also" />);
    expect(screen.getByText("See also")).toBeInTheDocument();
  });

  test("hostile question/answer render as text", () => {
    const { container } = render(<FaqList entries={[entry("h", { question: HOSTILE, answer: [HOSTILE] })]} openSlug="h" />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("summary")?.textContent).toBe(HOSTILE);
    expect(container.querySelector("details p")?.textContent).toBe(HOSTILE);
  });

  test("duplicate slugs keep only the first entry", () => {
    const { container } = render(
      <FaqList entries={[entry("d", { question: "First" }), entry("d", { question: "Second" })]} />,
    );
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(container.querySelector("summary")).toHaveTextContent("First");
  });

  test("optional title uses headingLevel", () => {
    const { rerender } = render(<FaqList entries={[entry("t")]} title="Ordering" />);
    expect(screen.getByRole("heading", { level: 2, name: "Ordering" })).toBeInTheDocument();
    rerender(<FaqList entries={[entry("t")]} title="Ordering" headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Ordering" })).toBeInTheDocument();
    rerender(<FaqList entries={[entry("t")]} headingLevel={3} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  test("all real FAQ entries: unique ids equal to slugs, every href allowlisted", () => {
    const { container } = render(<FaqList entries={FAQ_ENTRIES} />);
    const ids = Array.from(container.querySelectorAll("details")).map((d) => d.id);
    expect(ids).toEqual(FAQ_ENTRIES.map((e) => e.slug));
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
    const expected = FAQ_ENTRIES.reduce((n, e) => n + safeRelatedHrefs(e.relatedHrefs).length, 0);
    expect(container.querySelectorAll("a")).toHaveLength(expected);
  });
});

describe("FaqList: Phase 3 look (T162)", () => {
  test("entries are bordered white disclosures; ids and summaries unchanged", () => {
    const { container } = render(<FaqList entries={[entry("a"), entry("b")]} />);
    const details = Array.from(container.querySelectorAll("details"));
    expect(details.map((d) => d.id)).toEqual(["a", "b"]);
    for (const d of details) {
      expect(d).toHaveClass("rounded-lg", "border-border-default", "bg-surface-raised", "scroll-mt-4");
      expect(d.querySelector(":scope > summary")).not.toBeNull();
    }
  });
});
