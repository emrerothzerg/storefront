// T145 (Phase 3): buy-box look for AddToCartForm + buy-box molecule focus order.
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ok } from "@/lib/result";
import type { CartActionFn, CartActionFnV2 } from "../_contracts/cart-actions";
import type { ListActionFn } from "../_contracts/list-actions";
import { CompareToggle } from "../CompareToggle";
import { ShareLink } from "../ShareLink";
import { WishlistButton } from "../WishlistButton";
import { AddToCartForm } from "./AddToCartForm";

const success = ok({ itemCount: 1, subtotalCents: 1999, message: "Added to cart" });
const add: CartActionFn = async () => success;
const buy: CartActionFnV2 = async () => success;
const noopList: ListActionFn = async () => null;

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

let refSeq = 0;
/** Mimics a Next server reference as React SSR sees it (`$$FORM_ACTION`). */
function serverLike<T>(): T {
  const id = ++refSeq;
  const fields = () => ({ name: `$ACTION_REF_${id}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  const make = (): unknown => Object.assign(async () => null, { $$FORM_ACTION: fields, bind: () => make() });
  return make() as T;
}

/** Elements reachable with Tab, in DOM order (none of these molecules use tabindex > 0). */
function tabbables(root: ParentNode): HTMLElement[] {
  const selector = "a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), summary";
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (el) =>
      el.getAttribute("tabindex") !== "-1" &&
      // Content of a closed <details> is not focusable; its <summary> is.
      (el.tagName === "SUMMARY" || el.closest("details:not([open])") === null),
  );
}

function nameOf(el: HTMLElement): string {
  if (el instanceof HTMLInputElement && el.type !== "checkbox") return `input:${el.name}`;
  return (el.getAttribute("aria-label") ?? el.closest("label")?.textContent ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("T145 AddToCartForm look: consistent pills", () => {
  test("Add to cart = primary filled pill, Buy Now = outline pill; both full width and 48px in the buy box", () => {
    render(<AddToCartForm productId="p1" stock={5} addToCart={add} buyNowAction={buy} variant="buybox" />);
    const addBtn = screen.getByRole("button", { name: "Add to cart" });
    const buyBtn = screen.getByRole("button", { name: "Buy Now" });
    expect(addBtn).toHaveClass("rounded-full", "bg-accent", "text-text-on-accent", "w-full", "min-h-12", "min-h-touch");
    expect(buyBtn).toHaveClass("rounded-full", "border-accent", "text-accent", "w-full", "min-h-12", "min-h-touch");
    expect(buyBtn).not.toHaveClass("bg-accent");
  });

  test("quantity stepper is the pill outline atom, aligned to the start (no stretched field)", () => {
    const { container } = render(<AddToCartForm productId="p1" stock={5} addToCart={add} />);
    expect(container.querySelector('[role="group"]')).toHaveClass("rounded-full", "border-border-strong");
    expect(container.querySelector('[role="group"]')?.parentElement).toHaveClass("self-start");
  });
});

describe("T145 behaviour unchanged", () => {
  test("stepper max equals available stock when stock is under the per-order cap; typed values clamp to it", () => {
    const { container } = render(<AddToCartForm productId="p1" stock={3} maxQuantity={10} addToCart={add} />);
    const input = container.querySelector('input[name="quantity"]') as HTMLInputElement;
    const increase = screen.getByRole("button", { name: "Increase quantity" });
    for (let i = 0; i < 6; i++) fireEvent.click(increase);
    expect(input.value).toBe("3");
    expect(increase).toBeDisabled();
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    expect(input.value).toBe("3");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(input.value).toBe("1");
    fireEvent.change(input, { target: { value: "-2" } });
    fireEvent.blur(input);
    expect(input.value).toBe("1");
  });

  test("out of stock (with Buy Now wired): one disabled 'Out of stock' pill, no form, no Buy Now, no quantity", () => {
    const doc = parse(renderToStaticMarkup(<AddToCartForm productId="p1" stock={0} addToCart={add} buyNowAction={buy} variant="buybox" />));
    expect(doc.querySelector("form")).toBeNull();
    expect(doc.querySelector('[name="quantity"]')).toBeNull();
    const buttons = doc.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("Out of stock");
    expect(buttons[0]?.hasAttribute("disabled")).toBe(true);
    expect(buttons[0]?.className).toContain("rounded-full");
  });

  test("no-JS POST shape with server-like actions ($$FORM_ACTION): POST multipart form, Buy Now formaction on the same form", () => {
    const doc = parse(
      renderToStaticMarkup(
        <AddToCartForm productId="p1" stock={4} addToCart={serverLike<CartActionFn>()} buyNowAction={serverLike<CartActionFnV2>()} variant="buybox" />,
      ),
    );
    const form = doc.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form.getAttribute("action") ?? "").not.toContain("javascript:");
    expect((form.querySelector('input[type="hidden"][name="productId"]') as HTMLInputElement).value).toBe("p1");
    expect((form.querySelector('input[name="quantity"]') as HTMLInputElement).value).toBe("1");
    const submits = [...form.querySelectorAll('button[type="submit"]')];
    expect(submits.map((b) => b.textContent?.trim())).toEqual(["Add to cart", "Buy Now"]);
    expect(submits[0]?.hasAttribute("formaction")).toBe(false);
    expect(submits[1]?.getAttribute("formaction") ?? "").not.toContain("javascript:");
    expect(submits[1]?.getAttribute("formmethod")?.toLowerCase()).toBe("post");
    expect(submits[1]?.getAttribute("formenctype")).toBe("multipart/form-data");
    expect(submits[1]?.getAttribute("name") ?? "").toMatch(/^\$ACTION_REF_/);
  });
});

describe("T145 criterion 4: focus order quantity → Add → Buy now → list → compare → share", () => {
  function BuyBoxOrder() {
    return (
      <div>
        <AddToCartForm productId="p1" stock={5} addToCart={add} buyNowAction={buy} variant="buybox" />
        <WishlistButton
          productId="p1"
          productSlug="oak-desk"
          productName="Oak Desk"
          inList={false}
          addAction={noopList}
          removeAction={noopList}
          variant="button"
          fullWidth
        />
        <CompareToggle productSlug="oak-desk" productName="Oak Desk" selected={[]} />
        <ShareLink url="/products/oak-desk" title="Oak Desk" size="sm" />
      </div>
    );
  }

  test("tab sequence follows DOM order and the documented order (static and hydrated)", () => {
    const expected = [
      "input:quantity",
      "Increase quantity",
      "Add to cart",
      "Buy Now",
      "Add Oak Desk to Wish List",
      "Compare Oak Desk",
      "Compare (0): selected products",
      "Share",
    ];
    const staticDoc = parse(renderToStaticMarkup(<BuyBoxOrder />));
    // Static markup: Decrease is disabled at 1, the Copy button is disabled until hydration.
    expect(tabbables(staticDoc.body).map(nameOf)).toEqual(expected);
    const { container } = render(<BuyBoxOrder />);
    expect(tabbables(container).map(nameOf)).toEqual(expected);
  });

  test("no positive tabindex and no visual reordering classes in any buy-box molecule", () => {
    const { container } = render(<BuyBoxOrder />);
    for (const el of container.querySelectorAll("[tabindex]")) {
      expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
    }
    const classes = [...container.querySelectorAll("[class]")].map((el) => el.getAttribute("class") ?? "").join(" ");
    expect(classes).not.toMatch(/(?:^|\s)(?:order-\S+|flex-row-reverse|flex-col-reverse)(?:\s|$)/);
  });

  test("every control in the composition has a 44px class", () => {
    const doc = parse(renderToStaticMarkup(<BuyBoxOrder />));
    for (const el of doc.querySelectorAll("a, button, summary, input:not([type=hidden]), select")) {
      const cls = `${el.getAttribute("class") ?? ""} ${el.closest("label")?.getAttribute("class") ?? ""}`;
      expect([el.tagName, nameOf(el as HTMLElement), /\b(?:min-h-touch|size-touch|min-h-12)\b/.test(cls)]).toEqual([
        el.tagName,
        nameOf(el as HTMLElement),
        true,
      ]);
    }
  });
});
