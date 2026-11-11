import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseContactTopic } from "@/app/contact/_lib/contact-page";
import { CONTACT_TOPICS as SERVER_TOPICS } from "@/server/contact/contact-service";
import { CONTACT_TOPICS as FORM_TOPICS } from "../ContactForm";
import { FeedbackBlock } from "./FeedbackBlock";
import {
  DEFAULT_FEEDBACK_SUGGESTIONS,
  FEEDBACK_COPY,
  FEEDBACK_HREF,
  feedbackHeading,
  resolveFeedbackSuggestions,
  type FeedbackSuggestion,
} from "./feedback-helpers";

const HEADING = "Did you find what you were looking for?";

function suggestionLinks(): HTMLElement[] {
  return within(screen.getByRole("list")).getAllByRole("link");
}

describe("FeedbackBlock", () => {
  test("section named by an h2 'Did you find what you were looking for?'", () => {
    render(<FeedbackBlock />);
    const region = screen.getByRole("region", { name: HEADING });
    const h2 = within(region).getByRole("heading", { level: 2 });
    expect(h2.textContent).toBe(HEADING);
    expect(region.querySelectorAll("h1, h3, h4, h5, h6")).toHaveLength(0);
  });

  test("'Give feedback' link targets exactly /contact?topic=feedback", () => {
    render(<FeedbackBlock />);
    const links = screen.getAllByRole("link", { name: "Give feedback" });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/contact?topic=feedback");
    expect(FEEDBACK_HREF).toBe("/contact?topic=feedback");
    expect(links[0]?.className).toContain("rounded-full");
    expect(screen.getByText(FEEDBACK_COPY.band)).toBeInTheDocument();
  });

  test("the feedback topic exists in the service, the form and the /contact parser (ruling O-4)", () => {
    const topic = new URL(FEEDBACK_HREF, "http://localhost").searchParams.get("topic");
    expect(topic).toBe("feedback");
    expect(SERVER_TOPICS).toContain("feedback");
    expect(FORM_TOPICS).toContain("feedback");
    expect(parseContactTopic("feedback")).toBe("feedback");
  });

  test("defaults: three suggestion links (all products, deals, help)", () => {
    render(<FeedbackBlock />);
    expect(suggestionLinks().map((a) => [a.textContent, a.getAttribute("href")])).toEqual(
      DEFAULT_FEEDBACK_SUGGESTIONS.map((s) => [s.label, s.href]),
    );
  });

  test("caller suggestions: at most three, invalid ones dropped", () => {
    render(
      <FeedbackBlock
        suggestions={[
          { label: "Bad", href: "https://evil.example" },
          { label: "Toys", href: "/category/toys" },
          { label: "Acme", href: "/brand/acme" },
          { label: "New arrivals", href: "/new-arrivals" },
          { label: "Best sellers", href: "/best-sellers" },
        ]}
      />,
    );
    expect(suggestionLinks().map((a) => a.getAttribute("href"))).toEqual(["/category/toys", "/brand/acme", "/new-arrivals"]);
  });

  test("one valid caller suggestion is topped up to two", () => {
    render(<FeedbackBlock suggestions={[{ label: "Toys", href: "/category/toys" }, { label: "x", href: "javascript:alert(1)" }]} />);
    expect(suggestionLinks().map((a) => a.getAttribute("href"))).toEqual(["/category/toys", "/products"]);
  });

  test("no form, inputs, buttons, iframes or scripts; complete without JS", () => {
    const { container } = render(<FeedbackBlock />);
    expect(container.querySelectorAll("form, input, textarea, select, button, iframe, script")).toHaveLength(0);
    const html = renderToStaticMarkup(<FeedbackBlock />);
    expect(html).toContain('href="/contact?topic=feedback"');
    expect(html).toContain(`<h2`);
    expect(html).not.toContain("<form");
  });

  test("HTML in heading and labels renders as text", () => {
    const { container } = render(
      <FeedbackBlock heading="<img src=x onerror=alert(1)>" suggestions={[{ label: "<b>Deals</b>", href: "/deals" }, { label: "Toys", href: "/category/toys" }]} />,
    );
    expect(container.querySelector("img, b, script")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("<img src=x onerror=alert(1)>");
    expect(screen.getByRole("link", { name: "<b>Deals</b>" })).toBeInTheDocument();
  });

  test("blank heading falls back to the default; an id is forwarded", () => {
    const { container } = render(<FeedbackBlock heading="   " id="search-feedback" />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(HEADING);
    expect(container.querySelector("section")?.id).toBe("search-feedback");
  });

  test("suggestion links keep a 44px target and are underlined (not colour alone)", () => {
    render(<FeedbackBlock />);
    for (const a of suggestionLinks()) {
      expect(a.className).toContain("min-h-touch");
      expect(a.className).toContain("underline");
    }
  });

  test("320px contract: stacks on mobile, no fixed widths, long text can wrap", () => {
    const long = `Super${"long".repeat(30)}`;
    const html = renderToStaticMarkup(<FeedbackBlock suggestions={[{ label: long, href: "/deals" }, { label: "Toys", href: "/category/toys" }]} />);
    const classes = Array.from(html.matchAll(/class="([^"]*)"/g)).flatMap((m) => (m[1] ?? "").split(/\s+/));
    expect(classes.filter((c) => /^(w|min-w)-(?!0$|full$|touch$|auto$)/.test(c))).toEqual([]);
    expect(classes).toEqual(expect.arrayContaining(["flex-col", "sm:flex-row", "min-w-0", "max-w-full", "wrap-anywhere"]));
  });
});

describe("FeedbackBlock truncated suggestion labels (CLEANUP-P3 ce, ChipRow parity)", () => {
  const long = "word ".repeat(20).trim();

  test("a label cut at 60 keeps the full text in both title and the accessible name", () => {
    render(<FeedbackBlock suggestions={[{ label: long, href: "/deals" }, { label: "Toys", href: "/category/toys" }]} />);
    const link = screen.getByRole("link", { name: long });
    expect(link.getAttribute("href")).toBe("/deals");
    expect(link.getAttribute("title")).toBe(long);
    expect(link.getAttribute("aria-label")).toBe(long);
    expect(link.textContent?.endsWith("…")).toBe(true);
    expect(Array.from(link.textContent ?? "").length).toBeLessThanOrEqual(60);
  });

  test("short labels have no title or aria-label (name = visible text)", () => {
    render(<FeedbackBlock suggestions={[{ label: long, href: "/deals" }, { label: "Toys", href: "/category/toys" }]} />);
    const toys = screen.getByRole("link", { name: "Toys" });
    expect(toys.hasAttribute("title")).toBe(false);
    expect(toys.hasAttribute("aria-label")).toBe(false);
  });

  test("hostile long label stays text in title and name", () => {
    const hostile = `<img src=x onerror="alert(1)"> ${long}`;
    const html = renderToStaticMarkup(
      <FeedbackBlock suggestions={[{ label: hostile, href: "/deals" }, { label: "Toys", href: "/category/toys" }]} />,
    );
    expect(html).not.toContain("<img");
    render(<FeedbackBlock suggestions={[{ label: hostile, href: "/deals" }, { label: "Toys", href: "/category/toys" }]} />);
    const link = suggestionLinks()[0];
    expect(link?.getAttribute("aria-label")).toBe(link?.getAttribute("title"));
    expect(link?.getAttribute("aria-label")?.startsWith("<img")).toBe(true);
  });
});

describe("feedback helpers", () => {
  test("labels are cleaned and truncated at 60 with the full text as title", () => {
    const long = "word ".repeat(20).trim();
    const [first] = resolveFeedbackSuggestions([{ label: `  ${long}  `, href: "/deals" }, { label: "Toys", href: "/category/toys" }]);
    expect(first?.text.endsWith("…")).toBe(true);
    expect(Array.from(first?.text ?? "").length).toBeLessThanOrEqual(60);
    expect(first?.title).toBe(long);
  });

  test("drops duplicates, the feedback link itself, blank labels and hostile hrefs", () => {
    const input: FeedbackSuggestion[] = [
      { label: "Deals", href: "/deals" },
      { label: "Deals again", href: "/deals" },
      { label: "Feedback", href: FEEDBACK_HREF },
      { label: "   ", href: "/products" },
      { label: "x", href: "//evil.example" },
      { label: "x", href: "/nope" },
    ];
    // one valid (Deals) -> topped up with /products (default) to two
    expect(resolveFeedbackSuggestions(input).map((s) => s.href)).toEqual(["/deals", "/products"]);
  });

  test("non-array input gives the three defaults", () => {
    expect(resolveFeedbackSuggestions(null)).toHaveLength(3);
    expect(resolveFeedbackSuggestions("x" as unknown as FeedbackSuggestion[])).toHaveLength(3);
    expect(resolveFeedbackSuggestions([null] as unknown as FeedbackSuggestion[])).toHaveLength(3);
  });

  test("feedbackHeading cleans, truncates at 80 and falls back", () => {
    expect(feedbackHeading("  Hi  ")).toEqual({ text: "Hi", title: undefined });
    expect(feedbackHeading(undefined).text).toBe(HEADING);
    const long = "h".repeat(100);
    const h = feedbackHeading(long);
    expect(Array.from(h.text).length).toBe(80);
    expect(h.title).toBe(long);
  });
});
