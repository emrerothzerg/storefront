/**
 * QA-W1-T43: adversarial checks for the static content modules (T43 + T126).
 * Owned by QA; does not modify implementer files.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ICON_NAMES } from "@/components/atoms/Icon/Icon";
import { faqPageJsonLd } from "@/lib/seo/json-ld";
import { SEED_SHIPPING_METHODS } from "@/server/db/seed";
import { MOCK_CARDS } from "@/server/payments/mock-payment-provider";
import * as faqModule from "@/content/faq";
import * as helpTopicsModule from "@/content/help-topics";
import * as navigationModule from "@/content/navigation";
import * as policiesModule from "@/content/policies";
import * as routesModule from "@/content/routes";
import * as searchHelpModule from "@/content/search-help";
import { FAQ_ENTRIES, getFaqEntry, toFaqJsonLdInput } from "@/content/faq";
import { HELP_TOPICS } from "@/content/help-topics";
import { ACCOUNT_NAV, AUTH_NAV, FOOTER_COLUMNS, PRIMARY_NAV } from "@/content/navigation";
import { POLICY_PAGES, POLICY_SLUGS, SAMPLE_POLICY_NOTICE } from "@/content/policies";
import { isAllowedInternalHref, PLANNED_ROUTES } from "@/content/routes";
import { normalizeHelpQuery, searchHelp } from "@/content/search-help";

const CONTENT_DIR = join(import.meta.dir, "../../src/content");
const MODULE_FILES = ["routes.ts", "faq.ts", "help-topics.ts", "policies.ts", "navigation.ts", "search-help.ts"];

function collectStrings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value) {
      collectStrings(k, out, seen);
      collectStrings(v, out, seen);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, seen);
  } else {
    for (const item of Object.values(value)) collectStrings(item, out, seen);
  }
  return out;
}

const ALL_EXPORTS = {
  faqModule,
  helpTopicsModule,
  navigationModule,
  policiesModule,
  routesModule,
  searchHelpModule,
};
const ALL_STRINGS = collectStrings(ALL_EXPORTS);
/** Copy only (route patterns contain `[` `]` but never `<`). */
const COPY_STRINGS = collectStrings({ FAQ_ENTRIES, HELP_TOPICS, POLICY_PAGES, PRIMARY_NAV, ACCOUNT_NAV, AUTH_NAV, FOOTER_COLUMNS });
const COPY = COPY_STRINGS.join("\n");
const sentences = (text: string): string[] => text.split(/(?<=[.!?:;])\s+|\n/).filter((s) => s.length > 0);

