import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProductImage } from "@/lib/types";
import {
  IMAGE_GALLERY_PARAM,
  IMAGE_GALLERY_SIZES,
  ImageGallery,
  clampImageIndex,
  galleryHrefForIndex,
  galleryImageAlt,
  galleryPlaceholderAlt,
  safeImageUrl,
  thumbnailLabel,
} from "./index";
import { expectFocused } from "@/test/dom-assertions";

function makeImages(n: number): ProductImage[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `/images/products/desk-${i + 1}.png`,
    alt: i === 0 ? "Oak desk, front view" : "",
  }));
}

const hrefForIndex = (i: number) => `?img=${i}#gallery`;
const getDialog = () => document.querySelector("dialog") as HTMLDialogElement;

// happy-dom does not implement Escape -> cancel -> close; dispatch it (Dialog tests do the same).
function pressEscape(dialog: HTMLDialogElement) {
  act(() => {
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    dialog.close();
  });
}

function mainImage(container: HTMLElement): HTMLElement {
  const box = container.querySelector(".aspect-square");
  if (!box) throw new Error("main image box missing");
  const el = box.querySelector("img, [role='img']");
  if (!(el instanceof HTMLElement)) throw new Error("main image missing");
  return el;
}

function thumbs(): HTMLElement[] {
  const list = screen.getByRole("list", { name: "Product image thumbnails" });
  return within(list).getAllByRole("button");
}

function thumb(index: number): HTMLElement {
  const el = thumbs()[index];
  if (!el) throw new Error(`thumbnail ${index} missing`);
  return el;
}

describe("pure helpers", () => {
  test("clampImageIndex clamps NaN, negatives, fractions, overflow and empty", () => {
    expect(clampImageIndex(undefined, 3)).toBe(0);
    expect(clampImageIndex(Number.NaN, 3)).toBe(0);
    expect(clampImageIndex(-1, 3)).toBe(0);
    expect(clampImageIndex(Number.POSITIVE_INFINITY, 3)).toBe(0);
    expect(clampImageIndex(1.7, 3)).toBe(1);
    expect(clampImageIndex(2, 3)).toBe(2);
    expect(clampImageIndex(3, 3)).toBe(2);
    expect(clampImageIndex(999, 3)).toBe(2);
    expect(clampImageIndex(5, 0)).toBe(0);
  });

  test("safeImageUrl allows only same-origin paths and http(s)", () => {
    expect(safeImageUrl(" /images/a.svg ")).toBe("/images/a.svg");
    expect(safeImageUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(safeImageUrl("HTTP://cdn.example.com/a.png")).toBe("HTTP://cdn.example.com/a.png");
    for (const bad of [
      "",
      "   ",
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "//evil.example.com/a.png",
      "/\\evil.example.com",
      "images/relative.png",
      "https://",
      "ftp://x/a.png",
    ]) {
      expect(safeImageUrl(bad)).toBe("");
    }
    expect(safeImageUrl(undefined)).toBe("");
    expect(safeImageUrl(42)).toBe("");
  });

  test("galleryImageAlt prefers alt, falls back to product name + index", () => {
    expect(galleryImageAlt({ url: "/a", alt: "Front" }, "Desk", 0, 3)).toBe("Front");
    expect(galleryImageAlt({ url: "/a", alt: "   " }, "Desk", 1, 3)).toBe("Desk, image 2 of 3");
    expect(galleryImageAlt(undefined, "  ", 0, 1)).toBe("Product, image 1 of 1");
  });

  test("thumbnailLabel is 'Image N of M' (T144)", () => {
    expect(thumbnailLabel(1, 5)).toBe("Image 2 of 5");
    expect(thumbnailLabel(0, 1)).toBe("Image 1 of 1");
  });

  test("galleryPlaceholderAlt is the trimmed product name, 'Product' when blank", () => {
    expect(galleryPlaceholderAlt("  Oak Desk ")).toBe("Oak Desk");
    expect(galleryPlaceholderAlt("   ")).toBe("Product");
    expect(galleryPlaceholderAlt("")).toBe("Product");
  });
});

describe("ImageGallery: criterion 1 (0 / 1 images)", () => {
  test("0 images: one placeholder tile named after the product, no thumbnails, no zoom", () => {
    const { container } = render(<ImageGallery images={[]} productName="Oak Desk" />);
    const placeholders = container.querySelectorAll("[data-placeholder]");
    expect(placeholders).toHaveLength(1);
    // T144: the placeholder's alt is the product name.
    expect(placeholders[0]).toHaveAttribute("aria-label", "Oak Desk");
    expect(screen.getByRole("img", { name: "Oak Desk" }) === placeholders[0]).toBe(true);
    // It sits in the white main tile with the fixed aspect box.
    expect(placeholders[0]?.closest("[data-gallery-main]")).toHaveClass("aspect-square", "bg-surface-raised");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-gallery-strip]")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open image in full screen" })).toBeNull();
    expect(container.querySelector("dialog")).toBeNull();
  });

  test("1 image: main image only, no thumbnails, zoom available", () => {
    const { container } = render(<ImageGallery images={makeImages(1)} productName="Oak Desk" />);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByRole("list")).toBeNull();
    expect(container.querySelector("[data-gallery-strip]")).toBeNull();
    expect(screen.getByRole("button", { name: "Open image in full screen" })).toBeInTheDocument();
  });

  test("0 images with a blank product name: placeholder named 'Product'", () => {
    const { container } = render(<ImageGallery images={[]} productName="  " />);
    expect(container.querySelector("[data-placeholder]")).toHaveAttribute("aria-label", "Product");
  });
});

