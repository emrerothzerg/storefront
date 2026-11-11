import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Image } from "./Image";

const SVG_SRC = "/images/products/canvas-tote-bag.svg";

// happy-dom starts at "about:blank", and next/image's dev-only LCP tracker
// does `new URL(src, window.location.href)`, which throws for a relative src
// against about:blank. Give the document a real origin for this file only.
type HappyGlobal = typeof globalThis & {
  happyDOM?: { setURL(url: string): void };
};
const happy = (globalThis as HappyGlobal).happyDOM;
let originalHref = "about:blank";
beforeAll(() => {
  originalHref = window.location.href;
  happy?.setURL("http://localhost:3000/");
});
afterAll(() => {
  happy?.setURL(originalHref);
});

describe("Image", () => {
  test("renders a plain <img> with width/height and loading=lazy by default", () => {
    render(<Image src={SVG_SRC} alt="Canvas tote bag" width={400} height={300} />);
    const img = screen.getByRole("img", { name: "Canvas tote bag" });
    expect(img.tagName).toBe("IMG");
    // happy-dom reflects src resolved against the document URL.
    expect(new URL(img.getAttribute("src") ?? "", window.location.href).pathname).toBe(SVG_SRC);
    expect(img).toHaveAttribute("width", "400");
    expect(img).toHaveAttribute("height", "300");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).not.toHaveAttribute("fetchpriority");
  });

  test("priority opts out of lazy loading for above-the-fold images", () => {
    render(<Image src={SVG_SRC} alt="Hero" width={800} height={600} priority />);
    const img = screen.getByRole("img", { name: "Hero" });
    expect(img).toHaveAttribute("loading", "eager");
    expect(img).toHaveAttribute("fetchpriority", "high");
  });

  test("renders optimised (non-SVG) sources through next/image too", () => {
    render(<Image src="/photo.jpg" alt="Photo" width={640} height={480} sizes="100vw" />);
    const img = screen.getByRole("img", { name: "Photo" });
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img.getAttribute("src")).toContain("/_next/image?url=%2Fphoto.jpg");
    expect(img).toHaveAttribute("sizes", "100vw");
  });

  test("empty alt is allowed and decorative", () => {
    render(<Image src={SVG_SRC} alt="" width={10} height={10} />);
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("alt", "");
  });

  test.each([[""], [null], [undefined]])("src %p renders a sized placeholder", (src) => {
    render(<Image src={src} alt="Brass desk lamp" width={320} height={240} />);
    const placeholder = screen.getByRole("img", { name: "Brass desk lamp" });
    expect(placeholder.tagName).toBe("DIV");
    expect(placeholder).toHaveClass("bg-surface-sunken");
    const svg = placeholder.querySelector("svg");
    expect(svg).toHaveAttribute("width", "320");
    expect(svg).toHaveAttribute("height", "240");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector("img")).toBeNull();
  });

  test.each([["   "], ["\n"], ["\t \n"]])(
    "whitespace-only src %p renders the placeholder instead of throwing",
    (src) => {
      render(<Image src={src} alt="Lamp" width={50} height={40} />);
      const placeholder = screen.getByRole("img", { name: "Lamp" });
      expect(placeholder.tagName).toBe("DIV");
      expect(placeholder).toHaveAttribute("data-placeholder");
      expect(document.querySelector("img")).toBeNull();
    },
  );

  test("surrounding whitespace is trimmed before reaching next/image", () => {
    render(<Image src=" /images/x.svg " alt="X" width={10} height={10} />);
    const img = screen.getByRole("img", { name: "X" });
    expect(img.tagName).toBe("IMG");
    expect(new URL(img.getAttribute("src") ?? "", window.location.href).pathname).toBe(
      "/images/x.svg",
    );
  });

  test("decorative placeholder is aria-hidden", () => {
    render(<Image src={null} alt="" width={10} height={10} />);
    const placeholder = document.querySelector("[data-placeholder]");
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(placeholder).not.toHaveAttribute("aria-label");
  });

  test("swaps to the placeholder when the image errors, and retries on a new src", () => {
    const onError = mock();
    const { rerender } = render(
      <Image src="/missing.svg" alt="Lamp" width={100} height={100} onError={onError} />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Lamp" }));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Lamp" }).tagName).toBe("DIV");
    rerender(<Image src={SVG_SRC} alt="Lamp" width={100} height={100} />);
    expect(screen.getByRole("img", { name: "Lamp" }).tagName).toBe("IMG");
  });

  test("fill mode renders without width/height and a fill placeholder", () => {
    const { rerender } = render(<Image src={SVG_SRC} alt="Fill" fill sizes="50vw" />);
    const img = screen.getByRole("img", { name: "Fill" });
    expect(img).not.toHaveAttribute("width");
    rerender(<Image src={null} alt="Fill" fill />);
    expect(screen.getByRole("img", { name: "Fill" })).toHaveClass("absolute", "inset-0");
  });

  test("rounded and className are applied (className last)", () => {
    render(<Image src={SVG_SRC} alt="R" width={1} height={1} rounded className="object-cover" />);
    const img = screen.getByRole("img", { name: "R" });
    expect(img).toHaveClass("rounded-md", "object-cover");
    expect(img.className.endsWith("object-cover")).toBe(true);
  });
});

// Compile-time contract (checked by `bun run typecheck`, never executed).
/* eslint-disable jsx-a11y/alt-text -- intentional: the missing alt is the compile error under test */
export function _typeTests() {
  return (
    <>
      {/* @ts-expect-error alt is required */}
      <Image src={SVG_SRC} width={1} height={1} />
      {/* @ts-expect-error width/height are required unless fill */}
      <Image src={SVG_SRC} alt="" />
      {/* @ts-expect-error fill forbids width/height */}
      <Image src={SVG_SRC} alt="" fill width={1} height={1} />
      <Image src={SVG_SRC} alt="" width={1} height={1} />
      <Image src={undefined} alt="" fill />
    </>
  );
}
/* eslint-enable jsx-a11y/alt-text */
