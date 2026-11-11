// QA T181 (UI wave 1, part 1): U05 /brands tile grid and U15 coupon copy, against a seeded
// in-memory DB. Component-level checks live in tests/components/ui-wave1-part1.qa.test.tsx.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// next/* mocks are process-wide in bun test: registered before the page is imported.
const realServer = { ...(await import("next/server")) };
mock.module("next/server", () => ({ ...realServer, connection: async () => {} }));
const cookies = mock(async () => {
  throw new Error("/brands must not read cookies");
});
mock.module("next/headers", () => ({ cookies, headers: async () => new Headers() }));

const env = process.env as Record<string, string | undefined>;
env.DATABASE_PATH = ":memory:";
env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { default: BrandsPage } = await import("@/app/brands/page");
const { SqliteBrandRepository } = await import("@/server/catalog/brand-repository");
const { createCouponService, describeCoupon } = await import("@/server/pricing/coupon-service");
const { buildHeaderBenefits } = await import("@/app/_layout/header-benefits");
const { brandAndThemeViolations } = await import("./phase3-pages/_phase3");

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  cookies.mockClear();
});
afterEach(() => {
  closeDatabase();
});

const renderBrands = async () => render(await BrandsPage());

function addBrand(id: string, slug: string, name: string) {
  getDatabase().query("INSERT INTO brands (id, slug, name) VALUES (?, ?, ?)").run(id, slug, name);
}

describe("T181 U05 /brands", () => {
  test("one section, one list, one tile per brand; no per-letter sections or letter headings", async () => {
    const { container } = await renderBrands();
    expect(container.querySelectorAll("section")).toHaveLength(1);
    const section = container.querySelector("section");
    expect(section?.querySelectorAll("ul")).toHaveLength(1);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Brands", "All brands"]);
    const brands = new SqliteBrandRepository(getDatabase()).listWithCounts();
    expect(screen.getAllByTestId("brand-tile")).toHaveLength(brands.length);
    expect(cookies).not.toHaveBeenCalled();
  });

  test("each tile is exactly one link named by the brand, with the product count in the tile; no duplicate links", async () => {
    await renderBrands();
    const brands = new SqliteBrandRepository(getDatabase()).listWithCounts();
    const hrefs: string[] = [];
    for (const tile of screen.getAllByTestId("brand-tile")) {
      const links = within(tile).getAllByRole("link");
      expect(links).toHaveLength(1);
      const name = links[0]?.textContent ?? "";
      const brand = brands.find((b) => b.name === name);
      expect(brand?.name).toBe(name);
      expect(links[0]?.getAttribute("href")).toBe(`/brand/${brand?.slug}`);
      expect(tile.textContent).toBe(`${name}${brand?.productCount} product${brand?.productCount === 1 ? "" : "s"}`);
      hrefs.push(links[0]?.getAttribute("href") ?? "");
    }
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // Whole page: every /brand/ link appears once.
    const all = screen.getAllByRole("link").map((a) => a.getAttribute("href")).filter((h) => h?.startsWith("/brand/"));
    expect(all).toEqual(hrefs);
  });

  test("alphabetical, case- and accent-insensitive; names without a Latin initial come last", async () => {
    addBrand("qa-b1", "qa-zeta", "zeta Home");
    addBrand("qa-b2", "qa-emile", "Émile Atelier");
    addBrand("qa-b3", "qa-3m", "3 Mountains");
    await renderBrands();
    const names = screen.getAllByTestId("brand-tile").map((t) => within(t).getByRole("link").textContent ?? "");
    expect(names[names.length - 1]).toBe("3 Mountains");
    const latin = names.slice(0, -1);
    const collator = new Intl.Collator("en", { sensitivity: "base" });
    expect(latin).toEqual([...latin].sort((a, b) => collator.compare(a, b)));
    expect(latin.indexOf("Émile Atelier")).toBeGreaterThan(-1);
  });

  test("hostile brand name renders as text, not markup", async () => {
    addBrand("qa-b4", "qa-hostile", '<img src=x onerror="alert(1)">');
    const { container } = await renderBrands();
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(screen.getByRole("link", { name: '<img src=x onerror="alert(1)">' }).getAttribute("href")).toBe("/brand/qa-hostile");
  });

  test("tiles: stretched link inside a relative card, link carries focus (card itself not focusable)", async () => {
    await renderBrands();
    for (const tile of screen.getAllByTestId("brand-tile")) {
      expect(tile.getAttribute("tabindex")).toBeNull();
      const cls = (tile.getAttribute("class") ?? "").split(/\s+/);
      expect(cls).toContain("relative");
      const link = within(tile).getByRole("link");
      expect(link.className).toContain("after:absolute");
      expect(link.className).toContain("after:inset-0");
      expect(link.className).toContain("min-h-touch");
    }
  });

  test("server HTML: no retailer words, no script other than JSON-LD", async () => {
    const html = renderToStaticMarkup(await BrandsPage());
    expect(brandAndThemeViolations(html)).toEqual([]);
    expect((html.match(/<script/g) ?? []).length).toBe((html.match(/<script type="application\/ld\+json"/g) ?? []).length);
  });
});

describe("T181 U15 coupon / benefits copy", () => {
  test.each([
    ["free_shipping", 0, 2000, "Free shipping on orders of $20 or more"],
    ["free_shipping", 0, 2050, "Free shipping on orders of $20.50 or more"],
    ["fixed", 500, 2500, "$5 off orders of $25 or more"],
    ["fixed", 450, 0, "$4.50 off"],
    ["fixed", 1000000, 0, "$10,000 off"],
    ["fixed", 5, 0, "$0.05 off"],
    ["percent", 10, 0, "10% off"],
    ["percent", 15, 1999, "15% off orders of $19.99 or more"],
  ] as const)("describeCoupon(%s, %p, %p) -> %s", (kind, value, min, text) => {
    expect(describeCoupon(kind, value, min)).toBe(text);
  });

  test("seeded promoted coupon flows into the header strip as '$20' (no cents), next to '$35' from shipping data", () => {
    const service = createCouponService({ db: getDatabase() });
    const promoted = service.listPromoted();
    expect(promoted[0]?.code).toBe("FREESHIP");
    expect(promoted[0]?.description).toBe("Free shipping on orders of $20 or more");
    const strip = buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: promoted[0] ?? null });
    const labels = strip.items.map((i) => i.label);
    expect(labels).toContain("Free standard shipping on orders of $35 or more");
    expect(labels).toContain("Use code FREESHIP for free shipping on orders of $20 or more");
    expect(labels.join(" ")).not.toMatch(/\.00\b/);
  });

  test("'Add $X more' message keeps its cents (unchanged)", () => {
    const service = createCouponService({ db: getDatabase() });
    const short = service.validate("FREESHIP", 1500, null);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.message).toBe("Add $5.00 more to use this promo code.");
    const penny = service.validate("SAVE5", 2499, null);
    if (!penny.ok) expect(penny.error.message).toBe("Add $0.01 more to use this promo code.");
    expect(penny.ok).toBe(false);
  });

  test("an applied coupon's description also drops whole-dollar cents", () => {
    const service = createCouponService({ db: getDatabase() });
    const applied = service.validate("SAVE5", 3000, null);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.value.description).toBe("$5 off orders of $25 or more");
  });
});
