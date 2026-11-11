import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { fail, ok } from "@/lib/result";
import type { CartActionFnV2, CartActionStateV2 } from "../_contracts/cart-actions";
import { COUPON_INVALID_TEXT, CouponForm, couponErrorMessage, normalizeCouponInput } from ".";

function recording(result: CartActionStateV2): { action: CartActionFnV2; posted: Array<string | null> } {
  const posted: Array<string | null> = [];
  const action: CartActionFnV2 = async (_prev, formData) => {
    const v = formData.get("couponCode");
    posted.push(typeof v === "string" ? v : null);
    return result;
  };
  return { action, posted };
}

const noop: CartActionFnV2 = async () => null;
const applied = ok({ itemCount: 1, subtotalCents: 1000, message: "Promo code applied", kind: "coupon_applied" as const });

function submitApply(value: string): void {
  const input = screen.getByRole("textbox", { name: "Promo code" });
  fireEvent.change(input, { target: { value } });
  const form = input.closest("form");
  if (!form) throw new Error("no form");
  fireEvent.submit(form);
}

describe("CouponForm (not applied)", () => {
  test("static markup is a plain form with the couponCode input and a visible Apply button", () => {
    const html = renderToStaticMarkup(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={null} />);
    expect(html).toContain("<form");
    expect(html).toContain('name="couponCode"');
    expect(html).toContain('maxLength="32"');
    expect(html).toContain('autoCapitalize="characters"');
    expect(html).toMatch(/type="submit"[^>]*>[^<]*Apply/);
    expect(html).not.toContain("sr-only focus:not-sr-only");
  });

  test("labelled input with maxLength 32", () => {
    render(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={null} />);
    const input = screen.getByRole("textbox", { name: "Promo code" });
    expect(input).toHaveAttribute("maxLength", "32");
    expect(input).toHaveAttribute("name", "couponCode");
    expect(screen.getByRole("button", { name: "Apply" })).toHaveAttribute("type", "submit");
  });

  test("upper-cases and trims the code on submit", async () => {
    const { action, posted } = recording(applied);
    render(<CouponForm applyAction={action} removeAction={noop} appliedCoupon={null} />);
    submitApply("  save10 ");
    await waitFor(() => expect(posted).toEqual(["SAVE10"]));
  });

  test("COUPON_INVALID shows the generic message in role=alert linked to the input", async () => {
    const { action } = recording(fail("COUPON_INVALID", "No such code: <b>x</b>", { field: "couponCode" }));
    render(<CouponForm applyAction={action} removeAction={noop} appliedCoupon={null} />);
    submitApply("nope");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(COUPON_INVALID_TEXT);
    const input = screen.getByRole("textbox", { name: "Promo code" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });

  test("specific coupon errors show the server message", async () => {
    const { action } = recording(fail("COUPON_MIN_SUBTOTAL", "Add $5.00 more to use this code.", { shortfallCents: 500 }));
    render(<CouponForm applyAction={action} removeAction={noop} appliedCoupon={null} />);
    submitApply("big");
    expect(await screen.findByRole("alert")).toHaveTextContent("Add $5.00 more to use this code.");
  });

  test("network-style rejection does not crash: action returning INTERNAL_ERROR shows its message", async () => {
    const { action } = recording(fail("INTERNAL_ERROR", "Something went wrong."));
    render(<CouponForm applyAction={action} removeAction={noop} appliedCoupon={null} />);
    submitApply("x");
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
  });

  test("shows Applying… while pending", async () => {
    let resolve: (s: CartActionStateV2) => void = () => {};
    const action: CartActionFnV2 = () => new Promise((r) => { resolve = r; });
    render(<CouponForm applyAction={action} removeAction={noop} appliedCoupon={null} />);
    submitApply("abc");
    expect(await screen.findByRole("button", { name: /Applying/ })).toHaveAttribute("aria-busy", "true");
    resolve(applied);
    await screen.findByRole("button", { name: "Apply" });
  });

  test("hostile couponNotice renders as text in a warning alert", () => {
    const html = renderToStaticMarkup(
      <CouponForm applyAction={noop} removeAction={noop} appliedCoupon={null} couponNotice={'<img src=x onerror="alert(1)">'} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('role="alert"');
  });
});

describe("couponErrorMessage", () => {
  test("RATE_LIMITED reports whole minutes", () => {
    expect(couponErrorMessage({ code: "RATE_LIMITED", message: "x", details: { retryAfterSeconds: 61 } })).toBe(
      "Too many promo code attempts. Try again in 2 minutes.",
    );
    expect(couponErrorMessage({ code: "RATE_LIMITED", message: "x", details: { retryAfterSeconds: Number.NaN } })).toBe(
      "Too many promo code attempts. Try again in 1 minute.",
    );
  });
  test("empty message falls back to a generic one", () => {
    expect(couponErrorMessage({ code: "COUPON_EXPIRED", message: "  " })).toBe("Something went wrong. Please try again.");
    expect(couponErrorMessage({ code: "COUPON_EXPIRED", message: "That promo code has expired." })).toBe(
      "That promo code has expired.",
    );
  });
  test("normalizeCouponInput caps at 32", () => {
    expect(normalizeCouponInput("a".repeat(40))).toBe("A".repeat(32));
  });
});

describe("CouponForm (applied)", () => {
  const coupon = { code: "SAVE10", description: "10% off" };

  test("static markup shows the chip text and a plain remove form", () => {
    const html = renderToStaticMarkup(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={coupon} />);
    expect(html).toContain("SAVE10");
    expect(html).toContain("10% off");
    expect(html).toContain("<form");
    expect(html).not.toContain('name="couponCode"');
    expect(html).toMatch(/type="submit"/);
  });

  test("Remove button name includes the code and posts to removeAction", async () => {
    let calls = 0;
    const remove: CartActionFnV2 = async () => {
      calls += 1;
      return ok({ itemCount: 1, subtotalCents: 1000, message: "Promo code removed", kind: "coupon_removed" as const });
    };
    render(<CouponForm applyAction={noop} removeAction={remove} appliedCoupon={coupon} />);
    const button = screen.getByRole("button", { name: "Remove promo code SAVE10" });
    expect(button).toHaveAttribute("type", "submit");
    const form = button.closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toBe(1));
  });

  test("D-T161-1: Remove uses the danger role with its visible text label", () => {
    render(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={coupon} />);
    const button = screen.getByRole("button", { name: "Remove promo code SAVE10" });
    expect(button).toHaveTextContent(/^Remove/);
    expect(button).toHaveClass("bg-danger");
    expect(button).not.toHaveClass("bg-transparent");
  });

  test("remove failure shows role=alert", async () => {
    const remove: CartActionFnV2 = async () => fail("INTERNAL_ERROR", "Could not remove the code.");
    render(<CouponForm applyAction={noop} removeAction={remove} appliedCoupon={coupon} />);
    const form = screen.getByRole("button", { name: /Remove/ }).closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove the code.");
  });

  test("hostile description and code render as text", () => {
    // React appends its own form-replay <script>addEventListener(...)</script>; drop it first.
    const html = renderToStaticMarkup(
      <CouponForm applyAction={noop} removeAction={noop} appliedCoupon={{ code: "<script>", description: "<b>free</b>" }} />,
    ).replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/g, "");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;free&lt;/b&gt;");
  });

  test("blank applied code falls back to the entry form", () => {
    render(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={{ code: "  ", description: "" }} />);
    expect(screen.getByRole("textbox", { name: "Promo code" })).toBeInTheDocument();
  });

  test("couponNotice shows above the entry form", () => {
    render(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={null} couponNotice="Your code SAVE10 expired." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your code SAVE10 expired.");
  });
});
