// QA (T70 / QA-W3-molecules-B): T68 OrderTimeline + OrderCard, T69 HeroBanner + CategoryTile,
// plus cross-cutting audits (320px classes, style=, server imports, any/ts-ignore) for the batch.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, within } from "@testing-library/react";
import { OrderTimeline, toStepItems } from "@/components/molecules/OrderTimeline";
import { OrderCard, type OrderCardData, type OrderCardItem } from "@/components/molecules/OrderCard";
import { HeroBanner, type HeroSlide } from "@/components/molecules/HeroBanner";
import { CategoryTile, categoryTileLabel } from "@/components/molecules/CategoryTile";
import { ImageGallery } from "@/components/molecules/ImageGallery";
import { ShareLink } from "@/components/molecules/ShareLink";
import { CompareToggle } from "@/components/molecules/CompareToggle";
import { QuestionCard } from "@/components/molecules/QuestionCard";
import { QuestionForm } from "@/components/molecules/QuestionForm";
import { isAllowedInternalHref } from "@/content/routes";
import type { TimelineStep } from "@/server/fulfillment/timeline";
import { SIMULATED_TRACKING_NOTICE as SERVER_NOTICE } from "@/server/fulfillment/fulfillment";

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;

// ===========================================================================
// T68 OrderTimeline
// ===========================================================================
const step = (status: TimelineStep["status"], state: TimelineStep["state"], at: string | null, label?: string): TimelineStep => ({
  status,
  state,
  at,
  label: label ?? status,
});

describe("T68 OrderTimeline criterion 1: cancelled", () => {
  test("cancelled step shown in text; nothing after it rendered (even if the data claims complete)", () => {
    const steps = [
      step("processing", "complete", "2026-11-03T10:42:00.000Z", "Order placed"),
      step("cancelled", "cancelled", "2026-11-03T12:00:00.000Z", "Cancelled"),
      step("shipped", "complete", "2026-11-04T10:00:00.000Z", "Shipped"),
      step("delivered", "complete", "2026-11-05T10:00:00.000Z", "Delivered"),
    ];
    const { container } = render(<OrderTimeline steps={steps} estimatedDelivery={{ start: "2026-11-10T00:00:00Z", end: "2026-11-12T00:00:00Z" }} />);
    const items = [...container.querySelectorAll("li")];
    expect(items).toHaveLength(2);
    expect(items[1]?.textContent).toContain("Cancelled");
    expect(items[1]?.getAttribute("data-status")).toBe("cancelled");
    expect(container.textContent).not.toContain("Shipped");
    expect(container.textContent).not.toContain("Expected");
    const statuses = items.map((li) => li.getAttribute("data-status"));
    expect(statuses.indexOf("complete")).toBeLessThan(statuses.indexOf("cancelled"));
  });

  test("upcoming steps of an active order are never marked complete", () => {
    const items = toStepItems([
      step("processing", "complete", "2026-11-03T10:42:00.000Z"),
      step("shipped", "current", "2026-11-04T10:00:00.000Z"),
      step("delivered", "upcoming", null),
    ]);
    expect(items.map((i) => i.status)).toEqual(["complete", "current", "upcoming"]);
  });

  test("unknown state value is downgraded to upcoming (never complete)", () => {
    const bogus = { status: "shipped", state: "done", at: null, label: "Shipped" } as unknown as TimelineStep;
    expect(toStepItems([bogus])[0]?.status).toBe("upcoming");
  });
});

