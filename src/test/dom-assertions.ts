/**
 * DOM assertions that never put a DOM node into an `expect` message.
 *
 * Why: when `expect(<node>).toBe(<node>)` fails, Bun formats both values for
 * the error message, and a happy-dom node drags in its whole document graph.
 * Inside `waitFor` every failing poll does that again, so a few polls under
 * load allocate gigabytes and the test process is killed (TEST-HYGIENE,
 * root cause found in T129a). These helpers compare identity as a boolean and
 * only ever hand short strings (see `tagOf`) to `expect`.
 *
 * Test-only module; import as `@/test/dom-assertions` from `src/**` and
 * `tests/**`.
 */
import { expect } from "bun:test";

export type MaybeNode = Node | null | undefined;

/** Max characters of outerHTML / text kept in a description. */
export const SNIPPET_LENGTH = 120;

const OK = "ok";

function describeNode(node: MaybeNode): string {
  if (node === null) return "null";
  if (node === undefined) return "undefined";
  if (node instanceof Element) {
    const testId = node.getAttribute("data-testid");
    const id = node.id ? `#${node.id}` : "";
    const tid = testId ? `[data-testid=${testId}]` : "";
    return `${node.tagName.toLowerCase()}${id}${tid} ${node.outerHTML.slice(0, SNIPPET_LENGTH)}`;
  }
  return `${node.nodeName} ${(node.textContent ?? "").slice(0, SNIPPET_LENGTH)}`;
}

/**
 * Short string for a node: tag, id, data-testid and the first 120 chars of
 * outerHTML (text nodes / documents: nodeName + text). `null` for null or
 * undefined, so `expect(tagOf(x)).toBeNull()` reads naturally.
 */
export function tagOf(node: MaybeNode): string | null {
  if (node === null || node === undefined) return null;
  return describeNode(node);
}

/** Fails with `message` (a string) unless `ok`. */
function check(ok: boolean, message: () => string): void {
  expect(ok ? OK : message()).toBe(OK);
}

/** Same as `expect(doc.activeElement).toBe(node)` (identity), string-only message. */
export function expectFocused(node: MaybeNode, doc: Document = document): void {
  const active = doc.activeElement;
  check(active === node, () => `expected focus on ${describeNode(node)}; activeElement is ${describeNode(active)}`);
}

/** Same as `expect(doc.activeElement).not.toBe(node)`, string-only message. */
export function expectNotFocused(node: MaybeNode, doc: Document = document): void {
  const active = doc.activeElement;
  check(active !== node, () => `expected focus NOT on ${describeNode(node)}, but it is`);
}

/** Same as `expect(actual).toBe(expected)` for nodes (identity), string-only message. */
export function expectSameNode(actual: MaybeNode, expected: MaybeNode): void {
  check(actual === expected, () => `expected node ${describeNode(expected)}; received ${describeNode(actual)}`);
}

/** Same as `expect(node).toBeNull()` (undefined fails, as with toBeNull). */
export function expectNull(node: MaybeNode): void {
  check(node === null, () => `expected null; received ${describeNode(node)}`);
}

/** Same as `expect(node).not.toBeNull()` (undefined passes, as with not.toBeNull). */
export function expectNotNull(node: MaybeNode): void {
  check(node !== null, () => "expected a node; received null");
}

/** Same as jest-dom `expect(node).toBeInTheDocument()` against the node's own document. */
export function expectInDocument(node: MaybeNode): void {
  const ok = node !== null && node !== undefined && node.isConnected;
  check(ok, () => `expected node in the document; received ${describeNode(node)}`);
}

/** Same as jest-dom `expect(node).not.toBeInTheDocument()`: null, undefined or detached passes. */
export function expectNotInDocument(node: MaybeNode): void {
  const ok = node === null || node === undefined || !node.isConnected;
  check(ok, () => `expected node not in the document; received ${describeNode(node)}`);
}
