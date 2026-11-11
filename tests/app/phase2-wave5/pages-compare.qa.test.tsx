/**
 * T104a — QA wave 5, page-level: Compare `/compare` (T100). QA-owned.
 * Criteria: T104 1, 7 (+ T100 1–4 and the brief's hostile-param list).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  duplicateFormNames,
  duplicateIds,
  harness,
  headingViolations,
  hrefViolations,
  installNextMocks,
  isRealPostForm,
  parseHtml,
  resetCookies,
  serverLike,
  smallSubmitButtons,
  totalChanges,
} from "./_harness";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const dbClient = await import("@/server/db/client");
const { closeDatabase, getDatabase } = dbClient;
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const currentUser = await import("@/server/session/current-user");
const { isAllowedInternalHref } = await import("@/content/routes");
const { SqliteProductRepository } = await import("@/server/catalog/product-repository");
const cartActions = await import("@/app/actions/cart");
const { default: ComparePage, metadata } = await import("@/app/compare/page");
type RawSearchParams = import("@/app/compare/_lib/compare-params").RawSearchParams;

const spies = {
  readSessionId: spyOn(session, "readSessionId"),
  getOrCreateSessionId: spyOn(session, "getOrCreateSessionId"),
  readCurrentUser: spyOn(currentUser, "readCurrentUser"),
};
const getDetailBySlug = spyOn(SqliteProductRepository.prototype, "getDetailBySlug");

let slugs: string[] = [];

async function renderCompare(searchParams: unknown) {
  const element = await ComparePage({ searchParams: Promise.resolve(searchParams as RawSearchParams) });
  const html = renderToStaticMarkup(element);
  return { html, doc: parseHtml(html) };
}

function notices(doc: Document): string[] {
  return [...doc.querySelectorAll("[data-compare-notice]")].map((n) => n.getAttribute("data-compare-notice") ?? "");
}

function count(doc: Document): number {
  return Number(doc.querySelector("[data-compare-count]")?.getAttribute("data-compare-count") ?? "-1");
}

function compareLinks(doc: Document): string[] {
  return [...doc.querySelectorAll("a[href^='/compare']")].map((a) => a.getAttribute("href") ?? "");
}

beforeAll(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  slugs = getDatabase()
    .query<{ slug: string }, []>("SELECT slug FROM products WHERE stock > 0 ORDER BY slug LIMIT 6")
    .all()
    .map((r) => r.slug);
  expect(slugs).toHaveLength(6);
});

beforeEach(() => {
  resetCookies({ [session.SESSION_COOKIE_NAME]: "a1a1a1a1-3333-4333-8333-00000000000a", [session.AUTH_COOKIE_NAME]: "y".repeat(43) });
  for (const spy of Object.values(spies)) spy.mockClear();
  getDetailBySlug.mockClear();
});

afterAll(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
  getDetailBySlug.mockRestore();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
});

describe("compare — selection forms (T100-1/2)", () => {
  test("p=a,b and p=a&p=b give identical output; links use the repeated form", async () => {
    const [a, b] = slugs as [string, string];
    const comma = await renderCompare({ p: `${a},${b}` });
    const repeated = await renderCompare({ p: [a, b] });
    expect(comma.html).toBe(repeated.html);
    expect(count(comma.doc)).toBe(2);
    const links = compareLinks(comma.doc);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      expect(href).not.toContain(",");
      expect(href.toLowerCase()).not.toContain("%2c");
    }
    expect(links).toContain(`/compare?p=${b}`);
  });

  test("unknown and unpublished slugs are dropped with the 'unavailable' notice, never echoed", async () => {
    const db = getDatabase();
    const [a, b, c] = slugs as [string, string, string];
    const prev = db.query<{ published_at: string }, [string]>("SELECT published_at FROM products WHERE slug = ?").get(c)?.published_at ?? "";
    db.query("UPDATE products SET published_at = ? WHERE slug = ?").run(new Date(Date.now() + 86_400_000).toISOString(), c);
    try {
      const { doc, html } = await renderCompare({ p: [a, "qa-ghost-slug", c, b] });
      expect(count(doc)).toBe(2);
      expect(notices(doc)).toEqual(["unavailable"]);
      expect(html).not.toContain("qa-ghost-slug");
      expect(compareLinks(doc).join(" ")).not.toContain(c);
    } finally {
      db.query("UPDATE products SET published_at = ? WHERE slug = ?").run(prev, c);
    }
  });

  test("more than 4 -> first 4 shown with the 'capped' notice", async () => {
    const { doc } = await renderCompare({ p: slugs });
    expect(count(doc)).toBe(4);
    expect(notices(doc)).toEqual(["capped"]);
    for (const s of slugs.slice(4)) expect(compareLinks(doc).join(" ")).not.toContain(`p=${s}`);
  });

  test("fewer than 2 valid -> guidance (200), no table", async () => {
    const { doc } = await renderCompare({ p: slugs[0] ?? "" });
    expect(count(doc)).toBe(1);
    expect(doc.body.textContent).toContain("Add at least two products to compare");
  });
});

describe("compare — hostile p values never throw and never reach the DB", () => {
  const nul = String.fromCharCode(0);
  const cases: Array<[string, unknown]> = [
    ["10k chars", { p: "a".repeat(10_000) }],
    ["1 MB", { p: "b".repeat(1024 * 1024) }],
    ["1 MB of commas", { p: ",".repeat(1024 * 1024) }],
    ["500 hostile params", { p: Array.from({ length: 500 }, (_, i) => `<x${i}>`) }],
    ["script tags", { p: ["<script>alert(1)</script>", "\"><img src=x onerror=alert(1)>"] }],
    ["control characters", { p: [`abc${nul}def`, "a\u0007b", "line\nbreak", "tab\tbed"] }],
    ["nested arrays", { p: [["walnut-desk"], [["x"]]] }],
    ["objects and numbers", { p: [{ toString: () => "walnut-desk" }, 42, null, true] }],
    ["path traversal", { p: ["../../etc/passwd", "..%2F..%2F", "%2e%2e", "a/b", "..\\..\\win"] }],
    ["upper case and unicode", { p: ["WALNUT-DESK", "café", "‮rlo"] }],
    ["prototype keys", JSON.parse('{"__proto__": {"p": "walnut-desk"}, "constructor": "x"}') as unknown],
    ["non-object params", "p=walnut-desk"],
    ["null params", null],
  ];

  test.each(cases)("%s", async (_name, params) => {
    const getDb = spyOn(dbClient, "getDatabase");
    let dbCalls = -1;
    let doc: Document;
    try {
      ({ doc } = await renderCompare(params));
      dbCalls = getDb.mock.calls.length;
    } finally {
      getDb.mockRestore();
    }
    expect(dbCalls).toBe(0);
    expect(getDetailBySlug).not.toHaveBeenCalled();
    expect(count(doc)).toBe(0);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("img[src='x']")).toBeNull();
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
  });

  test("500 slug-shaped unknown values: bounded lookups (<= 16), capped/unavailable notices, no throw", async () => {
    const before = totalChanges(getDatabase());
    const { doc } = await renderCompare({ p: Array.from({ length: 500 }, (_, i) => `qa-unknown-${i}`) });
    expect(getDetailBySlug.mock.calls.length).toBeLessThanOrEqual(16);
    expect(getDetailBySlug.mock.calls.length).toBeGreaterThan(0); // positive control: the spy sees catalog reads
    expect(count(doc)).toBe(0);
    expect(notices(doc)).toContain("unavailable");
    expect(totalChanges(getDatabase())).toBe(before);
  });

  test("100 random query shapes never throw", async () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = ["a", "-", ",", "<", ">", "/", ".", "%", "0", "Z", " ", "\u0000", "é", ...slugs];
    for (let i = 0; i < 100; i += 1) {
      const n = Math.floor(rnd() * 8);
      const values = Array.from({ length: n }, () =>
        Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => alphabet[Math.floor(rnd() * alphabet.length)] ?? "").join(""),
      );
      const params = rnd() < 0.5 ? { p: values, diff: rnd() < 0.5 ? "1" : ["1", "0"] } : { p: values.join(",") };
      const { doc } = await renderCompare(params);
      expect(count(doc)).toBeLessThanOrEqual(4);
    }
  });
});

describe("compare — forms, metadata, cookies, a11y (T100-4, T104-7)", () => {
  test("add-to-cart forms are real POST forms with hidden productId and quantity=1", async () => {
    const restore = serverLike([cartActions.addToCart]);
    try {
      const { doc } = await renderCompare({ p: slugs.slice(0, 3) });
      const forms = [...doc.querySelectorAll("form")].filter((f) => (f.getAttribute("method") ?? "").toLowerCase() !== "get");
      expect(forms).toHaveLength(3);
      const ids = new Set(getDatabase().query<{ id: string }, []>("SELECT id FROM products").all().map((r) => r.id));
      for (const form of forms) {
        expect(isRealPostForm(form)).toBe(true);
        const productId = form.querySelector<HTMLInputElement>("input[type='hidden'][name='productId']")?.getAttribute("value") ?? "";
        expect(ids.has(productId)).toBe(true);
        expect(form.querySelector("input[name='quantity']")?.getAttribute("value")).toBe("1");
      }
      expect(smallSubmitButtons(doc)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("robots index:false, follow:true; canonical is the bare /compare", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(String(metadata.alternates?.canonical ?? "")).toMatch(/\/compare$/);
  });

  test("never reads cookies or the session, never writes", async () => {
    const before = totalChanges(getDatabase());
    await renderCompare({ p: slugs.slice(0, 2), diff: "1" });
    expect(harness.cookieReads).toBe(0);
    expect(spies.readSessionId).not.toHaveBeenCalled();
    expect(spies.getOrCreateSessionId).not.toHaveBeenCalled();
    expect(spies.readCurrentUser).not.toHaveBeenCalled();
    expect(harness.store.writes).toEqual([]);
    expect(totalChanges(getDatabase())).toBe(before);
  });

  test("one h1, no skipped levels, unique ids and form names, allow-listed hrefs (with and without diff)", async () => {
    for (const params of [{ p: slugs.slice(0, 4) }, { p: slugs.slice(0, 4), diff: "1" }, {}]) {
      const { doc } = await renderCompare(params);
      expect(headingViolations(doc)).toEqual([]);
      expect(duplicateIds(doc)).toEqual([]);
      expect(duplicateFormNames(doc)).toEqual([]);
      expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    }
  });
});
