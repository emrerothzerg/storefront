import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Product } from "@/lib/types";

import {
  availabilityFor,
  breadcrumbListJsonLd,
  centsToDecimalString,
  faqPageJsonLd,
  isSupportedCurrency,
  itemListJsonLd,
  organizationJsonLd,
  productJsonLd,
  toProductJsonLdInput,
  webSiteJsonLd,
  type ProductJsonLdInput,
} from "./json-ld";

const env = process.env as Record<string, string | undefined>;
const original = env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
});

afterEach(() => {
  if (original === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = original;
});

const BASE: ProductJsonLdInput = {
  name: "Walnut Standing Desk",
  description: "Solid walnut top.",
  slug: "walnut-desk",
  images: ["/images/products/walnut-desk.svg"],
  priceCents: 125000,
  currency: "USD",
  stock: 3,
};

describe("organizationJsonLd / webSiteJsonLd", () => {
  test("organization", () => {
    expect(organizationJsonLd()).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Northwind Goods",
      url: "https://shop.example.com/",
    });
  });

  test("website with a SearchAction on the fixed /search URL template", () => {
    expect(webSiteJsonLd()).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Northwind Goods",
      url: "https://shop.example.com/",
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: "https://shop.example.com/search?q={search_term_string}",
        },
        "query-input": "required name=search_term_string",
      },
    });
  });
});

describe("breadcrumbListJsonLd", () => {
  test("positions start at 1 and items are absolute", () => {
    expect(
      breadcrumbListJsonLd([
        { name: "Home", path: "/" },
        { name: " Desk ", path: "/products/desk" },
      ]),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://shop.example.com/" },
        { "@type": "ListItem", position: 2, name: "Desk", item: "https://shop.example.com/products/desk" },
      ],
    });
  });

  test("empty trail", () => {
    expect(breadcrumbListJsonLd([]).itemListElement).toEqual([]);
  });
});

describe("itemListJsonLd", () => {
  test("lists urls with optional names", () => {
    expect(itemListJsonLd([{ path: "/products/a", name: "A" }, { path: "/products/b" }])).toEqual({
      "@context": "https://schema.org",
      "@type": "ItemList",
      numberOfItems: 2,
      itemListElement: [
        { "@type": "ListItem", position: 1, url: "https://shop.example.com/products/a", name: "A" },
        { "@type": "ListItem", position: 2, url: "https://shop.example.com/products/b" },
      ],
    });
  });
});

describe("faqPageJsonLd", () => {
  test("questions with accepted answers", () => {
    expect(faqPageJsonLd([{ question: " Do you ship? ", answer: "Yes. " }])).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "Do you ship?", acceptedAnswer: { "@type": "Answer", text: "Yes." } },
      ],
    });
  });
});

describe("centsToDecimalString", () => {
  test.each([
    [125000, "USD", "1250.00"],
    [1999, "USD", "19.99"],
    [5, "USD", "0.05"],
    [0, "USD", "0.00"],
    [1999, "JPY", "1999"],
    [1999, "KWD", "1.999"],
    [Number.MAX_SAFE_INTEGER, "USD", "90071992547409.91"],
  ])("%p %s -> %s", (cents, currency, expected) => {
    expect(centsToDecimalString(cents, currency)).toBe(expected);
  });

  test.each([
    [19.99, "USD"],
    [-1, "USD"],
    [Number.NaN, "USD"],
    [Number.MAX_SAFE_INTEGER + 2, "USD"],
    [100, "NOT A CURRENCY"],
    [100, "ABC"],
    [100, "ZZZ"],
    [100, "BTC"],
    [100, ""],
  ])("invalid %p %s -> null", (cents, currency) => {
    expect(centsToDecimalString(cents, currency)).toBeNull();
  });
});

describe("availabilityFor", () => {
  test.each([
    [1, "https://schema.org/InStock"],
    [42, "https://schema.org/InStock"],
    [0, "https://schema.org/OutOfStock"],
    [-3, "https://schema.org/OutOfStock"],
    [Number.NaN, "https://schema.org/OutOfStock"],
    [Number.POSITIVE_INFINITY, "https://schema.org/OutOfStock"],
  ] as const)("stock %p -> %s", (stock, expected) => {
    expect(availabilityFor(stock)).toBe(expected);
  });
});

