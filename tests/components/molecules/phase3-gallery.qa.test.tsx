// QA (T147, Phase 3 wave A): ImageGallery v3 (T144) against BACKLOG-phase3 T144 AC1-AC5 and
// CONTRACTS P-4 (reference pending: structure and behaviour only).
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ImageGallery,
  galleryHrefForIndex,
  galleryPlaceholderAlt,
  safeImageUrl,
  thumbnailLabel,
} from "@/components/molecules/ImageGallery";
import { expectFocused } from "@/test/dom-assertions";

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;
const images = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `/images/p/${i + 1}.svg`, alt: "" }));

function doc(el: ReactElement): Document {
  return new DOMParser().parseFromString(`<body>${renderToStaticMarkup(el)}</body>`, "text/html");
}
const cls = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("T144 AC1 + P-4: no-JS links reach every image", () => {
  test("basePath: every thumbnail is a link (?img=N#gallery, first without the param); no buttons, no dialog", () => {
    const d = doc(<ImageGallery images={images(4)} productName="Oak Desk" basePath="/products/oak-desk" />);
    const links = [...d.querySelectorAll("ul a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/products/oak-desk#gallery",
      "/products/oak-desk?img=1#gallery",
      "/products/oak-desk?img=2#gallery",
      "/products/oak-desk?img=3#gallery",
    ]);
    expect(d.querySelector("button, dialog")).toBeNull();
    expect(d.getElementById("gallery") === null ? "missing" : "ok").toBe("ok");
  });

  test("basePath with an existing query or fragment is reduced to the path", () => {
    expect(galleryHrefForIndex("/products/a?img=3&x=1#top", 2)).toBe("/products/a?img=2#gallery");
  });

  test("unsafe basePath values give no links (null), never an off-site href", () => {
    for (const p of ["//evil.example/x", "https://evil.example/x", "javascript:alert(1)", "/\\evil", "", "  ", "/a b", 42]) {
      expect({ p: String(p), href: galleryHrefForIndex(p, 1) }).toEqual({ p: String(p), href: null });
    }
    const d = doc(<ImageGallery images={images(3)} productName="X" basePath="//evil.example" />);
    expect([...d.querySelectorAll("a")].filter((a) => /evil/.test(a.getAttribute("href") ?? "")).length).toBe(0);
  });

  test("initialIndex selects the main image and marks its thumbnail current (out of range clamps)", () => {
    const d = doc(<ImageGallery images={images(3)} productName="Oak Desk" basePath="/products/oak-desk" initialIndex={2} />);
    const links = [...d.querySelectorAll("ul a")];
    expect(links.map((a) => a.hasAttribute("aria-current"))).toEqual([false, false, true]);
    expect(d.querySelector("[data-gallery-main] img")?.getAttribute("alt")).toBe("Oak Desk, image 3 of 3");
    const clamped = doc(<ImageGallery images={images(3)} productName="Oak Desk" basePath="/p" initialIndex={99} />);
    expect([...clamped.querySelectorAll("ul a")].map((a) => a.hasAttribute("aria-current"))).toEqual([false, false, true]);
  });
});

