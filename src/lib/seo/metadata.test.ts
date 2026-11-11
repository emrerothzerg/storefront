import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  OG_LOCALE,
  buildMetadata,
  truncateText,
} from "./metadata";

const env = process.env as Record<string, string | undefined>;
const original = env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
});

afterEach(() => {
  if (original === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = original;
});

const graphemeCount = (value: string): number =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)).length;

describe("truncateText", () => {
  test("short text is returned with whitespace collapsed", () => {
    expect(truncateText("  Hello \n\t world  ", 60)).toBe("Hello world");
  });

  test("text at exactly the limit is untouched", () => {
    const text = "a".repeat(60);
    expect(truncateText(text, 60)).toBe(text);
  });

  test("long text is cut to the limit with an ellipsis, preferring a word boundary", () => {
    const out = truncateText("The quick brown fox jumps over the lazy dog again", 20);
    expect(graphemeCount(out)).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("The quick brown fox…");
  });

  test("a single long word is hard-cut", () => {
    expect(truncateText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });

  test("never splits a surrogate pair or a ZWJ emoji", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const input = `${"\u{1F600}".repeat(8)}${family.repeat(5)}`;
    for (let max = 1; max <= 14; max++) {
      const out = truncateText(input, max);
      expect(graphemeCount(out)).toBeLessThanOrEqual(max);
      // No lone surrogates: round-trips through UTF-8 unchanged.
      expect(new TextDecoder().decode(new TextEncoder().encode(out))).toBe(out);
      expect(out.replace("…", "").length % 2).toBe(0);
    }
    const cut = truncateText(input, 10);
    expect(cut).toBe(`${"\u{1F600}".repeat(8)}${family}…`);
  });

  test("invalid max yields an empty string", () => {
    expect(truncateText("abc", 0)).toBe("");
    expect(truncateText("abc", Number.NaN)).toBe("");
  });
});

describe("buildMetadata", () => {
  test("indexable page with canonical, OG and summary twitter card", () => {
    expect(buildMetadata({ title: "Catalog", description: "All products.", path: "/" })).toEqual({
      title: "Catalog",
      description: "All products.",
      alternates: { canonical: "https://shop.example.com/" },
      openGraph: {
        type: "website",
        siteName: "Northwind Goods",
        locale: "en_US",
        title: "Catalog",
        description: "All products.",
        url: "https://shop.example.com/",
      },
      twitter: { card: "summary", title: "Catalog", description: "All products." },
    });
  });

  test("an image adds OG images and a summary_large_image card with absolute URLs", () => {
    const meta = buildMetadata({
      title: "Desk",
      description: "A desk.",
      path: "/products/desk",
      image: { url: "/images/products/desk.svg", alt: "Desk" },
    });
    expect(meta.openGraph?.images).toEqual([
      { url: "https://shop.example.com/images/products/desk.svg", alt: "Desk" },
    ]);
    expect(meta.twitter).toEqual({
      card: "summary_large_image",
      title: "Desk",
      description: "A desk.",
      images: ["https://shop.example.com/images/products/desk.svg"],
    });
  });

  test("noindex sets robots and no path means no canonical or OG url", () => {
    const meta = buildMetadata({ title: "Checkout", description: "Pay.", noindex: true });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.alternates).toBeUndefined();
    expect(meta.openGraph).not.toHaveProperty("url");
  });

  test("openGraph always repeats the layout locale (Next merges openGraph shallowly)", () => {
    expect(buildMetadata({ title: "A", description: "B" }).openGraph).toMatchObject({ locale: OG_LOCALE });
    expect(OG_LOCALE).toBe("en_US");
  });

  test.each(["", "   ", "\n\t"])("blank title %p falls back to the site name", (title) => {
    const meta = buildMetadata({ title, description: "B", path: "/x" });
    expect(meta.title).toBe("Northwind Goods");
    expect(meta.openGraph?.title).toBe("Northwind Goods");
    expect(meta.twitter?.title).toBe("Northwind Goods");
  });

  test("indexable pages carry no robots override", () => {
    expect(buildMetadata({ title: "A", description: "B", path: "/a" }).robots).toBeUndefined();
  });

  test("article type is passed through", () => {
    const meta = buildMetadata({ title: "Help", description: "FAQ", path: "/help", type: "article" });
    expect(meta.openGraph).toMatchObject({ type: "article" });
  });

  test("title and description are truncated to 60 and 160 characters", () => {
    const meta = buildMetadata({
      title: "T".repeat(200),
      description: "word ".repeat(100),
      path: "/x",
    });
    expect(String(meta.title).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(String(meta.description).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(meta.openGraph?.title).toBe(meta.title as string);
  });
});
