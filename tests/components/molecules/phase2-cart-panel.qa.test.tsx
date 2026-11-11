// QA (QA-W3-molecules-C): T73 CouponForm, ShippingMethodPicker, FreeShippingProgress.
// Criteria: BACKLOG-phase2.md "### T73", SR2/SR3/SR6, contract _contracts/cart-actions.ts (v2).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appError, err, ok } from "@/lib/result";
import type { ErrorCode, ShippingMethod } from "@/lib/types";
import type { ShippingQuote } from "@/server/pricing/shipping-service";
import {
  CART_FIELD_V2,
  COUPON_CODE_MAX_LENGTH,
  type CartActionFnV2,
  type CartActionStateV2,
} from "@/components/molecules/_contracts/cart-actions";
import { CouponForm, couponErrorMessage, normalizeCouponInput, COUPON_INVALID_TEXT } from "@/components/molecules/CouponForm";
import { ShippingMethodPicker } from "@/components/molecules/ShippingMethodPicker";
import { FreeShippingProgress, freeShippingModel } from "@/components/molecules/FreeShippingProgress";

// ---------------------------------------------------------------- helpers

type Fields = Record<string, string>;
function snapshot(fd: FormData): Fields {
  const out: Fields = {};
  fd.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}
function userKeys(f: Fields): string[] {
  return Object.keys(f)
    .filter((k) => !k.startsWith("$ACTION"))
    .sort();
}
function scripted(steps: readonly CartActionStateV2[], fallback: CartActionStateV2 = null) {
  const calls: Fields[] = [];
  const action: CartActionFnV2 = async (_prev, fd) => {
    calls.push(snapshot(fd));
    return steps[calls.length - 1] ?? fallback;
  };
  return { action, calls };
}
function gated() {
  const calls: Fields[] = [];
  const resolvers: Array<(s: CartActionStateV2) => void> = [];
  const action: CartActionFnV2 = (_prev, fd) => {
    calls.push(snapshot(fd));
    return new Promise<CartActionStateV2>((res) => resolvers.push(res));
  };
  const release = async (s: CartActionStateV2) => {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        resolvers.splice(0).forEach((r) => r(s));
        await new Promise((r) => setTimeout(r, 5));
      });
      if (resolvers.length === 0 && i > 2) break;
    }
  };
  return { action, calls, release };
}
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
function failure(code: ErrorCode, message: string, details?: Record<string, unknown>): CartActionStateV2 {
  return err(appError(code, message, details));
}
function success(message: string, kind: "coupon_applied" | "coupon_removed" | "shipping_selected"): CartActionStateV2 {
  return ok({ itemCount: 1, subtotalCents: 4000, message, kind });
}
function stripReplay(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (s) => (s.includes("requestFormReset") || s.includes("$$reactFormReplay") || s.includes('addEventListener("submit"') ? "" : s));
}
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
const RTL = "\u202Eمرحبا שלום";
const LONG_WORD = "W".repeat(10_000);
const noop: CartActionFnV2 = async () => null;

const ROOT = join(import.meta.dir, "../../../src/components/molecules");
const FILES = ["CouponForm/CouponForm.tsx", "ShippingMethodPicker/ShippingMethodPicker.tsx", "FreeShippingProgress/FreeShippingProgress.tsx"];

describe("T73 source gates", () => {
  for (const file of FILES) {
    test(`${file}: no any / ts-ignore / eslint-disable / dangerouslySetInnerHTML / style= / runtime server import`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/:\s*any\b|<any>|as any\b|any\[\]/);
      expect(src).not.toMatch(/@ts-(ignore|expect-error|nocheck)/);
      expect(src).not.toContain("eslint-disable");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/\bstyle=/);
      for (const line of src.split("\n").filter((l) => /from ["']@\/server\//.test(l))) expect(line).toMatch(/^import type /);
    });
  }
  test("FreeShippingProgress is server-safe (no 'use client')", () => {
    expect(readFileSync(join(ROOT, FILES[2]!), "utf8").startsWith('"use client"')).toBe(false);
  });
});

// ---------------------------------------------------------------- CouponForm

