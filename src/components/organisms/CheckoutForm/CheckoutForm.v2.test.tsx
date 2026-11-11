import { describe, expect, test } from "bun:test";
import { Component, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isAllowedInternalHref } from "@/content/routes";
import { appError } from "@/lib/result";
import type { SavedAddress, ShippingMethod } from "@/lib/types";
import { validateCard } from "@/lib/validation";
import type { ShippingQuote } from "@/server/pricing/shipping-service";
import {
  CHECKOUT_FIELD_V2,
  type CheckoutActionFnV2,
  type CheckoutActionStateV2,
  type CheckoutRetainedValuesV2,
} from "../_contracts/checkout-actions";
import { CheckoutForm } from "./CheckoutForm";
import {
  CHECKOUT_V2_IDS,
  displayTotals,
  errorSummaryItems,
  mapV2Errors,
  nextIdempotencyKeyV2,
  type CheckoutFormV2Config,
} from "./CheckoutFormV2";
import { expectFocused } from "@/test/dom-assertions";

const KEY = "key-initial-v2-0000";
const CARD_NAMES = ["nameOnCard", "number", "expMonth", "expYear", "cvc"] as const;
const ADDRESS_NAMES = ["fullName", "email", "line1", "line2", "city", "region", "postalCode", "country"] as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function address(over: Partial<SavedAddress> & Pick<SavedAddress, "id">): SavedAddress {
  return {
    label: "",
    fullName: "Ada Lovelace",
    line1: "1 Main St",
    city: "London",
    region: "Greater London",
    postalCode: "N1 9GU",
    country: "GB",
    isDefault: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

const WORK = address({ id: "11111111-1111-4111-8111-111111111111", label: "Work", line1: "2 Office Rd" });
const HOME = address({ id: "22222222-2222-4222-8222-222222222222", label: "Home", isDefault: true });

function method(id: string, name: string, priceCents: number, freeOverCents: number | null, sortOrder: number): ShippingMethod {
  return { id, name, description: "", priceCents, freeOverCents, minDays: 1, maxDays: 5, sortOrder, isActive: true };
}

const STANDARD: ShippingQuote = { method: method("standard", "Standard", 599, 5000, 1), priceCents: 599, isFree: false, amountToFreeCents: 2000 };
const EXPRESS: ShippingQuote = { method: method("express", "Express", 1499, null, 2), priceCents: 1499, isFree: false, amountToFreeCents: null };

/** 2 × 15.00 = 30.00; discount 3.00; Standard 5.99 -> 32.99. */
function config(over: Partial<CheckoutFormV2Config> = {}): CheckoutFormV2Config {
  return {
    action: async () => null,
    savedAddresses: [WORK, HOME],
    shipping: {
      options: [STANDARD, EXPRESS],
      selectedId: "standard",
      arrivals: {
        standard: { start: "2026-11-10T00:00:00.000Z", end: "2026-11-12T00:00:00.000Z" },
        express: { start: "2026-11-09T00:00:00.000Z", end: "2026-11-09T00:00:00.000Z" },
      },
      currency: "USD",
      now: Date.parse("2026-11-07T12:00:00.000Z"),
    },
    summary: {
      items: [{ productId: "p1", name: "Mug", quantity: 2, unitPriceCents: 1500 }],
      subtotalCents: 3000,
      discountCents: 300,
      shippingCents: 599,
      totalCents: 3299,
    },
    coupon: { code: "WELCOME10", description: "10% off" },
    freeShipping: { subtotalCents: 3000, thresholdCents: 5000, amountToFreeCents: 2000, currency: "USD" },
    isSignedIn: false,
    ...over,
  };
}

type Call = { key: string; fields: Record<string, string> };

function snapshot(formData: FormData): Call {
  const fields: Record<string, string> = {};
  formData.forEach((value, name) => {
    if (typeof value === "string" && !(name in fields)) fields[name] = value;
  });
  return { key: fields.idempotencyKey ?? "", fields };
}

function scriptedAction(steps: ReadonlyArray<CheckoutActionStateV2 | "throw">) {
  const calls: Call[] = [];
  const action: CheckoutActionFnV2 = async (_prev, formData) => {
    calls.push(snapshot(formData));
    const step = steps[calls.length - 1] ?? null;
    if (step === "throw") throw new TypeError("Failed to fetch");
    return step;
  };
  return { action, calls };
}

function controlledAction() {
  const calls: Call[] = [];
  let resolveFn: (s: CheckoutActionStateV2) => void = () => {};
  const action: CheckoutActionFnV2 = (_prev, formData) => {
    calls.push(snapshot(formData));
    return new Promise<CheckoutActionStateV2>((res) => {
      resolveFn = res;
    });
  };
  return { action, calls, resolve: (s: CheckoutActionStateV2) => resolveFn(s) };
}

function failure(
  code: Parameters<typeof appError>[0],
  msg: string,
  extra: { details?: Readonly<Record<string, unknown>>; values?: CheckoutRetainedValuesV2; fieldErrors?: Record<string, string> } = {},
): CheckoutActionStateV2 {
  return {
    ok: false,
    error: appError(code, msg, extra.details),
    ...(extra.values ? { values: extra.values } : {}),
    ...(extra.fieldErrors ? { fieldErrors: extra.fieldErrors } : {}),
  };
}

function renderV2(over: Partial<CheckoutFormV2Config> = {}) {
  return render(<CheckoutForm initialIdempotencyKey={KEY} v2={config(over)} />);
}

function staticDom(over: Partial<CheckoutFormV2Config> = {}): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<CheckoutForm initialIdempotencyKey={KEY} v2={config(over)} />);
  return host;
}