describe("T68 OrderTimeline criterion 2: dates", () => {
  test("en-US dates; invalid dates omitted; delivered with at:null shows 'Expected <range>'", () => {
    const steps = [
      step("processing", "complete", "2026-11-03T10:42:00.000Z", "Order placed"),
      step("packed", "complete", "not-a-date", "Packed"),
      step("shipped", "current", "", "Shipped"),
      step("delivered", "upcoming", null, "Delivered"),
    ];
    const { container } = render(
      <OrderTimeline steps={steps} estimatedDelivery={{ start: "2026-11-10T12:00:00.000Z", end: "2026-11-12T12:00:00.000Z" }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Nov 3, 2026");
    expect(text).toMatch(/10:42\sAM UTC/);
    expect(text).not.toContain("Invalid Date");
    expect(text).not.toContain("NaN");
    const items = [...container.querySelectorAll("li")];
    expect(items[3]?.textContent).toMatch(/Expected .*Nov 10.*Nov 12/);
    expect(items[1]?.textContent).not.toMatch(/\d{4}/);
  });

  test("no estimate or invalid estimate -> no 'Expected'; delivered with a timestamp shows the date", () => {
    const delivered = [step("delivered", "upcoming", null, "Delivered")];
    expect(render(<OrderTimeline steps={delivered} />).container.textContent).not.toContain("Expected");
    expect(
      render(<OrderTimeline steps={delivered} estimatedDelivery={{ start: "nope", end: "nope" }} />).container.textContent,
    ).not.toContain("Expected");
    const done = toStepItems([step("delivered", "complete", "2026-11-05T14:00:00.000Z")], {
      start: "2026-11-10T00:00:00Z",
      end: "2026-11-12T00:00:00Z",
    });
    expect(done[0]?.timestamp).toContain("Nov 5, 2026");
  });

  test("simulated tracking line visible (not sr-only) and equal to the server constant; empty steps OK", () => {
    const { container } = render(<OrderTimeline steps={[]} />);
    const notice = screen.getByText(SERVER_NOTICE);
    expect(notice.closest(".sr-only")).toBeNull();
    expect(container.querySelector("section")).toHaveAccessibleName("Order progress");
  });

  test("server-safe static markup; heading level 3", () => {
    const html = renderToStaticMarkup(
      <OrderTimeline steps={[step("processing", "current", "2026-11-03T10:42:00.000Z", "Order placed")]} headingLevel={3} />,
    );
    expect(html).toContain("<h3");
    expect(html).toContain(SERVER_NOTICE);
  });
});

// ===========================================================================
// T68 OrderCard
// ===========================================================================
const ORDER_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
function item(i: number, over: Partial<OrderCardItem> = {}): OrderCardItem {
  return { productId: `p-${i}`, productSlug: `product-${i}`, name: `Product ${i}`, imageUrl: `/images/p-${i}.svg`, quantity: 1, ...over };
}
function order(over: Partial<OrderCardData> = {}): OrderCardData {
  return {
    id: ORDER_ID,
    createdAt: "2026-11-03T10:42:00.000Z",
    totalCents: 12_345,
    currency: "USD",
    shipToName: "Ada Lovelace",
    fulfillmentStatus: "shipped",
    items: [item(1)],
    ...over,
  };
}

describe("T68 OrderCard", () => {
  test("criterion 3: <= 4 thumbnails with alt, then '+N more'", () => {
    const { container, unmount } = render(<OrderCard order={order({ items: [1, 2, 3, 4, 5, 6].map((i) => item(i)) })} />);
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs).toHaveLength(4);
    expect(imgs.map((i) => i.getAttribute("alt"))).toEqual(["Product 1", "Product 2", "Product 3", "Product 4"]);
    expect(container.textContent).toContain("+2 more");
    unmount();
    const r = render(<OrderCard order={order({ items: [1, 2, 3, 4].map((i) => item(i)) })} />);
    expect(r.container.textContent).not.toContain("more");
    r.unmount();
    // missing image -> placeholder still named by the item
    const r2 = render(<OrderCard order={order({ items: [item(1, { imageUrl: null })] })} />);
    expect(r2.container.querySelector("[data-placeholder]")).toHaveAccessibleName("Product 1");
  });

  test("criterion 4: every status has text + an icon; unknown status reads Processing", () => {
    const expected: Record<OrderCardData["fulfillmentStatus"], string> = {
      processing: "Processing",
      packed: "Packed",
      shipped: "Shipped",
      out_for_delivery: "Out for delivery",
      delivered: "Delivered",
      cancelled: "Cancelled",
    };
    for (const [status, label] of Object.entries(expected)) {
      const { container, unmount } = render(<OrderCard order={order({ fulfillmentStatus: status as OrderCardData["fulfillmentStatus"] })} />);
      const badge = screen.getByText(label);
      const host = badge.closest("span, p") as HTMLElement;
      expect(host.textContent).toContain(label);
      expect(host.querySelector("svg") ?? host.parentElement?.querySelector("svg")).not.toBeNull();
      expect(container.querySelector("article")).not.toBeNull();
      unmount();
    }
    render(<OrderCard order={order({ fulfillmentStatus: "teleported" as unknown as OrderCardData["fulfillmentStatus"] })} />);
    expect(screen.getByText("Processing")).toBeInTheDocument();
  });

  test("criterion 5: all hrefs pass isAllowedInternalHref; help link /contact?topic=ordering&order=<id>", () => {
    const { container } = render(<OrderCard order={order({ items: [item(1), item(2)] })} />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
    for (const h of hrefs) expect(isAllowedInternalHref(h)).toBe(true);
    expect(hrefs).toContain(`/orders/${ORDER_ID}`);
    expect(hrefs).toContain(`/contact?topic=ordering&order=${ORDER_ID}`);
    expect(hrefs).toContain("/products/product-1#write-review");
    expect(screen.getByRole("link", { name: /^Get help/ })).toHaveAttribute("href", `/contact?topic=ordering&order=${ORDER_ID}`);
  });

  test("unsafe/blank slugs never produce product links (falls back to next usable slug)", () => {
    const { container } = render(
      <OrderCard
        order={order({ items: [item(1, { productSlug: ".." }), item(2, { productSlug: null }), item(3, { productSlug: "a/b" }), item(4, { productSlug: "good-one" })] })}
      />,
    );
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    for (const h of hrefs) expect(isAllowedInternalHref(h)).toBe(true);
    expect(hrefs).toContain("/products/good-one#write-review");
    const r = render(<OrderCard order={order({ id: "x", items: [item(1, { productSlug: ".." })] })} />);
    expect(within(r.container).queryByRole("link", { name: /^Write a review/ })).toBeNull();
  });

  test("buy-again form posts orderId (POST in static markup with a server reference)", () => {
    const calls: string[] = [];
    const action = async (fd: FormData) => {
      calls.push(String(fd.get("orderId")));
    };
    const { container } = render(<OrderCard order={order()} buyAgainAction={action} />);
    const form = screen.getByRole("button", { name: /^Buy it again/ }).closest("form") as HTMLFormElement;
    expect(new FormData(form).get("orderId")).toBe(ORDER_ID);
    expect([...new FormData(form).keys()].filter((k) => !k.startsWith("$"))).toEqual(["orderId"]);
    expect(container.querySelectorAll("form")).toHaveLength(1);

    const meta = () => ({ name: "$ACTION_ID_qa", action: "", encType: "multipart/form-data", method: "POST", data: null });
    const ref = Object.assign(async (fd: FormData) => void fd, { $$FORM_ACTION: meta });
    const html = renderToStaticMarkup(<OrderCard order={order()} buyAgainAction={ref} />);
    expect(html).toMatch(/<form[^>]*method="POST"/i);
    expect(html).toContain(`name="orderId" value="${ORDER_ID}"`);
  });

  test("no buyAgainAction: 'Buy it again' links to the product; 0 items: no buy-again / review", () => {
    render(<OrderCard order={order()} />);
    expect(screen.getByRole("link", { name: /^Buy it again/ })).toHaveAttribute("href", "/products/product-1");
    const r = render(<OrderCard order={order({ items: [] })} buyAgainAction={async () => {}} />);
    expect(within(r.container).queryByText("Buy it again")).toBeNull();
    expect(within(r.container).queryByText("Write a review")).toBeNull();
  });

  test("hostile ship-to/item names render as text; invalid placed date omitted; en-US placed date", () => {
    const { container, unmount } = render(
      <OrderCard order={order({ shipToName: HOSTILE, items: [item(1, { name: HOSTILE, imageUrl: null })] })} />,
    );
    expect(container.querySelectorAll("script, img[src='x'], [onerror]").length).toBe(0);
    expect(container.textContent).toContain(HOSTILE);
    expect(container.textContent).toContain("November 3, 2026");
    unmount();
    const r = render(<OrderCard order={order({ createdAt: "garbage" })} />);
    expect(r.container.textContent).not.toContain("Order placed");
    expect(r.container.textContent).not.toContain("Invalid");
  });

  test("article named by 'Order # <id>' heading at the requested level", () => {
    render(<OrderCard order={order()} headingLevel={3} />);
    const h = screen.getByRole("heading", { level: 3 });
    expect(h).toHaveTextContent(`Order # ${ORDER_ID}`);
    expect(screen.getByRole("article")).toHaveAccessibleName(`Order # ${ORDER_ID}`);
  });
});

// ===========================================================================
// T69 HeroBanner
// ===========================================================================
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

// T151 removed the Phase 2 single `heading` band; these pins now drive the v3 `slides` API (T139)
// and keep each original intent (links not buttons, heading level, no timers/live regions, token
// pairs per tone, decorative/priority images, unsafe CTA handling, hostile text).
const ART = { path: "/images/hero.svg", alt: "", width: 1200, height: 800 };
const heroSlide = (over: Partial<HeroSlide> = {}): HeroSlide => ({ id: "s", headline: "H", image: ART, ...over });

describe("T69 HeroBanner (v3 slides after T151)", () => {
  test("CTA is a link (not a button); one heading per slide at the requested level (h1 only on slide 1)", () => {
    const { container } = render(
      <HeroBanner
        headingLevel={1}
        slides={[
          heroSlide({ id: "a", headline: "Gifts", subline: "Free shipping.", cta: { label: "Shop deals", href: "/deals" } }),
          heroSlide({ id: "b", headline: "Best", cta: { label: "Best sellers", href: "/best-sellers" } }),
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Shop deals" })).toHaveAttribute("href", "/deals");
    expect(screen.getByRole("link", { name: "Best sellers" })).toHaveAttribute("href", "/best-sellers");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(2);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Gifts"]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Best"]);
    expect(render(<HeroBanner slides={[heroSlide({ headline: "Default" })]} />).container.querySelector("h2")).not.toBeNull();
  });

  test("D13: no timers, no aria-live, no animation classes; carousel semantics only as T139 specifies", () => {
    const st = spyOn(globalThis, "setTimeout");
    const si = spyOn(globalThis, "setInterval");
    const raf = typeof globalThis.requestAnimationFrame === "function" ? spyOn(globalThis, "requestAnimationFrame") : null;
    try {
      const before = { st: st.mock.calls.length, si: si.mock.calls.length };
      const html = renderToStaticMarkup(
        <HeroBanner slides={[heroSlide({ id: "a", tone: "inverse", cta: { label: "Go", href: "/deals" } }), heroSlide({ id: "b" })]} />,
      );
      expect(st.mock.calls.length).toBe(before.st);
      expect(si.mock.calls.length).toBe(before.si);
      if (raf) expect(raf).not.toHaveBeenCalled();
      expect(html).not.toMatch(/aria-live|role="(tablist|tab|status|alert|timer|marquee)"|animate-|autoplay/i);
      // T139 AC2: the only roles/roledescriptions are the carousel region and its slide groups.
      const doc = parse(html);
      expect([...doc.querySelectorAll("[aria-roledescription]")].map((el) => el.getAttribute("aria-roledescription"))).toEqual([
        "carousel",
        "slide",
        "slide",
      ]);
    } finally {
      st.mockRestore();
      si.mockRestore();
      raf?.mockRestore();
    }
  });

  test("documented token pairs per tone (no text-secondary on coloured slides; inverse text only on dark fills)", () => {
    const tones = {
      inverse: { surface: ["bg-surface-inverse", "text-text-inverse"], forbidden: /text-text-(primary|secondary)\b/ },
      accent: { surface: ["bg-accent", "text-text-inverse"], forbidden: /text-text-(primary|secondary)\b/ },
      "accent-subtle": { surface: ["bg-accent-subtle", "text-text-primary"], forbidden: /text-text-(secondary|inverse)\b/ },
      promo: { surface: ["bg-promo", "text-text-primary"], forbidden: /text-text-(secondary|inverse)\b/ },
      "promo-subtle": { surface: ["bg-promo-subtle", "text-text-primary"], forbidden: /text-text-(secondary|inverse)\b/ },
      neutral: { surface: ["bg-surface-sunken", "text-text-primary"], forbidden: /text-text-(secondary|inverse)\b/ },
    } as const;
    for (const [tone, rule] of Object.entries(tones)) {
      const doc = parse(renderToStaticMarkup(<HeroBanner slides={[heroSlide({ tone: tone as HeroSlide["tone"], subline: "C" })]} />));
      const slide = doc.querySelector("[data-hero-slide]") as HTMLElement;
      for (const cls of rule.surface) expect({ tone, has: slide.className.includes(cls) }).toEqual({ tone, has: true });
      // text inside the slide, excluding the CTA link (it carries its own button pair) and the white image frame
      const classes = [...slide.querySelectorAll("h1, h2, h3, p")].map((el) => el.getAttribute("class") ?? "").join(" ");
      expect({ tone, hit: rule.forbidden.exec(classes)?.[0] ?? null }).toEqual({ tone, hit: null });
    }
  });

  test("image: alt '' is decorative (hidden), non-empty alt names it; first slide priority by default, others lazy, priority={false} lazy", () => {
    const { container, unmount } = render(<HeroBanner slides={[heroSlide({ id: "a" }), heroSlide({ id: "b" })]} />);
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("alt"))).toEqual(["", ""]);
    expect(imgs.map((i) => i.getAttribute("loading"))).toEqual(["eager", "lazy"]);
    expect(imgs[0]?.getAttribute("fetchpriority")).toBe("high");
    expect(screen.queryByRole("img")).toBeNull();
    unmount();
    const r = render(<HeroBanner priority={false} slides={[heroSlide({ image: { ...ART, alt: "Wrapped gifts" } })]} />);
    expect(within(r.container).getByRole("img", { name: "Wrapped gifts" })).toHaveAttribute("loading", "lazy");
  });

  test("unsafe CTA hrefs drop the CTA (no '#' link), keep the slide, and warn in dev", () => {
    for (const bad of ["javascript:alert(1)", "//evil.example", "https://evil.example/deals", "/not-a-route", "deals"]) {
      warn.mockClear();
      const r = render(<HeroBanner slides={[heroSlide({ headline: "Kept", cta: { label: "Go", href: bad } })]} />);
      expect(within(r.container).queryByRole("link")).toBeNull();
      expect(within(r.container).getByRole("heading", { name: "Kept" })).toBeInTheDocument();
      expect(warn).toHaveBeenCalled();
      r.unmount();
    }
  });

  test("hostile headline/subline/CTA label render as text only", () => {
    const { container } = render(
      <HeroBanner label={HOSTILE} slides={[heroSlide({ headline: HOSTILE, subline: HOSTILE, cta: { label: HOSTILE, href: "/deals" } })]} />,
    );
    expect(container.querySelectorAll("script, [onerror]").length).toBe(0);
    // Only the slide's own art image (decorative, alt "") is an <img>.
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("alt"))).toEqual([""]);
    expect(container.querySelector("h2")?.textContent).toBe(HOSTILE);
  });
});

