import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import ErrorPage from "./error";

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

function renderDoc(): Document {
  const noop = (): void => {};
  return parse(renderToStaticMarkup(<ErrorPage error={new Error("secret detail")} retry={noop} reset={noop} />));
}

describe("root error boundary (T171 light-only pass)", () => {
  test("one h1, a Try again button, a link home and a link to search (D-T171-2); no error detail in the markup", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const doc = renderDoc();
      expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Something went wrong"]);
      expect([...doc.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Try again"]);
      const links = [...doc.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
      expect(links).toEqual([
        ["Back to the catalog", "/"],
        ["Search the store", "/search"],
      ]);
      // Both are button-look links (44px targets), side by side in the actions row.
      const search = doc.querySelector('a[href="/search"]');
      expect(search?.parentElement).toBe(doc.querySelector('a[href="/"]')?.parentElement ?? null);
      expect(search?.className ?? "").toMatch(/(^|\s)(min-h-touch|h-11|h-12|min-h-11|min-h-12)(\s|$)/);
      expect(doc.body.innerHTML).not.toContain("secret detail");
    } finally {
      spy.mockRestore();
    }
  });

  test("renders on a light Card panel with no theme or dark-mode classes", () => {
    const doc = renderDoc();
    const panel = doc.querySelector("section");
    expect(panel?.className ?? "").toContain("bg-surface-raised");
    const dark = ["dark", ":"].join("");
    expect(doc.body.innerHTML).not.toContain(dark);
    expect(doc.body.innerHTML).not.toContain(["data", "theme"].join("-"));
  });
});
