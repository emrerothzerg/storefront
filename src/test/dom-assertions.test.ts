import { afterEach, describe, expect, test } from "bun:test";
import {
  expectFocused,
  expectInDocument,
  expectNotFocused,
  expectNotInDocument,
  expectNotNull,
  expectNull,
  expectSameNode,
  SNIPPET_LENGTH,
  tagOf,
} from "./dom-assertions";

/** Runs `fn`, returns the thrown error's message ("" when it does not throw). */
function failureOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

/** A big document so a node-formatting message would be obviously huge. */
function bloat(): void {
  mount(Array.from({ length: 400 }, (_, i) => `<p data-i="${i}">${"lorem ipsum ".repeat(10)}</p>`).join(""));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tagOf", () => {
  test("null and undefined give null", () => {
    expect(tagOf(null)).toBeNull();
    expect(tagOf(undefined)).toBeNull();
  });

  test("element: tag, id, data-testid and a bounded outerHTML snippet", () => {
    const host = mount(`<button id="go" data-testid="go-btn" class="x">${"y".repeat(500)}</button>`);
    const tag = tagOf(host.querySelector("button"));
    expect(tag?.startsWith("button#go[data-testid=go-btn] <button")).toBe(true);
    expect((tag ?? "").length).toBeLessThanOrEqual("button#go[data-testid=go-btn] ".length + SNIPPET_LENGTH);
  });

  test("non-element nodes use nodeName and text", () => {
    expect(tagOf(document.createTextNode("hello"))).toBe("#text hello");
  });
});

describe("expectFocused / expectNotFocused", () => {
  test("pass on identity, fail with a short string message", () => {
    bloat();
    const host = mount(`<button id="a">A</button><button id="b">B</button>`);
    const a = host.querySelector<HTMLButtonElement>("#a");
    const b = host.querySelector<HTMLButtonElement>("#b");
    a?.focus();
    expectFocused(a);
    expectNotFocused(b);

    const msg = failureOf(() => expectFocused(b));
    expect(msg).toContain("button#b");
    expect(msg).toContain("button#a");
    expect(msg.length).toBeLessThan(2_000);
    expect(failureOf(() => expectNotFocused(a))).toContain("button#a");
  });

  test("two equal-looking nodes are still told apart (identity, not text)", () => {
    const host = mount(`<button>Same</button><button>Same</button>`);
    const [first, second] = Array.from(host.querySelectorAll("button"));
    first?.focus();
    expect(failureOf(() => expectFocused(second))).not.toBe("");
  });

  test("body focus and undefined target behave like toBe", () => {
    expectFocused(document.body);
    expect(failureOf(() => expectFocused(undefined))).not.toBe("");
  });
});

describe("expectSameNode / expectNull / expectNotNull", () => {
  test("identity and null semantics match toBe / toBeNull", () => {
    const host = mount(`<span>x</span>`);
    const span = host.querySelector("span");
    expectSameNode(span, span);
    expect(failureOf(() => expectSameNode(span, host))).toContain("span");

    expectNull(host.querySelector("em"));
    expect(failureOf(() => expectNull(span)).length).toBeLessThan(2_000);
    expect(failureOf(() => expectNull(undefined))).not.toBe("");

    expectNotNull(span);
    expectNotNull(undefined);
    expect(failureOf(() => expectNotNull(null))).toContain("null");
  });
});

describe("expectInDocument / expectNotInDocument", () => {
  test("connected vs detached vs null", () => {
    const host = mount(`<i>x</i>`);
    const i = host.querySelector("i");
    expectInDocument(i);
    expect(failureOf(() => expectNotInDocument(i))).toContain("<i>");

    i?.remove();
    expectNotInDocument(i);
    expectNotInDocument(null);
    expect(failureOf(() => expectInDocument(i))).not.toBe("");
    expect(failureOf(() => expectInDocument(null))).not.toBe("");
  });
});
