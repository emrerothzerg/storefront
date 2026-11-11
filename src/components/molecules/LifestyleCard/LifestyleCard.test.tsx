import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { LIFESTYLE_ART } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";
import { LifestyleCard, type LifestyleCardProps, type PromoTone } from "./index";

const FOCUSABLE =
  "a[href], button, input, select, textarea, summary, iframe, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

const BASE: LifestyleCardProps = {
  blurb: "Comfy pieces for slow weekends at home.",
  cta: { label: "Shop living room", href: "/category/home-kitchen" },
  image: LIFESTYLE_ART.living,
};

let warn: Mock<typeof console.warn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

function classesOf(el: Element | null | undefined): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("LifestyleCard structure", () => {
  test("image on top, blurb, then one bold underlined link (DOM order)", () => {
    const { container } = render(<LifestyleCard {...BASE} />);
    const root = container.firstElementChild;
    expect(root?.tagName).toBe("ARTICLE");
    const img = container.querySelector("img");
    const p = container.querySelector("p");
    const a = container.querySelector("a");
    expect(img).toBeTruthy();
    expect(p?.textContent).toBe(BASE.blurb);
    expect(a?.textContent).toBe("Shop living room");
    // image precedes blurb precedes link
    expect(img && p ? img.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
    expect(p && a ? p.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
    expect(classesOf(a)).toEqual(expect.arrayContaining(["font-semibold", "underline", "min-h-touch"]));
  });

  test("contract H-17: one link to an allowed route; image alt attribute present (decorative)", () => {
    const { container } = render(<LifestyleCard {...BASE} />);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links).toHaveLength(1);
    expect(isAllowedInternalHref(links[0]?.getAttribute("href") ?? "")).toBe(true);
    const img = container.querySelector("img");
    expect(img?.hasAttribute("alt")).toBe(true);
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("width")).toBe(String(LIFESTYLE_ART.living.width));
    expect(img?.getAttribute("loading")).toBe("lazy");
  });

  test("whole card click area via the link overlay: one tab stop, no nested links", () => {
    const { container } = render(<LifestyleCard {...BASE} />);
    expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(1);
    expect(container.querySelector("a a")).toBeNull();
    expect(classesOf(container.querySelector("a"))).toEqual(expect.arrayContaining(["after:absolute", "after:inset-0"]));
    expect(classesOf(container.firstElementChild)).toContain("relative");
  });

  test("optional heading: default h3, names the article and describes the link", () => {
    const { container } = render(<LifestyleCard {...BASE} heading="Living room" />);
    const h = screen.getByRole("heading", { level: 3, name: "Living room" });
    expect(screen.getByRole("article", { name: "Living room" })).toBeTruthy();
    expect(container.querySelector("a")?.getAttribute("aria-describedby")).toBe(h.id);
  });

  test("no heading: no heading element, article unnamed, link has no describedby", () => {
    const { container } = render(<LifestyleCard {...BASE} />);
    expect(container.querySelector("h1, h2, h3, h4")).toBeNull();
    expect(container.firstElementChild?.hasAttribute("aria-labelledby")).toBe(false);
    expect(container.querySelector("a")?.hasAttribute("aria-describedby")).toBe(false);
  });

  test("heading level 2/4 honoured, 1 coerced to 3", () => {
    expect(renderToStaticMarkup(<LifestyleCard heading="A" headingLevel={2} />)).toContain("<h2");
    expect(renderToStaticMarkup(<LifestyleCard heading="A" headingLevel={4} />)).toContain("<h4");
    const one = 1 as unknown as 2;
    const html = renderToStaticMarkup(<LifestyleCard heading="A" headingLevel={one} />);
    expect(html).not.toContain("<h1");
    expect(html).toContain("<h3");
  });

  test("as li inside a caller's list", () => {
    render(
      <ul>
        <LifestyleCard {...BASE} as="li" />
      </ul>,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("LifestyleCard tones", () => {
  test("no tone: plain card (no fill, no overflow clip so the focus ring is never cut)", () => {
    const { container } = render(<LifestyleCard {...BASE} />);
    const root = container.firstElementChild;
    expect(root?.getAttribute("data-promo-tone")).toBe("plain");
    const cls = classesOf(root);
    expect(cls.some((c) => c.startsWith("bg-"))).toBe(false);
    expect(cls).not.toContain("overflow-hidden");
    expect(classesOf(container.querySelector("[data-promo-image]"))).toEqual(
      expect.arrayContaining(["rounded-lg", "overflow-hidden"]),
    );
  });

  test.each([
    ["primary", "bg-surface-inverse"],
    ["primary-subtle", "bg-accent-subtle"],
    ["neutral", "bg-surface-sunken"],
    ["accent", "bg-promo"],
  ] as const)("%s → %s", (tone, bg) => {
    const { container } = render(<LifestyleCard {...BASE} tone={tone} />);
    expect(classesOf(container.firstElementChild)).toContain(bg);
    const link = classesOf(container.querySelector("a"));
    expect(link).toContain(tone === "primary" ? "text-text-inverse" : "text-text-primary");
  });

  test("unknown tone → neutral, no throw", () => {
    const bogus = "rainbow" as unknown as PromoTone;
    const { container } = render(<LifestyleCard {...BASE} tone={bogus} />);
    expect(classesOf(container.firstElementChild)).toContain("bg-surface-sunken");
  });
});

describe("LifestyleCard edge cases", () => {
  test.each(["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/category/../admin", "nope"])(
    "invalid href %p: card renders without a link",
    (href) => {
      const { container } = render(<LifestyleCard {...BASE} cta={{ label: "Shop living room", href }} />);
      expect(container.textContent).toContain(BASE.blurb ?? "");
      expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    },
  );

  test("no image: text fills the card, no img", () => {
    const { container } = render(<LifestyleCard {...BASE} image={undefined} />);
    expect(container.querySelector("img")).toBeNull();
    expect(classesOf(container.querySelector("[data-promo-body]"))).toEqual(expect.arrayContaining(["flex-1", "min-w-0"]));
  });

  test("nothing to say (no heading, blurb or valid link) renders nothing", () => {
    expect(renderToStaticMarkup(<LifestyleCard image={LIFESTYLE_ART.dining} />)).toBe("");
    expect(
      renderToStaticMarkup(<LifestyleCard blurb="  " cta={{ label: "Shop", href: "javascript:alert(1)" }} />),
    ).toBe("");
  });

  test("link-only card still renders", () => {
    const { container } = render(<LifestyleCard cta={{ label: "Shop outdoor", href: "/category/sports-outdoors" }} />);
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  test("hostile text renders as text", () => {
    const hostile = `<img src=x onerror=alert(1)><script>alert(1)</script>`;
    const html = renderToStaticMarkup(
      <LifestyleCard heading={hostile} blurb={hostile} cta={{ label: hostile, href: "/products" }} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("320px: text and link wrap", () => {
    const { container } = render(<LifestyleCard {...BASE} heading="Living" />);
    expect(classesOf(container.querySelector("p"))).toContain("break-words");
    expect(classesOf(container.querySelector("h3"))).toContain("break-words");
    expect(classesOf(container.querySelector("a"))).toEqual(expect.arrayContaining(["break-words", "max-w-full"]));
  });
});
