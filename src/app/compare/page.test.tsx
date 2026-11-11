import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// next/server, next/headers and the session module are mocked process-wide
// (bun mock.module). Every mock spreads the real module and delegates to it,
// so other test files keep working; the counters prove criterion 4.
// ---------------------------------------------------------------------------

const connection = mock(async (): Promise<void> => undefined);
const realServer = { ...(await import("next/server")) };
const realHeaders = { ...(await import("next/headers")) };
const headerCalls = { cookies: 0 };

mock.module("next/server", () => ({ ...realServer, connection }));
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: (...args: Parameters<typeof realHeaders.cookies>) => {
    headerCalls.cookies += 1;
    return realHeaders.cookies(...args);
  },
}));

const realSession = { ...(await import("@/server/session/session")) };
const sessionCalls = { readSessionId: 0, getOrCreateSessionId: 0 };
mock.module("@/server/session/session", () => ({
  ...realSession,
  readSessionId: async () => {
    sessionCalls.readSessionId += 1;
    return realSession.readSessionId();
  },
  getOrCreateSessionId: async () => {
    sessionCalls.getOrCreateSessionId += 1;
    return realSession.getOrCreateSessionId();
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { SqliteProductRepository } = await import("@/server/catalog/product-repository");
const { isAllowedInternalHref } = await import("@/content/routes");
const { COMPARE_MIN_HINT, COMPARE_TABLE_LABEL } = await import("@/components/organisms/CompareTable");
const { default: Page, metadata } = await import("./page");
const { COMPARE_CAPPED_NOTICE, COMPARE_TITLE, COMPARE_UNAVAILABLE_NOTICE } = await import(
  "./_lib/compare-copy"
);
const { absoluteUrl } = await import("@/lib/seo/site");

closeDatabase();
seedDatabase(getDatabase());

afterAll(() => {
  // Prototype spies are process-wide in bun test: never leak this one into other files.
  getDetailBySlug.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const getDetailBySlug = spyOn(SqliteProductRepository.prototype, "getDetailBySlug");

beforeEach(() => {
  headerCalls.cookies = 0;
  sessionCalls.readSessionId = 0;
  sessionCalls.getOrCreateSessionId = 0;
});

afterEach(() => {
  getDetailBySlug.mockClear();
  connection.mockClear();
});

type Params = Record<string, string | string[] | undefined>;

async function renderPage(searchParams?: Params) {
  return render(await Page(searchParams === undefined ? {} : { searchParams: Promise.resolve(searchParams) }));
}

function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
}

function removeLinks(): HTMLElement[] {
  return screen.queryAllByRole("link", { name: /^Remove .* from comparison$/ });
}

function changes(): number {
  return getDatabase().query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

function expectShell(container: HTMLElement): void {
  const h1 = screen.getAllByRole("heading", { level: 1 });
  expect(h1).toHaveLength(1);
  expect(h1[0]).toHaveTextContent(COMPARE_TITLE);
  const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
  expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  expect(within(crumbs).getByText("Compare")).toBeInTheDocument();
  expect(container.querySelector("main")).toBeNull();
  for (const href of hrefs(container)) expect([href, isAllowedInternalHref(href)]).toEqual([href, true]);
}

/** CONS-B4 (aw): with < 2 products CompareTable's notice is the only guidance; no page intro line. */
function expectGuidanceOnly(container: HTMLElement): void {
  expect(screen.getByText(COMPARE_MIN_HINT)).toBeInTheDocument();
  expect(container.textContent).not.toContain("Pick at least two");
  expect(container.textContent).not.toMatch(/Comparing \d+ products/);
  expect(container.querySelector("[data-compare-count]")).not.toBeNull();
}

describe("ComparePage: two or more products", () => {
  test("renders the table with both products, add-to-cart forms and the guidance-free intro", async () => {
    const { container } = await renderPage({ p: ["walnut-desk", "canvas-tote-bag"] });
    expectShell(container);
    expect(screen.getByRole("table", { name: COMPARE_TABLE_LABEL })).toBeInTheDocument();
    expect(screen.getByText("Comparing 2 products.")).toBeInTheDocument();
    expect(screen.queryByText(COMPARE_MIN_HINT)).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Add to cart for / }).length).toBeGreaterThan(0);
    expect(container.querySelectorAll("form").length).toBeGreaterThan(0);
    expect(connection).toHaveBeenCalled();
  });

  test("Remove link rebuilds the URL without that slug (criterion 2)", async () => {
    await renderPage({ p: ["walnut-desk", "canvas-tote-bag", "brass-desk-lamp"] });
    expect(removeLinks().map((a) => a.getAttribute("href"))).toEqual([
      "/compare?p=canvas-tote-bag&p=brass-desk-lamp",
      "/compare?p=walnut-desk&p=brass-desk-lamp",
      "/compare?p=walnut-desk&p=canvas-tote-bag",
    ]);
  });

  test("dropped slugs never reappear in links (criterion 1+2)", async () => {
    const { container } = await renderPage({
      p: ["ghost", "walnut-desk", "../etc", "walnut-desk", "%2e%2e", "canvas-tote-bag", "a/b"],
    });
    expect(removeLinks()).toHaveLength(2);
    const joined = hrefs(container).join(" ");
    for (const bad of ["ghost", "etc", "%2e", "a%2Fb"]) expect(joined).not.toContain(bad);
    expect(removeLinks()[0]).toHaveAttribute("href", "/compare?p=canvas-tote-bag");
  });

  test("more than 4 slugs are capped in order", async () => {
    await renderPage({
      p: ["walnut-desk", "canvas-tote-bag", "brass-desk-lamp", "cork-yoga-mat", "enamel-pin-set", "bike-light-set"],
    });
    expect(removeLinks()).toHaveLength(4);
    expect(screen.getByText("Comparing 4 products.")).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    expect(removeLinks()[3]).toHaveAttribute("href", "/compare?p=walnut-desk&p=canvas-tote-bag&p=brass-desk-lamp");
  });

  test("differences-only toggle works via the query (criterion 3)", async () => {
    const off = await renderPage({ p: ["walnut-desk", "canvas-tote-bag"] });
    const showDiff = screen.getByRole("link", { name: "Show differences only" });
    expect(showDiff).toHaveAttribute("href", "/compare?p=walnut-desk&p=canvas-tote-bag&diff=1");
    const rowsOff = off.container.querySelectorAll("tbody tr").length;
    off.unmount();

    const on = await renderPage({ p: ["walnut-desk", "canvas-tote-bag"], diff: "1" });
    expect(screen.getByRole("link", { name: "Show all details" })).toHaveAttribute(
      "href",
      "/compare?p=walnut-desk&p=canvas-tote-bag",
    );
    expect(removeLinks()[0]).toHaveAttribute("href", "/compare?p=canvas-tote-bag&diff=1");
    expect(on.container.querySelectorAll("tbody tr").length).toBeLessThanOrEqual(rowsOff);
  });

  test("diff other than \"1\" is off", async () => {
    await renderPage({ p: ["walnut-desk", "canvas-tote-bag"], diff: "true" });
    expect(screen.getByRole("link", { name: "Show differences only" })).toBeInTheDocument();
  });

  test("specs union rows come from the products' spec maps", async () => {
    const { container } = await renderPage({ p: ["walnut-desk", "canvas-tote-bag"] });
    const rows = Array.from(container.querySelectorAll("tbody tr[data-row^='spec-']"));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("ComparePage: fewer than two products (criterion 1)", () => {
  test("no params: 200 with guidance and a /products link", async () => {
    const { container } = await renderPage();
    expectShell(container);
    expectGuidanceOnly(container);
    expect(hrefs(container)).toContain("/products");
    expect(screen.queryByRole("table")).toBeNull();
    expect(getDetailBySlug).not.toHaveBeenCalled();
  });

  test("exactly one valid product keeps its Remove link (back to bare /compare, no ghosts)", async () => {
    const { container } = await renderPage({ p: ["walnut-desk", "ghost", "canvas-tote-bag-x"], diff: "0" });
    expectShell(container);
    expectGuidanceOnly(container);
    const links = removeLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/compare");
  });

  test.each<[string, Params]>([
    ["path traversal", { p: "../etc" }],
    ["encoded dots", { p: "%2e%2e" }],
    ["slash", { p: "a/b" }],
    ["10k chars", { p: "x".repeat(10_000) }],
    ["1 MB", { p: "a".repeat(1024 * 1024) }],
    ["500 params", { p: Array.from({ length: 500 }, (_, i) => `ghost-${i}`) }],
    ["upper case", { p: ["WALNUT-DESK", "Canvas-Tote-Bag"] }],
  ])("hostile input (%s) never throws and shows guidance", async (_label, params) => {
    const { container } = await renderPage(params);
    expectShell(container);
    expectGuidanceOnly(container);
    expect(removeLinks()).toHaveLength(0);
  });

  test("arrays of arrays (untyped garbage) never throw", async () => {
    const garbage: unknown = { p: [["walnut-desk"], [["canvas-tote-bag"]], { x: 1 }, 7, null], diff: [["1"]] };
    // Next never produces this shape; cast through unknown to probe the parser.
    const { container } = await renderPage(garbage as Params);
    expectShell(container);
    expectGuidanceOnly(container);
  });
});

describe("ComparePage: notices", () => {
  test("no notice when every selection resolves", async () => {
    const { container } = await renderPage({ p: ["walnut-desk", "canvas-tote-bag"] });
    expect(container.querySelector("[data-compare-notice]")).toBeNull();
  });

  test("unknown/unpublished/malformed selections raise one notice without echoing values", async () => {
    getDatabase().run("UPDATE products SET published_at = ? WHERE slug = 'brass-desk-lamp'", [
      new Date(Date.now() + 86_400_000).toISOString(),
    ]);
    try {
      const { container } = await renderPage({
        p: ["walnut-desk", "ghost-slug", "brass-desk-lamp", "<script>alert(1)</script>", "canvas-tote-bag"],
      });
      expect(screen.getByText(COMPARE_UNAVAILABLE_NOTICE)).toBeInTheDocument();
      expect(container.querySelectorAll("[data-compare-notice]")).toHaveLength(1);
      expect(removeLinks()).toHaveLength(2);
      const html = container.innerHTML;
      expect(html).not.toContain("ghost-slug");
      expect(html).not.toContain("brass-desk-lamp");
      expect(html).not.toContain("<script>");
      expect(container.querySelector("script")).toBeNull();
    } finally {
      getDatabase().run("UPDATE products SET published_at = '2020-01-01T00:00:00.000Z' WHERE slug = 'brass-desk-lamp'");
    }
  });

  test("more than 4 selections raise the cap notice", async () => {
    await renderPage({ p: "walnut-desk,canvas-tote-bag,brass-desk-lamp,cork-yoga-mat,enamel-pin-set" });
    expect(screen.getByText(COMPARE_CAPPED_NOTICE)).toBeInTheDocument();
    expect(removeLinks()).toHaveLength(4);
  });

  test("comma form ?p=a,b renders the table; links are rebuilt in the repeated form", async () => {
    await renderPage({ p: "walnut-desk,canvas-tote-bag" });
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(removeLinks()[0]).toHaveAttribute("href", "/compare?p=canvas-tote-bag");
  });
});

describe("ComparePage: no-JS shape (renderToStaticMarkup)", () => {
  test("add-to-cart is a real <form> with hidden productId, quantity=1 and a submit button", async () => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ p: ["walnut-desk", "canvas-tote-bag"] }) }));
    const doc = new DOMParser().parseFromString(html, "text/html");
    const forms = Array.from(doc.querySelectorAll("form"));
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form.querySelector('input[type="hidden"][name="productId"]')?.getAttribute("value")).toMatch(/^prod_/);
      expect(form.querySelector('input[type="hidden"][name="quantity"]')?.getAttribute("value")).toBe("1");
      expect(form.querySelector('button[type="submit"]')?.textContent).toMatch(/^Add to cart for /);
      // Never trust the client for price or session (SR9).
      expect(form.querySelector('[name*="price" i], [name*="session" i]')).toBeNull();
    }
    // Remove/toggle are plain links (work without JS).
    expect(doc.querySelectorAll('a[href^="/compare?"]').length).toBeGreaterThan(0);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
  });
});

