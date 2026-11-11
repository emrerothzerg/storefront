import { describe, expect, mock, test } from "bun:test";

import type { OrderView, OrdersPage } from "@/server/orders/order-service";
import type { CurrentUser } from "@/server/session/current-user";

import {
  MAX_CONTACT_ORDER_OPTIONS,
  contactOrderLabel,
  isProductRef,
  loadContactPage,
  parseContactQuery,
  parseContactTopic,
  type ContactOrderReader,
  type ContactPageDeps,
} from "./contact-page";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ORDER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORDER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ORDER_OLD = "cccccccc-0000-4000-8000-00000000000c";
const FOREIGN = "dddddddd-0000-4000-8000-00000000000d";
// Built at runtime so "#" + 8 hex letters is not read as a hex colour by check:tokens.
const HASH = "#";

function view(id: string, createdAt = "2026-11-07T10:00:00.000Z"): OrderView {
  return { id, createdAt } as unknown as OrderView;
}

function reader(own: string[], older: string[] = []) {
  const listOrders = mock((owner: string): OrdersPage => ({
    items: owner === OWNER ? own.map((id) => view(id)) : [],
    total: own.length,
    page: 1,
    pageCount: 1,
    tab: "all",
    range: "all",
  }));
  const getOrderView = mock((id: string, owner: string): OrderView | null =>
    owner === OWNER && (own.includes(id) || older.includes(id)) ? view(id, "2025-01-02T00:00:00.000Z") : null,
  );
  const service = { listOrders, getOrderView } as unknown as ContactOrderReader;
  return { service, listOrders, getOrderView };
}

function deps(over: Partial<ContactPageDeps> & { svc?: ContactOrderReader } = {}): ContactPageDeps {
  const svc = over.svc ?? reader([]).service;
  return {
    readOwnerKey: over.readOwnerKey ?? (async () => null),
    readUser: over.readUser ?? (async () => null),
    orders: over.orders ?? (() => svc),
  };
}

describe("parseContactTopic", () => {
  test("allowlisted topics; 'order' aliases 'ordering'; others dropped", () => {
    expect(parseContactTopic("shipping")).toBe("shipping");
    expect(parseContactTopic("order")).toBe("ordering");
    expect(parseContactTopic("product")).toBe("product");
    for (const bad of ["", "Ordering", "orders", "__proto__", "constructor", "<x>", "x".repeat(500), undefined, 3]) {
      expect(parseContactTopic(bad)).toBeUndefined();
    }
  });
});

describe("parseContactQuery", () => {
  test("ref honoured only with topic=product and slug shape", () => {
    expect(parseContactQuery({ topic: "product", ref: "canvas-tote-bag" }).productSlug).toBe("canvas-tote-bag");
    expect(parseContactQuery({ topic: "shipping", ref: "canvas-tote-bag" }).productSlug).toBeUndefined();
    expect(parseContactQuery({ ref: "canvas-tote-bag" }).productSlug).toBeUndefined();
    for (const bad of ["Canvas", "a--b", "-a", "a b", "../x", "a/b", "<x>", "a".repeat(129), ""]) {
      expect(parseContactQuery({ topic: "product", ref: bad }).productSlug).toBeUndefined();
    }
    expect(isProductRef("a".repeat(128))).toBe(true);
  });

  test("order must be a canonical order id", () => {
    expect(parseContactQuery({ order: ORDER_A }).orderId).toBe(ORDER_A);
    for (const bad of [ORDER_A.toUpperCase(), "1001", "ord_1", `${ORDER_A}x`, "' OR 1=1 --", ""]) {
      expect(parseContactQuery({ order: bad }).orderId).toBeUndefined();
    }
  });

  test("never throws on odd shapes", () => {
    expect(() => parseContactQuery(undefined)).not.toThrow();
    expect(() => parseContactQuery({ topic: ["order", "x"], order: [ORDER_A], ref: [] })).not.toThrow();
    expect(parseContactQuery({ topic: ["order", "x"] }).topic).toBe("ordering");
  });
});

