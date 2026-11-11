import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ALL_HOME_ART } from "./home-art";
import { LISTING_FEEDBACK_SUGGESTIONS, LISTING_PROMOS } from "./listing-promos";
import { isAllowedInternalHref } from "./routes";

const APP_DIR = join(import.meta.dir, "..", "app");

/** Static routes only: `/shipping` -> `src/app/shipping/page.tsx`. */
function pageExists(href: string): boolean {
  const path = href.split("?")[0] ?? "";
  return existsSync(join(APP_DIR, ...path.split("/").filter(Boolean), "page.tsx"));
}

function allText(): string[] {
  const out: string[] = [];
  for (const p of LISTING_PROMOS) out.push(p.heading, p.blurb, p.cta.label, p.image?.alt ?? "");
  for (const s of LISTING_FEEDBACK_SUGGESTIONS) out.push(s.label);
  return out;
}

describe("LISTING_PROMOS", () => {
  test("at least 3 tiles plus a stand-in, unique ids, non-blank copy", () => {
    expect(LISTING_PROMOS.length).toBeGreaterThanOrEqual(4);
    const ids = LISTING_PROMOS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of LISTING_PROMOS) {
      expect(p.heading.trim()).not.toBe("");
      expect(p.blurb.trim()).not.toBe("");
      expect(p.cta.label.trim()).not.toBe("");
    }
  });

  test("every CTA passes the allow-list and points at an existing page; CTA hrefs are unique", () => {
    const hrefs = LISTING_PROMOS.map((p) => p.cta.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect({ href, allowed: isAllowedInternalHref(href), page: pageExists(href) }).toEqual({ href, allowed: true, page: true });
  });

  test("every tile has art from the placeholder art manifest, each a different image (T178, U04)", () => {
    const paths = new Set(ALL_HOME_ART.map((a) => a.path));
    for (const p of LISTING_PROMOS) expect({ id: p.id, inManifest: p.image !== null && paths.has(p.image.path) }).toEqual({ id: p.id, inManifest: true });
    const used = LISTING_PROMOS.map((p) => p.image?.path);
    expect(new Set(used).size).toBe(used.length);
  });

  test("tones are PromoTile tones", () => {
    for (const p of LISTING_PROMOS) expect(["primary", "primary-subtle", "neutral", "accent"]).toContain(p.tone);
  });
});

describe("LISTING_FEEDBACK_SUGGESTIONS", () => {
  test("at least 4 (so 3 remain after dropping the current route), allow-listed, existing pages, unique", () => {
    expect(LISTING_FEEDBACK_SUGGESTIONS.length).toBeGreaterThanOrEqual(4);
    const hrefs = LISTING_FEEDBACK_SUGGESTIONS.map((s) => s.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const s of LISTING_FEEDBACK_SUGGESTIONS) {
      expect(s.label.trim()).not.toBe("");
      expect({ href: s.href, allowed: isAllowedInternalHref(s.href), page: pageExists(s.href) }).toEqual({ href: s.href, allowed: true, page: true });
    }
  });
});

describe("copy rules", () => {
  test("plain text: no markup, entities or money amounts", () => {
    for (const text of allText()) {
      expect(/[<>]|&[a-z]+;/i.test(text)).toBe(false);
      expect(/\$\s?\d/.test(text)).toBe(false);
    }
  });

  test("brand-free (R2) and honest (R10)", () => {
    const text = allText().join(" ").toLowerCase();
    // Banned words are assembled at runtime so no source file contains them (guard G01 scans src/**).
    const retailer = [["k", "mart"], ["tar", "get"], ["one", "pass"], ["after", "pay"], ["pay", "pal"]].map((p) => p.join(""));
    const services = [
      "click & collect", "click and collect", "same day", "same-day", "member", "newsletter", "subscribe",
      "sign up for", "in store", "in-store", "find a store", "download the app", "pay later",
      "low prices", "delivered faster", "reward", "marketplace", "online only",
    ];
    for (const banned of [...retailer, ...services]) expect({ banned, found: text.includes(banned) }).toEqual({ banned, found: false });
  });
});