describe("ComparePage: hostile values", () => {
  test.each<[string, Params]>([
    ["script tag", { p: "<script>alert(1)</script>" }],
    ["control chars", { p: ["walnut-desk\u0000", "\u0007canvas-tote-bag", "a\u001fb"] }],
    ["duplicates only", { p: ["walnut-desk", "walnut-desk", "walnut-desk"] }],
    ["10k comma list", { p: Array.from({ length: 10_000 }, () => "<x>").join(",") }],
  ])("%s renders the safe guidance state", async (_label, params) => {
    const { container } = await renderPage(params);
    expectShell(container);
    expectGuidanceOnly(container);
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("ComparePage: stateless (criterion 4)", () => {
  test("never reads cookies or the session, and writes nothing", async () => {
    const before = changes();
    await renderPage({ p: ["walnut-desk", "canvas-tote-bag", "ghost"], diff: "1" });
    await renderPage({ p: "walnut-desk" });
    await renderPage();
    expect(headerCalls.cookies).toBe(0);
    expect(sessionCalls).toEqual({ readSessionId: 0, getOrCreateSessionId: 0 });
    expect(changes()).toBe(before);
  });

  test("page module has no \"use client\" directive", async () => {
    const source = await Bun.file(new URL("./page.tsx", import.meta.url)).text();
    expect(source).not.toMatch(/["']use client["']/);
  });
});

describe("metadata", () => {
  test("noindex but follow, title set, canonical is the bare /compare", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.title).toBe(COMPARE_TITLE);
    expect(metadata.alternates?.canonical).toBe(absoluteUrl("/compare"));
    expect(JSON.stringify(metadata)).not.toContain("?p=");
  });
});
