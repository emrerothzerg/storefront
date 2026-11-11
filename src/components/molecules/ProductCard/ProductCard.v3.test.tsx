// T137: ProductCard v3 (listing reference) and the compact rail variant.
import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Product } from "@/lib/types";
import type { CartActionFn } from "../_contracts/cart-actions";
import type { ListActionFn } from "../_contracts/list-actions";
import { PRODUCT_CARD_COMPACT_IMAGE_SIZES, ProductCard, type ProductCardProps } from "./ProductCard";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const base: Product = {
  id: "p_1",
  slug: "blue-mug",
  name: "Blue Mug",
  description: "A mug.",
  priceCents: 1250,
  currency: "USD",
  imageUrl: "/images/products/blue-mug.jpg",
  stock: 12,
};

function make(over: Partial<Product> = {}): Product {
  return { ...base, ...over };
}

const addToCart: CartActionFn = async () => null;
const listAction: ListActionFn = async () => null;

const controls: Omit<ProductCardProps, "product"> = {
  wishlist: { inList: false, addAction: listAction, removeAction: listAction },
  quickAdd: { action: addToCart },
  compare: { selected: [] },
};

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");
const INTERACTIVE = "a, button, input, select, textarea, [tabindex]";

describe("ProductCard v3: badges from product data (criterion 1)", () => {
  test("sale + new + top pick qualifying: only 'Sale' and 'New', in that order", () => {
    const product = make({
      listPriceCents: 1900,
      publishedAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
      ratingAvg: 4.8,
      ratingCount: 20,
    });
    render(<ProductCard product={product} now={NOW} />);
    const row = screen.getByTestId("product-card-badges");
    expect(row.textContent).toBe("SaleNew");
    // Badges are text pills over the image, not inside the link.
    expect(row.closest("a")).toBeNull();
    expect(row.closest('[data-slot="product-card-overlay"]')).not.toBeNull();
  });

  test("top pick follows the displayed rating (an explicit null rating hides it)", () => {
    const product = make({ ratingAvg: 4.6, ratingCount: 84 });
    const { unmount } = render(<ProductCard product={product} now={NOW} />);
    expect(screen.getByTestId("product-card-badges").textContent).toBe("Top pick");
    unmount();
    const { container } = render(<ProductCard product={product} now={NOW} rating={null} />);
    expect(container.querySelector('[data-testid="product-card-badges"]')).toBeNull();
  });

  test("rating 4.5 from 4 reviews shows no badge", () => {
    const { container } = render(<ProductCard product={make({ ratingAvg: 4.5, ratingCount: 4 })} now={NOW} />);
    expect(container.querySelector('[data-testid="product-card-badges"]')).toBeNull();
  });

  test("Sale follows the listPriceCents override", () => {
    const { unmount } = render(<ProductCard product={make()} listPriceCents={1900} now={NOW} />);
    expect(screen.getByTestId("product-card-badges").textContent).toBe("Sale");
    unmount();
    const { container } = render(<ProductCard product={make({ listPriceCents: 1900 })} listPriceCents={null} now={NOW} />);
    expect(container.querySelector('[data-testid="product-card-badges"]')).toBeNull();
  });

  test("New uses the now prop (day 31 -> no badge)", () => {
    const publishedAt = new Date(NOW.getTime() - 31 * DAY).toISOString();
    const { container } = render(<ProductCard product={make({ publishedAt })} now={NOW} />);
    expect(container.querySelector('[data-testid="product-card-badges"]')).toBeNull();
  });

  test("explicit badges=[] suppresses derived badges", () => {
    const { container } = render(<ProductCard product={make({ listPriceCents: 1900 })} badges={[]} now={NOW} />);
    expect(container.querySelector('[data-testid="product-card-badges"]')).toBeNull();
  });

  test("badge pills keep text and the 12px caption size", () => {
    render(<ProductCard product={make({ listPriceCents: 1900 })} now={NOW} />);
    const sale = screen.getByText("Sale");
    expect(sale).toHaveClass("rounded-full", "text-caption", "bg-deal", "text-text-on-accent");
  });
});

