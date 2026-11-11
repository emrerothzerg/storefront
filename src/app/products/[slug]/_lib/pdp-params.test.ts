import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PDP_PARAMS,
  parseImageIndex,
  parsePage,
  parsePdpParams,
  parseStars,
  reviewsExtraParams,
  type RawSearchParams,
} from "./pdp-params";

describe("parsePdpParams", () => {
  test("empty, null and undefined give the defaults", () => {
    expect(parsePdpParams({})).toEqual(DEFAULT_PDP_PARAMS);
    expect(parsePdpParams(null)).toEqual(DEFAULT_PDP_PARAMS);
    expect(parsePdpParams(undefined)).toEqual(DEFAULT_PDP_PARAMS);
  });

  test("valid values are parsed", () => {
    expect(parsePdpParams({ img: "2", sort: "recent", stars: "4", verified: "1", rpage: "3", qpage: "2" })).toEqual({
      img: 2,
      reviews: { sort: "recent", stars: 4, verifiedOnly: true, page: 3 },
      qpage: 2,
    });
  });

  const table: readonly [string, RawSearchParams, Partial<{ img: number; stars: number | undefined; rpage: number; qpage: number; sort: string; verified: boolean }>][] = [
    ["stars=7 dropped", { stars: "7" }, { stars: undefined }],
    ["stars=0 dropped", { stars: "0" }, { stars: undefined }],
    ["stars=4.5 dropped", { stars: "4.5" }, { stars: undefined }],
    ["stars= 3 dropped", { stars: " 3" }, { stars: undefined }],
    ["stars=03 dropped", { stars: "03" }, { stars: undefined }],
    ["rpage=-1 dropped", { rpage: "-1" }, { rpage: 1 }],
    ["rpage=0 dropped", { rpage: "0" }, { rpage: 1 }],
    ["rpage=1e3 dropped", { rpage: "1e3" }, { rpage: 1 }],
    ["rpage=2.5 dropped", { rpage: "2.5" }, { rpage: 1 }],
    ["rpage huge dropped", { rpage: "99999999999" }, { rpage: 1 }],
    ["qpage=abc dropped", { qpage: "abc" }, { qpage: 1 }],
    ["qpage=0x10 dropped", { qpage: "0x10" }, { qpage: 1 }],
    ["img=abc -> 0", { img: "abc" }, { img: 0 }],
    ["img=-1 -> 0", { img: "-1" }, { img: 0 }],
    ["img=1.5 -> 0", { img: "1.5" }, { img: 0 }],
    ["img=100 -> 0", { img: "100" }, { img: 0 }],
    ["sort=<script> -> helpful", { sort: "<script>" }, { sort: "helpful" }],
    ["sort=RECENT -> helpful", { sort: "RECENT" }, { sort: "helpful" }],
    ["verified=true -> off", { verified: "true" }, { verified: false }],
    ["arrays use the first value", { stars: ["2", "7"], rpage: ["x", "4"] }, { stars: 2, rpage: 1 }],
    ["overlong values ignored", { rpage: "1".repeat(40) }, { rpage: 1 }],
  ];

  test.each(table)("%s", (_name, input, expected) => {
    const p = parsePdpParams(input);
    if ("img" in expected) expect(p.img).toBe(expected.img ?? 0);
    if ("stars" in expected) expect(p.reviews.stars).toBe(expected.stars as never);
    if ("rpage" in expected) expect(p.reviews.page).toBe(expected.rpage ?? 1);
    if ("qpage" in expected) expect(p.qpage).toBe(expected.qpage ?? 1);
    if ("sort" in expected) expect(p.reviews.sort).toBe(expected.sort as never);
    if ("verified" in expected) expect(p.reviews.verifiedOnly).toBe(expected.verified ?? false);
  });

  test("dropped stars leave no key (organisms trust typed props)", () => {
    expect(Object.keys(parsePdpParams({ stars: "7" }).reviews)).not.toContain("stars");
  });

  test("non-string values and prototype keys are ignored", () => {
    const hostile = JSON.parse('{"__proto__": {"stars": "5"}}') as RawSearchParams;
    expect(parsePdpParams(hostile)).toEqual(DEFAULT_PDP_PARAMS);
    expect(parsePdpParams({ stars: [] })).toEqual(DEFAULT_PDP_PARAMS);
  });
});

describe("primitive parsers", () => {
  test("parsePage bounds", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("1000000")).toBe(1_000_000);
    expect(parsePage("1000001")).toBeUndefined();
    expect(parsePage(undefined)).toBeUndefined();
  });
  test("parseImageIndex", () => {
    expect(parseImageIndex("0")).toBe(0);
    expect(parseImageIndex("99")).toBe(99);
    expect(parseImageIndex("007")).toBe(0);
  });
  test("parseStars", () => {
    expect([1, 2, 3, 4, 5].map((n) => parseStars(String(n)))).toEqual([1, 2, 3, 4, 5]);
    expect(parseStars("6")).toBeUndefined();
  });
});

describe("reviewsExtraParams", () => {
  test("omits defaults, keeps validated state in buildReviewsHref order", () => {
    expect(reviewsExtraParams(DEFAULT_PDP_PARAMS.reviews)).toEqual({});
    const extra = reviewsExtraParams({ sort: "recent", stars: 3, verifiedOnly: true, page: 2 });
    expect(Object.entries(extra)).toEqual([
      ["sort", "recent"],
      ["stars", "3"],
      ["verified", "1"],
      ["rpage", "2"],
    ]);
  });
});
