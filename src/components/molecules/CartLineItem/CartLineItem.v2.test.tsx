import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { fail, ok } from "@/lib/result";
import { formatMoney } from "@/lib/money";
import type { CartActionFn, CartActionFnV2, CartActionState, CartActionStateV2 } from "../_contracts/cart-actions";
import {
  CartLineItem,
  billableQuantity,
  computeLineSavingsCents,
  computeLineTotalCents,
  type CartLineItemData,
  type CartLineItemProps,
} from "./CartLineItem";

const noop: CartActionFn = async () => null;
const savedOk = ok({ itemCount: 0, subtotalCents: 0, message: "Saved for later", kind: "saved" as const });

const baseItem: CartLineItemData = {
  productId: "p1",
  name: "Canvas Tote",
  slug: "canvas-tote",
  imageUrl: "/images/tote.jpg",
  quantity: 2,
  unitPriceCents: 1250,
  lineTotalCents: 2500,
  availableStock: 5,
  status: "ok",
};

function recordingSave(result: CartActionStateV2) {
  const calls: Array<Record<string, FormDataEntryValue>> = [];
  const action: CartActionFnV2 = async (_prev, fd) => {
    calls.push(Object.fromEntries(fd.entries()));
    return result;
  };
  return { action, calls };
}

function ui(item: Partial<CartLineItemData> = {}, props: Partial<CartLineItemProps> = {}) {
  return (
    <CartLineItem
      item={{ ...baseItem, ...item }}
      currency="USD"
      updateQuantity={noop}
      removeItem={noop}
      {...props}
    />
  );
}

describe("CartLineItem v2: MVP rendering unchanged without v2 props", () => {
  test("no thumbnail, no link, no save form, no visible line-total label, no savings", () => {
    const { container } = render(ui());
    expect(container.querySelector("img, [role=img]")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save for later/ })).toBeNull();
    expect(screen.queryByTestId("line-total-label")).toBeNull();
    expect(screen.queryByTestId("line-savings")).toBeNull();
    expect(container.querySelectorAll("form")).toHaveLength(2);
  });
});

describe("CartLineItem v2: thumbnail and product link", () => {
  test("thumbnail renders a 64px image with the given alt", () => {
    render(ui({}, { thumbnail: { url: "/images/tote.jpg", alt: "Canvas Tote" } }));
    const img = screen.getByRole("img", { name: "Canvas Tote" });
    expect(img).toHaveAttribute("width", "64");
    expect(img).toHaveAttribute("height", "64");
    expect(img).toHaveClass("size-16", "shrink-0");
  });

  test("null / empty thumbnail url renders the labelled placeholder", () => {
    render(ui({}, { thumbnail: { url: null, alt: "Canvas Tote" } }));
    const placeholder = screen.getByRole("img", { name: "Canvas Tote" });
    expect(placeholder).toHaveAttribute("data-placeholder");
  });

  test("productHref turns the name into a link; empty string keeps plain text", () => {
    const { unmount } = render(ui({}, { productHref: "/products/canvas-tote" }));
    expect(screen.getByRole("link", { name: "Canvas Tote" })).toHaveAttribute("href", "/products/canvas-tote");
    // 44px touch target (D-T82-3).
    expect(screen.getByRole("link", { name: "Canvas Tote" }).className).toContain("min-h-touch");
    unmount();
    render(ui({}, { productHref: "" }));
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Canvas Tote")).toBeInTheDocument();
  });
});