describe("ImageGallery v3 layout (T144)", () => {
  test("main image is a white tile with a soft border and a fixed 1:1 box; DOM order main then strip", () => {
    const { container } = render(<ImageGallery images={makeImages(3)} productName="Oak Desk" />);
    const root = container.querySelector("#gallery") as HTMLElement;
    const main = root.querySelector("[data-gallery-main]") as HTMLElement;
    const strip = root.querySelector("[data-gallery-strip]") as HTMLElement;
    expect(main).toHaveClass("aspect-square", "w-full", "overflow-hidden", "rounded-lg", "bg-surface-raised", "border", "border-border-default");
    expect(main.querySelector("img")).toHaveAttribute("width", "800");
    expect(main.querySelector("img")).toHaveAttribute("height", "800");
    // Main first in the DOM (reading/focus order), strip second.
    // Compare markers, never DOM nodes (node diffs serialise the whole document).
    // (After hydration the lightbox <dialog> follows them.)
    expect([...root.children].map((el) => (el === main ? "main" : el === strip ? "strip" : el.tagName))).toEqual(["main", "strip", "DIALOG"]);
  });

  test("strip is horizontal below md and a vertical column left of the main image from md", () => {
    const { container } = render(<ImageGallery images={makeImages(5)} productName="Oak Desk" />);
    const root = container.querySelector("#gallery") as HTMLElement;
    // Column on mobile; from md the row is reversed so the strip renders on the left.
    expect(root).toHaveClass("flex", "flex-col", "md:flex-row-reverse", "md:justify-end", "md:items-start");
    const strip = container.querySelector("[data-gallery-strip]") as HTMLElement;
    expect(strip).toHaveClass("w-full", "md:w-20", "md:shrink-0", "md:self-stretch", "relative");
    const list = screen.getByRole("list", { name: "Product image thumbnails" });
    expect(list).toHaveClass("flex", "overflow-x-auto", "md:flex-col", "md:absolute", "md:inset-0", "md:overflow-y-auto", "md:overflow-x-hidden");
    expect(strip.contains(list)).toBe(true);
  });

  test("selected thumbnail: accent border + aria-current; idle thumbnails are white tiles with soft borders", () => {
    render(<ImageGallery images={makeImages(3)} productName="Oak Desk" initialIndex={1} />);
    expect(thumb(1)).toHaveClass("border-accent", "bg-surface-raised");
    expect(thumb(1)).toHaveAttribute("aria-current", "true");
    for (const i of [0, 2]) {
      expect(thumb(i)).toHaveClass("border-border-default", "bg-surface-raised");
      expect(thumb(i)).not.toHaveClass("border-accent");
    }
  });
});

