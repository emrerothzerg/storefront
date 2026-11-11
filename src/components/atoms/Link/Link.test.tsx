import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Link } from "./Link";

describe("Link", () => {
  test("internal link renders an <a href> via next/link", () => {
    render(<Link href="/products/shoe">Shoe</Link>);
    const a = screen.getByRole("link", { name: "Shoe" });
    expect(a.tagName).toBe("A");
    expect(a).toHaveAttribute("href", "/products/shoe");
    expect(a).not.toHaveAttribute("target");
    expect(a).not.toHaveAttribute("aria-current");
  });

  test("inline variant (default) uses accent colour and an underline", () => {
    render(<Link href="/a">Inline</Link>);
    expect(screen.getByRole("link", { name: "Inline" })).toHaveClass("text-accent", "underline");
  });

  test("external link opens in a new tab safely and says so", () => {
    render(
      <Link href="https://example.com" external>
        Docs
      </Link>,
    );
    const a = screen.getByRole("link", { name: "Docs (opens in new tab)" });
    expect(a).toHaveAttribute("href", "https://example.com");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("(opens in new tab)")).toHaveClass("sr-only");
  });

  test("current page sets aria-current and a non-colour indicator", () => {
    render(
      <Link href="/cart" variant="nav" isCurrent>
        Cart
      </Link>,
    );
    const a = screen.getByRole("link", { name: "Cart" });
    expect(a).toHaveAttribute("aria-current", "page");
    expect(a).toHaveClass("underline", "min-h-touch");
  });

  test("current page works on external links too", () => {
    render(
      <Link href="https://example.com" external isCurrent>
        Ext
      </Link>,
    );
    expect(screen.getByRole("link", { name: /Ext/ })).toHaveAttribute("aria-current", "page");
  });

  test("subtle variant uses secondary text and a touch target", () => {
    render(
      <Link href="/help" variant="subtle">
        Help
      </Link>,
    );
    expect(screen.getByRole("link", { name: "Help" })).toHaveClass(
      "text-text-secondary",
      "min-h-touch",
    );
  });

  test("merges className last and forwards rest props", () => {
    render(
      <Link href="/x" className="ml-2" data-testid="l" aria-describedby="hint">
        X
      </Link>,
    );
    const a = screen.getByTestId("l");
    expect(a).toHaveAttribute("aria-describedby", "hint");
    expect(a.className.endsWith("ml-2")).toBe(true);
  });

  test.each(["inline", "nav", "subtle"] as const)(
    "inverse tone %s uses text-inverse only, never secondary or accent",
    (variant) => {
      render(
        <Link href="/about" tone="inverse" variant={variant}>
          About
        </Link>,
      );
      const a = screen.getByRole("link", { name: "About" });
      expect(a).toHaveClass("text-text-inverse", "hover:text-text-inverse");
      expect(a).not.toHaveClass("text-text-secondary", "text-accent", "text-text-primary");
      expect(a).not.toHaveClass("hover:text-accent", "hover:text-text-primary");
    },
  );

  test("inverse tone underlines on hover (nav/subtle) and always (inline)", () => {
    render(
      <>
        <Link href="/a" tone="inverse">
          Inline
        </Link>
        <Link href="/b" tone="inverse" variant="subtle">
          Subtle
        </Link>
      </>,
    );
    expect(screen.getByRole("link", { name: "Inline" })).toHaveClass("underline");
    const subtle = screen.getByRole("link", { name: "Subtle" });
    expect(subtle).toHaveClass("hover:underline", "min-h-touch");
    expect(subtle).not.toHaveClass("underline");
  });

  test("inverse tone current page is underlined and sets aria-current", () => {
    render(
      <Link href="/faq" tone="inverse" variant="subtle" isCurrent>
        FAQ
      </Link>,
    );
    const a = screen.getByRole("link", { name: "FAQ" });
    expect(a).toHaveAttribute("aria-current", "page");
    expect(a).toHaveClass("underline", "text-text-inverse");
    expect(a).not.toHaveClass("text-text-primary");
  });

  test("inverse tone works for external links", () => {
    render(
      <Link href="https://example.com" external tone="inverse" variant="nav">
        Blog
      </Link>,
    );
    const a = screen.getByRole("link", { name: "Blog (opens in new tab)" });
    expect(a).toHaveClass("text-text-inverse");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("default tone is unchanged when tone is omitted or explicit", () => {
    render(
      <>
        <Link href="/x" variant="subtle">
          Omitted
        </Link>
        <Link href="/y" variant="subtle" tone="default">
          Explicit
        </Link>
      </>,
    );
    for (const name of ["Omitted", "Explicit"]) {
      expect(screen.getByRole("link", { name })).toHaveClass("text-text-secondary");
    }
  });

  test("button variant renders an <a href> with the primary Button md classes (pill)", () => {
    render(
      <Link href="/checkout" variant="button">
        Proceed to checkout
      </Link>,
    );
    const a = screen.getByRole("link", { name: "Proceed to checkout" });
    expect(a.tagName).toBe("A");
    expect(a).toHaveAttribute("href", "/checkout");
    expect(a).toHaveClass(
      "inline-flex",
      "items-center",
      "justify-center",
      "gap-2",
      "min-h-touch",
      "min-w-touch",
      "rounded-full",
      "font-semibold",
      "bg-accent",
      "text-text-on-accent",
      "hover:bg-accent-hover",
      "active:bg-accent-active",
      "px-4",
      "py-2",
      "text-body",
      "no-underline",
      "hover:no-underline",
    );
    expect(a).not.toHaveClass("text-accent", "underline", "hover:underline", "text-text-primary");
  });

  test("button variant keeps aria-current without adding text-link current styles", () => {
    render(
      <Link href="/checkout" variant="button" isCurrent className="w-full">
        Checkout
      </Link>,
    );
    const a = screen.getByRole("link", { name: "Checkout" });
    expect(a).toHaveAttribute("aria-current", "page");
    expect(a).not.toHaveClass("underline", "text-accent");
    expect(a.className.endsWith("w-full")).toBe(true);
  });

  test("button variant works as an external link", () => {
    render(
      <Link href="https://example.com" external variant="button">
        Visit
      </Link>,
    );
    const a = screen.getByRole("link", { name: "Visit (opens in new tab)" });
    expect(a).toHaveClass("bg-accent", "text-text-on-accent");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("explicit aria-current overrides the isCurrent default; styling still follows isCurrent", () => {
    render(
      <Link href="/reviews?stars=5" variant="subtle" isCurrent aria-current="true">
        5 star
      </Link>,
    );
    const a = screen.getByRole("link", { name: "5 star" });
    expect(a).toHaveAttribute("aria-current", "true");
    expect(a).toHaveClass("underline");
    expect(a).toHaveClass("text-text-primary");
  });

  test("each aria-current token is honoured with isCurrent, on internal and external links", () => {
    const tokens = ["true", "step", "location", "date", "time", "page", "false"] as const;
    for (const token of tokens) {
      const { unmount } = render(
        <>
          <Link href="/a" isCurrent aria-current={token}>
            internal
          </Link>
          <Link href="https://example.com" external isCurrent aria-current={token}>
            external
          </Link>
        </>,
      );
      for (const a of screen.getAllByRole("link")) expect(a).toHaveAttribute("aria-current", token);
      unmount();
    }
  });

  test("isCurrent without an override still defaults to aria-current=page", () => {
    render(
      <Link href="/a" variant="nav" isCurrent>
        Home
      </Link>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "page");
  });

  test("explicit aria-current without isCurrent passes through with no current styling", () => {
    render(
      <Link href="/a" variant="nav" aria-current="step">
        Step 2
      </Link>,
    );
    const a = screen.getByRole("link");
    expect(a).toHaveAttribute("aria-current", "step");
    expect(a).not.toHaveClass("decoration-2");
  });

  test("button variant honours an explicit aria-current", () => {
    render(
      <Link href="/a" variant="button" isCurrent aria-current="location">
        Go
      </Link>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "location");
  });

  test("invalid props are compile-time errors", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error href is required */}
        <Link>x</Link>
        {/* @ts-expect-error tone="inverse" is not allowed with variant="button" */}
        <Link href="/x" variant="button" tone="inverse">
          x
        </Link>
        {/* @ts-expect-error "dark" is not a valid tone */}
        <Link href="/x" tone="dark">
          x
        </Link>
        {/* @ts-expect-error target is controlled by `external` */}
        <Link href="/x" target="_blank">
          x
        </Link>
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});
