/**
 * T173 — QA wave C2, account / orders / lists / compare / auth / static pages
 * after T171 (light-only pass), plus not-found and error. QA-owned.
 *
 * Criteria: BACKLOG-phase3 T171 AC1–AC3, T173 AC4 (signed-out account route
 * redirects; no theme code in the HTML), R3 (no-JS forms, landmarks, one h1,
 * 44px targets, cookie rules), CONTRACTS G rows. Page functions are called
 * directly with the wave-5 harness mocks and a `:memory:` seeded DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expectNotNull } from "@/test/dom-assertions";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import {
  createSignedInUser,
  duplicateIds,
  harness,
  headingViolations,
  hrefViolations,
  installNextMocks,
  isRealPostForm,
  NotFoundSentinel,
  parseHtml,
  placePaidOrder,
  resetCookies,
  serverLike,
  type SignedInUser,
} from "../phase2-wave5/_harness";
import {
  brandAndThemeViolations,
  darkClassTokens,
  darkSurfaceTokens,
  landmarkViolations,
  smallTargets,
  themeToggles,
  withChrome,
} from "./_phase3";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const { HELP_TOPIC_SLUGS } = await import("@/content/help-topics");
const { SITE_NAME } = await import("@/lib/seo/site");
const { FOOTER_COLUMNS } = await import("@/content/navigation");
const { SiteFooter } = await import("@/components/organisms/SiteFooter");
const { HeaderShell } = await import("@/app/_layout/HeaderShell");

// Every server action module: marked server-like so React SSR renders real POST forms (production shape).
const ACTION_MODULES = await Promise.all([
  import("@/app/actions/account"),
  import("@/app/actions/addresses"),
  import("@/app/actions/auth"),
  import("@/app/actions/cart"),
  import("@/app/actions/contact"),
  import("@/app/actions/lists"),
  import("@/app/actions/orders"),
  import("@/app/actions/questions"),
  import("@/app/actions/reviews"),
  import("@/app/actions/stock-alerts"),
  import("@/app/actions/views"),
  // Page-local "use server" adapters.
  import("@/app/lists/_lib/list-form-actions"),
  import("@/app/account/settings/_lib/settings-form-actions"),
  import("@/app/_layout/header-actions"),
]);
type AnyAction = Parameters<typeof serverLike>[0][number];
const ALL_ACTIONS: AnyAction[] = ACTION_MODULES.flatMap((m) =>
  Object.values(m).filter((v): v is AnyAction => typeof v === "function"),
);

type PageFn = (props: Record<string, unknown>) => Promise<ReactElement> | ReactElement;
type Meta = { robots?: unknown } | undefined;
interface PageModule {
  default: PageFn;
  metadata?: Meta;
  generateMetadata?: (props: Record<string, unknown>) => Promise<Meta>;
}

const load = async (path: string): Promise<PageModule> => (await import(path)) as PageModule;
const MODULES = {
  hub: await load("@/app/account/page"),
  addresses: await load("@/app/account/addresses/page"),
  alerts: await load("@/app/account/alerts/page"),
  contributions: await load("@/app/account/contributions/page"),
  history: await load("@/app/account/history/page"),
  messages: await load("@/app/account/messages/page"),
  settings: await load("@/app/account/settings/page"),
  orders: await load("@/app/orders/page"),
  order: await load("@/app/orders/[id]/page"),
  invoice: await load("@/app/orders/[id]/invoice/page"),
  lists: await load("@/app/lists/page"),
  list: await load("@/app/lists/[id]/page"),
  shared: await load("@/app/lists/shared/[token]/page"),
  compare: await load("@/app/compare/page"),
  signin: await load("@/app/signin/page"),
  signup: await load("@/app/signup/page"),
  help: await load("@/app/help/page"),
  helpTopic: await load("@/app/help/[topic]/page"),
  faq: await load("@/app/faq/page"),
  contact: await load("@/app/contact/page"),
  about: await load("@/app/about/page"),
  accessibility: await load("@/app/accessibility/page"),
  privacy: await load("@/app/privacy/page"),
  returns: await load("@/app/returns/page"),
  shipping: await load("@/app/shipping/page"),
  terms: await load("@/app/terms/page"),
};
const notFoundModule = await load("@/app/not-found");
const errorModule = (await import("@/app/error")) as unknown as { default: (p: { error: unknown; retry: () => void }) => ReactElement };

type Key = keyof typeof MODULES;
const sp = (q: Record<string, string> = {}) => Promise.resolve(q);

/** Props per route (dynamic segments get a value that exists only where noted). */
function propsFor(key: Key, ids: { order?: string; topic?: string } = {}): Record<string, unknown> {
  switch (key) {
    case "order":
    case "invoice":
      return { params: Promise.resolve({ id: ids.order ?? "00000000-0000-4000-8000-000000000000" }), searchParams: sp() };
    case "list":
      return { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }), searchParams: sp() };
    case "shared":
      return { params: Promise.resolve({ token: "x".repeat(43) }), searchParams: sp() };
    case "helpTopic":
      return { params: Promise.resolve({ topic: ids.topic ?? HELP_TOPIC_SLUGS[0] }), searchParams: sp() };
    case "compare":
      return { searchParams: sp({ p: "canvas-tote-bag" }) };
    default:
      return { searchParams: sp() };
  }
}