describe("ProductCard v3: '+ Add' quick add (criteria 2, 3)", () => {
  test("a real form, sibling of the link, posting only productId and quantity=1", () => {
    const html = renderToStaticMarkup(<ProductCard product={make()} quickAdd={{ action: addToCart }} />);
    const doc = parse(html);
    const forms = doc.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    const form = forms[0]!;
    expect(form.closest("a")).toBeNull();
    expect(doc.querySelector("a")?.querySelector("form, button, input")).toBeNull();
    const fields = [...form.querySelectorAll("input[name]")].map((i) => [i.getAttribute("name"), i.getAttribute("value")]);
    expect(fields).toEqual([
      ["productId", "p_1"],
      ["quantity", "1"],
    ]);
    // SR9: no price/total in the posted fields.
    expect(form.querySelector('[name*="price" i], [name*="total" i], [name*="amount" i]')).toBeNull();
    const button = form.querySelector("button[type=submit]")!;
    expect(button.textContent).toBe("Add to cart: Blue Mug");
    expect(button.querySelector('[data-slot="quick-add-pill"]')?.textContent).toBe("Add to cart: Blue Mug");
    expect(button.querySelector('[data-icon="plus"]')).not.toBeNull();
  });

  test("out of stock: no form, disabled 'Out of stock' label instead", () => {
    const html = renderToStaticMarkup(<ProductCard product={make({ stock: 0 })} quickAdd={{ action: addToCart }} />);
    const doc = parse(html);
    expect(doc.querySelector("form")).toBeNull();
    const button = doc.querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.textContent).toBe("Out of stock: Blue Mug");
  });

  test("the '+ Add' sits on the image overlay (bottom left) and takes pointer events", () => {
    const { container } = render(<ProductCard product={make()} quickAdd={{ action: addToCart }} />);
    const form = container.querySelector("form")!;
    expect(form).toHaveClass("absolute", "bottom-0", "left-0", "pointer-events-auto", "z-raised");
    const overlay = form.closest('[data-slot="product-card-overlay"]');
    expect(overlay).toHaveClass("pointer-events-none", "aspect-square", "absolute", "inset-x-3", "top-3");
  });
});

describe("ProductCard v3: one link for image and title (criterion 4, 7)", () => {
  test("with every control: one link wrapping image + heading; no control inside it", () => {
    const { container } = render(<ProductCard product={make()} {...controls} now={NOW} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link).toHaveAttribute("href", "/products/blue-mug");
    expect(link).toHaveAccessibleName("Blue Mug");
    expect(link.querySelector("img")).not.toBeNull();
    expect(within(link).getByRole("heading", { level: 3 })).toHaveTextContent("Blue Mug");
    expect(link.querySelectorAll(INTERACTIVE)).toHaveLength(0);
    // Wishlist and compare toggles still render, outside the link, with 44px targets.
    const heart = screen.getByRole("button", { name: "Add Blue Mug to Wish List" });
    expect(heart.closest("a")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Compare Blue Mug" }).closest("a")).toBeNull();
    for (const button of container.querySelectorAll("button")) {
      expect(button.className).toMatch(/\bmin-h-touch\b|\bsize-touch\b|\bh-touch\b/);
    }
  });
});

describe("ProductCard v3: price (criterion 5)", () => {
  test('sale price reads "$12.50" (no "Now" prefix) and the struck price "Was $19.00"', () => {
    const { container } = render(<ProductCard product={make({ listPriceCents: 1900 })} />);
    expect(screen.getByText("$12.50")).toHaveClass("sr-only");
    const struck = container.querySelector("s")!;
    expect(struck.textContent).toBe("Was $19.00");
    expect(container.textContent).not.toContain("Now ");
    // Superscript cents are markup, hidden from assistive tech.
    const visual = container.querySelector('[data-slot="price-superscript"]')!;
    expect(visual).toHaveAttribute("aria-hidden", "true");
    expect(visual.textContent).toBe("$1250");
    expect(screen.getByText("34% off")).toHaveClass("text-deal");
  });

  test("regular price reads its full amount and has no struck price", () => {
    const { container } = render(<ProductCard product={make({ priceCents: 1900 })} />);
    expect(screen.getByText("$19.00")).toHaveClass("sr-only");
    expect(container.querySelector("s")).toBeNull();
  });
});

describe("ProductCard v3: layout tokens (criterion 6)", () => {
  test("160px min width, 2-line clamp, fixed-aspect image box", () => {
    const { container } = render(<ProductCard product={make()} />);
    const article = container.querySelector("article")!;
    expect(article).toHaveClass("min-w-40", "rounded-lg", "bg-surface-raised");
    expect(article).not.toHaveClass("min-w-0");
    expect(screen.getByRole("heading")).toHaveClass("line-clamp-2", "break-words");
    const box = container.querySelector('[data-slot="product-card-image"]')!;
    expect(box).toHaveClass("aspect-square", "w-full", "overflow-hidden", "bg-surface-raised");
    expect(container.querySelector("img")).toHaveClass("h-full", "w-full", "object-contain");
  });

  test("missing image keeps the fixed-aspect box (placeholder inside it)", () => {
    const { container } = render(<ProductCard product={make({ imageUrl: "" })} />);
    const box = container.querySelector('[data-slot="product-card-image"]')!;
    expect(box.querySelector("[data-placeholder]")).not.toBeNull();
    expect(box).toHaveClass("aspect-square");
  });
});

describe("ProductCard v3: brand, rating, stock lines", () => {
  test("brand line is trimmed text outside the link; blank brand renders nothing", () => {
    const { container, unmount } = render(<ProductCard product={make({ brandName: "  Northwind Home  " })} />);
    const brand = container.querySelector('[data-slot="product-card-brand"]')!;
    expect(brand.textContent).toBe("Northwind Home");
    expect(brand.closest("a")).toBeNull();
    expect(brand).toHaveClass("truncate", "text-text-secondary");
    unmount();
    const blank = render(<ProductCard product={make({ brandName: "   " })} />);
    expect(blank.container.querySelector('[data-slot="product-card-brand"]')).toBeNull();
  });

  test("hostile brand text renders as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(<ProductCard product={make({ brandName: evil })} />);
    expect(container.querySelector('[data-slot="product-card-brand"]')?.textContent).toBe(evil);
    expect(container.querySelector("img[onerror]")).toBeNull();
  });

  test("compact rating: one star, value and count", () => {
    render(<ProductCard product={make({ ratingAvg: 4.6, ratingCount: 84 })} />);
    expect(screen.getByText("(84)")).toBeInTheDocument();
    expect(screen.getByTestId("rating-value")).toHaveTextContent("4.6");
    expect(screen.getByTestId("rating-stars").querySelectorAll("svg")).toHaveLength(1);
  });

  test("low-stock line from the stock prop", () => {
    render(<ProductCard product={make()} stock={3} />);
    expect(screen.getByText("Only 3 left in stock")).toBeInTheDocument();
  });
});

