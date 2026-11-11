import { afterAll, describe, expect, mock, test } from "bun:test";
import { Suspense, isValidElement, type ReactElement, type ReactNode } from "react";

// next/font/google only works inside the Next compiler; stub it before the
// layout is imported. Only layout.tsx imports it, so the process-wide mock
// does not affect other test files.
mock.module("next/font/google", () => {
  const font = () => ({ variable: "font-stub", className: "font-stub", style: { fontFamily: "stub" } });
  return { Geist: font, Geist_Mono: font };
});

// metadataBase is computed at import time from NEXT_PUBLIC_SITE_URL.
const env = process.env as Record<string, string | undefined>;
const original = env.NEXT_PUBLIC_SITE_URL;
env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com/";

const layoutModule = await import("./layout");
const { metadata } = layoutModule;
const { HeaderShell } = await import("./_layout/HeaderShell");
const { SiteFooter } = await import("@/components/organisms/SiteFooter");
const { ToastProvider } = await import("@/components/atoms/Toast");
const { JsonLd } = await import("@/components/molecules/JsonLd");
const { FOOTER_COLUMNS } = await import("@/content/navigation");
const { SITE_NAME, THEME_COLOR } = await import("@/lib/seo/site");

afterAll(() => {
  if (original === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = original;
});

describe("root layout metadata", () => {
  test("metadataBase, title template, site name and default robots", () => {
    expect(metadata.metadataBase?.toString()).toBe("https://shop.example.com/");
    expect(metadata.title).toEqual({ default: "Northwind Goods", template: "%s | Northwind Goods" });
    expect(metadata.applicationName).toBe("Northwind Goods");
    expect(metadata.openGraph).toMatchObject({ siteName: "Northwind Goods", type: "website", locale: "en_US" });
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(typeof metadata.description).toBe("string");
  });

  test("metadata carries no theme handling (no themeColor/colorScheme; those live in viewport)", () => {
    const loose = metadata as Record<string, unknown>;
    expect(loose.themeColor).toBeUndefined();
    expect(loose.colorScheme).toBeUndefined();
  });

  test("no site-wide canonical (it would be inherited by every page)", () => {
    expect(metadata.alternates).toBeUndefined();
  });
});

describe("root layout viewport (T149, light only)", () => {
  test("themeColor is the single documented primary string from site.ts", () => {
    const { viewport } = layoutModule;
    expect(typeof viewport.themeColor).toBe("string");
    expect(viewport.themeColor).toBe(THEME_COLOR);
  });

  test("no colorScheme and no dual (per-media) themeColor", () => {
    const { viewport } = layoutModule;
    expect(viewport.colorScheme).toBeUndefined();
    expect(Array.isArray(viewport.themeColor)).toBe(false);
    expect(Object.keys(viewport)).toEqual(["themeColor"]);
  });
});

function collect(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child as ReactNode, out);
    return;
  }
  if (!isValidElement(node)) return;
  out.push(node);
  const children = (node.props as { children?: ReactNode }).children;
  if (children !== undefined) collect(children, out);
}

function layoutElements(): ReactElement[] {
  const tree = layoutModule.default({ children: <p>page</p>, params: Promise.resolve({}) } as Parameters<
    typeof layoutModule.default
  >[0]);
  const out: ReactElement[] = [];
  collect(tree, out);
  return out;
}

describe("root layout tree (T80)", () => {
  test("HeaderShell is rendered exactly once, directly (no Suspense boundary anywhere)", () => {
    const elements = layoutElements();
    expect(elements.filter((e) => e.type === HeaderShell)).toHaveLength(1);
    expect(elements.filter((e) => e.type === Suspense)).toHaveLength(0);
  });

  test("ToastProvider wraps header, main and footer", () => {
    const elements = layoutElements();
    const providers = elements.filter((e) => e.type === ToastProvider);
    expect(providers).toHaveLength(1);
    const inside: ReactElement[] = [];
    collect((providers[0]!.props as { children: ReactNode }).children, inside);
    expect(inside.some((e) => e.type === HeaderShell)).toBe(true);
    expect(inside.some((e) => e.type === SiteFooter)).toBe(true);
    expect(inside.some((e) => e.type === "main")).toBe(true);
  });

  test("<main id=\"main\" tabIndex={-1}> holds the page children", () => {
    const mains = layoutElements().filter((e) => e.type === "main");
    expect(mains).toHaveLength(1);
    const props = mains[0]!.props as { id: string; tabIndex: number; children: ReactNode };
    expect(props.id).toBe("main");
    expect(props.tabIndex).toBe(-1);
    expect(isValidElement(props.children) && props.children.type === "p").toBe(true);
  });

  test("SiteFooter gets SITE_NAME and FOOTER_COLUMNS", () => {
    const footers = layoutElements().filter((e) => e.type === SiteFooter);
    expect(footers).toHaveLength(1);
    const props = footers[0]!.props as { storeName?: string; columns?: unknown };
    expect(props.storeName).toBe(SITE_NAME);
    expect(props.columns).toBe(FOOTER_COLUMNS);
  });

  test("Organization + WebSite JSON-LD exactly once", () => {
    const jsonLd = layoutElements().filter((e) => e.type === JsonLd);
    expect(jsonLd).toHaveLength(1);
    const data = (jsonLd[0]!.props as { data: unknown }).data;
    const types = (Array.isArray(data) ? data : [data]).map((d) => (d as { "@type": string })["@type"]);
    expect(types).toEqual(["Organization", "WebSite"]);
  });

  test("no <script> other than the JSON-LD component and no color-scheme meta", () => {
    const elements = layoutElements();
    expect(elements.filter((e) => e.type === "script")).toHaveLength(0);
    expect(elements.filter((e) => e.type === "head")).toHaveLength(0);
    const metas = elements.filter((e) => e.type === "meta");
    expect(metas.filter((e) => /color-scheme|theme-color/i.test(String((e.props as { name?: string }).name)))).toHaveLength(0);
  });

  test("no route-level loading.tsx next to the root layout (SR8)", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(existsSync(join(import.meta.dir, "loading.tsx"))).toBe(false);
  });
});