describe("ImageGallery: criteria 4 and 5 (alt, priority, size)", () => {
  test("main image has explicit width/height in a 1:1 box and eager priority", () => {
    const { container } = render(<ImageGallery images={makeImages(3)} productName="Oak Desk" />);
    const img = mainImage(container);
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("width", "800");
    expect(img).toHaveAttribute("height", "800");
    expect(img).toHaveAttribute("loading", "eager");
    expect(img).toHaveAttribute("fetchpriority", "high");
    expect(img).toHaveAttribute("sizes", IMAGE_GALLERY_SIZES);
    expect(img).toHaveAttribute("alt", "Oak desk, front view");
    const box = container.querySelector(".aspect-square");
    expect(box).toHaveClass("aspect-square", "w-full", "max-w-2xl", "rounded-lg", "bg-surface-raised");
  });

  test("thumbnails are lazy and decorative; names come from hidden text", () => {
    const { container } = render(<ImageGallery images={makeImages(3)} productName="Oak Desk" />);
    const list = screen.getByRole("list");
    const thumbImgs = list.querySelectorAll("img");
    expect(thumbImgs).toHaveLength(3);
    for (const img of thumbImgs) {
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img).toHaveAttribute("alt", "");
    }
    // Only the main image is eager.
    expect(container.querySelectorAll('img[loading="eager"]')).toHaveLength(1);
  });

  test("fallback alt uses product name and index when alt is empty", () => {
    const { container } = render(
      <ImageGallery images={makeImages(3)} productName="Oak Desk" initialIndex={2} />,
    );
    expect(mainImage(container)).toHaveAttribute("alt", "Oak Desk, image 3 of 3");
  });

  test("custom sizes prop is forwarded", () => {
    const { container } = render(
      <ImageGallery images={makeImages(2)} productName="Oak Desk" sizes="100vw" />,
    );
    expect(mainImage(container)).toHaveAttribute("sizes", "100vw");
  });
});

