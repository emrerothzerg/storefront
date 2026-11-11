import { describe, expect, mock, test } from "bun:test";
import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Rating, clampRating, starIcons } from "./Rating";

function icons(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll('[data-testid="rating-stars"] svg')).map((s) =>
    s.getAttribute("data-icon"),
  );
}

describe("Rating (display)", () => {
  test("accessible text, stars hidden, rating colour token", () => {
    const { container } = render(<Rating value={4.3} />);
    expect(screen.getByText("4.3 out of 5 stars")).toHaveClass("sr-only");
    const stars = screen.getByTestId("rating-stars");
    expect(stars).toHaveAttribute("aria-hidden", "true");
    expect(stars).toHaveClass("text-rating");
    expect(icons(container)).toEqual(["star-filled", "star-filled", "star-filled", "star-filled", "star-half"]);
  });

  test("half-star rounding", () => {
    expect(starIcons(4.24)).toEqual(["star-filled", "star-filled", "star-filled", "star-filled", "star"]);
    expect(starIcons(4.25)).toEqual(["star-filled", "star-filled", "star-filled", "star-filled", "star-half"]);
    expect(starIcons(4.75)).toEqual(Array(5).fill("star-filled"));
    expect(starIcons(0)).toEqual(Array(5).fill("star"));
    expect(starIcons(0.5)[0]).toBe("star-half");
  });

  test("clamps out-of-range and non-finite values", () => {
    expect(clampRating(7)).toBe(5);
    expect(clampRating(-1)).toBe(0);
    expect(clampRating(Number.NaN)).toBe(0);
    render(<Rating value={9} />);
    expect(screen.getByText("5 out of 5 stars")).toBeInTheDocument();
  });

  test("count renders (1,234) visibly and '1,234 ratings' for assistive tech", () => {
    render(<Rating value={4} count={1234} />);
    expect(screen.getByText("(1,234)")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(", 1,234 ratings")).toHaveClass("sr-only");
  });

  test("singular rating, no count when omitted", () => {
    const { rerender } = render(<Rating value={5} count={1} />);
    expect(screen.getByText(", 1 rating")).toBeInTheDocument();
    rerender(<Rating value={5} />);
    expect(screen.queryByText(/\(/)).toBeNull();
  });

  test("sizes change icon and text size; className last; ref", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(<Rating value={3} size="lg" className="mt-1" ref={ref} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("text-body");
    expect(root.className.split(" ").at(-1)).toBe("mt-1");
    expect(container.querySelector("svg")).toHaveClass("size-6");
    expect(ref.current).toBe(root);
    expect(root).not.toHaveAttribute("mode");
  });
});

describe("Rating (input)", () => {
  test("radiogroup named by legend with 5 labelled native radios in order", () => {
    render(<Rating mode="input" name="rating" label="Your rating" />);
    const group = screen.getByRole("radiogroup", { name: "Your rating" });
    expect(group.tagName).toBe("FIELDSET");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(5);
    expect(radios.map((r) => r.getAttribute("value"))).toEqual(["1", "2", "3", "4", "5"]);
    expect(screen.getByRole("radio", { name: "1 out of 5 stars" })).toHaveAttribute("name", "rating");
    // Visually transparent layer over the 44px label (not sr-only: it draws the focus ring, D-T131-4).
    expect(screen.getByRole("radio", { name: "5 out of 5 stars" })).toHaveClass(
      "absolute",
      "inset-0",
      "appearance-none",
      "bg-transparent",
    );
  });

  test("star labels: 44px target, rating colour, CSS-only fill rules; focus ring drawn by the radio itself", () => {
    render(<Rating mode="input" name="r" label="Rating" />);
    const label = screen.getByRole("radio", { name: "3 out of 5 stars" }).closest("label");
    expect(label).toHaveClass(
      "size-touch",
      "text-rating",
      "peer/star",
      "group-has-checked/rating:fill-current",
      "peer-has-checked/star:fill-none",
      "group-hover/rating:fill-current",
      "peer-hover/star:fill-none",
    );
    expect(label?.querySelector("svg")).toHaveClass("fill-inherit");
    expect(label?.parentElement).toHaveClass("group/rating");
  });

  test("posts as a normal form field without JS (uncontrolled defaultValue)", () => {
    render(
      <form data-testid="f">
        <Rating mode="input" name="stars" label="Rating" defaultValue={4} />
      </form>,
    );
    const form = screen.getByTestId("f") as HTMLFormElement;
    expect(new FormData(form).get("stars")).toBe("4");
    fireEvent.click(screen.getByRole("radio", { name: "2 out of 5 stars" }));
    expect(new FormData(form).get("stars")).toBe("2");
  });

  test("no selection posts nothing; required marks every radio and aria-required", () => {
    render(
      <form data-testid="f">
        <Rating mode="input" name="stars" label="Rating" required />
      </form>,
    );
    const form = screen.getByTestId("f") as HTMLFormElement;
    expect(new FormData(form).get("stars")).toBeNull();
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-required", "true");
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeRequired();
  });

  test("onChange receives the star count (uncontrolled)", () => {
    const onChange = mock();
    render(<Rating mode="input" name="r" label="Rating" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "3 out of 5 stars" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toBe(3);
  });

  test("controlled value", () => {
    function Controlled() {
      const [value, setValue] = useState<number | null>(null);
      return (
        <>
          <Rating mode="input" name="r" label="Rating" value={value} onChange={setValue} />
          <output data-testid="out">{value ?? "none"}</output>
        </>
      );
    }
    render(<Controlled />);
    expect(screen.getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "5 out of 5 stars" }));
    expect(screen.getByTestId("out")).toHaveTextContent("5");
    expect(screen.getByRole("radio", { name: "5 out of 5 stars" })).toBeChecked();
  });

  test("keyboard: radios are native, share one name, focusable", () => {
    render(<Rating mode="input" name="r" label="Rating" defaultValue={2} />);
    const radio = screen.getByRole("radio", { name: "2 out of 5 stars" });
    radio.focus();
    expect(radio).toHaveFocus();
    // Arrow-key movement between same-name radios is native browser behaviour.
    expect(new Set(screen.getAllByRole("radio").map((r) => r.getAttribute("name")))).toEqual(new Set(["r"]));
  });

  test("invalid -> aria-invalid + describedBy; disabled disables the fieldset", () => {
    render(
      <>
        <Rating mode="input" name="r" label="Rating" invalid describedBy="err" disabled />
        <p id="err">Choose a rating</p>
      </>,
    );
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(group).toHaveAccessibleDescription("Choose a rating");
    expect(group).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });

  test("errorText: alert, linked via aria-describedby (merged with describedBy), implies invalid", () => {
    render(
      <>
        <Rating mode="input" name="r" label="Rating" describedBy="hint" errorText="Choose a star rating" />
        <p id="hint">Required</p>
      </>,
    );
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a star rating");
    expect(screen.getByRole("alert")).toHaveClass("text-danger");
    expect(group).toHaveAccessibleDescription("Required Choose a star rating");
  });

  test("no errorText: no alert, not invalid", () => {
    render(<Rating mode="input" name="r" label="Rating" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radiogroup")).not.toHaveAttribute("aria-invalid");
  });

  test("hideLabel keeps the legend for assistive tech; ref goes to the fieldset", () => {
    const ref = createRef<HTMLFieldSetElement>();
    render(<Rating mode="input" name="r" label="Rating" hideLabel ref={ref} />);
    expect(screen.getByText("Rating")).toHaveClass("sr-only");
    expect(ref.current?.tagName).toBe("FIELDSET");
  });

  test("required shows a visible aria-hidden '(required)' marker; name is the plain label", () => {
    render(<Rating mode="input" name="r" label="Overall rating" required />);
    const group = screen.getByRole("radiogroup", { name: "Overall rating" });
    const marker = screen.getByText("(required)");
    expect(marker).toHaveAttribute("aria-hidden", "true");
    expect(marker).toHaveClass("text-text-secondary");
    expect(marker.closest("legend")).not.toBeNull();
    expect(group).toHaveAttribute("aria-required", "true");
  });

  test("no marker when not required, when requiredMarker={false}, or when hideLabel", () => {
    const { unmount } = render(<Rating mode="input" name="r" label="Rating" />);
    expect(screen.queryByText("(required)")).toBeNull();
    unmount();
    const second = render(<Rating mode="input" name="r" label="Rating" required requiredMarker={false} />);
    expect(screen.queryByText("(required)")).toBeNull();
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-required", "true");
    second.unmount();
    render(<Rating mode="input" name="r" label="Rating" required hideLabel />);
    expect(screen.queryByText("(required)")).toBeNull();
  });

  test("requiredMarker can be forced on without required (visual only)", () => {
    render(<Rating mode="input" name="r" label="Rating" requiredMarker />);
    expect(screen.getByText("(required)")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("radiogroup")).not.toHaveAttribute("aria-required");
  });
});
