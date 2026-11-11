// QA (QA-W4-organisms-C / T90): T89 StaticPage template, FaqList, ContactSection.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContactActionFn, ContactActionState } from "@/components/molecules/_contracts/contact-actions";
import {
  CONTACT_SECTION_HELP_HEADING,
  CONTACT_SECTION_INTRO,
  ContactSection,
  DEFAULT_CONTACT_HELP_LINKS,
} from "@/components/organisms/ContactSection";
import { FaqList, faqRelatedLinkLabel, safeRelatedHrefs } from "@/components/organisms/FaqList";
import {
  StaticPage,
  buildSectionIds,
  formatLastUpdated,
  slugifyHeading,
  type StaticPageProps,
  type StaticPageSection,
} from "@/components/templates/StaticPage";
import { FAQ_ENTRIES, type FaqEntry } from "@/content/faq";
import { HELP_TOPICS } from "@/content/help-topics";
import { POLICY_PAGE_LIST, SAMPLE_POLICY_NOTICE } from "@/content/policies";
import { isAllowedInternalHref } from "@/content/routes";
import { expectFocused } from "@/test/dom-assertions";

const ROOT = join(import.meta.dir, "../../../src/components");
const EVIL = `<script>alert(1)</script><img src=x onerror="alert(2)">`;

function sections(n: number, prefix = "Section"): StaticPageSection[] {
  return Array.from({ length: n }, (_, i) => ({ heading: `${prefix} ${i + 1}`, paragraphs: [`Body ${i + 1}`] }));
}

