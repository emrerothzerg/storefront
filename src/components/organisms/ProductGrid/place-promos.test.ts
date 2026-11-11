import { describe, expect, test } from "bun:test";
import { MAX_PROMO_SLOTS, placePromos, selectPromoSlots, type PromoSlot } from "./place-promos";

const items = Array.from({ length: 10 }, (_, i) => `p${i}`);
const slot = (afterIndex: number, tile = `t${afterIndex}`): PromoSlot<string> => ({ afterIndex, tile });

function shape(entries: ReturnType<typeof placePromos<string, string>>): string[] {
  return entries.map((e) => (e.kind === "product" ? e.item : `[${e.tile}]`));
}

describe("placePromos", () => {
  test("interleaves tiles right after the product at afterIndex; product indexes ignore promos", () => {
    const out = placePromos(items, [slot(2), slot(5)]);
    expect(shape(out)).toEqual(["p0", "p1", "p2", "[t2]", "p3", "p4", "p5", "[t5]", "p6", "p7", "p8", "p9"]);
    const indexes = out.flatMap((e) => (e.kind === "product" ? [e.index] : []));
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("slots given out of order are placed by position", () => {
    expect(shape(placePromos(items, [slot(5), slot(1)])).filter((s) => s.startsWith("["))).toEqual(["[t1]", "[t5]"]);
  });

  test("an index beyond the item count is dropped", () => {
    expect(shape(placePromos(items, [slot(10), slot(42)]))).toEqual(items);
  });

  test("at most 3 slots are applied (the first three valid ones, in caller order)", () => {
    expect(MAX_PROMO_SLOTS).toBe(3);
    const out = placePromos(items, [slot(6), slot(0), slot(3), slot(1), slot(4)]);
    expect(out.filter((e) => e.kind === "promo").map((e) => (e.kind === "promo" ? e.afterIndex : -1))).toEqual([0, 3, 6]);
  });

  test("invalid slots do not use up the cap", () => {
    const out = placePromos(items, [slot(-1), slot(1.5), slot(Number.NaN), slot(99), slot(1), slot(2), slot(3), slot(4)]);
    expect(out.filter((e) => e.kind === "promo")).toHaveLength(3);
  });

  test("two slots at the same index keep the first", () => {
    const out = placePromos(items, [slot(2, "first"), slot(2, "second")]);
    expect(shape(out)).toContain("[first]");
    expect(shape(out)).not.toContain("[second]");
  });

  test("promos only on page 1 (flag from caller); default page is 1", () => {
    expect(placePromos(items, [slot(1)])).toHaveLength(11);
    expect(placePromos(items, [slot(1)], { page: 1 })).toHaveLength(11);
    for (const page of [2, 3, 0, -1, 1.5, Number.NaN]) {
      expect(shape(placePromos(items, [slot(1)], { page }))).toEqual(items);
    }
  });

  test("no promo is the last element unless the page is full", () => {
    expect(shape(placePromos(items, [slot(9)])).at(-1)).toBe("p9");
    expect(shape(placePromos(items, [slot(9)], { pageSize: 24 })).at(-1)).toBe("p9");
    expect(shape(placePromos(items, [slot(9)], { pageSize: 10 })).at(-1)).toBe("[t9]");
    expect(shape(placePromos(items, [slot(9)], { pageSize: 8 })).at(-1)).toBe("[t9]");
    for (const pageSize of [0, -10, Number.NaN, 2.5]) {
      expect(shape(placePromos(items, [slot(9)], { pageSize })).at(-1)).toBe("p9");
    }
  });

  test("empty items: no promos at all", () => {
    expect(placePromos([], [slot(0), slot(1)])).toEqual([]);
  });

  test("a single item never gets a trailing promo unless full", () => {
    expect(shape(placePromos(["only"], [slot(0)]))).toEqual(["only"]);
    expect(shape(placePromos(["only"], [slot(0)], { pageSize: 1 }))).toEqual(["only", "[t0]"]);
  });

  test("null/undefined/garbage slots are tolerated", () => {
    expect(shape(placePromos(items, undefined))).toEqual(items);
    expect(shape(placePromos(items, null))).toEqual(items);
    const junk = [null, "x", { afterIndex: "2", tile: "t" }, { afterIndex: 2, tile: null }] as unknown as PromoSlot<string>[];
    expect(shape(placePromos(items, junk))).toEqual(items);
  });

  test("isValidTile drops tiles before the cap", () => {
    const out = selectPromoSlots(10, [slot(0, ""), slot(1), slot(2), slot(3)], { isValidTile: (t) => t !== "" });
    expect(out.map((s) => s.afterIndex)).toEqual([1, 2, 3]);
  });

  test("contract L-16 positions (after products 3, 10, 17) on a full 24-item page", () => {
    const page = Array.from({ length: 24 }, (_, i) => `p${i}`);
    const out = placePromos(page, [slot(2, "ship"), slot(9, "sale"), slot(16, "signup")], { page: 1, pageSize: 24 });
    expect(out).toHaveLength(27);
    const positions = out.flatMap((e, i) => (e.kind === "promo" ? [i] : []));
    expect(positions).toEqual([3, 11, 19]);
    expect(out.at(-1)?.kind).toBe("product");
  });

  test("does not mutate its inputs", () => {
    const slots = [slot(5), slot(1)];
    const copy = slots.map((s) => ({ ...s }));
    placePromos(items, slots);
    expect(slots).toEqual(copy);
  });
});
