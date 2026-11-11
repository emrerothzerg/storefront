// QA (QA-W4-organisms-D / T90): T78 BuyBox + AddToCartForm v2 + AddedToCartToast.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/atoms/Toast";
import { AddToCartForm } from "@/components/molecules/AddToCartForm";
import type {
  CartActionFn,
  CartActionFnV2,
  CartActionState,
  CartActionStateV2,
} from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import type { StockAlertActionFn } from "@/components/molecules/_contracts/stock-alert-actions";
import { BUY_BOX_MAX_QUANTITY, BuyBox, type BuyBoxProps } from "@/components/organisms/BuyBox";
import { ADDED_TO_CART_TITLE, AddedToCartToast, type AddedToCartTrigger } from "@/components/organisms/ToastRegion";
import { isAllowedInternalHref } from "@/content/routes";
import { fail, ok } from "@/lib/result";
import { expectFocused } from "@/test/dom-assertions";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; "q" 's' ‮evil`;
const SRC = join(import.meta.dir, "../../../src/components");

type Posted = Record<string, FormDataEntryValue[]>;
function entries(fd: FormData): Posted {
  const out: Posted = {};
  for (const [k, v] of fd.entries()) (out[k] ??= []).push(v);
  return out;
}

const SUCCESS = ok({ itemCount: 1, subtotalCents: 1999, message: "Added to cart" });

function recorder<S extends CartActionState | CartActionStateV2>(result: S | (() => S)) {
  const calls: Posted[] = [];
  const action = async (_prev: S | null, fd: FormData): Promise<S> => {
    calls.push(entries(fd));
    return typeof result === "function" ? (result as () => S)() : result;
  };
  return { action, calls };
}

function deferred<S>() {
  const calls: Posted[] = [];
  const resolvers: ((s: S) => void)[] = [];
  const action = (_prev: S | null, fd: FormData): Promise<S> => {
    calls.push(entries(fd));
    return new Promise<S>((res) => resolvers.push(res));
  };
  return { action, calls, resolve: (s: S) => resolvers.shift()?.(s) };
}

const noopList: ListActionFn = async () => null;
const noopAlert: StockAlertActionFn = async () => null;

function props(over: Partial<BuyBoxProps> = {}, product: Partial<BuyBoxProps["product"]> = {}): BuyBoxProps {
  return {
    product: {
      id: "qa-prod-1",
      slug: "qa-tote",
      name: "QA Tote",
      priceCents: 1999,
      listPriceCents: 2999,
      currency: "USD",
      stock: 42,
      brandName: "QA Brand",
      ...product,
    },
    actions: {
      addToCart: recorder<CartActionState>(SUCCESS).action as CartActionFn,
      buyNow: recorder<CartActionStateV2>(SUCCESS).action as CartActionFnV2,
      addToList: noopList,
      removeFromList: noopList,
      subscribeStockAlert: noopAlert,
      unsubscribeStockAlert: noopAlert,
    },
    viewer: { inWishlist: false, alertRegistered: false },
    delivery: { estimate: { start: "2026-11-10T12:00:00.000Z", end: "2026-11-12T12:00:00.000Z" }, methodName: "Standard" },
    ...over,
  };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function qtyInput(): HTMLInputElement {
  const el = document.querySelector('input[name="quantity"]');
  if (!(el instanceof HTMLInputElement)) throw new Error("no quantity input");
  return el;
}

function clickIncrease(times: number) {
  const inc = screen.getByRole("button", { name: "Increase quantity" });
  for (let i = 0; i < times; i++) fireEvent.click(inc);
}

function maxReached(): number {
  clickIncrease(30);
  return Number(qtyInput().value);
}

// ---------------------------------------------------------------------------
describe("T78.3 static markup: ONE cart form, Add to cart + Buy Now (formaction), contract fields", () => {
  const doc = parse(renderToStaticMarkup(<BuyBox {...props()} />));

  test("exactly one form carries quantity; it has exactly two submit buttons; only Buy Now has formaction", () => {
    const forms = [...doc.querySelectorAll("form")].filter((f) => f.querySelector('[name="quantity"]'));
    expect(forms).toHaveLength(1);
    const form = forms[0] as HTMLFormElement;
    const submits = [...form.querySelectorAll('button[type="submit"]')];
    expect(submits.map((b) => b.textContent?.trim())).toEqual(["Add to cart", "Buy Now"]);
    expect(submits[0]?.hasAttribute("formaction")).toBe(false);
    expect(submits[1]?.hasAttribute("formaction")).toBe(true);
  });

  test("named fields in the cart form are exactly productId (hidden, = product id) and quantity", () => {
    const form = doc.querySelector('form:has([name="quantity"])') as HTMLFormElement;
    const names = [...form.querySelectorAll("[name]")].map((el) => el.getAttribute("name"));
    expect(names.sort()).toEqual(["productId", "quantity"]);
    const hidden = form.querySelector('input[type="hidden"][name="productId"]');
    expect(hidden?.getAttribute("value")).toBe("qa-prod-1");
    expect(form.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
    // No price / session / total fields anywhere in the panel.
    expect(doc.querySelectorAll('[name*="price" i], [name*="session" i], [name*="total" i]')).toHaveLength(0);
  });

  test("no nested forms", () => {
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
  });

  test("BUY_BOX_MAX_QUANTITY is 10", () => {
    expect(BUY_BOX_MAX_QUANTITY).toBe(10);
  });
});

describe("T78.3 quantity max = min(stock, 10)", () => {
  for (const [stock, expected] of [
    [1, 1],
    [3, 3],
    [10, 10],
    [11, 10],
    [9999, 10],
  ] as const) {
    test(`stock ${stock} -> stepper max ${expected}`, () => {
      render(<BuyBox {...props({}, { stock })} />);
      expect(maxReached()).toBe(expected);
      expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    });
  }

  test("stock 1: increase is disabled in the static (no-JS) markup", () => {
    const doc = parse(renderToStaticMarkup(<BuyBox {...props({}, { stock: 1 })} />));
    expect(doc.querySelector('button[aria-label="Increase quantity"]')?.hasAttribute("disabled")).toBe(true);
  });

  test("the quantity actually posted equals the capped value", async () => {
    const add = recorder<CartActionState>(SUCCESS);
    render(<BuyBox {...props({ actions: { ...props().actions, addToCart: add.action as CartActionFn } }, { stock: 50 })} />);
    clickIncrease(30);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(add.calls).toHaveLength(1));
    expect(add.calls[0]).toEqual({ productId: ["qa-prod-1"], quantity: ["10"] });
  });
});

describe("T78.2 out of stock (0, NaN, negative, fractional, Infinity)", () => {
  for (const stock of [0, Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY]) {
    test(`stock ${String(stock)}: no quantity / Add / Buy; StockAlertForm present`, () => {
      const doc = parse(renderToStaticMarkup(<BuyBox {...props({}, { stock })} />));
      expect(doc.querySelector('[name="quantity"]')).toBeNull();
      const buttons = [...doc.querySelectorAll("button")].map((b) => b.textContent ?? "");
      expect(buttons.some((t) => /add to cart/i.test(t))).toBe(false);
      expect(buttons.some((t) => /buy now/i.test(t))).toBe(false);
      expect(doc.querySelector("[formaction]")).toBeNull();
      expect(buttons.some((t) => /notify me/i.test(t))).toBe(true);
      // The alert form posts the product id.
      const alertForm = [...doc.querySelectorAll("form")].find((f) => /notify me/i.test(f.textContent ?? ""));
      expect(alertForm?.querySelector('input[name="productId"]')?.getAttribute("value")).toBe("qa-prod-1");
    });
  }

  test("in stock: no StockAlertForm", () => {
    const html = renderToStaticMarkup(<BuyBox {...props()} />);
    expect(html).not.toMatch(/Notify me/i);
  });
});

describe("T78.4 pending: both buttons loading while either action pends; clicks swallowed", () => {
  test("Add pending -> both aria-busy/aria-disabled; Buy Now and second Add clicks send nothing", async () => {
    const add = deferred<CartActionState>();
    const buy = recorder<CartActionStateV2>(SUCCESS);
    render(
      <BuyBox
        {...props({
          actions: { ...props().actions, addToCart: add.action as CartActionFn, buyNow: buy.action as CartActionFnV2 },
        })}
      />,
    );
    const addBtn = screen.getByRole("button", { name: /add to cart/i });
    const buyBtn = screen.getByRole("button", { name: /buy now/i });
    fireEvent.click(addBtn);
    await waitFor(() => expect(addBtn).toHaveAttribute("aria-busy", "true"));
    expect(buyBtn).toHaveAttribute("aria-busy", "true");
    expect(addBtn).toHaveAttribute("aria-disabled", "true");
    expect(buyBtn).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(buyBtn);
    fireEvent.click(addBtn);
    await new Promise((r) => setTimeout(r, 20));
    expect(add.calls).toHaveLength(1);
    expect(buy.calls).toHaveLength(0);
    await act(async () => add.resolve(SUCCESS));
    await waitFor(() => expect(addBtn).not.toHaveAttribute("aria-busy"));
    expect(buyBtn).not.toHaveAttribute("aria-busy");
  });

  test("Buy Now pending -> both busy; Add click swallowed", async () => {
    const add = recorder<CartActionState>(SUCCESS);
    const buy = deferred<CartActionStateV2>();
    render(
      <BuyBox
        {...props({
          actions: { ...props().actions, addToCart: add.action as CartActionFn, buyNow: buy.action as CartActionFnV2 },
        })}
      />,
    );
    const addBtn = screen.getByRole("button", { name: /add to cart/i });
    const buyBtn = screen.getByRole("button", { name: /buy now/i });
    fireEvent.click(buyBtn);
    await waitFor(() => expect(buyBtn).toHaveAttribute("aria-busy", "true"));
    expect(addBtn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(addBtn);
    await new Promise((r) => setTimeout(r, 20));
    expect(add.calls).toHaveLength(0);
    expect(buy.calls).toEqual([{ productId: ["qa-prod-1"], quantity: ["1"] }]);
    await act(async () => buy.resolve(fail("INTERNAL_ERROR", "Something went wrong.")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
  });
});

describe("T78.5 only the last-finished action's message shows", () => {
  function setup(addResults: CartActionState[], buyResults: CartActionStateV2[]) {
    let ai = 0;
    let bi = 0;
    const add = recorder<CartActionState>(() => addResults[Math.min(ai++, addResults.length - 1)] ?? null);
    const buy = recorder<CartActionStateV2>(() => buyResults[Math.min(bi++, buyResults.length - 1)] ?? null);
    const utils = render(
      <AddToCartForm
        productId="qa-prod-1"
        stock={5}
        addToCart={add.action as CartActionFn}
        buyNowAction={buy.action as CartActionFnV2}
      />,
    );
    const live = utils.container.querySelector('p[aria-live="polite"]:not(.sr-only)') as HTMLElement;
    return { ...utils, add, buy, live };
  }

  test("Add success then Buy error: alert only, success message cleared", async () => {
    const { live } = setup([SUCCESS], [fail("OUT_OF_STOCK", "Buy failed.")]);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(live).toHaveTextContent("Added to cart"));
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Buy failed.");
    expect(live).toBeEmptyDOMElement();
  });

  test("Buy error then Add success: success only, alert removed", async () => {
    const { live } = setup([SUCCESS], [fail("OUT_OF_STOCK", "Buy failed.")]);
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Buy failed.");
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(live).toHaveTextContent("Added to cart"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("Add error, Buy error, Add error (same object each time): latest add error shown, once", async () => {
    const addErr = fail("INTERNAL_ERROR", "Add failed.");
    const { live } = setup([addErr], [fail("INTERNAL_ERROR", "Buy failed.")]);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add failed.");
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Buy failed."));
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Add failed."));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(live).toBeEmptyDOMElement();
  });
});

describe("T78.5 stock reduced mid-session: 'Available now: N.' and stepper max drops", () => {
  for (const code of ["STOCK_CHANGED", "INSUFFICIENT_STOCK"] as const) {
    test(`${code} with details.available 2 (page stock 8)`, async () => {
      const add = recorder<CartActionState>(fail(code, "Stock changed.", { available: 2 }));
      render(<AddToCartForm productId="p" stock={8} addToCart={add.action as CartActionFn} />);
      clickIncrease(5);
      expect(qtyInput().value).toBe("6");
      fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Stock changed. Available now: 2.");
      // Clamped value and new max.
      await waitFor(() => expect(qtyInput().value).toBe("2"));
      expect(maxReached()).toBe(2);
    });
  }

  test("from Buy Now too (BuyBox)", async () => {
    const buy = recorder<CartActionStateV2>(fail("STOCK_CHANGED", "Only 3 left.", { available: 3 }));
    render(<BuyBox {...props({ actions: { ...props().actions, buyNow: buy.action as CartActionFnV2 } }, { stock: 9 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 3 left. Available now: 3.");
    expect(maxReached()).toBe(3);
  });

  for (const available of ["2", -1, 1.5, Number.NaN, null]) {
    test(`invalid details.available ${String(available)} -> no 'Available now', max unchanged`, async () => {
      const add = recorder<CartActionState>(fail("STOCK_CHANGED", "Stock changed.", { available }));
      render(<AddToCartForm productId="p" stock={4} addToCart={add.action as CartActionFn} />);
      fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("Stock changed.");
      expect(maxReached()).toBe(4);
    });
  }

  test("available on a non-stock error code is ignored", async () => {
    const add = recorder<CartActionState>(fail("INTERNAL_ERROR", "Oops.", { available: 1 }));
    render(<AddToCartForm productId="p" stock={4} addToCart={add.action as CartActionFn} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Oops.");
    expect(maxReached()).toBe(4);
  });

  test("hostile error message renders as text", async () => {
    const add = recorder<CartActionState>(fail("STOCK_CHANGED", HOSTILE, { available: 1 }));
    const { container } = render(<AddToCartForm productId="p" stock={4} addToCart={add.action as CartActionFn} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`${HOSTILE} Available now: 1.`);
    expect(container.querySelector("img, script")).toBeNull();
  });
});

describe("T78.4 onSuccess fires once per success", () => {
  test("same state object returned twice -> two calls; errors -> no call; initial render -> no call", async () => {
    const seq: CartActionState[] = [SUCCESS, fail("INTERNAL_ERROR", "x"), SUCCESS];
    let i = 0;
    const add = recorder<CartActionState>(() => seq[i++] ?? SUCCESS);
    const calls: unknown[] = [];
    render(
      <AddToCartForm productId="p" stock={5} addToCart={add.action as CartActionFn} onSuccess={(s) => calls.push(s)} />,
    );
    expect(calls).toHaveLength(0);
    const btn = screen.getByRole("button", { name: "Add to cart" });
    fireEvent.click(btn);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(btn);
    await screen.findByRole("alert");
    expect(calls).toHaveLength(1);
    fireEvent.click(btn);
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(btn);
    await waitFor(() => expect(add.calls).toHaveLength(4));
    await waitFor(() => expect(calls).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c).toBe(SUCCESS);
  });

  test("re-render with a new onSuccess identity does not re-fire", async () => {
    const add = recorder<CartActionState>(SUCCESS);
    const calls: number[] = [];
    function Host() {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setN((x) => x + 1)}>
            bump
          </button>
          <AddToCartForm productId="p" stock={5} addToCart={add.action as CartActionFn} onSuccess={() => calls.push(n)} />
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "bump" }));
    fireEvent.click(screen.getByRole("button", { name: "bump" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
  });

  test("Buy Now success also fires onSuccess once", async () => {
    const add = recorder<CartActionState>(SUCCESS);
    const buy = recorder<CartActionStateV2>(SUCCESS);
    const calls: unknown[] = [];
    render(
      <AddToCartForm
        productId="p"
        stock={5}
        addToCart={add.action as CartActionFn}
        buyNowAction={buy.action as CartActionFnV2}
        onSuccess={(s) => calls.push(s)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
  });
});

describe("T78.4 AddedToCartToast", () => {
  function Harness({ trigger }: { trigger: AddedToCartTrigger | null }) {
    return (
      <ToastProvider maxVisible={50}>
        <button type="button">Elsewhere</button>
        <AddedToCartToast trigger={trigger} navigate={() => {}} />
      </ToastProvider>
    );
  }
  const count = () => screen.queryAllByText(ADDED_TO_CART_TITLE).length;

  test("one toast() per count increment (1,1,2,2,3 -> 3), none for 0/null", async () => {
    const { rerender } = render(<Harness trigger={null} />);
    rerender(<Harness trigger={{ count: 0 }} />);
    expect(count()).toBe(0);
    for (const n of [1, 1, 2, 2, 3]) rerender(<Harness trigger={{ count: n, description: "QA Tote" }} />);
    await waitFor(() => expect(count()).toBe(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(count()).toBe(3);
  });

  test("a jump (1 -> 5) is one toast; unsafe integers and non-finite counts never toast", async () => {
    const { rerender } = render(<Harness trigger={{ count: 1 }} />);
    await waitFor(() => expect(count()).toBe(1));
    rerender(<Harness trigger={{ count: 5 }} />);
    await waitFor(() => expect(count()).toBe(2));
    for (const n of [Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN, 6.5, -1]) {
      rerender(<Harness trigger={{ count: n }} />);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(count()).toBe(2);
  });

  test("never throws without a provider (mount + increments + unmount)", () => {
    const { rerender, unmount, container } = render(<AddedToCartToast trigger={null} />);
    expect(() => {
      rerender(<AddedToCartToast trigger={{ count: 1 }} />);
      rerender(<AddedToCartToast trigger={{ count: 2, description: HOSTILE }} />);
      unmount();
    }).not.toThrow();
    expect(container.innerHTML).toBe("");
  });

  test("does not move focus; toast is polite (not role=alert) and hostile description is text", async () => {
    const { rerender } = render(<Harness trigger={null} />);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(<Harness trigger={{ count: 1, description: HOSTILE }} />);
    const title = await screen.findByText(ADDED_TO_CART_TITLE);
    expectFocused(elsewhere);
    expect(title.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByText(HOSTILE)).toBeInTheDocument();
    expect(document.querySelector("img[src=x], script")).toBeNull();
  });

  test("BuyBox: two successful adds -> two toasts; error -> none; focus stays on the Add button", async () => {
    const seq: CartActionState[] = [SUCCESS, fail("INTERNAL_ERROR", "nope"), SUCCESS];
    let i = 0;
    const add = recorder<CartActionState>(() => seq[i++] ?? SUCCESS);
    render(
      <ToastProvider maxVisible={50}>
        <BuyBox {...props({ actions: { ...props().actions, addToCart: add.action as CartActionFn } })} />
      </ToastProvider>,
    );
    const btn = screen.getByRole("button", { name: "Add to cart" });
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(count()).toBe(1));
    fireEvent.click(btn);
    expect(await screen.findByText("nope")).toHaveAttribute("role", "alert");
    await waitFor(() => expect(add.calls).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(count()).toBe(1);
    fireEvent.click(btn);
    await waitFor(() => expect(count()).toBe(2));
    expectFocused(btn);
  });
});

describe("T78.6 optional parts render only when supplied", () => {
  const has = (html: string) => ({
    share: /data-icon="share"/.test(html),
    compare: /action="\/compare"/.test(html),
    wishlist: /to Wish List/.test(html),
  });

  test("no shareUrl / compare -> neither; wishlist (required actions) always", () => {
    expect(has(renderToStaticMarkup(<BuyBox {...props()} />))).toEqual({ share: false, compare: false, wishlist: true });
  });

  for (const shareUrl of ["", "   ", "\t\n", null, undefined]) {
    test(`shareUrl ${JSON.stringify(shareUrl)} -> no Share`, () => {
      expect(has(renderToStaticMarkup(<BuyBox {...props({ shareUrl })} />)).share).toBe(false);
    });
  }

  test("shareUrl + compare supplied -> both rendered", () => {
    const h = has(renderToStaticMarkup(<BuyBox {...props({ shareUrl: "/products/qa-tote", compare: { selected: [] } })} />));
    expect(h).toEqual({ share: true, compare: true, wishlist: true });
  });

  test("compare null -> no compare form", () => {
    expect(has(renderToStaticMarkup(<BuyBox {...props({ compare: null })} />)).compare).toBe(false);
  });
});

describe("T78 trust lines, heading, hostile text, hrefs, 320px", () => {
  test("trust lines are plain text list items; icons aria-hidden", () => {
    const doc = parse(renderToStaticMarkup(<BuyBox {...props({ sellerName: HOSTILE })} />));
    const lis = [...doc.querySelectorAll("section > ul:last-of-type > li")];
    expect(lis.map((li) => li.textContent)).toEqual([
      "Secure transaction",
      "Free returns within 30 days (sample policy)",
      `Ships from ${HOSTILE}`,
    ]);
    for (const li of lis) {
      expect(li.querySelector("a, button")).toBeNull();
      expect(li.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("section aria-labelledby -> visually hidden 'Buying options' heading (h2 default, h3 on request)", () => {
    for (const [level, tag] of [
      [undefined, "H2"],
      [3, "H3"],
    ] as const) {
      const doc = parse(renderToStaticMarkup(<BuyBox {...props({ headingLevel: level })} />));
      const section = doc.querySelector("section[aria-labelledby]") as HTMLElement;
      const heading = doc.getElementById(section.getAttribute("aria-labelledby") ?? "");
      expect(heading?.tagName).toBe(tag);
      expect(heading?.textContent).toBe("Buying options");
      expect(heading?.className).toContain("sr-only");
      expect(section.contains(heading)).toBe(true);
    }
  });

  test("hostile product / brand names are text only (no injected elements); slug cannot break the id", () => {
    const html = renderToStaticMarkup(
      <BuyBox
        {...props({ shareUrl: "/products/x", compare: { selected: [] } }, { name: HOSTILE, brandName: HOSTILE, slug: `"><svg onload=1>` })}
      />,
    );
    const doc = parse(html);
    expect(doc.querySelector("img[src=x]")).toBeNull();
    expect(doc.querySelectorAll("script")).toHaveLength(1); // React's own form-replay bootstrap only
    expect(doc.querySelector("script")?.textContent).not.toContain("alert(2)");
    expect(doc.body.textContent).toContain(HOSTILE);
    const id = doc.querySelector("section")?.getAttribute("aria-labelledby") ?? "";
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  test("every internal href passes isAllowedInternalHref (mailto share links excluded)", () => {
    const doc = parse(
      renderToStaticMarkup(<BuyBox {...props({ shareUrl: "/products/qa-tote", compare: { selected: ["a"] } })} />),
    );
    const hrefs = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    for (const h of hrefs.filter((x) => !x.startsWith("mailto:"))) expect(isAllowedInternalHref(h)).toBe(true);
    for (const f of doc.querySelectorAll("form[action]")) {
      const action = f.getAttribute("action") ?? "";
      if (!action.startsWith("javascript:")) expect(isAllowedInternalHref(action)).toBe(true);
    }
  });

  test("320px: panel shrinks, buttons full width, no fixed widths / inline styles in BuyBox or AddToCartForm sources", () => {
    const html = renderToStaticMarkup(<BuyBox {...props()} />);
    const doc = parse(html);
    expect(doc.querySelector("section")?.className).toContain("min-w-0");
    for (const b of doc.querySelectorAll('form:has([name="quantity"]) button[type="submit"]')) {
      expect(b.className).toContain("w-full");
    }
    for (const file of [
      "organisms/BuyBox/BuyBox.tsx",
      "organisms/BuyBox/BuyBoxPurchase.tsx",
      "organisms/ToastRegion/AddedToCartToast.tsx",
      "molecules/AddToCartForm/AddToCartForm.tsx",
    ]) {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src).not.toMatch(/\bstyle=\{/);
      expect(src).not.toMatch(/(?<![a-z]:)\b(?:w|min-w)-(?:\d{2,}|\[)/);
    }
  });
});

