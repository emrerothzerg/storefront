import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { SIMULATED_TRACKING_NOTICE as SERVER_NOTICE } from "@/server/fulfillment/fulfillment";
import type { TimelineStep } from "@/server/fulfillment/timeline";
import {
  OrderTimeline,
  SIMULATED_TRACKING_NOTICE,
  formatExpected,
  formatTimelineDate,
  normalizeTimeline,
  toStepItems,
} from ".";

const live: readonly TimelineStep[] = [
  { status: "processing", at: "2026-11-03T10:42:00.000Z", state: "complete", label: "Order placed" },
  { status: "packed", at: "2026-11-04T09:00:00.000Z", state: "complete", label: "Packed" },
  { status: "shipped", at: "2026-11-05T15:30:00.000Z", state: "current", label: "Shipped" },
  { status: "out_for_delivery", at: null, state: "upcoming", label: "Out for delivery" },
  { status: "delivered", at: null, state: "upcoming", label: "Delivered" },
];

const cancelled: readonly TimelineStep[] = [
  { status: "processing", at: "2026-11-03T10:42:00.000Z", state: "complete", label: "Order placed" },
  { status: "cancelled", at: "2026-11-03T10:50:00.000Z", state: "cancelled", label: "Cancelled" },
];

const estimate = { start: "2026-11-10T00:00:00.000Z", end: "2026-11-12T00:00:00.000Z" };

