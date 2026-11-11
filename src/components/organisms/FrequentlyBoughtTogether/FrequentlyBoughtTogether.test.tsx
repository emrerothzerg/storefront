import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CartActionFnV2,
  CartActionStateV2,
} from "@/components/molecules/_contracts/cart-actions";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import type { Bundle } from "@/server/recommendations/recommendation-service";
import {
  FrequentlyBoughtTogether,
  bundleItems,
  describePerItem,
  totalCentsOf,
} from "./FrequentlyBoughtTogether";

function makeProduct(n: number, overrides: Partial<Product> = {}): Product {
  return {
    id: `p${n}`,
    slug: `product-${n}`,
    name: `Product ${n}`,
    description: "",
    priceCents: 1000,
    currency: "USD",
    imageUrl: `/images/p${n}.jpg`,
    stock: 10,
    ...overrides,
  };
}

// Amounts chosen so float dollars would drift: 19.99 + 0.01 + 1234.57.
const A = makeProduct(1, { name: "Alpha", priceCents: 1999 });
const B = makeProduct(2, { name: "Bravo", priceCents: 1 });
const C = makeProduct(3, { name: "Charlie", priceCents: 123457 });
const bundle3: Bundle = { items: [A, B, C], totalCents: 125457 };

function successWith(perItem: { productId: string; result: "added" | "out_of_stock" | "capped" | "unavailable" }[]): CartActionStateV2 {
  return {
    ok: true,
    value: { itemCount: 2, subtotalCents: 2000, message: "Cart updated.", kind: "added_many", perItem },
  };
}

const noop: CartActionFnV2 = async () => null;

function boxes(): HTMLInputElement[] {
  return screen.getAllByRole("checkbox") as HTMLInputElement[];
}

function totalText(): string {
  const p = screen.getByText(/^Total for|^Select at least/).closest("p");
  return p?.textContent ?? "";
}

