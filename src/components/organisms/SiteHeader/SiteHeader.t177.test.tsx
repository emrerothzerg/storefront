import { describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCOUNT_NAV, AUTH_NAV, DEPARTMENT_NAV } from "@/content/navigation";
import { HEADER_BENEFIT_COMPACT_IDS } from "@/content/header-benefits";
import { ACCOUNT_MENU_LABEL, AccountMenu } from "./AccountMenu";
import { HeaderBenefitsRow, headerBenefitRowItems } from "./HeaderBenefitsRow";
import { SiteHeader } from "./SiteHeader";
import type { HeaderBenefits, SiteHeaderProps } from "./SiteHeader";

const BENEFITS: HeaderBenefits = {
  label: "Store benefits",
  items: [
    { id: "free-shipping", label: "Free standard shipping on orders of $35 or more", icon: "truck", href: "/shipping" },
    { id: "track-order", label: "Track your order", icon: "package", href: "/orders" },
    { id: "returns", label: "Returns and refunds", icon: "refresh", href: "/returns" },
    { id: "promo-code", label: "Use code FREESHIP for free shipping on orders of $20 or more", icon: "tag" },
  ],
};

function props(overrides: Partial<SiteHeaderProps> = {}): SiteHeaderProps {
  return {
    cartCount: 1,
    storeName: "Northwind Goods",
    departments: [],
    account: { status: "guest" },
    utilityLinks: [{ label: "Lists", href: "/lists", icon: "heart" }],
    categoryNav: DEPARTMENT_NAV,
    benefits: BENEFITS,
    ...overrides,
  };
}

function classes(el: Element | null | undefined): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("T177 U02: only row 1 sticks, from lg", () => {
  test("header box is lg:contents (static below lg); row 1 is lg:sticky top-0 z-sticky with an opaque background", () => {
    render(<SiteHeader {...props()} />);
    const banner = screen.getByRole("banner");
    const header = classes(banner);
    expect(header).toContain("lg:contents");
    expect(header.filter((c) => /(^|:)(sticky|fixed)$/.test(c))).toEqual([]);
    const row = classes(banner.firstElementChild);
    expect(row).toEqual(expect.arrayContaining(["lg:sticky", "lg:top-0", "lg:z-sticky", "bg-surface-page", "lg:border-b"]));
    expect(row).not.toContain("sticky");
    // Nothing below row 1 sticks.
    for (const el of [...banner.children].slice(1)) {
      expect(classes(el).filter((c) => /sticky|fixed/.test(c))).toEqual([]);
    }
  });

  test("lg borders: first lower row drops its top border, last lower row draws the bottom border", () => {
    render(<SiteHeader {...props()} />);
    expect(screen.getByTestId("header-category-row")).toHaveClass("border-t", "lg:border-t-0");
    expect(screen.getByTestId("header-category-row")).not.toHaveClass("lg:border-b");
    expect(screen.getByTestId("header-benefits")).toHaveClass("border-t", "lg:border-b");
    expect(screen.getByTestId("header-benefits")).not.toHaveClass("lg:border-t-0");
  });

  test("benefits as the only lower row gets both lg edge classes; no lower rows -> row 1 only", () => {
    const { unmount } = render(<SiteHeader {...props({ categoryNav: undefined })} />);
    expect(screen.getByTestId("header-benefits")).toHaveClass("lg:border-t-0", "lg:border-b");
    unmount();
    render(<SiteHeader {...props({ categoryNav: undefined, benefits: undefined })} />);
    expect(screen.getByRole("banner").children).toHaveLength(1);
  });

  test("MVP header (no extended props) keeps the whole header sticky top-0 and no lg edge classes", () => {
    render(<SiteHeader cartCount={0} />);
    const banner = screen.getByRole("banner");
    expect(banner).toHaveClass("sticky", "top-0", "z-sticky");
    expect(banner).not.toHaveClass("lg:contents");
    expect(classes(banner.firstElementChild)).not.toContain("lg:sticky");
  });

  test("account flyout is inside the sticky row (opens above content from lg)", () => {
    render(<SiteHeader {...props()} />);
    const row = screen.getByRole("banner").firstElementChild;
    expect(row?.contains(screen.getByTestId("account-menu"))).toBe(true);
  });
});