function listItems(): HTMLElement[] {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

describe("SIMULATED_TRACKING_NOTICE", () => {
  test("matches the fulfilment module constant", () => {
    expect(SIMULATED_TRACKING_NOTICE).toBe(SERVER_NOTICE);
  });
});

describe("formatTimelineDate", () => {
  test("formats en-US in UTC", () => {
    expect(formatTimelineDate("2026-11-03T10:42:00.000Z")).toBe("Nov 3, 2026, 10:42 AM UTC");
    expect(formatTimelineDate("2026-11-03T23:59:00-05:00")).toBe("Nov 4, 2026, 4:59 AM UTC");
  });
  test("returns null for missing or invalid input", () => {
    expect(formatTimelineDate(null)).toBeNull();
    expect(formatTimelineDate(undefined)).toBeNull();
    expect(formatTimelineDate("")).toBeNull();
    expect(formatTimelineDate("   ")).toBeNull();
    expect(formatTimelineDate("not a date")).toBeNull();
    expect(formatTimelineDate("2026-13-45T99:00:00Z")).toBeNull();
  });
});

describe("formatExpected", () => {
  test("range, single day, invalid", () => {
    expect(formatExpected(estimate)).toBe("Expected Tue, Nov 10 – Thu, Nov 12");
    expect(formatExpected({ start: estimate.start, end: estimate.start })).toBe("Expected Tue, Nov 10");
    expect(formatExpected({ start: estimate.end, end: estimate.start })).toBeNull();
    expect(formatExpected({ start: "bad", end: estimate.end })).toBeNull();
    expect(formatExpected(null)).toBeNull();
    expect(formatExpected(undefined)).toBeNull();
  });
});

describe("normalizeTimeline", () => {
  test("drops every step after the first cancelled step", () => {
    const hostile: TimelineStep[] = [
      ...cancelled,
      { status: "delivered", at: "2026-11-09T14:00:00.000Z", state: "complete", label: "Delivered" },
      { status: "shipped", at: null, state: "upcoming", label: "Shipped" },
    ];
    const out = normalizeTimeline(hostile);
    expect(out.map((s) => s.status)).toEqual(["processing", "cancelled"]);
  });
  test("unknown state becomes upcoming", () => {
    const bad = [{ ...live[0], state: "done" }] as unknown as TimelineStep[];
    expect(normalizeTimeline(bad)[0]?.state).toBe("upcoming");
  });
  test("leaves a live timeline untouched", () => {
    expect(normalizeTimeline(live)).toEqual(live);
  });
});

describe("toStepItems", () => {
  test("maps state to status, dates to timestamps, Expected on the delivered step", () => {
    const items = toStepItems(live, estimate);
    expect(items.map((i) => i.status)).toEqual(["complete", "complete", "current", "upcoming", "upcoming"]);
    expect(items[0]?.timestamp).toBe("Nov 3, 2026, 10:42 AM UTC");
    expect(items[3]?.timestamp).toBeUndefined();
    expect(items[4]?.timestamp).toBe("Expected Tue, Nov 10 – Thu, Nov 12");
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
  test("no estimate or invalid estimate leaves the delivered step without text", () => {
    expect(toStepItems(live)[4]?.timestamp).toBeUndefined();
    expect(toStepItems(live, { start: "x", end: "y" })[4]?.timestamp).toBeUndefined();
  });
  test("a delivered step with a timestamp shows the date, not Expected", () => {
    const delivered: TimelineStep[] = live.map((s) =>
      s.status === "delivered"
        ? { ...s, at: "2026-11-09T14:00:00.000Z", state: "complete" }
        : { ...s, state: "complete", at: s.at ?? "2026-11-09T06:00:00.000Z" },
    );
    expect(toStepItems(delivered, estimate)[4]?.timestamp).toBe("Nov 9, 2026, 2:00 PM UTC");
  });
  test("invalid step dates are omitted, never thrown", () => {
    const bad: TimelineStep[] = [{ ...live[0]!, at: "garbage" }];
    expect(() => toStepItems(bad)).not.toThrow();
    expect(toStepItems(bad)[0]?.timestamp).toBeUndefined();
  });
});

describe("OrderTimeline", () => {
  test("renders a heading, the steps and the visible simulated-tracking label", () => {
    render(<OrderTimeline steps={live} estimatedDelivery={estimate} />);
    const heading = screen.getByRole("heading", { level: 2, name: "Order progress" });
    expect(screen.getByRole("list")).toHaveAccessibleName("Order progress");
    expect(screen.getByRole("region", { name: "Order progress" })).toContainElement(heading);
    expect(listItems()).toHaveLength(5);
    expect(screen.getByText("Tracking is simulated in this demo store.")).toBeVisible();
    expect(screen.getByText("Expected Tue, Nov 10 – Thu, Nov 12")).toBeInTheDocument();
    expect(screen.getByText("Nov 5, 2026, 3:30 PM UTC")).toBeInTheDocument();
    const current = listItems().find((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveTextContent("Shipped");
  });

  test("criterion 1: cancelled order shows a cancelled step in text and no later complete steps", () => {
    const hostile: TimelineStep[] = [
      ...cancelled,
      { status: "delivered", at: "2026-11-09T14:00:00.000Z", state: "complete", label: "Delivered" },
    ];
    render(<OrderTimeline steps={hostile} estimatedDelivery={estimate} />);
    const items = listItems();
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveAttribute("data-status", "cancelled");
    expect(items[1]).toHaveTextContent("Cancelled: Cancelled");
    expect(items[1]).toHaveTextContent("Nov 3, 2026, 10:50 AM UTC");
    expect(screen.queryByText(/Delivered/)).toBeNull();
    expect(screen.queryByText(/^Expected/)).toBeNull();
  });

  test("headingLevel 3, custom heading, horizontal orientation", () => {
    render(<OrderTimeline steps={live} headingLevel={3} heading="Tracking" orientation="horizontal" />);
    expect(screen.getByRole("heading", { level: 3, name: "Tracking" })).toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveAttribute("data-orientation", "horizontal");
  });

  test("empty steps still render the heading and label without a list", () => {
    render(<OrderTimeline steps={[]} />);
    expect(screen.getByRole("heading", { name: "Order progress" })).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText(SIMULATED_TRACKING_NOTICE)).toBeInTheDocument();
  });

  test("hostile labels render as text", () => {
    const steps: TimelineStep[] = [{ ...live[0]!, label: '<img src=x onerror="alert(1)">' }];
    const { container } = render(<OrderTimeline steps={steps} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });

  test("two timelines get distinct heading ids", () => {
    const { container } = render(
      <>
        <OrderTimeline steps={live} />
        <OrderTimeline steps={live} />
      </>,
    );
    const ids = [...container.querySelectorAll("h2")].map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("server-safe: renderToStaticMarkup works and uses tokens only", () => {
    const html = renderToStaticMarkup(<OrderTimeline steps={live} estimatedDelivery={estimate} />);
    expect(html).toContain("Tracking is simulated in this demo store.");
    expect(html).toContain("Expected Tue, Nov 10 – Thu, Nov 12");
    expect(html).not.toMatch(/style=/);
    expect(html).not.toMatch(/\[#|-\[/);
  });
});
