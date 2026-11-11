import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  ROUTE_POLICIES,
  dynamicSitemapRoutes,
  fillRoute,
  isDisallowedPath,
  isDynamicRoute,
  policyFor,
  routeFromPageFile,
  staticSitemapRoutes,
} from "./routes";
import { ROBOTS_DISALLOW } from "./site";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

function pageFilesOnDisk(): string[] {
  const glob = new Bun.Glob("src/app/**/page.tsx");
  return [...glob.scanSync({ cwd: PROJECT_ROOT })].map((f) => f.replace(/\\/g, "/")).sort();
}

describe("criterion 4: policy table vs src/app/**/page.tsx", () => {
  const files = pageFilesOnDisk();

  test("the glob finds pages (sanity)", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain("src/app/page.tsx");
  });

  test("every page on disk has exactly one policy entry", () => {
    const missing = files.filter((file) => ROUTE_POLICIES.filter((p) => p.file === file).length !== 1);
    expect(missing).toEqual([]);
  });

  test("every policy entry has a page on disk", () => {
    const orphans = ROUTE_POLICIES.map((p) => p.file).filter((file) => !files.includes(file));
    expect(orphans).toEqual([]);
  });

  test("each entry's route matches its file and routes are unique", () => {
    for (const policy of ROUTE_POLICIES) expect(routeFromPageFile(policy.file)).toBe(policy.route);
    const routes = ROUTE_POLICIES.map((p) => p.route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe("policy invariants", () => {
  test("indexable routes are exactly the sitemap routes", () => {
    for (const policy of ROUTE_POLICIES) expect(policy.sitemap).toBe(policy.indexing === "indexable");
  });

  test("dynamic sitemap routes name a source; nothing else does", () => {
    for (const policy of ROUTE_POLICIES) {
      const needsSource = policy.sitemap && isDynamicRoute(policy.route);
      expect(policy.sitemapSource !== undefined).toBe(needsSource);
    }
    expect(dynamicSitemapRoutes().map((r) => `${r.route}:${r.source}`).sort()).toEqual([
      "/brand/[slug]:brands",
      "/category/[slug]:categories",
      "/help/[topic]:help-topics",
      "/products/[slug]:products",
    ]);
  });

  test("indexable routes are never disallowed and always have a canonical", () => {
    for (const policy of ROUTE_POLICIES.filter((p) => p.indexing === "indexable")) {
      expect(policy.robotsDisallowed).toBe(false);
      expect(policy.canonical).not.toBe("none");
    }
  });

  test("only /search, /compare and the 15 account/cart/checkout/lists/orders routes are disallowed", () => {
    const disallowed = ROUTE_POLICIES.filter((p) => p.robotsDisallowed).map((p) => p.route);
    expect(disallowed).toHaveLength(17);
    expect(disallowed).not.toContain("/contact");
    expect(disallowed).toContain("/search");
  });

  test("robots.txt disallow list agrees with robotsDisallowed for every route", () => {
    const mismatches = ROUTE_POLICIES.filter(
      (p) => isDisallowedPath(fillRoute(p.route, "sample"), ROBOTS_DISALLOW) !== p.robotsDisallowed,
    ).map((p) => p.route);
    expect(mismatches).toEqual([]);
  });

  test("T127 ruling (+ /contact ruling): /signin, /signup, /contact are noindex, out of the sitemap, crawlable", () => {
    for (const route of ["/signin", "/signup", "/contact"]) {
      expect(policyFor(route)).toMatchObject({ indexing: "noindex", sitemap: false, robotsDisallowed: false });
    }
  });

  test("brief classes: /search noindex-follow; private routes noindex; none in the sitemap", () => {
    expect(policyFor("/search")?.indexing).toBe("noindex-follow");
    const privateRoutes = ROUTE_POLICIES.filter((p) =>
      /^\/(account|cart|checkout|orders|lists|signin|signup|contact)(\/|$)/.test(p.route),
    );
    expect(privateRoutes.length).toBe(18);
    for (const policy of privateRoutes) {
      expect(policy.indexing).toBe("noindex");
      expect(policy.sitemap).toBe(false);
    }
    expect(policyFor("/account/settings")?.indexing).toBe("noindex");
    expect(policyFor("/compare")?.indexing).not.toBe("indexable");
  });

  test("routes whose URL carries a private id or token have no canonical", () => {
    for (const route of ["/orders/[id]", "/orders/[id]/invoice", "/lists/[id]", "/lists/shared/[token]"]) {
      expect(policyFor(route)?.canonical).toBe("none");
    }
  });

  test("faceted listing variants are noindex-follow", () => {
    for (const route of ["/products", "/deals", "/best-sellers", "/new-arrivals", "/top-rated", "/category/[slug]", "/brand/[slug]"]) {
      const variants = policyFor(route)?.variants ?? [];
      expect(variants.length).toBeGreaterThan(0);
      for (const variant of variants.filter((v) => v.description !== "default sort in the URL")) {
        expect(variant.indexing).toBe("noindex-follow");
      }
    }
  });

  test("class counts (documented in README)", () => {
    const count = (indexing: string) => ROUTE_POLICIES.filter((p) => p.indexing === indexing).length;
    expect(ROUTE_POLICIES.length).toBe(39);
    expect(count("indexable")).toBe(19);
    expect(count("noindex-follow")).toBe(2);
    expect(count("noindex")).toBe(18);
  });
});

describe("helpers", () => {
  test("routeFromPageFile", () => {
    expect(routeFromPageFile("src/app/page.tsx")).toBe("/");
    expect(routeFromPageFile("src/app/orders/[id]/invoice/page.tsx")).toBe("/orders/[id]/invoice");
    expect(routeFromPageFile("src/app/(shop)/deals/page.tsx")).toBe("/deals");
    expect(routeFromPageFile("src\\app\\faq\\page.tsx")).toBe("/faq");
  });

  test("fillRoute encodes the slug", () => {
    expect(fillRoute("/products/[slug]", "a b")).toBe("/products/a%20b");
    expect(fillRoute("/faq", "x")).toBe("/faq");
  });

  test("isDisallowedPath is a prefix match and ignores empty rules", () => {
    expect(isDisallowedPath("/account/settings", ["/account"])).toBe(true);
    expect(isDisallowedPath("/accessibility", ["/account"])).toBe(false);
    expect(isDisallowedPath("/anything", [""])).toBe(false);
  });

  test("staticSitemapRoutes starts with home and has no dynamic route", () => {
    const routes = staticSitemapRoutes();
    expect(routes[0]).toBe("/");
    expect(routes.some(isDynamicRoute)).toBe(false);
    expect(routes).toHaveLength(15);
    expect(routes).toContain("/top-rated");
  });
});
