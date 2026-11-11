import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";

import { getFaqEntries } from "@/content/faq";
import { HELP_TOPICS, getHelpTopic } from "@/content/help-topics";
import { isAllowedInternalHref } from "@/content/routes";

import Page, { generateMetadata } from "./page";
import { loadHelpTopicPage, resolveHelpTopic } from "./_lib/help-topic-page";

afterEach(cleanup);

function props(topic: string, search: Record<string, string | string[] | undefined> = {}) {
  return { params: Promise.resolve({ topic }), searchParams: Promise.resolve(search) };
}

async function renderTopic(topic: string, search: Record<string, string | string[] | undefined> = {}) {
  return render(await Page(props(topic, search)));
}

/** notFound() throws; under bun's process-wide mocks it may be a test sentinel instead of Next's error. */
async function expectNotFound(topic: string, search: Record<string, string> = {}) {
  let thrown: unknown = null;
  try {
    await Page(props(topic, search));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const digest = (thrown as { digest?: unknown }).digest;
  if (typeof digest === "string") expect(digest).toContain("404");
}

describe("resolveHelpTopic / loadHelpTopicPage", () => {
  test("known topics resolve; anything else is null", () => {
    expect(resolveHelpTopic("shipping")?.slug).toBe("shipping");
    for (const bad of ["", "Shipping", "../faq", "%2e%2e", "shipping/", "constructor", "__proto__", "x".repeat(5000), undefined, 7]) {
      expect(resolveHelpTopic(bad)).toBeNull();
    }
  });

  test("?open must be one of the topic's entries", () => {
    const shipping = getHelpTopic("shipping");
    const first = shipping?.faqSlugs[0] ?? "";
    expect(loadHelpTopicPage("shipping", { open: first })?.openSlug).toBe(first);
    const otherTopicSlug = getHelpTopic("payments")?.faqSlugs[0] ?? "";
    expect(loadHelpTopicPage("shipping", { open: otherTopicSlug })?.openSlug).toBeUndefined();
    expect(loadHelpTopicPage("shipping", { open: "<x>" })?.openSlug).toBeUndefined();
    expect(loadHelpTopicPage("nope", {})).toBeNull();
  });
});

describe("/help/[topic] page", () => {
  test("criterion 1: unknown or hostile topics 404", async () => {
    for (const bad of ["nope", "SHIPPING", "..", "%3Cscript%3E", "x".repeat(3000), "constructor"]) {
      await expectNotFound(bad);
    }
  });

  test.each(HELP_TOPICS.map((t) => [t.slug]))("%s renders one h1, breadcrumb, FAQ items with id=slug", async (slug) => {
    const topic = getHelpTopic(slug);
    if (topic === undefined) throw new Error("missing topic");
    const { container } = await renderTopic(slug);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(topic.title);

    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(crumbs).getByRole("link", { name: "Help center" })).toHaveAttribute("href", "/help");

    const entries = getFaqEntries(topic.faqSlugs);
    const details = Array.from(container.querySelectorAll("details"));
    expect(details.map((d) => d.id)).toEqual(entries.map((e) => e.slug));
    expect(details.every((d) => !d.open)).toBe(true);

    expect(container.querySelector(`a[href="/contact?topic=${slug}"]`)).not.toBeNull();

    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.textContent ?? "null");
    expect(ld).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [{ name: "Home" }, { name: "Help center" }, { name: topic.title }],
    });
    expect(String(ld.itemListElement[2].item)).toMatch(new RegExp(`/help/${slug}$`));

    for (const a of Array.from(container.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) expect(container.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
      else expect(isAllowedInternalHref(href)).toBe(true);
    }
  });

  test("?open=<slug> opens exactly that entry; hostile open values are ignored", async () => {
    const topic = getHelpTopic("returns");
    const target = topic?.faqSlugs[1] ?? "";
    const { container, unmount } = await renderTopic("returns", { open: target });
    const open = Array.from(container.querySelectorAll("details")).filter((d) => d.open);
    expect(open.map((d) => d.id)).toEqual([target]);
    unmount();

    for (const bad of ["nope", "\"><script>", "x".repeat(10_000), ""]) {
      const r = await renderTopic("returns", { open: bad });
      expect(Array.from(r.container.querySelectorAll("details")).some((d) => d.open)).toBe(false);
      r.unmount();
    }
  });

  test("metadata: canonical per topic; unknown topic is noindex without a canonical", async () => {
    const meta = await generateMetadata(props("shipping"));
    expect(meta.title).toBe("Shipping and delivery help");
    expect(String(meta.alternates?.canonical)).toMatch(/\/help\/shipping$/);
    expect(meta.robots).toBeUndefined();

    const missing = await generateMetadata(props("nope"));
    expect(missing.robots).toMatchObject({ index: false });
    expect(missing.alternates).toBeUndefined();
  });
});
