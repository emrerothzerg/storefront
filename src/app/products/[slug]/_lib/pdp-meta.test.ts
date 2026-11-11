import { describe, expect, test } from "bun:test";

import {
  PDP_DESCRIPTION_MAX,
  PDP_DESCRIPTION_MIN,
  buildPdpDescription,
  productFactsSentence,
  truncateOnWord,
  type PdpDescriptionSource,
} from "./pdp-meta";

function product(over: Partial<PdpDescriptionSource> = {}): PdpDescriptionSource {
  return {
    name: "Plush Fox",
    description: "An extra-soft plush fox with embroidered eyes, 30 cm tall.",
    priceCents: 2400,
    currency: "USD",
    bullets: ["Machine washable at 30 degrees", "Recycled polyester filling"],
    brand: { name: "Wild Things" },
    category: { name: "Soft Toys" },
    ...over,
  };
}

function expectInBounds(text: string): void {
  expect(text.length).toBeGreaterThanOrEqual(PDP_DESCRIPTION_MIN);
  expect(text.length).toBeLessThanOrEqual(PDP_DESCRIPTION_MAX);
  expect(text).not.toMatch(/\s{2,}|^\s|\s$/);
}

describe("buildPdpDescription", () => {
  test("a description already 70-160 chars is used as-is", () => {
    const description = "Heavyweight natural cotton tote with an inside pocket. Carries a week of groceries.";
    expect(buildPdpDescription(product({ description }))).toBe(description);
  });

  test("a short description is extended with name, brand, category and price", () => {
    const out = buildPdpDescription(product());
    expect(out).toBe(
      "An extra-soft plush fox with embroidered eyes, 30 cm tall. Plush Fox by Wild Things in Soft Toys, $24.00.",
    );
    expectInBounds(out);
  });

  test("missing brand/category/price parts are left out; bullets then the site line fill the gap", () => {
    const out = buildPdpDescription(product({ description: "Soft fox.", brand: null, category: null, priceCents: -1 }));
    expect(out.startsWith("Soft fox. Plush Fox. Machine washable at 30 degrees.")).toBe(true);
    expectInBounds(out);
    const bare = buildPdpDescription(product({ description: "", bullets: [], brand: null, category: null }));
    expect(bare).toBe("Plush Fox, $24.00. Available at Northwind Goods.");
  });

  test("a long description is cut on a word boundary with an ellipsis", () => {
    const description = `${"Sturdy oak frame with hand-rubbed oil finish ".repeat(6)}end`;
    const out = buildPdpDescription(product({ description }));
    expect(out.length).toBeLessThanOrEqual(PDP_DESCRIPTION_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(description.startsWith(out.slice(0, -1))).toBe(true);
    expect(description[out.length - 1]).toBe(" ");
  });

  test("short description + very long name stays within 160", () => {
    const out = buildPdpDescription(product({ description: "Tiny.", name: "Fox ".repeat(60).trim() }));
    expectInBounds(out);
    expect(out.endsWith("…")).toBe(true);
  });

  test("whitespace in catalog copy is collapsed", () => {
    const out = buildPdpDescription(product({ description: "  Soft\n\nplush   fox.  " }));
    expect(out.startsWith("Soft plush fox. Plush Fox by Wild Things")).toBe(true);
  });

  test("hostile copy stays plain text (no escaping, no throw); unsupported currency drops the price", () => {
    const out = buildPdpDescription(product({ description: "<script>alert(1)</script>", currency: "ZZZ" as PdpDescriptionSource["currency"] }));
    expect(out.startsWith("<script>alert(1)</script>. Plush Fox by Wild Things in Soft Toys.")).toBe(true);
    expect(out).not.toContain("ZZZ");
  });

  test("only catalog fields are read (no owner or viewer keys on the input type)", () => {
    const input = { ...product(), sessionId: "should-never-appear", ownerKey: "nope" };
    const out = buildPdpDescription(input);
    expect(out).not.toContain("should-never-appear");
    expect(out).not.toContain("nope");
  });
});

describe("productFactsSentence", () => {
  test("joins the available parts", () => {
    expect(productFactsSentence(product())).toBe("Plush Fox by Wild Things in Soft Toys, $24.00.");
    expect(productFactsSentence(product({ name: "", brand: null }))).toBe("In Soft Toys, $24.00.");
    expect(productFactsSentence(product({ name: "", brand: null, category: null, priceCents: 1.5 }))).toBe("");
  });

  test("GBP and zero-decimal currencies format through formatMoney", () => {
    expect(productFactsSentence(product({ currency: "GBP" }))).toContain("£24.00");
    expect(productFactsSentence(product({ currency: "JPY", priceCents: 2400 }))).toContain("2,400");
  });
});

describe("truncateOnWord", () => {
  test("no-op within the limit", () => {
    expect(truncateOnWord("short text", 160)).toBe("short text");
  });

  test("cuts at the last space and strips trailing punctuation", () => {
    expect(truncateOnWord("alpha beta, gamma delta", 14)).toBe("alpha beta…");
  });

  test("never leaves a lone high surrogate", () => {
    const out = truncateOnWord("\u{1F600}".repeat(20), 10);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.length).toBeLessThanOrEqual(10);
  });

  test("degenerate max returns empty", () => {
    expect(truncateOnWord("abc def", 1)).toBe("");
  });
});
