import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GUEST_NOTICE_TEXT } from "@/components/organisms/AccountHub";
import { isAllowedInternalHref } from "@/content/routes";

import { AccountGuestState, GUEST_STATE_LABEL } from "./guest-state";
import { ACCOUNT_PAGES } from "./page-parts";

const PAGES = ["addresses", "history", "contributions", "alerts", "messages"] as const;

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

describe("AccountGuestState (D-T98-1)", () => {
  test.each(PAGES)("%s: device-bound notice + sign-in/create-account links returning to the page", (page) => {
    const doc = parse(renderToStaticMarkup(<AccountGuestState page={page} />));
    const group = doc.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toBe(GUEST_STATE_LABEL);
    expect(group?.textContent).toContain(GUEST_NOTICE_TEXT);
    const links = [...doc.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    const next = encodeURIComponent(ACCOUNT_PAGES[page].path);
    expect(links).toEqual([
      ["Sign in", `/signin?next=${next}`],
      ["Create account", `/signup?next=${next}`],
    ]);
    for (const a of doc.querySelectorAll("a")) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
      expect(a.getAttribute("class") ?? "").toMatch(/\bmin-h-touch\b/);
    }
  });

  test("no headings, forms, buttons or landmarks (the page view owns the h1)", () => {
    const doc = parse(renderToStaticMarkup(<AccountGuestState page="history" />));
    expect(doc.querySelectorAll("h1, h2, h3, h4, h5, h6, form, button, nav, main, section, aside")).toHaveLength(0);
  });

  test("the notice is a polite status (info tone), not an alert", () => {
    const doc = parse(renderToStaticMarkup(<AccountGuestState page="alerts" />));
    const notice = doc.querySelector('[data-tone="info"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(doc.querySelector('[role="alert"]')).toBeNull();
  });
});
