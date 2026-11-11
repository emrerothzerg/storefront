import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { POLICY_PAGES, POLICY_SLUGS, SAMPLE_POLICY_NOTICE, type PolicySlug } from "@/content/policies";
import { isAllowedInternalHref } from "@/content/routes";

import AboutPage, { metadata as aboutMeta } from "../about/page";
import AccessibilityPage, { metadata as accessibilityMeta } from "../accessibility/page";
import PrivacyPage, { metadata as privacyMeta } from "../privacy/page";
import ReturnsPage, { metadata as returnsMeta } from "../returns/page";
import ShippingPage, { metadata as shippingMeta } from "../shipping/page";
import TermsPage, { metadata as termsMeta } from "../terms/page";
import { policyBreadcrumb, policyBreadcrumbJsonLd, policyDescription, policyMetadata } from "./policy-page";

afterEach(cleanup);

const ROUTES: Record<PolicySlug, { Page: () => ReactElement; metadata: Metadata }> = {
  about: { Page: AboutPage, metadata: aboutMeta },
  shipping: { Page: ShippingPage, metadata: shippingMeta },
  returns: { Page: ReturnsPage, metadata: returnsMeta },
  privacy: { Page: PrivacyPage, metadata: privacyMeta },
  terms: { Page: TermsPage, metadata: termsMeta },
  accessibility: { Page: AccessibilityPage, metadata: accessibilityMeta },
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("policy-page helpers", () => {
  test("description skips the sample notice", () => {
    for (const slug of POLICY_SLUGS) {
      const d = policyDescription(POLICY_PAGES[slug]);
      expect(d).not.toBe(SAMPLE_POLICY_NOTICE);
      expect(d.length).toBeGreaterThan(20);
    }
  });

  test("breadcrumb and JSON-LD: Home > title", () => {
    const page = POLICY_PAGES.terms;
    expect(policyBreadcrumb(page)).toEqual([{ label: "Home", href: "/" }, { label: page.title }]);
    const ld = policyBreadcrumbJsonLd(page);
    expect(ld.itemListElement.map((i) => i.name)).toEqual(["Home", page.title]);
    expect(String(ld.itemListElement[1]?.item)).toMatch(/\/terms$/);
  });
});

describe.each(POLICY_SLUGS.map((slug) => [slug]))("/%s (T102)", (slug) => {
  const page = POLICY_PAGES[slug];
  const { Page, metadata } = ROUTES[slug];

  test("metadata via buildMetadata with canonical, indexable", () => {
    expect(metadata).toEqual(policyMetadata(slug));
    expect(String(metadata.alternates?.canonical)).toMatch(new RegExp(`/${slug}$`));
    expect(metadata.robots).toBeUndefined();
    expect(typeof metadata.description).toBe("string");
  });

  test("criterion 1: one h1, breadcrumb, sample notice, last updated, sections", () => {
    const { container } = render(<Page />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(page.title);

    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(crumbs).toHaveTextContent(page.title);

    expect(screen.getByRole("status")).toHaveTextContent(SAMPLE_POLICY_NOTICE);
    expect(container.querySelector(`time[datetime="${page.lastUpdated}"]`)).not.toBeNull();
    for (const section of page.sections) {
      expect(screen.getByRole("heading", { level: 2, name: section.heading })).toBeInTheDocument();
    }

    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.textContent ?? "null");
    expect(ld).toMatchObject({ "@type": "BreadcrumbList", itemListElement: [{ name: "Home" }, { name: page.title }] });

    for (const a of Array.from(container.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) expect(container.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
      else expect(isAllowedInternalHref(href)).toBe(true);
    }
    expect(container.innerHTML).not.toMatch(UUID_RE);
  });
});

describe("/privacy criterion 2", () => {
  test("states what is stored and that guest data is device-bound", () => {
    const { container } = render(<PrivacyPage />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const phrase of ["session cookie", "orders", "addresses", "lists", "messages", "device-bound"]) {
      expect(text).toContain(phrase);
    }
    expect(screen.getByRole("heading", { level: 2, name: "What we store" })).toBeInTheDocument();
  });
});
