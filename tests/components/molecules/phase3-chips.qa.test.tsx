// QA (T147, Phase 3 wave A): ChipRow + FeedbackBlock (T142) against BACKLOG-phase3 T142 AC1-AC5,
// T147 AC4 (ChipRow encoding of &, <, emoji and 100+ char queries) and CONTRACTS H-18, L-4, L-5,
// L-19, L-21 (feedback topic; ruling O-4).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import {
  CHIP_LABEL_MAX,
  CHIP_QUERY_MAX,
  CHIP_ROW_MAX_ITEMS,
  ChipRow,
  chipLabel,
  chipSearchHref,
  chipSearchQuery,
} from "@/components/molecules/ChipRow";
import {
  DEFAULT_FEEDBACK_SUGGESTIONS,
  FEEDBACK_HREF,
  FeedbackBlock,
  resolveFeedbackSuggestions,
} from "@/components/molecules/FeedbackBlock";
import { parseContactQuery } from "@/app/contact/_lib/contact-page";
import { CONTACT_TOPICS } from "@/server/contact/contact-service";
import { isAllowedInternalHref } from "@/content/routes";

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;

function doc(el: ReactElement): Document {
  return new DOMParser().parseFromString(`<body>${renderToStaticMarkup(el)}</body>`, "text/html");
}
const cls = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const hrefs = (d: ParentNode) => [...d.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
const qOf = (href: string) => new URL(href, "http://local.invalid").searchParams.get("q");

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

// ============================================================ ChipRow
describe("T142 AC1 + H-18 / L-4: ChipRow structure", () => {
  test("<nav> named by label with a <ul> of text chip links; no headings (L-5)", () => {
    const d = doc(<ChipRow label="Popular searches" items={[{ query: "lego" }, { label: "Deals", href: "/deals" }]} />);
    const nav = d.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Popular searches");
    expect(nav?.querySelectorAll("ul > li > a").length).toBe(2);
    expect([...d.querySelectorAll("a")].map((a) => a.textContent?.trim())).toEqual(["lego", "Deals"]);
    expect(d.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
  });

  test("showLabel: nav labelled by the visible text instead of aria-label", () => {
    const d = doc(<ChipRow label="Related searches" showLabel items={[{ query: "uno" }]} />);
    const nav = d.querySelector("nav");
    expect(nav?.hasAttribute("aria-label")).toBe(false);
    const labelled = d.getElementById(nav?.getAttribute("aria-labelledby") ?? "");
    expect(labelled?.textContent).toBe("Related searches");
    expect(labelled?.tagName).toBe("P");
  });

  test("empty / all-invalid items render nothing (no empty nav)", () => {
    expect(renderToStaticMarkup(<ChipRow label="x" items={[]} />)).toBe("");
    expect(renderToStaticMarkup(<ChipRow label="x" items={[{ query: "   " }, { label: "x", href: "javascript:alert(1)" }, { label: "  ", href: "/deals" }]} />)).toBe("");
  });

  test("max 12 chips by default; duplicates (same href) dropped; maxItems 0 / negative -> nothing", () => {
    expect(CHIP_ROW_MAX_ITEMS).toBe(12);
    const items = Array.from({ length: 20 }, (_, i) => ({ query: `q${i % 15}` }));
    expect(doc(<ChipRow label="x" items={items} />).querySelectorAll("a").length).toBe(12);
    const dupes = doc(<ChipRow label="x" items={[{ query: "a" }, { query: " a " }, { query: "a", label: "Other" }]} />);
    expect(hrefs(dupes)).toEqual(["/search?q=a"]);
    expect(renderToStaticMarkup(<ChipRow label="x" maxItems={0} items={[{ query: "a" }]} />)).toBe("");
    expect(renderToStaticMarkup(<ChipRow label="x" maxItems={-3} items={[{ query: "a" }]} />)).toBe("");
  });

  test("link items must pass the allow-list", () => {
    const d = doc(<ChipRow label="x" items={["javascript:x", "//evil.example", "/no-route", "/deals"].map((href) => ({ label: href, href }))} />);
    expect(hrefs(d)).toEqual(["/deals"]);
  });
});

describe("T142 AC1/AC2 + T147 AC4: labels, truncation and query encoding", () => {
  test("labels trimmed; <= 40 code points kept whole; 41 -> 40 with an ellipsis, full text in title + accessible name", () => {
    expect(CHIP_LABEL_MAX).toBe(40);
    expect(chipLabel("  " + "a".repeat(40) + "  ")).toEqual({ text: "a".repeat(40), full: "a".repeat(40), truncated: false });
    const long = "b".repeat(41);
    const r = chipLabel(long);
    expect(r?.truncated).toBe(true);
    expect(Array.from(r?.text ?? "").length).toBe(40);
    expect(r?.text.endsWith("…")).toBe(true);
    render(<ChipRow label="x" items={[{ label: long, href: "/deals" }]} />);
    const link = screen.getByRole("link", { name: long });
    expect(link.closest("li")?.getAttribute("title")).toBe(long);
  });

  test("emoji count as one code point each and are never split", () => {
    const emoji = "😀".repeat(45);
    const r = chipLabel(emoji);
    expect(Array.from(r?.text ?? "").length).toBe(40);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(r?.text ?? "")).toBe(false);
  });

  test("& and < are percent-encoded in the href and render as text", () => {
    const d = doc(<ChipRow label="x" items={[{ query: "salt & pepper" }, { query: "<b>bold</b>" }]} />);
    const [a, b] = hrefs(d);
    expect(a).toBe(`/search?q=${encodeURIComponent("salt & pepper")}`);
    expect(qOf(a ?? "")).toBe("salt & pepper");
    expect(b).not.toMatch(/[<>&]/);
    expect(qOf(b ?? "")).toBe("<b>bold</b>");
    expect(d.querySelector("b")).toBeNull();
    expect([...d.querySelectorAll("a")].map((x) => x.textContent?.trim())).toEqual(["salt & pepper", "<b>bold</b>"]);
  });

  test("emoji query encodes as UTF-8 and round-trips", () => {
    const href = chipSearchHref("🍕 pizza") ?? "";
    expect(href).toBe(`/search?q=${encodeURIComponent("🍕 pizza")}`);
    expect(qOf(href)).toBe("🍕 pizza");
    expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("queries are capped at 100 code units (never splitting a surrogate pair); the label is cut at 40", () => {
    expect(CHIP_QUERY_MAX).toBe(100);
    const q = "x".repeat(150);
    expect(chipSearchQuery(q)).toBe("x".repeat(100));
    const surrogateEdge = "a".repeat(99) + "😀";
    expect(chipSearchQuery(surrogateEdge)).toBe("a".repeat(99));
    const d = doc(<ChipRow label="x" items={[{ query: q }]} />);
    expect(qOf(hrefs(d)[0] ?? "")?.length).toBe(100);
    expect(Array.from(d.querySelector("a")?.textContent?.trim() ?? "").length).toBe(40);
  });

  test("hostile labels and queries never become markup; control and bidi characters are stripped", () => {
    const { container } = render(<ChipRow label={HOSTILE} items={[{ query: HOSTILE }, { label: "a‮b\u0000c", href: "/deals" }]} />);
    expect(container.querySelectorAll("script, img, [onerror]").length).toBe(0);
    expect(container.textContent).not.toMatch(/[‮\u0000]/);
  });
});

describe("T142 AC5 + 44px: layout", () => {
  test("scroll (default): one row inside the ul, chips do not shrink; focus padding p-1", () => {
    const d = doc(<ChipRow label="x" items={[{ query: "a" }, { query: "b" }]} />);
    expect(cls(d.querySelector("ul"))).toEqual(expect.arrayContaining(["flex-nowrap", "overflow-x-auto", "min-w-0", "p-1"]));
    expect(cls(d.querySelector("nav"))).toEqual(expect.arrayContaining(["min-w-0", "max-w-full"]));
  });

  test("wrap: wraps and lets long chips break", () => {
    const d = doc(<ChipRow label="x" layout="wrap" items={[{ query: "a" }]} />);
    expect(cls(d.querySelector("ul"))).toContain("flex-wrap");
    expect(cls(d.querySelector("ul"))).not.toContain("overflow-x-auto");
  });

  test("chips and the more arrow are >= 44px; the arrow is named and allow-listed", () => {
    render(<ChipRow label="x" items={[{ query: "a" }]} more={{ label: "More searches", href: "/search" }} />);
    for (const a of screen.getAllByRole("link")) expect(cls(a)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch"]));
    expect(screen.getByRole("link", { name: "More searches" }).getAttribute("href")).toBe("/search");
  });

  test("more link with a bad href is omitted", () => {
    const d = doc(<ChipRow label="x" items={[{ query: "a" }]} more={{ label: "More", href: "javascript:alert(1)" }} />);
    expect(hrefs(d)).toEqual(["/search?q=a"]);
  });
});

// ============================================================ FeedbackBlock
describe("T142 AC3/AC4 + L-19: FeedbackBlock", () => {
  test("section named by an h2 'Did you find what you were looking for?'; 'Give feedback' -> exactly /contact?topic=feedback", () => {
    render(<FeedbackBlock />);
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2.textContent).toBe("Did you find what you were looking for?");
    expect(screen.getByRole("region", { name: "Did you find what you were looking for?" }).tagName).toBe("SECTION");
    const give = screen.getByRole("link", { name: "Give feedback" });
    expect(give.getAttribute("href")).toBe("/contact?topic=feedback");
    expect(FEEDBACK_HREF).toBe("/contact?topic=feedback");
    expect(cls(give)).toContain("min-h-touch");
  });

  test("AC4: no form, no input, no script, no third-party URL", () => {
    const html = renderToStaticMarkup(<FeedbackBlock />);
    expect(html).not.toMatch(/<form|<input|<script|<iframe|(href|src|action)="https?:/);
  });

  test("2-3 suggestion links: defaults when none valid; one valid topped up to two; max 3; feedback href excluded", () => {
    const sugg = (d: Document) => hrefs(d).filter((h) => h !== FEEDBACK_HREF);
    expect(sugg(doc(<FeedbackBlock />))).toEqual(DEFAULT_FEEDBACK_SUGGESTIONS.map((s) => s.href));
    expect(sugg(doc(<FeedbackBlock suggestions={[{ label: "Toys", href: "/category/toys" }]} />))).toEqual(["/category/toys", "/products"]);
    const many = ["/deals", "/best-sellers", "/new-arrivals", "/help"].map((href) => ({ label: href, href }));
    expect(sugg(doc(<FeedbackBlock suggestions={many} />))).toEqual(["/deals", "/best-sellers", "/new-arrivals"]);
    expect(resolveFeedbackSuggestions([{ label: "Loop", href: FEEDBACK_HREF }, { label: "Bad", href: "javascript:x" }]).length).toBe(3);
  });

  test("hostile heading and suggestion labels are text; long heading keeps the full text in title", () => {
    const longHeading = "H".repeat(120);
    const { container } = render(<FeedbackBlock heading={longHeading} suggestions={[{ label: HOSTILE, href: "/deals" }]} />);
    expect(container.querySelectorAll("script, img, [onerror]").length).toBe(0);
    expect(container.querySelector("h2")?.getAttribute("title")).toBe(longHeading);
    // Suggestion labels are cut at 60 code points (FEEDBACK_LABEL_MAX); the full text goes to `title`.
    const link = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/deals");
    expect(HOSTILE.startsWith((link?.textContent ?? "").replace(/…$/, ""))).toBe(true);
    expect(link?.getAttribute("title")).toBe(HOSTILE);
  });

  test("blank heading falls back to the default copy; never an h1", () => {
    const d = doc(<FeedbackBlock heading="   " />);
    expect(d.querySelector("h2")?.textContent).toBe("Did you find what you were looking for?");
    expect(d.querySelector("h1")).toBeNull();
  });

  test("L-21 / O-4: 'feedback' is an allowed contact topic end to end (service enum and /contact query parser)", () => {
    expect((CONTACT_TOPICS as readonly string[]).includes("feedback")).toBe(true);
    expect(parseContactQuery({ topic: "feedback" }).topic).toBe("feedback");
    expect(isAllowedInternalHref(FEEDBACK_HREF)).toBe(true);
  });
});

describe("T142 cross-cutting: tokens only, light only", () => {
  test("no arbitrary, dark: or palette classes", () => {
    const d = doc(
      <>
        <ChipRow label="x" searchIcon="leading" items={[{ query: "a" }]} more={{ label: "m", href: "/search" }} />
        <ChipRow label="y" searchIcon="trailing" layout="wrap" items={[{ query: "b" }]} />
        <FeedbackBlock />
      </>,
    );
    const c = [...d.querySelectorAll("[class]")].flatMap((el) => cls(el));
    expect(c.filter((x) => /\[|^dark:|:dark:/.test(x))).toEqual([]);
    expect(c.filter((x) => /(^|:)(bg|text|border)-(gray|slate|red|blue|green|white|black)(-\d+)?$/.test(x))).toEqual([]);
  });
});
