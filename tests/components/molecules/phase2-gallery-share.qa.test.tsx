// QA (T70 / QA-W3-molecules-B): T62 ImageGallery, T67 ShareLink + CompareToggle.
// Independent of the implementers' colocated tests; imports only public entry points.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  ImageGallery,
  clampImageIndex,
  galleryImageAlt,
  safeImageUrl,
} from "@/components/molecules/ImageGallery";
import { ShareLink, buildMailtoHref } from "@/components/molecules/ShareLink";
import {
  CompareToggle,
  buildComparePath,
  normaliseCompareSlugs,
} from "@/components/molecules/CompareToggle";
import type { ProductImage } from "@/lib/types";
import { expectFocused, expectSameNode } from "@/test/dom-assertions";

function images(n: number, over: Partial<ProductImage> = {}): ProductImage[] {
  return Array.from({ length: n }, (_, i) => ({ url: `/images/p-${i}.svg`, alt: "", ...over }));
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

function pressEscape(dialog: HTMLDialogElement) {
  // happy-dom lacks the Escape -> cancel -> close sequence; dispatch it like a browser.
  act(() => {
    const proceed = dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    if (proceed) dialog.close();
  });
}

const thumbs = () => within(screen.getByRole("list", { name: "Product image thumbnails" })).getAllByRole("button");
const mainImg = (c: HTMLElement, id = "gallery") => c.querySelector(`#${id} img`) as HTMLElement;

// ===========================================================================
// T62 ImageGallery
// ===========================================================================
describe("T62 criterion 1: empty / single", () => {
  test("0 images: one placeholder, no thumbnail list, no zoom button, no dialog", () => {
    const { container } = render(<ImageGallery images={[]} productName="Oak Desk" />);
    expect(container.querySelectorAll("[data-placeholder]")).toHaveLength(1);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("1 image: no thumbnails; zoom still available", () => {
    const { container } = render(<ImageGallery images={images(1)} productName="Oak Desk" />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("button", { name: "Open image in full screen" })).toBeInTheDocument();
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});

describe("T62 criterion 2: thumbnails", () => {
  // T144: thumbnail names moved from "Show image N of M" to "Image N of M" (backlog T144 AC2, contract P-4).
  test("names 'Image N of M', aria-current only on the active one, click switches main image", () => {
    const { container } = render(<ImageGallery images={images(5)} productName="Oak Desk" />);
    const list = thumbs();
    expect(list.map((b) => b.textContent)).toEqual([1, 2, 3, 4, 5].map((n) => `Image ${n} of 5`));
    // Indexes, not DOM nodes, in toEqual (src/test/README.md).
    expect(list.flatMap((b, i) => (b.hasAttribute("aria-current") ? [i] : []))).toEqual([0]);
    expect(list[0]).toHaveAttribute("aria-current", "true");
    fireEvent.click(list[2] as HTMLElement);
    const after = thumbs();
    expect(after.flatMap((b, i) => (b.hasAttribute("aria-current") ? [i] : []))).toEqual([2]);
    expect(mainImg(container)).toHaveAttribute("alt", "Oak Desk, image 3 of 5");
  });

  test("roving tabindex: exactly one tabindex=0; ArrowRight/Left wrap, Home/End jump; focus does not change selection", () => {
    render(<ImageGallery images={images(4)} productName="Oak Desk" initialIndex={1} />);
    const zero = () => thumbs().filter((b) => b.getAttribute("tabindex") === "0");
    expect(zero()).toHaveLength(1);
    expectSameNode(zero()[0], thumbs()[1]);
    for (const b of thumbs()) if (b !== thumbs()[1]) expect(b).toHaveAttribute("tabindex", "-1");
    (thumbs()[1] as HTMLElement).focus();
    const key = (k: string) => fireEvent.keyDown(document.activeElement as HTMLElement, { key: k });
    key("ArrowRight");
    expectFocused(thumbs()[2] as HTMLElement);
    key("ArrowRight");
    key("ArrowRight");
    expectFocused(thumbs()[0] as HTMLElement); // wrapped
    key("ArrowLeft");
    expectFocused(thumbs()[3] as HTMLElement); // wrapped back
    key("Home");
    expectFocused(thumbs()[0] as HTMLElement);
    key("End");
    expectFocused(thumbs()[3] as HTMLElement);
    // Indexes, not DOM nodes, in toEqual (src/test/README.md).
    expect(thumbs().flatMap((b, i) => (b.getAttribute("tabindex") === "0" ? [i] : []))).toEqual([3]);
    // selection unchanged until activation
    expect(thumbs()[1]).toHaveAttribute("aria-current", "true");
    fireEvent.click(document.activeElement as HTMLElement);
    expect(thumbs()[3]).toHaveAttribute("aria-current", "true");
  });

  test("unrelated keys are ignored and not prevented", () => {
    render(<ImageGallery images={images(3)} productName="Oak Desk" />);
    (thumbs()[0] as HTMLElement).focus();
    const notPrevented = fireEvent.keyDown(document.activeElement as HTMLElement, { key: "a" });
    expect(notPrevented).toBe(true);
    expectFocused(thumbs()[0] as HTMLElement);
  });

  test("thumbnail touch targets are >= 44px (size-16) and the strip scrolls horizontally inside itself", () => {
    render(<ImageGallery images={images(8)} productName="Oak Desk" />);
    for (const b of thumbs()) expect(b.className).toContain("size-16");
    const ul = screen.getByRole("list", { name: "Product image thumbnails" });
    expect(ul.className).toContain("overflow-x-auto");
    expect(ul.className).toContain("w-full");
  });
});

describe("T62 criterion 3: lightbox", () => {
  test("zoom -> showModal; Escape closes; focus returns to zoom; prev/next inside", () => {
    const original = HTMLDialogElement.prototype.showModal;
    const spy = mock(function (this: HTMLDialogElement) {
      original.call(this);
    });
    HTMLDialogElement.prototype.showModal = spy;
    try {
      const { container } = render(<ImageGallery images={images(3)} productName="Oak Desk" />);
      const zoom = screen.getByRole("button", { name: "Open image in full screen" });
      zoom.focus();
      fireEvent.click(zoom);
      expect(spy).toHaveBeenCalledTimes(1);
      const dialog = container.querySelector("dialog") as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      expect(dialog).toHaveAccessibleName("Oak Desk");
      fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
      expect(within(dialog).getByText("Image 2 of 3")).toBeInTheDocument();
      fireEvent.keyDown(dialog, { key: "ArrowLeft" });
      fireEvent.keyDown(dialog, { key: "ArrowLeft" });
      expect(within(dialog).getByText("Image 3 of 3")).toBeInTheDocument(); // wraps
      pressEscape(dialog);
      expect(dialog.open).toBe(false);
      expectFocused(zoom);
      // reopen works after close
      fireEvent.click(zoom);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
  });

  test("Close button closes and returns focus", () => {
    const { container } = render(<ImageGallery images={images(2)} productName="Oak Desk" />);
    const zoom = screen.getByRole("button", { name: "Open image in full screen" });
    zoom.focus();
    fireEvent.click(zoom);
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "Close full screen image" }));
    expect(dialog.open).toBe(false);
    expectFocused(zoom);
  });
});

describe("T62 criterion 4/5: alt, loading, dimensions", () => {
  test("alt fallback '<name>, image N of M'; provided alt wins; blank alt / blank name fall back", () => {
    expect(galleryImageAlt({ url: "/a", alt: "Front view" }, "Oak Desk", 0, 3)).toBe("Front view");
    expect(galleryImageAlt({ url: "/a", alt: "   " }, "Oak Desk", 1, 3)).toBe("Oak Desk, image 2 of 3");
    expect(galleryImageAlt({ url: "/a", alt: "" }, "  ", 0, 1)).toBe("Product, image 1 of 1");
    expect(galleryImageAlt(undefined, "Oak Desk", 0, 1)).toBe("Oak Desk, image 1 of 1");
  });

  test("main image priority (eager/high), thumbnails lazy, explicit width/height everywhere", () => {
    const { container } = render(<ImageGallery images={images(4)} productName="Oak Desk" />);
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.length).toBe(5);
    const eager = imgs.filter((i) => i.getAttribute("loading") !== "lazy");
    expect(eager).toHaveLength(1);
    expect(eager[0]).toHaveAttribute("fetchpriority", "high");
    expect(eager[0]).toHaveAttribute("width", "800");
    for (const i of imgs) {
      expect(i.getAttribute("width")).toMatch(/^\d+$/);
      expect(i.getAttribute("height")).toMatch(/^\d+$/);
    }
    // thumbnails are decorative (the button carries the name)
    const thumbImgs = imgs.slice(1);
    for (const i of thumbImgs) expect(i.getAttribute("alt")).toBe("");
  });

  test("initialIndex clamping", () => {
    expect(clampImageIndex(Number.NaN, 3)).toBe(0);
    expect(clampImageIndex(-1, 3)).toBe(0);
    expect(clampImageIndex(99, 3)).toBe(2);
    expect(clampImageIndex(1.7, 3)).toBe(1);
    expect(clampImageIndex(Number.POSITIVE_INFINITY, 3)).toBe(0);
    expect(clampImageIndex(undefined, 3)).toBe(0);
    expect(clampImageIndex(2, 0)).toBe(0);
    const { container } = render(<ImageGallery images={images(3)} productName="Oak Desk" initialIndex={Number("abc")} />);
    expect(mainImg(container)).toHaveAttribute("alt", "Oak Desk, image 1 of 3");
    const { container: c2 } = render(<ImageGallery id="g2" images={images(3)} productName="Oak Desk" initialIndex={50} />);
    expect(mainImg(c2, "g2")).toHaveAttribute("alt", "Oak Desk, image 3 of 3");
  });

  test("unsafe URLs render the placeholder", () => {
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:x", "data:image/svg+xml,<svg/>", "//evil.example/x.png", "/\\evil.example/x.png", "images/rel.png", "", "   ", "ftp://x/y.png", "http:/broken"]) {
      expect(safeImageUrl(bad)).toBe("");
    }
    expect(safeImageUrl(" /images/ok.svg ")).toBe("/images/ok.svg");
    expect(safeImageUrl("https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
    expect(safeImageUrl(42)).toBe("");
    const { container } = render(
      <ImageGallery
        images={[{ url: "javascript:alert(1)", alt: "" }, { url: "//evil.example/a.png", alt: "" }, { url: "data:x", alt: "" }]}
        productName="Oak Desk"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("[data-placeholder]").length).toBeGreaterThanOrEqual(4);
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.innerHTML).not.toContain("evil.example");
  });
});

describe("T62 no-JS markup", () => {
  test("with hrefForIndex: thumbnails are <a href>, no <button>, no <dialog>; initialIndex marked current", () => {
    const html = renderToStaticMarkup(
      <ImageGallery images={images(3)} productName="Oak Desk" initialIndex={2} hrefForIndex={(i) => `?img=${i}#gallery`} />,
    );
    const doc = parse(html);
    expect(doc.querySelector("button")).toBeNull();
    expect(doc.querySelector("dialog")).toBeNull();
    const links = [...doc.querySelectorAll("ul a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["?img=0#gallery", "?img=1#gallery", "?img=2#gallery"]);
    expect(links.map((a) => a.textContent)).toEqual(["Image 1 of 3", "Image 2 of 3", "Image 3 of 3"]);
    expect(links[2]?.hasAttribute("aria-current")).toBe(true);
    expect(links[0]?.hasAttribute("aria-current")).toBe(false);
    expect(doc.getElementById("gallery")).not.toBeNull();
    // main image is the initialIndex image
    expect(html).toContain("Oak Desk, image 3 of 3");
  });

  test("no style= attributes other than on next/image <img> elements", () => {
    const doc = parse(renderToStaticMarkup(<ImageGallery images={images(3)} productName="Oak Desk" hrefForIndex={(i) => `?img=${i}`} />));
    const styled = [...doc.querySelectorAll("[style]")].filter((el) => el.tagName !== "IMG");
    expect(styled).toHaveLength(0);
  });
});

// ===========================================================================
// T67 ShareLink
// ===========================================================================
type Nav = Navigator & { share?: unknown; clipboard?: unknown };
const nav = navigator as Nav;
const saved = {
  clipboard: Object.getOwnPropertyDescriptor(nav, "clipboard"),
  share: Object.getOwnPropertyDescriptor(nav, "share"),
};
function setNav(key: "clipboard" | "share", value: unknown) {
  Object.defineProperty(nav, key, { value, configurable: true, writable: true });
}
afterEach(() => {
  for (const key of ["clipboard", "share"] as const) {
    const d = saved[key];
    if (d) Object.defineProperty(nav, key, d);
    else delete (nav as unknown as Record<string, unknown>)[key];
  }
});

function openShare() {
  const details = document.querySelector("details") as HTMLDetailsElement;
  act(() => {
    details.open = true;
  });
  return details;
}

describe("T67 ShareLink criterion 1: mailto encoding", () => {
  const nasty = "Desk & Chair? 50% off #1 = best\nLine two 🎉 a+b";
  test("subject/body survive URL parsing with &, ?, #, =, +, newlines and emoji", () => {
    const href = buildMailtoHref(nasty, "https://shop.example/products/desk?ref=a&b=c#x");
    const url = new URL(href);
    expect(url.protocol).toBe("mailto:");
    expect([...url.searchParams.keys()]).toEqual(["subject", "body"]);
    expect(url.searchParams.get("subject")).toBe(`Check out ${nasty}`);
    expect(url.searchParams.get("body")).toBe(`${nasty}\nhttps://shop.example/products/desk?ref=a&b=c#x`);
    expect(url.hash).toBe("");
    expect(href).not.toMatch(/[\n #]/);
  });

  test("custom text replaces the title in the body; lone surrogate never throws", () => {
    const url = new URL(buildMailtoHref("T", "https://x.example/p", "Look & see"));
    expect(url.searchParams.get("body")).toBe("Look & see\nhttps://x.example/p");
    expect(() => buildMailtoHref("bad \uD800 name", "https://x.example")).not.toThrow();
  });

  test("rendered 'Email a friend' link carries the encoded absolute URL", () => {
    render(<ShareLink url="/products/oak-desk" title={nasty} />);
    openShare();
    const link = screen.getByRole("link", { name: /Email a friend/ });
    const url = new URL(link.getAttribute("href") ?? "");
    const body = url.searchParams.get("body") ?? "";
    expect(body.startsWith(`${nasty}\n`)).toBe(true);
    expect(body).toMatch(/^[\s\S]*\nhttps?:\/\/[^/]+\/products\/oak-desk$/);
  });
});

describe("T67 ShareLink criterion 2: clipboard", () => {
  test("copy success announces 'Link copied' in a polite status region", async () => {
    const writeText = mock(async (t: string) => void t);
    setNav("clipboard", { writeText });
    render(<ShareLink url="/products/oak-desk" title="Oak Desk" />);
    openShare();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toMatch(/^https?:\/\/[^/]+\/products\/oak-desk$/);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    // String, not the node, inside waitFor (src/test/README.md).
    await waitFor(() => expect(status.textContent ?? "").toContain("Link copied"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  for (const [label, clip] of [
    ["denied (rejects)", { writeText: async () => { throw new DOMException("denied", "NotAllowedError"); } }],
    ["throws synchronously", { writeText: () => { throw new Error("boom"); } }],
    ["absent", undefined],
    ["writeText missing", {}],
  ] as const) {
    test(`clipboard ${label}: readonly field shown, focused, fully selected, with hint`, async () => {
      setNav("clipboard", clip);
      render(<ShareLink url="/products/oak-desk" title="Oak Desk" />);
      openShare();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
      });
      const field = (await screen.findByRole("textbox", { name: "Link to share" })) as HTMLInputElement;
      expect(field).toHaveAttribute("readonly");
      expect(field.value).toMatch(/\/products\/oak-desk$/);
      await waitFor(() => expectFocused(field));
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(field.value.length);
      expect(field).toHaveAccessibleDescription("Press Ctrl/Cmd+C to copy");
      expect(screen.getByRole("status")).not.toHaveTextContent("Link copied");
    });
  }
});

describe("T67 ShareLink: Web Share + static markup", () => {
  test("static markup: no Share… button, copy disabled, <noscript> readonly field, no scripts/iframes", () => {
    setNav("share", async () => {});
    const html = renderToStaticMarkup(<ShareLink url="/products/oak-desk" title="Oak Desk" />);
    expect(html).not.toContain("Share…");
    expect(html).toContain("<noscript>");
    expect(html).toMatch(/readOnly|readonly/);
    expect(html).not.toMatch(/<script|<iframe/i);
    const doc = parse(html);
    const copy = [...doc.querySelectorAll("button")].find((b) => b.textContent?.includes("Copy link"));
    expect(copy?.hasAttribute("disabled")).toBe(true);
    expect(doc.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  test("no navigator.share -> no Share… button after mount", () => {
    setNav("share", undefined);
    render(<ShareLink url="/products/oak-desk" title="Oak Desk" />);
    openShare();
    expect(screen.queryByRole("button", { name: /Share…/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy link" })).not.toBeDisabled();
  });

  test("navigator.share present -> button; AbortError ignored; other errors fall back to the field", async () => {
    const share = mock(async (d: unknown) => {
      void d;
      throw new DOMException("cancel", "AbortError");
    });
    setNav("share", share);
    const { unmount } = render(<ShareLink url="/products/oak-desk" title="Oak Desk" text="Nice desk" />);
    openShare();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    });
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ title: "Oak Desk", text: "Nice desk" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    unmount();

    setNav("share", async () => {
      throw new Error("not allowed");
    });
    render(<ShareLink url="/products/oak-desk" title="Oak Desk" />);
    openShare();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    });
    expect(await screen.findByRole("textbox", { name: "Link to share" })).toBeInTheDocument();
  });

  test("hostile title renders as text only", () => {
    const evil = `<img src=x onerror="window.__pwned=1">`;
    const { container } = render(<ShareLink url="/products/oak-desk" title={evil} />);
    openShare();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("list", { name: `Share ${evil}` })).toBeInTheDocument();
  });
});

// ===========================================================================
// T67 CompareToggle
// ===========================================================================
function formFields(form: HTMLFormElement, submitter?: HTMLElement): string[] {
  const fd = new FormData(form);
  const out: string[] = [];
  fd.forEach((v, k) => {
    if (k === "p") out.push(String(v));
  });
  void submitter;
  return out;
}

describe("T67 CompareToggle criterion 3: GET form", () => {
  test("form method=get action=/compare, hidden p for others, checkbox p=<slug>", () => {
    const { container } = render(
      <CompareToggle productSlug="oak-desk" productName="Oak Desk" selected={["lamp", "chair"]} />,
    );
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/compare");
    const hidden = [...form.querySelectorAll<HTMLInputElement>("input[type=hidden][name=p]")].map((i) => i.value);
    expect(hidden).toEqual(["lamp", "chair"]);
    const box = screen.getByRole("checkbox", { name: "Compare Oak Desk" }) as HTMLInputElement;
    expect(box.name).toBe("p");
    expect(box.value).toBe("oak-desk");
    expect(box.checked).toBe(false);
    expect(formFields(form)).toEqual(["lamp", "chair"]);
    fireEvent.click(box);
    expect(formFields(form)).toEqual(["lamp", "chair", "oak-desk"]);
    expect(screen.getByRole("button", { name: /Compare \(2\)/ })).toHaveAttribute("type", "submit");
  });

  test("already selected: checked, no duplicate hidden input; unchecking removes it from the submission", () => {
    const { container } = render(
      <CompareToggle productSlug="oak-desk" productName="Oak Desk" selected={["oak-desk", "lamp"]} />,
    );
    const form = container.querySelector("form") as HTMLFormElement;
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(formFields(form)).toEqual(["lamp", "oak-desk"]);
    fireEvent.click(box);
    expect(formFields(form)).toEqual(["lamp"]);
  });

  test("cap at 4: 5th selection blocked (disabled + message linked via aria-describedby)", () => {
    render(<CompareToggle productSlug="e" productName="Item E" selected={["a", "b", "c", "d"]} />);
    const box = screen.getByRole("checkbox", { name: "Compare Item E" });
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription("You can compare up to 4 products");
    expect(screen.getByText("You can compare up to 4 products")).toBeInTheDocument();
  });

  test("cap includes this product: 4 selected incl. this one -> enabled + checked", () => {
    render(<CompareToggle productSlug="d" productName="Item D" selected={["a", "b", "c", "d"]} />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box).not.toBeDisabled();
    expect(box.checked).toBe(true);
  });

  test("dirty selection (dupes, blanks, > 4) is normalised before hidden inputs", () => {
    const { container } = render(
      <CompareToggle productSlug="z" productName="Z" selected={["a", " a ", "", "b", "b", "c", "d", "e", "f"]} />,
    );
    const hidden = [...container.querySelectorAll<HTMLInputElement>("input[type=hidden][name=p]")].map((i) => i.value);
    expect(hidden).toEqual(["a", "b", "c", "d"]);
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  test("basePath: 'Add to selection' formAction + non-p params replayed; unsafe basePath ignored", () => {
    const { container, unmount } = render(
      <CompareToggle productSlug="z" productName="Z" selected={["a"]} basePath="/search?q=desk&p=a&sort=price" />,
    );
    const add = screen.getByRole("button", { name: "Add to selection" });
    expect(add.getAttribute("formaction")).toBe("/search");
    const hiddenNonP = [...container.querySelectorAll<HTMLInputElement>("input[type=hidden]")]
      .filter((i) => i.name !== "p")
      .map((i) => `${i.name}=${i.value}`);
    expect(hiddenNonP).toEqual(["q=desk", "sort=price"]);
    unmount();
    for (const bad of ["//evil.example/x", "https://evil.example", "javascript:alert(1)", "search"]) {
      const r = render(<CompareToggle productSlug="z" productName="Z" selected={[]} basePath={bad} />);
      expect(screen.queryByRole("button", { name: "Add to selection" })).toBeNull();
      r.unmount();
    }
  });

  test("blank slug renders nothing; server-safe static markup", () => {
    const { container } = render(<CompareToggle productSlug="  " productName="X" selected={[]} />);
    expect(container.innerHTML).toBe("");
    const html = renderToStaticMarkup(<CompareToggle productSlug="a" productName="A" selected={["b"]} />);
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/compare"');
    expect(html).not.toMatch(/<script/i);
  });

  test("link mode: add / remove labels, full -> message only", () => {
    const { unmount } = render(<CompareToggle mode="link" productSlug="b" productName="B" selected={["a"]} />);
    const add = screen.getByRole("link", { name: /Add to compare/ });
    expect(add).toHaveAttribute("href", "/compare?p=a&p=b");
    expect(add.textContent).toBe("Add to compare: B");
    unmount();
    const r2 = render(<CompareToggle mode="link" productSlug="a" productName="A" selected={["a", "b"]} />);
    expect(screen.getByRole("link", { name: /Remove from compare/ })).toHaveAttribute("href", "/compare?p=b");
    r2.unmount();
    render(<CompareToggle mode="link" productSlug="e" productName="E" selected={["a", "b", "c", "d"]} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("You can compare up to 4 products")).toBeInTheDocument();
  });
});

describe("T67 buildComparePath", () => {
  test("dedupe / cap / encode / remove", () => {
    expect(buildComparePath([], "a")).toBe("/compare?p=a");
    expect(buildComparePath(["a"], "b")).toBe("/compare?p=a&p=b");
    expect(buildComparePath(["a", "b"], "a")).toBe("/compare?p=b");
    expect(buildComparePath(["a"], "a")).toBe("/compare");
    expect(buildComparePath(["a", "a", "b"], "c")).toBe("/compare?p=a&p=b&p=c");
    expect(buildComparePath(["a", "b", "c", "d"], "e")).toBe("/compare?p=a&p=b&p=c&p=d");
    expect(buildComparePath(["a", "b", "c", "d", "e", "f"], "a")).toBe("/compare?p=b&p=c&p=d");
    expect(buildComparePath(["x y&z=1#h"], "é")).toBe("/compare?p=x+y%26z%3D1%23h&p=%C3%A9");
    expect(new URL(buildComparePath(["x y&z=1#h"], "é"), "http://l.invalid").searchParams.getAll("p")).toEqual(["x y&z=1#h", "é"]);
    expect(buildComparePath(["a"], "   ")).toBe("/compare?p=a");
    expect(buildComparePath(["a", "b"], "c", 2)).toBe("/compare?p=a&p=b");
    expect(buildComparePath(["a"], "b", Number.NaN)).toBe("/compare?p=a&p=b");
    expect(buildComparePath(["a", "b", "c", "d"], "e", 0)).toBe("/compare?p=a&p=b&p=c&p=d");
    expect(normaliseCompareSlugs([" a", "a ", "b"])).toEqual(["a", "b"]);
  });
});

// ===========================================================================
// Known defects (test.failing until fixed)
// ===========================================================================
describe("QA-W3-B defects", () => {
  // D-T67-1: the status text stays "Link copied" after the first copy, so a second copy changes nothing
  // in the live region and screen readers get no confirmation.
  test("D-T67-1: a second successful copy is announced again (live region content changes)", async () => {
    setNav("clipboard", { writeText: async () => {} });
    render(<ShareLink url="/products/oak-desk" title="Oak Desk" />);
    openShare();
    const status = screen.getByRole("status");
    const mutations: string[] = [];
    const obs = new MutationObserver(() => mutations.push(status.textContent ?? ""));
    obs.observe(status, { childList: true, subtree: true, characterData: true });
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    obs.disconnect();
    expect(mutations.filter((m) => m.includes("copied")).length).toBeGreaterThanOrEqual(2);
  });
});
