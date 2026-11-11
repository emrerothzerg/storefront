import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { ProgressBar, clampProgress } from "./ProgressBar";

describe("ProgressBar", () => {
  test("renders role=progressbar named by the visible label", () => {
    render(<ProgressBar label="Free shipping progress" value={40} />);
    const bar = screen.getByRole("progressbar", { name: "Free shipping progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "40%");
    expect(screen.getByText("Free shipping progress")).toBeVisible();
  });

  test("hideLabel uses aria-label instead of visible text", () => {
    render(<ProgressBar label="Upload" value={10} hideLabel />);
    const bar = screen.getByRole("progressbar", { name: "Upload" });
    expect(bar).toHaveAttribute("aria-label", "Upload");
    expect(bar).not.toHaveAttribute("aria-labelledby");
    expect(screen.queryByText("Upload")).toBeNull();
  });

  test("clamps value into [0, max]", () => {
    const { rerender } = render(<ProgressBar label="P" value={150} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByTestId("progress-fill").style.width).toBe("100%");
    rerender(<ProgressBar label="P" value={-5} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByTestId("progress-fill").style.width).toBe("0%");
    expect(clampProgress(Number.NaN, 100)).toBe(0);
  });

  test("custom max scales the fill and aria-valuemax", () => {
    render(<ProgressBar label="Spend" value={25} max={50} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemax", "50");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(bar).toHaveAttribute("aria-valuetext", "50%");
    expect(screen.getByTestId("progress-fill").style.width).toBe("50%");
  });

  test("invalid max falls back to 100", () => {
    render(<ProgressBar label="P" value={30} max={0} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "100");
  });

  test("valueText is shown and used as aria-valuetext", () => {
    render(
      <ProgressBar label="Free shipping" value={75} valueText="$12.50 away from free shipping" />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "$12.50 away from free shipping",
    );
    expect(screen.getByText("$12.50 away from free shipping")).toBeInTheDocument();
  });

  test("hideValueText drops the visible valueText line but keeps aria-valuetext", () => {
    const text = "$12.50 away from free shipping";
    const { container, rerender } = render(
      <ProgressBar label="Free shipping" value={30} valueText={text} hideValueText />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuetext", text);
    expect(bar).toHaveAttribute("aria-valuenow", "30");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(screen.queryByText(text)).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    rerender(<ProgressBar label="Free shipping" value={30} valueText={text} hideValueText={false} />);
    expect(screen.getByText(text)).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", text);
  });

  test("hideValueText omitted or false: markup identical to the default", () => {
    const props = { label: "Free shipping", value: 30, valueText: "$12.50 away", id: "fs" };
    const base = renderToStaticMarkup(<ProgressBar {...props} />);
    expect(renderToStaticMarkup(<ProgressBar {...props} hideValueText={false} />)).toBe(base);
    expect(base).toContain("$12.50 away</p>");
  });

  test("showValue displays the rounded percentage", () => {
    render(<ProgressBar label="P" value={33.4} showValue />);
    expect(screen.getByText("33%")).toBeInTheDocument();
  });

  test.each([
    ["accent", "bg-accent"],
    ["success", "bg-success"],
    ["warning", "bg-warning"],
  ] as const)("tone %s uses %s", (tone, cls) => {
    render(<ProgressBar label="P" value={50} tone={tone} />);
    expect(screen.getByTestId("progress-fill")).toHaveClass(cls);
  });

  test("size maps to track height", () => {
    render(<ProgressBar label="P" value={50} size="sm" />);
    expect(screen.getByRole("progressbar")).toHaveClass("h-2", "border-border-strong");
  });

  test("indeterminate omits aria-valuenow and pulses only with motion", () => {
    render(<ProgressBar label="Loading" indeterminate />);
    const bar = screen.getByRole("progressbar", { name: "Loading" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).not.toHaveAttribute("aria-valuetext");
    expect(bar).toHaveAttribute("aria-busy", "true");
    const fill = screen.getByTestId("progress-fill");
    expect(fill).toHaveClass("motion-safe:animate-pulse", "w-full");
    expect(fill.style.width).toBe("");
  });

  test("forwards ref to the progressbar and merges className on the wrapper", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<ProgressBar ref={ref} label="P" value={1} className="mt-4" />);
    expect(ref.current).toBe(screen.getByRole("progressbar") as HTMLDivElement);
    expect((container.firstElementChild as HTMLElement).className.endsWith("mt-4")).toBe(true);
  });

  test("empty label warns and falls back to aria-label=Progress", () => {
    const original = console.warn;
    const warn = mock(() => {});
    console.warn = warn;
    try {
      const { rerender } = render(<ProgressBar label="" value={10} />);
      let bar = screen.getByRole("progressbar", { name: "Progress" });
      expect(bar).not.toHaveAttribute("aria-labelledby");
      rerender(<ProgressBar label="  " value={10} hideLabel />);
      bar = screen.getByRole("progressbar", { name: "Progress" });
      expect(bar).toHaveAttribute("aria-label", "Progress");
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = original;
    }
  });
});
