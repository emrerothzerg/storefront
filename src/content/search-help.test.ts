import { describe, expect, test } from "bun:test";
import { FAQ_ENTRIES } from "./faq";
import { HELP_TOPICS } from "./help-topics";
import { isAllowedInternalHref } from "./routes";
import { createSearchService } from "@/server/catalog/search-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  HELP_QUERY_MAX_LENGTH,
  POPULAR_SEARCHES,
  SEARCH_TIPS,
  normalizeHelpQuery,
  searchHelp,
  type HelpSearchResult,
} from "./search-help";

const total = HELP_TOPICS.length + FAQ_ENTRIES.length;

function topicOf(result: HelpSearchResult): string {
  return result.kind === "topic" ? result.topic.slug : result.entry.topic;
}

describe("searchHelp", () => {
  test("empty, whitespace or non-string query returns every topic and FAQ entry", () => {
    expect(searchHelp("")).toHaveLength(total);
    expect(searchHelp("   \t\n ")).toHaveLength(total);
    expect(searchHelp(undefined as unknown as string)).toHaveLength(total);
    const all = searchHelp("");
    expect(all.slice(0, HELP_TOPICS.length).every((r) => r.kind === "topic")).toBe(true);
  });

  test("'shipping' returns the shipping entries first, title hits before body hits", () => {
    const results = searchHelp("shipping");
    expect(results.length).toBeGreaterThan(2);
    const titleHits = results.filter((r) => r.title.toLowerCase().includes("shipping"));
    expect(titleHits.length).toBeGreaterThanOrEqual(3);
    // All title hits come before any body-only hit.
    const firstBodyOnly = results.findIndex((r) => !r.title.toLowerCase().includes("shipping"));
    const lastTitle = results.findLastIndex((r) => r.title.toLowerCase().includes("shipping"));
    expect(firstBodyOnly === -1 || lastTitle < firstBodyOnly).toBe(true);
    for (const hit of titleHits) expect(topicOf(hit)).toBe("shipping");
    expect(results[0]?.kind).toBe("topic");
    expect(topicOf(results[0] as HelpSearchResult)).toBe("shipping");
    // Scores never increase down the list.
    for (let i = 1; i < results.length; i += 1) {
      expect((results[i] as HelpSearchResult).score).toBeLessThanOrEqual((results[i - 1] as HelpSearchResult).score);
    }
  });

  test("is case-insensitive and collapses whitespace", () => {
    expect(searchHelp("  SHIPPING  ").map((r) => r.title)).toEqual(searchHelp("shipping").map((r) => r.title));
    expect(searchHelp("test   card").length).toBeGreaterThan(0);
  });

  test("multi-term queries require every term", () => {
    const results = searchHelp("cancel refund");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.kind === "faq" && r.entry.slug === "how-do-i-cancel-an-order")).toBe(true);
    expect(searchHelp("shipping zzzqqq")).toEqual([]);
  });

  test("regex metacharacters never throw and match literally", () => {
    for (const q of ["(", ")", "[", "*", "+?", "\\", "^$", ".*", "a|b", "{2}", "(?<x>", "\u0000"]) {
      expect(() => searchHelp(q)).not.toThrow();
    }
    expect(searchHelp(".*")).toEqual([]);
    expect(searchHelp("(").length).toBeGreaterThanOrEqual(0);
    expect(searchHelp("$4.99").some((r) => r.kind === "faq" && r.entry.slug === "what-shipping-options-are-there")).toBe(true);
  });

  test("caps the query at 100 characters", () => {
    expect(HELP_QUERY_MAX_LENGTH).toBe(100);
    const long = "shipping" + " ".repeat(92) + "zzzzzz";
    expect(normalizeHelpQuery(long)).toBe("shipping");
    expect(searchHelp(long).length).toBe(searchHelp("shipping").length);
    expect(normalizeHelpQuery("x".repeat(10_000))).toHaveLength(100);
    expect(() => searchHelp("(".repeat(100_000))).not.toThrow();
  });

  test("results link to allowed routes", () => {
    for (const result of searchHelp("")) expect(isAllowedInternalHref(result.href), result.href).toBe(true);
    const faq = searchHelp("test card").find((r) => r.kind === "faq");
    expect(faq?.href).toBe("/help/payments#which-test-card-numbers-can-i-use");
  });
});

describe("product search help (SEARCH_TIPS, POPULAR_SEARCHES)", () => {
  test("tips are non-empty, unique plain sentences", () => {
    expect(SEARCH_TIPS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(SEARCH_TIPS).size).toBe(SEARCH_TIPS.length);
    for (const tip of SEARCH_TIPS) {
      expect(tip).toBe(tip.trim());
      expect(tip).toMatch(/\.$/);
    }
  });

  test("popular searches are unique lower-case words", () => {
    expect(POPULAR_SEARCHES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(POPULAR_SEARCHES).size).toBe(POPULAR_SEARCHES.length);
    for (const term of POPULAR_SEARCHES) expect(term).toMatch(/^[a-z]+( [a-z]+)*$/);
  });

  test("every popular search returns results on the seeded catalogue", () => {
    const db = createDatabase(":memory:");
    try {
      runMigrations(db);
      seedDatabase(db);
      const search = createSearchService({ db, now: () => Date.now() });
      for (const term of POPULAR_SEARCHES) {
        const r = search.search(term, { page: 1, pageSize: 1 });
        expect({ term, ok: r.ok, total: r.ok ? r.value.total > 0 : false }).toEqual({ term, ok: true, total: true });
      }
    } finally {
      db.close();
    }
  });
});