describe("contactOrderLabel", () => {
  test("Order #<first 8 upper> · short date (UTC)", () => {
    expect(contactOrderLabel(view(ORDER_A, "2026-11-07T23:59:00.000Z"))).toBe(`Order ${HASH}AAAAAAAA · Nov 7, 2026`);
    expect(contactOrderLabel(view(ORDER_A, "garbage"))).toBe(`Order ${HASH}AAAAAAAA`);
  });
});

describe("loadContactPage", () => {
  test("criterion 2: no cookie -> no orders, order service never touched", async () => {
    const orders = mock(() => reader([ORDER_A]).service);
    const data = await loadContactPage({ topic: "order", order: ORDER_A }, deps({ orders }));
    expect(orders).not.toHaveBeenCalled();
    expect(data).toEqual({
      orders: [],
      initialTopic: "ordering",
      initialOrderId: undefined,
      productSlug: undefined,
      signedInEmail: null,
    });
  });

  test("with a session: own orders only, as id + label", async () => {
    const r = reader([ORDER_A, ORDER_B]);
    const data = await loadContactPage({}, deps({ readOwnerKey: async () => OWNER, svc: r.service }));
    expect(data.orders).toEqual([
      { id: ORDER_A, label: `Order ${HASH}AAAAAAAA · Nov 7, 2026` },
      { id: ORDER_B, label: `Order ${HASH}BBBBBBBB · Nov 7, 2026` },
    ]);
    expect(r.listOrders).toHaveBeenCalledWith(OWNER, { tab: "all", range: "all", page: 1 });
    expect(data.initialOrderId).toBeUndefined();
  });

  test("criterion 2: forged foreign order id is ignored", async () => {
    const r = reader([ORDER_A]);
    const data = await loadContactPage(
      { topic: "order", order: FOREIGN },
      deps({ readOwnerKey: async () => OWNER, svc: r.service }),
    );
    expect(data.initialOrderId).toBeUndefined();
    expect(data.orders.map((o) => o.id)).toEqual([ORDER_A]);
    expect(r.getOrderView).toHaveBeenCalledWith(FOREIGN, OWNER);
  });

  test("own order preselected; topic defaults to ordering", async () => {
    const r = reader([ORDER_A, ORDER_B]);
    const data = await loadContactPage({ order: ORDER_B }, deps({ readOwnerKey: async () => OWNER, svc: r.service }));
    expect(data.initialOrderId).toBe(ORDER_B);
    expect(data.initialTopic).toBe("ordering");
    expect(r.getOrderView).not.toHaveBeenCalled();
  });

  test("an own order older than the first page is appended when requested", async () => {
    const r = reader([ORDER_A], [ORDER_OLD]);
    const data = await loadContactPage(
      { topic: "returns", order: ORDER_OLD },
      deps({ readOwnerKey: async () => OWNER, svc: r.service }),
    );
    expect(data.orders.map((o) => o.id)).toEqual([ORDER_A, ORDER_OLD]);
    expect(data.initialOrderId).toBe(ORDER_OLD);
    expect(data.initialTopic).toBe("returns");
  });

  test("select is capped", async () => {
    const many = Array.from({ length: 15 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const data = await loadContactPage({}, deps({ readOwnerKey: async () => OWNER, svc: reader(many).service }));
    expect(data.orders).toHaveLength(MAX_CONTACT_ORDER_OPTIONS);
  });

  test("order read failure falls back to no orders and logs no identifiers", async () => {
    const error = mock(() => undefined);
    const original = console.error;
    console.error = error;
    try {
      const data = await loadContactPage(
        { order: ORDER_A },
        deps({
          readOwnerKey: async () => OWNER,
          orders: () => {
            throw new Error(`db down for ${OWNER}`);
          },
        }),
      );
      expect(data.orders).toEqual([]);
      expect(data.initialOrderId).toBeUndefined();
      expect(JSON.stringify(error.mock.calls)).not.toContain(OWNER);
    } finally {
      console.error = original;
    }
  });

  test("signedInEmail comes from the current user only", async () => {
    const user: CurrentUser = { id: "u1", email: "ada@example.com", displayName: "Ada" };
    const data = await loadContactPage({}, deps({ readUser: async () => user }));
    expect(data.signedInEmail).toBe("ada@example.com");
    expect(Object.keys(data).sort()).toEqual(
      ["initialOrderId", "initialTopic", "orders", "productSlug", "signedInEmail"].sort(),
    );
  });
});
