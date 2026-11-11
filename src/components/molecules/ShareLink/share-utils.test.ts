import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildMailtoHref, resolveShareUrl, toWellFormed } from "./share-utils";

function parseMailto(href: string): { subject: string | null; body: string | null; raw: URL } {
  const raw = new URL(href);
  return { subject: raw.searchParams.get("subject"), body: raw.searchParams.get("body"), raw };
}

describe("buildMailtoHref (criterion 1)", () => {
  const url = "https://shop.example.com/products/desk-lamp";

  test("subject is 'Check out <title>', body is '<title>\\n<url>' when no text", () => {
    const href = buildMailtoHref("Desk Lamp", url);
    expect(href.startsWith("mailto:?subject=")).toBe(true);
    const { subject, body } = parseMailto(href);
    expect(subject).toBe("Check out Desk Lamp");
    expect(body).toBe(`Desk Lamp\n${url}`);
  });

  test("text replaces the title in the body", () => {
    const { subject, body } = parseMailto(buildMailtoHref("Lamp", url, "Look at this"));
    expect(subject).toBe("Check out Lamp");
    expect(body).toBe(`Look at this\n${url}`);
  });

  test.each([
    ["ampersand", "Salt & Pepper"],
    ["query chars", "Lamp?subject=pwned&body=x"],
    ["hash", "Mug #1"],
    ["newlines", "Line one\nLine two\r\nthree"],
    ["emoji", "Coffee ☕ Mug 🎉👩‍👩‍👧"],
    ["plus and percent", "100% cotton + wool %20"],
    ["html", "<script>alert(1)</script>"],
  ])("%s survive round-trip and do not add parameters", (_label, title) => {
    const href = buildMailtoHref(title, url);
    const { subject, body, raw } = parseMailto(href);
    expect(subject).toBe(`Check out ${title}`);
    expect(body).toBe(`${title}\n${url}`);
    expect([...raw.searchParams.keys()]).toEqual(["subject", "body"]);
    // Encoded text has no raw separators or whitespace.
    const query = href.slice("mailto:?".length);
    expect(query.split("&")).toHaveLength(2);
    expect(/[\s#?]/.test(query)).toBe(false);
  });

  test("a URL with its own query and hash stays inside the body", () => {
    const tricky = "https://shop.example.com/p/x?ref=a&b=c#reviews";
    const { body, raw } = parseMailto(buildMailtoHref("X", tricky));
    expect(body).toBe(`X\n${tricky}`);
    expect([...raw.searchParams.keys()]).toEqual(["subject", "body"]);
  });

  test("lone surrogates do not throw (replaced with U+FFFD)", () => {
    const broken = "Bad \uD83D name \uDC00";
    expect(() => buildMailtoHref(broken, url)).not.toThrow();
    const { subject } = parseMailto(buildMailtoHref(broken, url));
    expect(subject).toBe("Check out Bad � name �");
  });
});

describe("toWellFormed", () => {
  test("keeps valid pairs and replaces lone halves", () => {
    expect(toWellFormed("ok 🎉")).toBe("ok 🎉");
    expect(toWellFormed("\uD800")).toBe("�");
    expect(toWellFormed("\uDFFFa\uD800")).toBe("�a�");
  });
});

describe("resolveShareUrl", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  });

  test("makes paths absolute", () => {
    expect(resolveShareUrl("/products/x")).toBe("https://shop.example.com/products/x");
    expect(resolveShareUrl("products/x")).toBe("https://shop.example.com/products/x");
  });

  test("keeps absolute http(s) URLs", () => {
    expect(resolveShareUrl("https://cdn.example.com/a")).toBe("https://cdn.example.com/a");
  });

  test("a javascript: value is treated as a path, never as a scheme", () => {
    expect(resolveShareUrl("javascript:alert(1)")).toBe("https://shop.example.com/javascript:alert(1)");
  });
});
