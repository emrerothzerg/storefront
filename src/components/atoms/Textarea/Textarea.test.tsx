import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormField } from "../FormField";
import { Textarea, thresholdLevel } from "./Textarea";

describe("Textarea", () => {
  test("labelled textarea with Input's token classes; rows default 4", () => {
    render(
      <>
        <label htmlFor="review">Review</label>
        <Textarea id="review" />
      </>,
    );
    const ta = screen.getByLabelText("Review");
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta).toHaveAttribute("rows", "4");
    for (const cls of ["min-h-touch", "bg-surface-raised", "border-border-strong", "rounded-md", "text-body", "placeholder:text-text-secondary", "resize-y"]) {
      expect(ta).toHaveClass(cls);
    }
    expect(ta).not.toHaveAttribute("aria-invalid");
  });

  test("invalid / aria-invalid -> danger border", () => {
    const { rerender } = render(<Textarea id="t" aria-label="T" invalid />);
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox")).toHaveClass("border-danger");
    rerender(<Textarea id="t" aria-label="T" aria-invalid="true" />);
    expect(screen.getByRole("textbox")).toHaveClass("border-danger");
  });

  test("works with FormField (label, hint, error, required)", () => {
    render(
      <FormField id="body" label="Your review" hint="At least 20 characters" error="Too short" required>
        {(p) => <Textarea {...p} name="body" />}
      </FormField>,
    );
    const ta = screen.getByRole("textbox", { name: /your review/i });
    expect(ta).toBeRequired();
    expect(ta).toHaveAttribute("aria-invalid", "true");
    expect(ta).toHaveClass("border-danger");
    expect(ta).toHaveAccessibleDescription("At least 20 characters Too short");
  });

  test("posts as a normal form field", () => {
    render(
      <form data-testid="f">
        <Textarea id="t" name="question" defaultValue="Is it waterproof?" aria-label="Q" />
      </form>,
    );
    expect(new FormData(screen.getByTestId("f") as HTMLFormElement).get("question")).toBe("Is it waterproof?");
  });

  test("showCount: visible count linked by aria-describedby, updates on input", () => {
    render(<Textarea id="t" aria-label="T" maxLength={10} showCount defaultValue="abc" />);
    const ta = screen.getByRole("textbox");
    expect(ta).toHaveAttribute("maxlength", "10");
    expect(ta).toHaveAccessibleDescription("3 / 10 characters");
    fireEvent.change(ta, { target: { value: "abcdef" } });
    expect(ta).toHaveAccessibleDescription("6 / 10 characters");
  });

  test("live region announces only when crossing 80% / 90% / 100% upward", () => {
    render(<Textarea id="t" aria-label="T" maxLength={10} showCount />);
    const ta = screen.getByRole("textbox");
    const live = screen.getByTestId("textarea-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    fireEvent.change(ta, { target: { value: "1234567" } });
    expect(live).toHaveTextContent("");
    fireEvent.change(ta, { target: { value: "12345678" } });
    expect(live).toHaveTextContent("8 / 10 characters");
    fireEvent.change(ta, { target: { value: "123456789" } });
    expect(live).toHaveTextContent("9 / 10 characters");
    fireEvent.change(ta, { target: { value: "12345678" } }); // falling: silent
    expect(live).toHaveTextContent("9 / 10 characters");
    fireEvent.change(ta, { target: { value: "1234567890" } });
    expect(live).toHaveTextContent("10 / 10 characters");
    expect(document.getElementById("t-count")).toHaveClass("text-danger");
  });

  test("thresholdLevel", () => {
    expect(thresholdLevel(0, 500)).toBe(-1);
    expect(thresholdLevel(400, 500)).toBe(0);
    expect(thresholdLevel(450, 500)).toBe(1);
    expect(thresholdLevel(500, 500)).toBe(2);
  });

  test("controlled value counts from value; onChange still called", () => {
    const onChange = mock();
    render(<Textarea id="t" aria-label="T" maxLength={5} showCount value="hey" onChange={onChange} />);
    expect(screen.getByText(/3 \/ 5/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hey!" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("showCount without maxLength renders no counter", () => {
    render(<Textarea id="t" aria-label="T" showCount />);
    expect(screen.queryByTestId("textarea-live")).toBeNull();
  });

  test("autoResize uses CSS field-sizing with a height cap", () => {
    render(<Textarea id="t" aria-label="T" autoResize />);
    expect(screen.getByRole("textbox")).toHaveClass("field-sizing-content", "max-h-64", "resize-none");
  });

  test("className last, ref forwarded", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea id="t" aria-label="T" className="mt-2" ref={ref} />);
    const ta = screen.getByRole("textbox");
    expect(ta.className.split(" ").at(-1)).toBe("mt-2");
    expect(ref.current).toBe(ta as HTMLTextAreaElement);
  });
});
