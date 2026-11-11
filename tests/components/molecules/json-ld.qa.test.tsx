import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// QA-W0-S criterion 4: <JsonLd> escaping, array handling, round-trip.
// ---------------------------------------------------------------------------

import { JsonLd, serializeJsonLd } from "@/components/molecules/JsonLd/JsonLd";
import { productJsonLd, type JsonLdThing } from "@/lib/seo/json-ld";

const UNSAFE = new RegExp("[<>&\\u2028\\u2029]");
const HOSTILE = "</script><script>alert(1)</script>";

function thing(extra: Record<string, unknown>): JsonLdThing {
  return { "@context": "https://schema.org", "@type": "Thing", ...extra };
}

describe("C4 serializeJsonLd", () => {
  test.each([
    ["<", "\\u003c"],
    [">", "\\u003e"],
    ["&", "\\u0026"],
    ["\u2028", "\\u2028"],
    ["\u2029", "\\u2029"],
  ])("escapes %p as %p", (char, escaped) => {
    const out = serializeJsonLd(thing({ name: `a${char}b` }));
    expect(out).toContain(`a${escaped}b`);
    expect(out.includes(char)).toBe(false);
  });

  test("output contains no raw <, >, &, U+2028, U+2029 for a nasty payload", () => {
    const nasty = thing({
      name: `${HOSTILE} <!-- --> <![CDATA[ ]]> & \u2028\u2029 "quoted" \\ back`,
      nested: { list: [HOSTILE, { deep: "</SCRIPT >" }] },
    });
    const out = serializeJsonLd(nasty);
    expect(out).not.toMatch(UNSAFE);
    expect(JSON.parse(out)).toEqual(nasty);
  });

  test("round-trips arrays and unicode", () => {
    const data = [thing({ name: "\u{1F600} café \u0000" }), thing({ n: 1.5, b: true, z: null })];
    expect(JSON.parse(serializeJsonLd(data))).toEqual(data);
  });
});

describe("C4 <JsonLd>", () => {
  test("hostile product name cannot close the script tag (SSR markup)", () => {
    const product = productJsonLd({
      name: HOSTILE,
      description: `<img src=x onerror=alert(1)> & ${HOSTILE}`,
      slug: "x",
      images: [],
      priceCents: 100,
      currency: "USD",
      stock: 1,
    });
    const html = renderToStaticMarkup(<JsonLd data={product} />);
    // Exactly one opening and one closing script tag.
    expect(html.match(/<script/gi)?.length).toBe(1);
    expect(html.match(/<\/script/gi)?.length).toBe(1);
    expect(html.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(html.endsWith("</script>")).toBe(true);
    const body = html.slice('<script type="application/ld+json">'.length, -"</script>".length);
    expect(body).not.toMatch(/[<>]/);
    expect(JSON.parse(body)).toEqual(product);
  });

  test("hostile name in the DOM yields one script whose text parses to the same object", () => {
    const data = thing({ name: HOSTILE });
    const { container } = render(<JsonLd data={data} />);
    const scripts = container.querySelectorAll("script");
    expect(scripts.length).toBe(1);
    expect(scripts[0]?.getAttribute("type")).toBe("application/ld+json");
    expect(JSON.parse(scripts[0]?.textContent ?? "")).toEqual(data);
  });

  test("empty array renders nothing", () => {
    expect(renderToStaticMarkup(<JsonLd data={[]} />)).toBe("");
    const { container } = render(<JsonLd data={[]} />);
    expect(container.innerHTML).toBe("");
  });

  test("single-element array is unwrapped to an object", () => {
    const one = thing({ name: "one" });
    const html = renderToStaticMarkup(<JsonLd data={[one]} />);
    const body = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    const parsed: unknown = JSON.parse(body);
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed).toEqual(one);
  });

  test("multi-element array renders one script with a JSON array", () => {
    const list = [thing({ name: "a" }), thing({ name: "b" })];
    const html = renderToStaticMarkup(<JsonLd data={list} />);
    expect(html.match(/<script/g)?.length).toBe(1);
    const body = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(JSON.parse(body)).toEqual(list);
  });
});
