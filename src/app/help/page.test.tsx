import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";

import { HELP_TOPICS } from "@/content/help-topics";
import { isAllowedInternalHref } from "@/content/routes";

import Page, { generateMetadata } from "./page";

afterEach(cleanup);

type Params = Record<string, string | string[] | undefined>;

async function renderHelp(params: Params = {}) {
  return render(await Page({ searchParams: Promise.resolve(params) }));
}

function jsonLd(container: HTMLElement): unknown[] {
  return Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map((s) =>
    JSON.parse(s.textContent ?? "null"),
  );
}

function expectSafeLinks(container: HTMLElement) {
  for (const a of Array.from(container.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      expect(container.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
    } else {
      expect(isAllowedInternalHref(href)).toBe(true);
    }
  }
}

describe("/help metadata (criterion 4)", () => {
  test("indexable with canonical /help when there is no query", async () => {
    const meta = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(meta.title).toBe("Help center");
    expect(String(meta.alternates?.canonical)).toMatch(/\/help$/);
    expect(meta.robots).toBeUndefined();
  });

  test.each([["shipping"], [""], ["<script>"], [["a", "b"]]])("?q=%p is noindex", async (q) => {
    const meta = await generateMetadata({ searchParams: Promise.resolve({ q }) });
    expect(meta.robots).toMatchObject({ index: false });
    expect(String(meta.alternates?.canonical)).toMatch(/\/help$/);
  });
});

describe("/help page", () => {
  test("one h1, breadcrumb Home > Help center, topic tiles, BreadcrumbList JSON-LD", async () => {
    const { container } = await renderHelp();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Help center");

    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(crumbs).toHaveTextContent("Help center");

    for (const topic of HELP_TOPICS) {
      const link = container.querySelector(`a[href="/help/${topic.slug}"]`);
      expect(link).not.toBeNull();
      expect(link).toHaveTextContent(topic.title);
    }

    const docs = jsonLd(container);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 1, name: "Home" },
        { position: 2, name: "Help center" },
      ],
    });
    expect(screen.queryByText(/results? for/i)).toBeNull();
    expectSafeLinks(container);
  });

  test("search form is a GET to /help with q, max 100 chars, labelled", async () => {
    const { container } = await renderHelp();
    const form = screen.getByRole("search", { name: "Help" });
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/help");
    const input = within(form).getByLabelText("Search help");
    expect(input).toHaveAttribute("name", "q");
    expect(input).toHaveAttribute("maxlength", "100");
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });

  test("matching query lists results with deep links", async () => {
    const { container } = await renderHelp({ q: "free shipping" });
    expect(screen.getByRole("heading", { level: 2, name: "Results for “free shipping”" })).toBeInTheDocument();
    const section = screen.getByRole("region", { name: /Results for/ });
    const links = within(section).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    expect(links.some((l) => /\?open=[a-z0-9-]+#/.test(l.getAttribute("href") ?? ""))).toBe(true);
    expect(screen.getByLabelText("Search help")).toHaveValue("free shipping");
    expectSafeLinks(container);
  });

  test("criterion 1: garbage, regex and over-long queries render (200) with results or an empty state", async () => {
    const hostile = [
      ".*",
      "(a+)+$",
      "[",
      "\\",
      "<script>alert(1)</script>",
      "\u0000​‮",
      "x".repeat(100_000),
      "%E0%A4%A",
      "\u{1F600}".repeat(200),
      ["a", "b"],
    ];
    for (const q of hostile) {
      const { container, unmount } = await renderHelp({ q });
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      const section = container.querySelector('section[aria-labelledby="help-results-heading"]');
      expect(section).not.toBeNull();
      expect(container.querySelector("script:not([type])")).toBeNull();
      const h2 = section?.querySelector("h2")?.textContent ?? "";
      expect(Array.from(h2).length).toBeLessThan(120);
      unmount();
    }
  });

  test("no matches shows the empty state with the query as text only", async () => {
    const { container } = await renderHelp({ q: "<img src=x onerror=alert(1)>" });
    expect(screen.getByText("No help articles match your search")).toBeInTheDocument();
    expect(screen.getByText("0 results")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("blank query asks for a word", async () => {
    await renderHelp({ q: "   " });
    expect(screen.getByText("Enter a word or phrase to search the help center.")).toBeInTheDocument();
  });
});
