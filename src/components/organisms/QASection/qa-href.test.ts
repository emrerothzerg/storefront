import { describe, expect, test } from "bun:test";
import { QA_PAGE_PARAM, QA_SECTION_ID, buildQaHref } from "./qa-href";

const base = "/products/oak-desk";

describe("buildQaHref", () => {
  test("constants", () => {
    expect(QA_SECTION_ID).toBe("questions");
    expect(QA_PAGE_PARAM).toBe("qpage");
  });

  test("page 1, undefined and no state omit qpage", () => {
    expect(buildQaHref(base)).toBe(`${base}#questions`);
    expect(buildQaHref(base, { qpage: 1 })).toBe(`${base}#questions`);
    expect(buildQaHref(base, { qpage: 3 }, { qpage: 1 })).toBe(`${base}#questions`);
    expect(buildQaHref(base, { qpage: 3 }, { qpage: undefined })).toBe(`${base}#questions`);
  });

  test("page N > 1", () => {
    expect(buildQaHref(base, { qpage: 1 }, { qpage: 2 })).toBe(`${base}?qpage=2#questions`);
    expect(buildQaHref(base, { qpage: 4 })).toBe(`${base}?qpage=4#questions`);
  });

  test("absent patch key keeps the current page", () => {
    expect(buildQaHref(base, { qpage: 3 }, {})).toBe(`${base}?qpage=3#questions`);
  });

  test("invalid pages are dropped", () => {
    for (const bad of [0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(buildQaHref(base, {}, { qpage: bad })).toBe(`${base}#questions`);
    }
  });

  test("extra params are preserved in order before qpage; arrays repeat; undefined/qpage keys skipped", () => {
    expect(
      buildQaHref(
        base,
        { qpage: 1, extra: { sort: "recent", stars: "4", tag: ["a", "b"], gone: undefined, qpage: "9", rpage: "2" } },
        { qpage: 3 },
      ),
    ).toBe(`${base}?sort=recent&stars=4&tag=a&tag=b&rpage=2&qpage=3#questions`);
    expect(buildQaHref(base, { extra: { sort: "recent" } }, { qpage: 1 })).toBe(`${base}?sort=recent#questions`);
  });

  test("extra values are URL-encoded", () => {
    expect(buildQaHref(base, { extra: { q: "a&b=c #x" } })).toBe(`${base}?q=a%26b%3Dc+%23x#questions`);
  });

  test("query/fragment on basePath is discarded", () => {
    expect(buildQaHref(`${base}?qpage=7&x=1#reviews`, {}, { qpage: 2 })).toBe(`${base}?qpage=2#questions`);
    expect(buildQaHref(`${base}#top`)).toBe(`${base}#questions`);
  });
});