const codeInput = () => screen.getByLabelText("Promo code") as HTMLInputElement;
const applyBtn = () => screen.getByRole("button", { name: /Apply/ });

describe("T73 AC1 CouponForm (no JS, maxLength 32, upper-case, alerts, applied + Remove)", () => {
  test("static entry markup: one form, input name=couponCode maxlength=32 with label, submit, no script / nested form", () => {
    const html = stripReplay(renderToStaticMarkup(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={null} />));
    expect(html).not.toContain("<script");
    const doc = parse(html);
    expect(doc.querySelectorAll("form")).toHaveLength(1);
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
    const input = doc.querySelector(`input[name="${CART_FIELD_V2.couponCode}"]`)!;
    expect(input.getAttribute("maxlength")).toBe(String(COUPON_CODE_MAX_LENGTH));
    expect(doc.querySelector(`label[for="${input.id}"]`)!.textContent).toContain("Promo code");
    expect(doc.querySelector('button[type="submit"]')!.textContent).toContain("Apply");
    expect(html).not.toMatch(/name="(sessionId|discount|total|shipping|priceCents)"/);
  });

  test("static applied markup: code chip + description text + Remove form named 'Remove promo code <CODE>', no entry input", () => {
    const html = stripReplay(
      renderToStaticMarkup(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={{ code: "SAVE10", description: "10% off" }} />),
    );
    const doc = parse(html);
    expect(doc.querySelector('input[name="couponCode"]')).toBeNull();
    expect(doc.querySelectorAll("form")).toHaveLength(1);
    const btn = doc.querySelector("form button")!;
    expect(btn.textContent!.replace(/\s+/g, " ").trim()).toBe("Remove promo code SAVE10");
    expect(doc.body.textContent).toContain("SAVE10");
    expect(doc.body.textContent).toContain("10% off");
  });

  test("hydrated applied: Remove button accessible name and posts no user fields", async () => {
    const rm = scripted([success("Promo code removed.", "coupon_removed")]);
    render(<CouponForm applyAction={noop} removeAction={rm.action} appliedCoupon={{ code: "SAVE10", description: "10% off" }} />);
    const btn = screen.getByRole("button", { name: "Remove promo code SAVE10" });
    fireEvent.click(btn);
    await flush();
    expect(rm.calls).toHaveLength(1);
    expect(userKeys(rm.calls[0]!)).toEqual([]);
  });

  for (const [typed, posted] of [
    ["  save10  ", "SAVE10"],
    ["Free_Ship-2", "FREE_SHIP-2"],
  ] as const) {
    test(`trim + upper-case on submit: ${JSON.stringify(typed.slice(0, 12))} -> ${posted.slice(0, 12)}; only couponCode posted`, async () => {
      const ap = scripted([success("Applied.", "coupon_applied")]);
      render(<CouponForm applyAction={ap.action} removeAction={noop} appliedCoupon={null} />);
      fireEvent.change(codeInput(), { target: { value: typed } });
      fireEvent.click(applyBtn());
      await flush();
      expect(ap.calls).toHaveLength(1);
      expect(userKeys(ap.calls[0]!)).toEqual(["couponCode"]);
      expect(ap.calls[0]!.couponCode).toBe(posted);
    });
  }

  test("normalizeCouponInput: trim, upper-case, cap 32; hostile chars are passed to the server unchanged (server validates)", () => {
    expect(normalizeCouponInput(" ab ")).toBe("AB");
    expect(normalizeCouponInput("x".repeat(33))).toHaveLength(32);
    expect(normalizeCouponInput("<script>")).toBe("<SCRIPT>");
  });

  const errorCases: Array<[string, CartActionStateV2, string]> = [
    ["COUPON_INVALID with a server message", failure("COUPON_INVALID", "Code ABC does not exist"), COUPON_INVALID_TEXT],
    ["COUPON_INVALID hostile", failure("COUPON_INVALID", HOSTILE), COUPON_INVALID_TEXT],
    ["RATE_LIMITED 61s", failure("RATE_LIMITED", "x", { retryAfterSeconds: 61 }), "Too many promo code attempts. Try again in 2 minutes."],
    ["RATE_LIMITED 60s", failure("RATE_LIMITED", "x", { retryAfterSeconds: 60 }), "Too many promo code attempts. Try again in 1 minute."],
    ["RATE_LIMITED missing", failure("RATE_LIMITED", "x"), "Too many promo code attempts. Try again in 1 minute."],
    ["RATE_LIMITED NaN", failure("RATE_LIMITED", "x", { retryAfterSeconds: Number.NaN }), "Too many promo code attempts. Try again in 1 minute."],
    ["COUPON_EXPIRED", failure("COUPON_EXPIRED", "That promo code has expired."), "That promo code has expired."],
    ["COUPON_EXHAUSTED", failure("COUPON_EXHAUSTED", "That promo code is no longer available."), "That promo code is no longer available."],
    ["COUPON_USED", failure("COUPON_USED", "You have already used that promo code."), "You have already used that promo code."],
    ["COUPON_MIN_SUBTOTAL", failure("COUPON_MIN_SUBTOTAL", "Add $5.00 more to use this code.", { shortfallCents: 500 }), "Add $5.00 more to use this code."],
    ["INTERNAL_ERROR", failure("INTERNAL_ERROR", "Something went wrong."), "Something went wrong."],
    ["blank message", failure("COUPON_EXPIRED", "   "), "Something went wrong. Please try again."],
    ["hostile message (non-invalid code)", failure("COUPON_EXPIRED", HOSTILE), HOSTILE],
  ];
  for (const [label, state, text] of errorCases) {
    test(`apply error ${label}: role=alert text, linked by aria-describedby, aria-invalid`, async () => {
      const ap = scripted([state]);
      const { container } = render(<CouponForm applyAction={ap.action} removeAction={noop} appliedCoupon={null} />);
      fireEvent.change(codeInput(), { target: { value: "abc" } });
      fireEvent.click(applyBtn());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(text);
      expect(codeInput().getAttribute("aria-describedby") ?? "").toContain(alert.id);
      expect(codeInput()).toHaveAttribute("aria-invalid", "true");
      expect(container.querySelector("img[src=x], script")).toBeNull();
    });
  }

  test("couponErrorMessage maps every coupon code (pure)", () => {
    expect(couponErrorMessage(appError("COUPON_INVALID", "leak"))).toBe(COUPON_INVALID_TEXT);
    expect(couponErrorMessage(appError("RATE_LIMITED", "x", { retryAfterSeconds: 601 }))).toBe("Too many promo code attempts. Try again in 11 minutes.");
  });

  test("remove error -> role=alert; success messages -> polite live region", async () => {
    const rm = scripted([failure("INTERNAL_ERROR", "Could not remove the code.")]);
    render(<CouponForm applyAction={noop} removeAction={rm.action} appliedCoupon={{ code: "SAVE10", description: "" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove promo code/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not remove the code.");
    const ap = scripted([success("Promo code SAVE10 applied.", "coupon_applied")]);
    const { container } = render(<CouponForm applyAction={ap.action} removeAction={noop} appliedCoupon={null} />);
    fireEvent.change(screen.getAllByLabelText("Promo code").at(-1)!, { target: { value: "save10" } });
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Apply"))!);
    await flush();
    // Success of apply is announced from the applied view (after revalidation); the entry view must not show an alert.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("pending: Apply aria-busy; 5 rapid clicks -> 1 call", async () => {
    const g = gated();
    try {
      render(<CouponForm applyAction={g.action} removeAction={noop} appliedCoupon={null} />);
      fireEvent.change(codeInput(), { target: { value: "save10" } });
      fireEvent.click(applyBtn());
      await waitFor(() => expect(applyBtn()).toHaveAttribute("aria-busy", "true"));
      for (let i = 0; i < 4; i++) fireEvent.click(applyBtn());
      await flush();
      expect(g.calls).toHaveLength(1);
    } finally {
      await g.release(failure("COUPON_EXPIRED", "Expired."));
    }
  });

  test("pending: Remove aria-busy; 5 rapid clicks -> 1 call", async () => {
    const g = gated();
    try {
      render(<CouponForm applyAction={noop} removeAction={g.action} appliedCoupon={{ code: "SAVE10", description: "" }} />);
      const btn = () => screen.getByRole("button", { name: /Remov/ });
      fireEvent.click(btn());
      await waitFor(() => expect(btn()).toHaveAttribute("aria-busy", "true"));
      for (let i = 0; i < 4; i++) fireEvent.click(btn());
      await flush();
      expect(g.calls).toHaveLength(1);
    } finally {
      await g.release(failure("INTERNAL_ERROR", "x"));
    }
  });

  test("hostile / RTL / 10k applied code + description, and hostile couponNotice: text only, wrap-safe", () => {
    for (const s of [HOSTILE, RTL, LONG_WORD]) {
      const { container, unmount } = render(
        <CouponForm applyAction={noop} removeAction={noop} appliedCoupon={{ code: s, description: s }} couponNotice={s} />,
      );
      expect(container.querySelector("img[src=x], script")).toBeNull();
      expect(container.textContent).toContain(s);
      expect(container.innerHTML).toMatch(/break-all|break-words/);
      expect((container.firstElementChild as HTMLElement).className).toMatch(/min-w-0/);
      unmount();
    }
  });

  test("blank applied code falls back to the entry form", () => {
    render(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={{ code: "  ", description: "x" }} />);
    expect(codeInput()).toBeInTheDocument();
  });

  test("SR6 + keyboard: input and buttons are native, focusable, >= 44px", () => {
    const { container, unmount } = render(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={null} compact />);
    expect(codeInput().className).toMatch(/min-h-touch/);
    expect(applyBtn().className).toMatch(/min-h-touch/);
    for (const el of Array.from(container.querySelectorAll("button, input"))) expect(el.getAttribute("tabindex")).not.toBe("-1");
    unmount();
    render(<CouponForm applyAction={noop} removeAction={noop} appliedCoupon={{ code: "X", description: "" }} compact />);
    expect(screen.getByRole("button", { name: /Remove promo code X/ }).className).toMatch(/min-h-touch/);
  });

  test("observation: typed code after a failed apply (React 19 resets uncontrolled form fields after an action)", async () => {
    const ap = scripted([failure("COUPON_EXPIRED", "Expired.")]);
    render(<CouponForm applyAction={ap.action} removeAction={noop} appliedCoupon={null} />);
    fireEvent.change(codeInput(), { target: { value: "save10" } });
    fireEvent.click(applyBtn());
    await screen.findByRole("alert");
    // Pinned as-is (documented in the report): the field is cleared after the failure.
    expect(codeInput().value).toBe("");
  });
});

// ---------------------------------------------------------------- ShippingMethodPicker

function method(id: string, name: string, priceCents: number, freeOverCents: number | null = null): ShippingMethod {
  return { id, name, description: "", priceCents, freeOverCents, minDays: 3, maxDays: 5, sortOrder: 0, isActive: true };
}
function quote(m: ShippingMethod, opts: Partial<ShippingQuote> = {}): ShippingQuote {
  return { method: m, priceCents: m.priceCents, isFree: false, amountToFreeCents: null, ...opts };
}
const STANDARD = quote(method("standard", "Standard", 599, 5000), { amountToFreeCents: 1250 });
const EXPRESS = quote(method("express", "Express", 1499));
const FREE = quote(method("pickup", "Pickup", 0), { isFree: true, priceCents: 0 });
const OPTIONS = [STANDARD, EXPRESS, FREE];
const ARRIVALS = {
  standard: { start: "2026-11-12T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" },
  express: { start: "2026-11-10T00:00:00.000Z", end: "2026-11-10T00:00:00.000Z" },
};
const NOW = Date.parse("2026-11-07T12:00:00.000Z");

/** happy-dom's requestSubmit passes the form as submitter (FormData throws); spy + replay as a plain submit. */
function spyRequestSubmit(): { count: () => number } {
  const form = screen.getAllByRole("radio")[0]!.closest("form")!;
  let n = 0;
  form.requestSubmit = () => {
    n += 1;
    fireEvent.submit(form);
  };
  return { count: () => n };
}
const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("T73 AC2 ShippingMethodPicker", () => {
  test("static markup: one form, labelled radiogroup (legend), radios name=shippingMethodId, selected checked, visible Update, Price atom", () => {
    const html = stripReplay(
      renderToStaticMarkup(<ShippingMethodPicker action={noop} options={OPTIONS} selectedId="express" arrivals={ARRIVALS} now={NOW} />),
    );
    expect(html).not.toContain("<script");
    const doc = parse(html);
    expect(doc.querySelectorAll("form")).toHaveLength(1);
    const group = doc.querySelector('[role="radiogroup"]')!;
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelector("legend")!.textContent).toContain("Shipping method");
    const radios = Array.from(doc.querySelectorAll('input[type="radio"]'));
    expect(radios.map((r) => r.getAttribute("name"))).toEqual(["shippingMethodId", "shippingMethodId", "shippingMethodId"]);
    expect(radios.map((r) => r.getAttribute("value"))).toEqual(["standard", "express", "pickup"]);
    expect(radios.filter((r) => r.hasAttribute("checked")).map((r) => r.getAttribute("value"))).toEqual(["express"]);
    const update = doc.querySelector('button[type="submit"]')!;
    expect(update.className).not.toMatch(/sr-only/);
    expect(update.textContent).toContain("Update");
    expect(doc.body.textContent).toContain("$5.99");
    expect(doc.body.textContent).toContain("$14.99");
    expect(doc.body.textContent).toContain("Free");
    expect(doc.body.textContent).toContain("Free with $12.50 more in your cart");
    expect(doc.body.textContent).toMatch(/Arrives/);
  });

  test("unknown selectedId checks nothing; invalid / duplicate quotes dropped; none usable -> nothing", () => {
    const { container, unmount } = render(<ShippingMethodPicker action={noop} options={OPTIONS} selectedId="nope" />);
    expect(Array.from(container.querySelectorAll("input[type=radio]")).some((r) => (r as HTMLInputElement).checked)).toBe(false);
    unmount();
    const bad = [
      STANDARD,
      STANDARD,
      quote(method("", "Empty id", 100)),
      quote(method("n", "   ", 100)),
      quote(method("nan", "NaN price", 0), { priceCents: Number.NaN }),
      quote(method("neg", "Negative", 0), { priceCents: -1 }),
    ];
    const r2 = render(<ShippingMethodPicker action={noop} options={bad} selectedId={null} />);
    expect(r2.container.querySelectorAll("input[type=radio]")).toHaveLength(1);
    r2.unmount();
    expect(renderToStaticMarkup(<ShippingMethodPicker action={noop} options={[]} selectedId={null} />)).toBe("");
  });

  test("autoSubmit: change calls form.requestSubmit and posts ONLY shippingMethodId; Update visually hidden but focusable", async () => {
    const a = scripted([success("Shipping updated", "shipping_selected")]);
    render(<ShippingMethodPicker action={a.action} options={OPTIONS} selectedId="standard" />);
    const spy = spyRequestSubmit();
    const update = screen.getByRole("button", { name: /Update shipping method/ });
    expect(update.className).toMatch(/sr-only/);
    expect(update.className).toMatch(/focus:not-sr-only/);
    fireEvent.click(radio(/Express/));
    await flush();
    expect(spy.count()).toBe(1);
    expect(a.calls).toHaveLength(1);
    expect(userKeys(a.calls[0]!)).toEqual(["shippingMethodId"]);
    expect(a.calls[0]!.shippingMethodId).toBe("express");
    await waitFor(() => expect(document.body.textContent).toContain("Shipping updated"));
  });

  test("autoSubmit=false: change does not submit; visible Update posts the choice", async () => {
    const a = scripted([success("ok", "shipping_selected")]);
    render(<ShippingMethodPicker action={a.action} options={OPTIONS} selectedId="standard" autoSubmit={false} />);
    const spy = spyRequestSubmit();
    fireEvent.click(radio(/Express/));
    await flush();
    expect(spy.count()).toBe(0);
    expect(a.calls).toHaveLength(0);
    const update = screen.getByRole("button", { name: /Update shipping method/ });
    expect(update.className).not.toMatch(/sr-only/);
    fireEvent.click(update);
    await flush();
    expect(a.calls[0]!.shippingMethodId).toBe("express");
  });

  test("re-keys on selectedId change (no-JS post result): the new server selection is checked", () => {
    const { rerender } = render(<ShippingMethodPicker action={noop} options={OPTIONS} selectedId="standard" autoSubmit={false} />);
    fireEvent.click(radio(/Pickup/));
    expect(radio(/Pickup/).checked).toBe(true);
    rerender(<ShippingMethodPicker action={noop} options={OPTIONS} selectedId="express" autoSubmit={false} />);
    expect(radio(/Express/).checked).toBe(true);
    expect(radio(/Pickup/).checked).toBe(false);
  });

  test("failed post: radios reset to selectedId, error in role=alert; a second identical failure resets again", async () => {
    const a = scripted([failure("NOT_FOUND", "That shipping method is not available."), failure("NOT_FOUND", "That shipping method is not available.")]);
    render(<ShippingMethodPicker action={a.action} options={OPTIONS} selectedId="standard" />);
    spyRequestSubmit();
    fireEvent.click(radio(/Express/));
    expect((await screen.findByRole("alert")).textContent).toBe("That shipping method is not available.");
    await waitFor(() => expect(radio(/Standard/).checked).toBe(true));
    expect(radio(/Express/).checked).toBe(false);
    spyRequestSubmit();
    fireEvent.click(radio(/Pickup/));
    await flush();
    expect(a.calls).toHaveLength(2);
    await waitFor(() => expect(radio(/Standard/).checked).toBe(true));
  });

  test("pending: radiogroup aria-busy; Update aria-busy", async () => {
    const g = gated();
    try {
      render(<ShippingMethodPicker action={g.action} options={OPTIONS} selectedId="standard" autoSubmit={false} />);
      fireEvent.click(radio(/Express/));
      fireEvent.click(screen.getByRole("button", { name: /Update shipping method/ }));
      await waitFor(() => expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-busy", "true"));
      const btn = screen.getByRole("button", { name: /shipping method/ });
      expect(btn).toHaveAttribute("aria-busy", "true");
      for (let i = 0; i < 4; i++) fireEvent.click(btn);
      await flush();
      expect(g.calls).toHaveLength(1);
    } finally {
      await g.release(success("ok", "shipping_selected"));
    }
  });

  test("hostile / RTL / 10k method names and hostile error message: text only, break-words", async () => {
    const opts = [HOSTILE, RTL, LONG_WORD].map((n, i) => quote(method(`m${i}`, n, 100)));
    const a = scripted([failure("INTERNAL_ERROR", HOSTILE)]);
    const { container } = render(<ShippingMethodPicker action={a.action} options={opts} selectedId="m0" />);
    expect(container.querySelector("img[src=x], script")).toBeNull();
    expect(container.textContent).toContain(LONG_WORD);
    expect(container.querySelectorAll(".break-words").length).toBeGreaterThanOrEqual(3);
    spyRequestSubmit();
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect((await screen.findByRole("alert")).textContent).toBe(HOSTILE);
    expect(container.querySelector("img[src=x], script")).toBeNull();
  });

  test("currency formatting via Price atom: EUR and JPY", () => {
    const eur = renderToStaticMarkup(<ShippingMethodPicker action={noop} options={[EXPRESS]} selectedId={null} currency="EUR" />);
    expect(parse(eur).body.textContent).toContain("€14.99");
    const jpy = renderToStaticMarkup(<ShippingMethodPicker action={noop} options={[quote(method("j", "Yamato", 500))]} selectedId={null} currency="JPY" />);
    expect(parse(jpy).body.textContent).toContain("¥500");
  });

  test("SR6 + keyboard: radios are native inputs in 44px labels; Update button 44px", () => {
    const { container } = render(<ShippingMethodPicker action={noop} options={OPTIONS} selectedId="standard" />);
    for (const r of Array.from(container.querySelectorAll("input[type=radio]"))) {
      expect(r.getAttribute("tabindex")).not.toBe("-1");
      expect(r.closest("label")!.className).toMatch(/min-h-touch/);
    }
    expect(screen.getByRole("button", { name: /Update shipping method/ }).className).toMatch(/min-h-touch/);
  });
});

// ---------------------------------------------------------------- FreeShippingProgress

describe("T73 AC3/AC4 FreeShippingProgress model", () => {
  const cases: Array<[number, number | null, number | null, string, unknown]> = [
    [2500, 5000, null, "USD", { kind: "progress", percent: 50, remainingText: "$25.00" }],
    [3750, 5000, 1250, "USD", { kind: "progress", percent: 75, remainingText: "$12.50" }],
    [4999, 5000, null, "USD", { kind: "progress", percent: 99, remainingText: "$0.01" }], // floor(99.98)
    [9999, 10000, null, "USD", { kind: "progress", percent: 99, remainingText: "$0.01" }],
    [1, 5000, null, "USD", { kind: "progress", percent: 0, remainingText: "$49.99" }],
    [3333, 10000, null, "USD", { kind: "progress", percent: 33, remainingText: "$66.67" }],
    [5000, 5000, null, "USD", { kind: "qualified" }],
    [6000, 5000, null, "USD", { kind: "qualified" }],
    [4000, 5000, 0, "USD", { kind: "qualified" }],
    [0, 5000, null, "USD", null],
    [-1, 5000, null, "USD", null],
    [Number.NaN, 5000, null, "USD", null],
    [2500.5, 5000, null, "USD", null],
    [Number.POSITIVE_INFINITY, 5000, null, "USD", null],
    [2500, null, null, "USD", null],
    [2500, 0, null, "USD", null],
    [2500, -5000, null, "USD", null],
    [2500, 5000.5, null, "USD", null],
    [2500, 5000, -1, "USD", null],
    [2500, 5000, 12.5, "USD", null],
    [2500, 5000, Number.NaN, "USD", null],
    [2500, 5000, null, "XX", null],
    [2500, 5000, null, "", null],
  ];
  for (const [sub, thr, amt, cur, want] of cases) {
    test(`(${sub}, ${thr}, ${amt}, ${JSON.stringify(cur)}) -> ${JSON.stringify(want)}`, () => {
      expect(freeShippingModel(sub, thr, amt, cur)).toEqual(want as ReturnType<typeof freeShippingModel>);
    });
  }
  test("JPY formatting (zero-decimal)", () => {
    expect(freeShippingModel(2000, 5000, null, "JPY")).toEqual({ kind: "progress", percent: 40, remainingText: "¥3,000" });
  });
});

describe("T73 AC3 FreeShippingProgress rendering", () => {
  test("below threshold: role=progressbar with value + text equivalent; visible 'Add $X more for free shipping'", () => {
    const html = renderToStaticMarkup(<FreeShippingProgress subtotalCents={3750} thresholdCents={5000} amountToFreeCents={1250} currency="USD" />);
    const doc = parse(html);
    const bar = doc.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("75");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuetext")).toBe("$12.50 away from free shipping");
    expect(bar.getAttribute("aria-label") ?? bar.getAttribute("aria-labelledby")).toBeTruthy();
    expect(doc.body.textContent).toContain("Add $12.50 more for free shipping");
    expect(html).not.toContain("<script");
  });
  test("at/above threshold: success text 'You've got free shipping!' and full bar", () => {
    for (const sub of [5000, 12000]) {
      const doc = parse(renderToStaticMarkup(<FreeShippingProgress subtotalCents={sub} thresholdCents={5000} amountToFreeCents={null} currency="USD" />));
      expect(doc.body.textContent).toContain("You've got free shipping!");
      expect(doc.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("100");
    }
  });
  test("0 total hides the bar; invalid inputs render nothing", () => {
    for (const props of [
      { subtotalCents: 0, thresholdCents: 5000, amountToFreeCents: null, currency: "USD" },
      { subtotalCents: 100, thresholdCents: null, amountToFreeCents: null, currency: "USD" },
      { subtotalCents: Number.NaN, thresholdCents: 5000, amountToFreeCents: null, currency: "USD" },
      { subtotalCents: 100, thresholdCents: 5000, amountToFreeCents: null, currency: "nope" },
    ]) {
      expect(renderToStaticMarkup(<FreeShippingProgress {...props} />)).toBe("");
    }
  });
});