function page(over: Partial<StaticPageProps> = {}) {
  return (
    <StaticPage
      title="Shipping policy"
      breadcrumb={[{ label: "Home", href: "/" }, { label: "Help", href: "/help" }, { label: "Shipping" }]}
      sections={sections(5)}
      {...over}
    />
  );
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

function faq(slug: string, over: Partial<FaqEntry> = {}): FaqEntry {
  return { slug, question: `Question ${slug}?`, answer: [`Answer ${slug}.`], topic: "ordering", ...over };
}

function fixed(result: ContactActionState): ContactActionFn {
  return async () => result;
}
const noop = fixed(null);

function allIds(root: ParentNode): string[] {
  return [...root.querySelectorAll("[id]")].map((n) => n.id);
}

/* ------------------------------------------------------------------ */
describe("StaticPage (T89.1/T89.3)", () => {
  test("exactly one <h1 id=static-page-title>; article labelled by it", () => {
    const doc = parse(renderToStaticMarkup(page()));
    const h1s = doc.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.id).toBe("static-page-title");
    expect(doc.querySelector("article")?.getAttribute("aria-labelledby")).toBe("static-page-title");
    expect(doc.querySelectorAll("h2").length).toBe(5);
  });

  test("breadcrumb: invalid hrefs render as text; valid kept; last item current", () => {
    const doc = parse(
      renderToStaticMarkup(
        page({
          breadcrumb: [
            { label: "Home", href: "/" },
            { label: "Evil", href: "javascript:alert(1)" },
            { label: "Ext", href: "https://evil.example/" },
            { label: "Proto", href: "//evil.example" },
            { label: "Unplanned", href: "/not-a-route" },
            { label: "Help", href: "/help" },
            { label: "Here" },
          ],
        }),
      ),
    );
    const nav = doc.querySelector('nav[aria-label="Breadcrumb"]') as HTMLElement;
    expect(nav).not.toBeNull();
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/help"]);
    for (const label of ["Evil", "Ext", "Proto", "Unplanned"]) expect(nav.textContent).toContain(label);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Here");
  });

  test("TOC only when sections > 3", () => {
    for (const n of [0, 1, 3]) {
      expect(renderToStaticMarkup(page({ sections: sections(n) }))).not.toContain('aria-label="On this page"');
    }
    for (const n of [4, 9]) {
      const doc = parse(renderToStaticMarkup(page({ sections: sections(n) })));
      const toc = doc.querySelector('nav[aria-label="On this page"]');
      expect(toc).not.toBeNull();
      expect(toc?.querySelectorAll("a")).toHaveLength(n);
    }
  });

  test("every # link targets an element id on the page; every non-# href passes isAllowedInternalHref", () => {
    const hostile: StaticPageSection[] = [
      { heading: "Returns", paragraphs: ["a"] },
      { heading: "Returns", paragraphs: ["b"] },
      { heading: "Returns", paragraphs: ["c"] },
      { heading: "main", paragraphs: ["d"] },
      { heading: "Static page title", paragraphs: ["e"] },
      { heading: "日本語", paragraphs: ["f"] },
      { heading: EVIL, paragraphs: ["g"] },
      { id: "Custom ID!!", heading: "With id", paragraphs: ["h"] },
      { id: "section-1", heading: "Collides with fallback", paragraphs: ["i"] },
    ];
    const doc = parse(renderToStaticMarkup(page({ sections: hostile })));
    const links = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    const frag = links.filter((h) => h.startsWith("#"));
    expect(frag).toHaveLength(hostile.length);
    for (const href of frag) {
      const target = doc.getElementById(href.slice(1));
      expect(target).not.toBeNull();
      expect(target?.tagName).toBe("SECTION");
      expect(target?.querySelector("h2")).not.toBeNull();
    }
    for (const href of links.filter((h) => !h.startsWith("#"))) expect(isAllowedInternalHref(href)).toBe(true);
    const ids = allIds(doc);
    expect(new Set(ids).size).toBe(ids.length);
    const sectionIds = [...doc.querySelectorAll("section[id]")].map((s) => s.id);
    expect(sectionIds).toEqual([
      "returns",
      "returns-2",
      "returns-3",
      "main-2",
      "static-page-title-2",
      "section-6",
      "script-alert-1-script-img-src-x-onerror-alert-2",
      "custom-id",
      "section-1",
    ]);
    for (const id of sectionIds) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(sectionIds).not.toContain("main");
    expect(sectionIds).not.toContain("static-page-title");
  });

  test("slugify: ASCII only, length capped, diacritics folded", () => {
    expect(slugifyHeading("Café & Crème — Résumé")).toBe("cafe-creme-resume");
    expect(slugifyHeading("  --Hello   World--  ")).toBe("hello-world");
    expect(slugifyHeading("🙂")).toBe("");
    expect(slugifyHeading("a".repeat(200)).length).toBeLessThanOrEqual(64);
    expect(buildSectionIds([{ heading: "A" }, { heading: "a" }, { heading: "A!" }])).toEqual(["a", "a-2", "a-3"]);
  });

  test("Last updated: <time dateTime> for valid dates; invalid omitted", () => {
    const doc = parse(renderToStaticMarkup(page({ lastUpdated: "2026-11-07" })));
    const time = doc.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-11-07");
    expect(time?.textContent).toBe("November 7, 2026");
    expect(time?.parentElement?.textContent).toBe("Last updated November 7, 2026");
    for (const bad of ["", "garbage", "2026-02-30", "2026-13-01", "11/07/2026", "2026-11-7", EVIL]) {
      expect(formatLastUpdated(bad)).toBeNull();
      expect(renderToStaticMarkup(page({ lastUpdated: bad }))).not.toContain("Last updated");
    }
    expect(formatLastUpdated("2026-11-07T10:00:00Z")).toEqual({ dateTime: "2026-11-07", label: "November 7, 2026" });
  });

  test("sample notice once; duplicate first paragraph skipped; kept when sampleNotice is false", () => {
    const secs: StaticPageSection[] = [{ heading: "Intro", paragraphs: [SAMPLE_POLICY_NOTICE, "Real text"] }];
    const withNotice = renderToStaticMarkup(page({ sections: secs, sampleNotice: true }));
    expect(withNotice.split(SAMPLE_POLICY_NOTICE).length - 1).toBe(1);
    expect(withNotice).toContain("Real text");
    const without = renderToStaticMarkup(page({ sections: secs, sampleNotice: false }));
    expect(without.split(SAMPLE_POLICY_NOTICE).length - 1).toBe(1);
    expect(parse(without).querySelector('[role="status"]')).toBeNull();
  });

  test("paragraphs/title/intro are text children; hostile text inert; max-w-prose", () => {
    const { container } = render(
      page({ title: EVIL, intro: [EVIL], sections: [{ heading: EVIL, paragraphs: [EVIL, "<b>x</b>"] }] }),
    );
    expect(container.querySelector("script, img, b")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(EVIL);
    const ps = [...container.querySelectorAll("section p")].map((p) => p.textContent);
    expect(ps).toEqual([EVIL, "<b>x</b>"]);
    expect(container.querySelector(".max-w-prose")).not.toBeNull();
    expect(container.querySelector("section")?.closest(".max-w-prose")).not.toBeNull();
  });

  test("every real policy page: one h1, unique ids, TOC links resolve", () => {
    for (const p of POLICY_PAGE_LIST) {
      const doc = parse(
        renderToStaticMarkup(
          <StaticPage
            title={p.title}
            breadcrumb={[{ label: "Home", href: "/" }, { label: p.title }]}
            sections={p.sections}
            lastUpdated={p.lastUpdated}
            sampleNotice={p.sampleNotice}
          />,
        ),
      );
      expect(doc.querySelectorAll("h1")).toHaveLength(1);
      const ids = allIds(doc);
      expect(new Set(ids).size).toBe(ids.length);
      for (const a of doc.querySelectorAll('a[href^="#"]')) {
        expect(doc.getElementById((a.getAttribute("href") ?? "").slice(1))).not.toBeNull();
      }
    }
  });
});

/* ------------------------------------------------------------------ */
describe("FaqList (T89.1/T89.2)", () => {
  test("<ul> of <details id=slug>; summary text is the question; no hidden attribute anywhere", () => {
    const html = renderToStaticMarkup(<FaqList entries={[faq("a"), faq("b")]} />);
    const doc = parse(html);
    const ul = doc.querySelector("ul") as HTMLElement;
    expect(ul).not.toBeNull();
    const details = [...ul.querySelectorAll(":scope > li > details")];
    expect(details.map((d) => d.id)).toEqual(["a", "b"]);
    expect(details[0]?.querySelector("summary")?.textContent).toBe("Question a?");
    expect(doc.querySelector("[hidden]")).toBeNull();
    expect(html).not.toMatch(/\shidden(=|\s|>)/);
    expect(html).not.toContain("aria-hidden=\"true\">Answer");
  });

  test("openSlug opens only the matching entry; unknown slug opens none", () => {
    const doc = parse(renderToStaticMarkup(<FaqList entries={[faq("a"), faq("b"), faq("c")]} openSlug="b" />));
    expect([...doc.querySelectorAll("details")].map((d) => d.hasAttribute("open"))).toEqual([false, true, false]);
    const none = parse(renderToStaticMarkup(<FaqList entries={[faq("a")]} openSlug="zzz" />));
    expect(none.querySelector("details[open]")).toBeNull();
  });

  test("duplicate slugs keep the first", () => {
    const doc = parse(
      renderToStaticMarkup(<FaqList entries={[faq("dup", { question: "First?" }), faq("dup", { question: "Second?" }), faq("x")]} />),
    );
    const details = doc.querySelectorAll("details");
    expect(details).toHaveLength(2);
    expect(details[0]?.querySelector("summary")?.textContent).toBe("First?");
    expect(doc.body.textContent).not.toContain("Second?");
  });

  test("related links: allowlisted + deduped; labels from navigation or humanised path", () => {
    const entry = faq("r", {
      relatedHrefs: ["/cart", "/cart", "javascript:alert(1)", "https://evil.example", "//evil", "/nope", "/orders", "/help/shipping", "/signup"],
    });
    expect(safeRelatedHrefs(entry.relatedHrefs)).toEqual(["/cart", "/orders", "/help/shipping", "/signup"]);
    const { container } = render(<FaqList entries={[entry]} openSlug="r" />);
    const links = [...container.querySelectorAll("details a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/cart", "/orders", "/help/shipping", "/signup"]);
    for (const a of links) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    expect(faqRelatedLinkLabel("/help/shipping")).toBe("Shipping");
    expect(faqRelatedLinkLabel("/best-sellers")).not.toBe("");
    expect(faqRelatedLinkLabel("/account/settings?x=1#y")).toBe(faqRelatedLinkLabel("/account/settings"));
  });

  test("keyboard: every summary is a native <summary> (focusable, Enter/Space toggle) with no tabindex override", () => {
    const { container } = render(<FaqList entries={[faq("a"), faq("b")]} />);
    const summaries = [...container.querySelectorAll("summary")];
    expect(summaries).toHaveLength(2);
    for (const s of summaries) {
      expect(s.getAttribute("tabindex")).toBeNull();
      expect(s.parentElement?.tagName).toBe("DETAILS");
      expect(s.querySelector("a, button, input")).toBeNull();
    }
    const first = summaries[0] as HTMLElement;
    first.focus();
    expectFocused(first);
    fireEvent.click(first);
    expect((first.parentElement as HTMLDetailsElement).open).toBe(true);
  });

  test("hostile question / answer render as text", () => {
    const { container } = render(<FaqList entries={[faq("e", { question: EVIL, answer: [EVIL, "<b>b</b>"] })]} openSlug="e" />);
    expect(container.querySelector("script, img, b")).toBeNull();
    expect(container.querySelector("summary")?.textContent).toBe(EVIL);
  });

  test("real FAQ_ENTRIES: all render, ids == slugs, unique, URL-safe, all hrefs allowlisted", () => {
    const doc = parse(renderToStaticMarkup(<FaqList entries={FAQ_ENTRIES} />));
    const ids = [...doc.querySelectorAll("details")].map((d) => d.id);
    expect(ids).toEqual(FAQ_ENTRIES.map((e) => e.slug));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(["main", "static-page-title", "contact-heading"]).not.toContain(id);
    }
    for (const a of doc.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    expect(doc.querySelector("[hidden]")).toBeNull();
  });

  test("help topic pages: StaticPage + FaqList(topic entries) have unique ids", () => {
    for (const topic of HELP_TOPICS) {
      const entries = FAQ_ENTRIES.filter((e) => topic.faqSlugs.includes(e.slug));
      const doc = parse(
        renderToStaticMarkup(
          <StaticPage title={topic.title} breadcrumb={[{ label: "Help", href: "/help" }, { label: topic.title }]} sections={[]} intro={[topic.summary]}>
            <FaqList entries={entries} title="Questions" />
          </StaticPage>,
        ),
      );
      const ids = allIds(doc);
      expect(new Set(ids).size).toBe(ids.length);
      expect(doc.querySelectorAll("h1")).toHaveLength(1);
    }
  });
});

/* ------------------------------------------------------------------ */
describe("ContactSection (T89.4)", () => {
  test("<section aria-labelledby=contact-heading>; intro copy word-for-word per README", () => {
    const readme = readFileSync(join(ROOT, "organisms/README.md"), "utf8");
    const quoted = /the honest intro \("([^"]+)"\)/.exec(readme)?.[1];
    expect(quoted).toBe(CONTACT_SECTION_INTRO);
    render(<ContactSection action={noop} />);
    const section = screen.getByRole("region", { name: "Contact us" });
    expect(section.tagName).toBe("SECTION");
    expect(section).toHaveAttribute("aria-labelledby", "contact-heading");
    expect(within(section).getByText(CONTACT_SECTION_INTRO)).toBeInTheDocument();
    expect(CONTACT_SECTION_INTRO).toBe("We reply within two business days. This demo store stores your message but does not send email.");
  });

  test("ContactForm passthrough: productSlug hidden input, initialTopic, orders select", () => {
    const { container } = render(
      <ContactSection
        action={noop}
        productSlug="desk-lamp"
        initialTopic="returns"
        orders={[{ id: "0f8fad5b-d9cb-469f-a165-70867728950e", label: "Order placed Nov 7" }]}
        initialOrderId="0f8fad5b-d9cb-469f-a165-70867728950e"
      />,
    );
    expect(container.querySelector('input[type="hidden"][name="productSlug"]')).toHaveValue("desk-lamp");
    expect(screen.getByLabelText(/^Topic/)).toHaveValue("returns");
    expect(screen.getByLabelText("Which order?")).toHaveValue("0f8fad5b-d9cb-469f-a165-70867728950e");
  });

  test("no-JS shape: one form with the action, named fields", () => {
    const doc = parse(renderToStaticMarkup(<ContactSection action={noop} />));
    expect(doc.querySelectorAll("form")).toHaveLength(1);
    const names = [...doc.querySelectorAll("form [name]")].map((n) => n.getAttribute("name"));
    for (const n of ["name", "email", "topic", "message", "website"]) expect(names).toContain(n);
  });

  test("success: <code>C-XXXXXXXX</code> inside the polite status region", async () => {
    render(<ContactSection action={fixed({ ok: true, reference: "C-QA7Z9K2M", message: "Message sent" })} />);
    fireEvent.submit(screen.getByRole("form", { name: "Contact us" }));
    const code = await screen.findByText("C-QA7Z9K2M");
    expect(code.tagName).toBe("CODE");
    expect(code.textContent).toMatch(/^C-[A-Z0-9]{8}$/);
    const live = code.closest('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(code.closest('[role="status"]')).not.toBeNull();
    expect(screen.getByRole("region", { name: "Contact us" }).contains(code)).toBe(true);
  });

  test("hostile reference renders as text", async () => {
    const { container } = render(<ContactSection action={fixed({ ok: true, reference: EVIL, message: "x" })} />);
    fireEvent.submit(screen.getByRole("form", { name: "Contact us" }));
    await screen.findByText(EVIL);
    expect(container.querySelector("script, img")).toBeNull();
  });

  test("aside 'Looking for something else?' with default 5 links, all allowlisted", () => {
    render(<ContactSection action={noop} />);
    const aside = screen.getByRole("complementary", { name: CONTACT_SECTION_HELP_HEADING });
    const links = within(aside).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(DEFAULT_CONTACT_HELP_LINKS.map((l) => l.href));
    expect(links).toHaveLength(5);
    for (const a of links) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("invalid links dropped; aside dropped when none remain", () => {
    render(
      <ContactSection
        action={noop}
        helpLinks={[
          { label: "Bad", href: "javascript:alert(1)" },
          { label: "Ext", href: "https://evil.example" },
          { label: EVIL, href: "/faq" },
        ]}
      />,
    );
    const aside = screen.getByRole("complementary", { name: CONTACT_SECTION_HELP_HEADING });
    expect(within(aside).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/faq"]);
    expect(aside.querySelector("script, img")).toBeNull();
    const html = renderToStaticMarkup(<ContactSection action={noop} helpLinks={[{ label: "Bad", href: "//evil" }]} />);
    expect(html).not.toContain("<aside");
    expect(html).not.toContain(CONTACT_SECTION_HELP_HEADING);
    expect(renderToStaticMarkup(<ContactSection action={noop} helpLinks={[]} />)).not.toContain("<aside");
  });

  test("heading levels: 1 -> aside h2; 2 (default) -> aside h3", () => {
    render(<ContactSection action={noop} headingLevel={1} />);
    expect(screen.getByRole("heading", { level: 1, name: "Contact us" })).toHaveAttribute("id", "contact-heading");
    expect(screen.getByRole("heading", { level: 2, name: CONTACT_SECTION_HELP_HEADING })).toBeInTheDocument();
    const html = renderToStaticMarkup(<ContactSection action={noop} />);
    const doc = parse(html);
    expect(doc.querySelector("h2#contact-heading")).not.toBeNull();
    expect(doc.querySelector("h3")?.textContent).toBe(CONTACT_SECTION_HELP_HEADING);
    expect(doc.querySelector("h1")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
describe("Cross-cutting (T89 composed page)", () => {
  function composed() {
    return (
      <main id="main">
        <StaticPage
          title="Help: shipping"
          breadcrumb={[{ label: "Home", href: "/" }, { label: "Help", href: "/help" }, { label: "Shipping" }]}
          sections={sections(4, "Topic")}
          lastUpdated="2026-11-07"
          aside={<p>Related</p>}
        >
          <FaqList entries={FAQ_ENTRIES.slice(0, 6)} title="Questions" />
          <ContactSection action={noop} />
        </StaticPage>
      </main>
    );
  }

  test("one h1, unique ids, every # link resolves, every other href allowlisted", () => {
    const doc = parse(renderToStaticMarkup(composed()));
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    const ids = allIds(doc);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) expect(doc.getElementById(href.slice(1))).not.toBeNull();
      else expect(isAllowedInternalHref(href)).toBe(true);
    }
  });

  test("landmarks: navs/complementary/regions have distinct accessible names", () => {
    render(composed());
    const navNames = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(navNames.sort()).toEqual(["Breadcrumb", "On this page"]);
    expect(new Set(navNames).size).toBe(navNames.length);
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"));
    expect(new Set(regions).size).toBe(regions.length);
    const named = screen
      .queryAllByRole("complementary")
      .map((c) => c.getAttribute("aria-label") ?? c.getAttribute("aria-labelledby"))
      .filter((n): n is string => n !== null);
    expect(new Set(named).size).toBe(named.length);
  });

  test("source hygiene: no style=, dangerouslySetInnerHTML, any, ts-ignore, runtime server imports", () => {
    const files = [
      "templates/StaticPage/StaticPage.tsx",
      "templates/StaticPage/static-page-utils.ts",
      "templates/StaticPage/index.ts",
      "organisms/FaqList/FaqList.tsx",
      "organisms/FaqList/faq-links.ts",
      "organisms/FaqList/index.ts",
      "organisms/ContactSection/ContactSection.tsx",
      "organisms/ContactSection/index.ts",
    ];
    for (const file of files) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/style=\{/);
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|eslint-disable/);
      expect(src).not.toMatch(/^import (?!type )[^;]*["']@\/server/m);
    }
  });
});
