import { describe, expect, test } from "bun:test";
import { SITE_NAME } from "@/lib/seo/site";
import {
  POLICY_PAGES,
  POLICY_PAGE_LIST,
  POLICY_SLUGS,
  SAMPLE_POLICY_NOTICE,
  getPolicyPage,
  isPolicySlug,
  policyHref,
} from "./policies";
import { isAllowedInternalHref } from "./routes";

function pageText(slug: (typeof POLICY_SLUGS)[number]): string {
  const page = POLICY_PAGES[slug];
  return [page.title, ...page.sections.flatMap((section) => [section.heading, ...section.paragraphs])].join(" ");
}

describe("POLICY_PAGES", () => {
  test("has the six pages keyed by their own slug, each an allowed route", () => {
    expect(Object.keys(POLICY_PAGES).sort()).toEqual([...POLICY_SLUGS].sort());
    for (const slug of POLICY_SLUGS) {
      expect(POLICY_PAGES[slug].slug).toBe(slug);
      expect(isAllowedInternalHref(policyHref(slug))).toBe(true);
    }
    expect(POLICY_PAGE_LIST.map((page) => page.slug)).toEqual([...POLICY_SLUGS]);
  });

  test("every page has lastUpdated, the sample flag and the visible sample sentence first", () => {
    expect(SAMPLE_POLICY_NOTICE).toBe("This is sample policy text for a demo store and is not legal advice.");
    for (const page of POLICY_PAGE_LIST) {
      expect(page.lastUpdated).toBe("2026-11-07");
      expect(page.sampleNotice).toBe(true);
      expect(page.sections[0]?.paragraphs[0]).toBe(SAMPLE_POLICY_NOTICE);
    }
  });

  test("no empty sections, headings or paragraphs", () => {
    for (const page of POLICY_PAGE_LIST) {
      expect(page.title.trim().length).toBeGreaterThan(0);
      expect(page.sections.length).toBeGreaterThan(0);
      for (const section of page.sections) {
        expect(section.heading.trim().length).toBeGreaterThan(0);
        expect(section.paragraphs.length).toBeGreaterThan(0);
        for (const paragraph of section.paragraphs) expect(paragraph.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("privacy states exactly what is stored and that data is device-bound in a local database", () => {
    const text = pageText("privacy");
    for (const fact of [
      "sf_session",
      "Your cart",
      "the shipping address, the email address you entered at checkout, the last 4 digits of the card",
      "address book",
      "Your lists",
      "Reviews, questions and answers",
      "contact form",
      "browsing history",
      "device-bound until you sign in",
      "local database",
      "email address, your display name, a password hash",
      "never the password itself",
      "sign-in session records",
      "sf_auth",
      "Orders are kept as financial records but anonymised",
      "the items, amounts and dates are kept",
      "There is no password recovery",
      "password reset is not available",
    ]) {
      expect(text, fact).toContain(fact);
    }
  });

  test("terms, shipping and returns state mock payments, simulated tracking and the 30-minute cancellation", () => {
    for (const slug of ["terms", "shipping", "returns"] as const) {
      const text = pageText(slug);
      expect(text, slug).toContain("30 minutes");
      expect(text, slug).toContain("processing");
    }
    expect(pageText("terms")).toContain("mock payments");
    expect(pageText("terms")).toContain("You can check out as a guest or signed in to an account");
    expect(pageText("terms")).not.toContain("Checkout is guest checkout");
    expect(pageText("returns")).toContain("mock payments");
    expect(pageText("terms")).toContain("tracking is simulated");
    expect(pageText("shipping")).toContain("Tracking is simulated");
    expect(pageText("returns")).toContain("simulated tracking");
    expect(pageText("terms")).toContain("Guest data is device-bound until you sign in");
    expect(pageText("terms")).toContain("responsible for keeping your password secret");
    expect(pageText("about")).toContain("Guest data is device-bound until you sign in");
    expect(pageText("shipping")).toContain("$4.99");
    expect(pageText("shipping")).toContain("free on orders of $35 or more");
    expect(pageText("shipping")).toContain("business-day estimates");
  });

  test("uses SITE_NAME for the store name", () => {
    expect(POLICY_PAGES.about.title).toBe(`About ${SITE_NAME}`);
    expect(pageText("privacy")).toContain(SITE_NAME);
  });
});

describe("getPolicyPage / isPolicySlug", () => {
  test("resolve known slugs and reject unknown ones", () => {
    expect(getPolicyPage("returns")?.title).toBe("Returns and refunds policy");
    expect(getPolicyPage("cookies")).toBeUndefined();
    expect(getPolicyPage("toString")).toBeUndefined();
    expect(isPolicySlug("terms")).toBe(true);
    expect(isPolicySlug("Terms")).toBe(false);
  });
});
