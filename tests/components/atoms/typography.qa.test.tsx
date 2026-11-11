// QA (T02): Heading / Text adversarial checks.
import { describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Heading, Text, type HeadingLevel, type HeadingSize } from "@/components/atoms/Typography";

const LEVELS: HeadingLevel[] = [1, 2, 3, 4];
const SIZES: HeadingSize[] = ["h1", "h2", "h3", "h4", "h1-lg"];
const SIZE_CLASS: Record<HeadingSize, string> = {
  h1: "text-h1",
  h2: "text-h2",
  h3: "text-h3",
  h4: "text-h4",
  "h1-lg": "text-h1-lg",
};

describe("Heading level x size matrix (T02.1)", () => {
  const combos = LEVELS.flatMap((level) => SIZES.map((size) => [level, size] as const));
  test.each(combos)("level %i + size %s renders <h%i> with only that size class", (level, size) => {
    render(
      <Heading level={level} size={size}>
        X
      </Heading>,
    );
    const el = screen.getByRole("heading", { level, name: "X" });
    expect(el.tagName).toBe(`H${level}`);
    expect(el).toHaveClass(SIZE_CLASS[size]);
    for (const other of SIZES) {
      if (other !== size && !(size === "h1" && other === "h1-lg")) {
        // "h1" legitimately carries md:text-h1-lg, which is a different class token.
        expect(el.classList.contains(SIZE_CLASS[other])).toBe(false);
      }
    }
  });

  test("invalid levels/sizes do not type-check (compile-only)", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error level 0 */}
        <Heading level={0}>x</Heading>
        {/* @ts-expect-error level 7 */}
        <Heading level={7}>x</Heading>
        {/* @ts-expect-error level 5 is not supported either (questionable, see report) */}
        <Heading level={5}>x</Heading>
        {/* @ts-expect-error string level */}
        <Heading level="2">x</Heading>
        {/* @ts-expect-error level is required */}
        <Heading>x</Heading>
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });

  test("runtime bypass of the type (level 7 via cast) renders an <h7>-less element, not a crash", () => {
    // Documents behaviour only: TS prevents this; data from CMS could not reach it.
    const bad = 7 as unknown as HeadingLevel;
    const err = spyOn(console, "error").mockImplementation(mock(() => {}));
    const { container } = render(<Heading level={bad}>Seven</Heading>);
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe("h7");
    err.mockRestore();
  });

  test("className cannot drop the size or colour class", () => {
    render(
      <Heading level={2} className="text-text-secondary">
        Muted
      </Heading>,
    );
    const el = screen.getByRole("heading", { level: 2 });
    expect(el.className).toBe("text-h2 text-text-primary text-text-secondary");
  });
});

describe("Text", () => {
  test("as=span inside a heading keeps phrasing content valid", () => {
    render(
      <Heading level={2}>
        Title <Text as="span" variant="small" tone="secondary">sub</Text>
      </Heading>,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Title sub");
    expect(screen.getByText("sub").tagName).toBe("SPAN");
  });

  test("tone=warning/info are not offered (compile-only)", () => {
    const compileOnly = () => (
      // @ts-expect-error not a TextTone
      <Text tone="warning">x</Text>
    );
    expect(typeof compileOnly).toBe("function");
  });
});
