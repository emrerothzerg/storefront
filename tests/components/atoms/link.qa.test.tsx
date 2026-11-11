// QA (T02.4): Link adversarial checks.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Link } from "@/components/atoms/Link";

let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errSpy = spyOn(console, "error").mockImplementation(mock(() => {}));
});
afterEach(() => {
  errSpy.mockRestore();
});

function Icon() {
  return (
    <svg data-testid="icon" aria-hidden="true" viewBox="0 0 10 10">
      <path d="M0 0h10v10H0z" />
    </svg>
  );
}

describe("Link", () => {
  test("internal link renders an <a href> without target/rel", () => {
    render(<Link href="/products">Products</Link>);
    const a = screen.getByRole("link", { name: "Products" });
    expect(a.tagName).toBe("A");
    expect(a).toHaveAttribute("href", "/products");
    expect(a).not.toHaveAttribute("target");
    expect(a).not.toHaveAttribute("rel");
    expect(a).not.toHaveAttribute("aria-current");
  });

  test("external link with an icon child: rel, target, sr-only suffix, icon hidden", () => {
    render(
      <Link href="https://example.com/help" external>
        Help <Icon />
      </Link>,
    );
    const a = screen.getByRole("link", { name: "Help (opens in new tab)" });
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
    expect(a).toHaveAttribute("target", "_blank");
    expect(screen.getByTestId("icon")).toHaveAttribute("aria-hidden", "true");
  });

  test("rel/target cannot be overridden by props (compile + runtime)", () => {
    const props = { rel: "opener", target: "_self" } as Record<string, string>;
    render(
      <Link href="https://example.com" external {...props}>
        Ext
      </Link>,
    );
    const a = screen.getByRole("link", { name: /Ext/ });
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
    expect(a).toHaveAttribute("target", "_blank");
  });

  test.each([["inline"], ["nav"], ["subtle"]] as const)("isCurrent on %s sets aria-current=page and a non-colour cue", (variant) => {
    render(
      <Link href="/a" variant={variant} isCurrent>
        Here
      </Link>,
    );
    const a = screen.getByRole("link", { name: "Here" });
    expect(a).toHaveAttribute("aria-current", "page");
    expect(a.className).toMatch(/\b(underline|decoration-2)\b/);
  });

  test("external + isCurrent keeps aria-current", () => {
    render(
      <Link href="https://example.com" external isCurrent>
        X
      </Link>,
    );
    expect(screen.getByRole("link", { name: /X/ })).toHaveAttribute("aria-current", "page");
  });

  test.each([["nav"], ["subtle"]] as const)("%s variant has a 44px touch target", (variant) => {
    render(
      <Link href="/a" variant={variant}>
        T
      </Link>,
    );
    expect(screen.getByRole("link")).toHaveClass("min-h-touch", "min-w-touch");
  });

  test("href='javascript:alert(1)' is neutralised by React (no script URL reaches the DOM)", () => {
    render(<Link href="javascript:alert(1)">Evil</Link>);
    const a = screen.getByRole("link", { name: "Evil" });
    const href = a.getAttribute("href") ?? "";
    // React 19 replaces javascript: URLs with a throwing stub. Record what we got.
    console.info(`[link.qa] javascript: href rendered as: ${href}`);
    expect(href).not.toBe("javascript:alert(1)");
    expect(href).not.toContain("alert(1)");
  });

  test("external href='javascript:alert(1)' is neutralised too", () => {
    render(
      <Link href="javascript:alert(1)" external>
        Evil
      </Link>,
    );
    const a = screen.getByRole("link", { name: /Evil/ });
    expect(a.getAttribute("href") ?? "").not.toContain("alert(1)");
  });

  describe("tone (inverse for surface-inverse)", () => {
    const FORBIDDEN = ["text-text-secondary", "text-accent", "text-text-primary"];
    // Strip variant prefixes (hover:, md:...) so hover:text-accent also counts.
    const colourTokens = (el: Element) => el.className.split(/\s+/).map((c) => c.split(":").pop());

    const combos = (["inline", "nav", "subtle"] as const).flatMap((variant) =>
      [false, true].flatMap((isCurrent) => [false, true].map((external) => [variant, isCurrent, external] as const)),
    );
    test.each(combos)("inverse %s (current=%p, external=%p) uses only text-text-inverse", (variant, isCurrent, external) => {
      render(
        <Link href="/a" tone="inverse" variant={variant} isCurrent={isCurrent} external={external}>
          Foot
        </Link>,
      );
      const a = screen.getByRole("link", { name: /Foot/ });
      const tokens = colourTokens(a);
      for (const bad of FORBIDDEN) expect(tokens).not.toContain(bad);
      expect(a).toHaveClass("text-text-inverse");
      if (isCurrent) {
        expect(a).toHaveAttribute("aria-current", "page");
        expect(a.className).toMatch(/\b(underline|decoration-2)\b/);
      }
    });

    // Exact class strings from the pre-tone implementation: default must be unchanged.
    const DEFAULT: Record<"inline" | "nav" | "subtle", [string, string]> = {
      inline: ["text-accent underline underline-offset-2 hover:decoration-2", "decoration-2"],
      nav: [
        "inline-flex min-h-touch min-w-touch items-center text-text-primary underline-offset-4 hover:text-accent hover:underline",
        "text-accent underline decoration-2",
      ],
      subtle: [
        "inline-flex min-h-touch min-w-touch items-center text-text-secondary underline-offset-2 hover:text-text-primary hover:underline",
        "text-text-primary underline",
      ],
    };
    test.each((["inline", "nav", "subtle"] as const).flatMap((v) => [[v, false], [v, true]] as const))(
      "default tone %s (current=%p) is byte-identical to before; tone='default' equals omitted",
      (variant, isCurrent) => {
        const expected = isCurrent ? `${DEFAULT[variant][0]} ${DEFAULT[variant][1]}` : DEFAULT[variant][0];
        const { unmount } = render(
          <Link href="/a" variant={variant} isCurrent={isCurrent}>
            D
          </Link>,
        );
        expect(screen.getByRole("link", { name: "D" }).className).toBe(expected);
        unmount();
        render(
          <Link href="/a" tone="default" variant={variant} isCurrent={isCurrent}>
            D
          </Link>,
        );
        expect(screen.getByRole("link", { name: "D" }).className).toBe(expected);
      },
    );
  });
});