describe("T144 AC2: thumbnail names and selection", () => {
  test("names 'Image N of M' (helper and markup); the thumbnail image itself is decorative", () => {
    expect(thumbnailLabel(1, 5)).toBe("Image 2 of 5");
    const d = doc(<ImageGallery images={images(5)} productName="Oak Desk" basePath="/p" />);
    const links = [...d.querySelectorAll("ul a")];
    expect(links.map((a) => a.textContent)).toEqual([1, 2, 3, 4, 5].map((n) => `Image ${n} of 5`));
    for (const img of d.querySelectorAll("ul img")) expect(img.getAttribute("alt")).toBe("");
  });

  test("hydrated: buttons with exactly one aria-current; click selects; roving tabindex", () => {
    render(<ImageGallery images={images(3)} productName="Oak Desk" />);
    const thumbs = [1, 2, 3].map((n) => screen.getByRole("button", { name: `Image ${n} of 3` }));
    expect(thumbs.map((t) => t.getAttribute("aria-current"))).toEqual(["true", null, null]);
    expect(thumbs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    fireEvent.click(thumbs[1]!);
    const after = [1, 2, 3].map((n) => screen.getByRole("button", { name: `Image ${n} of 3` }));
    expect(after.map((t) => t.getAttribute("aria-current"))).toEqual([null, "true", null]);
  });

  test("keyboard: ArrowDown / ArrowUp (vertical strip) and ArrowRight / Left move focus with wrap; Home / End jump", () => {
    render(<ImageGallery images={images(3)} productName="Oak Desk" />);
    const list = screen.getByRole("list", { name: "Product image thumbnails" });
    const thumb = (n: number) => screen.getByRole("button", { name: `Image ${n} of 3` });
    thumb(1).focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expectFocused(thumb(2));
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expectFocused(thumb(3));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expectFocused(thumb(1));
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expectFocused(thumb(3));
    fireEvent.keyDown(list, { key: "Home" });
    expectFocused(thumb(1));
    fireEvent.keyDown(list, { key: "End" });
    expectFocused(thumb(3));
  });
});

describe("T144 AC3: one image and zero images", () => {
  test("1 image: no thumbnail list", () => {
    const d = doc(<ImageGallery images={images(1)} productName="Oak Desk" basePath="/p" />);
    expect(d.querySelector("ul, [data-gallery-strip]")).toBeNull();
    expect(d.querySelectorAll("img").length).toBe(1);
  });

  test("0 images: placeholder tile named by the product (no <img>, no thumbnails, no zoom)", () => {
    render(<ImageGallery images={[]} productName="Oak Desk" />);
    const ph = screen.getByRole("img", { name: "Oak Desk" });
    expect(ph.hasAttribute("data-placeholder")).toBe(true);
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("0 images with a blank or hostile product name: 'Product' / the text, never markup", () => {
    expect(galleryPlaceholderAlt("   ")).toBe("Product");
    const { container } = render(<ImageGallery images={[]} productName={HOSTILE} />);
    expect(container.querySelectorAll("script, img, [onerror]").length).toBe(0);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(HOSTILE);
  });

  test("unsafe image URLs become the placeholder (javascript:, data:, protocol-relative, backslash)", () => {
    for (const u of ["javascript:alert(1)", "data:image/svg+xml,x", "//evil.example/a.png", "/\\evil/a.png", "   "]) {
      expect({ u, safe: safeImageUrl(u) }).toEqual({ u, safe: "" });
    }
    const d = doc(<ImageGallery images={[{ url: "javascript:alert(1)", alt: "" }]} productName="Oak Desk" />);
    expect(d.querySelector("img")).toBeNull();
    expect(d.querySelector("[data-placeholder]")?.getAttribute("aria-label")).toBe("Oak Desk, image 1 of 1");
  });
});

describe("T144 AC4 + layout", () => {
  test("main image sits in a fixed square tile (no CLS); first image is priority (eager)", () => {
    const d = doc(<ImageGallery images={images(2)} productName="Oak Desk" />);
    const main = d.querySelector("[data-gallery-main]");
    expect(cls(main)).toEqual(expect.arrayContaining(["aspect-square", "w-full", "overflow-hidden"]));
    expect(main?.querySelector("img")?.getAttribute("loading")).toBe("eager");
  });

  test("DOM order: main image before the strip; thumbnails are 64px (>= 44px) targets; strip scrolls inside itself", () => {
    const d = doc(<ImageGallery images={images(3)} productName="Oak Desk" basePath="/p" />);
    const wrapper = d.getElementById("gallery");
    const kids = [...(wrapper?.children ?? [])].map((k) => (k.hasAttribute("data-gallery-main") ? "main" : k.hasAttribute("data-gallery-strip") ? "strip" : "other"));
    expect(kids).toEqual(["main", "strip"]);
    for (const a of d.querySelectorAll("ul a")) expect(cls(a)).toContain("size-16");
    expect(cls(d.querySelector("ul"))).toEqual(expect.arrayContaining(["overflow-x-auto", "p-1"]));
  });

  test("tokens only, light only", () => {
    const d = doc(<ImageGallery images={images(3)} productName="Oak Desk" basePath="/p" />);
    const c = [...d.querySelectorAll("[class]")].flatMap((el) => cls(el));
    expect(c.filter((x) => /\[|^dark:|:dark:/.test(x))).toEqual([]);
  });
});
