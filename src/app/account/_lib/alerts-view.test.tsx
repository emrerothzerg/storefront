import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StockAlertActionFn } from "@/components/molecules/_contracts/stock-alert-actions";
import type { StockAlertView } from "@/server/alerts/stock-alert-service";

import { ALERT_UNAVAILABLE_TEXT, AlertsView } from "./alerts-view";

const noop: StockAlertActionFn = async () => null;

const ALERT_LIVE = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const ALERT_GONE = "6fa459ea-ee8a-4ca4-894e-db77e160355e";

function view(id: string, overrides: Partial<StockAlertView> = {}): StockAlertView {
  return {
    id,
    productId: "p1",
    createdAt: "2026-11-01T00:00:00.000Z",
    acknowledgedAt: null,
    status: "back_in_stock",
    available: true,
    product: { id: "p1", slug: "blue-mug", name: "Blue Mug", imageUrl: "/x.svg", priceCents: 100, currency: "USD", stock: 3 },
    ...overrides,
  };
}

function parse(alerts: readonly StockAlertView[]): Document {
  const html = renderToStaticMarkup(<AlertsView alerts={alerts} unsubscribeAction={noop} acknowledgeAction={noop} />);
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

function items(doc: Document): Element[] {
  return [...doc.querySelectorAll('ul[aria-label="Watched products"] > li')];
}

describe("AlertsView: unavailable products (D-T98-4)", () => {
  const unpublished = view(ALERT_GONE, {
    available: false,
    product: { id: "p2", slug: "", name: "Withdrawn Kettle", imageUrl: "/k.svg", priceCents: 100, currency: "USD", stock: 4 },
  });

  test("available product: link, status badge, 'available again' notice", () => {
    const [li] = items(parse([view(ALERT_LIVE)]));
    expect(li?.querySelector("a")?.getAttribute("href")).toBe("/products/blue-mug");
    expect(li?.textContent).toContain("Back in stock");
    expect(li?.textContent).toContain("Blue Mug is available again.");
    expect(li?.textContent).not.toContain(ALERT_UNAVAILABLE_TEXT);
  });

  test("unpublished product: name as text, 'No longer available', no link, only Stop watching + Acknowledge", () => {
    const [li] = items(parse([unpublished]));
    expect(li?.querySelector("a")).toBeNull();
    expect(li?.textContent).toContain("Withdrawn Kettle");
    expect(li?.textContent).toContain(ALERT_UNAVAILABLE_TEXT);
    expect(li?.textContent).not.toContain("is available again");
    const forms = [...(li?.querySelectorAll("form") ?? [])];
    expect(forms.map((f) => (f.querySelector("button")?.textContent ?? "").split(" ").slice(0, 2).join(" "))).toEqual([
      "Stop watching",
      "Acknowledge back-in-stock",
    ]);
    for (const f of forms) {
      expect(f.querySelector('input[name="alertId"]')?.getAttribute("value")).toBe(ALERT_GONE);
      expect(f.querySelector('input[name="productSlug"]')).toBeNull();
    }
  });

  test("available false wins over a well-formed slug; acknowledged unavailable alert keeps only Stop watching", () => {
    const tricky = view(ALERT_GONE, { available: false, acknowledgedAt: "2026-11-02T00:00:00.000Z" });
    const [li] = items(parse([tricky]));
    expect(li?.querySelector("a")).toBeNull();
    expect(li?.textContent).toContain(ALERT_UNAVAILABLE_TEXT);
    const forms = [...(li?.querySelectorAll("form") ?? [])];
    expect(forms).toHaveLength(1);
    expect(forms[0]?.textContent).toContain("Stop watching");
    expect(forms[0]?.querySelector('input[name="productSlug"]')).toBeNull();
  });

  test("gone product (null): fallback name, no link, 'No longer available'", () => {
    const [li] = items(parse([view(ALERT_GONE, { product: null, available: false, status: "waiting" })]));
    expect(li?.querySelector("a")).toBeNull();
    expect(li?.textContent).toContain("Product no longer available");
    expect(li?.textContent).toContain(ALERT_UNAVAILABLE_TEXT);
  });

  test("hand-built view without `available` keeps the old behaviour (link when the slug is valid)", () => {
    const legacy: StockAlertView = { ...view(ALERT_LIVE) };
    delete (legacy as { available?: boolean }).available;
    expect("available" in legacy).toBe(false);
    const [li] = items(parse([legacy]));
    expect(li?.querySelector("a")?.getAttribute("href")).toBe("/products/blue-mug");
  });

  test("submit names stay unique with mixed items", () => {
    const doc = parse([view(ALERT_LIVE), unpublished]);
    const names = [...doc.querySelectorAll("form button")].map((b) => b.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(4);
  });
});
