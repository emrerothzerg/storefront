import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { Rating } from "./Rating";

describe('Rating variant="compact"', () => {
  test("one filled star + numeric value + count; announced text unchanged", () => {
    const { container } = render(<Rating value={4.63} count={84} variant="compact" />);
    const stars = screen.getByTestId("rating-stars");
    expect(stars.getAttribute("aria-hidden")).toBe("true");
    expect(stars.querySelectorAll("svg").length).toBe(1);
    expect(screen.getByTestId("rating-value").textContent).toBe("4.6");
    expect(screen.getByTestId("rating-value").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("4.6 out of 5 stars").className).toBe("sr-only");
    expect(screen.getByText(", 84 ratings").className).toBe("sr-only");
    expect(container.textContent).toContain("(84)");
  });

  test("value shows one decimal even for whole numbers", () => {
    render(<Rating value={4} variant="compact" />);
    expect(screen.getByTestId("rating-value").textContent).toBe("4.0");
  });
});

describe("Rating full + showValue", () => {
  test("value before five stars; default full markup has no value", () => {
    render(<Rating value={3.5} count={2} showValue />);
    expect(screen.getByTestId("rating-value").textContent).toBe("3.5");
    expect(screen.getByTestId("rating-stars").querySelectorAll("svg").length).toBe(5);
    const plain = renderToStaticMarkup(<Rating value={3.5} />);
    expect(plain).not.toContain("rating-value");
  });

  test("sizes still apply to compact", () => {
    const html = renderToStaticMarkup(<Rating value={5} variant="compact" size="sm" />);
    expect(html).toContain("text-caption");
  });
});
