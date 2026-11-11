import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Product } from "@/lib/types";
import type { CartActionFn } from "../_contracts/cart-actions";
import type { ListActionFn } from "../_contracts/list-actions";
import {
  PRODUCT_CARD_LIST_IMAGE_SIZES,
  ProductCard,
  type ProductCardProps,
  cardBullets,
  cardRating,
} from "./ProductCard";
import { cardBadges } from "./card-badges";

const base: Product = {
  id: "p_1",
  slug: "canvas-tote-bag",
  name: "Canvas Tote Bag",
  description: "A sturdy tote.",
  priceCents: 2400,
  currency: "USD",
  imageUrl: "/images/products/canvas-tote-bag.jpg",
  stock: 12,
};

function make(overrides: Partial<Product> = {}): Product {
  return { ...base, ...overrides };
}

const addToCart: CartActionFn = async () => null;
const listAction: ListActionFn = async () => null;

const full: Omit<ProductCardProps, "product"> = {
  rating: { avg: 4.5, count: 1234 },
  listPriceCents: 3000,
  badges: ["best_seller", "deal"],
  rank: 2,
  stock: 3,
  wishlist: { inList: false, addAction: listAction, removeAction: listAction },
  quickAdd: { action: addToCart },
  compare: { selected: ["other-slug"], basePath: "/search?q=tote" },
};

function productLinks(html: string, slug: string): number {
  const re = new RegExp(`<a [^>]*href="/products/${slug}"`, "g");
  return (html.match(re) ?? []).length;
}

describe("ProductCard v2: one product link (criterion 1)", () => {
  test("static markup with every option has exactly one <a> to the product page and no other links", () => {
    const html = renderToStaticMarkup(<ProductCard product={make()} {...full} />);
    expect(productLinks(html, "canvas-tote-bag")).toBe(1);
    expect((html.match(/<a /g) ?? []).length).toBe(1);
  });

  test("heart, quick add and compare are buttons/inputs in z-raised siblings of the link", () => {
    const { container } = render(<ProductCard product={make()} {...full} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add Canvas Tote Bag to Wish List" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add to cart\s*: Canvas Tote Bag$/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Compare Canvas Tote Bag" })).toBeInTheDocument();
    for (const form of container.querySelectorAll("form")) {
      expect(form.closest(".z-raised")).not.toBeNull();
    }
  });

  test("quick-add form markup has hidden productId and quantity=1", () => {
    const html = renderToStaticMarkup(<ProductCard product={make()} quickAdd={{ action: addToCart }} />);
    expect(html).toMatch(/<input type="hidden" name="productId" value="p_1"\/>/);
    expect(html).toMatch(/<input type="hidden" name="quantity" value="1"\/>/);
    // T137 (pin changed): visible "Add" + sr-only " to cart: <name>" (was the literal "Add to cart").
    expect(html).toMatch(/>Add<span class="sr-only"> to cart: Canvas Tote Bag<\/span>/);
  });

  test("wishlist heart overlays the image corner and carries list fields", () => {
    const { container } = render(
      <ProductCard
        product={make()}
        wishlist={{ inList: true, listId: "L9", addAction: listAction, removeAction: listAction }}
      />,
    );
    const heart = screen.getByRole("button", { name: "Remove Canvas Tote Bag from Wish List" });
    expect(heart).toHaveAttribute("aria-pressed", "true");
    // T137 (pin changed): the heart sits in the image overlay (same box as the image), top right.
    const corner = heart.closest(".absolute");
    expect(corner).toHaveClass("right-0", "top-0", "z-raised", "pointer-events-auto");
    expect(corner?.parentElement).toHaveAttribute("data-slot", "product-card-overlay");
    expect(corner?.parentElement).toHaveClass("aspect-square", "pointer-events-none");
    expect(heart.closest("a")).toBeNull();
    expect(container.querySelector('input[name="listId"]')).toHaveAttribute("value", "L9");
    expect(container.querySelector('input[name="productSlug"]')).toHaveAttribute("value", "canvas-tote-bag");
  });

  test("compare toggle is a GET form to /compare keeping other selected slugs", () => {
    const { container } = render(<ProductCard product={make()} compare={{ selected: ["other-slug"] }} />);
    const form = container.querySelector('form[action="/compare"]');
    expect(form).not.toBeNull();
    expect(form?.querySelector('input[type="hidden"][name="p"][value="other-slug"]')).not.toBeNull();
  });
});

