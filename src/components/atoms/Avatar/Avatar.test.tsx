import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { AVATAR_TONES, Avatar, avatarTone, getInitials } from "./Avatar";

describe("Avatar", () => {
  test("initials fallback: role=img named by name, initials hidden", () => {
    render(<Avatar name="Jane Q Doe" />);
    const avatar = screen.getByRole("img", { name: "Jane Q Doe" });
    const initials = screen.getByText("JD");
    expect(initials).toHaveAttribute("aria-hidden", "true");
    expect(avatar).toHaveClass("rounded-full", "text-text-primary", "size-10");
  });

  test("getInitials", () => {
    expect(getInitials("jane")).toBe("J");
    expect(getInitials("  ada   lovelace ")).toBe("AL");
    expect(getInitials("")).toBe("?");
    expect(getInitials("Émile Zola")).toBe("ÉZ");
  });

  test("background is deterministic and from the small token set", () => {
    expect(avatarTone("Jane Doe")).toBe(avatarTone("jane doe"));
    const seen = new Set(["Ann", "Bob", "Cy", "Dee", "Eve", "Fay", "Gus", "Hal"].map(avatarTone));
    for (const tone of seen) expect(AVATAR_TONES).toContain(tone);
    expect(seen.size).toBeGreaterThan(1);
    const { container } = render(<Avatar name="Jane Doe" />);
    expect(container.firstElementChild).toHaveClass(avatarTone("Jane Doe"));
  });

  test("src renders a decorative image; error falls back to initials", () => {
    const { container } = render(<Avatar name="Sam Lee" src="/avatars/sam.png" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("alt", "");
    expect(screen.getByRole("img", { name: "Sam Lee" })).toBeInTheDocument();
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("SL")).toBeInTheDocument();
  });

  test("blank src uses initials", () => {
    const { container } = render(<Avatar name="Kim" src="   " />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("K")).toBeInTheDocument();
  });

  test("decorative hides it from assistive tech", () => {
    const { container } = render(<Avatar name="Kim" decorative />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("sizes, className last, ref", () => {
    const ref = createRef<HTMLSpanElement>();
    const { rerender } = render(<Avatar name="A B" size="sm" />);
    expect(screen.getByRole("img")).toHaveClass("size-8", "text-caption");
    rerender(<Avatar name="A B" size="lg" className="ring-2" ref={ref} />);
    const el = screen.getByRole("img");
    expect(el).toHaveClass("size-14");
    expect(el.className.split(" ").at(-1)).toBe("ring-2");
    expect(ref.current).toBe(el as HTMLSpanElement);
  });
});