describe('ProductCard v3: variant="compact" (rails)', () => {
  test("same data, tighter padding/type, compact sizes, data-variant", () => {
    const product = make({ listPriceCents: 1900, brandName: "Acme", ratingAvg: 4.6, ratingCount: 84, imageUrl: "/images/x.jpg" });
    const { container } = render(<ProductCard product={product} variant="compact" quickAdd={{ action: addToCart }} now={NOW} />);
    const article = container.querySelector("article")!;
    expect(article).toHaveAttribute("data-variant", "compact");
    expect(article).toHaveClass("p-2", "gap-1", "min-w-40");
    expect(screen.getByRole("heading")).toHaveClass("text-small", "line-clamp-2");
    expect(container.querySelector("img")?.getAttribute("sizes")).toBe(PRODUCT_CARD_COMPACT_IMAGE_SIZES);
    expect(container.querySelector('[data-slot="product-card-overlay"]')).toHaveClass("inset-x-2", "top-2");
    expect(container.querySelector('[data-slot="quick-add-pill"]')).toHaveClass("text-caption");
    // Same data as the default card.
    expect(screen.getByTestId("product-card-badges").textContent).toBe("SaleTop pick");
    expect(container.querySelector("s")?.textContent).toBe("Was $19.00");
    expect(container.querySelector('[data-slot="product-card-brand"]')?.textContent).toBe("Acme");
    expect(screen.getByText("(84)")).toBeInTheDocument();
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });

  test("compact ignores the list layout", () => {
    const { container } = render(<ProductCard product={make()} variant="compact" layout="list" bullets={["One"]} />);
    expect(container.querySelector("article")).toHaveAttribute("data-layout", "grid");
    expect(container.querySelector("ul")).toBeNull();
  });

  test("default variant is data-variant=default", () => {
    const { container } = render(<ProductCard product={make()} />);
    expect(container.querySelector("article")).toHaveAttribute("data-variant", "default");
  });
});

describe("ProductCard: two title lines reserved in grid mode (T179 U14)", () => {
  test("grid title keeps line-clamp-2 and reserves two text-body lines (2 x 1.5rem = min-h-12)", () => {
    render(<ProductCard product={make({ name: "Short" })} />);
    const heading = screen.getByRole("heading");
    expect(heading).toHaveClass("text-body", "line-clamp-2", "min-h-12");
  });

  test("compact grid title reserves two text-small lines (2 x 1.25rem = min-h-10)", () => {
    render(<ProductCard product={make({ name: "Short" })} variant="compact" />);
    const heading = screen.getByRole("heading");
    expect(heading).toHaveClass("text-small", "line-clamp-2", "min-h-10");
    expect(heading).not.toHaveClass("min-h-12");
  });

  test("short and long titles get the same reserved height class (price rows align)", () => {
    const { container } = render(
      <div>
        <ProductCard product={make({ id: "a", slug: "a", name: "Mug" })} />
        <ProductCard product={make({ id: "b", slug: "b", name: "Gooseneck Pour-Over Kettle With Thermometer" })} />
      </div>,
    );
    const titles = [...container.querySelectorAll("h3, h2, h4")];
    expect(titles).toHaveLength(2);
    expect(titles[0]?.className).toBe(titles[1]?.className);
  });

  test("list layout is unchanged: line-clamp-3, no reserved min height", () => {
    render(<ProductCard product={make()} layout="list" />);
    const heading = screen.getByRole("heading");
    expect(heading).toHaveClass("line-clamp-3");
    expect(heading.className).not.toMatch(/\bmin-h-/);
  });
});
