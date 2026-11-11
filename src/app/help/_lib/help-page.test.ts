import { describe, expect, test } from "bun:test";

import { FAQ_ENTRIES } from "@/content/faq";
import { HELP_TOPICS } from "@/content/help-topics";
import { isAllowedInternalHref } from "@/content/routes";

import {
  faqDeepLink,
  helpTiles,
  isHelpSearchRequest,
  loadHelpPage,
  parseHelpQuery,
  resultCountLabel,
  runHelpSearch,
} from "./help-page";

describe("parseHelpQuery", () => {
  test("cleans and caps at 100 characters", () => {
    expect(parseHelpQuery("  shipping  ")).toBe("shipping");
    expect(parseHelpQuery("a".repeat(500))).toHaveLength(100);
    expect(parseHelpQuery("​")).toBeNull();
    expect(parseHelpQuery(["refund", "x"])).toBe("refund");
  });
});

describe("isHelpSearchRequest", () => {
  test("any ?q (even empty) is a search request", () => {
    expect(isHelpSearchRequest({ q: "" })).toBe(true);
    expect(isHelpSearchRequest({ q: "x" })).toBe(true);
    expect(isHelpSearchRequest({})).toBe(false);
    expect(isHelpSearchRequest({ open: "x" })).toBe(false);
  });
});

describe("runHelpSearch", () => {
  test("finds topics and FAQ entries; FAQ links deep-link with ?open=#", () => {
    const results = runHelpSearch("free shipping");
    expect(results.length).toBeGreaterThan(0);
    const faq = results.find((r) => r.kind === "faq");
    expect(faq).toBeDefined();
    expect(faq?.href).toMatch(/^\/help\/[a-z-]+\?open=[a-z0-9-]+#[a-z0-9-]+$/);
    for (const r of results) expect(isAllowedInternalHref(r.href)).toBe(true);
  });

  test("regex metacharacters, markup and garbage never throw", () => {
    for (const q of [".*", "(a+)+$", "[", "\\", "<script>", "%00", "'; DROP TABLE x;--", "\u{1F600}", "zzzzqqqq"]) {
      expect(() => runHelpSearch(q)).not.toThrow();
    }
    expect(runHelpSearch(".*")).toEqual([]);
    expect(runHelpSearch("zzzzqqqq")).toEqual([]);
  });

  test("keys are unique", () => {
    const keys = runHelpSearch("order").map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("faqDeepLink / helpTiles", () => {
  test("every FAQ deep link passes the route allowlist", () => {
    for (const entry of FAQ_ENTRIES) {
      const href = faqDeepLink(entry.topic, entry.slug);
      expect(href).toBe(`/help/${entry.topic}?open=${entry.slug}#${entry.slug}`);
      expect(isAllowedInternalHref(href)).toBe(true);
    }
  });

  test("one tile per help topic", () => {
    const tiles = helpTiles();
    expect(tiles.map((t) => t.slug)).toEqual(HELP_TOPICS.map((t) => t.slug));
    for (const tile of tiles) expect(isAllowedInternalHref(tile.href)).toBe(true);
  });
});

describe("loadHelpPage", () => {
  test("no q: no search, all topics", () => {
    const data = loadHelpPage({});
    expect(data).toMatchObject({ query: null, searched: false, results: [] });
    expect(data.topics).toHaveLength(HELP_TOPICS.length);
  });

  test("blank q: searched but no query and no results", () => {
    expect(loadHelpPage({ q: "   " })).toMatchObject({ query: null, searched: true, results: [] });
  });

  test("undefined params are safe", () => {
    expect(loadHelpPage(undefined).searched).toBe(false);
  });

  test("resultCountLabel", () => {
    expect(resultCountLabel(0)).toBe("0 results");
    expect(resultCountLabel(1)).toBe("1 result");
    expect(resultCountLabel(5)).toBe("5 results");
  });
});