describe("FBT: renders nothing below two items", () => {
  test("0 or 1 item, or duplicates collapsing to 1, render nothing", () => {
    for (const items of [[], [A], [A, A]]) {
      const { container, unmount } = render(
        <FrequentlyBoughtTogether bundle={{ items, totalCents: 0 }} action={noop} />,
      );
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });
});

describe("FBT: static markup (no JS, criterion 3)", () => {
  test("all checkboxes checked, static total equals bundle.totalCents, one plain form", () => {
    const html = renderToStaticMarkup(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    expect((html.match(/<form/g) ?? []).length).toBe(1);
    const inputs = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(3);
    inputs.forEach((i) => {
      expect(i).toContain('checked=""');
      expect(i).toContain('name="productId"');
      expect(i).not.toMatch(/ disabled=/);
    });
    expect(html).toContain('value="p1"');
    expect(html).toContain('value="p2"');
    expect(html).toContain('value="p3"');
    expect(html).toContain("Total for 3 items: ");
    expect(html).toContain("$1,254.57");
    expect(totalCentsOf(bundle3.items)).toBe(bundle3.totalCents);
    // No hidden duplicate id when nothing is locked.
    expect(html).not.toContain('type="hidden"');
    expect(html).toContain("Add selected to cart");
  });
});

describe("FBT: structure", () => {
  test("section labelled by heading; level prop; images joined by plus icons", () => {
    const { container, rerender } = render(
      <FrequentlyBoughtTogether bundle={bundle3} action={noop} />,
    );
    const section = screen.getByRole("region", { name: "Frequently bought together" });
    const heading = screen.getByRole("heading", { level: 2, name: "Frequently bought together" });
    expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
    // 2 plus icons between 3 images, decorative.
    const plus = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(plus.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("img", { name: "Alpha" })).toBeInTheDocument();

    rerender(<FrequentlyBoughtTogether bundle={bundle3} action={noop} headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
  });

  test("labels read '<name> — <price>' and the main item is marked", () => {
    render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    expect(screen.getByRole("checkbox", { name: "This item: Alpha — $19.99" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Bravo — $0.01" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Charlie — $1,234.57" })).toBeChecked();
  });

  test("image links point to product pages and are allowed internal hrefs", () => {
    render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/products/product-1",
      "/products/product-2",
      "/products/product-3",
    ]);
    links.forEach((l) => expect(isAllowedInternalHref(l.getAttribute("href") ?? "")).toBe(true));
  });

  test("two instances have unique aria-labelledby ids (criterion 5)", () => {
    render(
      <>
        <FrequentlyBoughtTogether bundle={bundle3} action={noop} />
        <FrequentlyBoughtTogether bundle={bundle3} action={noop} />
      </>,
    );
    const ids = Array.from(document.querySelectorAll("section"), (s) =>
      s.getAttribute("aria-labelledby"),
    );
    expect(new Set(ids).size).toBe(2);
    ids.forEach((id) => expect(document.getElementById(id ?? "")).not.toBeNull());
  });
});

describe("FBT: live total (criterion 3)", () => {
  test("unchecking recomputes the exact integer total", () => {
    render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    expect(totalText()).toBe("Total for 3 items: $1,254.57");
    const [, b, c] = boxes();
    fireEvent.click(c as HTMLInputElement);
    expect(totalText()).toBe("Total for 2 items: $20.00");
    fireEvent.click(c as HTMLInputElement);
    fireEvent.click(b as HTMLInputElement);
    expect(totalText()).toBe("Total for 2 items: $1,254.56");
    // Float math would give 1254.5700000000002 for 19.99 + 0.01 + 1234.57.
    fireEvent.click(b as HTMLInputElement);
    expect(totalText()).toBe("Total for 3 items: $1,254.57");
  });

  test("the total region is a polite live region", () => {
    render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const p = screen.getByText(/^Total for/).closest("p");
    expect(p).toHaveAttribute("aria-live", "polite");
    expect(p).toHaveAttribute("aria-atomic", "true");
  });

  test("main unchecked then all others unchecked: zero selected disables submit", () => {
    render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const [a, b, c] = boxes() as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    fireEvent.click(a);
    expect(a).not.toBeChecked();
    expect(totalText()).toBe("Total for 2 items: $1,234.58");
    fireEvent.click(b);
    fireEvent.click(c);
    expect(totalText()).toBe("Select at least one item.");
    expect(screen.getByRole("button", { name: "Add selected to cart" })).toBeDisabled();
  });
});

describe("FBT: main item lock (criterion 4)", () => {
  test("main checkbox becomes disabled when it is the last checked, and still posts via hidden input", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const [a, b, c] = boxes() as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    fireEvent.click(b);
    expect(a).not.toBeDisabled();
    fireEvent.click(c);
    expect(a).toBeDisabled();
    expect(a).toBeChecked();
    expect(totalText()).toBe("Total for 1 item: $19.99");
    expect(screen.getByText("Stays selected while it is the only item selected.")).toBeInTheDocument();

    const form = container.querySelector("form") as HTMLFormElement;
    expect(new FormData(form).getAll("productId")).toEqual(["p1"]);
    expect(screen.getByRole("button", { name: "Add selected to cart" })).not.toBeDisabled();

    // Clicking the disabled box changes nothing; re-checking another unlocks it.
    fireEvent.click(a);
    expect(a).toBeChecked();
    fireEvent.click(b);
    expect(a).not.toBeDisabled();
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
  });

  test("the form posts only checked ids as repeated productId fields", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const form = container.querySelector("form") as HTMLFormElement;
    expect(new FormData(form).getAll("productId")).toEqual(["p1", "p2", "p3"]);
    fireEvent.click(boxes()[1] as HTMLInputElement);
    expect(new FormData(form).getAll("productId")).toEqual(["p1", "p3"]);
  });
});

