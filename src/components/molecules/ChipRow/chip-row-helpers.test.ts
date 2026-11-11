import { describe, expect, test } from "bun:test";
import { MAX_QUERY_LENGTH as LISTING_QUERY_MAX } from "@/app/_listing/parse-params";
import { isAllowedInternalHref } from "@/content/routes";
import {
  CHIP_LABEL_MAX,
  CHIP_QUERY_MAX,
  CHIP_ROW_MAX_ITEMS,
  chipLabel,
  chipSearchHref,
  chipSearchQuery,
  cleanChipText,
  resolveChips,
  type ChipRowItem,
} from "./chip-row-helpers";

const ELLIPSIS = "…";

describe("constants", () => {
  test("label 40, query 100 (= listing MAX_QUERY_LENGTH), at most 12 chips", () => {
    expect(CHIP_LABEL_MAX).toBe(40);
    expect(CHIP_QUERY_MAX).toBe(100);
    expect(CHIP_QUERY_MAX).toBe(LISTING_QUERY_MAX);
    expect(CHIP_ROW_MAX_ITEMS).toBe(12);
  });
});

describe("cleanChipText", () => {
  test("trims, collapses whitespace, strips control and zero-width characters", () => {
    expect(cleanChipText("  lego \n\t sets  ")).toBe("lego sets");
    expect(cleanChipText("a​b‮c\u0000d")).toBe("abc d");
    expect(cleanChipText("x\ud800y")).toBe("xy");
  });
  test("non-strings become empty", () => {
    for (const bad of [null, undefined, 1, {}, ["a"]]) expect(cleanChipText(bad)).toBe("");
  });
});

describe("chipLabel", () => {
  test("short labels are trimmed and not truncated", () => {
    expect(chipLabel("  Lego  ")).toEqual({ text: "Lego", full: "Lego", truncated: false });
  });
  test("exactly 40 characters stay whole", () => {
    const forty = "a".repeat(40);
    expect(chipLabel(forty)).toEqual({ text: forty, full: forty, truncated: false });
  });
  test("41+ characters: 39 characters + ellipsis (40 total), full text kept", () => {
    const long = `${"word ".repeat(10)}end`;
    const label = chipLabel(long);
    expect(label?.truncated).toBe(true);
    expect(label?.full).toBe(long.trim());
    expect(label?.text.endsWith(ELLIPSIS)).toBe(true);
    expect(Array.from(label?.text ?? "").length).toBeLessThanOrEqual(CHIP_LABEL_MAX);
    // no space before the ellipsis
    expect(label?.text).not.toContain(` ${ELLIPSIS}`);
  });
  test("emoji are counted as one character and never split", () => {
    const label = chipLabel("\u{1F600}".repeat(50));
    expect(label?.text).toBe(`${"\u{1F600}".repeat(39)}${ELLIPSIS}`);
  });
  test("empty, whitespace-only and non-string labels are null", () => {
    for (const bad of ["", "   ", "​​", null, undefined, 42]) expect(chipLabel(bad)).toBeNull();
  });
});

describe("chipSearchHref", () => {
  test("encodes the query with encodeURIComponent", () => {
    expect(chipSearchHref("lego")).toBe("/search?q=lego");
    expect(chipSearchHref("a b&c=d/e?f#g")).toBe(`/search?q=${encodeURIComponent("a b&c=d/e?f#g")}`);
    expect(chipSearchHref("<script>alert(1)</script>")).toBe("/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(chipSearchHref("\"quoted\" 'x'")).toBe(`/search?q=${encodeURIComponent("\"quoted\" 'x'")}`);
  });
  test("cleans then cuts the query to 100 code units (never mid surrogate pair)", () => {
    expect(chipSearchQuery(`  ${"q".repeat(150)}  `)).toBe("q".repeat(100));
    const emoji = `${"q".repeat(99)}\u{1F600}`;
    expect(chipSearchQuery(emoji)).toBe("q".repeat(99));
    expect(chipSearchHref("x".repeat(101))).toBe(`/search?q=${"x".repeat(100)}`);
  });
  test("empty queries give null", () => {
    for (const bad of ["", "   ", "​", null, 5]) expect(chipSearchHref(bad)).toBeNull();
  });
  test("every built href passes the route allow-list", () => {
    for (const q of ["lego", "a/b", "../../etc", "//evil.example", "https://evil.example", "%2f%2f"]) {
      const href = chipSearchHref(q);
      expect(href?.startsWith("/search?q=")).toBe(true);
      expect(isAllowedInternalHref(href ?? "")).toBe(true);
    }
  });
});

describe("resolveChips", () => {
  test("search and link chips resolve to href + label", () => {
    const chips = resolveChips([{ query: " lego " }, { query: "uno", label: "UNO cards" }, { label: "Toys", href: "/category/toys" }]);
    expect(chips.map((c) => [c.href, c.label.text])).toEqual([
      ["/search?q=lego", "lego"],
      ["/search?q=uno", "UNO cards"],
      ["/category/toys", "Toys"],
    ]);
  });
  test("blank label on a search chip falls back to the query", () => {
    expect(resolveChips([{ query: "desk", label: "   " }])[0]?.label.text).toBe("desk");
  });
  test("drops hrefs that are not allow-listed internal routes", () => {
    const bad: ChipRowItem[] = [
      { label: "x", href: "https://evil.example/" },
      { label: "x", href: "//evil.example" },
      { label: "x", href: "javascript:alert(1)" },
      { label: "x", href: "/not-a-route" },
      { label: "x", href: "/search\\evil" },
      { label: "x", href: "relative" },
      { label: "x", href: "" },
      { label: "x", href: "/category/%2e%2e" },
    ];
    expect(resolveChips(bad)).toEqual([]);
  });
  test("drops empty labels and queries; dedupes by href (first wins)", () => {
    const chips = resolveChips([
      { query: "   " },
      { label: "  ", href: "/deals" },
      { query: "lego" },
      { query: " lego ", label: "Lego again" },
      { label: "Deals", href: "/deals" },
      { label: "Deals 2", href: "/deals" },
    ]);
    expect(chips.map((c) => c.label.text)).toEqual(["lego", "Deals"]);
  });
  test("caps at 12 by default and honours max", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ query: `term ${i}` }));
    expect(resolveChips(many)).toHaveLength(12);
    expect(resolveChips(many, 3)).toHaveLength(3);
    expect(resolveChips(many, 0)).toHaveLength(0);
    expect(resolveChips(many, Number.NaN)).toHaveLength(12);
  });
  test("non-array input and hostile entries give no chips", () => {
    expect(resolveChips(null)).toEqual([]);
    expect(resolveChips(undefined)).toEqual([]);
    expect(resolveChips("lego" as unknown as ChipRowItem[])).toEqual([]);
    expect(resolveChips([null, 1, "x"] as unknown as ChipRowItem[])).toEqual([]);
  });
});