describe("ImageGallery: initialIndex and hostile input", () => {
  test.each([
    [Number.NaN, 0],
    [-4, 0],
    [1, 1],
    [10, 2],
  ])("initialIndex %p shows image %p", (initial, expected) => {
    render(<ImageGallery images={makeImages(3)} productName="Oak Desk" initialIndex={initial} />);
    const buttons = thumbs();
    buttons.forEach((b, i) => {
      if (i === expected) expect(b).toHaveAttribute("aria-current", "true");
      else expect(b).not.toHaveAttribute("aria-current");
    });
  });

  test("javascript:, whitespace and empty URLs render the placeholder, never the URL", () => {
    const images: ProductImage[] = [
      { url: "javascript:alert(1)", alt: "" },
      { url: "   ", alt: "  " },
      { url: "", alt: "" },
    ];
    const { container } = render(<ImageGallery images={images} productName="Oak Desk" />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // main + 3 thumbnails
    expect(container.querySelectorAll("[data-placeholder]")).toHaveLength(4);
    expect(container.innerHTML).not.toContain("javascript:");
    expect(mainImage(container)).toHaveAttribute("aria-label", "Oak Desk, image 1 of 3");
  });

  test("20 images render 20 thumbnails in a horizontally scrolling strip", () => {
    render(<ImageGallery images={makeImages(20)} productName="Oak Desk" />);
    const list = screen.getByRole("list");
    expect(list).toHaveClass("flex", "overflow-x-auto", "w-full");
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    for (const li of within(list).getAllByRole("listitem")) expect(li).toHaveClass("shrink-0");
    expect(thumb(19)).toHaveAccessibleName("Image 20 of 20");
  });
});

describe("ImageGallery: criterion 2 (thumbnails, keyboard)", () => {
  test("thumbnail buttons are named 'Image N of M' with aria-current on the active one", () => {
    render(<ImageGallery images={makeImages(5)} productName="Oak Desk" />);
    const list = screen.getByRole("list");
    expect(list).toHaveAttribute("role", "list");
    const buttons = thumbs();
    expect(buttons).toHaveLength(5);
    buttons.forEach((b, i) => expect(b).toHaveAccessibleName(`Image ${i + 1} of 5`));
    expect(thumb(0)).toHaveAttribute("aria-current", "true");
    expect(document.querySelector("[aria-selected]")).toBeNull();
    // After hydration thumbnails are buttons, never links.
    expect(within(list).queryAllByRole("link")).toHaveLength(0);
  });

  test("click activates a thumbnail and swaps the main image", () => {
    const { container } = render(<ImageGallery images={makeImages(3)} productName="Oak Desk" />);
    fireEvent.click(thumb(1));
    expect(thumb(1)).toHaveAttribute("aria-current", "true");
    expect(thumb(0)).not.toHaveAttribute("aria-current");
    const img = mainImage(container);
    expect(img.getAttribute("src") ?? "").toContain("desk-2");
    expect(img).toHaveAttribute("alt", "Oak Desk, image 2 of 3");
  });

  test("click with hrefForIndex prevents navigation (JS path is a button)", () => {
    render(<ImageGallery images={makeImages(3)} productName="Oak Desk" hrefForIndex={hrefForIndex} />);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      thumb(2).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(thumb(2)).toHaveAttribute("aria-current", "true");
  });

  test("roving tabindex: one tab stop, arrows/Home/End move focus with wrap", () => {
    render(<ImageGallery images={makeImages(4)} productName="Oak Desk" initialIndex={1} />);
    let buttons = thumbs();
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1]);

    thumb(1).focus();
    fireEvent.keyDown(thumb(1), { key: "ArrowRight" });
    buttons = thumbs();
    expectFocused(thumb(2));
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, -1, 0, -1]);
    // Moving focus does not activate.
    expect(thumb(1)).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(thumb(2), { key: "End" });
    expectFocused(thumb(3));
    fireEvent.keyDown(thumb(3), { key: "ArrowRight" });
    expectFocused(thumb(0));
    fireEvent.keyDown(thumb(0), { key: "ArrowLeft" });
    expectFocused(thumb(3));
    fireEvent.keyDown(thumb(3), { key: "Home" });
    expectFocused(thumb(0));
    expect(thumbs().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  test("other keys are ignored and not prevented", () => {
    render(<ImageGallery images={makeImages(3)} productName="Oak Desk" />);
    const first = thumb(0);
    first.focus();
    const event = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
    act(() => {
      first.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expectFocused(first);
  });

  test("ArrowDown/ArrowUp move focus too (vertical strip from md), with wrap", () => {
    render(<ImageGallery images={makeImages(3)} productName="Oak Desk" />);
    thumb(0).focus();
    fireEvent.keyDown(thumb(0), { key: "ArrowDown" });
    expectFocused(thumb(1));
    fireEvent.keyDown(thumb(1), { key: "ArrowUp" });
    expectFocused(thumb(0));
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    act(() => {
      thumb(0).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expectFocused(thumb(2));
    // Focus moves never change the selection.
    expect(thumb(0)).toHaveAttribute("aria-current", "true");
  });

  test("Enter/Space activate via native button click (type=button, focused thumb)", () => {
    const { container } = render(<ImageGallery images={makeImages(3)} productName="Oak Desk" />);
    const first = thumb(0);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = thumb(1);
    expect(second.tagName).toBe("BUTTON");
    expect(second).toHaveAttribute("type", "button");
    // Browsers turn Enter/Space on a <button> into a click.
    fireEvent.click(second);
    expect(second).toHaveAttribute("aria-current", "true");
    expect(mainImage(container).getAttribute("src") ?? "").toContain("desk-2");
  });

  test("thumbnail targets meet 44px (size-16) and use token borders", () => {
    render(<ImageGallery images={makeImages(2)} productName="Oak Desk" />);
    const a = thumb(0);
    const b = thumb(1);
    expect(a).toHaveClass("size-16", "border-accent", "rounded-md");
    expect(b).toHaveClass("size-16", "border-border-default");
  });
});

describe("ImageGallery: criterion 3 (lightbox)", () => {
  test("zoom opens a modal with showModal, Escape closes, focus returns to zoom", () => {
    const original = HTMLDialogElement.prototype.showModal;
    const spy = mock(function (this: HTMLDialogElement) {
      original.call(this);
    });
    HTMLDialogElement.prototype.showModal = spy;
    try {
      render(<ImageGallery images={makeImages(3)} productName="Oak Desk" initialIndex={1} />);
      const zoom = screen.getByRole("button", { name: "Open image in full screen" });
      expect(getDialog().open).toBe(false);
      zoom.focus();
      fireEvent.click(zoom);
      expect(spy).toHaveBeenCalledTimes(1);
      const dialog = screen.getByRole("dialog", { name: "Oak Desk" });
      expect((dialog as HTMLDialogElement).open).toBe(true);
      const large = within(dialog).getByRole("img", { name: "Oak Desk, image 2 of 3" });
      expect(large).toHaveAttribute("width", "1200");
      expect(within(dialog).getByText("Image 2 of 3")).toHaveAttribute("aria-live", "polite");

      pressEscape(getDialog());
      expect(getDialog().open).toBe(false);
      expectFocused(zoom);
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
  });

  test("close button closes and returns focus", () => {
    render(<ImageGallery images={makeImages(2)} productName="Oak Desk" />);
    const zoom = screen.getByRole("button", { name: "Open image in full screen" });
    zoom.focus();
    fireEvent.click(zoom);
    fireEvent.click(screen.getByRole("button", { name: "Close full screen image" }));
    expect(getDialog().open).toBe(false);
    expectFocused(zoom);
  });

  test("prev/next buttons and arrow keys cycle images and sync the thumbnails", () => {
    render(<ImageGallery images={makeImages(3)} productName="Oak Desk" />);
    const zoom = screen.getByRole("button", { name: "Open image in full screen" });
    zoom.focus();
    fireEvent.click(zoom);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(within(dialog).getByText("Image 2 of 3")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous image" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous image" }));
    expect(within(dialog).getByText("Image 3 of 3")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(dialog).getByText("Image 1 of 3")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(within(dialog).getByText("Image 3 of 3")).toBeInTheDocument();
    pressEscape(getDialog());
    expect(thumb(2)).toHaveAttribute("aria-current", "true");
  });

  test("single image: no prev/next in the lightbox", () => {
    render(<ImageGallery images={makeImages(1)} productName="Oak Desk" />);
    fireEvent.click(screen.getByRole("button", { name: "Open image in full screen" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Next image" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Previous image" })).toBeNull();
  });

  test("empty product name still gives the dialog a name", () => {
    render(<ImageGallery images={makeImages(1)} productName="   " />);
    fireEvent.click(screen.getByRole("button", { name: "Open image in full screen" }));
    expect(screen.getByRole("dialog", { name: "Product images" })).toBeInTheDocument();
  });
});

describe("ImageGallery: no-JS static markup", () => {
  test("thumbnails are plain links to hrefForIndex, main image is initialIndex, no JS-only state", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={makeImages(3)} productName="Oak Desk" initialIndex={2} hrefForIndex={hrefForIndex} />,
    );
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain('href="?img=0#gallery"');
    expect(html).toContain('href="?img=2#gallery"');
    expect(html).toContain('id="gallery"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("aria-selected");
    expect(html).not.toContain("tabindex");
    expect(html).toContain("Image 3 of 3");
    expect(html).not.toContain("Show image");
    // Active link marked; only one.
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a [^>]*aria-current="page"[^>]*href="\?img=2#gallery"|<a [^>]*href="\?img=2#gallery"[^>]*aria-current="page"/);
    // Main image is image 3 and eager.
    expect(html).toContain('alt="Oak Desk, image 3 of 3"');
    expect(html).toMatch(/desk-3/);
  });

  test("clamped initialIndex in static markup", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={makeImages(2)} productName="Oak Desk" initialIndex={99} hrefForIndex={hrefForIndex} />,
    );
    expect(html).toContain('alt="Oak Desk, image 2 of 2"');
  });

  test("every image is reachable with JS off: one link per image, distinct hrefs, named 'Image N of M'", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={makeImages(5)} productName="Oak Desk" basePath="/products/oak-desk" />,
    );
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const links = [...doc.querySelectorAll("[data-gallery-strip] ul a")];
    expect(links).toHaveLength(5);
    expect(new Set(links.map((a) => a.getAttribute("href"))).size).toBe(5);
    expect(links.map((a) => a.textContent)).toEqual([1, 2, 3, 4, 5].map((n) => `Image ${n} of 5`));
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null, null, null]);
    expect(doc.querySelector("[data-gallery-main] img")?.getAttribute("fetchpriority")).toBe("high");
  });

  test("static markup: 0 images = placeholder named after the product; 1 image = no thumbnails", () => {
    const none = renderToStaticMarkup(<ImageGallery images={[]} productName="Oak Desk" basePath="/p" />);
    expect(none).toContain('aria-label="Oak Desk"');
    expect(none).toContain("data-placeholder");
    expect(none).not.toContain("<a ");
    expect(none).not.toContain("<ul");
    const one = renderToStaticMarkup(<ImageGallery images={makeImages(1)} productName="Oak Desk" basePath="/p" />);
    expect(one).not.toContain("<a ");
    expect(one).not.toContain("<ul");
    expect(one).toContain('alt="Oak desk, front view"');
  });

  test("custom id is the fragment target", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={makeImages(2)} productName="Oak Desk" id="pdp-gallery" />,
    );
    expect(html).toContain('id="pdp-gallery"');
  });
});

