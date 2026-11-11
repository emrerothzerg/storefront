/**
 * T104b (QA wave 5, part B): page-level QA of the static pages — /help,
 * /help/[topic], /faq, /contact (T101) and the six policy routes (T102,
 * `src/app/_lib/policy-page.ts`). Page functions + metadata called directly
 * with mocked `next/*`, `renderToStaticMarkup`, `:memory:` SQLite. The
 * contact form's no-JS shape uses the `$$FORM_ACTION` server-reference
 * fixture from ReviewCard.test.tsx. QA-owned; pins are `test.failing` tagged
 * `// PIN: D-Txx-n`.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// next/* mocks: identical in all three T104b files, one shared state object.
interface QaState {
  cookieCalls: number;
  notFoundCalls: number;
  jar: Map<string, string>;
}
const g = globalThis as typeof globalThis & { __qaT104b?: QaState };
const qa: QaState = (g.__qaT104b ??= { cookieCalls: 0, notFoundCalls: 0, jar: new Map() });

const realServer = { ...(await import("next/server")) };
const realHeaders = { ...(await import("next/headers")) };
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/server", () => ({ ...realServer, connection: async (): Promise<void> => {} }));
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: async () => {
    qa.cookieCalls += 1;
    return {
      get: (name: string) => (qa.jar.has(name) ? { name, value: qa.jar.get(name) ?? "" } : undefined),
      has: (name: string) => qa.jar.has(name),
      getAll: () => [...qa.jar].map(([name, value]) => ({ name, value })),
      set: () => {
        throw new Error("render must not set cookies");
      },
      delete: () => {
        throw new Error("render must not delete cookies");
      },
    };
  },
  headers: async () => new Headers(),
}));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    qa.notFoundCalls += 1;
    throw new Error("NEXT_NOT_FOUND (T104b sentinel)");
  },
}));

const env = process.env as Record<string, string | undefined>;
env.DATABASE_PATH = ":memory:";
const SITE = "https://shop.example.com";
env.NEXT_PUBLIC_SITE_URL = SITE;

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { isAllowedInternalHref } = await import("@/content/routes");
const { HELP_TOPICS } = await import("@/content/help-topics");
const { POLICY_PAGES, POLICY_SLUGS, SAMPLE_POLICY_NOTICE } = await import("@/content/policies");
const { CONTACT_FIELD } = await import("@/components/molecules/_contracts/contact-actions");
const contactActions = await import("@/app/actions/contact");

const helpPage = await import("@/app/help/page");
const helpTopicPage = await import("@/app/help/[topic]/page");
const faqPage = await import("@/app/faq/page");
const contactPage = await import("@/app/contact/page");
const POLICY_MODULES = {
  about: await import("@/app/about/page"),
  shipping: await import("@/app/shipping/page"),
  returns: await import("@/app/returns/page"),
  privacy: await import("@/app/privacy/page"),
  terms: await import("@/app/terms/page"),
  accessibility: await import("@/app/accessibility/page"),
} as const;

type SP = Record<string, string | string[] | undefined>;

let db: Database;

// ---------------------------------------------------------------------------
// `$$FORM_ACTION` fixture: marks the REAL exported action object so React SSR
// renders a real POST/multipart form; `.bind` keeps the marker. Restored in afterAll.
// ---------------------------------------------------------------------------
const formFields = () => ({ name: "$ACTION_REF_QA_T104B", action: "", encType: "multipart/form-data", method: "POST", data: null });
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
const sendContact = contactActions.sendContactMessage as unknown as AnyFn;

beforeAll(() => {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  closeDatabase();
  db = getDatabase();
  seedDatabase(db);
  markServerLike(sendContact);
});

afterAll(() => {
  delete (sendContact as unknown as Record<string, unknown>).$$FORM_ACTION;
  delete (sendContact as unknown as Record<string, unknown>).bind;
  qa.jar.clear();
  closeDatabase();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HASH = String.fromCharCode(35);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A raw hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa) written with \x23 so this file never contains one. */