type Outcome = { kind: "ok"; html: string; doc: Document } | { kind: "notFound" } | { kind: "redirect"; url: string };

/** Accepts the wave-5 sentinel, Next's real redirect error, or any NEXT_REDIRECT-message sentinel (see the auth QA addendum). */
function redirectTarget(error: unknown): string | null {
  if (isRedirectError(error)) return getURLFromRedirectError(error);
  if (!(error instanceof Error) || !error.message.startsWith("NEXT_REDIRECT")) return null;
  const url: unknown = (error as Error & { url?: unknown }).url;
  if (typeof url === "string") return url;
  return error.message.split(/\s+/).find((t) => t.startsWith("/")) ?? null;
}

async function run(key: Key, ids: { order?: string; topic?: string } = {}): Promise<Outcome> {
  const restore = serverLike(ALL_ACTIONS);
  try {
    const el = await MODULES[key].default(propsFor(key, ids));
    const html = renderToStaticMarkup(el);
    return { kind: "ok", html, doc: parseHtml(html) };
  } catch (error) {
    if (error instanceof NotFoundSentinel || (error instanceof Error && error.message.startsWith("NEXT_NOT_FOUND"))) return { kind: "notFound" };
    const url = redirectTarget(error);
    if (url !== null) return { kind: "redirect", url };
    throw error;
  } finally {
    restore();
  }
}

async function metaOf(key: Key, ids: { order?: string; topic?: string } = {}): Promise<Meta> {
  const mod = MODULES[key];
  if (mod.generateMetadata !== undefined) return mod.generateMetadata(propsFor(key, ids));
  return mod.metadata;
}

const robotsIndex = (m: Meta): boolean | undefined => {
  const r = m?.robots as { index?: boolean } | undefined;
  return r?.index;
};

/**
 * SR6 exempts links inside running text: a link whose parent element also holds
 * direct text (a sentence around it), e.g. "Use … on product pages, or browse all products.".
 */
const inlineInText = (el: Element): boolean =>
  el.tagName === "A" &&
  [...(el.parentElement?.childNodes ?? [])].some((n) => n.nodeType === 3 && /[A-Za-z]/.test(n.textContent ?? ""));

const PRIVATE: Key[] = ["hub", "addresses", "alerts", "contributions", "history", "messages", "settings", "orders", "order", "invoice", "lists", "list", "shared", "signin", "signup", "contact"];
const INDEXABLE: Key[] = ["help", "helpTopic", "faq", "about", "accessibility", "privacy", "returns", "shipping", "terms"];
const GUEST_OK: Key[] = ["hub", "addresses", "alerts", "contributions", "history", "messages", "orders", "lists", "compare", "signin", "signup", "help", "helpTopic", "faq", "contact", "about", "accessibility", "privacy", "returns", "shipping", "terms"];
const SUB_PAGES: Key[] = ["addresses", "alerts", "contributions", "history", "messages"];

let user: SignedInUser;
let orderId = "";
const mints = {
  getOrCreateSessionId: spyOn(session, "getOrCreateSessionId"),
  rotateGuestSession: spyOn(session, "rotateGuestSession"),
  setAuthCookie: spyOn(session, "setAuthCookie"),
  clearAuthCookie: spyOn(session, "clearAuthCookie"),
};

function expectNoMint(label: string): void {
  const called = Object.entries(mints).filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n);
  expect([label, called, harness.store.writes]).toEqual([label, [], []]);
}

/**
 * Known sub-44px standalone links, pinned as D-T171-1 below (excluded here so
 * every other check on those pages keeps running).
 */
