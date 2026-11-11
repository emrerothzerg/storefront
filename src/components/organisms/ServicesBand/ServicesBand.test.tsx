import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServiceTileItem } from "@/components/molecules/ServiceTiles";
import { PLANNED_ROUTES, isAllowedInternalHref } from "@/content/routes";
import {
  SERVICES_BAND_DEFAULT_HEADING,
  SERVICES_BAND_DEFAULT_NOTICE,
  SERVICES_BAND_DEFAULT_TILES,
  ServicesBand,
  resolveServicesBandNotice,
} from "./ServicesBand";

const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>&amp; "q" 's'`;
const APP_DIR = join(import.meta.dir, "../../../app");
const CONTRACT_HREFS = ["/orders", "/returns", "/shipping", "/help", "/faq", "/contact"];

let warn: ReturnType<typeof spyOn> | null = null;
function silence() {
  warn = spyOn(console, "warn").mockImplementation(() => {});
}
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

const tileHrefs = (root: ParentNode) => [...root.querySelectorAll("ul a")].map((a) => a.getAttribute("href"));

describe("ServicesBand: defaults (contract H-21)", () => {
  test("default tiles link exactly the contract routes, in order, each allow-listed with a page under src/app", () => {
    expect(SERVICES_BAND_DEFAULT_TILES.map((t): string => t.href)).toEqual(CONTRACT_HREFS);
    const planned: readonly string[] = PLANNED_ROUTES;
    for (const tile of SERVICES_BAND_DEFAULT_TILES) {
      expect(planned).toContain(tile.href);
      expect(isAllowedInternalHref(tile.href)).toBe(true);
      expect(existsSync(join(APP_DIR, tile.href.slice(1), "page.tsx"))).toBe(true);
      expect(tile.label.trim()).toBe(tile.label);
      expect(tile.label.length).toBeGreaterThan(0);
    }
    expect(isAllowedInternalHref(SERVICES_BAND_DEFAULT_NOTICE.href)).toBe(true);
    expect(SERVICES_BAND_DEFAULT_NOTICE.href).toBe("/returns");
  });

  test("default copy names no service that does not exist (R10)", () => {
    const copy = [
      ...SERVICES_BAND_DEFAULT_TILES.map((t) => t.label),
      SERVICES_BAND_DEFAULT_NOTICE.text,
      SERVICES_BAND_DEFAULT_NOTICE.linkLabel ?? "",
    ].join(" ");
    expect(copy).not.toMatch(/click\s*(?:&|and)\s*collect|same[- ]day|store|member|app\b|pay later|newsletter/i);
  });

  test("renders a section named by a visually hidden h2 with the six tiles and the returns notice", () => {
    render(<ServicesBand id="home-services" />);
    const region = screen.getByRole("region", { name: SERVICES_BAND_DEFAULT_HEADING });
    expect(region.id).toBe("home-services");
    expect(region.getAttribute("aria-labelledby")).toBe("home-services-heading");
    const h2 = within(region).getByRole("heading", { level: 2, name: SERVICES_BAND_DEFAULT_HEADING });
    expect(h2.id).toBe("home-services-heading");
    expect(h2.className).toContain("sr-only");
    expect(tileHrefs(region)).toEqual(CONTRACT_HREFS);
    const notice = within(region).getByRole("link", { name: SERVICES_BAND_DEFAULT_NOTICE.linkLabel });
    expect(notice.getAttribute("href")).toBe("/returns");
    expect(notice.closest("p")?.textContent).toContain(SERVICES_BAND_DEFAULT_NOTICE.text);
  });

  test("notice sits after the band by default and before it with noticePlacement='before'", () => {
    const after = render(<ServicesBand />).container;
    const sectionA = after.querySelector("section");
    expect(sectionA?.lastElementChild?.tagName).toBe("P");
    after.remove();
    const before = render(<ServicesBand noticePlacement="before" />).container;
    const kids = [...(before.querySelector("section")?.children ?? [])].map((e) => e.tagName);
    expect(kids.indexOf("P")).toBeLessThan(kids.indexOf("DIV"));
  });

  test("tiles sit on the primary-subtle band by default; tone passes through", () => {
    const { container } = render(<ServicesBand />);
    expect(container.querySelector("ul")?.parentElement?.className).toContain("bg-accent-subtle");
    const sunken = renderToStaticMarkup(<ServicesBand tone="sunken" notice={null} />);
    expect(sunken).toContain("bg-surface-sunken");
    expect(sunken).not.toContain("bg-accent-subtle text-text-primary");
  });

  test("every link is a 44px target", () => {
    const { container } = render(<ServicesBand />);
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(7);
    for (const a of links) expect(a.className).toMatch(/\bmin-h-touch\b/);
  });
});

describe("ServicesBand: heading", () => {
  test("custom heading, level 3 and visible heading", () => {
    render(<ServicesBand heading="Help & services" headingLevel={3} headingVisuallyHidden={false} />);
    const h3 = screen.getByRole("heading", { level: 3, name: "Help & services" });
    expect(h3.className).not.toContain("sr-only");
    expect(screen.getByRole("region", { name: "Help & services" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  test("visually hidden level 3 heading renders an h3", () => {
    const html = renderToStaticMarkup(<ServicesBand headingLevel={3} />);
    expect(html).toContain("<h3");
    expect(html).not.toContain("<h2");
  });

  test("blank heading falls back to the default; no id gives a generated, matching heading id", () => {
    const { container } = render(<ServicesBand heading="   " />);
    const section = container.querySelector("section");
    const labelledBy = section?.getAttribute("aria-labelledby") ?? "";
    expect(labelledBy).not.toBe("");
    expect(section?.id).toBe("");
    const target = container.querySelector(`[id="${labelledBy}"]`);
    expect(target?.textContent).toBe(SERVICES_BAND_DEFAULT_HEADING);
  });
});

describe("ServicesBand: omission and invalid input", () => {
  test("no tiles, only invalid tiles or a non-array render nothing (even with a notice)", () => {
    silence();
    const notArray = 7 as unknown as readonly ServiceTileItem[];
    for (const tiles of [
      [],
      [{ label: "Evil", href: "https://evil.example" }, { label: "  ", href: "/faq" }, { label: "Up", href: "/../etc" }],
      notArray,
    ]) {
      expect(renderToStaticMarkup(<ServicesBand tiles={tiles} id="home-services" />)).toBe("");
    }
  });

  test("invalid tiles are dropped (one warning each), valid ones kept in order", () => {
    silence();
    const { container } = render(
      <ServicesBand
        notice={null}
        tiles={[
          { label: "Orders", href: "/orders", icon: "package" },
          { label: "Evil", href: "javascript:alert(1)" },
          { label: "Proto", href: "//evil.example/x" },
          { label: "Topic", href: "/help/shipping" },
        ]}
      />,
    );
    expect(tileHrefs(container)).toEqual(["/orders", "/help/shipping"]);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const h of tileHrefs(container)) expect(isAllowedInternalHref(h ?? "")).toBe(true);
  });

  test("notice: null hides it; blank text hides it; blank label or bad href keeps text without a link", () => {
    expect(renderToStaticMarkup(<ServicesBand notice={null} />)).not.toMatch(/<p[ >]/);
    expect(renderToStaticMarkup(<ServicesBand notice={{ text: "  ", linkLabel: "x", href: "/returns" }} />)).not.toMatch(/<p[ >]/);
    silence();
    const bad = render(<ServicesBand notice={{ text: "Refund programme", linkLabel: "Learn more", href: "https://evil.example" }} />);
    const p = bad.container.querySelector("p");
    expect(p?.textContent).toBe("Refund programme");
    expect(p?.querySelector("a")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    bad.unmount();
    const noLabel = render(<ServicesBand notice={{ text: "Refund programme", linkLabel: " ", href: "/returns" }} />);
    expect(noLabel.container.querySelector("p a")).toBeNull();
  });

  test("resolveServicesBandNotice trims and validates", () => {
    expect(resolveServicesBandNotice(undefined)).toBeNull();
    expect(resolveServicesBandNotice(null)).toBeNull();
    expect(resolveServicesBandNotice({ text: " A ", linkLabel: " B ", href: "/returns" })).toEqual({
      text: "A",
      link: { label: "B", href: "/returns" },
    });
    expect(resolveServicesBandNotice({ text: "A" })).toEqual({ text: "A", link: null });
    silence();
    expect(resolveServicesBandNotice({ text: "A", linkLabel: "B", href: "/nope" })).toEqual({ text: "A", link: null });
  });
});

describe("ServicesBand: hostile text and markup", () => {
  test("hostile heading, tile labels and notice render as text", () => {
    const html = renderToStaticMarkup(
      <ServicesBand
        heading={HOSTILE}
        tiles={[{ label: HOSTILE, href: "/faq" }]}
        notice={{ text: HOSTILE, linkLabel: HOSTILE, href: "/returns" }}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    const d = new DOMParser().parseFromString(html, "text/html");
    expect(d.querySelector("h2")?.textContent).toBe(HOSTILE);
    expect(d.querySelector("p a")?.textContent).toBe(HOSTILE);
  });

  test("no script, no inline style, no use client, tokens only", () => {
    const html = renderToStaticMarkup(<ServicesBand />);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/style="/);
    const src = readFileSync(join(import.meta.dir, "ServicesBand.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
    expect(src).not.toMatch(/\bstyle=\{/);
    expect(src).not.toMatch(/-\[/);
  });

  test("ids unique and heading inside its section", () => {
    const d = new DOMParser().parseFromString(renderToStaticMarkup(<ServicesBand id="home-services" />), "text/html");
    const ids = [...d.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const section = d.querySelector("section");
    expect(section?.contains(d.getElementById(section.getAttribute("aria-labelledby") ?? ""))).toBe(true);
    expect(d.querySelectorAll("section")).toHaveLength(1);
  });
});
