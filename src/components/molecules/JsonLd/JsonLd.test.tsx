import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { breadcrumbListJsonLd, productJsonLd } from "@/lib/seo/json-ld";

import { JsonLd, serializeJsonLd } from "./JsonLd";

const HOSTILE = "</script><script>alert(1)</script><!-- & \u2028";

function product(name: string) {
  return productJsonLd({
    name,
    description: "desc </SCRIPT> & more",
    slug: "evil",
    images: [],
    priceCents: 100,
    currency: "USD",
    stock: 1,
  });
}

describe("serializeJsonLd", () => {
  test("escapes <, > and & as unicode escapes and round-trips through JSON.parse", () => {
    const data = product(HOSTILE);
    const out = serializeJsonLd(data);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("&");
    expect(out).not.toContain("\u2028");
    expect(out).toContain("\\u003c/script\\u003e");
    expect(out).toContain("\\u0026");
    expect(JSON.parse(out)).toEqual(data);
  });
});

describe("JsonLd", () => {
  test("server markup contains exactly one script element; hostile text cannot close it", () => {
    const html = renderToStaticMarkup(<JsonLd data={product(HOSTILE)} />);
    expect(html.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(html.endsWith("</script>")).toBe(true);
    expect(html.match(/<script/gi)).toHaveLength(1);
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(html).not.toContain("<!--");
  });

  test("renders a single object as-is and parses back", () => {
    const data = product(HOSTILE);
    const { container } = render(<JsonLd data={data} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    expect(JSON.parse(script?.textContent ?? "")).toEqual(data);
  });

  test("renders an array as one JSON array", () => {
    const data = [product("A"), breadcrumbListJsonLd([{ name: "Home", path: "/" }])];
    const { container } = render(<JsonLd data={data} />);
    const scripts = container.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(JSON.parse(scripts[0]?.textContent ?? "")).toEqual(data);
  });

  test("a one-element array is unwrapped to the object", () => {
    const data = product("A");
    const { container } = render(<JsonLd data={[data]} />);
    expect(JSON.parse(container.querySelector("script")?.textContent ?? "")).toEqual(data);
  });

  test("an empty array renders nothing", () => {
    const { container } = render(<JsonLd data={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
