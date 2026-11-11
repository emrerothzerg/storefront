import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Card } from "../Card";
import { Rating } from "./Rating";

const list = (el: Element | null): string[] => (el?.getAttribute("class") ?? "").split(" ");

describe("Rating input: focus ring drawn by the radio (D-T131-4)", () => {
  test("no label sets an outline colour; each radio is a transparent 44px layer that receives focus", () => {
    render(<Rating mode="input" name="r" label="Rating" />);
    for (const radio of screen.getAllByRole("radio")) {
      const label = radio.closest("label");
      expect(list(label)).toContain("relative");
      expect(list(label)).toContain("size-touch");
      expect(list(label).filter((c) => c.includes("outline"))).toEqual([]);
      for (const c of ["absolute", "inset-0", "size-full", "appearance-none", "bg-transparent", "rounded-md"]) {
        expect(list(radio)).toContain(c);
      }
      expect(list(radio)).not.toContain("sr-only");
      expect(list(radio).filter((c) => /outline-(none|0|focus-ring)/.test(c))).toEqual([]);
      expect(radio).not.toHaveAttribute("tabindex");
    }
  });

  test("inside a dark band the focused radio is a .bg-surface-inverse descendant (base white-ring rule applies)", () => {
    render(
      <Card tone="inverse">
        <Rating mode="input" name="r" label="Rating" />
      </Card>,
    );
    const radio = screen.getByRole("radio", { name: "4 out of 5 stars" });
    radio.focus();
    expect(document.activeElement).toBe(radio);
    expect(radio.closest(".bg-surface-inverse")).not.toBeNull();
  });

  test("clicking the (overlaying) radio still selects the star and posts the value", () => {
    render(
      <form data-testid="f">
        <Rating mode="input" name="stars" label="Rating" />
      </form>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "3 out of 5 stars" }));
    expect(new FormData(screen.getByTestId("f") as HTMLFormElement).get("stars")).toBe("3");
  });

  test("disabled: radios disabled, not-allowed cursor on both layers", () => {
    render(<Rating mode="input" name="r" label="Rating" disabled />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
      expect(list(radio)).toContain("disabled:cursor-not-allowed");
      expect(list(radio.closest("label"))).toContain("has-disabled:cursor-not-allowed");
    }
  });
});