const faqText = (slug: string): string => {
  const entry = getFaqEntry(slug);
  if (!entry) throw new Error(`missing FAQ ${slug}`);
  return `${entry.question} ${entry.answer.join(" ")}`;
};
const policyText = (slug: (typeof POLICY_SLUGS)[number]): string => collectStrings(POLICY_PAGES[slug]).join(" ");

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Criterion 1: slugs, answers, link allowlist
// ---------------------------------------------------------------------------
describe("C1 FAQ integrity and internal link allowlist", () => {
  test("FAQ slugs unique, no empty or whitespace-only paragraphs", () => {
    const slugs = FAQ_ENTRIES.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const e of FAQ_ENTRIES) {
      expect(e.answer.length, e.slug).toBeGreaterThan(0);
      for (const p of e.answer) expect(p.trim().length, e.slug).toBeGreaterThan(0);
    }
  });

  test("PLANNED_ROUTES is exactly the 39 planned patterns", () => {
    // 39 since CONS-B1 added /top-rated.
    expect(PLANNED_ROUTES.length).toBe(39);
    expect(new Set(PLANNED_ROUTES).size).toBe(39);
    for (const r of ["/signin", "/signup", "/account/settings"]) expect(PLANNED_ROUTES).toContain(r as never);
  });

  test("accepts one instantiation of every planned pattern, with and without query/hash", () => {
    for (const pattern of PLANNED_ROUTES) {
      const href = pattern.replace(/\[[^\]]+\]/g, "abc-123");
      expect(isAllowedInternalHref(href), href).toBe(true);
      expect(isAllowedInternalHref(`${href}?x=1&y=2`), href).toBe(true);
      expect(isAllowedInternalHref(`${href}#frag`), href).toBe(true);
      expect(isAllowedInternalHref(`${href}?q=a/../b#x/y`), href).toBe(true);
    }
  });

  test("rejects hrefs that do not match a planned pattern", () => {
    const bad = [
      "",
      "cart",
      "./cart",
      "../cart",
      "/cart/",
      "/help/shipping/",
      "/products/",
      "//evil.com",
      "//evil.com/cart",
      "///evil.com",
      "https://evil.com/cart",
      "http://localhost/cart",
      "javascript:alert(1)",
      "mailto:a@b.c",
      "/\\evil.com",
      "\\\\evil.com",
      "/cart\\..\\admin",
      "/products/..",
      "/products/.",
      "/orders/../invoice",
      "/lists/shared/..",
      "/orders/x/../invoice",
      "/products/a b",
      "/products/a/b",
      "/nope",
      "/admin",
      "/account/secret",
      "/orders//invoice",
      "?x=1",
      "#top",
      " /cart",
      "/cart ",
      "/\t/evil.com",
      "/products/<script>",
    ];
    for (const href of bad) expect(isAllowedInternalHref(href), JSON.stringify(href)).toBe(false);
    expect(isAllowedInternalHref("/".repeat(1) + "a".repeat(5000))).toBe(false);
  });

  test("rejects percent-encoded dot segments (URL parsers treat %2e%2e as ..)", () => {
    for (const href of ["/products/%2e%2e", "/products/%2E%2E", "/orders/%2e%2e/invoice", "/products/%2e", "/lists/.%2e"]) {
      expect(isAllowedInternalHref(href), href).toBe(false);
    }
  });

  test("root is allowed, with query and hash", () => {
    for (const href of ["/", "/?q=1", "/#main"]) expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("non-string input never throws and is rejected", () => {
    for (const v of [null, undefined, 42, {}, []]) {
      expect(isAllowedInternalHref(v as unknown as string)).toBe(false);
    }
  });

  test("every internal href in content passes the allowlist", () => {
    const hrefs: string[] = [];
    for (const e of FAQ_ENTRIES) hrefs.push(...(e.relatedHrefs ?? []));
    for (const l of [...PRIMARY_NAV, ...ACCOUNT_NAV, ...AUTH_NAV]) hrefs.push(l.href);
    for (const c of FOOTER_COLUMNS) for (const l of c.links) hrefs.push(l.href);
    for (const t of HELP_TOPICS) hrefs.push(helpTopicsModule.helpTopicHref(t.slug));
    for (const s of POLICY_SLUGS) hrefs.push(policiesModule.policyHref(s));
    for (const r of searchHelp("")) hrefs.push(r.href);
    expect(hrefs.length).toBeGreaterThan(80);
    expect(hrefs.filter((h) => !isAllowedInternalHref(h))).toEqual([]);
  });

  test("help search hash anchors point at an FAQ slug listed by that topic", () => {
    for (const r of searchHelp("")) {
      if (r.kind !== "faq") continue;
      const [path, hash] = r.href.split("#");
      expect(hash).toBe(r.entry.slug);
      const topic = HELP_TOPICS.find((t) => path === `/help/${t.slug}`);
      expect(topic?.faqSlugs).toContain(r.entry.slug);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: searchHelp
// ---------------------------------------------------------------------------
describe("C2 searchHelp", () => {
  const total = HELP_TOPICS.length + FAQ_ENTRIES.length;

  test('"shipping" returns shipping entries, title hits before body-only hits', () => {
    const results = searchHelp("shipping");
    expect(results.length).toBeGreaterThan(0);
    const titleHit = (r: (typeof results)[number]) => r.title.toLowerCase().includes("shipping");
    const firstBody = results.findIndex((r) => !titleHit(r));
    const lastTitle = results.map(titleHit).lastIndexOf(true);
    expect(firstBody === -1 || lastTitle < firstBody).toBe(true);
    for (let i = 1; i < results.length; i++) expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    const slugs = results.flatMap((r) => (r.kind === "faq" ? [r.entry.slug] : []));
    for (const s of ["what-shipping-options-are-there", "how-does-free-shipping-work"]) expect(slugs).toContain(s);
    expect(results.some((r) => r.kind === "topic" && r.topic.slug === "shipping")).toBe(true);
    // Every returned item really mentions shipping.
    for (const r of results) {
      const text = r.kind === "faq" ? faqText(r.entry.slug) : `${r.topic.title} ${r.topic.summary}`;
      expect(text.toLowerCase()).toContain("shipping");
    }
  });

  test("case-insensitive and whitespace-collapsing", () => {
    expect(searchHelp("  SHIPPING\t").map((r) => r.href)).toEqual(searchHelp("shipping").map((r) => r.href));
  });

  test("empty, whitespace-only and non-string queries return everything", () => {
    for (const q of ["", " ", "\t\n  \r", "  "]) expect(searchHelp(q).length, JSON.stringify(q)).toBe(total);
    for (const q of [null, undefined, 5]) expect(searchHelp(q as unknown as string).length).toBe(total);
  });

  test("query is capped at 100 characters", () => {
    expect(normalizeHelpQuery("x".repeat(500)).length).toBe(100);
    // A term starting beyond character 100 is ignored.
    expect(searchHelp(`${"q".repeat(100)} shipping`)).toEqual([]);
    expect(searchHelp(`shipping${" ".repeat(200)}zzzzqqqq`).length).toBeGreaterThan(0);
  });

  test("only the first 8 terms are required to match", () => {
    const eight = "standard shipping is free when your order subtotal";
    const withNinth = searchHelp(`${eight} zzzzqqqq`);
    expect(withNinth.some((r) => r.kind === "faq" && r.entry.slug === "how-does-free-shipping-work")).toBe(true);
    expect(searchHelp(`zzzzqqqq ${eight}`)).toEqual([]);
  });

  test("hostile queries never throw", () => {
    const hostile = [
      "(", ")", "[", "]", "*", "\\", "+?", "^$", "{2,}", "(?<x>", "[a-", "\\u{", ".*", "|",
      "x".repeat(10_000), "( ".repeat(5000), "\\".repeat(10_000),
      "\u{1F600}".repeat(60), "\uD800", "\uDFFF abc", "İstanbul ǅ ß", "مرحبا שלום", "\u0000\u0007",
      "<script>alert(1)</script>", "' OR 1=1 --", "%00", "__proto__", "constructor",
    ];
    for (const q of hostile) {
      expect(() => searchHelp(q), JSON.stringify(q.slice(0, 20))).not.toThrow();
      expect(Array.isArray(searchHelp(q))).toBe(true);
    }
  });

  test("10k-char query completes quickly", () => {
    const start = performance.now();
    for (let i = 0; i < 50; i++) searchHelp("shipping returns ".repeat(600));
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("results are fresh objects; mutating them does not corrupt later searches", () => {
    const a = searchHelp("shipping");
    (a[0] as { score: number }).score = -99;
    a.length = 0;
    expect(searchHelp("shipping")[0]!.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: no HTML anywhere in exports
// ---------------------------------------------------------------------------
describe("C3 plain text", () => {
  test("walks every export of every module", () => {
    expect(ALL_STRINGS.length).toBeGreaterThan(300);
    expect(ALL_STRINGS.filter((s) => s.includes("<") || s.includes(">"))).toEqual([]);
  });

  test("no HTML entities, markdown emphasis or links", () => {
    expect(COPY_STRINGS.filter((s) => /&[a-z#0-9]+;|\]\(|\*\*|__|`/i.test(s))).toEqual([]);
  });

  test("paragraphs are plain strings", () => {
    for (const e of FAQ_ENTRIES) for (const p of e.answer) expect(typeof p).toBe("string");
    for (const page of Object.values(POLICY_PAGES))
      for (const s of page.sections) {
        expect(typeof s.heading).toBe("string");
        for (const p of s.paragraphs) expect(typeof p).toBe("string");
      }
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: copy matches behaviour constants
// ---------------------------------------------------------------------------
describe("C4 copy matches behaviour", () => {
  test("shipping prices, thresholds and days equal the seeded methods (FAQ and policy)", () => {
    const faq = faqText("what-shipping-options-are-there");
    const policy = policyText("shipping");
    for (const m of SEED_SHIPPING_METHODS) {
      for (const text of [faq, policy]) {
        expect(text, m.id).toContain(`${m.name}`);
        expect(text, m.id).toContain(dollars(m.priceCents));
        if (m.minDays === 1 && m.maxDays === 1) expect(text).toContain("next business day");
        else expect(text, m.id).toContain(`${m.minDays} to ${m.maxDays} business days`);
        if (m.freeOverCents !== null) expect(text).toContain(`free on orders of ${dollars(m.freeOverCents)} or more`);
      }
    }
    expect(SEED_SHIPPING_METHODS.filter((m) => m.freeOverCents !== null).length).toBe(1);
  });

  test("free shipping rule is >= (no 'over $35' / 'more than $35' wording)", () => {
    const threshold = dollars(SEED_SHIPPING_METHODS.find((m) => m.freeOverCents !== null)!.freeOverCents!);
    expect(faqText("how-does-free-shipping-work")).toContain(`${threshold} or more`);
    expect(COPY).not.toMatch(new RegExp(`(over|above|more than|exceeding) \\${threshold}\\b`, "i"));
    const mentions = sentences(COPY).filter((s) => s.includes(threshold));
    for (const s of mentions) expect(s, s).toContain(`${threshold} or more`);
  });

  test("the four mock test cards equal MOCK_CARDS, and no other 16-digit number appears", () => {
    const text = faqText("which-test-card-numbers-can-i-use");
    const found = [...COPY.matchAll(/\b\d{4} \d{4} \d{4} \d{4}\b/g)].map((m) => m[0].replace(/ /g, ""));
    const expected = Object.values(MOCK_CARDS);
    expect(expected.length).toBe(4);
    for (const n of expected) expect(text.replace(/ /g, "")).toContain(n);
    for (const n of found) expect(expected).toContain(n as never);
  });

  test("30-minute cancel window everywhere cancellation is mentioned", () => {
    for (const t of [faqText("how-do-i-cancel-an-order"), faqText("why-can-i-no-longer-cancel"), policyText("shipping"), policyText("returns"), policyText("terms"), policyText("about")]) {
      expect(t).toContain("30 minutes");
    }
    expect(COPY).not.toMatch(/\b(15|60|10|20|45) minutes? (of placing|after the order)/i);
  });

  test("tracking is described as simulated", () => {
    for (const t of [faqText("how-do-i-track-my-order"), policyText("shipping"), policyText("terms"), policyText("about")]) {
      expect(t.toLowerCase()).toMatch(/simulated/);
    }
  });

  test("promo codes: once per device as a guest or once per account", () => {
    const t = faqText("how-do-promo-codes-work");
    expect(t).toContain("once per device as a guest");
    expect(t).toContain("once per account");
  });

  test("limits: lists 20 x 200, 50 views, 20 stock alerts, compare 4, note 200, Q&A 300/1000, password 8..128", () => {
    expect(faqText("how-do-wish-lists-work")).toMatch(/up to 20 lists with up to 200 items/);
    expect(policyText("privacy")).toContain("most recent 50 products");
    expect(faqText("how-do-back-in-stock-alerts-work")).toContain("up to 20 alerts");
    expect(faqText("how-do-i-compare-products")).toContain("up to 4 products");
    expect(faqText("can-i-add-delivery-instructions")).toContain("200 characters");
    expect(faqText("how-do-product-questions-work")).toMatch(/300 characters and answers up to 1000/);
    expect(faqText("how-do-i-create-an-account")).toContain("8 to 128 characters");
    expect(faqText("how-do-i-sign-in")).toMatch(/30 days/);
    expect(faqText("how-do-i-sign-in")).toMatch(/10 incorrect attempts[^.]*15 minutes/);
  });

  test("T126 wording present; no leftover guest-only account claims", () => {
    const lower = COPY.toLowerCase();
    expect(lower).toContain("guest data is device-bound until you sign in");
    for (const slug of ["privacy", "terms", "about"] as const) {
      expect(policyText(slug).toLowerCase(), slug).toContain("device-bound until you sign in");
    }
    for (const stale of [
      "no user accounts",
      "your account is device-bound",
      "device-bound account",
      "there are no accounts",
      "no accounts",
      "without an account, everything",
      "no sign-in",
      "no login",
    ]) {
      expect(lower.includes(stale), stale).toBe(false);
    }
  });

  test("no copy says checkout is guest-only now that accounts exist", () => {
    const offenders = sentences(COPY).filter((s) => /checkout is guest checkout|guest checkout only|only (as a )?guest/i.test(s));
    expect(offenders).toEqual([]);
  });

  test("every policy page carries the sample-policy notice first", () => {
    expect(POLICY_SLUGS.length).toBe(6);
    for (const slug of POLICY_SLUGS) {
      const page = POLICY_PAGES[slug];
      expect(page.sampleNotice).toBe(true);
      expect(page.sections[0]!.paragraphs[0]).toBe(SAMPLE_POLICY_NOTICE);
      expect(page.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(SAMPLE_POLICY_NOTICE.toLowerCase()).toContain("not legal advice");
  });

  test("mock payments stated in policies", () => {
    for (const slug of ["terms", "about", "returns"] as const) expect(policyText(slug).toLowerCase()).toContain("mock payment");
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: accounts copy
// ---------------------------------------------------------------------------
describe("C5 accounts copy", () => {
  test("required account FAQ entries exist under the account topic", () => {
    for (const slug of [
      "how-do-i-create-an-account",
      "how-do-i-sign-in",
      "what-happens-to-my-guest-data-when-i-sign-in",
      "how-do-i-sign-out-everywhere",
      "how-do-i-delete-my-account",
      "i-cannot-reset-my-password",
    ]) {
      expect(getFaqEntry(slug)?.topic, slug).toBe("account");
    }
  });

  test("delete account: orders anonymised, amounts kept, reviews removed", () => {
    const t = faqText("how-do-i-delete-my-account").toLowerCase();
    expect(t).toContain("anonymised");
    expect(t).toMatch(/amounts[^.]*(stay|kept)/);
    expect(t).toMatch(/removes[^.]*reviews/);
    // CONS-B1 (aj), ruling R-7: questions/answers are anonymised as "[deleted]", not removed.
    expect(t).toContain("[deleted]");
    expect(t).not.toMatch(/removes[^.]*questions and answers/);
    const p = policyText("privacy").toLowerCase();
    expect(p).toContain("anonymised");
    expect(p).toMatch(/amounts[^.]*kept/);
  });

  test("password reset: 'not available' wording and a /contact link", () => {
    const entry = getFaqEntry("i-cannot-reset-my-password")!;
    expect(entry.answer.join(" ")).toContain("not available");
    expect(entry.relatedHrefs).toContain("/contact");
    expect(policyText("privacy")).toContain("not available");
  });

  test("privacy lists email, display name, password hash (never the password), session records, sf_auth", () => {
    const p = policyText("privacy");
    for (const s of ["email address", "display name", "password hash", "never the password", "sign-in session", "sf_auth", "sf_session"]) {
      expect(p, s).toContain(s);
    }
  });

  test("every sentence mentioning reset, verification, 2FA, codes or social login is a negation", () => {
    const risky = /\breset\b|verif(y|ication)|confirm(ation)? (your )?email|two-factor|\b2fa\b|two-step|authenticator|one-time|\botp\b|sign-in code|login code|magic link|social|google|facebook|apple|github|recovery (email|code)/i;
    const negated = /\bnot\b|\bno\b|never|cannot|n't/i;
    const offenders = sentences(COPY).filter((s) => risky.test(s) && !/verified purchase/i.test(s) && !negated.test(s));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: FAQPage JSON-LD
// ---------------------------------------------------------------------------
describe("C6 FAQPage JSON-LD", () => {
  test("one Question per FAQ with non-empty, HTML-free acceptedAnswer", () => {
    const ld = faqPageJsonLd(toFaqJsonLdInput(FAQ_ENTRIES));
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity.length).toBe(FAQ_ENTRIES.length);
    ld.mainEntity.forEach((q, i) => {
      expect(q["@type"]).toBe("Question");
      expect(q.name).toBe(FAQ_ENTRIES[i]!.question);
      expect(q.acceptedAnswer["@type"]).toBe("Answer");
      expect(q.acceptedAnswer.text.length).toBeGreaterThan(0);
      expect(q.acceptedAnswer.text).not.toMatch(/[<>]/);
      for (const p of FAQ_ENTRIES[i]!.answer) expect(q.acceptedAnswer.text).toContain(p);
    });
    expect(JSON.stringify(ld)).not.toMatch(/[<>]/);
  });

  test("toFaqJsonLdInput on an empty list yields empty mainEntity", () => {
    expect(faqPageJsonLd(toFaqJsonLdInput([])).mainEntity).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7: topics and navigation
// ---------------------------------------------------------------------------
describe("C7 help topics and navigation", () => {
  test("8 topics, each with >= 2 resolvable FAQs and a valid icon; every FAQ in exactly one topic", () => {
    expect(HELP_TOPICS.length).toBe(8);
    expect(new Set(HELP_TOPICS.map((t) => t.slug)).size).toBe(8);
    const placed = new Map<string, number>();
    for (const t of HELP_TOPICS) {
      expect(t.faqSlugs.length, t.slug).toBeGreaterThanOrEqual(2);
      expect(new Set(t.faqSlugs).size, t.slug).toBe(t.faqSlugs.length);
      for (const s of t.faqSlugs) {
        expect(getFaqEntry(s), `${t.slug}:${s}`).toBeDefined();
        placed.set(s, (placed.get(s) ?? 0) + 1);
      }
      expect(ICON_NAMES).toContain(t.icon);
    }
    for (const icon of helpTopicsModule.HELP_TOPIC_ICONS) expect(ICON_NAMES).toContain(icon);
    for (const e of FAQ_ENTRIES) expect(placed.get(e.slug), e.slug).toBe(1);
  });

  test("ACCOUNT_NAV ends with Settings; AUTH_NAV has Sign in and Create account", () => {
    expect(ACCOUNT_NAV.at(-1)).toEqual({ label: "Settings", href: "/account/settings" });
    expect(AUTH_NAV).toContainEqual({ label: "Sign in", href: "/signin" });
    expect(AUTH_NAV).toContainEqual({ label: "Create account", href: "/signup" });
  });

  // T172 pin move (T150 v3 columns): the account links moved from the Phase 2 "Your account" column
  // into the "Help" column; the intent (the footer offers Sign in and Settings) is unchanged.
  test('footer "Help" column includes Sign in and Settings', () => {
    const col = FOOTER_COLUMNS.find((c) => c.heading === "Help");
    expect(col).toBeDefined();
    expect(col!.links).toContainEqual({ label: "Sign in", href: "/signin" });
    expect(col!.links).toContainEqual({ label: "Settings", href: "/account/settings" });
  });

  test("no duplicate labels or hrefs within a nav group", () => {
    const groups = [PRIMARY_NAV, ACCOUNT_NAV, AUTH_NAV, ...FOOTER_COLUMNS.map((c) => c.links)];
    for (const g of groups) {
      expect(new Set(g.map((l) => l.label)).size).toBe(g.length);
      expect(new Set(g.map((l) => l.href)).size).toBe(g.length);
      for (const l of g) expect(l.label.trim().length).toBeGreaterThan(0);
    }
  });

  test("lookup helpers reject unknown and prototype keys", () => {
    for (const k of ["__proto__", "constructor", "toString", "", "SHIPPING"]) {
      expect(helpTopicsModule.getHelpTopic(k)).toBeUndefined();
      expect(policiesModule.getPolicyPage(k)).toBeUndefined();
      expect(getFaqEntry(k)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 8: standards
// ---------------------------------------------------------------------------
describe("C8 standards", () => {
  const sources = MODULE_FILES.map((f) => [f, readFileSync(join(CONTENT_DIR, f), "utf8")] as const);

  test("modules import only SITE_NAME and sibling content modules", () => {
    for (const [file, src] of sources) {
      const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["'];?$/gm)];
      for (const m of imports) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        expect(spec, file).toBe("@/lib/seo/site");
        expect(m[0], file).toMatch(/\{\s*SITE_NAME\s*\}/);
      }
      expect(src, file).not.toMatch(/require\(|import\(/);
    }
  });

  test("no React, any, ts-ignore, eslint-disable", () => {
    for (const [file, src] of sources) {
      expect(src, file).not.toMatch(/from\s+["']react|jsx|tsx/);
      expect(src, file).not.toMatch(/:\s*any\b|\bas any\b|<any>/);
      expect(src, file).not.toMatch(/@ts-(ignore|expect-error|nocheck)|eslint-disable/);
    }
  });

  test("no new runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["next", "react", "react-dom"]);
  });
});
