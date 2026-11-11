// MVP SiteFooter tests, updated for v3 (T150): light surfaces, named footer
// navs, `now` clock. Same nine behaviours as the MVP file.
import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { SITE_NAME } from "@/lib/seo/site";
import { SiteHeader } from "../SiteHeader";
import { SiteFooter } from "./SiteFooter";
import { SITE_FOOTER_COLUMNS } from "./footer-links";

const NOW = Date.UTC(2026, 6, 1);

describe("SiteFooter", () => {
  test("renders a contentinfo landmark on a light surface (no inverse band)", () => {
    render(<SiteFooter now={NOW} />);
    const footer = screen.getByRole("contentinfo");
    expect(footer.tagName).toBe("FOOTER");
    expect(footer).toHaveClass("bg-surface-page", "text-text-primary");
    expect(footer.outerHTML).not.toContain("surface-inverse");
    expect(footer.outerHTML).not.toContain("text-inverse");
  });

  test("default columns are the v3 columns, each in a labelled Footer nav", () => {
    render(<SiteFooter now={NOW} />);
    for (const column of SITE_FOOTER_COLUMNS) {
      const nav = screen.getByRole("navigation", { name: `Footer: ${column.heading}` });
      const links = within(nav).getAllByRole("link");
      expect(links.map((l) => l.getAttribute("href"))).toEqual(column.links.map((l) => l.href));
    }
  });

  test("column links use the subtle variant with the default tone and no important overrides", () => {
    render(<SiteFooter now={NOW} />);
    for (const link of within(screen.getByRole("navigation", { name: "Footer: Help" })).getAllByRole("link")) {
      expect(link).toHaveClass("min-h-touch", "text-text-secondary");
      expect(link).not.toHaveClass("text-text-inverse");
      expect(link.className.split(/\s+/).filter((c) => c.includes("!"))).toEqual([]);
    }
  });

  test("custom flat links render in a Footer: Links nav, including external ones", () => {
    render(
      <SiteFooter
        now={NOW}
        links={[
          { href: "/about", label: "About" },
          { href: "https://example.com/help", label: "Help", external: true },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Footer: Links" });
    expect(within(nav).getByRole("link", { name: "About" })).toHaveAttribute("href", "/about");
    const help = within(nav).getByRole("link", { name: "Help (opens in new tab)" });
    expect(help).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("navigation", { name: "Footer: Help" })).toBeNull();
  });

  test("empty flat links omit that nav; quick links and legal links remain", () => {
    render(<SiteFooter now={NOW} links={[]} />);
    expect(screen.queryByRole("navigation", { name: "Footer: Links" })).toBeNull();
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(names).toEqual(["Footer: Quick links", "Footer: Legal"]);
  });

  test("copyright line uses the explicit year and store name", () => {
    render(<SiteFooter year={2031} storeName="Acme Goods" />);
    const p = screen.getByText("© 2031 Acme Goods. All rights reserved.");
    expect(p.tagName).toBe("P");
    expect(p).toHaveClass("text-text-primary");
  });

  test("year defaults to the current UTC year and store name to SITE_NAME", () => {
    render(<SiteFooter />);
    const year = new Date().getUTCFullYear();
    expect(screen.getByText(`© ${year} ${SITE_NAME}. All rights reserved.`)).toBeInTheDocument();
  });

  test("footer layout wraps at 320px (responsive classes)", () => {
    render(<SiteFooter now={NOW} />);
    const quick = within(screen.getByRole("navigation", { name: "Footer: Quick links" })).getByRole("list");
    expect(quick).toHaveClass("flex", "flex-wrap", "min-w-0");
    expect(screen.getByRole("contentinfo").firstElementChild).toHaveClass("px-4", "min-w-0");
  });
});

describe("SiteHeader + SiteFooter landmarks", () => {
  test("exactly one banner, one contentinfo, and navigations with distinct names", () => {
    const { container } = render(
      <>
        <SiteHeader cartCount={3} />
        <main id="main" />
        <SiteFooter now={NOW} />
      </>,
    );
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
    const navs = screen.getAllByRole("navigation");
    const names = navs.map((n) => n.getAttribute("aria-label"));
    expect(names.every((n) => n !== null && n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(navs.length);
    expect(container.querySelector("a[href], button")).toHaveAttribute("href", "#main");
  });
});
