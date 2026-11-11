import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/cache mocks. mock.module is process-wide in bun test, so
// the mocks are registered before `./addresses` is imported and delegate to
// per-test state in this file (same pattern as contact.test.ts).
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: unknown;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options?: unknown): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }

  delete(name: string): void {
    this.jar.delete(name);
  }
}

let fakeStore = new FakeCookieStore();
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const wired = await import("./addresses");
const { saveAddress, deleteAddress, setDefaultAddress } = wired;

const EXISTING = "33333333-3333-4333-8333-333333333333";
const FORGED = "44444444-4444-4444-8444-444444444444";
const VALID = {
  fullName: "Zelda Quartermain",
  line1: "742 Evergreen Terrace",
  city: "Springfieldton",
  region: "Westshire",
  postalCode: "ZX9 8QW",
  country: "GB",
} as const;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function rows(): { id: string; session_id: string }[] {
  return getDatabase().query("SELECT id, session_id FROM addresses").all() as { id: string; session_id: string }[];
}

beforeEach(() => {
  closeDatabase(); // fresh in-memory DB per test
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  revalidatePath.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("'use server' module shape", () => {
  test("exports only the three async actions", () => {
    expect(Object.keys(wired).sort()).toEqual(["deleteAddress", "saveAddress", "setDefaultAddress"]);
    for (const value of Object.values(wired) as unknown[]) {
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });
});

describe("address server actions (wired)", () => {
  test("cold visitor: first save sets the session cookie and stores the address under it", async () => {
    const state = await saveAddress(null, form({ ...VALID }));
    expect(state).toMatchObject({ ok: true, kind: "saved" });
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(call?.value).not.toContain(VALID.fullName);
    expect(rows()).toEqual([{ id: state !== null && state.ok ? (state.addressId ?? "") : "", session_id: call?.value ?? "" }]);
    expect(revalidatePath.mock.calls).toEqual([["/account/addresses"], ["/checkout"]]);
  });

  test("existing cookie reused; forged sessionId ignored", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    expect(await saveAddress(null, form({ ...VALID, sessionId: FORGED }))).toMatchObject({ ok: true });
    expect(fakeStore.setCalls).toEqual([]);
    expect(rows()[0]?.session_id).toBe(EXISTING);
  });

  test("update / delete / setDefault without a cookie set no cookie and answer NOT_FOUND", async () => {
    const id = crypto.randomUUID();
    for (const state of [
      await saveAddress(null, form({ ...VALID, addressId: id })),
      await deleteAddress(null, form({ addressId: id, confirm: "yes" })),
      await setDefaultAddress(null, form({ addressId: id })),
    ]) {
      expect(state).toMatchObject({ ok: false, error: { code: "NOT_FOUND" }, message: "Address not found." });
    }
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("invalid input sets no cookie and stores nothing", async () => {
    const state = await saveAddress(null, form({ fullName: "Ada" }));
    expect(state).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" }, values: { fullName: "Ada" } });
    expect(fakeStore.setCalls).toEqual([]);
    expect(rows()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("full lifecycle with a cookie: save, set default, delete", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const a = await saveAddress(null, form({ ...VALID }));
    const b = await saveAddress(null, form({ ...VALID, line1: "1 Other Road" }));
    if (a === null || !a.ok || b === null || !b.ok) throw new Error("expected saves");
    expect(await setDefaultAddress(null, form({ addressId: b.addressId ?? "" }))).toMatchObject({ ok: true, kind: "default_set" });
    expect(await deleteAddress(null, form({ addressId: a.addressId ?? "" }))).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await deleteAddress(null, form({ addressId: a.addressId ?? "", confirm: "yes" }))).toMatchObject({
      ok: true,
      kind: "deleted",
    });
    expect(rows().map((r) => r.id)).toEqual([b.addressId ?? ""]);
  });

  test("a DB that cannot open still settles with a generic error and a PII-free log", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    closeDatabase();
    env.DATABASE_PATH = "/nonexistent-dir-for-address-test/db.sqlite";
    try {
      const save = await saveAddress(null, form({ ...VALID }));
      expect(save).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT", details: { reason: "unavailable" } },
        values: { fullName: VALID.fullName },
      });
      expect(await deleteAddress(null, form({ addressId: "x", confirm: "yes" }))).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
      expect(await setDefaultAddress(null, form({ addressId: "x" }))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("ADDRESS_ACTION_FAILED");
      for (const value of Object.values(VALID)) expect(logged).not.toContain(value);
    } finally {
      errorSpy.mockRestore();
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});
