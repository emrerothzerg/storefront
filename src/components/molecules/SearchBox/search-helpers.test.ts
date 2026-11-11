import { describe, expect, test } from "bun:test";
import {
  MAX_QUERY_LENGTH,
  RECENT_SEARCHES_KEY,
  buildEmptyStateSuggestions,
  clearRecentSearches,
  isSafeSuggestionHref,
  parseRecentSearches,
  parseSuggestBody,
  pushRecentSearch,
  readRecentSearches,
  searchHref,
  shouldFetchSuggestions,
} from "./search-helpers";
import type { RecentStorage } from "./search-helpers";

function memoryStorage(initial?: string): RecentStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(RECENT_SEARCHES_KEY, initial);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const throwingStorage: RecentStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("readRecentSearches", () => {
  test("missing or null storage yields []", () => {
    expect(readRecentSearches(null)).toEqual([]);
    expect(readRecentSearches(undefined)).toEqual([]);
    expect(readRecentSearches(memoryStorage())).toEqual([]);
  });

  test("throwing getItem yields [] and does not throw", () => {
    expect(() => readRecentSearches(throwingStorage)).not.toThrow();
    expect(readRecentSearches(throwingStorage)).toEqual([]);
  });

  test("malformed JSON or non-array yields []", () => {
    expect(readRecentSearches(memoryStorage("{not json"))).toEqual([]);
    expect(readRecentSearches(memoryStorage('{"a":1}'))).toEqual([]);
    expect(parseRecentSearches("42")).toEqual([]);
  });

  test("keeps strings only, trimmed, de-duplicated, capped at 5", () => {
    const raw = JSON.stringify([" a ", 1, null, "A", "b", "", "c", "d", "e", "f"]);
    expect(readRecentSearches(memoryStorage(raw))).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("drops values with control characters", () => {
    expect(parseRecentSearches(JSON.stringify(["ok", "bad\u0007"]))).toEqual(["ok"]);
  });
});

describe("pushRecentSearch", () => {
  test("adds newest first and writes JSON", () => {
    const storage = memoryStorage();
    pushRecentSearch(storage, "desk");
    const next = pushRecentSearch(storage, "lamp");
    expect(next).toEqual(["lamp", "desk"]);
    expect(storage.data.get(RECENT_SEARCHES_KEY)).toBe(JSON.stringify(["lamp", "desk"]));
  });

  test("de-duplicates case-insensitively, moving the entry to the front", () => {
    const storage = memoryStorage(JSON.stringify(["lamp", "Desk", "chair"]));
    expect(pushRecentSearch(storage, "  desk ")).toEqual(["desk", "lamp", "chair"]);
  });

  test("caps at 5", () => {
    const storage = memoryStorage();
    for (const q of ["1", "2", "3", "4", "5", "6", "7"]) pushRecentSearch(storage, q);
    expect(readRecentSearches(storage)).toEqual(["7", "6", "5", "4", "3"]);
  });

  test("cuts to 100 characters", () => {
    const storage = memoryStorage();
    const [first] = pushRecentSearch(storage, "x".repeat(150));
    expect(first).toHaveLength(MAX_QUERY_LENGTH);
  });

  test("empty / whitespace query changes nothing", () => {
    const storage = memoryStorage(JSON.stringify(["a"]));
    expect(pushRecentSearch(storage, "   ")).toEqual(["a"]);
    expect(storage.data.get(RECENT_SEARCHES_KEY)).toBe(JSON.stringify(["a"]));
  });

  test("throwing storage never throws", () => {
    expect(() => pushRecentSearch(throwingStorage, "desk")).not.toThrow();
    expect(pushRecentSearch(throwingStorage, "desk")).toEqual(["desk"]);
    expect(() => pushRecentSearch(null, "desk")).not.toThrow();
  });

  test("setItem throwing (quota) with a readable getItem never throws", () => {
    const storage: RecentStorage = {
      getItem: () => JSON.stringify(["old"]),
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(pushRecentSearch(storage, "new")).toEqual(["new", "old"]);
  });
});

describe("clearRecentSearches", () => {
  test("removes the key; throwing storage is swallowed", () => {
    const storage = memoryStorage(JSON.stringify(["a"]));
    clearRecentSearches(storage);
    expect(storage.data.has(RECENT_SEARCHES_KEY)).toBe(false);
    expect(() => clearRecentSearches(throwingStorage)).not.toThrow();
    expect(() => clearRecentSearches(null)).not.toThrow();
  });
});

describe("isSafeSuggestionHref", () => {
  test("accepts internal paths", () => {
    expect(isSafeSuggestionHref("/products/desk")).toBe(true);
    expect(isSafeSuggestionHref("/search?q=a%20b")).toBe(true);
  });

  test.each([
    ["//evil.example"],
    ["javascript:alert(1)"],
    ["https://evil.example/x"],
    ["http:/x"],
    ["/\\evil.example"],
    ["relative/path"],
    [""],
    ["/a\nb"],
  ])("rejects %p", (href) => {
    expect(isSafeSuggestionHref(href)).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isSafeSuggestionHref(undefined)).toBe(false);
    expect(isSafeSuggestionHref(42)).toBe(false);
    expect(isSafeSuggestionHref({ href: "/x" })).toBe(false);
  });
});

describe("parseSuggestBody", () => {
  test("maps the 200 shape and filters unsafe hrefs", () => {
    const items = parseSuggestBody({
      suggestions: [
        { type: "product", label: "Oak desk", href: "/products/oak-desk" },
        { type: "category", label: "Desks", href: "//evil" },
        { type: "brand", label: "Bad", href: "javascript:alert(1)" },
        { type: "brand", label: "Ext", href: "https://evil.example" },
        { type: "brand", label: "", href: "/brands/x" },
        { type: "brand", label: "Acme", href: "/brands/acme" },
      ],
    });
    expect(items.map((i) => [i.label, i.href, i.kind])).toEqual([
      ["Oak desk", "/products/oak-desk", "product"],
      ["Acme", "/brands/acme", "brand"],
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  test("error bodies and junk yield []", () => {
    expect(parseSuggestBody({ error: "rate_limited", retryAfterSeconds: 5 })).toEqual([]);
    expect(parseSuggestBody(null)).toEqual([]);
    expect(parseSuggestBody("x")).toEqual([]);
    expect(parseSuggestBody({ suggestions: "x" })).toEqual([]);
  });

  test("caps at 8", () => {
    const suggestions = Array.from({ length: 12 }, (_, i) => ({ type: "product", label: `p${i}`, href: `/products/p${i}` }));
    expect(parseSuggestBody({ suggestions })).toHaveLength(8);
  });
});

describe("buildEmptyStateSuggestions", () => {
  test("recents first with 'Recent:' prefix, then popular without duplicates", () => {
    const items = buildEmptyStateSuggestions(["desk", "lamp"], ["Desk", "chair", "  ", "chair"]);
    expect(items.map((i) => [i.label, i.kind, i.query, i.href])).toEqual([
      ["Recent: desk", "recent", "desk", "/search?q=desk"],
      ["Recent: lamp", "recent", "lamp", "/search?q=lamp"],
      ["chair", "popular", "chair", "/search?q=chair"],
    ]);
  });

  test("searchHref encodes the query", () => {
    expect(searchHref("a&b c")).toBe("/search?q=a%26b%20c");
  });
});

describe("shouldFetchSuggestions", () => {
  test("needs 2..100 trimmed code points", () => {
    expect(shouldFetchSuggestions("")).toBe(false);
    expect(shouldFetchSuggestions(" a ")).toBe(false);
    expect(shouldFetchSuggestions("ab")).toBe(true);
    expect(shouldFetchSuggestions("x".repeat(101))).toBe(false);
  });

  test("rejects any control character (D-T64-2)", () => {
    for (const q of ["de\u0007sk", "a\u0000b", "desk\u007f", "de\u0085sk", "de\nsk", "de\tsk"]) {
      expect(shouldFetchSuggestions(q)).toBe(false);
    }
    expect(shouldFetchSuggestions("de\u200Bsk")).toBe(true);
  });
});