describe("productJsonLd", () => {
  test("minimal product with offer, absolute url and images", () => {
    expect(productJsonLd(BASE)).toEqual({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Walnut Standing Desk",
      description: "Solid walnut top.",
      url: "https://shop.example.com/products/walnut-desk",
      image: ["https://shop.example.com/images/products/walnut-desk.svg"],
      offers: {
        "@type": "Offer",
        url: "https://shop.example.com/products/walnut-desk",
        price: "1250.00",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/NewCondition",
      },
    });
  });

  test("out of stock", () => {
    expect(productJsonLd({ ...BASE, stock: 0 }).offers?.availability).toBe(
      "https://schema.org/OutOfStock",
    );
  });

  test("sku, brand, explicit url and aggregate rating", () => {
    const out = productJsonLd({
      ...BASE,
      sku: "SKU-1",
      brandName: "Acme",
      ratingCount: 12,
      ratingAvg: 4.26,
      url: "/products/walnut-desk?ref=x",
      images: ["https://cdn.example.com/a.png", "  ", "/b.png"],
    });
    expect(out.sku).toBe("SKU-1");
    expect(out.brand).toEqual({ "@type": "Brand", name: "Acme" });
    expect(out.url).toBe("https://shop.example.com/products/walnut-desk?ref=x");
    expect(out.image).toEqual(["https://cdn.example.com/a.png", "https://shop.example.com/b.png"]);
    expect(out.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.3,
      ratingCount: 12,
      bestRating: 5,
      worstRating: 1,
    });
  });

  test.each([
    [0, 4.5],
    [-1, 4.5],
    [1.5, 4.5],
    [3, 0],
    [3, 5.1],
    [3, Number.NaN],
  ])("no aggregateRating for count %p avg %p", (ratingCount, ratingAvg) => {
    expect(productJsonLd({ ...BASE, ratingCount, ratingAvg })).not.toHaveProperty("aggregateRating");
  });

  test("no aggregateRating when only one of count/avg is given", () => {
    expect(productJsonLd({ ...BASE, ratingCount: 3 })).not.toHaveProperty("aggregateRating");
    expect(productJsonLd({ ...BASE, ratingAvg: 4 })).not.toHaveProperty("aggregateRating");
  });

  test("supported lower-case currency is accepted and upper-cased", () => {
    expect(productJsonLd({ ...BASE, currency: "eur" }).offers).toMatchObject({
      price: "1250.00",
      priceCurrency: "EUR",
    });
  });

  test.each(["ABC", "ZZZ", "BTC"])("non-ISO-4217 currency %p omits offers", (currency) => {
    expect(productJsonLd({ ...BASE, currency })).not.toHaveProperty("offers");
  });

  test("invalid price or currency omits offers instead of emitting a wrong price", () => {
    expect(productJsonLd({ ...BASE, priceCents: 12.5 })).not.toHaveProperty("offers");
    expect(productJsonLd({ ...BASE, currency: "??" })).not.toHaveProperty("offers");
  });

  test("blank sku/brand are omitted; the slug is URL-encoded in the default url", () => {
    const out = productJsonLd({ ...BASE, sku: " ", brandName: "", slug: "a b" });
    expect(out).not.toHaveProperty("sku");
    expect(out).not.toHaveProperty("brand");
    expect(out.url).toBe("https://shop.example.com/products/a%20b");
  });

  test("untrusted text is kept verbatim (escaping is the JsonLd component's job)", () => {
    const name = "</script><script>alert(1)</script>";
    expect(productJsonLd({ ...BASE, name }).name).toBe(name);
  });
});

describe("isSupportedCurrency", () => {
  test("ISO 4217 codes yes, made-up codes no", () => {
    expect(isSupportedCurrency("USD")).toBe(true);
    expect(isSupportedCurrency("JPY")).toBe(true);
    expect(isSupportedCurrency("ABC")).toBe(false);
    expect(isSupportedCurrency("BTC")).toBe(false);
    expect(isSupportedCurrency("usd")).toBe(false);
  });
});

describe("toProductJsonLdInput", () => {
  test.each(["", "   "])("blank sku %p falls back to id", (sku) => {
    const input = toProductJsonLdInput({ ...BASE, id: "prod_walnut-desk", sku });
    expect(input.sku).toBe("prod_walnut-desk");
  });

  test("sku is trimmed", () => {
    expect(toProductJsonLdInput({ ...BASE, id: "prod_x", sku: " SKU-9 " }).sku).toBe("SKU-9");
  });

  test("blank sku and no id: no sku", () => {
    expect(toProductJsonLdInput({ ...BASE, sku: " " })).not.toHaveProperty("sku");
  });

  test("maps today's Product (imageUrl, id as sku)", () => {
    const product: Product = {
      id: "prod_walnut-desk",
      slug: "walnut-desk",
      name: "Walnut Standing Desk",
      description: "Solid walnut top.",
      priceCents: 125000,
      currency: "USD",
      imageUrl: "/images/products/walnut-desk.svg",
      stock: 3,
    };
    expect(toProductJsonLdInput(product)).toEqual({
      ...BASE,
      sku: "prod_walnut-desk",
    });
  });

  test("maps a richer product detail (images[], brand object, ratings)", () => {
    const detail = {
      id: "prod_x",
      slug: "x",
      name: "X",
      description: "D",
      priceCents: 100,
      currency: "EUR",
      stock: 0,
      imageUrl: "/old.svg",
      images: [{ url: "/1.svg", alt: "one" }, "/2.svg"],
      brand: { id: "b1", name: "Acme" },
      bullets: ["a", "b"],
      ratingCount: 0,
      ratingAvg: 0,
    };
    const input = toProductJsonLdInput(detail);
    expect(input.images).toEqual(["/1.svg", "/2.svg"]);
    expect(input.brandName).toBe("Acme");
    expect(input.sku).toBe("prod_x");
    expect(productJsonLd(input)).not.toHaveProperty("aggregateRating");
  });

  test("brand as a string, null optional fields, explicit sku wins", () => {
    const input = toProductJsonLdInput({
      slug: "x",
      name: "X",
      description: "D",
      priceCents: 1,
      currency: "USD",
      stock: 1,
      id: "prod_x",
      sku: "SKU",
      brand: "Acme",
      images: null,
      imageUrl: null,
      ratingCount: null,
      ratingAvg: null,
    });
    expect(input).toEqual({
      slug: "x",
      name: "X",
      description: "D",
      priceCents: 1,
      currency: "USD",
      stock: 1,
      images: [],
      sku: "SKU",
      brandName: "Acme",
    });
  });
});
