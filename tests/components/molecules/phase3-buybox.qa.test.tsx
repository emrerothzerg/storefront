// QA (T147, Phase 3 wave A): buy-box molecules restyle (T145) against BACKLOG-phase3 T145 AC1-AC5 and
// CONTRACTS P-6 (SavingBadge), P-7 (stock text), P-8 (no-JS POST), P-9 (focus order).
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CartActionFn, CartActionFnV2 } from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import { AddToCartForm } from "@/components/molecules/AddToCartForm";
import { CompareToggle } from "@/components/molecules/CompareToggle";
import { DeliveryEstimate } from "@/components/molecules/DeliveryEstimate";
import { ShareLink } from "@/components/molecules/ShareLink";
import { SavingBadge, StockBadge, savingLabel } from "@/components/molecules/StockBadge";
import { StockUrgency } from "@/components/molecules/StockUrgency";
import { WishlistButton } from "@/components/molecules/WishlistButton";

const noop = async () => null;
const add = noop as CartActionFn;
const buy = noop as CartActionFnV2;
const list = noop as ListActionFn;

function doc(el: ReactElement): Document {
  return new DOMParser().parseFromString(`<body>${renderToStaticMarkup(el)}</body>`, "text/html");
}
const cls = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

let refSeq = 0;
function serverLike<T>(): T {
  const id = ++refSeq;
  const fields = () => ({ name: `$ACTION_REF_${id}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  const mk = (): unknown => Object.assign(async () => null, { $$FORM_ACTION: fields, bind: () => mk() });
  return mk() as T;
}

// ============================================================ SavingBadge (P-6)
describe("T145 SavingBadge + P-6", () => {
  test("1999 vs 2499 -> 'Save $5.00 (20%)' (percent floored); text, not colour only; tag icon decorative", () => {
    expect(savingLabel(1999, 2499, "USD")).toBe("Save $5.00 (20%)");
    const d = doc(<SavingBadge priceCents={1999} listPriceCents={2499} currency="USD" />);
    const badge = d.querySelector("[data-saving-badge]");
    expect(badge?.textContent).toBe("Save $5.00 (20%)");
    expect(cls(badge)).toContain("rounded-full");
    for (const svg of d.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  test("percent floors (2/3 -> 66%), under 1% omits the percent, 100% when free", () => {
    expect(savingLabel(1000, 3000, "USD")).toBe("Save $20.00 (66%)");
    expect(savingLabel(9950, 10000, "USD")).toBe("Save $0.50");
    expect(savingLabel(0, 1000, "USD")).toBe("Save $10.00 (100%)");
  });

  test("no saving -> nothing: list == price, list < price, null, NaN, negative, fractional, invalid currency", () => {
    for (const [p, l, c] of [
      [1000, 1000, "USD"],
      [1000, 999, "USD"],
      [1000, null, "USD"],
      [1000, Number.NaN, "USD"],
      [-1, 2000, "USD"],
      [1000, 2000.5, "USD"],
      [1000, 2000, "NOPE"],
      [1000, 2000, ""],
    ] as const) {
      expect({ p, l: String(l), c, label: savingLabel(p, l, c) }).toEqual({ p, l: String(l), c, label: null });
      expect(renderToStaticMarkup(<SavingBadge priceCents={p} listPriceCents={l} currency={c} />)).toBe("");
    }
  });

  test("JPY (zero-decimal) formats without cents", () => {
    expect(savingLabel(900, 1000, "JPY")).toBe("Save ¥100 (10%)");
  });
});

// ============================================================ stock states (AC2, P-7)
describe("T145 AC2 + P-7: stock conveyed by text + colour + icon", () => {
  const cases: Array<[number, string, string]> = [
    [0, "out", "Out of stock"],
    [1, "low", "Only 1 left"],
    [5, "low", "Only 5 left"],
    [6, "in", "In stock"],
  ];
  for (const [stock, status, text] of cases) {
    test(`StockBadge + StockUrgency stock ${stock}: '${text}' with a tinted role pair and a decorative icon`, () => {
      for (const el of [<StockBadge key="b" stock={stock} />, <StockUrgency key="u" stock={stock} />]) {
        const d = doc(el);
        const root = d.querySelector("[data-stock-status]");
        expect(root?.getAttribute("data-stock-status")).toBe(status);
        expect(root?.textContent).toContain(text);
        const tint = { out: "danger", low: "warning", in: "success" }[status as "out" | "low" | "in"];
        expect(cls(root)).toEqual(expect.arrayContaining([`bg-${tint}-subtle`, `text-${tint}`, "rounded-full"]));
        const svg = root?.querySelector("svg");
        expect(svg?.getAttribute("aria-hidden")).toBe("true");
      }
    });
  }

  test("StockUrgency is not a live region (no spam on re-render)", () => {
    const html = renderToStaticMarkup(<StockUrgency stock={2} />);
    expect(html).not.toMatch(/aria-live|role="(status|alert)"/);
  });
});

// ============================================================ AddToCartForm (AC1, AC3, P-8)
describe("T145 AC1/AC3 + P-8: AddToCartForm behaviour unchanged", () => {
  test("no-JS POST ($$FORM_ACTION): POST multipart; only productId + quantity posted (no price/total, SR9)", () => {
    const d = doc(<AddToCartForm productId="p1" stock={4} addToCart={serverLike<CartActionFn>()} buyNowAction={serverLike<CartActionFnV2>()} variant="buybox" />);
    const form = d.querySelector("form");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form?.getAttribute("action") ?? "").not.toContain("javascript:");
    const names = [...(form?.querySelectorAll("input[name]") ?? [])].map((i) => i.getAttribute("name")).filter((n) => !n?.startsWith("$ACTION"));
    expect(names.sort()).toEqual(["productId", "quantity"]);
    expect(form?.innerHTML).not.toMatch(/name="[^"]*(price|total|cents)/i);
  });

  test("quantity input is labelled and the stepper max is min(stock, 10) (T78 cap; ruling in STATE T145 row)", () => {
    render(<AddToCartForm productId="p1" stock={3} addToCart={add} variant="buybox" />);
    const input = screen.getByRole("textbox", { name: "Quantity" }) as HTMLInputElement;
    const inc = screen.getByRole("button", { name: "Increase quantity" });
    fireEvent.click(inc);
    fireEvent.click(inc);
    expect(input.value).toBe("3");
    expect(inc.hasAttribute("disabled")).toBe(true);
  });

  test("typed quantity above stock is clamped to stock; 0 / negative / text fall back to >= 1", () => {
    render(<AddToCartForm productId="p1" stock={3} addToCart={add} variant="buybox" />);
    const input = screen.getByRole("textbox", { name: "Quantity" }) as HTMLInputElement;
    for (const [typed, want] of [["99", "3"], ["0", "1"], ["-4", "1"]] as const) {
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.blur(input);
      expect({ typed, value: input.value }).toEqual({ typed, value: want });
    }
  });

  for (const stock of [0, -1, Number.NaN]) {
    test(`out of stock (${String(stock)}): no form, one disabled 'Out of stock' pill, no Buy Now`, () => {
      const d = doc(<AddToCartForm productId="p1" stock={stock} addToCart={add} buyNowAction={buy} variant="buybox" />);
      expect(d.querySelector("form")).toBeNull();
      const btns = [...d.querySelectorAll("button")];
      expect(btns.map((b) => b.textContent)).toEqual(["Out of stock"]);
      expect(btns[0]?.hasAttribute("disabled")).toBe(true);
    });
  }

  test("pills: Add = primary filled, Buy Now = outline; both >= 44px", () => {
    render(<AddToCartForm productId="p1" stock={3} addToCart={add} buyNowAction={buy} variant="buybox" />);
    const a = screen.getByRole("button", { name: "Add to cart" });
    const b = screen.getByRole("button", { name: "Buy Now" });
    expect(cls(a)).toEqual(expect.arrayContaining(["rounded-full", "bg-accent", "min-h-touch"]));
    expect(cls(b)).toEqual(expect.arrayContaining(["rounded-full", "border-accent", "text-accent", "min-h-touch"]));
  });
});

// ============================================================ AC4 + P-9: focus order and targets
describe("T145 AC4 + P-9: buy-box focus order and 44px", () => {
  function tabbables(root: ParentNode): HTMLElement[] {
    const sel = "a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), summary";
    return [...root.querySelectorAll<HTMLElement>(sel)].filter(
      (el) => el.getAttribute("tabindex") !== "-1" && (el.tagName === "SUMMARY" || el.closest("details:not([open])") === null),
    );
  }

  test("quantity -> Add to cart -> Buy Now -> Wish List -> compare -> share; no positive tabindex", () => {
    const { container } = render(
      <div>
        <AddToCartForm productId="p1" stock={5} addToCart={add} buyNowAction={buy} variant="buybox" />
        <WishlistButton productId="p1" productSlug="mug" productName="Mug" inList={false} addAction={list} removeAction={list} variant="button" fullWidth />
        <CompareToggle mode="form" productSlug="mug" productName="Mug" selected={[]} basePath="/products/mug" />
        <ShareLink url="/products/mug" title="Mug" />
      </div>,
    );
    const order = tabbables(container).map((el) =>
      el.tagName === "INPUT" && (el as HTMLInputElement).type !== "checkbox"
        ? "quantity"
        : (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    const significant = order.filter((n) => !/^(Decrease|Increase) quantity$/.test(n));
    expect(significant[0]).toBe("quantity");
    expect(significant[1]).toBe("Add to cart");
    expect(significant[2]).toBe("Buy Now");
    expect(significant[3]).toMatch(/Wish List/);
    expect(significant.findIndex((n) => /Compare/.test(n))).toBeGreaterThan(3);
    expect(significant[significant.length - 1]).toMatch(/Share/);
    expect(container.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length).toBe(0);
  });

  test("WishlistButton fullWidth pill and ShareLink pills keep 44px targets", () => {
    const d = doc(
      <>
        <WishlistButton productId="p1" productSlug="mug" productName="Mug" inList={false} addAction={list} removeAction={list} variant="button" fullWidth />
        <ShareLink url="/products/mug" title="Mug" />
      </>,
    );
    const heart = [...d.querySelectorAll("button")].find((b) => /Wish List/.test(b.textContent ?? ""));
    expect(cls(heart)).toEqual(expect.arrayContaining(["w-full", "rounded-full", "min-h-touch"]));
    const email = [...d.querySelectorAll("a")].find((a) => /Email a friend/.test(a.textContent ?? ""));
    expect(cls(email)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch"]));
    expect(email?.getAttribute("href")?.startsWith("mailto:")).toBe(true);
  });
});

// ============================================================ DeliveryEstimate
describe("T145 DeliveryEstimate", () => {
  const est = { start: "2026-11-10T00:00:00.000Z", end: "2026-11-12T00:00:00.000Z" };
  test("renders the range with a decorative truck icon; 'Free' is text in a success pill", () => {
    const d = doc(<DeliveryEstimate estimate={est} methodName="Standard" isFree inStock now={Date.parse("2026-11-08T12:00:00Z")} />);
    expect(d.body.textContent).toMatch(/Nov/);
    const free = [...d.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent?.trim() === "Free");
    expect(cls(free)).toEqual(expect.arrayContaining(["bg-success-subtle", "text-success"]));
    for (const svg of d.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  test("null estimate or out of stock never throws", () => {
    expect(() => renderToStaticMarkup(<DeliveryEstimate estimate={null} inStock />)).not.toThrow();
    expect(() => renderToStaticMarkup(<DeliveryEstimate estimate={{ start: "bad", end: "x" }} inStock={false} />)).not.toThrow();
  });
});

describe("T145 cross-cutting: tokens only, light only", () => {
  test("no arbitrary, dark: or palette classes across the buy-box molecules", () => {
    const d = doc(
      <>
        <AddToCartForm productId="p1" stock={3} addToCart={add} buyNowAction={buy} variant="buybox" />
        <AddToCartForm productId="p1" stock={0} addToCart={add} />
        <SavingBadge priceCents={1999} listPriceCents={2499} currency="USD" />
        <StockBadge stock={2} />
        <StockUrgency stock={0} />
        <WishlistButton productId="p1" productSlug="mug" productName="Mug" inList addAction={list} removeAction={list} variant="button" fullWidth />
        <ShareLink url="/products/mug" title="Mug" />
        <CompareToggle mode="form" productSlug="mug" productName="Mug" selected={["a"]} />
      </>,
    );
    const c = [...d.querySelectorAll("[class]")].flatMap((el) => cls(el));
    expect(c.filter((x) => /\[|^dark:|:dark:/.test(x))).toEqual([]);
    expect(c.filter((x) => /(^|:)(bg|text|border)-(gray|slate|red|blue|green|white|black)(-\d+)?$/.test(x))).toEqual([]);
  });
});