describe("MVP AddToCartForm contract still holds (T78.1 spot checks)", () => {
  test("without buyNowAction: one submit button, no formaction; stock <= 0 -> disabled 'Out of stock' only", () => {
    const add = recorder<CartActionState>(SUCCESS).action as CartActionFn;
    const doc = parse(renderToStaticMarkup(<AddToCartForm productId="p" stock={3} addToCart={add} />));
    expect(doc.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(doc.querySelector("[formaction]")).toBeNull();
    const oos = parse(renderToStaticMarkup(<AddToCartForm productId="p" stock={0} addToCart={add} />));
    expect(oos.querySelector("form")).toBeNull();
    expect(oos.querySelector("button")?.textContent).toBe("Out of stock");
    expect(oos.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });

  test("invalid maxQuantity (0, NaN, 2.5) falls back to 10", () => {
    for (const maxQuantity of [0, Number.NaN, 2.5]) {
      const add = recorder<CartActionState>(SUCCESS).action as CartActionFn;
      const { unmount } = render(<AddToCartForm productId="p" stock={50} maxQuantity={maxQuantity} addToCart={add} />);
      expect(maxReached()).toBe(10);
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Resume rulings: real <form action> posting without JS ($$FORM_ACTION fixture), 44px targets, a11y basics.
let refSeq = 0;
/** Mimics a Next server reference as React SSR sees it (`$$FORM_ACTION`, kept across `.bind`). */
function serverLike<T>(): T {
  const id = ++refSeq;
  const fields = () => ({ name: `$ACTION_REF_${id}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  const make = (): unknown => Object.assign(async () => null, { $$FORM_ACTION: fields, bind: () => make() });
  return make() as T;
}
function serverActions(): BuyBoxProps["actions"] {
  return {
    addToCart: serverLike<CartActionFn>(),
    buyNow: serverLike<CartActionFnV2>(),
    addToList: serverLike<ListActionFn>(),
    removeFromList: serverLike<ListActionFn>(),
    subscribeStockAlert: serverLike<StockAlertActionFn>(),
    unsubscribeStockAlert: serverLike<StockAlertActionFn>(),
  };
}
const TOUCH = /\b(?:min-h-touch|size-touch|min-h-12)\b/;

describe("Resume: no-JS POST shape with server-like actions (SR2)", () => {
  const variants: [string, Partial<BuyBoxProps>, Partial<BuyBoxProps["product"]>][] = [
    ["in stock", {}, {}],
    ["out of stock, not registered", {}, { stock: 0 }],
    ["out of stock, registered + in wish list", { viewer: { inWishlist: true, wishlistId: "list-1", alertRegistered: true, alertId: "alert-1" } }, { stock: 0 }],
  ];
  for (const [label, over, prod] of variants) {
    test(`${label}: every mutation form is method=POST, multipart, no javascript: action`, () => {
      const doc = parse(renderToStaticMarkup(<BuyBox {...props({ ...over, actions: serverActions(), compare: { selected: [] } }, prod)} />));
      const forms = [...doc.querySelectorAll("form")].filter((f) => f.getAttribute("method")?.toLowerCase() !== "get");
      expect(forms.length).toBeGreaterThanOrEqual(2);
      for (const f of forms) {
        expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
        expect(f.getAttribute("enctype")).toBe("multipart/form-data");
        expect(f.getAttribute("action") ?? "").not.toContain("javascript:");
      }
      // The compare form is the only GET form (it navigates, it does not mutate).
      for (const g of doc.querySelectorAll('form[method="get"]')) expect(g.getAttribute("action")).toBe("/compare");
    });
  }

  test("Buy Now button carries its own formaction/formmethod/formenctype (posts the same form to buyNow)", () => {
    const doc = parse(renderToStaticMarkup(<BuyBox {...props({ actions: serverActions() })} />));
    const buy = [...doc.querySelectorAll("button")].find((b) => b.textContent === "Buy Now") as HTMLButtonElement;
    expect(buy.getAttribute("formaction") ?? "").not.toContain("javascript:");
    expect(buy.getAttribute("formmethod")?.toLowerCase()).toBe("post");
    expect(buy.getAttribute("formenctype")).toBe("multipart/form-data");
    expect(buy.getAttribute("name") ?? "").toMatch(/^\$ACTION_REF_/);
    expect(buy.closest("form")?.querySelector('input[name="quantity"]')).not.toBeNull();
  });

  test("actions passed unwrapped: `.bind(null, null)` server actions keep the POST shape", () => {
    const bound = serverLike<CartActionFn>().bind(null, null) as unknown as CartActionFn;
    const doc = parse(renderToStaticMarkup(<BuyBox {...props({ actions: { ...serverActions(), addToCart: bound } })} />));
    const form = doc.querySelector('form:has([name="quantity"])') as HTMLFormElement;
    expect(form.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form.getAttribute("action") ?? "").not.toContain("javascript:");
  });
});

describe("Resume: 44px targets, labels, unique names, no ids/tokens", () => {
  test("every interactive element has a 44px class (min-h-touch / size-touch / lg button)", () => {
    for (const stock of [5, 0]) {
      const doc = parse(
        renderToStaticMarkup(<BuyBox {...props({ shareUrl: "/products/qa-tote", compare: { selected: [] } }, { stock })} />),
      );
      for (const el of doc.querySelectorAll("a, button, summary, input:not([type=hidden]), select, textarea")) {
        const cls = `${el.getAttribute("class") ?? ""} ${el.closest("label")?.getAttribute("class") ?? ""}`;
        expect([el.tagName, el.textContent?.slice(0, 20), TOUCH.test(cls)]).toEqual([el.tagName, el.textContent?.slice(0, 20), true]);
      }
    }
  });

  test("quantity input labelled; buttons have accessible names; ids unique", () => {
    const doc = parse(renderToStaticMarkup(<BuyBox {...props({ compare: { selected: [] } })} />));
    const q = doc.querySelector('input[name="quantity"]') as HTMLInputElement;
    expect(doc.querySelector(`label[for="${q.id}"]`)?.textContent).toBe("Quantity");
    for (const b of doc.querySelectorAll("button")) expect((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()).not.toBe("");
    const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no session ids / owner keys / UUIDs in the markup (product id is not a UUID here)", () => {
    const html = renderToStaticMarkup(<BuyBox {...props({ actions: serverActions(), shareUrl: "/products/x" })} />);
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(html).not.toMatch(/sessionId|ownerKey|owner_key|sf_session|sf_auth/i);
  });
});