const D_T171_1: Readonly<Record<string, readonly string[]>> = {
  compare: ["a:Canvas Tote Bag"],
  order: ["a:Canvas Tote Bag", "a:Continue shopping"],
  invoice: ["a:Back to order"],
};

function pageChecks(label: string, doc: Document, html: string): void {
  expect([label, doc.querySelectorAll("h1").length]).toEqual([label, 1]);
  expect([label, headingViolations(doc).filter((v) => !v.startsWith("first heading"))]).toEqual([label, []]);
  expect([label, duplicateIds(doc)]).toEqual([label, []]);
  expect([label, hrefViolations(doc, (h) => isAllowedInternalHref(h) || h.startsWith("mailto:?"))]).toEqual([label, []]);
  const posts = [...doc.querySelectorAll("form")].filter((f) => (f.getAttribute("method") ?? "").toLowerCase() !== "get");
  expect([label, posts.filter((f) => !isRealPostForm(f)).map((f) => f.getAttribute("action"))]).toEqual([label, []]);
  expect([label, html.toLowerCase().includes("javascript:")]).toEqual([label, false]);
  const known = D_T171_1[label] ?? [];
  expect([label, smallTargets(doc, inlineInText).filter((t) => !known.includes(t))]).toEqual([label, []]);
  expect([label, darkClassTokens(doc)]).toEqual([label, []]);
  expect([label, darkSurfaceTokens(doc)]).toEqual([label, []]);
  expect([label, brandAndThemeViolations(html)]).toEqual([label, []]);
  expect([label, themeToggles(doc)]).toEqual([label, []]);
  expect([label, landmarkViolations(doc, { chrome: false })]).toEqual([label, []]);
}

beforeAll(async () => {
  closeDatabase();
  seedDatabase(getDatabase());
  user = await createSignedInUser(getDatabase(), "Tess Account", "tess.account.t173");
  orderId = (await placePaidOrder(getDatabase(), user.ownerKey, ["prod_canvas-tote-bag"])).orderId;
});

beforeEach(() => {
  resetCookies();
  for (const s of Object.values(mints)) s.mockClear();
});

afterAll(() => {
  for (const s of Object.values(mints)) s.mockRestore();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
});

// ---------------------------------------------------------------------------
// Guest states
// ---------------------------------------------------------------------------

describe("guest (no cookie): 200 pages, one h1, no-JS forms, 44px, light-only, brand-free, nothing minted", () => {
  test.each(GUEST_OK.map((k) => [k]))("%s", async (key) => {
    const out = await run(key);
    if (out.kind !== "ok") throw new Error(`${key}: ${out.kind} ${"url" in out ? out.url : ""}`);
    pageChecks(key, out.doc, out.html);
    expectNoMint(key);
  });

  test("account sub-pages show the guest invitation: Sign in / Create account pills returning to the page (?next=)", async () => {
    for (const key of SUB_PAGES) {
      const out = await run(key);
      if (out.kind !== "ok") throw new Error(key);
      const group = out.doc.querySelector('[role="group"][aria-label="Sign in to your account"]');
      expect([key, group !== null]).toEqual([key, true]);
      const links = [...(group?.querySelectorAll("a") ?? [])];
      const next = encodeURIComponent(`/account/${key}`);
      expect([key, links.map((a) => a.getAttribute("href"))]).toEqual([key, [`/signin?next=${next}`, `/signup?next=${next}`]]);
      for (const a of links) expect([key, (a.getAttribute("class") ?? "").includes("rounded-full")]).toEqual([key, true]);
    }
  });

  test("signed-out /account/settings redirects to /signin?next=%2Faccount%2Fsettings (T173 AC4), writing nothing", async () => {
    const out = await run("settings");
    expect(out).toEqual({ kind: "redirect", url: "/signin?next=%2Faccount%2Fsettings" });
    expectNoMint("settings");
  });

  test("garbage/unknown ids -> notFound (orders, invoice, lists, shared list, help topic)", async () => {
    for (const [key, ids] of [
      ["order", { order: "not-an-id" }],
      ["order", {}],
      ["invoice", { order: "<script>" }],
      ["list", {}],
      ["shared", {}],
      ["helpTopic", { topic: "../../etc" }],
    ] as [Key, { order?: string; topic?: string }][]) {
      expect([key, (await run(key, ids)).kind]).toEqual([key, "notFound"]);
    }
    expectNoMint("ids");
  });

  test("garbage cookies behave like no cookie (no throw, nothing rewritten)", async () => {
    for (const cookies of [
      { [session.SESSION_COOKIE_NAME]: "garbage" },
      { [session.AUTH_COOKIE_NAME]: "x".repeat(300) },
      { [session.SESSION_COOKIE_NAME]: "", [session.AUTH_COOKIE_NAME]: "" },
    ] as Record<string, string>[]) {
      for (const key of ["hub", "orders", "lists", "signin", "history"] as Key[]) {
        resetCookies(cookies);
        expect([key, (await run(key)).kind]).toEqual([key, "ok"]);
        expect([key, harness.store.writes]).toEqual([key, []]);
      }
      resetCookies(cookies);
      expect((await run("settings")).kind).toBe("redirect");
    }
  });
});

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