function form(): HTMLFormElement {
  return screen.getByRole("form", { name: "Checkout" }) as HTMLFormElement;
}
function hiddenKey(): HTMLInputElement {
  const el = form().querySelector<HTMLInputElement>('input[type="hidden"][name="idempotencyKey"]');
  if (!el) throw new Error("hidden key missing");
  return el;
}
function byName(name: string): HTMLInputElement {
  const el = form().querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!el) throw new Error(`no field ${name}`);
  return el;
}
function setValue(name: string, value: string) {
  fireEvent.change(byName(name), { target: { value } });
}
function fillCard(number: string, cvc = "123") {
  setValue("nameOnCard", "A LOVELACE");
  setValue("number", number);
  setValue("expMonth", "12");
  setValue("expYear", "2099");
  setValue("cvc", cvc);
}
function newAddressBox(): HTMLElement {
  return screen.getByTestId("checkout-new-address");
}
function summarySection(): HTMLElement {
  const el = form().querySelector<HTMLElement>("[data-total-check]");
  if (!el) throw new Error("no order summary");
  return el;
}
const submitButton = () => screen.getByRole("button", { name: /place order|placing order/i });

async function summaryAlert(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name: "Please fix the following" });
  return heading.closest('[role="alert"]') as HTMLElement;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("nextIdempotencyKeyV2", () => {
  const gen = () => "fresh";
  test("keeps the key after a network error", () => {
    expect(nextIdempotencyKeyV2("k", "network", gen)).toBe("k");
  });
  test("keeps the key after INTERNAL_ERROR (outcome unknown)", () => {
    expect(nextIdempotencyKeyV2("k", failure("INTERNAL_ERROR", "Something went wrong."), gen)).toBe("k");
  });
  test.each(["PAYMENT_FAILED", "VALIDATION_FAILED", "STOCK_CHANGED", "COUPON_EXPIRED", "INVALID_INPUT", "NOT_FOUND"] as const)(
    "regenerates after %s",
    (code) => {
      expect(nextIdempotencyKeyV2("k", failure(code, "x"), gen)).toBe("fresh");
    },
  );
  test("regenerates after a null state", () => {
    expect(nextIdempotencyKeyV2("k", null, gen)).toBe("fresh");
  });
});

