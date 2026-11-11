import { describe, expect, test } from "bun:test";

import { CONTACT_TOPIC_LABELS } from "@/components/molecules/ContactForm";
import { isAllowedInternalHref } from "@/content/routes";
import { CONTACT_TOPICS } from "@/server/contact/contact-service";

import {
  ACCOUNT_PAGES,
  CONTACT_TOPIC_TEXT,
  accountAuthHref,
  accountBreadcrumb,
  accountMetadata,
  alertStatusText,
  formatAccountDate,
  isoForTimeElement,
  productHref,
  type AccountPageKey,
} from "./page-parts";

const KEYS = Object.keys(ACCOUNT_PAGES) as AccountPageKey[];

describe("account page parts", () => {
  test.each(KEYS)("%s: sign-in / sign-up hrefs carry the encoded page path as next (D-T98-1)", (key) => {
    const path = ACCOUNT_PAGES[key].path;
    for (const auth of ["/signin", "/signup"] as const) {
      const href = accountAuthHref(auth, key);
      expect(href).toBe(`${auth}?next=${encodeURIComponent(path)}`);
      expect(isAllowedInternalHref(href)).toBe(true);
      const url = new URL(href, "http://localhost");
      expect(url.pathname).toBe(auth);
      expect(url.searchParams.get("next")).toBe(path);
    }
  });

  test.each(KEYS)("%s: noindex metadata with its title and an allowed path", (key) => {
    const m = accountMetadata(key);
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.title).toBe(ACCOUNT_PAGES[key].title);
    expect(isAllowedInternalHref(ACCOUNT_PAGES[key].path)).toBe(true);
  });

  test("breadcrumbs: Home › Your Account (› page); every href allowed", () => {
    expect(accountBreadcrumb("hub")).toEqual([{ label: "Home", href: "/" }, { label: "Your Account" }]);
    expect(accountBreadcrumb("history")).toEqual([
      { label: "Home", href: "/" },
      { label: "Your Account", href: "/account" },
      { label: "Browsing History" },
    ]);
    for (const key of KEYS) {
      for (const item of accountBreadcrumb(key)) if (item.href !== undefined) expect(isAllowedInternalHref(item.href)).toBe(true);
    }
  });

  test("productHref: only well-formed slugs", () => {
    expect(productHref("canvas-tote-bag")).toBe("/products/canvas-tote-bag");
    expect(productHref("canvas-tote-bag", "questions")).toBe("/products/canvas-tote-bag#questions");
    for (const bad of ["", "../x", "a/b", "//evil.com", "UPPER", "a b", 7, null, "x".repeat(101)]) {
      expect(productHref(bad)).toBeNull();
    }
  });

  test("formatAccountDate: strict ISO with zone, UTC", () => {
    expect(formatAccountDate("2026-11-07T23:30:00.000Z")).toBe("November 7, 2026");
    expect(isoForTimeElement("2026-11-07T23:30:00+00:00")).toBe("2026-11-07T23:30:00.000Z");
    for (const bad of ["2026-11-07", "2026-11-07T10:00:00", "nope", "", 123, null, "2026-13-40T00:00:00Z"]) {
      expect(formatAccountDate(bad)).toBeNull();
      expect(isoForTimeElement(bad)).toBeNull();
    }
  });

  test("contact topic labels mirror the ContactForm molecule and cover every service topic", () => {
    expect(CONTACT_TOPIC_TEXT).toEqual(CONTACT_TOPIC_LABELS);
    expect(Object.keys(CONTACT_TOPIC_TEXT).sort()).toEqual([...CONTACT_TOPICS].sort());
  });

  test("alert status wording", () => {
    expect(alertStatusText("waiting")).toBe("Watching");
    expect(alertStatusText("back_in_stock")).toBe("Back in stock");
  });
});