// ===========================================================================
// T69 CategoryTile
// ===========================================================================
describe("T69 CategoryTile", () => {
  test("ONE link named 'Name, N products' wrapping the tile; count text visible", () => {
    const { container } = render(<CategoryTile category={{ slug: "desks", name: "Desks", productCount: 12 }} />);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Desks, 12 products" })).toHaveAttribute("href", "/category/desks");
    expect(container.textContent).toContain("12 products");
    expect(container.querySelectorAll("button, input").length).toBe(0);
  });

  test("singular / zero / invalid / large counts", () => {
    expect(categoryTileLabel("Lamps", 1)).toBe("Lamps, 1 product");
    expect(categoryTileLabel("Lamps", 0)).toBe("Lamps");
    expect(categoryTileLabel("Lamps", undefined)).toBe("Lamps");
    expect(categoryTileLabel("Lamps", -3)).toBe("Lamps");
    expect(categoryTileLabel("Lamps", Number.NaN)).toBe("Lamps");
    expect(categoryTileLabel("Lamps", 1234)).toBe("Lamps, 1,234 products");
    const { container } = render(<CategoryTile category={{ slug: "lamps", name: "Lamps", productCount: 0 }} />);
    expect(screen.getByRole("link", { name: "Lamps" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d/);
  });

  test("icon fallback when imageUrl missing/blank; image decorative when present", () => {
    for (const imageUrl of [undefined, null, "", "   "]) {
      const r = render(<CategoryTile category={{ slug: "toys", name: "Toys", imageUrl }} icon="gift" />);
      const fallback = r.container.querySelector("[data-icon-fallback]");
      expect(fallback).not.toBeNull();
      expect(fallback?.querySelector("svg")).not.toBeNull();
      expect(r.container.querySelector("img")).toBeNull();
      r.unmount();
    }
    const r = render(<CategoryTile category={{ slug: "toys", name: "Toys", imageUrl: "/images/toys.svg" }} />);
    expect(r.container.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(r.container.querySelector("[data-icon-fallback]")).toBeNull();
  });

  test("unsafe hrefs and unsafe slugs -> '#' with a dev warning; slug is encoded", () => {
    for (const href of ["javascript:alert(1)", "//evil.example", "https://evil.example", "/unknown/route", "category/x"]) {
      warn.mockClear();
      const r = render(<CategoryTile category={{ slug: "x", name: "X" }} href={href} />);
      expect(within(r.container).getByRole("link")).toHaveAttribute("href", "#");
      expect(warn).toHaveBeenCalled();
      r.unmount();
    }
    warn.mockClear();
    const dots = render(<CategoryTile category={{ slug: "..", name: "Dots" }} />);
    expect(within(dots.container).getByRole("link")).toHaveAttribute("href", "#");
    dots.unmount();
    const enc = render(<CategoryTile category={{ slug: "home & garden", name: "H" }} />);
    expect(within(enc.container).getByRole("link")).toHaveAttribute("href", "/category/home%20%26%20garden");
  });

  test("hostile name stays text (in aria-label and visible text)", () => {
    const { container } = render(<CategoryTile category={{ slug: "x", name: HOSTILE, productCount: 2 }} />);
    expect(container.querySelectorAll("script, img, [onerror]").length).toBe(0);
    expect(screen.getByRole("link")).toHaveAttribute("aria-label", `${HOSTILE}, 2 products`);
  });
});

// ===========================================================================
// Cross-cutting audits for the batch
// ===========================================================================
const ROOT = join(import.meta.dir, "../../../src/components/molecules");
const FOLDERS = ["QuestionCard", "QuestionForm", "AnswerForm", "ImageGallery", "ShareLink", "CompareToggle", "OrderTimeline", "OrderCard", "HeroBanner", "CategoryTile"];
const SOURCES = FOLDERS.flatMap((f) =>
  readdirSync(join(ROOT, f))
    .filter((n) => /\.tsx?$/.test(n) && !n.includes(".test.") && !n.includes("test-helpers"))
    .map((n) => ({ file: `${f}/${n}`, text: readFileSync(join(ROOT, f, n), "utf8") })),
);

describe("cross-cutting audits", () => {
  test("sources found", () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(15);
  });

  test("no `any`, @ts-ignore, @ts-expect-error, dangerouslySetInnerHTML, eval or <script> in implementation files", () => {
    for (const { file, text } of SOURCES) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect({ file, hit: /:\s*any\b|\bas any\b|<any>|@ts-ignore|@ts-expect-error|dangerouslySetInnerHTML|\beval\(|new Function\(/.exec(code)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  test("imports from src/server are `import type` only", () => {
    for (const { file, text } of SOURCES) {
      const lines = text.split("\n").filter((l) => /from\s+["']@\/server\//.test(l) || /from\s+["'](\.\.\/)+server\//.test(l));
      for (const l of lines) expect({ file, line: l.trim(), typeOnly: /^\s*import\s+type\s/.test(l) }).toEqual({ file, line: l.trim(), typeOnly: true });
      expect({ file, dyn: /import\(\s*["']@\/server/.test(text) }).toEqual({ file, dyn: false });
    }
  });

  test("no inline style props in source", () => {
    for (const { file, text } of SOURCES) expect({ file, style: /\bstyle=\{/.test(text) }).toEqual({ file, style: false });
  });

  test("no third-party URLs/scripts/widgets in ShareLink/CompareToggle", () => {
    for (const { file, text } of SOURCES.filter((s) => /ShareLink|CompareToggle/.test(s.file))) {
      expect({ file, hit: /<script|<iframe|https?:\/\/(?!local\.invalid)/.exec(text)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  test("320px class audit on rendered markup: fixed widths only with max-w-full or inside a scroller; no style= except next/image <img>", () => {
    const meta = () => ({ name: "$ACTION_ID_qa", action: "", encType: "multipart/form-data", method: "POST", data: null });
    const ref = <F extends (...a: never[]) => unknown>(fn: F) =>
      Object.assign(fn, { $$FORM_ACTION: meta, bind: (t: unknown, ...a: unknown[]) => Object.assign(Function.prototype.bind.call(fn, t, ...a), { $$FORM_ACTION: meta }) });
    const views = [
      <QuestionCard
        key="qc"
        question={{ id: "q", productId: "p", displayName: "A", body: "B", helpfulCount: 1, status: "published", createdAt: "2026-11-01T00:00:00Z", answers: [] }}
        voteQuestion={ref(async () => null)}
        voteAnswer={ref(async () => null)}
        answerAction={ref(async () => null)}
        productSlug="s"
      />,
      <QuestionForm key="qf" action={ref(async () => null)} productId="p" productSlug="s" />,
      <ImageGallery key="ig" images={[{ url: "/a.svg", alt: "" }, { url: "/b.svg", alt: "" }]} productName="P" hrefForIndex={(i) => `?img=${i}`} />,
      <ShareLink key="sl" url="/products/a" title="A" />,
      <CompareToggle key="ct" productSlug="a" productName="A" selected={["b", "c", "d", "e"]} basePath="/search?q=x" />,
      <OrderTimeline key="ot" steps={[{ status: "processing", state: "complete", at: "2026-11-01T00:00:00Z", label: "Order placed" }]} />,
      <OrderCard key="oc" order={order({ items: [1, 2, 3, 4, 5].map((i) => item(i)) })} />,
      <HeroBanner key="hb" slides={[{ id: "a", headline: "H", subline: "C", cta: { label: "Go", href: "/deals" }, image: { path: "/h.svg", alt: "", width: 1200, height: 800 } }, { id: "b", headline: "H2", image: { path: "/h.svg", alt: "", width: 1200, height: 800 } }]} />,
      <CategoryTile key="ct2" category={{ slug: "a", name: "A", productCount: 3, imageUrl: "/c.svg" }} />,
      <CategoryTile key="ct3" size="sm" category={{ slug: "a", name: "A" }} />,
    ];
    // w-0 / min-w-0 are shrink helpers, not fixed widths.
    const FIXED = /(?:^|\s)(?:min-)?w-(?:[1-9]\d*(?:\.\d+)?|0\.\d+|px|\[[^\]]+\])(?=\s|$)/;
    for (const v of views) {
      const doc = parse(renderToStaticMarkup(v));
      for (const el of doc.querySelectorAll("[class]")) {
        const cls = el.getAttribute("class") ?? "";
        if (!FIXED.test(cls)) continue;
        // T139: hero pager dots are w-2 / w-6 (8px / 24px). Widths up to w-12 (48px) cannot overflow 320px.
        const small = [...cls.matchAll(/(?:^|\s)(?:min-)?w-(\d+(?:\.\d+)?)(?=\s|$)/g)].every((m) => Number(m[1]) <= 12);
        const ok = /max-w-full/.test(cls) || el.closest(".overflow-x-auto") !== null || (small && !/w-(px|\[)/.test(cls));
        expect({ cls, ok }).toEqual({ cls, ok: true });
      }
      const styled = [...doc.querySelectorAll("[style]")].filter((el) => el.tagName !== "IMG");
      expect(styled.map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
    }
  });
});

// ===========================================================================
// Known defects (test.failing until fixed; flip to test() when the fix lands)
// ===========================================================================
describe("QA-W3-B defects", () => {
  // D-T69-1 (fixed by T139/T151): the accent-filled CTA on surface-inverse failed 3:1. The v3 hero never
  // puts an accent fill on a dark slide: inverse and accent slides use the white `inverse` pill, and the
  // accent slide moves the focus ring to focus-ring-inverse (globals.css contrast header).
  test("D-T69-1: dark hero slides (inverse, accent) never render an accent-filled CTA; accent slide uses the inverse focus ring", () => {
    for (const tone of ["inverse", "accent"] as const) {
      const doc = parse(renderToStaticMarkup(<HeroBanner slides={[heroSlide({ tone, cta: { label: "Go", href: "/deals" } })]} />));
      const cta = doc.querySelector('[data-hero-slide] a[href="/deals"]') as HTMLElement;
      const cls = cta.className.split(/\s+/);
      expect({ tone, accentFill: cls.includes("bg-accent") }).toEqual({ tone, accentFill: false });
      expect({ tone, whitePill: cls.includes("bg-surface-raised") || cls.some((c) => c.startsWith("bg-") && c.includes("inverse")) }).toEqual({ tone, whitePill: true });
      if (tone === "accent") expect(cls).toContain("focus-visible:outline-focus-ring-inverse");
    }
  });

  // D-T68-1: product hrefs are checked with isAllowedInternalHref but the order/help defaults are not.
  test("D-T68-1: OrderCard never renders an order href that fails isAllowedInternalHref", () => {
    for (const id of ["..", "a/b"]) {
      const { container, unmount } = render(<OrderCard order={order({ id, items: [] })} />);
      for (const a of container.querySelectorAll("a")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
      unmount();
    }
  });
});
