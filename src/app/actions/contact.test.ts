import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/cache mocks. mock.module is process-wide in bun test, so
// the mocks are registered before `./contact` is imported and delegate to
// per-test state in this file (same pattern as stock-alerts.test.ts).
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
const wired = await import("./contact");
const { sendContactMessage } = wired;

const EXISTING = "33333333-3333-4333-8333-333333333333";
const FORGED = "44444444-4444-4444-8444-444444444444";
const VALID = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  topic: "returns",
  message: "I would like to return the tote bag, please.",
} as const;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function rows(): { reference: string; session_id: string | null }[] {
  return getDatabase().query("SELECT reference, session_id FROM contact_messages").all() as {
    reference: string;
    session_id: string | null;
  }[];
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
  test("exports only the async sendContactMessage", () => {
    const names = Object.keys(wired);
    expect(names).toEqual(["sendContactMessage"]);
    const value: unknown = wired.sendContactMessage;
    expect(typeof value).toBe("function");
    expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
  });
});

describe("contact server action (wired)", () => {
  test("first submit sets the session cookie and stores the message under it", async () => {
    const state = await sendContactMessage(null, form({ ...VALID, website: "" }));
    if (state === null || !state.ok) throw new Error(`expected success, got ${JSON.stringify(state)}`);
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(rows()).toEqual([{ reference: state.reference, session_id: call?.value ?? "" }]);
    expect(revalidatePath.mock.calls).toEqual([["/account/messages"]]);
  });

  test("existing cookie is reused; forged sessionId ignored", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const state = await sendContactMessage(null, form({ ...VALID, sessionId: FORGED }));
    expect(state).toMatchObject({ ok: true });
    expect(fakeStore.setCalls).toEqual([]);
    expect(rows()[0]?.session_id).toBe(EXISTING);
  });

  test("invalid input and honeypot set no cookie and store nothing", async () => {
    const invalid = await sendContactMessage(null, form({ email: "a@example.com" }));
    expect(invalid).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const trap = await sendContactMessage(null, form({ ...VALID, website: "https://spam.example" }));
    expect(trap).toMatchObject({ ok: true });
    expect(fakeStore.setCalls).toEqual([]);
    expect(rows()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("4th message in an hour is rate limited with retryAfterSeconds", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    for (let i = 0; i < 3; i++) {
      expect(await sendContactMessage(null, form({ ...VALID, message: `${VALID.message} ${i}` }))).toMatchObject({ ok: true });
    }
    const state = await sendContactMessage(null, form({ ...VALID, message: `${VALID.message} 3` }));
    expect(state).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (state === null || state.ok) throw new Error("expected error");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(rows()).toHaveLength(3);
  });

  test("a DB that cannot open still settles with a generic error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    closeDatabase();
    env.DATABASE_PATH = "/nonexistent-dir-for-contact-test/db.sqlite";
    try {
      const state = await sendContactMessage(null, form({ ...VALID }));
      expect(state).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { reason: "unavailable" } } });
      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("CONTACT_ACTION_FAILED");
      expect(logged).not.toContain(VALID.email);
    } finally {
      errorSpy.mockRestore();
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});
