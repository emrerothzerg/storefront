import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { BEAUTY_PROMO_ART, DELIVERY_PROMO_ART } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";
import { PromoStrip, type PromoStripProps } from "./index";
import type { PromoTone } from "./promo-shared";

const FOCUSABLE =
  "a[href], button, input, select, textarea, summary, iframe, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

const BASE: PromoStripProps = {
  heading: "Free shipping over $35",
  blurb: "Standard shipping is on us when your order reaches the threshold.",
  cta: { label: "Learn more", href: "/shipping" },
  image: DELIVERY_PROMO_ART,
  id: "home-shipping-promo",
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

describe("PromoStrip structure", () => {
  test("a section named by its heading, with blurb, one CTA and a decorative image", () => {
    const { container } = render(<PromoStrip {...BASE} />);
    const region = screen.getByRole("region", { name: BASE.heading });
    expect(region.id).toBe("home-shipping-promo");
    expect(region.tagName).toBe("SECTION");
    expect(within(region).getByRole("heading", { level: 3, name: BASE.heading })).toBeTruthy();
    expect(region.textContent).toContain(BASE.blurb ?? "");
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/shipping");
    expect(screen.getByRole("link", { name: "Learn more" })).toBeTruthy();
    const img = container.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("width")).toBe(String(DELIVERY_PROMO_ART.width));
    expect(img?.getAttribute("height")).toBe(String(DELIVERY_PROMO_ART.height));
    expect(img?.getAttribute("loading")).toBe("lazy");
  });

  test("exactly one focusable element and no nested links (whole band via the CTA overlay)", () => {
    const { container } = render(<PromoStrip {...BASE} />);
    expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(1);
    expect(container.querySelector("a a")).toBeNull();
    const link = container.querySelector("a");
    expect(classesOf(link)).toEqual(expect.arrayContaining(["after:absolute", "after:inset-0"]));
    expect(classesOf(container.firstElementChild)).toContain("relative");
    // The CTA is described by the heading so "Learn more" has context.
    const headingId = container.querySelector("h3")?.id ?? "";
    expect(headingId).not.toBe("");
    expect(link?.getAttribute("aria-describedby")).toBe(headingId);
  });

  test("CTA href passes isAllowedInternalHref", () => {
    const { container } = render(<PromoStrip {...BASE} cta={{ label: "Shop deals", href: "/deals?sort=new" }} />);
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
  });
});