describe("CartLineItem v2: Save for later", () => {
  test("separate native form with hidden productId; accessible name carries the product name", () => {
    const save = recordingSave(savedOk);
    render(ui({}, { saveForLaterAction: save.action }));
    const btn = screen.getByRole("button", { name: "Save for later: Canvas Tote" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("type", "submit");
    const form = btn.closest("form");
    expect(form).not.toBeNull();
    expect(form).not.toBe(screen.getByRole("button", { name: "Remove Canvas Tote" }).closest("form"));
    const hidden = form!.querySelectorAll('input[type="hidden"]');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toHaveAttribute("name", "productId");
    expect(hidden[0]).toHaveAttribute("value", "p1");
  });

  test("posts exactly productId", async () => {
    const save = recordingSave(savedOk);
    render(ui({}, { saveForLaterAction: save.action }));
    fireEvent.click(screen.getByRole("button", { name: "Save for later: Canvas Tote" }));
    await waitFor(() => expect(save.calls).toHaveLength(1));
    expect(save.calls[0]).toEqual({ productId: "p1" });
  });

  test("pending: loading state and a repeat click sends no second request", async () => {
    let count = 0;
    let resolve: (s: CartActionStateV2) => void = () => {};
    const pending: CartActionFnV2 = () => {
      count += 1;
      return new Promise<CartActionStateV2>((r) => {
        resolve = r;
      });
    };
    render(ui({}, { saveForLaterAction: pending }));
    const btn = screen.getByRole("button", { name: /Save for later/ });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 20));
    expect(count).toBe(1);
    await act(async () => resolve(savedOk));
    await waitFor(() => expect(btn).not.toHaveAttribute("aria-busy"));
  });

  test("error is shown inline with role=alert on the line", async () => {
    const save = recordingSave(fail("RATE_LIMITED", "Too many changes. Try again shortly."));
    render(ui({}, { saveForLaterAction: save.action }));
    fireEvent.click(screen.getByRole("button", { name: /Save for later/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many changes. Try again shortly.");
  });

  test("the most recently settled action's error wins: update error, then save error (D-T82-1)", async () => {
    const update: CartActionFn = async () => fail("INSUFFICIENT_STOCK", "Update failed.");
    const save = recordingSave(fail("INTERNAL_ERROR", "Save failed."));
    render(ui({}, { updateQuantity: update, saveForLaterAction: save.action }));
    fireEvent.click(screen.getByRole("button", { name: "Update quantity for Canvas Tote" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Update failed.");
    fireEvent.click(screen.getByRole("button", { name: /Save for later/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Save failed."));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  test("a newer update error replaces an older save error; a later success clears it (D-T82-1)", async () => {
    let updateResult: CartActionState = fail("INSUFFICIENT_STOCK", "Update failed.");
    const update: CartActionFn = async () => updateResult;
    const save = recordingSave(fail("INTERNAL_ERROR", "Save failed."));
    render(ui({}, { updateQuantity: update, saveForLaterAction: save.action }));
    fireEvent.click(screen.getByRole("button", { name: /Save for later/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed.");
    fireEvent.click(screen.getByRole("button", { name: "Update quantity for Canvas Tote" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Update failed."));
    updateResult = ok({ itemCount: 2, subtotalCents: 2500, message: "Updated" });
    fireEvent.click(screen.getByRole("button", { name: "Update quantity for Canvas Tote" }));
    await waitFor(() => expect(screen.getByTestId("line-status")).toHaveTextContent("Updated"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("unavailable line can still be saved for later", () => {
    const save = recordingSave(savedOk);
    render(ui({ status: "unavailable", availableStock: 0 }, { saveForLaterAction: save.action }));
    expect(screen.getByRole("button", { name: "Save for later: Canvas Tote" })).toBeEnabled();
  });

  test("server markup: plain forms with hidden fields, no JS needed", () => {
    const save = recordingSave(savedOk);
    const html = renderToStaticMarkup(ui({}, { saveForLaterAction: save.action, productHref: "/products/canvas-tote" }));
    expect((html.match(/<form/g) ?? []).length).toBe(3);
    expect(html).toContain('type="hidden" name="productId" value="p1"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Save for later/);
    expect(html).toContain('href="/products/canvas-tote"');
  });
});

describe("CartLineItem v2: savings", () => {
  test('"You save" = (list - unit) x quantity, exact', () => {
    render(ui({ quantity: 3, lineTotalCents: 3750 }, { listPriceCents: 1999 }));
    expect(screen.getByTestId("line-savings")).toHaveTextContent(`You save ${formatMoney((1999 - 1250) * 3, "USD")}`);
  });

  test.each([
    ["equal", 1250],
    ["lower (never negative)", 1000],
    ["null", null],
    ["NaN", Number.NaN],
    ["float", 1500.5],
    ["negative", -5],
  ])("no savings text when list price is %s", (_label, list) => {
    render(ui({}, { listPriceCents: list }));
    expect(screen.queryByTestId("line-savings")).toBeNull();
    expect(document.body.textContent).not.toMatch(/You save|NaN|-\$/);
  });

  test("unavailable line shows no savings; reduced line counts only billable units", () => {
    const { unmount } = render(ui({ status: "unavailable", availableStock: 0 }, { listPriceCents: 2000 }));
    expect(screen.queryByTestId("line-savings")).toBeNull();
    unmount();
    render(ui({ status: "reduced", quantity: 5, availableStock: 2, lineTotalCents: 2500 }, { listPriceCents: 1500 }));
    expect(screen.getByTestId("line-savings")).toHaveTextContent("You save $5.00");
  });
});

describe("CartLineItem v2: computed line total", () => {
  test('visible "Line total:" text equals unit x quantity', () => {
    render(ui({ quantity: 3, unitPriceCents: 1999, lineTotalCents: 5997 }, { lineTotal: "computed" }));
    expect(screen.getByTestId("line-total-label")).toHaveTextContent("Line total:");
    expect(screen.getByTestId("line-total")).toHaveTextContent("$59.97");
  });

  test("computed mode ignores an inconsistent lineTotalCents", () => {
    render(ui({ lineTotalCents: 1 }, { lineTotal: "computed" }));
    expect(screen.getByTestId("line-total")).toHaveTextContent("$25.00");
  });

  test("reduced line: total over billable units (matches the service); unavailable: 0", () => {
    const { unmount } = render(
      ui({ status: "reduced", quantity: 5, availableStock: 2, lineTotalCents: 2500 }, { lineTotal: "computed" }),
    );
    expect(screen.getByTestId("line-total")).toHaveTextContent("$25.00");
    unmount();
    render(ui({ status: "unavailable", availableStock: 0, lineTotalCents: 0 }, { lineTotal: "computed" }));
    expect(screen.getByTestId("line-total")).toHaveTextContent("$0.00");
  });

  test("large integers stay exact", () => {
    const unit = 2 ** 52 - 1;
    render(ui({ unitPriceCents: unit, quantity: 2, availableStock: 99, lineTotalCents: 0 }, { lineTotal: "computed" }));
    expect(screen.getByTestId("line-total").textContent).toBe(formatMoney(2 ** 53 - 2, "USD"));
  });

  test("overflowing product falls back to the server lineTotalCents", () => {
    render(
      ui(
        { unitPriceCents: Number.MAX_SAFE_INTEGER, quantity: 2, availableStock: 99, lineTotalCents: 4200 },
        { lineTotal: "computed" },
      ),
    );
    expect(screen.getByTestId("line-total")).toHaveTextContent("$42.00");
  });
});

describe("CartLineItem v2: hostile text", () => {
  test("names render as text, never markup (incl. accessible names)", () => {
    const name = '<img src=x onerror="alert(1)"><b>Bold</b>';
    const save = recordingSave(savedOk);
    const { container } = render(
      ui({ name }, { saveForLaterAction: save.action, productHref: "/products/x", thumbnail: { url: null, alt: name } }),
    );
    expect(container.querySelector("img[src='x'], b")).toBeNull();
    expect(screen.getByRole("link", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Save for later: ${name}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Remove ${name}` })).toBeInTheDocument();
    const html = renderToStaticMarkup(ui({ name }, { saveForLaterAction: save.action }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("CartLineItem v2: layout", () => {
  test("320px: shrinkable rows that wrap", () => {
    const save = recordingSave(savedOk);
    const { container } = render(ui({}, { saveForLaterAction: save.action, thumbnail: { url: null, alt: "x" } }));
    const actions = within(container).getByRole("button", { name: /Save for later/ }).closest("form")!.parentElement!;
    expect(actions).toHaveClass("flex-wrap", "min-w-0");
    expect(container.querySelectorAll(".min-w-0").length).toBeGreaterThan(1);
  });
});

describe("CartLineItem v2 helpers", () => {
  test("billableQuantity", () => {
    expect(billableQuantity({ quantity: 3, availableStock: 5, status: "ok" })).toBe(3);
    expect(billableQuantity({ quantity: 5, availableStock: 2, status: "reduced" })).toBe(2);
    expect(billableQuantity({ quantity: 5, availableStock: 9, status: "unavailable" })).toBe(0);
    expect(billableQuantity({ quantity: 3, availableStock: Number.NaN, status: "reduced" })).toBe(0);
    expect(billableQuantity({ quantity: Number.NaN, availableStock: 4, status: "ok" })).toBe(0);
    expect(billableQuantity({ quantity: -2, availableStock: 4, status: "ok" })).toBe(0);
  });

  test("computeLineTotalCents", () => {
    expect(computeLineTotalCents(1999, 3)).toBe(5997);
    expect(computeLineTotalCents(1, 0)).toBe(0);
    expect(computeLineTotalCents(Number.MAX_SAFE_INTEGER, 2)).toBeNull();
    expect(computeLineTotalCents(12.5, 2)).toBeNull();
    expect(computeLineTotalCents(-1, 2)).toBeNull();
  });

  test("computeLineSavingsCents never negative or zero", () => {
    expect(computeLineSavingsCents(1000, 1500, 2)).toBe(1000);
    expect(computeLineSavingsCents(1500, 1000, 2)).toBeNull();
    expect(computeLineSavingsCents(1000, 1000, 2)).toBeNull();
    expect(computeLineSavingsCents(1000, 1500, 0)).toBeNull();
    expect(computeLineSavingsCents(1000, null, 2)).toBeNull();
    expect(computeLineSavingsCents(1, Number.MAX_SAFE_INTEGER, 3)).toBeNull();
  });
});
