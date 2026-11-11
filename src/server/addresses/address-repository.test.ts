import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteAddressRepository, type AddressRecord } from "./address-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T = (n: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, n)).toISOString();

const RECORD: AddressRecord = {
  label: "Home",
  fullName: "Ada Lovelace",
  phone: null,
  line1: "12 Analytical Row",
  line2: null,
  city: "London",
  region: "Greater London",
  postalCode: "SW1A 1AA",
  country: "GB",
};

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return { db, repo: new SqliteAddressRepository(db) };
}

describe("SqliteAddressRepository", () => {
  test("insert + findById maps columns; null optional columns are omitted", () => {
    const { repo } = setup();
    repo.insert(S1, "a1", RECORD, true, T(0));
    expect(repo.findById(S1, "a1")).toEqual({
      id: "a1",
      label: "Home",
      fullName: "Ada Lovelace",
      line1: "12 Analytical Row",
      city: "London",
      region: "Greater London",
      postalCode: "SW1A 1AA",
      country: "GB",
      isDefault: true,
      createdAt: T(0),
      updatedAt: T(0),
    });
    repo.insert(S1, "a2", { ...RECORD, phone: "555 0100 99", line2: "Flat 2" }, false, T(1));
    expect(repo.findById(S1, "a2")).toMatchObject({ phone: "555 0100 99", line2: "Flat 2", isDefault: false });
  });

  test("every query is scoped by owner key", () => {
    const { repo } = setup();
    repo.insert(S1, "a1", RECORD, true, T(0));
    expect(repo.findById(S2, "a1")).toBeNull();
    expect(repo.listBySession(S2)).toEqual([]);
    expect(repo.countBySession(S2)).toBe(0);
    expect(repo.findDefault(S2)).toBeNull();
    expect(repo.findMostRecent(S2)).toBeNull();
    expect(repo.update(S2, "a1", { ...RECORD, city: "X" }, T(5))).toBe(false);
    expect(repo.markDefault(S2, "a1", T(5))).toBe(false);
    repo.clearDefault(S2, T(5));
    expect(repo.delete(S2, "a1")).toBe(false);
    expect(repo.findById(S1, "a1")).toMatchObject({ city: "London", isDefault: true, updatedAt: T(0) });
  });

  test("listBySession orders default first, then newest; findMostRecent ignores the default flag", () => {
    const { repo } = setup();
    repo.insert(S1, "old", RECORD, true, T(0));
    repo.insert(S1, "mid", RECORD, false, T(1));
    repo.insert(S1, "new", RECORD, false, T(2));
    repo.insert(S1, "tie", RECORD, false, T(2));
    expect(repo.listBySession(S1).map((a) => a.id)).toEqual(["old", "tie", "new", "mid"]);
    expect(repo.findMostRecent(S1)?.id).toBe("tie");
    expect(repo.findDefault(S1)?.id).toBe("old");
    expect(repo.countBySession(S1)).toBe(4);
  });

  test("update, clearDefault, markDefault and delete report matches", () => {
    const { repo } = setup();
    repo.insert(S1, "a1", RECORD, true, T(0));
    repo.insert(S1, "a2", RECORD, false, T(1));
    expect(repo.update(S1, "a1", { ...RECORD, city: "Bath", label: "" }, T(3))).toBe(true);
    expect(repo.findById(S1, "a1")).toMatchObject({ city: "Bath", label: "", createdAt: T(0), updatedAt: T(3) });
    repo.clearDefault(S1, T(4));
    expect(repo.findDefault(S1)).toBeNull();
    expect(repo.markDefault(S1, "a2", T(5))).toBe(true);
    expect(repo.findDefault(S1)?.id).toBe("a2");
    expect(repo.delete(S1, "a2")).toBe(true);
    expect(repo.delete(S1, "a2")).toBe(false);
  });

  test("invalid owner keys: reads are empty without querying, writes throw TypeError", () => {
    const { repo } = setup();
    for (const bad of ["", "nope", "' OR 1=1 --"]) {
      expect(repo.listBySession(bad)).toEqual([]);
      expect(repo.findById(bad, "a1")).toBeNull();
      expect(repo.findDefault(bad)).toBeNull();
      expect(repo.findMostRecent(bad)).toBeNull();
      expect(repo.countBySession(bad)).toBe(0);
      expect(() => repo.insert(bad, "a1", RECORD, true, T(0))).toThrow(TypeError);
      expect(() => repo.update(bad, "a1", RECORD, T(0))).toThrow(TypeError);
      expect(() => repo.delete(bad, "a1")).toThrow(TypeError);
      expect(() => repo.clearDefault(bad, T(0))).toThrow(TypeError);
      expect(() => repo.markDefault(bad, "a1", T(0))).toThrow(TypeError);
    }
  });

  test("values are bound, never interpolated", () => {
    const { repo } = setup();
    const hostile = { ...RECORD, fullName: "Robert'); DROP TABLE addresses; --", label: "<script>x</script>" };
    repo.insert(S1, "a1", hostile, true, T(0));
    expect(repo.findById(S1, "a1")).toMatchObject({ fullName: hostile.fullName, label: hostile.label });
    expect(repo.findById(S1, "a1' OR '1'='1")).toBeNull();
  });
});