describe("signed in: pages render the user's data, no secrets in markup, auth pages redirect", () => {
  const SIGNED_OK: Key[] = ["hub", "addresses", "alerts", "contributions", "history", "messages", "settings", "orders", "lists", "contact"];

  test.each(SIGNED_OK.map((k) => [k]))("%s: one h1, checks, no token/hash/owner key/password hash in HTML", async (key) => {
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const out = await run(key);
    if (out.kind !== "ok") throw new Error(`${key}: ${out.kind} ${"url" in out ? out.url : ""}`);
    pageChecks(key, out.doc, out.html);
    for (const secret of [user.token, user.tokenHash, user.passwordHash, user.ownerKey, user.userId]) {
      expect([key, out.html.includes(secret)]).toEqual([key, false]);
    }
    expect([key, out.doc.querySelector('[aria-label="Sign in to your account"]') === null]).toEqual([key, true]);
    expect(harness.store.writes).toEqual([]);
  });

  test("hub greets the user by display name; order detail + invoice render for the owner", async () => {
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const hub = await run("hub");
    expect(hub.kind === "ok" && (hub.doc.body.textContent ?? "").includes("Tess Account")).toBe(true);
    for (const key of ["order", "invoice"] as Key[]) {
      const out = await run(key, { order: orderId });
      if (out.kind !== "ok") throw new Error(`${key}: ${out.kind}`);
      pageChecks(key, out.doc, out.html);
      expect([key, out.html.includes(user.token) || out.html.includes(user.ownerKey)]).toEqual([key, false]);
    }
  });

  test("another visitor cannot open the owner's order (notFound), even signed out or with a guest cookie", async () => {
    for (const cookies of [{}, { [session.SESSION_COOKIE_NAME]: "f0f0f0f0-1737-4173-8173-0000000000f0" }] as Record<string, string>[]) {
      resetCookies(cookies);
      expect((await run("order", { order: orderId })).kind).toBe("notFound");
      expect((await run("invoice", { order: orderId })).kind).toBe("notFound");
    }
  });

  test("signed-in /signin and /signup redirect to /account; no form is rendered", async () => {
    for (const key of ["signin", "signup"] as Key[]) {
      resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
      expect(await run(key)).toEqual({ kind: "redirect", url: "/account" });
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("metadata: private routes noindex, help/policy pages indexable, compare noindex+follow", () => {
  test.each(PRIVATE.map((k) => [k]))("%s is noindex", async (key) => {
    const ids = key === "order" || key === "invoice" ? { order: orderId } : {};
    expect(robotsIndex(await metaOf(key, ids))).toBe(false);
  });

  test.each(INDEXABLE.map((k) => [k]))("%s stays indexable", async (key) => {
    expect(robotsIndex(await metaOf(key))).not.toBe(false);
  });

  test("compare: index false, follow true; not-found: noindex", async () => {
    expect(MODULES.compare.metadata?.robots).toEqual({ index: false, follow: true });
    expect(robotsIndex(notFoundModule.metadata)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// not-found and error (T171 AC2)
// ---------------------------------------------------------------------------

describe("not-found and error pages (T171 AC2)", () => {
  test("not-found: one h1, a link home, a GET search form to /search, light-only, brand-free", () => {
    const html = renderToStaticMarkup(notFoundModule.default({}) as ReactElement);
    const doc = parseHtml(html);
    expect(doc.querySelectorAll("h1").length).toBe(1);
    expectNotNull(doc.querySelector('a[href="/"]') ?? null);
    const search = [...doc.querySelectorAll("form")].find((f) => f.getAttribute("action") === "/search");
    expect(search !== undefined).toBe(true);
    expect((search?.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    expect(smallTargets(doc, inlineInText)).toEqual([]);
    expect(darkClassTokens(doc)).toEqual([]);
    expect(darkSurfaceTokens(doc)).toEqual([]);
    expect(brandAndThemeViolations(html)).toEqual([]);
  });

  test("error: one h1, retry button, links home and to search; never shows the error message or digest", () => {
    const secret = Object.assign(new Error("SECRET-DB-PATH /var/data leaked"), { digest: "DIGEST-QA-173" });
    const err = console.error;
    console.error = () => undefined;
    try {
      const html = renderToStaticMarkup(createElement(errorModule.default, { error: secret, retry: () => undefined }));
      const doc = parseHtml(html);
      expect(doc.querySelectorAll("h1").length).toBe(1);
      expect([...doc.querySelectorAll("button")].length).toBeGreaterThan(0);
      expectNotNull(doc.querySelector('a[href="/"]') ?? null);
      expect(html).not.toContain("SECRET-DB-PATH");
      expect(html).not.toContain("DIGEST-QA-173");
      expect(smallTargets(doc, inlineInText)).toEqual([]);
      expect(darkClassTokens(doc)).toEqual([]);
      expect(brandAndThemeViolations(html)).toEqual([]);
    } finally {
      console.error = err;
    }
  });
});

// PIN: D-T171-2 — src/app/error.tsx offers "Try again" and "Back to the catalog" (/) but no way to search
// (no `/search` link or search form); T171 AC2 says the 404 AND error pages keep links home and to search.
test("D-T171-2: the error page links to search (T171 AC2)", () => {
  const err = console.error;
  console.error = () => undefined;
  try {
    const html = renderToStaticMarkup(createElement(errorModule.default, { error: new Error("x"), retry: () => undefined }));
    expectNotNull(parseHtml(html).querySelector('a[href^="/search"], form[action="/search"]') ?? null);
  } finally {
    console.error = err;
  }
});

// PIN: D-T171-1 — standalone text links without a 44px target (SR6, R3), not inside running text:
// /compare product-name link in the CompareTable column header, and on /orders/<id> the line's product-name
// link (alone in its <p>) and "Continue shopping" (alone in a <div>); on /orders/<id>/invoice "Back to order".
// Plain `Link` default variant, no `min-h-touch`.
test("D-T171-1: compare, order-detail and invoice standalone links are 44px targets", async () => {
  const compare = await run("compare");
  resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
  const order = await run("order", { order: orderId });
  const invoice = await run("invoice", { order: orderId });
  if (compare.kind !== "ok" || order.kind !== "ok" || invoice.kind !== "ok") throw new Error("render");
  expect([compare, order, invoice].flatMap((o) => (o.kind === "ok" ? smallTargets(o.doc, inlineInText) : []))).toEqual([]);
});

// ---------------------------------------------------------------------------
// With the layout chrome
// ---------------------------------------------------------------------------

describe("with the layout chrome: one banner/main/contentinfo, unique nav names, one h1 (G-1…G-6)", () => {
  test.each([["hub"], ["orders"], ["lists"], ["signin"], ["signup"], ["faq"], ["about"], ["contact"], ["compare"], ["help"]] as [Key][])(
    "%s (guest and signed in)",
    async (key) => {
      for (const cookies of [{}, { [session.AUTH_COOKIE_NAME]: user.token }] as Record<string, string>[]) {
        resetCookies(cookies);
        if (key === "signin" || key === "signup") {
          if (session.AUTH_COOKIE_NAME in cookies) continue;
        }
        const restore = serverLike(ALL_ACTIONS);
        try {
          const el = await MODULES[key].default(propsFor(key));
          const html = await withChrome(el, { HeaderShell, SiteFooter, storeName: SITE_NAME, columns: FOOTER_COLUMNS });
          const doc = parseHtml(html);
          expect([key, landmarkViolations(doc, { chrome: true })]).toEqual([key, []]);
          expect([key, doc.querySelectorAll("h1").length]).toEqual([key, 1]);
          expect([key, duplicateIds(doc)]).toEqual([key, []]);
          expect([key, hrefViolations(doc, isAllowedInternalHref)]).toEqual([key, []]);
          expect([key, brandAndThemeViolations(html)]).toEqual([key, []]);
          expect([key, darkSurfaceTokens(doc.querySelector("main") as Element)]).toEqual([key, []]);
        } finally {
          restore();
        }
      }
    },
  );
});