describe("ProductCard v2: rating (criterion 2)", () => {
  test("shows stars + formatted count", () => {
    render(<ProductCard product={make()} rating={{ avg: 4.5, count: 1234 }} />);
    expect(screen.getByText("(1,234)")).toBeInTheDocument();
    expect(screen.getByText("4.5 out of 5 stars")).toBeInTheDocument();
  });

  test.each([
    [{ avg: 0, count: 0 }],
    [{ avg: 4, count: 0 }],
    [{ avg: Number.NaN, count: 3 }],
    [{ avg: 4, count: -1 }],
    [{ avg: 4, count: 1.5 }],
  ])("hidden for %p (no '0.0 stars')", (rating) => {
    const { container } = render(<ProductCard product={make()} rating={rating} />);
    expect(container.textContent).not.toMatch(/stars|\(0\)/);
    expect(container.querySelector('[data-testid="rating-stars"]')).toBeNull();
  });

  test("falls back to product.ratingAvg / ratingCount; explicit null hides it", () => {
    const p = make({ ratingAvg: 3.9, ratingCount: 12 });
    const { unmount } = render(<ProductCard product={p} />);
    expect(screen.getByText("(12)")).toBeInTheDocument();
    unmount();
    const { container } = render(<ProductCard product={p} rating={null} />);
    expect(container.textContent).not.toContain("stars");
  });

  test("cardRating clamps avg to 5", () => {
    expect(cardRating({ avg: 9, count: 1 }, {})).toEqual({ avg: 5, count: 1 });
    expect(cardRating(undefined, {})).toBeNull();
  });
});

describe("ProductCard v2: price, badges, rank, stock", () => {
  test("list price above price: struck list price and '% off' text", () => {
    const { container } = render(<ProductCard product={make()} listPriceCents={3000} />);
    const struck = container.querySelector("s");
    expect(struck).toHaveTextContent("$30.00");
    expect(screen.getByText("20% off")).toBeInTheDocument();
  });

  test.each([[2400], [1000], [null], [Number.NaN], [-5]])("list price %p: no struck price, no '% off'", (listPriceCents) => {
    const { container } = render(<ProductCard product={make()} listPriceCents={listPriceCents} />);
    expect(container.querySelector("s")).toBeNull();
    expect(container.textContent).not.toContain("% off");
    expect(screen.getByText("$24.00")).toBeInTheDocument();
  });

  test("saving under 1% shows the struck price but no '0% off'", () => {
    const { container } = render(<ProductCard product={make({ priceCents: 99_950 })} listPriceCents={100_000} />);
    expect(container.querySelector("s")).not.toBeNull();
    expect(container.textContent).not.toContain("% off");
  });

  test("falls back to product.listPriceCents", () => {
    render(<ProductCard product={make({ listPriceCents: 4800 })} />);
    expect(screen.getByText("50% off")).toBeInTheDocument();
  });

  // T137 (pin changed): explicit badges are capped at 2 (CARD_BADGE_MAX); "Top Pick" -> "Top pick".
  test("badges render as text, deduped, unknown ignored, at most 2", () => {
    render(
      <ProductCard
        product={make()}
        badges={["new", "top_pick", "deal", "best_seller", "new", "bogus" as "new"]}
      />,
    );
    const row = screen.getByTestId("product-card-badges");
    expect(row.textContent).toBe("NewTop pick");
    expect(cardBadges(["deal", "deal"])).toEqual(["deal"]);
    expect(cardBadges(undefined)).toEqual([]);
  });

  test("rank renders '#N'; invalid ranks are hidden", () => {
    const { unmount } = render(<ProductCard product={make()} rank={7} />);
    expect(screen.getByTestId("product-card-badges")).toHaveTextContent("Rank #7");
    unmount();
    for (const rank of [0, -1, 1.5, Number.NaN]) {
      const r = render(<ProductCard product={make()} rank={rank} />);
      expect(r.queryByTestId("product-card-badges")).toBeNull();
      r.unmount();
    }
  });

  test("stock prop switches to StockUrgency text", () => {
    const { unmount } = render(<ProductCard product={make()} stock={2} />);
    expect(screen.getByText("Only 2 left in stock")).toBeInTheDocument();
    expect(screen.queryByText("Only 2 left")).toBeNull();
    unmount();
    render(<ProductCard product={make()} stock={0} />);
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
  });
});