describe("mapV2Errors / errorSummaryItems", () => {
  test("address + v2 fields from fieldErrors; card only from details.fields", () => {
    const card = validateCard({ number: "1234", expMonth: "13", expYear: "2030", cvc: "1", nameOnCard: "Ada" });
    if (card.ok) throw new Error("expected failure");
    const errors = mapV2Errors(
      failure("VALIDATION_FAILED", "Fix", {
        details: { fields: { ...card.error.details.fields, city: { code: "REQUIRED", message: "from details" } } },
        fieldErrors: { city: "Enter a city.", shippingMethodId: "Choose a valid shipping method.", number: "should be ignored", bogus: "x", phone: "  " },
      }),
    );
    expect(errors.address.city?.message).toBe("Enter a city.");
    expect(errors.extra.shippingMethodId).toBe("Choose a valid shipping method.");
    expect(errors.extra.phone).toBeUndefined();
    expect(errors.card.number?.message).not.toBe("should be ignored");
    expect(errors.card.number).toBeDefined();
    const ids = errorSummaryItems(errors).map((i) => i.id);
    expect(ids[0]).toBe("address-city");
    expect(ids).toContain(CHECKOUT_V2_IDS.shippingMethodId);
    expect(ids.indexOf(CHECKOUT_V2_IDS.shippingMethodId)).toBeLessThan(ids.indexOf("card-number"));
  });

  test("without fieldErrors, address errors fall back to the MVP details.fields", () => {
    const errors = mapV2Errors(failure("VALIDATION_FAILED", "Fix", { details: { fields: { line1: { code: "REQUIRED", message: "Enter line 1." } } } }));
    expect(errors.address.line1?.message).toBe("Enter line 1.");
  });

  test("null and malformed states map to nothing", () => {
    expect(errorSummaryItems(mapV2Errors(null))).toEqual([]);
    const weird = { ok: false, error: appError("VALIDATION_FAILED", "x", { fields: "nope" }), fieldErrors: ["a"] } as unknown as CheckoutActionStateV2;
    expect(errorSummaryItems(mapV2Errors(weird))).toEqual([]);
  });
});

describe("displayTotals", () => {
  const c = config();
  test("server totals while the chosen method is the server's", () => {
    expect(displayTotals(c.summary, [STANDARD, EXPRESS], "standard", "standard", c.coupon)).toEqual({
      shippingCents: 599,
      totalCents: 3299,
      estimated: false,
      methodName: "Standard",
    });
  });
  test("re-priced for another method; free-shipping coupon keeps 0; unknown id falls back", () => {
    expect(displayTotals(c.summary, [STANDARD, EXPRESS], "standard", "express", c.coupon)).toMatchObject({ shippingCents: 1499, totalCents: 4199, estimated: true });
    expect(
      displayTotals(c.summary, [STANDARD, EXPRESS], "standard", "express", { code: "SHIPFREE", description: "", freeShipping: true }),
    ).toMatchObject({ shippingCents: 0, totalCents: 2700 });
    expect(displayTotals(c.summary, [STANDARD, EXPRESS], "standard", "ghost", c.coupon)).toMatchObject({ totalCents: 3299, estimated: false });
  });
});

// ---------------------------------------------------------------------------
// No-JS markup
// ---------------------------------------------------------------------------

