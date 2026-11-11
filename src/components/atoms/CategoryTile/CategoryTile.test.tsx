import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { CATEGORY_TILE_UNSAFE_HREF, CategoryTile, categoryTileInitial } from "./CategoryTile";

const list = (el: Element | null | undefined): string[] => (el?.getAttribute("class") ?? "").split(" ");
const mask = (link: Element): Element | null => link.querySelector("[data-mask]");

let warn: Mock<typeof console.warn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("CategoryTile", () => {
  test("server markup: one link, decorative image, label is the accessible name", () => {
    const html = renderToStaticMarkup(
      <CategoryTile href="/category/kitchen" label="Kitchen" imageSrc="/images/home/tile-home-kitchen.svg" />,
    );
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).toContain('href="/category/kitchen"');
    expect(html).toContain('alt=""');
    expect(html).toContain('data-nimg="fill"');
    expect(html).toContain(">Kitchen</span>");
    expect(html).toContain("rounded-full");
    expect(html).toContain('data-shape="circle"');
  });

  test('default shape equals shape="circle"', () => {
    const props = { href: "/category/toys-games", label: "Toys", imageSrc: "/images/home/tile-toys-games.svg" };
    expect(renderToStaticMarkup(<CategoryTile {...props} />)).toBe(
      renderToStaticMarkup(<CategoryTile {...props} shape="circle" />),
    );
  });

  test.each([
    ["circle", ["aspect-square", "rounded-full"], "rounded-lg"],
    ["rounded", ["aspect-square", "rounded-lg"], "rounded-full"],
    ["card", ["aspect-4/5", "rounded-lg"], "rounded-full"],
  ] as const)("shape %s -> mask %p", (shape, has, hasNot) => {
    render(<CategoryTile href="/category/books" label="Books" imageSrc="/a.svg" shape={shape} />);
    const link = screen.getByRole("link", { name: "Books" });
    expect(link.getAttribute("data-shape")).toBe(shape);
    const m = mask(link);
    for (const c of has) expect(list(m)).toContain(c);
    expect(list(m)).not.toContain(hasNot);
    expect(list(m)).toContain("overflow-hidden");
  });

  test.each([
    ["circle", "sm", ["w-16"], ["text-caption"]],
    ["circle", "md", ["w-20", "md:w-24"], ["text-small"]],
    ["circle", "lg", ["w-20", "md:w-32"], ["text-small", "md:text-body"]],
    ["rounded", "md", ["w-20", "md:w-24"], ["text-small"]],
    ["card", "sm", ["w-28", "md:w-32"], ["text-caption"]],
    ["card", "md", ["w-32", "md:w-40"], ["text-small"]],
    ["card", "lg", ["w-40", "md:w-56"], ["text-small", "md:text-body"]],
  ] as const)("shape %s size %s -> responsive width %p, caption %p", (shape, size, widths, text) => {
    render(<CategoryTile href="/category/x" label="Label" imageSrc={null} shape={shape} size={size} />);
    const link = screen.getByRole("link", { name: "Label" });
    expect(list(link)).toEqual(expect.arrayContaining([...widths]));
    // Exactly one base (mobile) width and at most one md: width.
    expect(list(link).filter((c) => /^w-\d+$/.test(c))).toHaveLength(1);
    expect(list(screen.getByText("Label"))).toEqual(expect.arrayContaining([...text]));
  });

  test("mobile circle (lg) is 80px so about four fit on a 390px screen; hit area >= 44px", () => {
    render(<CategoryTile href="/category/x" label="Dept" imageSrc={null} shape="circle" size="lg" />);
    const link = screen.getByRole("link", { name: "Dept" });
    expect(list(link)).toEqual(expect.arrayContaining(["w-20", "min-h-touch", "min-w-touch"]));
  });

  test.each([
    ["card", "lg", "(min-width: 768px) 224px, 160px"],
    ["circle", "lg", "(min-width: 768px) 128px, 80px"],
    ["circle", "sm", "64px"],
  ] as const)("%s %s image sizes attribute follows the responsive width", (shape, size, sizes) => {
    const html = renderToStaticMarkup(
      <CategoryTile href="/category/x" label="X" imageSrc="/a.png" shape={shape} size={size} />,
    );
    expect(html).toContain(`sizes="${sizes}"`);
  });

  test.each([null, undefined, "", "   "])("fallback tile for image %p: initial letter, no img, no throw", (src) => {
    const html = renderToStaticMarkup(
      <CategoryTile href="/category/toys-games" label="toys & games" imageSrc={src} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data-nimg");
    render(<CategoryTile href="/category/toys-games" label="toys & games" imageSrc={src} />);
    const link = screen.getByRole("link", { name: "toys & games" });
    expect(link.getAttribute("href")).toBe("/category/toys-games");
    const fallback = link.querySelector("[data-fallback]");
    expect(fallback?.textContent).toBe("T");
    expect(fallback?.getAttribute("aria-hidden")).toBe("true");
    expect(list(fallback)).toContain("text-text-secondary");
    expect(list(mask(link))).toContain("bg-surface-sunken");
    expect(link.querySelectorAll("img").length).toBe(0);
  });

  test("categoryTileInitial: trimmed, upper-cased, code-point safe, blank -> empty", () => {
    expect(categoryTileInitial("  electronics")).toBe("E");
    expect(categoryTileInitial("été")).toBe("É");
    expect(categoryTileInitial("\u{1F381} Gifts")).toBe("\u{1F381}");
    expect(categoryTileInitial("   ")).toBe("");
    expect(categoryTileInitial("")).toBe("");
  });

  test("long captions clamp to 2 lines and break long words", () => {
    const long = "Beauty, Personal Care, Fragrance and Grooming Essentials for Everyone";
    render(<CategoryTile href="/category/beauty-personal-care" label={long} imageSrc={null} shape="card" />);
    const caption = screen.getByText(long);
    expect(list(caption)).toContain("line-clamp-2");
    expect(list(caption)).toContain("break-words");
    expect(screen.getByRole("link").getAttribute("aria-label")).toBeNull();
    expect(screen.getByRole("link", { name: long })).toBeTruthy();
  });

  test.each(["circle", "rounded", "card"] as const)("%s: exactly one link, one tab stop, name is the caption", (shape) => {
    const { container } = render(
      <CategoryTile href="/category/office" label="Office" imageSrc="/a.svg" shape={shape} />,
    );
    expect(container.querySelectorAll("a").length).toBe(1);
    expect(container.querySelectorAll("a, button, input, [tabindex]").length).toBe(1);
    const link = screen.getByRole("link", { name: "Office" });
    expect(link.textContent).toBe("Office");
    expect(link.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  test.each([
    "javascript:alert(1)",
    "//evil.example/category/x",
    "https://evil.example/",
    "category/x",
    "/not-a-route",
    "/category/x/",
    "",
  ])("href %p is not allow-listed -> renders # and warns", (href) => {
    render(<CategoryTile href={href} label="Bad" imageSrc={null} />);
    expect(screen.getByRole("link", { name: "Bad" }).getAttribute("href")).toBe(CATEGORY_TILE_UNSAFE_HREF);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each(["/category/home-kitchen", "/search?q=lego", "/deals", "/"])("href %p is allowed", (href) => {
    render(<CategoryTile href={href} label="Ok" imageSrc={null} />);
    expect(screen.getByRole("link", { name: "Ok" }).getAttribute("href")).toBe(href);
    expect(warn).not.toHaveBeenCalled();
  });

  test("hostile names render as text, never markup", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const html = renderToStaticMarkup(<CategoryTile href="/category/x" label={hostile} imageSrc={null} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    render(<CategoryTile href="/category/x" label={hostile} imageSrc={null} />);
    const link = screen.getByRole("link");
    expect(link.querySelector("script")).toBeNull();
    expect(link.querySelector("img")).toBeNull();
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(link.querySelector("[data-fallback]")?.textContent).toBe("<");
  });

  test("hit area: link keeps the 44px touch minimum and circle sizes are >= 64px", () => {
    render(<CategoryTile href="/category/x" label="Tiny" imageSrc={null} size="sm" />);
    const link = screen.getByRole("link", { name: "Tiny" });
    expect(list(link)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch", "w-16"]));
    expect(list(mask(link))).toContain("w-full");
  });

  test.each(["circle", "rounded", "card"] as const)(
    "%s: focus ring on the link, outside the overflow-hidden mask",
    (shape) => {
      render(<CategoryTile href="/category/x" label="Focus" imageSrc="/a.svg" shape={shape} />);
      const link = screen.getByRole("link", { name: "Focus" });
      link.focus();
      expect(document.activeElement === link).toBe(true);
      expect(list(link)).toEqual(
        expect.arrayContaining([
          "focus-visible:outline-2",
          "focus-visible:outline-offset-2",
        ]),
      );
      // Colour comes from the base layer (blue, or white inside bg-surface-inverse), D-T131-4.
      expect(list(link).some((c) => /^focus-visible:outline-(focus-ring|text|accent)/.test(c))).toBe(false);
      expect(list(link).some((c) => /outline-none|outline-0|overflow-hidden/.test(c))).toBe(false);
      const m = mask(link);
      expect(list(m)).toContain("overflow-hidden");
      expect(list(m).some((c) => c.startsWith("focus"))).toBe(false);
      expect(m?.contains(link)).toBe(false);
    },
  );

  test("informative imageAlt is added to the name; ref and className forwarded", () => {
    const ref = createRef<HTMLAnchorElement>();
    render(
      <CategoryTile ref={ref} href="/category/x" label="Sale" imageSrc={null} imageAlt="Red tag" className="mx-2" />,
    );
    const link = screen.getByRole("link");
    expect(link.textContent).toContain("Sale");
    expect(link.querySelector('[aria-label="Red tag"]')?.getAttribute("role")).toBe("img");
    expect(ref.current === link).toBe(true);
    expect(list(link).at(-1)).toBe("mx-2");
  });

  test("priority loads the image eagerly", () => {
    const html = renderToStaticMarkup(
      <CategoryTile href="/category/x" label="X" imageSrc="/a.svg" priority />,
    );
    expect(html).toContain('loading="eager"');
  });
});