describe("ProductCard v2: quick add (criterion 3)", () => {
  test("stock 0 (prop) renders a disabled 'Out of stock' button and no cart form", () => {
    const { container } = render(<ProductCard product={make()} stock={0} quickAdd={{ action: addToCart }} />);
    const button = screen.getByRole("button", { name: /Out of stock/ });
    expect(button).toBeDisabled();
    expect(container.querySelector('input[name="quantity"]')).toBeNull();
  });

  test("falls back to product.stock when the stock prop is absent", () => {
    render(<ProductCard product={make({ stock: 0 })} quickAdd={{ action: addToCart }} />);
    expect(screen.getByRole("button", { name: /Out of stock/ })).toBeDisabled();
  });

  test("quantity is fixed at 1 (hidden, no stepper)", () => {
    const { container } = render(<ProductCard product={make()} stock={50} quickAdd={{ action: addToCart }} />);
    const qty = container.querySelectorAll('input[name="quantity"]');
    expect(qty).toHaveLength(1);
    expect(qty[0]).toHaveAttribute("type", "hidden");
    expect(qty[0]).toHaveAttribute("value", "1");
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});

describe("ProductCard v2: list layout (criterion 4)", () => {
  const longDescription = "Durable waxed canvas with leather handles. ".repeat(10);

  test("shows a <= 160 char excerpt with ellipsis and at most 3 bullets", () => {
    const { container } = render(
      <ProductCard
        product={make({ description: longDescription })}
        layout="list"
        bullets={["One", "Two", "   ", "Three", "Four"]}
      />,
    );
    const article = container.querySelector("article")!;
    expect(article).toHaveAttribute("data-layout", "list");
    // T137 (pin changed: sm:flex-row -> sm:flow-root): the image floats left inside the one link.
    expect(article).toHaveClass("sm:flow-root");
    const p = Array.from(article.querySelectorAll("p")).find((el) => el.textContent?.startsWith("Durable"));
    expect(p).toBeDefined();
    expect(p!.textContent!.length).toBeLessThanOrEqual(160);
    expect(p!.textContent!.endsWith("…")).toBe(true);
    const bullets = within(article.querySelector("ul")!).getAllByRole("listitem");
    expect(bullets.map((li) => li.textContent)).toEqual(["One", "Two", "Three"]);
  });

  test("list layout uses list image sizes and a 3-line name clamp", () => {
    const { container } = render(<ProductCard product={make()} layout="list" />);
    expect(container.querySelector("img")?.getAttribute("sizes")).toBe(PRODUCT_CARD_LIST_IMAGE_SIZES);
    expect(screen.getByRole("heading")).toHaveClass("line-clamp-3", "break-words");
  });

  test("grid layout shows no description and no bullets", () => {
    const { container } = render(
      <ProductCard product={make({ description: longDescription })} bullets={["One"]} />,
    );
    expect(container.textContent).not.toContain("Durable");
    expect(container.querySelector("ul")).toBeNull();
  });

  test("cardBullets caps at 3 and drops blanks", () => {
    expect(cardBullets(["a", "", "b", "c", "d"])).toEqual(["a", "b", "c"]);
    expect(cardBullets(undefined)).toEqual([]);
  });
});

describe("ProductCard v2: hostile text, placeholder, tokens (criterion 5, SR3)", () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

  test("hostile name/description/bullets render as text only", () => {
    const { container } = render(
      <ProductCard
        product={make({ name: hostile, description: hostile, imageUrl: "" })}
        layout="list"
        bullets={[hostile]}
        {...full}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(screen.getByRole("link")).toHaveTextContent(hostile);
    const html = renderToStaticMarkup(
      <ProductCard product={make({ name: hostile, description: hostile })} layout="list" bullets={[hostile]} />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("missing image with every option still renders the placeholder", () => {
    const { container } = render(<ProductCard product={make({ imageUrl: "" })} {...full} />);
    // T137 (pin changed): decorative placeholder; the link text names the product.
    expect(container.querySelector("[data-placeholder]")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("link")).toHaveAccessibleName("Canvas Tote Bag");
    expect(container.querySelector("img")).toBeNull();
  });

  test("long names keep break-words, the 160px min width, and the full name in the link", () => {
    const name = "Supercalifragilistic".repeat(15);
    const { container } = render(<ProductCard product={make({ name })} {...full} />);
    expect(screen.getByRole("heading")).toHaveClass("break-words");
    // T137 (pin changed: min-w-0 -> min-w-40).
    expect(container.querySelector("article")).toHaveClass("min-w-40");
    expect(screen.getByRole("link").textContent).toBe(name);
  });

  test("no arbitrary values, palette colours, or inline styles with every option", () => {
    const { container } = render(
      <>
        <ProductCard product={make()} {...full} />
        <ProductCard product={make({ id: "p2", imageUrl: "" })} {...full} layout="list" bullets={["x"]} />
      </>,
    );
    const styled = [...container.querySelectorAll("[style]")].filter((el) => el.tagName !== "IMG");
    expect(styled).toHaveLength(0);
    const classes = [...container.querySelectorAll("[class]")].flatMap((el) =>
      (el.getAttribute("class") ?? "").split(/\s+/),
    );
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /(^|:)(bg|text|border)-(gray|red|blue|green|white|black)(-\d+)?$/.test(c))).toEqual([]);
  });
});
