import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDatabase, createDatabase, getDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createAccountService, getAccountService, DELETED_OWNER_KEY } from "./account-service";
import { createAuthRepository } from "./auth-repository";
import { createAuthService, hashToken } from "./auth-service";
import { argon2idHasher, validatePassword } from "./password-policy";

/**
 * T118 through the REAL T116 auth service, argon2id hasher and password policy
 * (one integration path; the colocated unit tests use fast fakes).
 */

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const PASSWORD = "integration pass 42";
const NEW_PASSWORD = "integration pass 43";

const captured: string[] = [];
const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
  spyOn(console, m).mockImplementation((...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  }),
);
const hashes: string[] = [];
afterAll(() => {
  for (const s of spies) s.mockRestore();
  const all = captured.join("\n");
  for (const secret of [PASSWORD, NEW_PASSWORD, "$argon2", ...hashes]) expect(all.includes(secret)).toBe(false);
});

function hashOf(db: Database, id: string): string {
  return db.query<{ h: string }, [string]>("SELECT password_hash AS h FROM users WHERE id = ?").get(id)?.h ?? "";
}

async function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const authService = createAuthService({ db, hasher: argon2idHasher, now: () => NOW });
  const repo = createAuthRepository(db);
  const created = repo.createUser({
    email: "int@example.com",
    passwordHash: await argon2idHasher.hash(PASSWORD),
    displayName: "Int",
  });
  if (!created.ok) throw new Error("fixture");
  const user = created.value;
  hashes.push(hashOf(db, user.id));
  const keep = authService.issueSessionFor(user.id, { sessionKey: null, now: NOW });
  const other = authService.issueSessionFor(user.id, { sessionKey: null, now: NOW });
  if (!keep.ok || !other.ok) throw new Error("fixture sessions");
  const service = createAccountService({
    db,
    verifyPassword: (id, pw, now) => authService.verifyPassword(id, pw, now),
    hashPassword: (pw) => argon2idHasher.hash(pw),
    validatePassword,
    revokeOthers: (id, keepId, now) => repo.revokeOthers(id, keepId, now),
    now: () => NOW,
  });
  const failed = () =>
    db.query<{ n: number }, [string]>("SELECT failed_login_count AS n FROM users WHERE id = ?").get(user.id)?.n;
  return { db, repo, authService, service, user, keep: keep.value, other: other.value, failed };
}

describe("account service with the real auth service (T116)", () => {
  test("changePassword: wrong current counts toward lockout; missing current maps to currentPassword; success rotates hash and revokes others", async () => {
    const { db, repo, authService, service, user, keep, other, failed } = await setup();

    const wrong = await service.changePassword(user.id, "not my password", NEW_PASSWORD, keep.authSessionId, NOW);
    expect(!wrong.ok && wrong.error.code).toBe("INVALID_CREDENTIALS");
    expect(failed()).toBe(1);

    const missing = await service.changePassword(user.id, "", NEW_PASSWORD, keep.authSessionId, NOW);
    expect(!missing.ok && missing.error.code).toBe("VALIDATION_FAILED");
    expect(!missing.ok && Object.keys((missing.error.details?.fields as object) ?? {})).toEqual(["currentPassword"]);

    const weak = await service.changePassword(user.id, PASSWORD, "password", keep.authSessionId, NOW);
    expect(!weak.ok && weak.error.details).toEqual({ fields: { newPassword: { code: "WEAK", message: expect.any(String) } } });
    const short = await service.changePassword(user.id, PASSWORD, "abcdefg", keep.authSessionId, NOW);
    expect(!short.ok && short.error.details).toEqual({ fields: { newPassword: { code: "TOO_SHORT", message: expect.any(String) } } });

    const before = hashOf(db, user.id);
    const r = await service.changePassword(user.id, PASSWORD, NEW_PASSWORD, keep.authSessionId, NOW);
    expect(r.ok).toBe(true);
    const after = hashOf(db, user.id);
    hashes.push(after);
    expect(after).not.toBe(before);
    expect(after.startsWith("$argon2id$")).toBe(true);
    expect((await authService.verifyPassword(user.id, PASSWORD, NOW)).ok).toBe(false);
    expect((await authService.verifyPassword(user.id, NEW_PASSWORD, NOW)).ok).toBe(true);
    expect(authService.resolveToken(keep.token, NOW)).not.toBeNull();
    expect(authService.resolveToken(other.token, NOW)).toBeNull();
    expect(repo.findAuthSessionByTokenHash(hashToken(other.token), NOW)).toBeNull();
  });

  test("deleteAccount: wrong password counts and deletes nothing; correct password deletes, tokens die, email reusable", async () => {
    const { db, repo, authService, service, user, keep, failed } = await setup();
    db.query(
      `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
         region, postal_code, country, card_last4, idempotency_key) VALUES
       ('ord-int', ?, 'paid', 100, 100, 'USD', 'Int', 'int@example.com', '1 St', 'C', 'R', 'P', 'US', '4242', 'idem-int')`,
    ).run(user.ownerKey);

    const wrong = await service.deleteAccount(user.id, "nope nope nope", NOW);
    expect(!wrong.ok && wrong.error.code).toBe("INVALID_CREDENTIALS");
    expect(failed()).toBe(1);
    expect(repo.findUserById(user.id)).not.toBeNull();

    const r = await service.deleteAccount(user.id, PASSWORD, NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.anonymisedOrders).toBe(1);
    expect(authService.resolveToken(keep.token, NOW)).toBeNull();
    expect(db.query("SELECT session_id, email FROM orders WHERE id = 'ord-int'").get()).toEqual({
      session_id: DELETED_OWNER_KEY,
      email: "[deleted]",
    });
    const again = await authService.signUp(
      { email: "INT@example.com", password: "another strong one", displayName: "Again" },
      { sessionKey: globalThis.crypto.randomUUID(), now: NOW },
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.user.id).not.toBe(user.id);
    const fresh = repo.findUserById(again.value.user.id);
    expect(fresh?.ownerKey).not.toBe(user.ownerKey);
    expect(db.query("SELECT COUNT(*) AS n FROM orders WHERE session_id = ?").get(fresh?.ownerKey ?? "")).toEqual({ n: 0 });
  });
});

describe("getAccountService", () => {
  const previous = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  });

  test("is a singleton over getDatabase() wired to the real policy", async () => {
    process.env.DATABASE_PATH = ":memory:";
    const a = getAccountService();
    expect(getAccountService()).toBe(a);
    const user = createAuthRepository(getDatabase()).createUser({
      email: "single@example.com",
      passwordHash: await argon2idHasher.hash(PASSWORD),
      displayName: "S",
    });
    if (!user.ok) throw new Error("fixture");
    hashes.push(hashOf(getDatabase(), user.value.id));
    const renamed = await a.updateDisplayName(user.value.id, "  Renamed  ");
    expect(renamed.ok && renamed.value.displayName).toBe("Renamed");
    // Real verify (argon2id) through getAuthService(): wrong password is INVALID_CREDENTIALS.
    const r = await a.deleteAccount(user.value.id, "wrong wrong wrong");
    expect(!r.ok && r.error.code).toBe("INVALID_CREDENTIALS");
    const ok = await a.deleteAccount(user.value.id, PASSWORD);
    expect(ok.ok).toBe(true);
  });
});