const HEX_COLOUR = /\x23(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_])/i;
const INDEXABLE = undefined;
const NOINDEX_NOFOLLOW = { index: false, follow: false };

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, "text/html");
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const digest = (error as { digest?: unknown } | null)?.digest;
  return /NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/.test(`${message} ${typeof digest === "string" ? digest : ""}`);
}

async function renderTree(run: () => ReactNode | Promise<ReactNode>): Promise<{ html: string; doc: Document }> {
  const tree = await run();
  const html = renderToStaticMarkup(<>{tree}</>);
  return { html, doc: parseHtml(html) };
}

function hrefs(doc: Document): string[] {
  return [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
}

function hrefViolations(doc: Document): string[] {
  const out: string[] = [];
  for (const href of hrefs(doc)) {
    if (href.startsWith(HASH)) {
      const id = decodeURIComponent(href.slice(1));
      if (id === "" || doc.getElementById(id) === null) out.push(`dangling:${href}`);
    } else if (!isAllowedInternalHref(href)) out.push(href);
  }
  return out;
}

function headingViolations(doc: Document): string[] {
  const levels = [...doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));
  const out: string[] = [];
  const h1 = levels.filter((l) => l === 1).length;
  if (h1 !== 1) out.push(`h1 count ${h1}`);
  if (levels[0] !== 1) out.push(`first heading h${levels[0] ?? "none"}`);
  for (let i = 1; i < levels.length; i += 1) {
    const prev = levels[i - 1] ?? 1;
    const cur = levels[i] ?? 1;
    if (cur > prev + 1) out.push(`skip h${prev}->h${cur} at ${i}`);
  }
  return out;
}

function landmarkName(el: Element, doc: Document): string {
  const label = el.getAttribute("aria-label");
  if (label !== null) return label.trim();
  const by = el.getAttribute("aria-labelledby");
  if (by !== null) return by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ").trim();
  return "";
}

function landmarkViolations(doc: Document): string[] {
  const out: string[] = [];
  if (doc.body.querySelector("main, [role='main']") !== null) out.push("page renders main");
  const groups: Record<string, Element[]> = {
    navigation: [...doc.body.querySelectorAll("nav, [role='navigation']")],
    complementary: [...doc.body.querySelectorAll("aside, [role='complementary']")],
    search: [...doc.body.querySelectorAll("search, [role='search']")],
    region: [...doc.body.querySelectorAll("section[aria-label], section[aria-labelledby], [role='region']")],
  };
  for (const [role, els] of Object.entries(groups)) {
    if (els.length < 2) continue;
    const names = els.map((el) => landmarkName(el, doc));
    if (names.some((n) => n === "")) out.push(`${role}: unnamed among ${els.length}`);
    const dupes = names.filter((n, i) => n !== "" && names.indexOf(n) !== i);
    if (dupes.length > 0) out.push(`${role}: duplicate ${dupes.join("|")}`);
  }
  return out;
}

