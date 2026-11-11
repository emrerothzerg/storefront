// QA (T03.4-T03.6): Image adversarial checks. happy-dom is registered at
// http://localhost:3000/ by the preload, so next/image renders.
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Image } from "@/components/atoms/Image";

const SRC = "/images/products/canvas-tote-bag.svg";
const pathOf = (el: Element | null) =>
  new URL(el?.getAttribute("src") ?? "", window.location.href).pathname;

describe("Image placeholder", () => {
  test.each([[""], [null], [undefined]])("src %p renders a sized placeholder, not an <img>", (src) => {
    const { container } = render(<Image src={src} alt="Lamp" width={320} height={240} />);
    expect(container.querySelector("img")).toBeNull();
    const ph = screen.getByRole("img", { name: "Lamp" });
    expect(ph).toHaveAttribute("data-placeholder");
    const svg = ph.querySelector("svg");
    expect(svg).toHaveAttribute("width", "320");
    expect(svg).toHaveAttribute("height", "240");
  });

  test("alt='' placeholder is aria-hidden (decorative)", () => {
    const { container } = render(<Image src={null} alt="" width={10} height={10} />);
    const ph = container.querySelector("[data-placeholder]");
    expect(ph).toHaveAttribute("aria-hidden", "true");
    expect(ph).not.toHaveAttribute("aria-label");
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("fill + empty src renders an absolutely positioned placeholder", () => {
    render(
      <div className="relative">
        <Image src="" alt="Hero" fill />
      </div>,
    );
    const ph = screen.getByRole("img", { name: "Hero" });
    expect(ph).toHaveClass("absolute", "inset-0", "bg-surface-sunken");
  });

  test("onError swaps to placeholder and calls the user's onError once", () => {
    const onError = mock(() => {});
    const { container } = render(
      <Image src={SRC} alt="Tote" width={100} height={100} onError={onError} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "Tote" })).toHaveAttribute("data-placeholder");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("after an error, a new src gets a fresh attempt", () => {
    const { container, rerender } = render(<Image src={SRC} alt="T" width={10} height={10} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    rerender(<Image src="/other.svg" alt="T" width={10} height={10} />);
    expect(pathOf(container.querySelector("img"))).toBe("/other.svg");
  });
});

describe("Image loading", () => {
  test("default: width/height set and loading=lazy, no fetchpriority", () => {
    const { container } = render(<Image src={SRC} alt="Tote" width={400} height={300} />);
    const img = container.querySelector("img");
    expect(pathOf(img)).toBe(SRC);
    expect(img).toHaveAttribute("width", "400");
    expect(img).toHaveAttribute("height", "300");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).not.toHaveAttribute("fetchpriority");
  });

  test("priority: eager + fetchpriority=high", () => {
    const { container } = render(<Image src={SRC} alt="Hero" width={800} height={600} priority />);
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("loading", "eager");
    expect(img).toHaveAttribute("fetchpriority", "high");
  });

  test("fill renders an <img> with no width/height and lazy loading", () => {
    // Raster src: next/image drops `sizes` for unoptimised SVGs, so use a .jpg here.
    const { container } = render(
      <div className="relative">
        <Image src="/photo.jpg" alt="Fill" fill sizes="100vw" />
      </div>,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).not.toHaveAttribute("width");
    expect(img).not.toHaveAttribute("height");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("sizes", "100vw");
  });

  test("alt='' real image keeps alt='' (decorative)", () => {
    const { container } = render(<Image src={SRC} alt="" width={10} height={10} />);
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });

  test("type contract: alt required, fill excludes width/height, fixed requires both", () => {
    const compileOnly = () => (
      <>
        {/* eslint-disable jsx-a11y/alt-text -- missing alt is the compile error under test */}
        {/* @ts-expect-error alt is required */}
        <Image src={SRC} width={1} height={1} />
        {/* eslint-enable jsx-a11y/alt-text */}
        {/* @ts-expect-error width/height not allowed with fill */}
        <Image src={SRC} alt="x" fill width={1} height={1} />
        {/* @ts-expect-error height missing */}
        <Image src={SRC} alt="x" width={1} />
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});