describe("T177 U08: wordmark on one line", () => {
  test("v3 wordmark: whitespace-nowrap, text-body below sm, text-h4 from sm; accessible name unchanged", () => {
    render(<SiteHeader {...props()} />);
    const mark = screen.getByTestId("header-wordmark");
    expect(mark).toHaveClass("whitespace-nowrap", "text-body", "sm:text-h4", "min-w-0");
    expect(mark).not.toHaveClass("break-words");
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Northwind Goods" })).toBe(mark);
  });

  test("MVP wordmark still wraps long names", () => {
    render(<SiteHeader cartCount={0} storeName="Supercalifragilistic Goods" />);
    expect(screen.getByTestId("header-wordmark")).toHaveClass("break-words");
    expect(screen.getByTestId("header-wordmark")).not.toHaveClass("whitespace-nowrap");
  });
});

describe("T177 U16: account chevron sits next to the label", () => {
  test("link has a small end padding; summary reverses so the chevron is at its start; names unchanged", () => {
    render(<AccountMenu account={{ status: "guest" }} accountNav={ACCOUNT_NAV} authNav={AUTH_NAV} />);
    const link = screen.getByRole("link", { name: "Hello, Sign in, Account & Lists" });
    expect(link).toHaveClass("ps-3", "pe-1");
    expect(link).not.toHaveClass("px-3");
    const summary = screen.getByTestId("account-menu").querySelector("summary");
    expect(summary).toHaveClass("flex-row-reverse", "min-w-touch");
    expect(summary).toHaveTextContent(ACCOUNT_MENU_LABEL);
  });
});

describe("T177 U20: HeaderBenefitsRow", () => {
  test("compact ids default to the content (free shipping + coupon)", () => {
    const rows = headerBenefitRowItems(BENEFITS.items);
    expect(rows.map((r) => r.compact)).toEqual([true, false, false, true]);
    expect(HEADER_BENEFIT_COMPACT_IDS).toEqual(["free-shipping", "promo-code"]);
  });

  test("below md only compact items show (others hidden md:flex); one list, all items in the DOM", () => {
    render(<HeaderBenefitsRow items={BENEFITS.items} label="Store benefits" />);
    const list = screen.getByRole("list", { name: "Store benefits" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).not.toHaveClass("hidden");
    expect(items[3]).not.toHaveClass("hidden");
    for (const li of [items[1], items[2]]) expect(li).toHaveClass("hidden", "md:flex");
    expect(list).toHaveClass("flex-wrap", "md:flex-nowrap", "md:w-max");
    // Small wrapping text below md, single-line small text from md.
    const link = within(items[0]!).getByRole("link");
    expect(link).toHaveClass("text-caption", "md:text-small", "md:whitespace-nowrap", "break-words");
    expect(link).not.toHaveClass("whitespace-nowrap");
  });

  test("no compact match -> first item is kept; blank items dropped; custom ids honoured", () => {
    const rows = headerBenefitRowItems([{ id: "a", label: "  " }, { id: "b", label: "B" }, { id: "c", label: "C" }]);
    expect(rows.map((r) => [r.label, r.compact])).toEqual([
      ["B", true],
      ["C", false],
    ]);
    expect(headerBenefitRowItems([{ id: "b", label: "B" }, { id: "c", label: "C" }], ["c"]).map((r) => r.compact)).toEqual([
      false,
      true,
    ]);
    expect(headerBenefitRowItems(null)).toEqual([]);
  });

  test("keys are unique and stable across duplicate ids", () => {
    const keys = headerBenefitRowItems([{ id: "x", label: "One" }, { id: "x", label: "Two" }]).map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });

  test("disallowed hrefs render as text (no link); no links -> focusable named region", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(
        <HeaderBenefitsRow items={[{ id: "free-shipping", label: "Ships", href: "javascript:alert(1)" }]} label="Store benefits" />,
      );
      expect(html).not.toContain("javascript:");
      const doc = new DOMParser().parseFromString(html, "text/html");
      const region = doc.querySelector('[role="region"]');
      expect(region?.getAttribute("aria-label")).toBe("Store benefits");
      expect(region?.getAttribute("tabindex")).toBe("0");
      expect(doc.querySelector("a")).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("empty input renders nothing", () => {
    expect(renderToStaticMarkup(<HeaderBenefitsRow items={[]} label="Store benefits" />)).toBe("");
  });

  test("no arbitrary values or inline styles", () => {
    const html = renderToStaticMarkup(<HeaderBenefitsRow items={BENEFITS.items} label="Store benefits" />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const all = [...doc.querySelectorAll("[class]")].flatMap((el) => classes(el));
    expect(all.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(html).not.toMatch(/\sstyle="/);
  });
});
