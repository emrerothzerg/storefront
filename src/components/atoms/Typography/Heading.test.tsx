import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Heading } from "./Heading";

describe("Heading", () => {
  test.each([1, 2, 3, 4] as const)("level %i renders <h%i> with matching default size", (level) => {
    render(<Heading level={level}>Title</Heading>);
    const el = screen.getByRole("heading", { level, name: "Title" });
    expect(el.tagName).toBe(`H${level}`);
    expect(el).toHaveClass(`text-h${level}`, "text-text-primary");
  });

  test("tag comes from level, independent of size", () => {
    render(
      <Heading level={2} size="h1-lg">
        Big h2
      </Heading>,
    );
    const el = screen.getByRole("heading", { level: 2, name: "Big h2" });
    expect(el.tagName).toBe("H2");
    expect(el).toHaveClass("text-h1-lg");
    expect(el).not.toHaveClass("text-h2");
  });

  test("small visual size on a level 1 heading", () => {
    render(
      <Heading level={1} size="h4">
        Quiet h1
      </Heading>,
    );
    const el = screen.getByRole("heading", { level: 1 });
    expect(el).toHaveClass("text-h4");
    expect(el).not.toHaveClass("text-h1");
  });

  test("h1 size steps up to h1-lg from md", () => {
    render(<Heading level={1}>Page</Heading>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("text-h1", "md:text-h1-lg");
  });

  test("merges className last and forwards rest props", () => {
    render(
      <Heading level={3} className="mb-4" id="section" data-testid="h">
        Section
      </Heading>,
    );
    const el = screen.getByTestId("h");
    expect(el).toHaveAttribute("id", "section");
    expect(el.className.endsWith("mb-4")).toBe(true);
  });

  test("tone defaults to text-primary; inverse and secondary map to their roles", () => {
    render(
      <>
        <Heading level={2}>Default</Heading>
        <Heading level={2} tone="default">
          Explicit
        </Heading>
        <Heading level={1} tone="inverse">
          Inverse
        </Heading>
        <Heading level={3} tone="secondary">
          Secondary
        </Heading>
      </>,
    );
    for (const name of ["Default", "Explicit"]) {
      const h = screen.getByRole("heading", { name });
      expect(h).toHaveClass("text-text-primary");
      expect(h).not.toHaveClass("text-text-inverse");
    }
    const inverse = screen.getByRole("heading", { level: 1, name: "Inverse" });
    expect(inverse).toHaveClass("text-text-inverse");
    expect(inverse).not.toHaveClass("text-text-primary");
    expect(inverse).toHaveClass("text-h1");
    const secondary = screen.getByRole("heading", { level: 3, name: "Secondary" });
    expect(secondary).toHaveClass("text-text-secondary");
    expect(secondary).not.toHaveClass("text-text-primary");
  });

  test("invalid levels are compile-time errors", () => {
    // Never invoked: these exist only for `tsc` to check.
    const compileOnly = () => (
      <>
        <Heading
          // @ts-expect-error level 0 is not a valid heading level
          level={0}
        >
          x
        </Heading>
        <Heading
          // @ts-expect-error level 7 is not a valid heading level
          level={7}
        >
          x
        </Heading>
        {/* @ts-expect-error "danger" is not a valid heading tone */}
        <Heading level={2} tone="danger">
          x
        </Heading>
        <Heading
          level={2}
          // @ts-expect-error "h5" is not a valid size
          size="h5"
        >
          x
        </Heading>
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});
