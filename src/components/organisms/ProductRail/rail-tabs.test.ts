import { describe, expect, test } from "bun:test";
import { RAIL_PARAM_MAX_LENGTH, resolveRailTab, validRailTabs, type ProductRailTab } from "./rail-tabs";

const IDS = ["best-sellers", "deals", "new-arrivals", "top-rated"] as const;
const DEFAULT = "best-sellers";

describe("resolveRailTab (T153 AC1, contract H-15)", () => {
  test("a single known value selects that tab", () => {
    for (const id of IDS) expect(resolveRailTab(id, IDS, DEFAULT)).toBe(id);
  });

  test("missing, empty, unknown, repeated, prototype-like and over-long values fall back to the default", () => {
    const cases: Array<string | string[] | null | undefined> = [
      undefined,
      null,
      "",
      "x",
      "DEALS",
      " deals",
      "deals ",
      ["deals", "top-rated"],
      ["deals"],
      [],
      "__proto__",
      "constructor",
      "toString",
      "a".repeat(500),
      "deals".padEnd(RAIL_PARAM_MAX_LENGTH + 1, "x"),
    ];
    for (const raw of cases) expect(resolveRailTab(raw, IDS, DEFAULT)).toBe(DEFAULT);
  });

  test("never throws on odd id lists", () => {
    expect(resolveRailTab("deals", [], DEFAULT)).toBe(DEFAULT);
    expect(resolveRailTab("__proto__", ["__proto__"], DEFAULT)).toBe("__proto__");
  });
});

describe("validRailTabs", () => {
  const tab = (id: string, href = `/?rail=${id}#top-picks`, label = id.toUpperCase()): ProductRailTab => ({
    id,
    label,
    href,
  });

  test("keeps valid tabs in order; activeId honoured when present", () => {
    const r = validRailTabs([tab("a"), tab("b")], "b");
    expect(r.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(r.activeId).toBe("b");
    expect(r.dropped).toEqual([]);
  });

  test("unknown or missing activeId falls back to the first valid tab", () => {
    expect(validRailTabs([tab("a"), tab("b")], "zzz").activeId).toBe("a");
    expect(validRailTabs([tab("a"), tab("b")], undefined).activeId).toBe("a");
    expect(validRailTabs([], "a").activeId).toBeNull();
    expect(validRailTabs(undefined, undefined)).toEqual({ tabs: [], activeId: null, dropped: [] });
  });

  test("drops disallowed hrefs, empty ids/labels and duplicate ids (first wins)", () => {
    const r = validRailTabs(
      [
        tab("ok"),
        tab("js", "javascript:alert(1)"),
        tab("abs", "https://evil.example/"),
        tab("proto", "//evil.example"),
        tab("", "/?rail=x"),
        tab("blank", "/?rail=blank", "   "),
        tab("ok", "/?rail=other"),
        tab("two"),
      ],
      "js",
    );
    expect(r.tabs.map((t) => [t.id, t.href])).toEqual([
      ["ok", "/?rail=ok#top-picks"],
      ["two", "/?rail=two#top-picks"],
    ]);
    expect(r.activeId).toBe("ok");
    expect(r.dropped).toHaveLength(6);
  });

  test("labels and ids are trimmed", () => {
    const r = validRailTabs([{ id: " a ", label: "  Deals ", href: "/?rail=a" }], "a");
    expect(r.tabs).toEqual([{ id: "a", label: "Deals", href: "/?rail=a" }]);
    expect(r.activeId).toBe("a");
  });
});
