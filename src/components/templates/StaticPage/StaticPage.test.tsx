import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { POLICY_PAGE_LIST, SAMPLE_POLICY_NOTICE } from "@/content/policies";
import { isAllowedInternalHref } from "@/content/routes";
import {
  STATIC_PAGE_TOC_LABEL,
  STATIC_PAGE_TOC_THRESHOLD,
  StaticPage,
  buildSectionIds,
  formatLastUpdated,
  slugifyHeading,
  type StaticPageSection,
} from "./index";

const HOSTILE = `<script>alert(1)</script><img src=x onerror="alert(2)">`;

function sections(n: number): StaticPageSection[] {
  return Array.from({ length: n }, (_, i) => ({
    heading: `Section ${i + 1}`,
    paragraphs: [`Paragraph ${i + 1}a`, `Paragraph ${i + 1}b`],
  }));
}

const crumbs = [{ label: "Home", href: "/" }, { label: "Help", href: "/help" }, { label: "Shipping" }];

function markup(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[href]"));
}

describe("static-page utils", () => {
  test("slugifyHeading keeps ascii words and drops markup", () => {
    expect(slugifyHeading("Returns & refunds")).toBe("returns-refunds");
    expect(slugifyHeading("  Café déjà vu  ")).toBe("cafe-deja-vu");
    expect(slugifyHeading(HOSTILE)).toBe("script-alert-1-script-img-src-x-onerror-alert-2");
    expect(slugifyHeading("!!!")).toBe("");
    expect(slugifyHeading("a".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  test("buildSectionIds: provided id, heading slug, fallback, uniqueness and reserved ids", () => {
    expect(
      buildSectionIds(
        [
          { heading: "Intro" },
          { heading: "Intro" },
          { id: "Custom Id", heading: "Ignored" },
          { heading: "???" },
          { heading: "main" },
          { id: "intro", heading: "x" },
        ],
        ["main"],
      ),
    ).toEqual(["intro", "intro-2", "custom-id", "section-4", "main-2", "intro-3"]);
  });

  test("formatLastUpdated", () => {
    expect(formatLastUpdated("2026-11-07")).toEqual({ dateTime: "2026-11-07", label: "November 7, 2026" });
    expect(formatLastUpdated("2026-01-31T23:59:59Z")).toEqual({ dateTime: "2026-01-31", label: "January 31, 2026" });
    expect(formatLastUpdated("2026-02-30")).toBeNull();
    expect(formatLastUpdated("yesterday")).toBeNull();
    expect(formatLastUpdated("")).toBeNull();
  });
});

describe("StaticPage", () => {
  test("renderToStaticMarkup works and contains one h1", () => {
    const html = renderToStaticMarkup(
      <StaticPage title="Shipping" breadcrumb={crumbs} sections={sections(5)} lastUpdated="2026-11-07" sampleNotice />,
    );
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).toContain("Last updated");
    expect(html).toContain("November 7, 2026");
  });

  test("one h1, breadcrumb, last updated in <time>", () => {
    const { container } = render(
      <StaticPage title="Shipping policy" breadcrumb={crumbs} sections={sections(2)} lastUpdated="2026-11-07" />,
    );
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Shipping policy");
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Help" })).toHaveAttribute("href", "/help");
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-11-07");
    expect(screen.getByText(/Last updated/)).toHaveTextContent("Last updated November 7, 2026");
  });

  test("invalid lastUpdated is omitted", () => {
    render(<StaticPage title="T" breadcrumb={crumbs} sections={sections(1)} lastUpdated="nope" />);
    expect(screen.queryByText(/Last updated/)).toBeNull();
  });

  test(`no TOC with ${STATIC_PAGE_TOC_THRESHOLD} or fewer sections`, () => {
    render(<StaticPage title="T" breadcrumb={crumbs} sections={sections(STATIC_PAGE_TOC_THRESHOLD)} />);
    expect(screen.queryByRole("navigation", { name: STATIC_PAGE_TOC_LABEL })).toBeNull();
  });

  test("TOC with more than 3 sections; every link resolves to a section id with an h2", () => {
    const { container } = render(<StaticPage title="T" breadcrumb={crumbs} sections={sections(4)} />);
    const toc = screen.getByRole("navigation", { name: STATIC_PAGE_TOC_LABEL });
    const links = within(toc).getAllByRole("link");
    expect(links).toHaveLength(4);
    for (const [i, link] of links.entries()) {
      const href = link.getAttribute("href") ?? "";
      expect(href.startsWith("#")).toBe(true);
      const target = container.querySelector(`[id="${href.slice(1)}"]`);
      expect(target?.tagName).toBe("SECTION");
      expect(target?.querySelector("h2")).toHaveTextContent(`Section ${i + 1}`);
      expect(link).toHaveTextContent(`Section ${i + 1}`);
    }
    expect(container.querySelectorAll("h2")).toHaveLength(4);
  });

  test("duplicate headings still get unique ids", () => {
    const { container } = render(
      <StaticPage
        title="T"
        breadcrumb={crumbs}
        sections={[1, 2, 3, 4].map(() => ({ heading: "Same", paragraphs: ["p"] }))}
      />,
    );
    const ids = Array.from(container.querySelectorAll("section")).map((s) => s.id);
    expect(new Set(ids).size).toBe(4);
  });

  test("sections render paragraphs as <p> text; hostile strings stay text", () => {
    const { container } = render(
      <StaticPage
        title={HOSTILE}
        breadcrumb={[{ label: HOSTILE, href: "/" }, { label: HOSTILE }]}
        intro={[HOSTILE]}
        sections={[{ heading: HOSTILE, paragraphs: [HOSTILE, "Second"] }, ...sections(3)]}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(HOSTILE);
    const first = container.querySelector("section");
    expect(first?.querySelector("h2")?.textContent).toBe(HOSTILE);
    const ps = Array.from(first?.querySelectorAll("p") ?? []).map((p) => p.textContent);
    expect(ps).toEqual([HOSTILE, "Second"]);
    expect(first?.id).toMatch(/^[a-z0-9-]+$/);
  });

  test("sampleNotice shows the notice and skips the duplicate first paragraph", () => {
    const { container } = render(
      <StaticPage
        title="About"
        breadcrumb={crumbs}
        sampleNotice
        sections={[{ heading: "Who", paragraphs: [SAMPLE_POLICY_NOTICE, "Body"] }]}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveAttribute("data-tone", "info");
    expect(notice).toHaveTextContent(SAMPLE_POLICY_NOTICE);
    const section = container.querySelector("section");
    expect(Array.from(section?.querySelectorAll("p") ?? []).map((p) => p.textContent)).toEqual(["Body"]);
  });

  test("without sampleNotice the paragraph is kept and no notice renders", () => {
    const { container } = render(
      <StaticPage title="About" breadcrumb={crumbs} sections={[{ heading: "Who", paragraphs: [SAMPLE_POLICY_NOTICE] }]} />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector("section p")).toHaveTextContent(SAMPLE_POLICY_NOTICE);
  });

  test("disallowed breadcrumb hrefs render as text; every non-fragment href passes the allowlist", () => {
    const { container } = render(
      <StaticPage
        title="T"
        breadcrumb={[
          { label: "Home", href: "/" },
          { label: "Evil", href: "javascript:alert(1)" },
          { label: "Proto", href: "//evil.example" },
          { label: "Here" },
        ]}
        sections={sections(5)}
      />,
    );
    expect(screen.queryByRole("link", { name: "Evil" })).toBeNull();
    expect(screen.getByText("Evil")).toBeInTheDocument();
    for (const el of markup(container)) {
      const href = el.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        expect(container.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
      } else {
        expect(isAllowedInternalHref(href)).toBe(true);
      }
    }
  });

  test("intro, aside and children render; prose width class applied", () => {
    const { container } = render(
      <StaticPage
        title="T"
        breadcrumb={crumbs}
        intro={["Lead text"]}
        sections={sections(1)}
        aside={<p>Aside content</p>}
      >
        <p>Extra content</p>
      </StaticPage>,
    );
    expect(screen.getByText("Lead text")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveTextContent("Aside content");
    expect(screen.getByText("Extra content")).toBeInTheDocument();
    expect(container.querySelector(".max-w-prose section")).not.toBeNull();
  });

  test("every real policy page renders with one h1, notice, and a TOC iff > 3 sections", () => {
    for (const page of POLICY_PAGE_LIST) {
      const html = renderToStaticMarkup(
        <StaticPage
          title={page.title}
          breadcrumb={[{ label: "Home", href: "/" }, { label: page.title }]}
          sections={page.sections}
          lastUpdated={page.lastUpdated}
          sampleNotice={page.sampleNotice}
        />,
      );
      expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
      expect(html.split(SAMPLE_POLICY_NOTICE).length - 1).toBe(1);
      expect(html.includes(`aria-label="${STATIC_PAGE_TOC_LABEL}"`)).toBe(page.sections.length > 3);
    }
  });
});
