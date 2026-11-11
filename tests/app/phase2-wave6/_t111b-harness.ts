/**
 * Harness for the T111b QA files (checkout page, order pages, journey,
 * foreign-access matrix). QA-owned; distinct from `_harness.ts` (T111a).
 *
 * `next/*` mocks SPREAD the real modules and delegate to per-test state. The
 * cookie store is resolved through an AsyncLocalStorage first, so two
 * concurrent journeys can each carry their own cookie jar; otherwise the
 * shared `qa.store` is used. Each test file calls `installNextMocks()` at
 * import time (before importing pages/actions) so its own registration is
 * current while that file runs, even when files share one bun process.
 */
import { mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND (T111b sentinel)");
  }
}

export class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT (T111b sentinel) ${url}`);
  }
}

/**
 * Cookie store double. Records every write attempt. `persist` (journey only)
 * also applies writes to the jar, like a browser would on the next request.
 */
export class QaCookieStore {
  readonly jar = new Map<string, string>();
  readonly writes: string[] = [];
  constructor(readonly persist = false) {}
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  has(name: string): boolean {
    return this.jar.has(name);
  }
  getAll(): { name: string; value: string }[] {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }
  set(nameOrCookie: string | { name: string; value: string }, value?: string): void {
    const name = typeof nameOrCookie === "string" ? nameOrCookie : nameOrCookie.name;
    const v = typeof nameOrCookie === "string" ? value : nameOrCookie.value;
    this.writes.push(`set:${name}`);
    if (this.persist && typeof v === "string") this.jar.set(name, v);
  }
  delete(name: string): void {
    this.writes.push(`delete:${name}`);
    if (this.persist) this.jar.delete(name);
  }
}

export const qa = {
  store: new QaCookieStore(),
  revalidated: [] as string[],
  notFoundCalls: 0,
};

export const cookieScope = new AsyncLocalStorage<QaCookieStore>();

function currentStore(): QaCookieStore {
  return cookieScope.getStore() ?? qa.store;
}

const realServer = { ...(await import("next/server")) };
const realHeaders = { ...(await import("next/headers")) };
const realNavigation = { ...(await import("next/navigation")) };
const realCache = { ...(await import("next/cache")) };

export function installNextMocks(): void {
  mock.module("next/server", () => ({
    ...realServer,
    connection: async (): Promise<void> => undefined,
  }));
  mock.module("next/headers", () => ({
    ...realHeaders,
    cookies: async (): Promise<QaCookieStore> => currentStore(),
    headers: async (): Promise<Headers> => new Headers(),
  }));
  mock.module("next/navigation", () => ({
    ...realNavigation,
    notFound: (): never => {
      qa.notFoundCalls += 1;
      throw new NotFoundSentinel();
    },
    redirect: (url: string): never => {
      throw new RedirectSentinel(url);
    },
  }));
  mock.module("next/cache", () => ({
    ...realCache,
    revalidatePath: (path: string): void => {
      qa.revalidated.push(path);
    },
    revalidateTag: (): void => undefined,
  }));
}

installNextMocks();

export function resetCookies(cookies: Readonly<Record<string, string>> = {}, persist = false): QaCookieStore {
  qa.store = new QaCookieStore(persist);
  for (const [k, v] of Object.entries(cookies)) qa.store.jar.set(k, v);
  qa.notFoundCalls = 0;
  qa.revalidated = [];
  return qa.store;
}

export type PageOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "notFound" }
  | { readonly kind: "redirect"; readonly url: string };

export async function outcomeOf<T>(run: () => Promise<T>): Promise<PageOutcome<T>> {
  try {
    return { kind: "ok", value: await run() };
  } catch (error: unknown) {
    if (error instanceof NotFoundSentinel) return { kind: "notFound" };
    if (error instanceof RedirectSentinel) return { kind: "redirect", url: error.url };
    throw error;
  }
}

/** Runs an action that is expected to `redirect()`; returns the URL, or the returned state when it did not redirect. */
export async function redirectOrState<T>(run: () => Promise<T>): Promise<{ url: string } | { state: T }> {
  try {
    return { state: await run() };
  } catch (error: unknown) {
    if (error instanceof RedirectSentinel) return { url: error.url };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// `$$FORM_ACTION` server-reference fixture (pattern: phase2-wave5/_harness.ts)
// ---------------------------------------------------------------------------

const formFields = () => ({
  name: "$ACTION_REF_T111B",
  action: "",
  encType: "multipart/form-data",
  method: "POST",
  data: null,
});

type AnyFn = (...args: never[]) => unknown;

function markServerLike(fn: AnyFn): void {
  const realBind = Function.prototype.bind;
  Object.defineProperty(fn, "$$FORM_ACTION", { value: formFields, configurable: true, writable: true });
  Object.defineProperty(fn, "bind", {
    configurable: true,
    writable: true,
    value(this: AnyFn, thisArg: unknown, ...args: unknown[]): AnyFn {
      const bound = realBind.call(this, thisArg, ...args) as AnyFn;
      markServerLike(bound);
      return bound;
    },
  });
}

export function serverLike(fns: readonly AnyFn[]): () => void {
  for (const fn of fns) markServerLike(fn);
  return () => {
    for (const fn of fns) {
      delete (fn as unknown as Record<string, unknown>).$$FORM_ACTION;
      delete (fn as unknown as Record<string, unknown>).bind;
    }
  };
}

// ---------------------------------------------------------------------------
// Markup helpers
// ---------------------------------------------------------------------------

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
}

export function uuidsIn(html: string): string[] {
  return [...new Set(html.match(UUID_RE) ?? [])].sort();
}

const FRAGMENT = String.fromCharCode(35);

/** Every `a[href]` and form `action`: fragments must resolve, the rest must be allow-listed. */
export function hrefViolations(doc: Document, isAllowed: (href: string) => boolean): string[] {
  const out: string[] = [];
  for (const a of doc.body.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith(FRAGMENT)) {
      const id = decodeURIComponent(href.slice(1));
      if (id === "" || doc.getElementById(id) === null) out.push(`dangling:${href}`);
      continue;
    }
    if (!isAllowed(href)) out.push(`href:${href}`);
  }
  for (const f of doc.body.querySelectorAll("form[action]")) {
    const action = f.getAttribute("action") ?? "";
    if (action === "") continue;
    if (action.toLowerCase().includes("javascript:")) out.push(`form-action:${action}`);
    else if (!isAllowed(action)) out.push(`form-action:${action}`);
  }
  return out;
}

/** One h1, first heading is the h1, no skipped levels going down. */
export function headingViolations(doc: Document): string[] {
  const levels = [...doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));
  const out: string[] = [];
  const h1 = levels.filter((l) => l === 1).length;
  if (h1 !== 1) out.push(`h1 count ${h1}`);
  for (let i = 1; i < levels.length; i += 1) {
    const prev = levels[i - 1] ?? 1;
    const cur = levels[i] ?? 1;
    if (cur > prev + 1) out.push(`skip h${prev}->h${cur} at index ${i}`);
  }
  return out;
}

export function duplicateIds(doc: Document): string[] {
  const seen = new Map<string, number>();
  for (const el of doc.body.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

/** Labels: every visible input/select/textarea has an associated label or aria name. */
export function unlabelledControls(doc: Document): string[] {
  const out: string[] = [];
  for (const el of doc.body.querySelectorAll("input, select, textarea")) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "hidden" || type === "submit") continue;
    const id = el.getAttribute("id");
    const hasFor = id !== null && doc.body.querySelector(`label[for="${CSS.escape(id)}"]`) !== null;
    const wrapped = el.closest("label") !== null;
    const aria = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
    if (!hasFor && !wrapped && !aria) out.push(el.getAttribute("name") ?? el.outerHTML.slice(0, 60));
  }
  return out;
}

export function isRealPostForm(form: Element): boolean {
  const method = (form.getAttribute("method") ?? "").toLowerCase();
  const enctype = form.getAttribute("enctype") ?? "";
  const action = form.getAttribute("action") ?? "";
  return method === "post" && enctype === "multipart/form-data" && !action.toLowerCase().includes("javascript:");
}

/**
 * What a no-JS browser would submit for `form` (successful controls only:
 * checked radios/checkboxes, the selected option, every hidden input incl.
 * React's `$ACTION_*` plumbing), with `overrides` applied as if typed. The
 * body goes through a real multipart `Request` round trip.
 */
export async function browserSubmit(
  form: Element,
  overrides: Readonly<Record<string, string | null>> = {},
): Promise<FormData> {
  const fd = new FormData();
  const seen = new Set<string>();
  for (const el of form.querySelectorAll("input[name], select[name], textarea[name]")) {
    if (el.hasAttribute("disabled")) continue;
    const name = el.getAttribute("name") ?? "";
    if (name === "") continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (name in overrides) {
      if (seen.has(name)) continue;
      seen.add(name);
      const v = overrides[name];
      if (v !== null && v !== undefined) fd.append(name, v);
      continue;
    }
    if ((type === "radio" || type === "checkbox") && !el.hasAttribute("checked")) continue;
    if (type === "submit" || type === "button" || type === "file") continue;
    if (tag === "select") {
      const selected = el.querySelector("option[selected]") ?? el.querySelector("option");
      fd.append(name, selected?.getAttribute("value") ?? selected?.textContent ?? "");
      continue;
    }
    if (tag === "textarea") {
      fd.append(name, el.textContent ?? "");
      continue;
    }
    fd.append(name, el.getAttribute("value") ?? (type === "checkbox" || type === "radio" ? "on" : ""));
  }
  for (const [name, v] of Object.entries(overrides)) {
    if (!seen.has(name) && v !== null && form.querySelector(`[name="${CSS.escape(name)}"]`) === null) fd.append(name, v);
  }
  const request = new Request("http://localhost/checkout", { method: "POST", body: fd });
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) throw new Error("not a multipart body");
  return parseMultipartText(await request.text(), contentType);
}

/**
 * Minimal multipart/form-data parser for text fields. Needed because
 * happy-dom's `Request.formData()` drops empty-valued parts (its serializer is
 * correct), which would hide React's empty `$ACTION_*` hidden inputs.
 */
export function parseMultipartText(body: string, contentType: string): FormData {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (boundary === undefined) throw new Error("no boundary");
  const out = new FormData();
  for (const part of body.split(`--${boundary}`)) {
    if (part === "" || part.startsWith("--")) continue;
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const split = trimmed.indexOf("\r\n\r\n");
    if (split === -1) continue;
    const head = trimmed.slice(0, split);
    const value = trimmed.slice(split + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (name !== undefined) out.append(name, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface SignedInUser {
  readonly userId: string;
  readonly ownerKey: string;
  readonly token: string;
  readonly email: string;
  readonly displayName: string;
}

/** A user + live auth session created through the real auth repository. */
export async function createSignedInUser(db: Database, displayName: string, emailLocal: string): Promise<SignedInUser> {
  const { createAuthRepository } = await import("@/server/auth/auth-repository");
  const repo = createAuthRepository(db);
  const passwordHash = `$argon2id$v=19$m=65536,t=2,p=1$t111bsalt$t111bhash${emailLocal}`;
  const created = repo.createUser({ email: `${emailLocal}@example.test`, passwordHash, displayName });
  if (!created.ok) throw new Error(`createUser failed: ${created.error.code}`);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const session = repo.createAuthSession({
    userId: created.value.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  if (!session.ok) throw new Error(`createAuthSession failed: ${session.error.code}`);
  return { userId: created.value.id, ownerKey: created.value.ownerKey, token, email: created.value.email, displayName };
}

export function totalChanges(db: Database): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

export function stockOf(db: Database, productId: string): number {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(productId)?.stock ?? -1;
}

/** Card + address values a shopper types into the v2 checkout form (new-address mode). */
export const TYPED_NEW_ADDRESS: Readonly<Record<string, string>> = {
  addressMode: "new",
  fullName: "Quinn Journeyer",
  email: "quinn.journeyer@example.test",
  line1: "12 Journey Lane",
  line2: "",
  city: "Portland",
  region: "OR",
  postalCode: "97201",
  country: "US",
  nameOnCard: "Quinn Journeyer",
  number: "4242 4242 4242 4242",
  expMonth: "12",
  expYear: "2031",
  cvc: "987",
};

/** Asserts nothing in `html` looks like card data beyond last4. */
export function cardLeaks(html: string): string[] {
  const out: string[] = [];
  for (const needle of ["4242424242424242", "4242 4242 4242 4242", "4000000000000002", "987"]) {
    if (needle === "987") {
      if (/name="cvc"[^>]*value="987"/.test(html) || />987</.test(html)) out.push("cvc");
      continue;
    }
    if (html.includes(needle)) out.push(needle);
  }
  return out;
}
