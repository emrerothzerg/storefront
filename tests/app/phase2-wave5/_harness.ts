/**
 * Shared harness for the T104a page QA files (QA-owned). Registers process-wide
 * `next/*` mocks that SPREAD the real modules and delegate to per-test state,
 * so other test files sharing the process keep working. Every page file calls
 * `installNextMocks()` before importing its page module.
 */
import { mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type { Address } from "@/lib/types";

export class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND (QA sentinel)");
  }
}

export class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT (QA sentinel) ${url}`);
  }
}

/** Cookie store double: records every write attempt. */
export class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly writes: string[] = [];
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
  set(name: string): void {
    this.writes.push(`set:${name}`);
  }
  delete(name: string): void {
    this.writes.push(`delete:${name}`);
  }
}

export const harness = {
  store: new FakeCookieStore(),
  cookieReads: 0,
  connectionCalls: 0,
  notFoundCalls: 0,
};

const realServer = { ...(await import("next/server")) };
const realHeaders = { ...(await import("next/headers")) };
const realNavigation = { ...(await import("next/navigation")) };

export function installNextMocks(): void {
  mock.module("next/server", () => ({
    ...realServer,
    connection: async (): Promise<void> => {
      harness.connectionCalls += 1;
    },
  }));
  mock.module("next/headers", () => ({
    ...realHeaders,
    cookies: async (): Promise<FakeCookieStore> => {
      harness.cookieReads += 1;
      return harness.store;
    },
    headers: async (): Promise<Headers> => new Headers(),
  }));
  mock.module("next/navigation", () => ({
    ...realNavigation,
    notFound: (): never => {
      harness.notFoundCalls += 1;
      throw new NotFoundSentinel();
    },
    redirect: (url: string): never => {
      throw new RedirectSentinel(url);
    },
  }));
}

installNextMocks();

export function resetCookies(cookies: Readonly<Record<string, string>> = {}): FakeCookieStore {
  harness.store = new FakeCookieStore();
  for (const [k, v] of Object.entries(cookies)) harness.store.jar.set(k, v);
  harness.cookieReads = 0;
  harness.notFoundCalls = 0;
  return harness.store;
}

/** Outcome of calling a page function: rendered element, notFound(), redirect() or another error. */
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

// ---------------------------------------------------------------------------
// `$$FORM_ACTION` server-reference fixture (pattern from ReviewCard.test.tsx):
// patches the REAL exported action function objects so React SSR renders a
// real POST/multipart form, and `.bind` keeps the marker. `restore()` deletes
// the own properties again (the functions themselves are never replaced).
// ---------------------------------------------------------------------------

const formFields = () => ({
  name: "$ACTION_REF_QA",
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
// Markup checks
// ---------------------------------------------------------------------------

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
}

/**
 * Every `a[href]`: same-page `#id` links must target an element on the page
 * (T89 ruling); everything else must pass `isAllowedInternalHref`.
 */
export function hrefViolations(doc: Document | Element, isAllowed: (href: string) => boolean): string[] {
  const root = "body" in doc ? doc.body : doc;
  const out: string[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      if (id === "" || root.querySelector(`[id="${CSS.escape(id)}"]`) === null) out.push(`dangling:${href}`);
      continue;
    }
    if (!isAllowed(href)) out.push(`href:${href}`);
  }
  return out;
}

/** One h1, first heading is the h1, no skipped levels going down. */
export function headingViolations(root: Document | Element): string[] {
  const scope = "body" in root ? root.body : root;
  const levels = [...scope.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));
  const out: string[] = [];
  const h1 = levels.filter((l) => l === 1).length;
  if (h1 !== 1) out.push(`h1 count ${h1}`);
  if (levels[0] !== 1) out.push(`first heading is h${levels[0] ?? "none"}`);
  for (let i = 1; i < levels.length; i += 1) {
    const prev = levels[i - 1] ?? 1;
    const cur = levels[i] ?? 1;
    if (cur > prev + 1) out.push(`skip h${prev}->h${cur} at #${i}`);
  }
  return out;
}