describe("FBT: submit and results", () => {
  test("submits the checked ids; mixed perItem results render as text in a polite region", async () => {
    let posted: string[] = [];
    let release: () => void = () => {};
    const action = mock<CartActionFnV2>(async (_prev, fd) => {
      posted = fd.getAll("productId").map(String);
      await new Promise<void>((r) => {
        release = r;
      });
      return successWith([
        { productId: "p1", result: "added" },
        { productId: "p2", result: "added" },
        { productId: "p3", result: "out_of_stock" },
      ]);
    });
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Add selected to cart" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Adding…/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Adding…/ })).toHaveAttribute("aria-busy", "true");
    await act(async () => release());
    const msg = await screen.findByText("Added: Alpha, Bravo. Out of stock: Charlie.");
    expect(msg).toHaveAttribute("aria-live", "polite");
    expect(posted).toEqual(["p1", "p2", "p3"]);
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("after a successful post the checkboxes and the total stay in sync", async () => {
    const action: CartActionFnV2 = async () => successWith([{ productId: "p1", result: "added" }]);
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    const [, b, c] = boxes() as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    fireEvent.click(c);
    fireEvent.click(b);
    fireEvent.click(screen.getByRole("button", { name: "Add selected to cart" }));
    await screen.findByText("Added: Alpha.");
    const checked = boxes().filter((x) => x.checked).length;
    expect(totalText()).toContain(`Total for ${checked} item`);
  });

  test("error result renders in role=alert", async () => {
    const action: CartActionFnV2 = async () => ({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Choose at least one item." },
    });
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Add selected to cart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose at least one item.");
  });

  test("success without perItem falls back to the server message", async () => {
    const action: CartActionFnV2 = async () => ({
      ok: true,
      value: { itemCount: 0, subtotalCents: 0, message: "Nothing to add." },
    });
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Add selected to cart" }));
    expect(await screen.findByText("Nothing to add.")).toBeInTheDocument();
  });
});

describe("FBT: helpers", () => {
  test("describePerItem groups every outcome in a fixed order", () => {
    expect(
      describePerItem(
        [
          { productId: "p3", result: "unavailable" },
          { productId: "p1", result: "capped" },
          { productId: "p2", result: "out_of_stock" },
          { productId: "zz", result: "added" },
        ],
        [A, B, C],
      ),
    ).toBe(
      "Added: another item. Out of stock: Bravo. Already at the cart limit: Alpha. Unavailable: Charlie.",
    );
    expect(describePerItem([], [A])).toBe("");
  });

  test("bundleItems dedupes and caps at ADD_MANY_MAX_ITEMS", () => {
    const many = Array.from({ length: 14 }, (_, i) => makeProduct(i + 1));
    expect(bundleItems({ items: [...many, many[0] as Product], totalCents: 0 })).toHaveLength(10);
    expect(bundleItems({ items: [A, A, B], totalCents: 0 }).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  test("totalCentsOf rejects invalid prices instead of producing a float", () => {
    expect(totalCentsOf([A, makeProduct(9, { priceCents: 1.5 })])).toBeNull();
    expect(totalCentsOf([A, B, C])).toBe(125457);
  });

  test("an invalid price shows 'Total unavailable.' rather than a wrong number", () => {
    render(
      <FrequentlyBoughtTogether
        bundle={{ items: [A, makeProduct(9, { priceCents: Number.NaN })], totalCents: 0 }}
        action={noop}
      />,
    );
    expect(screen.getByText("Total unavailable.")).toBeInTheDocument();
  });
});

describe("FBT: hostile text and tokens", () => {
  test("hostile names render as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <FrequentlyBoughtTogether
        bundle={{ items: [makeProduct(1, { name: evil }), B], totalCents: 1001 }}
        action={noop}
      />,
    );
    expect(container.querySelector("img[onerror]")).toBeNull();
    const form = container.querySelector("form") as HTMLFormElement;
    expect(within(form).getAllByRole("checkbox")[0]?.closest("label")).toHaveTextContent(evil);
  });

  test("source: tokens only, no inline style, no raw HTML, no effects", () => {
    const src = readFileSync(join(import.meta.dir, "FrequentlyBoughtTogether.tsx"), "utf8");
    expect(src).not.toMatch(/-\[[^\]]+\]/);
    expect(src).not.toMatch(/style=\{/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/useEffect/);
  });

  test("320px: thumbnails are small below sm and the image row wraps", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const img = screen.getByRole("img", { name: "Alpha" });
    expect(img).toHaveClass("size-16", "sm:size-24");
    expect(container.querySelector(".flex-wrap")).not.toBeNull();
  });
});

describe("FBT: Phase 3 restyle (T160)", () => {
  test("section is a white card; images on bordered tiles; checkboxes on a grey band", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const section = container.querySelector("section");
    expect(section).toHaveClass("bg-surface-raised", "border", "border-border-default", "rounded-lg", "shadow-sm");
    expect(section).toHaveAttribute("aria-labelledby", screen.getByRole("heading", { level: 2 }).id);
    for (const link of within(section as HTMLElement).getAllByRole("link")) {
      expect(link).toHaveClass("rounded-lg", "border", "border-border-default", "bg-surface-raised");
      expect(link.querySelector("img")).not.toBeNull();
    }
    const fieldset = container.querySelector("fieldset");
    expect(fieldset).toHaveClass("bg-surface-sunken", "rounded-lg");
    // Checkbox rows keep the 44px target from the atom.
    for (const box of boxes()) expect(box.closest("label")).toHaveClass("min-h-touch");
  });

  test("submit is a pill button with a 44px target", () => {
    render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    expect(screen.getByRole("button", { name: "Add selected to cart" })).toHaveClass("rounded-full", "min-h-touch");
  });

  test("form post: submits every checked id as repeated productId fields (same fields the no-JS POST sends)", async () => {
    const received: string[][] = [];
    const action: CartActionFnV2 = async (_prev, formData) => {
      received.push(formData.getAll("productId").map(String));
      return null;
    };
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    fireEvent.click(boxes()[1] as HTMLInputElement);
    expect(totalText()).toBe("Total for 2 items: $1,254.56");
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: "Add selected to cart" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(received).toEqual([["p1", "p3"]]));
  });
});