describe("PromoStrip CTA validation", () => {
  test.each([
    ["absolute", "https://evil.example/x"],
    ["protocol-relative", "//evil.example"],
    ["javascript:", "javascript:alert(1)"],
    ["relative", "shipping"],
    ["unknown route", "/definitely-not-a-route"],
    ["empty", ""],
  ])("%s href: strip renders without any link", (_name, href) => {
    const { container } = render(<PromoStrip {...BASE} cta={{ label: "Learn more", href }} />);
    expect(screen.getByRole("heading", { name: BASE.heading })).toBeTruthy();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(container.textContent).not.toContain("Learn more");
    expect(classesOf(container.firstElementChild)).not.toContain("hover:shadow-md");
  });

  test("blank label or missing CTA: no link", () => {
    const blank = render(<PromoStrip {...BASE} cta={{ label: "  ", href: "/shipping" }} />);
    expect(blank.container.querySelectorAll("a")).toHaveLength(0);
    blank.unmount();
    const none = render(<PromoStrip heading="Hello" />);
    expect(none.container.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("PromoStrip tones", () => {
  test.each([
    ["primary", "bg-surface-inverse", "text-text-inverse"],
    ["primary-subtle", "bg-accent-subtle", "text-text-primary"],
    ["neutral", "bg-surface-sunken", "text-text-primary"],
    ["accent", "bg-promo", "text-text-primary"],
  ] as const)("%s maps to %s", (tone, bg, text) => {
    const { container } = render(<PromoStrip {...BASE} tone={tone} />);
    const root = container.firstElementChild;
    expect(classesOf(root)).toEqual(expect.arrayContaining([bg, text]));
    const headingClasses = classesOf(container.querySelector("h3"));
    expect(headingClasses).toContain(tone === "primary" ? "text-text-inverse" : "text-text-primary");
    const linkClasses = classesOf(container.querySelector("a"));
    // Inverse band gets the white inverse pill; others the primary (accent) pill.
    expect(linkClasses).toContain(tone === "primary" ? "bg-surface-raised" : "bg-accent");
  });

  test("default and unknown tones fall back to neutral without throwing", () => {
    const def = render(<PromoStrip {...BASE} />);
    expect(classesOf(def.container.firstElementChild)).toContain("bg-surface-sunken");
    def.unmount();
    const bogus = "hot-pink" as unknown as PromoTone;
    expect(() => render(<PromoStrip {...BASE} tone={bogus} />)).not.toThrow();
    expect(document.querySelector("section")?.getAttribute("data-promo-tone")).toBe("sunken");
  });
});

describe("PromoStrip heading level", () => {
  test("defaults to h3; 2 and 4 honoured; 1 is never rendered", () => {
    expect(renderToStaticMarkup(<PromoStrip heading="A" />)).toContain("<h3");
    expect(renderToStaticMarkup(<PromoStrip heading="A" headingLevel={2} />)).toContain("<h2");
    expect(renderToStaticMarkup(<PromoStrip heading="A" headingLevel={4} />)).toContain("<h4");
    const one = 1 as unknown as 2;
    const html = renderToStaticMarkup(<PromoStrip heading="A" headingLevel={one} />);
    expect(html).not.toContain("<h1");
    expect(html).toContain("<h3");
  });
});

describe("PromoStrip images and layout", () => {
  test("no image: no img, text side fills the width, no row layout", () => {
    const { container } = render(<PromoStrip {...BASE} image={undefined} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-promo-image]")).toBeNull();
    const root = classesOf(container.firstElementChild);
    expect(root).not.toContain("md:flex-row");
    expect(root).not.toContain("md:flex-row-reverse");
    expect(classesOf(container.querySelector("[data-promo-body]"))).toContain("flex-1");
  });

  test("invalid image path renders like no image", () => {
    const { container } = render(<PromoStrip {...BASE} image={{ path: "javascript:alert(1)", width: 10, height: 10 }} />);
    expect(container.querySelector("img")).toBeNull();
  });

  test("imagePosition end (default) puts the image right from md; start puts it left; image first in DOM", () => {
    const end = render(<PromoStrip {...BASE} />);
    expect(classesOf(end.container.firstElementChild)).toContain("md:flex-row-reverse");
    expect(end.container.firstElementChild?.firstElementChild?.hasAttribute("data-promo-image")).toBe(true);
    end.unmount();
    const start = render(<PromoStrip {...BASE} image={BEAUTY_PROMO_ART} imagePosition="start" />);
    expect(classesOf(start.container.firstElementChild)).toContain("md:flex-row");
  });

  test("a non-decorative image keeps its alt; priority loads eagerly", () => {
    const { container } = render(
      <PromoStrip {...BASE} priority image={{ ...DELIVERY_PROMO_ART, decorative: false }} />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("alt")).toBe(DELIVERY_PROMO_ART.alt);
    expect(img?.getAttribute("loading")).not.toBe("lazy");
  });

  test("320px readability: stacked by default, text wraps (break-words, min-w-0)", () => {
    const { container } = render(<PromoStrip {...BASE} />);
    expect(classesOf(container.firstElementChild)).toEqual(expect.arrayContaining(["flex", "flex-col", "w-full"]));
    expect(classesOf(container.querySelector("[data-promo-body]"))).toContain("min-w-0");
    expect(classesOf(container.querySelector("h3"))).toContain("break-words");
    expect(classesOf(container.querySelector("a"))).toEqual(expect.arrayContaining(["break-words", "max-w-full"]));
  });
});

describe("PromoStrip hostile and empty input", () => {
  test("hostile heading, blurb and label render as text", () => {
    const hostile = `<img src=x onerror="alert(1)"><script>alert(1)</script>`;
    const html = renderToStaticMarkup(
      <PromoStrip heading={hostile} blurb={hostile} cta={{ label: hostile, href: "/deals" }} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  test("blank or missing heading renders nothing", () => {
    expect(renderToStaticMarkup(<PromoStrip heading="   " cta={BASE.cta} />)).toBe("");
    const missing = undefined as unknown as string;
    expect(renderToStaticMarkup(<PromoStrip heading={missing} />)).toBe("");
  });

  test("server-renders without client hooks (renderToStaticMarkup)", () => {
    const html = renderToStaticMarkup(<PromoStrip {...BASE} />);
    expect(html).toContain('id="home-shipping-promo"');
    expect(html).toContain('href="/shipping"');
    expect(html).not.toContain("<h1");
  });
});