describe("galleryHrefForIndex", () => {
  test("builds <path>?img=N#gallery; index 0 omits the param", () => {
    expect(IMAGE_GALLERY_PARAM).toBe("img");
    expect(galleryHrefForIndex("/products/oak-desk", 0)).toBe("/products/oak-desk#gallery");
    expect(galleryHrefForIndex("/products/oak-desk", 2)).toBe("/products/oak-desk?img=2#gallery");
  });

  test("drops any query or fragment already on basePath and uses the id as fragment", () => {
    expect(galleryHrefForIndex("/products/oak-desk?img=4&x=1#reviews", 1)).toBe("/products/oak-desk?img=1#gallery");
    expect(galleryHrefForIndex("/p", 3, "pdp-gallery")).toBe("/p?img=3#pdp-gallery");
    expect(galleryHrefForIndex("/p", 3, "  ")).toBe("/p?img=3");
  });

  test("negative, fractional and non-finite indexes omit the param", () => {
    for (const i of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(galleryHrefForIndex("/p", i)).toBe("/p#gallery");
    }
  });

  test("non same-origin paths are rejected (null)", () => {
    for (const bad of ["", "   ", "products/x", "//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "/a b", 42, null, undefined]) {
      expect(galleryHrefForIndex(bad, 1)).toBeNull();
    }
  });
});

describe("ImageGallery: basePath (Server Component callers)", () => {
  test("no-JS markup: thumbnails link to <basePath>?img=N#gallery, initialIndex current, no buttons", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={makeImages(3)} productName="Oak Desk" initialIndex={1} basePath="/products/oak-desk" />,
    );
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain('href="/products/oak-desk#gallery"');
    expect(html).toContain('href="/products/oak-desk?img=1#gallery"');
    expect(html).toContain('href="/products/oak-desk?img=2#gallery"');
    expect(html).not.toContain("<button");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('alt="Oak Desk, image 2 of 3"');
  });

  test("custom id becomes the fragment of basePath links", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={makeImages(2)} productName="Oak Desk" basePath="/p" id="pdp-gallery" />,
    );
    expect(html).toContain('href="/p?img=1#pdp-gallery"');
  });

  test("hrefForIndex wins over basePath when both are given", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={makeImages(2)} productName="Oak Desk" basePath="/p" hrefForIndex={hrefForIndex} />,
    );
    expect(html).toContain('href="?img=1#gallery"');
    expect(html).not.toContain('href="/p');
  });

  test("an unsafe basePath renders no links (buttons only)", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={makeImages(2)} productName="Oak Desk" basePath="//evil.example/x" />,
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("<button");
  });

  test("after hydration basePath thumbnails are buttons that switch the image in place", () => {
    const { container } = render(<ImageGallery images={makeImages(3)} productName="Oak Desk" basePath="/products/oak-desk" />);
    expect(container.querySelector("ul a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Image 3 of 3" }));
    expect(mainImage(container).getAttribute("alt")).toBe("Oak Desk, image 3 of 3");
  });
});