function duplicateIds(doc: Document): string[] {
  const seen = new Map<string, number>();
  for (const el of doc.body.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

type Json = Record<string, unknown>;

function jsonLdScripts(doc: Document): Element[] {
  return [...doc.querySelectorAll('script[type="application/ld+json"]')];
}

function jsonLdDocs(doc: Document): Json[] {
  return jsonLdScripts(doc).flatMap((s) => {
    const parsed: unknown = JSON.parse(s.textContent ?? "null");
    return Array.isArray(parsed) ? (parsed as Json[]) : [parsed as Json];
  });
}

function markupRuleViolations(doc: Document, html: string): string[] {
  const out = [
    ...headingViolations(doc).map((v) => `heading ${v}`),
    ...landmarkViolations(doc).map((v) => `landmark ${v}`),
    ...duplicateIds(doc).map((v) => `duplicate id ${v}`),
    ...hrefViolations(doc).map((v) => `href ${v}`),
  ];
  const withoutHrefs = html.replace(/\shref="[^"]*"/g, "");
  if (HEX_COLOUR.test(withoutHrefs)) out.push(`hex colour ${HEX_COLOUR.exec(withoutHrefs)?.[0] ?? ""}`);
  if (UUID_RE.test(html)) out.push("UUID in markup");
  return out;
}

function breadcrumbLinks(doc: Document): string[] {
  return [...(doc.querySelector('nav[aria-label="Breadcrumb"]')?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href") ?? "");
}

// Page invokers ---------------------------------------------------------------

const help = (sp: SP = {}) => renderTree(() => helpPage.default({ searchParams: Promise.resolve(sp) }));
const helpMeta = (sp: SP = {}) => helpPage.generateMetadata({ searchParams: Promise.resolve(sp) });
const topic = (slug: string, sp: SP = {}) =>
  renderTree(() => helpTopicPage.default({ params: Promise.resolve({ topic: slug }), searchParams: Promise.resolve(sp) }));
const topicMeta = (slug: string) =>
  helpTopicPage.generateMetadata({ params: Promise.resolve({ topic: slug }), searchParams: Promise.resolve({}) });
const faq = (sp: SP = {}) => renderTree(() => faqPage.default({ searchParams: Promise.resolve(sp) }));
const contact = (sp: SP = {}) => renderTree(() => contactPage.default({ searchParams: Promise.resolve(sp) }));

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

describe("/help (T101)", () => {
  test("metadata: plain indexable + canonical; any ?q= variant noindex, nofollow (canonical stays /help)", async () => {
    const plain = await helpMeta();
    expect({ robots: plain.robots, canonical: plain.alternates?.canonical }).toEqual({ robots: INDEXABLE, canonical: `${SITE}/help` });
    for (const sp of [{ q: "" }, { q: "shipping" }, { q: ["a", "b"] }, { q: "<script>" }, { q: "x".repeat(5000) }] as SP[]) {
      const md = await helpMeta(sp);
      expect({ robots: md.robots, canonical: md.alternates?.canonical }).toEqual({ robots: NOINDEX_NOFOLLOW, canonical: `${SITE}/help` });
    }
    // Unrelated params do not de-index the page.
    expect((await helpMeta({ utm_source: "x" })).robots).toBe(INDEXABLE);
  });

  test("help search with garbage / regex / over-long / hostile input -> 200 with results or empty state", async () => {
    const inputs = [
      "shipping", "(.*", "[", "a+", "^$", "\\", "%", "a".repeat(10_000), "<script>alert(1)</script>",
      "‮returns​", "\u0000\u0007", "\u{1F600}", "   ", "", "?q=", "' OR 1=1 --",
    ];
    for (const q of inputs) {
      const { doc, html } = await help({ q });
      expect({ q: q.slice(0, 20), h1: doc.querySelectorAll("h1").length }).toEqual({ q: q.slice(0, 20), h1: 1 });
      expect(doc.querySelectorAll("script:not([type='application/ld+json'])")).toHaveLength(0);
      expect(html).not.toContain("<script>alert");
      const text = doc.body.textContent ?? "";
      expect(/result|No help articles match|Enter a word or phrase/.test(text)).toBe(true);
      expect(markupRuleViolations(doc, html)).toEqual([]);
    }
    const found = await help({ q: "shipping" });
    expect(found.doc.querySelectorAll("ol li a").length).toBeGreaterThan(0);
  });

  test("help search form is a plain GET form named q, capped by maxlength", async () => {
    const { doc } = await help();
    const form = doc.querySelector("form");
    expect((form?.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
    expect(form?.getAttribute("action")).toBe("/help");
    const input = form?.querySelector('input[name="q"]');
    expect(Number(input?.getAttribute("maxlength") ?? input?.getAttribute("maxLength") ?? "0")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// /help/[topic]
// ---------------------------------------------------------------------------

describe("/help/[topic] (T101)", () => {
  test("every topic: 200, one h1, breadcrumb Home > Help center, canonical /help/<slug>, indexable", async () => {
    for (const t of HELP_TOPICS) {
      const { doc, html } = await topic(t.slug);
      expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toEqual([t.title]);
      expect(breadcrumbLinks(doc)).toEqual(["/", "/help"]);
      expect(markupRuleViolations(doc, html)).toEqual([]);
      const md = await topicMeta(t.slug);
      expect({ slug: t.slug, robots: md.robots, canonical: md.alternates?.canonical }).toEqual({
        slug: t.slug,
        robots: INDEXABLE,
        canonical: `${SITE}/help/${t.slug}`,
      });
      expect(jsonLdDocs(doc).map((d) => d["@type"])).toEqual(["BreadcrumbList"]);
    }
  });

  test("unknown / hostile topics -> 404 (never a throw); metadata noindex", async () => {
    const hostile: unknown[] = ["order", "nope", "ORDERING", "..", "%2e%2e", "a".repeat(10_000), "<script>", "‮shipping", "ship\u0000ping", "", ["shipping"], "__proto__", "constructor"];
    for (const raw of hostile) {
      let kind = "ok";
      try {
        await topic(raw as string);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        kind = "notFound";
      }
      // Arrays (never produced by a single [topic] segment) may resolve to their first value: 200 safe state accepted.
      const expected = Array.isArray(raw) ? kind : "notFound";
      expect({ raw: String(raw).slice(0, 30), kind }).toEqual({ raw: String(raw).slice(0, 30), kind: expected });
      if (!Array.isArray(raw)) expect((await topicMeta(raw as string)).robots).toEqual(NOINDEX_NOFOLLOW);
    }
  });

  test("?open=<slug> opens only a slug of this topic; hostile values ignored", async () => {
    const t = HELP_TOPICS[0];
    if (t === undefined) throw new Error("no topics");
    const first = t.faqSlugs[0] ?? "";
    const { doc } = await topic(t.slug, { open: first });
    expect(doc.getElementById(first)?.hasAttribute("open")).toBe(true);
    for (const open of ["<x>", "a".repeat(5000), "how-do-i-delete-my-account-zz", ["x", first]] as Array<string | string[]>) {
      const r = await topic(t.slug, { open });
      // Arrays use their first value ("x"), which is not a slug of this topic either.
      expect(r.doc.querySelectorAll("details[open]")).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// /faq
// ---------------------------------------------------------------------------

describe("/faq (T101)", () => {
  test("FAQPage JSON-LD valid, one script, and matches the visible questions one-to-one", async () => {
    const { doc, html } = await faq();
    expect(jsonLdScripts(doc)).toHaveLength(1);
    const docs = jsonLdDocs(doc);
    expect(docs.map((d) => d["@type"])).toEqual(["FAQPage", "BreadcrumbList"]);
    const page = docs[0] as { mainEntity: Array<{ "@type": string; name: string; acceptedAnswer: { "@type": string; text: string } }> };
    const visible = [...doc.querySelectorAll("details > summary")].map((s) => (s.textContent ?? "").replace(/\s+/g, " ").trim());
    expect(page.mainEntity.length).toBe(visible.length);
    page.mainEntity.forEach((q, i) => {
      expect(q["@type"]).toBe("Question");
      expect(q.acceptedAnswer["@type"]).toBe("Answer");
      expect(q.acceptedAnswer.text.length).toBeGreaterThan(0);
      expect(visible[i]).toContain(q.name);
    });
    expect(new Set(page.mainEntity.map((q) => q.name)).size).toBe(page.mainEntity.length);
    expect(markupRuleViolations(doc, html)).toEqual([]);
    const md: Metadata = faqPage.metadata;
    expect({ robots: md.robots, canonical: md.alternates?.canonical }).toEqual({ robots: INDEXABLE, canonical: `${SITE}/faq` });
  });

  test("FAQPage JSON-LD appears on /faq only", async () => {
    const pages: Array<[string, Promise<{ doc: Document }>]> = [
      ["/help", help()],
      ["/help?q=shipping", help({ q: "shipping" })],
      ["/help/shipping", topic("shipping")],
      ["/contact", contact()],
      ...POLICY_SLUGS.map((slug) => [`/${slug}`, renderTree(() => POLICY_MODULES[slug].default())] as [string, Promise<{ doc: Document }>]),
    ];
    for (const [name, p] of pages) {
      const types = jsonLdDocs((await p).doc).map((d) => d["@type"]);
      expect({ name, faq: types.includes("FAQPage") }).toEqual({ name, faq: false });
    }
  });

  test("?open= hostile values never throw and never open a non-existent entry", async () => {
    for (const open of ["<script>", "a".repeat(10_000), ["x", "y"], "\u0000"] as Array<string | string[]>) {
      const { doc } = await faq({ open });
      expect(doc.querySelectorAll("details[open]")).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// /contact
// ---------------------------------------------------------------------------

describe("/contact (T101)", () => {
  function contactForm(doc: Document): Element {
    const form = doc.querySelector('form[aria-label="Contact us"]');
    if (form === null) throw new Error("contact form missing");
    return form;
  }

  test("metadata: noindex (canonical /contact)", () => {
    const md: Metadata = contactPage.metadata;
    expect({ robots: md.robots, canonical: md.alternates?.canonical }).toEqual({ robots: NOINDEX_NOFOLLOW, canonical: `${SITE}/contact` });
  });

  test("real no-JS POST form: method POST + multipart, no javascript: action, contract fields only", async () => {
    qa.jar.clear();
    const { doc, html } = await contact();
    const form = contactForm(doc);
    expect((form.getAttribute("method") ?? "").toLowerCase()).toBe("post");
    expect(form.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form.getAttribute("action") ?? "").not.toContain("javascript:");
    const contract = new Set<string>(Object.values(CONTACT_FIELD));
    const names = [...form.querySelectorAll("input[name], select[name], textarea[name]")].map((el) => el.getAttribute("name") ?? "");
    const unexpected = names.filter((n) => !contract.has(n) && !n.startsWith("$ACTION_"));
    expect(unexpected).toEqual([]);
    for (const hidden of form.querySelectorAll('input[type="hidden"]')) {
      const name = hidden.getAttribute("name") ?? "";
      expect(name.startsWith("$ACTION_") || name === CONTACT_FIELD.productSlug).toBe(true);
    }
    expect(names.some((n) => /session|owner|user|token|auth/i.test(n))).toBe(false);
    // Honeypot present, hidden from AT, not focusable.
    const honeypot = form.querySelector(`input[name="${CONTACT_FIELD.website}"]`);
    expect(honeypot?.getAttribute("tabindex")).toBe("-1");
    expect(honeypot?.closest('[aria-hidden="true"]')).not.toBeNull();
    // Guest: no order select.
    expect(form.querySelector(`select[name="${CONTACT_FIELD.orderId}"]`)).toBeNull();
    expect(markupRuleViolations(doc, html)).toEqual([]);
    expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Contact us"]);
    expect(breadcrumbLinks(doc)).toEqual(["/"]);
  });

  test("topic=order is an alias of ordering; unknown topics dropped", async () => {
    const selected = async (sp: SP) => {
      const { doc } = await contact(sp);
      const select = contactForm(doc).querySelector(`select[name="${CONTACT_FIELD.topic}"]`);
      return select?.querySelector("option[selected]")?.getAttribute("value") ?? "";
    };
    expect(await selected({ topic: "order" })).toBe("ordering");
    expect(await selected({ topic: "ordering" })).toBe("ordering");
    expect(await selected({ topic: "shipping" })).toBe("shipping");
    for (const t of ["ORDER", "<x>", "a".repeat(500), "__proto__", "constructor", ""]) expect(await selected({ topic: t })).toBe("");
  });

  test("ref is shape-checked only (no product lookup) and honoured only with topic=product", async () => {
    const slugOf = async (sp: SP) => {
      const { doc } = await contact(sp);
      return contactForm(doc).querySelector(`input[name="${CONTACT_FIELD.productSlug}"]`)?.getAttribute("value") ?? null;
    };
    expect(await slugOf({ topic: "product", ref: "walnut-desk" })).toBe("walnut-desk");
    expect(await slugOf({ topic: "product", ref: "does-not-exist-anywhere" })).toBe("does-not-exist-anywhere");
    expect(await slugOf({ topic: "shipping", ref: "walnut-desk" })).toBeNull();
    expect(await slugOf({ ref: "walnut-desk" })).toBeNull();
    for (const ref of ["<script>", "UPPER", "a--b", "-a", "a".repeat(129), "../x", "a b", "‮a", ""]) {
      expect({ ref: ref.slice(0, 20), v: await slugOf({ topic: "product", ref }) }).toEqual({ ref: ref.slice(0, 20), v: null });
    }
  });

  test("garbage cookies and forged order ids: 200, no order select, no cookie writes", async () => {
    qa.jar.clear();
    qa.jar.set("sf_session", "garbage<script>");
    qa.jar.set("sf_auth", "x".repeat(4000));
    try {
      const { doc, html } = await contact({ topic: "order", order: "00000000-0000-4000-8000-000000000000" });
      const form = contactForm(doc);
      expect(form.querySelector(`select[name="${CONTACT_FIELD.orderId}"]`)).toBeNull();
      expect(html).not.toContain("garbage");
      expect(UUID_RE.test(html)).toBe(false);
    } finally {
      qa.jar.clear();
    }
  });
});

// ---------------------------------------------------------------------------
// Policy pages (T102)
// ---------------------------------------------------------------------------

describe("policy pages (T102)", () => {
  test("all six policy routes resolve: one h1, breadcrumb, sample notice, canonical, indexable, BreadcrumbList", async () => {
    expect([...POLICY_SLUGS].sort() as string[]).toEqual(Object.keys(POLICY_MODULES).sort());
    for (const slug of POLICY_SLUGS) {
      const page = POLICY_PAGES[slug];
      const mod = POLICY_MODULES[slug];
      const { doc, html } = await renderTree(() => mod.default());
      expect({ slug, h1: [...doc.querySelectorAll("h1")].map((h) => h.textContent) }).toEqual({ slug, h1: [page.title] });
      expect(breadcrumbLinks(doc)).toEqual(["/"]);
      expect(doc.body.textContent).toContain(SAMPLE_POLICY_NOTICE);
      expect(markupRuleViolations(doc, html)).toEqual([]);
      expect(isAllowedInternalHref(`/${slug}`)).toBe(true);
      const md: Metadata = mod.metadata;
      expect({ slug, robots: md.robots, canonical: md.alternates?.canonical, title: md.title }).toEqual({
        slug,
        robots: INDEXABLE,
        canonical: `${SITE}/${slug}`,
        title: page.title,
      });
      expect(String(md.description ?? "")).not.toBe(SAMPLE_POLICY_NOTICE);
      expect(jsonLdScripts(doc)).toHaveLength(1);
      const crumbs = jsonLdDocs(doc)[0] as { "@type": string; itemListElement: Array<{ position: number; item: string }> };
      expect(crumbs["@type"]).toBe("BreadcrumbList");
      expect(crumbs.itemListElement.map((e) => e.item)).toEqual([`${SITE}/`, `${SITE}/${slug}`]);
    }
  });

  test("privacy page states what is stored and that data is device-bound", async () => {
    const { doc } = await renderTree(() => POLICY_MODULES.privacy.default());
    const text = (doc.body.textContent ?? "").toLowerCase();
    for (const word of ["cookie", "order", "address", "list", "message"]) expect({ word, found: text.includes(word) }).toEqual({ word, found: true });
    expect(/device|browser/.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Data rules shared by all static pages
// ---------------------------------------------------------------------------

describe("static pages: no writes, no cookie writes, no list()/DB reads for content pages", () => {
  test("help, topic, faq and policy renders read no cookies and change nothing", async () => {
    const before = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
    const cookieBefore = qa.cookieCalls;
    await help({ q: "returns" });
    await topic("returns");
    await faq();
    for (const slug of POLICY_SLUGS) await renderTree(() => POLICY_MODULES[slug].default());
    expect(qa.cookieCalls).toBe(cookieBefore);
    expect(db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n).toBe(before);
  });

  test("contact render reads cookies but never writes them or the database", async () => {
    qa.jar.clear();
    const before = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
    await contact({ topic: "product", ref: "walnut-desk" });
    expect(db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n).toBe(before);
  });
});