describe("CheckoutForm v2 static markup (no JS)", () => {
  test("exactly one form, no nested forms, every v2 + address + card name present", () => {
    const root = staticDom();
    expect(root.querySelectorAll("form")).toHaveLength(1);
    expect(root.querySelector("form form")).toBeNull();
    const formEl = root.querySelector("form") as HTMLFormElement;
    expect(formEl.hasAttribute("novalidate")).toBe(true);
    for (const name of [...Object.values(CHECKOUT_FIELD_V2), ...CARD_NAMES, ...ADDRESS_NAMES]) {
      expect(formEl.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    expect(formEl.querySelectorAll('[name="email"]')).toHaveLength(1);
    expect((formEl.querySelector('input[name="idempotencyKey"]') as HTMLInputElement).value).toBe(KEY);
  });

  test("saved-address radios and the new-address fieldset are both present and visible", () => {
    const root = staticDom();
    expect(root.querySelectorAll('input[type="radio"][name="addressId"]')).toHaveLength(2);
    const box = root.querySelector('[data-testid="checkout-new-address"]') as HTMLElement;
    expect(box.hasAttribute("hidden")).toBe(false);
    expect(box.querySelector('[name="line1"]')).not.toBeNull();
    // Without JS the shopper is told the new-address fields only matter in "new" mode.
    expect(box.querySelector('[data-testid="checkout-new-address-hint"]')?.textContent).toMatch(/only if you chose "Use a new address"/);
  });

  test("default address and saved mode are preselected; cart shipping method is checked", () => {
    const root = staticDom();
    const checked = (name: string) => (root.querySelector(`input[name="${name}"][checked]`) as HTMLInputElement | null)?.value;
    expect(checked("addressId")).toBe(HOME.id);
    expect(checked("addressMode")).toBe("saved");
    expect(checked("shippingMethodId")).toBe("standard");
  });

  test("input limits mirror the server (note 200, label 40, phone 20, address 200, email 254)", () => {
    const root = staticDom();
    const max = (name: string) => root.querySelector(`[name="${name}"]`)?.getAttribute("maxlength");
    expect(max("deliveryNote")).toBe("200");
    expect(max("addressLabel")).toBe("40");
    expect(max("phone")).toBe("20");
    expect(max("line1")).toBe("200");
    expect(max("email")).toBe("254");
  });

  test("server totals match (data-total-check) and the method name is shown", () => {
    const root = staticDom();
    const section = root.querySelector("[data-total-check]") as HTMLElement;
    expect(section.getAttribute("data-total-check")).toBe("match");
    expect(section.textContent).toContain("$32.99");
    expect(section.textContent).toContain("Standard");
  });

  test("coupon is a read-only chip with a Change in cart link; terms/privacy links; every href allowed", () => {
    const root = staticDom();
    const coupon = root.querySelector('[data-testid="checkout-coupon"]') as HTMLElement;
    expect(coupon.textContent).toContain("WELCOME10");
    expect(coupon.textContent).toContain("10% off");
    expect(coupon.querySelector("input, button")).toBeNull();
    expect(coupon.querySelector("a")?.getAttribute("href")).toBe("/cart");
    // D-T161-2: standalone link beside the chip -> 44px target.
    expect((coupon.querySelector("a")?.getAttribute("class") ?? "").split(/\s+/)).toEqual(
      expect.arrayContaining(["inline-flex", "min-h-touch", "items-center"]),
    );
    const hrefs = Array.from(root.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("/terms");
    expect(hrefs).toContain("/privacy");
    for (const href of hrefs) expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("no coupon -> 'Add it in your cart' link; invalid cartHref falls back to /cart", () => {
    const root = staticDom({ coupon: null, cartHref: "https://evil.example/cart" });
    const link = Array.from(root.querySelectorAll("a")).find((a) => a.textContent === "Add it in your cart");
    expect(link?.getAttribute("href")).toBe("/cart");
  });

  test("no saved addresses: hidden addressMode=new, MVP-shaped AddressFields with email", () => {
    const root = staticDom({ savedAddresses: [] });
    const mode = root.querySelector('input[name="addressMode"]') as HTMLInputElement;
    expect(mode.type).toBe("hidden");
    expect(mode.value).toBe("new");
    expect(root.querySelector('[name="addressId"]')).toBeNull();
    const fieldset = root.querySelector('[data-testid="checkout-new-address"] fieldset') as HTMLElement;
    expect(fieldset.querySelector("legend")?.textContent).toBe("Shipping address");
    expect(fieldset.querySelector('input[name="email"]')).not.toBeNull();
  });

  test("hostile saved-address text renders as inert text", () => {
    const hostile = address({
      id: "33333333-3333-4333-8333-333333333333",
      label: '<img src=x onerror="alert(1)">',
      fullName: "<script>alert(2)</script>",
      line1: "javascript:alert(3)",
      isDefault: true,
    });
    const root = staticDom({ savedAddresses: [hostile] });
    expect(root.querySelector("img")).toBeNull();
    // The only scripts are React's own form-replay helper; none carries user text.
    for (const script of Array.from(root.querySelectorAll("script"))) expect(script.textContent).not.toContain("alert(");
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(root.textContent).toContain("<script>alert(2)</script>");
  });
});

// ---------------------------------------------------------------------------
// Email placement
// ---------------------------------------------------------------------------

describe("CheckoutForm v2 email", () => {
  test("signed in with an email: shown as text + one hidden input; AddressFields omits email", () => {
    renderV2({ isSignedIn: true, email: "ada@example.com" });
    const emails = form().querySelectorAll<HTMLInputElement>('[name="email"]');
    expect(emails).toHaveLength(1);
    expect(emails[0]?.type).toBe("hidden");
    expect(emails[0]?.value).toBe("ada@example.com");
    expect(document.getElementById(CHECKOUT_V2_IDS.email)).toHaveTextContent("Order updates go to ada@example.com");
    expect(within(newAddressBox()).queryByLabelText(/^Email/)).toBeNull();
    expect(new FormData(form()).get("email")).toBe("ada@example.com");
  });

  test("guest with saved addresses: one email input outside the new-address block", () => {
    renderV2();
    const emails = form().querySelectorAll<HTMLInputElement>('[name="email"]');
    expect(emails).toHaveLength(1);
    expect(emails[0]?.id).toBe(CHECKOUT_V2_IDS.email);
    expect(newAddressBox().contains(emails[0] ?? null)).toBe(false);
  });

  test("signed in without an email falls back to an email input", () => {
    renderV2({ isSignedIn: true, email: "  ", savedAddresses: [] });
    expect(within(newAddressBox()).getByLabelText(/^Email/)).toHaveAttribute("type", "email");
  });
});

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

describe("CheckoutForm v2 with JS", () => {
  test("mode switching: new-address block hidden in saved mode, revealed by 'Use a new address', hidden again by a card", async () => {
    renderV2();
    await waitFor(() => expect(newAddressBox()).toHaveAttribute("hidden"));
    expect(new FormData(form()).get("addressMode")).toBe("saved");
    expect(new FormData(form()).get("addressId")).toBe(HOME.id);

    fireEvent.click(screen.getByRole("radio", { name: "Use a new address" }));
    expect(newAddressBox()).not.toHaveAttribute("hidden");
    expect(new FormData(form()).get("addressMode")).toBe("new");

    const workRadio = within(screen.getByRole("radiogroup", { name: /Your saved addresses/ })).getAllByRole("radio")[0] as HTMLInputElement;
    fireEvent.click(workRadio);
    expect(newAddressBox()).toHaveAttribute("hidden");
    expect(new FormData(form()).get("addressMode")).toBe("saved");
    expect(new FormData(form()).get("addressId")).toBe(WORK.id);
  });

  test("the default address is preselected even when it is not first", () => {
    renderV2();
    const radios = within(screen.getByRole("radiogroup", { name: /Your saved addresses/ })).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
  });

  test("changing the shipping method updates shipping and total; the choice is posted", async () => {
    const { action, calls } = scriptedAction([null]);
    renderV2({ action });
    expect(summarySection()).toHaveTextContent("$32.99");
    fireEvent.click(screen.getByRole("radio", { name: /^Express/ }));
    expect(summarySection()).toHaveTextContent("$41.99");
    expect(summarySection()).toHaveTextContent("$14.99");
    expect(summarySection().getAttribute("data-total-check")).toBe("match");
    expect(screen.getByTestId("checkout-total-note")).toHaveTextContent(/updated for Express/);
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.fields.shippingMethodId).toBe("express");
  });

  test("posts every v2 field with the key", async () => {
    const { action, calls } = scriptedAction([null]);
    renderV2({ action });
    fireEvent.click(screen.getByRole("radio", { name: "Use a new address" }));
    setValue("email", "ada@example.com");
    setValue("fullName", "Ada Lovelace");
    setValue("line1", "9 New St");
    setValue("city", "London");
    setValue("region", "LDN");
    setValue("postalCode", "N1");
    fireEvent.change(byName("country"), { target: { value: "GB" } });
    setValue("phone", "+44 20 7946 0000");
    fireEvent.click(screen.getByRole("checkbox", { name: /Save this address/ }));
    setValue("addressLabel", "Flat");
    setValue("deliveryNote", "Side door");
    fillCard("4242424242424242");
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.fields).toMatchObject({
      idempotencyKey: KEY,
      addressMode: "new",
      line1: "9 New St",
      phone: "+44 20 7946 0000",
      saveAddress: "on",
      addressLabel: "Flat",
      deliveryNote: "Side door",
      shippingMethodId: "standard",
      number: "4242424242424242",
    });
  });

  test("delivery note shows a counter and has maxLength 200", () => {
    renderV2();
    const note = byName("deliveryNote");
    expect(note).toHaveAttribute("maxlength", "200");
    expect(screen.getByText(/0 \/ 200/)).toBeTruthy();
  });

  test("pending: 'Placing order…', one submission while pending, released afterwards", async () => {
    const { action, calls, resolve } = controlledAction();
    renderV2({ action });
    fireEvent.submit(form());
    fireEvent.submit(form());
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton()).toHaveTextContent("Placing order…"));
    expect(calls).toHaveLength(1);
    await act(async () => resolve(failure("PAYMENT_FAILED", "Card declined.")));
    await screen.findByRole("heading", { name: /payment didn't go through/i });
    expect(submitButton()).toHaveTextContent("Place order");
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    // Settle the second attempt: an unresolved async transition would entangle later tests.
    await act(async () => resolve(failure("PAYMENT_FAILED", "Card declined.")));
  });

  test("keys: kept on network error and INTERNAL_ERROR, regenerated after other failures", async () => {
    const { action, calls } = scriptedAction(["throw", failure("INTERNAL_ERROR", "Something went wrong. Please try again."), failure("PAYMENT_FAILED", "Declined."), null]);
    renderV2({ action });
    fireEvent.submit(form());
    await screen.findByText(/couldn't reach the store/i);
    expect(hiddenKey()).toHaveValue(KEY);

    fireEvent.submit(form());
    const internal = await screen.findByText("Something went wrong. Please try again.");
    expect(internal.closest('[role="alert"]')).toHaveTextContent(/won't be charged twice/i);
    expect(hiddenKey()).toHaveValue(KEY);

    fireEvent.submit(form());
    await screen.findByRole("heading", { name: /payment didn't go through/i });
    await waitFor(() => expect(hiddenKey().value).not.toBe(KEY));
    const fresh = hiddenKey().value;

    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.map((c) => c.key)).toEqual([KEY, KEY, KEY, fresh]);
  });

  test("validation regenerates the key (MVP rule)", async () => {
    const { action, calls } = scriptedAction([failure("VALIDATION_FAILED", "Fix", { fieldErrors: { city: "Enter a city." } }), null]);
    renderV2({ action });
    fireEvent.submit(form());
    await summaryAlert();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.key).not.toBe(KEY);
  });

  test("no card number / CVC anywhere in the DOM after a failed submit; other values re-filled", async () => {
    const values: CheckoutRetainedValuesV2 = {
      addressMode: "new",
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      line1: "9 New St",
      city: "London",
      region: "LDN",
      postalCode: "N1",
      country: "GB",
      phone: "+44 20 7946 0000",
      addressLabel: "Flat",
      saveAddress: true,
      deliveryNote: "Side door",
      shippingMethodId: "express",
      nameOnCard: "A LOVELACE",
    };
    const { action } = scriptedAction([failure("PAYMENT_FAILED", "Your card was declined.", { values })]);
    renderV2({ action });
    fillCard("4000056655665556", "987");
    fireEvent.submit(form());
    await screen.findByRole("heading", { name: /payment didn't go through/i });
    await waitFor(() => expect(byName("number").value).toBe(""));
    expect(byName("cvc").value).toBe("");
    expect(byName("expMonth").value).toBe("");
    // Mask UUIDs (idempotency key, React ids) first: a random UUID can contain "987".
    const html = document.body.innerHTML.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
    expect(html).not.toContain("4000056655665556");
    expect(html).not.toContain("987");
    for (const el of Array.from(form().querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value.includes("4000056655665556")).toBe(false);
      }
    }
    // Re-filled from values (never card data).
    expect(byName("nameOnCard").value).toBe("A LOVELACE");
    expect(byName("line1").value).toBe("9 New St");
    expect(byName("phone").value).toBe("+44 20 7946 0000");
    expect(byName("addressLabel").value).toBe("Flat");
    expect(byName("deliveryNote").value).toBe("Side door");
    expect((screen.getByRole("checkbox", { name: /Save this address/ }) as HTMLInputElement).checked).toBe(true);
    expect(newAddressBox()).not.toHaveAttribute("hidden");
    expect(new FormData(form()).get("addressMode")).toBe("new");
    expect(new FormData(form()).get("shippingMethodId")).toBe("express");
  });

  test.each([
    ["addressId", "Choose a saved address.", CHECKOUT_V2_IDS.addressId, "Saved address"],
    ["shippingMethodId", "Choose a valid shipping method.", CHECKOUT_V2_IDS.shippingMethodId, "Shipping method"],
    ["deliveryNote", "Delivery note must be at most 200 characters.", CHECKOUT_V2_IDS.deliveryNote, "Delivery note"],
    ["addressLabel", "Label is too long.", CHECKOUT_V2_IDS.addressLabel, "Address label"],
    ["phone", "Enter a valid phone number.", CHECKOUT_V2_IDS.phone, "Phone"],
    ["email", "Enter a valid email address.", CHECKOUT_V2_IDS.email, "Email"],
    ["postalCode", "Enter a postal code.", "address-postalCode", "Postal code"],
  ] as const)("fieldErrors.%s -> summary link + inline error", async (field, msg, id, label) => {
    const { action } = scriptedAction([
      failure(field === "addressId" ? "NOT_FOUND" : "VALIDATION_FAILED", msg, {
        fieldErrors: { [field]: msg },
        values: field === "postalCode" ? { addressMode: "new" } : {},
      }),
    ]);
    renderV2({ action });
    fireEvent.submit(form());
    const alert = await summaryAlert();
    await waitFor(() => expectFocused(alert));
    const link = within(alert).getByRole("link", { name: `${label}: ${msg}` });
    expect(link).toHaveAttribute("href", `#${id}`);
    const target = document.getElementById(id);
    expect(target).not.toBeNull();
    // Inline error rendered next to the field (group errorText or FormField error).
    expect(screen.getAllByText(msg).filter((el) => !alert.contains(el))).toHaveLength(1);
    fireEvent.click(link);
    if (target?.tagName === "FIELDSET") {
      expect(document.activeElement?.getAttribute("type")).toBe("radio");
      expect(target.contains(document.activeElement)).toBe(true);
    } else {
      expectFocused(target);
    }
  });

  test("card errors come from details.fields only and link to the card inputs", async () => {
    const card = validateCard({ number: "1234", expMonth: "12", expYear: "2099", cvc: "1", nameOnCard: "Ada" });
    if (card.ok) throw new Error("expected failure");
    const { action } = scriptedAction([failure("VALIDATION_FAILED", "Fix", { details: { fields: card.error.details.fields } })]);
    renderV2({ action });
    fireEvent.submit(form());
    const alert = await summaryAlert();
    const hrefs = within(alert).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("#card-number");
    expect(hrefs).toContain("#card-cvc");
    expect(byName("number")).toHaveAttribute("aria-invalid", "true");
  });

  test("coupon failure: alert says nothing was charged and links back to the cart", async () => {
    const { action } = scriptedAction([failure("COUPON_EXPIRED", "This code has expired.")]);
    renderV2({ action, cartHref: "/cart" });
    fireEvent.submit(form());
    const heading = await screen.findByRole("heading", { name: /promo code can't be used/i });
    const alert = heading.closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent("This code has expired.");
    expect(alert).toHaveTextContent(/Nothing was charged/);
    expect(within(alert).getByRole("link", { name: "Change in cart" })).toHaveAttribute("href", "/cart");
    expect(within(alert).getByRole("link", { name: "Change in cart" }).className).toContain("min-h-touch");
  });

  test("STOCK_CHANGED and EMPTY_CART keep the MVP alerts", async () => {
    const { action } = scriptedAction([
      failure("STOCK_CHANGED", "Stock changed.", { details: { lines: [{ productId: "p1", name: "Mug", requested: 2, available: 1 }] } }),
      failure("EMPTY_CART", "Your cart is empty."),
    ]);
    renderV2({ action });
    fireEvent.submit(form());
    const stock = await screen.findByRole("heading", { name: /items in your cart changed/i });
    expect(stock.closest('[role="alert"]')).toHaveTextContent("Mug: you asked for 2, only 1 available.");
    fireEvent.submit(form());
    await screen.findByRole("heading", { name: "Your cart is empty" });
  });

  test("a Next.js redirect (success) is rethrown", async () => {
    class Boundary extends Component<{ children: ReactNode }, { caught: string | null }> {
      override state = { caught: null as string | null };
      static getDerivedStateFromError(error: unknown) {
        const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : "other";
        return { caught: digest };
      }
      override render() {
        return this.state.caught ? <p data-testid="caught">{this.state.caught}</p> : this.props.children;
      }
    }
    const redirectAction: CheckoutActionFnV2 = async () => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/orders/1;303;" });
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      render(
        <Boundary>
          <CheckoutForm initialIdempotencyKey={KEY} v2={config({ action: redirectAction })} />
        </Boundary>,
      );
      fireEvent.submit(form());
      expect(await screen.findByTestId("caught")).toHaveTextContent(/^NEXT_REDIRECT/);
    } finally {
      console.error = originalError;
    }
  });

  test("320px audit: shrinkable containers, single-column address grid, wrapping coupon row, no arbitrary values", () => {
    const { container } = renderV2();
    expect(form()).toHaveClass("min-w-0");
    for (const section of Array.from(form().querySelectorAll("section"))) expect(section).toHaveClass("min-w-0");
    const list = within(screen.getByRole("radiogroup", { name: /Your saved addresses/ })).getByRole("list");
    expect(list).toHaveClass("grid-cols-1", "min-w-0");
    expect(screen.getByTestId("checkout-coupon")).toHaveClass("flex-wrap", "min-w-0");
    for (const el of Array.from(container.querySelectorAll("[class]"))) {
      const cls = el.getAttribute("class") ?? "";
      expect(cls).not.toMatch(/\[|\bw-(?:\d{2,}|screen)\b|\bmin-w-(?:[1-9]|\[)/);
    }
  });

  test("T161: every checkout step is a raised Card panel; Place order is the primary pill", () => {
    renderV2();
    const steps = Array.from(form().querySelectorAll("section[aria-labelledby^='checkout-step-']"));
    expect(steps).toHaveLength(6);
    for (const step of steps) expect(step).toHaveClass("bg-surface-raised", "rounded-lg", "border-border-default");
    const place = screen.getByRole("button", { name: "Place order" });
    expect(place).toHaveClass("bg-accent", "rounded-full", "w-full");
  });
});

describe("CheckoutForm v2 layout (U06)", () => {
  test("no-JS markup: two columns from lg inside the one form; steps left, review + Place order right and sticky", () => {
    const root = staticDom();
    expect(root.querySelectorAll("form")).toHaveLength(1);
    const formEl = root.querySelector("form");
    const layout = root.querySelector('[data-testid="checkout-layout"]');
    const steps = root.querySelector('[data-testid="checkout-steps"]');
    const aside = root.querySelector('[data-testid="checkout-review-column"]');
    if (!formEl || !layout || !steps || !aside) throw new Error("layout pieces missing");
    expect(formEl.contains(layout)).toBe(true);
    expect(layout.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex-col", "lg:flex-row", "lg:items-start"]));
    expect(steps.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "lg:flex-1", "lg:max-w-3xl"]));
    expect(aside.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "lg:sticky", "lg:top-20", "lg:shrink-0"]));
    // Sticky only from lg: below lg the column stacks and scrolls normally.
    expect(aside.className.split(/\s+/)).not.toContain("sticky");

    const stepIds = Array.from(steps.querySelectorAll("section[aria-labelledby]")).map((el) => el.getAttribute("aria-labelledby"));
    expect(stepIds).toEqual(["checkout-step-address", "checkout-step-shipping", "checkout-step-note", "checkout-step-promo", "checkout-step-payment"]);
    expect(aside.querySelector('section[aria-labelledby="checkout-step-review"]')).not.toBeNull();

    // DOM (= stacked and tab) order: steps, review, terms, Place order last.
    const submit = aside.querySelector('button[type="submit"]');
    expect(submit?.textContent).toBe("Place order");
    expect(formEl.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    const controls = Array.from(formEl.querySelectorAll("input:not([type=hidden]), select, textarea, button, a[href]"));
    expect(controls.at(-1) ?? null).toBe(submit);
    expect(aside.textContent).toContain("By placing your order, you agree to our");
  });

  test("legends repeating the card heading are visually hidden but keep naming their groups", () => {
    renderV2({ savedAddresses: [] });
    const payment = screen.getByRole("group", { name: "Payment" });
    expect(payment.querySelector("legend")).toHaveClass("sr-only");
    const shipping = screen.getByRole("group", { name: "Shipping address" });
    expect(shipping.querySelector("legend")).toHaveClass("sr-only");
  });

  test("with saved addresses the 'New shipping address' legend stays visible (it adds information)", () => {
    const legend = staticDom().querySelector('[data-testid="checkout-new-address"] fieldset > legend');
    expect(legend?.textContent).toBe("New shipping address");
    expect(legend).not.toHaveClass("sr-only");
  });

  test("the review summary uses the plain $0.00 format on every row (U18)", () => {
    const root = staticDom();
    const review = root.querySelector('section[aria-labelledby="checkout-step-review"]');
    expect(review?.querySelector('[data-slot="price-superscript"]')).toBeNull();
    expect(review?.textContent).toContain("$32.99");
  });
});

