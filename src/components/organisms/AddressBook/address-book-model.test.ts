import { describe, expect, test } from "bun:test";
import type { SavedAddress } from "@/lib/types";
import { MAX_ADDRESSES_PER_SESSION } from "@/server/addresses/address-service";
import {
  ADDRESS_BOOK_LIMIT,
  ADDRESS_DELETED_TEXT,
  ADDRESS_SAVED_TEXT,
  editFormPrefix,
  limitReachedText,
  normaliseLimit,
  planAfterChange,
  sameSnapshot,
  snapshotOf,
  sortAddresses,
} from "./address-book-model";

function addr(id: string, isDefault = false): SavedAddress {
  return {
    id,
    label: "",
    fullName: `Name ${id}`,
    line1: `${id} Street`,
    city: "Town",
    region: "",
    postalCode: "12345",
    country: "US",
    isDefault,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  };
}

const ids = (list: readonly SavedAddress[]) => list.map((a) => a.id);
const flagged = (list: readonly SavedAddress[]) => list.filter((a) => a.isDefault).map((a) => a.id);

describe("constants", () => {
  test("default limit equals the service constant", () => {
    expect(ADDRESS_BOOK_LIMIT).toBe(MAX_ADDRESSES_PER_SESSION);
    expect(ADDRESS_BOOK_LIMIT).toBe(10);
  });
  test("limit text", () => {
    expect(limitReachedText(10)).toBe("You've reached the limit of 10 addresses. Delete one to add another.");
    expect(limitReachedText(1)).toBe("You've reached the limit of 1 address. Delete one to add another.");
  });
  test("edit prefix is index-based", () => {
    expect(editFormPrefix(0)).toBe("address-form-0");
    expect(editFormPrefix(9)).toBe("address-form-9");
  });
  test("normaliseLimit", () => {
    expect(normaliseLimit(undefined)).toBe(10);
    expect(normaliseLimit(3)).toBe(3);
    for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(normaliseLimit(bad)).toBe(10);
  });
});

describe("sortAddresses", () => {
  test("default first, others keep service order", () => {
    const out = sortAddresses([addr("a"), addr("b"), addr("c", true), addr("d")]);
    expect(ids(out)).toEqual(["c", "a", "b", "d"]);
    expect(flagged(out)).toEqual(["c"]);
  });
  test("already first is unchanged", () => {
    expect(ids(sortAddresses([addr("a", true), addr("b")]))).toEqual(["a", "b"]);
  });
  test("0 flagged -> no default, order kept", () => {
    const out = sortAddresses([addr("a"), addr("b")]);
    expect(ids(out)).toEqual(["a", "b"]);
    expect(flagged(out)).toEqual([]);
  });
  test("2 flagged -> the first flagged wins, the other is shown as regular", () => {
    const out = sortAddresses([addr("a"), addr("b", true), addr("c", true)]);
    expect(ids(out)).toEqual(["b", "a", "c"]);
    expect(flagged(out)).toEqual(["b"]);
  });
  test("does not mutate input", () => {
    const input = [addr("a"), addr("b", true), addr("c", true)];
    sortAddresses(input);
    expect(flagged(input)).toEqual(["b", "c"]);
  });
  test("empty", () => {
    expect(sortAddresses([])).toEqual([]);
  });
});

describe("planAfterChange", () => {
  const snap = (list: SavedAddress[]) => snapshotOf(list);
  const abc = [addr("a", true), addr("b"), addr("c")];

  test("no change -> null", () => {
    expect(planAfterChange(snap(abc), snap([...abc]))).toBeNull();
    expect(sameSnapshot(snap(abc), snap(abc))).toBe(true);
  });
  test("delete middle -> next card takes its index", () => {
    const plan = planAfterChange(snap(abc), snap([addr("a", true), addr("c")]));
    expect(plan).toEqual({ change: "deleted", target: { kind: "card", index: 1 }, announcement: ADDRESS_DELETED_TEXT });
  });
  test("delete last -> new last card", () => {
    const plan = planAfterChange(snap(abc), snap([addr("a", true), addr("b")]));
    expect(plan?.target).toEqual({ kind: "card", index: 1 });
  });
  test("delete default (promotion) -> card at index 0", () => {
    const plan = planAfterChange(snap(abc), snap([addr("c", true), addr("b")]));
    expect(plan?.change).toBe("deleted");
    expect(plan?.target).toEqual({ kind: "card", index: 1 });
  });
  test("delete the only address -> heading", () => {
    const plan = planAfterChange(snap([addr("a", true)]), snap([]));
    expect(plan?.target).toEqual({ kind: "heading" });
    expect(plan?.announcement).toBe(ADDRESS_DELETED_TEXT);
  });
  test("added -> limit notice, falls back to the new card", () => {
    const plan = planAfterChange(snap(abc), snap([addr("a", true), addr("d"), addr("b"), addr("c")]));
    expect(plan).toEqual({
      change: "added",
      target: { kind: "limit", fallbackIndex: 1 },
      announcement: ADDRESS_SAVED_TEXT,
    });
  });
  test("default changed -> new default card, no own announcement", () => {
    const plan = planAfterChange(snap(abc), snap([addr("c", true), addr("a"), addr("b")]));
    expect(plan).toEqual({ change: "default", target: { kind: "card", index: 0 }, announcement: "" });
  });
  test("reorder only -> null", () => {
    expect(planAfterChange(snap(abc), snap([addr("a", true), addr("c"), addr("b")]))).toBeNull();
  });
});
