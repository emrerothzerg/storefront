import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";

import { FAQ_ENTRIES, type FaqEntry } from "@/content/faq";
import { isAllowedInternalHref } from "@/content/routes";

import Page, { metadata } from "./page";
import { groupFaqEntries, loadFaqPage } from "./_lib/faq-page";

afterEach(cleanup);

async function renderFaq(search: Record<string, string | string[] | undefined> = {}) {
  return render(await Page({ searchParams: Promise.resolve(search) }));
}

interface LdQuestion {
  "@type": string;
  name: string;
  acceptedAnswer: { "@type": string; text: string };
}

function ldDocs(container: HTMLElement): Record<string, unknown>[] {
  const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
  return scripts.flatMap((s) => {
    const parsed: unknown = JSON.parse(s.textContent ?? "null");
    return (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
  });
}

describe("faq-page logic", () => {
  test("groups cover every entry exactly once, in topic order", () => {
    const groups = groupFaqEntries();
    const flat = groups.flatMap((g) => g.entries.map((e) => e.slug));
    expect(new Set(flat).size).toBe(flat.length);
    expect(new Set(flat)).toEqual(new Set(FAQ_ENTRIES.map((e) => e.slug)));
    for (const g of groups) expect(g.id.startsWith("faq-topic-")).toBe(true);
  });

  test("duplicates are dropped from both the list and the JSON-LD", () => {
    const first = FAQ_ENTRIES[0] as FaqEntry;
    const dup: FaqEntry = { ...first, question: "Duplicate?" };
    const data = loadFaqPage({}, [first, dup]);
    expect(data.entries).toHaveLength(1);
    expect(data.jsonLd.mainEntity).toHaveLength(1);
    expect(data.jsonLd.mainEntity[0]?.name).toBe(first.question);
  });

  test("?open validated against rendered slugs", () => {
    const slug = FAQ_ENTRIES[3]?.slug ?? "";
    expect(loadFaqPage({ open: slug }).openSlug).toBe(slug);
    expect(loadFaqPage({ open: "nope" }).openSlug).toBeUndefined();
    expect(loadFaqPage({ open: ["x".repeat(9999)] }).openSlug).toBeUndefined();
  });
});

describe("/faq page", () => {
  test("metadata via buildMetadata: indexable, canonical /faq", () => {
    expect(metadata.title).toBe("Frequently asked questions");
    expect(String(metadata.alternates?.canonical)).toMatch(/\/faq$/);
    expect(metadata.robots).toBeUndefined();
  });

  test("one h1, breadcrumb Home > FAQ, every entry rendered as <details id=slug>", async () => {
    const { container } = await renderFaq();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(crumbs).toHaveTextContent("Frequently asked questions");
    const ids = Array.from(container.querySelectorAll("details")).map((d) => d.id);
    expect(new Set(ids)).toEqual(new Set(FAQ_ENTRIES.map((e) => e.slug)));
  });

  test("criterion 3: FAQPage JSON-LD matches the visible questions one-to-one, in order", async () => {
    const { container } = await renderFaq();
    const docs = ldDocs(container);
    const faq = docs.find((d) => d["@type"] === "FAQPage");
    const crumbs = docs.find((d) => d["@type"] === "BreadcrumbList");
    expect(faq).toBeDefined();
    expect(crumbs).toBeDefined();
    const questions = (faq?.mainEntity ?? []) as LdQuestion[];

    const details = Array.from(container.querySelectorAll("details"));
    const visible = details.map((d) => (d.querySelector("summary")?.textContent ?? "").trim());
    expect(questions.map((q) => q.name)).toEqual(visible);
    expect(questions).toHaveLength(details.length);

    // Each answer equals the visible answer paragraphs of the same <details>.
    const bySlug = new Map(FAQ_ENTRIES.map((e) => [e.slug, e]));
    details.forEach((d, i) => {
      const entry = bySlug.get(d.id);
      expect(entry).toBeDefined();
      expect(questions[i]?.acceptedAnswer.text).toBe((entry?.answer ?? []).join(" "));
      for (const paragraph of entry?.answer ?? []) expect(d.textContent).toContain(paragraph);
      expect(questions[i]?.["@type"]).toBe("Question");
    });
  });

  test("?open=<slug> opens that entry only; hostile values open nothing", async () => {
    const slug = FAQ_ENTRIES[5]?.slug ?? "";
    const r = await renderFaq({ open: slug });
    expect(Array.from(r.container.querySelectorAll("details[open]")).map((d) => d.id)).toEqual([slug]);
    r.unmount();
    for (const bad of ["<x>", "nope", "", "x".repeat(20_000)]) {
      const h = await renderFaq({ open: bad });
      expect(h.container.querySelectorAll("details[open]")).toHaveLength(0);
      h.unmount();
    }
  });

  test("every href is allowed or a same-page #id that exists; ids are unique", async () => {
    const { container } = await renderFaq();
    const ids = Array.from(container.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const anchors = Array.from(container.querySelectorAll("a[href]"));
    expect(anchors.some((a) => (a.getAttribute("href") ?? "").startsWith("#faq-topic-"))).toBe(true);
    for (const a of anchors) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) expect(container.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
      else expect(isAllowedInternalHref(href)).toBe(true);
    }
  });
});