export function duplicateIds(root: Document | Element): string[] {
  const scope = "body" in root ? root.body : root;
  const seen = new Map<string, number>();
  for (const el of scope.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

/** Accessible name of a form: aria-label, aria-labelledby text, or "" when unnamed. */
export function formName(form: Element): string {
  const label = form.getAttribute("aria-label");
  if (label !== null) return label.trim();
  const by = form.getAttribute("aria-labelledby");
  if (by !== null) {
    const doc = form.ownerDocument;
    return by
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  return "";
}

/** Named forms (role=form only when named) must have unique names. */
export function duplicateFormNames(root: Document | Element): string[] {
  const scope = "body" in root ? root.body : root;
  const names = [...scope.querySelectorAll("form")].map(formName).filter((n) => n !== "");
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([n]) => n);
}

/** Visible submit buttons without a 44px touch-target class. */
export function smallSubmitButtons(root: Document | Element): string[] {
  const scope = "body" in root ? root.body : root;
  const out: string[] = [];
  for (const b of scope.querySelectorAll('button[type="submit"], button:not([type])')) {
    if (b.closest("[hidden]") !== null) continue;
    const cls = b.getAttribute("class") ?? "";
    if (!/\b(min-h-touch|h-touch|size-touch)\b/.test(cls)) out.push((b.textContent ?? "").trim() || "(unnamed)");
  }
  return out;
}

export interface FormShape {
  readonly method: string;
  readonly enctype: string;
  readonly action: string;
}

export function formShape(form: Element): FormShape {
  return {
    method: (form.getAttribute("method") ?? "").toLowerCase(),
    enctype: form.getAttribute("enctype") ?? "",
    action: form.getAttribute("action") ?? "",
  };
}

export function isRealPostForm(form: Element): boolean {
  const s = formShape(form);
  return s.method === "post" && s.enctype === "multipart/form-data" && !s.action.includes("javascript:");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface SignedInUser {
  readonly userId: string;
  readonly ownerKey: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

/** A user + live auth session created through the real auth repository. */
export async function createSignedInUser(db: Database, displayName: string, emailLocal: string): Promise<SignedInUser> {
  const { createAuthRepository } = await import("@/server/auth/auth-repository");
  const repo = createAuthRepository(db);
  const passwordHash = `$argon2id$v=19$m=65536,t=2,p=1$qafixturesalt$qafixturehash${emailLocal}`;
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
  return {
    userId: created.value.id,
    ownerKey: created.value.ownerKey,
    token,
    tokenHash,
    email: created.value.email,
    displayName,
    passwordHash,
  };
}

export const QA_ADDRESS: Address = {
  fullName: "Zelda Quartermaine",
  email: "zelda.quartermaine@example.test",
  line1: "742 Evergreen Terrace QA",
  city: "Springfieldqa",
  region: "OR",
  postalCode: "97475",
  country: "US",
};

/** Places a real paid order (cart service + order service v2, zero-latency mock payments). */
export async function placePaidOrder(
  db: Database,
  ownerKey: string,
  productIds: readonly string[],
  address: Address = QA_ADDRESS,
): Promise<{ readonly orderId: string; readonly idempotencyKey: string }> {
  const { createCartService } = await import("@/server/cart/cart-service");
  const { createOrderService } = await import("@/server/orders/order-service");
  const { createMockPaymentProvider, MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
  const carts = createCartService(db);
  for (const id of productIds) {
    const r = carts.addItem(ownerKey, id, 1);
    if (!r.ok) throw new Error(`addItem failed: ${r.error.code}`);
  }
  const orders = createOrderService(db, { payments: createMockPaymentProvider({ latencyMs: 0 }), inFlight: new Map() });
  const idempotencyKey = `qa-idem-${crypto.randomUUID()}`;
  const placed = await orders.placeOrderV2({
    sessionId: ownerKey,
    address,
    card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2031, cvc: "987", nameOnCard: address.fullName },
    idempotencyKey,
  });
  if (!placed.ok) throw new Error(`placeOrderV2 failed: ${JSON.stringify(placed.error)}`);
  return { orderId: placed.value.id, idempotencyKey };
}

export function totalChanges(db: Database): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}
