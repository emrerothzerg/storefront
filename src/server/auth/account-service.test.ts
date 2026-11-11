import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { isSessionId } from "@/server/session/session-id";
import { createAuthRepository } from "./auth-repository";
import { createAccountRepository, OWNER_KEYED_TABLES } from "./account-repository";
import {
  createAccountService,
  DELETED_MARKER,
  DELETED_OWNER_KEY,
  type DeletionSummary,
} from "./account-service";
import { DISPLAY_NAME_MAX } from "./password-policy";
import {
  createFakeAuth,
  createFixture,
  createSession,
  discoverOwnerColumns,
  fakeHash,
  NOW,
  PASSWORDS,
  snapshotDatabase,
  type Fixture,
  type Party,
} from "./account-test-fixture";

// AR1: capture every console channel for the whole file; asserted at the end.
const captured: string[] = [];
const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
  spyOn(console, method).mockImplementation((...args: unknown[]) => {
    captured.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : String(a))).join(" "));
  }),
);
const secrets = new Set<string>([PASSWORDS.A, PASSWORDS.B, "brand new password 1", "$argon2"]);
const serviceLogs: string[] = [];

afterAll(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  const all = [...captured, ...serviceLogs].join("\n");
  for (const secret of secrets) expect(all.includes(secret)).toBe(false);
});

function passwordHashOf(db: Database, userId: string): string | null {
  return db.query<{ password_hash: string }, [string]>("SELECT password_hash FROM users WHERE id = ?").get(userId)
    ?.password_hash ?? null;
}

function failedCount(db: Database, userId: string): number {
  return db.query<{ n: number }, [string]>("SELECT failed_login_count AS n FROM users WHERE id = ?").get(userId)?.n ?? -1;
}

function setup(overrides: Parameters<typeof createFakeAuth>[1] = {}) {
  const fx = createFixture();
  const fake = createFakeAuth(fx.db, overrides);
  const service = createAccountService(fake.deps);
  secrets.add(passwordHashOf(fx.db, fx.A.user.id) ?? "");
  secrets.add(passwordHashOf(fx.db, fx.B.user.id) ?? "");
  for (const s of [...fx.A.sessions, ...fx.B.sessions]) secrets.add(s.tokenHash);
  return { fx, fake, service, track: () => serviceLogs.push(...fake.logs) };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("constants", () => {
  test("tombstone is a v4-shaped UUID that never resolves to a user", () => {
    const { fx } = setup();
    expect(DELETED_OWNER_KEY).toBe("00000000-0000-4000-8000-000000000000");
    expect(DELETED_MARKER).toBe("[deleted]");
    expect(isSessionId(DELETED_OWNER_KEY)).toBe(true);
    expect(fx.repo.findUserByOwnerKey(DELETED_OWNER_KEY)).toBeNull();
  });
});

describe("updateDisplayName", () => {
  test("cleans and stores the name, returns the updated user", async () => {
    const { fx, service } = setup();
    const r = await service.updateDisplayName(fx.A.user.id, "  Ada \t  Lovelace​ ", NOW + 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.displayName).toBe("Ada Lovelace");
    expect(fx.repo.findUserById(fx.A.user.id)?.displayName).toBe("Ada Lovelace");
  });

  test.each([
    ["empty", "", "REQUIRED"],
    ["whitespace", "   ", "REQUIRED"],
    ["non-string", 42, "REQUIRED"],
    ["missing", undefined, "REQUIRED"],
    ["51 chars", "x".repeat(51), "TOO_LONG"],
    ["oversized raw", "x".repeat(10_000), "TOO_LONG"],
  ])("%s -> VALIDATION_FAILED on displayName (%s)", async (_label, raw, code) => {
    const { fx, service } = setup();
    const r = await service.updateDisplayName(fx.A.user.id, raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION_FAILED");
    expect(r.error.details).toEqual({ fields: { displayName: { code, message: expect.any(String) } } });
    expect(fx.repo.findUserById(fx.A.user.id)?.displayName).toBe("Name A");
  });

  test("50 chars accepted; length is UTF-16 units like every cleanText field (25 astral ok, 26 not)", async () => {
    const { fx, service } = setup();
    expect((await service.updateDisplayName(fx.A.user.id, "y".repeat(DISPLAY_NAME_MAX))).ok).toBe(true);
    expect((await service.updateDisplayName(fx.A.user.id, "\u{1F600}".repeat(25))).ok).toBe(true);
    const over = await service.updateDisplayName(fx.A.user.id, "\u{1F600}".repeat(26));
    expect(!over.ok && over.error.code).toBe("VALIDATION_FAILED");
  });

  test("hostile markup is stored as plain text", async () => {
    const { fx, service } = setup();
    const r = await service.updateDisplayName(fx.A.user.id, "<img src=x onerror=alert(1)>");
    expect(r.ok && r.value.displayName).toBe("<img src=x onerror=alert(1)>");
  });

  test("existing review / question / answer display_name snapshots are unchanged", async () => {
    const { fx, service } = setup();
    await service.updateDisplayName(fx.A.user.id, "Renamed");
    const names = fx.db
      .query<{ display_name: string }, [string]>(
        `SELECT display_name FROM reviews WHERE session_id = ?1
         UNION ALL SELECT display_name FROM questions WHERE session_id = ?1
         UNION ALL SELECT display_name FROM answers WHERE session_id = ?1`,
      )
      .all(fx.A.key)
      .map((r) => r.display_name);
    expect(names.length).toBe(4);
    expect(names).not.toContain("Renamed");
  });

  test("unknown or malformed user -> NOT_FOUND", async () => {
    const { service } = setup();
    for (const id of [globalThis.crypto.randomUUID(), "nope"]) {
      const r = await service.updateDisplayName(id, "Valid");
      expect(!r.ok && r.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("changePassword", () => {
  const NEW = "brand new password 1";

  test("success: new hash stored, old fails, new verifies, other sessions revoked, keep session and B untouched", async () => {
    const { fx, fake, service } = setup();
    const [keep, other] = fx.A.sessions as [Fixture["A"]["sessions"][0], Fixture["A"]["sessions"][0]];
    const before = passwordHashOf(fx.db, fx.A.user.id);
    const r = await service.changePassword(fx.A.user.id, PASSWORDS.A, NEW, keep.id, NOW);
    expect(r).toEqual({ ok: true, value: undefined });
    const after = passwordHashOf(fx.db, fx.A.user.id);
    expect(after).not.toBe(before);
    expect(after).toBe(fakeHash(NEW));
    expect(fake.hashCalls.count).toBe(1);
    expect((await fake.deps.verifyPassword(fx.A.user.id, PASSWORDS.A, NOW)).ok).toBe(false);
    expect((await fake.deps.verifyPassword(fx.A.user.id, NEW, NOW)).ok).toBe(true);
    expect(fx.repo.findAuthSessionByTokenHash(keep.tokenHash, NOW)).not.toBeNull();
    expect(fx.repo.findAuthSessionByTokenHash(other.tokenHash, NOW)).toBeNull();
    for (const s of fx.B.sessions) expect(fx.repo.findAuthSessionByTokenHash(s.tokenHash, NOW)).not.toBeNull();
  });

  test("wrong current password -> INVALID_CREDENTIALS on currentPassword, counts toward lockout, nothing changes", async () => {
    const { fx, fake, service } = setup();
    const before = snapshotDatabase(fx.db, ["users"]);
    const hash = passwordHashOf(fx.db, fx.A.user.id);
    const r = await service.changePassword(fx.A.user.id, "wrong password", NEW, fx.A.sessions[0]!.id, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CREDENTIALS");
    expect(r.error.details).toEqual({
      fields: { currentPassword: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } },
    });
    expect(failedCount(fx.db, fx.A.user.id)).toBe(1);
    expect(fake.verifyCalls).toEqual([{ userId: fx.A.user.id, now: NOW }]);
    expect(passwordHashOf(fx.db, fx.A.user.id)).toBe(hash);
    expect(fake.hashCalls.count).toBe(0);
    expect(snapshotDatabase(fx.db, ["users"])).toEqual(before);
  });

  test("ACCOUNT_LOCKED passes through with retryAfterSeconds, even with the right password", async () => {
    const { fx, service } = setup();
    for (let i = 0; i < 10; i++) fx.repo.recordLoginFailure(fx.A.user.id, NOW);
    const r = await service.changePassword(fx.A.user.id, PASSWORDS.A, NEW, fx.A.sessions[0]!.id, NOW);
    expect(!r.ok && r.error.code).toBe("ACCOUNT_LOCKED");
    expect(!r.ok && r.error.details?.retryAfterSeconds).toBe(900);
  });

  test.each([
    ["7 chars", "abcdefg", "TOO_SHORT"],
    ["weak list", "password", "WEAK"],
    ["non-string", 12345678, "REQUIRED"],
  ])("new password %s -> VALIDATION_FAILED on newPassword", async (_label, next, code) => {
    const { fx, fake, service } = setup();
    const hash = passwordHashOf(fx.db, fx.A.user.id);
    const r = await service.changePassword(fx.A.user.id, PASSWORDS.A, next, fx.A.sessions[0]!.id, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION_FAILED");
    expect(r.error.details).toEqual({ fields: { newPassword: { code, message: expect.any(String) } } });
    expect(passwordHashOf(fx.db, fx.A.user.id)).toBe(hash);
    expect(fake.hashCalls.count).toBe(0);
    for (const s of fx.A.sessions) expect(fx.repo.findAuthSessionByTokenHash(s.tokenHash, NOW)).not.toBeNull();
  });

  test("policy receives the account email (local-part rule)", async () => {
    const { fx, service } = setup();
    fx.db.query("UPDATE users SET email = 'longlocalpart@example.com' WHERE id = ?").run(fx.A.user.id);
    const r = await service.changePassword(fx.A.user.id, PASSWORDS.A, "LongLocalPart", fx.A.sessions[0]!.id, NOW);
    expect(!r.ok && r.error.details).toEqual({ fields: { newPassword: { code: "WEAK", message: expect.any(String) } } });
  });

  test("new equal to current -> SAME_AS_CURRENT, nothing hashed", async () => {
    const { fx, fake, service } = setup();
    const r = await service.changePassword(fx.A.user.id, PASSWORDS.A, PASSWORDS.A, fx.A.sessions[0]!.id, NOW);
    expect(!r.ok && r.error.code).toBe("VALIDATION_FAILED");
    expect(!r.ok && r.error.details).toEqual({
      fields: { newPassword: { code: "SAME_AS_CURRENT", message: expect.any(String) } },
    });
    expect(fake.hashCalls.count).toBe(0);
  });

  test("malformed keepSessionId -> UNAUTHENTICATED before any verify (no lockout attempt burned)", async () => {
    const { fx, fake, service } = setup();
    const r = await service.changePassword(fx.A.user.id, PASSWORDS.A, NEW, "not-a-session", NOW);
    expect(!r.ok && r.error.code).toBe("UNAUTHENTICATED");
    expect(fake.verifyCalls.length).toBe(0);
  });

  test("unknown user -> NOT_FOUND", async () => {
    const { fx, service } = setup();
    const r = await service.changePassword(globalThis.crypto.randomUUID(), PASSWORDS.A, NEW, fx.A.sessions[0]!.id);
    expect(!r.ok && r.error.code).toBe("NOT_FOUND");
  });

  test("revokeOthers failure rolls the new hash back; error logged without secrets and rethrown", async () => {
    const { fx, fake, service, track } = setup({
      revokeOthers: () => {
        throw new Error("network down");
      },
    });
    const hash = passwordHashOf(fx.db, fx.A.user.id);
    await expect(service.changePassword(fx.A.user.id, PASSWORDS.A, NEW, fx.A.sessions[0]!.id, NOW)).rejects.toThrow(
      "network down",
    );
    expect(passwordHashOf(fx.db, fx.A.user.id)).toBe(hash);
    expect(fake.logs).toEqual([`"account: password change failed" {"name":"Error"}`]);
    track();
  });
});

function countWhere(db: Database, table: string, column: string, value: string): number {
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value)?.n ?? -1;
}

/** Owner rows of a bystander (B or H), helpful counts omitted (asserted separately). */
function partySnapshot(db: Database, party: Party): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { table, column } of discoverOwnerColumns(db)) {
    out[table] = db
      .query<Record<string, unknown>, [string]>(`SELECT * FROM ${table} WHERE ${column} = ?`)
      .all(party.key)
      .map((row) => JSON.stringify({ ...row, helpful_count: undefined }))
      .sort();
  }
  const orderRows = (t: string) =>
    party.orderIds.flatMap((id) =>
      db.query<Record<string, unknown>, [string]>(`SELECT * FROM ${t} WHERE order_id = ?`).all(id).map((r) => JSON.stringify(r)),
    );
  out.order_items = orderRows("order_items");
  out.order_events = orderRows("order_events");
  out.list_items = db
    .query<Record<string, unknown>, [string]>(
      "SELECT li.* FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.session_id = ?",
    )
    .all(party.key)
    .map((r) => JSON.stringify(r))
    .sort();
  return out;
}

function helpful(db: Database, table: string, id: string): number {
  return db.query<{ n: number }, [string]>(`SELECT helpful_count AS n FROM ${table} WHERE id = ?`).get(id)?.n ?? -1;
}

function ratingsMatchRecompute(db: Database): boolean {
  const bad = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM products p
        WHERE p.rating_count <> (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published')
           OR p.rating_sum <> (SELECT coalesce(SUM(rating), 0) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published')`,
    )
    .get();
  return bad?.n === 0;
}

describe("deleteAccount", () => {
  test("wrong password -> INVALID_CREDENTIALS, only failed_login_count changes (A-70)", async () => {
    const { fx, service } = setup();
    const before = snapshotDatabase(fx.db);
    const r = await service.deleteAccount(fx.A.user.id, "nope nope nope", NOW);
    expect(!r.ok && r.error.code).toBe("INVALID_CREDENTIALS");
    expect(!r.ok && r.error.details).toEqual({
      fields: { password: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } },
    });
    expect(failedCount(fx.db, fx.A.user.id)).toBe(1);
    fx.db.query("UPDATE users SET failed_login_count = 0, updated_at = ? WHERE id = ?").run(
      new Date(NOW).toISOString(),
      fx.A.user.id,
    );
    const after = snapshotDatabase(fx.db);
    expect({ ...after, users: [] }).toEqual({ ...before, users: [] });
  });

  test("missing password and unknown user", async () => {
    const { fx, service } = setup();
    const r1 = await service.deleteAccount(fx.A.user.id, undefined, NOW);
    expect(!r1.ok && r1.error.code).toBe("INVALID_CREDENTIALS");
    const r2 = await service.deleteAccount(globalThis.crypto.randomUUID(), PASSWORDS.A, NOW);
    expect(!r2.ok && r2.error.code).toBe("NOT_FOUND");
    expect(fx.repo.findUserById(fx.A.user.id)).not.toBeNull();
  });

  test("success: exact counts, anonymisation, bystanders untouched (A-71, A-73, A-74, T118 AC4/6/7)", async () => {
    const { fx, service } = setup();
    const { db, A, B, H } = fx;
    const bBefore = partySnapshot(db, B);
    const hBefore = partySnapshot(db, H);
    const rateBefore = snapshotDatabase(db).rate_limits;
    const couponsBefore = snapshotDatabase(db).coupons;
    const ordersBefore = A.orderIds.map((id) =>
      db.query<Record<string, unknown>, [string]>("SELECT * FROM orders WHERE id = ?").get(id),
    );
    const orderChildren = () =>
      A.orderIds.map((id) => [
        db.query("SELECT * FROM order_items WHERE order_id = ?").all(id),
        db.query("SELECT * FROM order_events WHERE order_id = ?").all(id),
      ]);
    const childrenBefore = orderChildren();
    const p1 = fx.products[0] as string;
    const ratingBefore = db
      .query<{ c: number; s: number }, [string]>("SELECT rating_count AS c, rating_sum AS s FROM products WHERE id = ?")
      .get(p1);
    const bReviewHelpful = helpful(db, "reviews", B.reviewIds[0]!);
    const hReviewHelpful = helpful(db, "reviews", H.reviewIds[0]!);
    const bQuestionHelpful = helpful(db, "questions", B.questionIds[0]!);
    const aQuestionHelpful = helpful(db, "questions", A.questionIds[0]!);
    const bAnswerHelpful = helpful(db, "answers", B.answerIds[0]!);

    const r = await service.deleteAccount(A.user.id, PASSWORDS.A, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected: DeletionSummary = {
      deletedRows: {
        cart_items: 2,
        carts: 1,
        list_items: 3,
        lists: 2,
        product_views: 2,
        review_votes: 2,
        question_votes: 1,
        answer_votes: 1,
        review_votes_cascaded: 1,
        reviews: 2,
        stock_alerts: 1,
        contact_messages: 1,
        addresses: 2,
        coupon_redemptions: 0,
        auth_sessions: 2,
        users: 1,
      },
      anonymisedOrders: 2,
      recomputedProducts: 2,
      anonymisedQuestions: 1,
      anonymisedAnswers: 1,
      rekeyedCouponRedemptions: 1,
    };
    expect(r.value).toEqual(expected);
    // AR1/R-1: the summary never carries the owner key or the user id.
    expect(json(r.value).includes(A.key)).toBe(false);
    expect(json(r.value).includes(A.user.id)).toBe(false);

    // No owner-keyed row carries the old key (discovered from the schema).
    for (const { table, column } of discoverOwnerColumns(db)) {
      expect({ table, n: countWhere(db, table, column, A.key) }).toEqual({ table, n: 0 });
    }
    expect(Object.values(createAccountRepository(db).countOwnedRows(A.key)).every((n) => n === 0)).toBe(true);

    // Users / sessions gone; old tokens resolve to nothing.
    expect(countWhere(db, "users", "id", A.user.id)).toBe(0);
    expect(countWhere(db, "users", "email", A.user.email)).toBe(0);
    expect(countWhere(db, "auth_sessions", "user_id", A.user.id)).toBe(0);
    for (const s of A.sessions) expect(fx.repo.findAuthSessionByTokenHash(s.tokenHash, NOW)).toBeNull();
    expect(fx.repo.findUserByOwnerKey(A.key)).toBeNull();
    expect(fx.repo.findUserByOwnerKey(DELETED_OWNER_KEY)).toBeNull();

    // Orders anonymised (R-6), everything else identical.
    A.orderIds.forEach((id, i) => {
      const row = db.query<Record<string, unknown>, [string]>("SELECT * FROM orders WHERE id = ?").get(id);
      expect(row).toEqual({
        ...ordersBefore[i],
        session_id: DELETED_OWNER_KEY,
        full_name: DELETED_MARKER,
        email: DELETED_MARKER,
        line1: DELETED_MARKER,
        city: DELETED_MARKER,
        region: DELETED_MARKER,
        postal_code: DELETED_MARKER,
        country: DELETED_MARKER,
        line2: null,
        phone: null,
        delivery_note: null,
      });
      expect(row?.total_cents).toBe(1499 + i);
      expect(row?.card_last4).toBe("4242");
      expect(row?.payment_ref).toBe(`pay_${id}`);
    });
    expect(orderChildren()).toEqual(childrenBefore);
    expect(
      db.query("SELECT coupon_code, session_id, order_id FROM coupon_redemptions WHERE order_id = ?").get(A.orderIds[0]!),
    ).toEqual({ coupon_code: "WELCOME10", session_id: DELETED_OWNER_KEY, order_id: A.orderIds[0]! });
    expect(snapshotDatabase(db).coupons).toEqual(couponsBefore);

    // Q&A anonymised (R-7); B's answer on A's question survives.
    expect(db.query("SELECT session_id, display_name, body, status FROM questions WHERE id = ?").get(A.questionIds[0]!)).toEqual({
      session_id: DELETED_OWNER_KEY,
      display_name: DELETED_MARKER,
      body: DELETED_MARKER,
      status: "published",
    });
    expect(db.query("SELECT session_id, display_name, body FROM answers WHERE id = ?").get(A.answerIds[0]!)).toEqual({
      session_id: DELETED_OWNER_KEY,
      display_name: DELETED_MARKER,
      body: DELETED_MARKER,
    });
    expect(countWhere(db, "answers", "id", B.answerIds[0]!)).toBe(1);
    expect(helpful(db, "questions", A.questionIds[0]!)).toBe(aQuestionHelpful); // B's vote stays

    // Ratings: P1 lost A's published 5-star; hidden review did not count.
    const ratingAfter = db
      .query<{ c: number; s: number }, [string]>("SELECT rating_count AS c, rating_sum AS s FROM products WHERE id = ?")
      .get(p1);
    expect(ratingAfter).toEqual({ c: ratingBefore!.c - 1, s: ratingBefore!.s - 5 });
    expect(ratingsMatchRecompute(db)).toBe(true);

    // Helpful counts of others' content voted on by A drop by exactly 1.
    expect(helpful(db, "reviews", B.reviewIds[0]!)).toBe(bReviewHelpful - 1);
    expect(helpful(db, "reviews", H.reviewIds[0]!)).toBe(hReviewHelpful - 1);
    expect(helpful(db, "questions", B.questionIds[0]!)).toBe(bQuestionHelpful - 1);
    expect(helpful(db, "answers", B.answerIds[0]!)).toBe(bAnswerHelpful - 1);

    // Bystanders, sessions of B, rate_limits: unchanged.
    // ...except B's vote on A's (deleted) review, which cascaded (counted in review_votes_cascaded).
    const bExpected = {
      ...bBefore,
      review_votes: (bBefore.review_votes ?? []).filter((row) => !A.reviewIds.some((id) => row.includes(`"${id}"`))),
    };
    expect(bBefore.review_votes?.length).toBe(1);
    expect(partySnapshot(db, B)).toEqual(bExpected);
    expect(partySnapshot(db, H)).toEqual(hBefore);
    for (const s of B.sessions) expect(fx.repo.findAuthSessionByTokenHash(s.tokenHash, NOW)).not.toBeNull();
    expect(snapshotDatabase(db).rate_limits).toEqual(rateBefore);
  });

  test("same email (different case) signs up again as a brand-new user with no old data (A-76)", async () => {
    const { fx, service } = setup();
    expect((await service.deleteAccount(fx.A.user.id, PASSWORDS.A, NOW)).ok).toBe(true);
    const again = fx.repo.createUser({ email: "  A@Example.COM ", passwordHash: fakeHash("whatever 123"), displayName: "New" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.id).not.toBe(fx.A.user.id);
    expect(again.value.ownerKey).not.toBe(fx.A.key);
    expect(again.value.ownerKey).not.toBe(DELETED_OWNER_KEY);
    for (const { table, column } of discoverOwnerColumns(fx.db)) {
      expect(countWhere(fx.db, table, column, again.value.ownerKey)).toBe(0);
    }
  });

  test("two deleted accounts that redeemed the same coupon: the tombstone keeps one redemption", async () => {
    const { fx, service } = setup();
    expect((await service.deleteAccount(fx.A.user.id, PASSWORDS.A, NOW)).ok).toBe(true);
    const r = await service.deleteAccount(fx.B.user.id, PASSWORDS.B, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rekeyedCouponRedemptions).toBe(0);
    expect(r.value.deletedRows.coupon_redemptions).toBe(1);
    expect(r.value.anonymisedOrders).toBe(2);
    expect(countWhere(fx.db, "coupon_redemptions", "session_id", fx.B.key)).toBe(0);
    expect(countWhere(fx.db, "orders", "session_id", DELETED_OWNER_KEY)).toBe(4);
    expect(ratingsMatchRecompute(fx.db)).toBe(true);
  });

  test("concurrent double delete: exactly one succeeds, the other is NOT_FOUND", async () => {
    const { fx, service } = setup();
    const [r1, r2] = await Promise.all([
      service.deleteAccount(fx.A.user.id, PASSWORDS.A, NOW),
      service.deleteAccount(fx.A.user.id, PASSWORDS.A, NOW),
    ]);
    const codes = [r1, r2].map((r) => (r.ok ? "ok" : r.error.code)).sort();
    expect(codes).toEqual(["NOT_FOUND", "ok"]);
  });

  test("user deleted between verify and transaction -> NOT_FOUND, nothing else touched", async () => {
    const fx = createFixture();
    const fake = createFakeAuth(fx.db);
    const service = createAccountService({
      ...fake.deps,
      verifyPassword: async (userId, pw, now) => {
        const r = await fake.deps.verifyPassword(userId, pw, now);
        fx.db.query("DELETE FROM users WHERE id = ?").run(userId);
        return r;
      },
    });
    const before = snapshotDatabase(fx.db, ["users", "auth_sessions"]);
    const r = await service.deleteAccount(fx.A.user.id, PASSWORDS.A, NOW);
    expect(!r.ok && r.error.code).toBe("NOT_FOUND");
    expect(snapshotDatabase(fx.db, ["users", "auth_sessions"])).toEqual(before);
  });

  // A-72 / AC3: abort on each table in turn -> full rollback.
  const failurePoints: readonly [string, "DELETE" | "UPDATE"][] = [
    ["cart_items", "DELETE"],
    ["carts", "DELETE"],
    ["list_items", "DELETE"],
    ["lists", "DELETE"],
    ["product_views", "DELETE"],
    ["review_votes", "DELETE"],
    ["question_votes", "DELETE"],
    ["answer_votes", "DELETE"],
    ["reviews", "DELETE"],
    ["stock_alerts", "DELETE"],
    ["contact_messages", "DELETE"],
    ["addresses", "DELETE"],
    ["questions", "UPDATE"],
    ["answers", "UPDATE"],
    ["orders", "UPDATE"],
    ["coupon_redemptions", "UPDATE"],
    ["products", "UPDATE"],
    ["auth_sessions", "UPDATE"],
    ["users", "DELETE"],
  ];
  test.each(failurePoints)("injected failure on %s %s rolls back everything", async (table, op) => {
    const { fx, fake, service, track } = setup();
    fx.db.run(`CREATE TRIGGER trg_inject_fail BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const before = snapshotDatabase(fx.db);
    let thrown: unknown;
    try {
      await service.deleteAccount(fx.A.user.id, PASSWORDS.A, NOW);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const text = `${String(thrown)} ${(thrown as Error).stack ?? ""}`;
    for (const secret of [PASSWORDS.A, passwordHashOf(fx.db, fx.A.user.id) ?? "x"]) expect(text.includes(secret)).toBe(false);
    expect(snapshotDatabase(fx.db)).toEqual(before);
    expect(fake.logs).toEqual([`"account: deletion failed (rolled back)" {"name":"SQLiteError","code":"SQLITE_CONSTRAINT_TRIGGER"}`]);
    track();
  });
});

describe("account repository guards", () => {
  test("OWNER_KEYED_TABLES covers every table with an owner column (I-00 discovery guard)", () => {
    const { fx } = setup();
    const discovered = discoverOwnerColumns(fx.db).map((r) => r.table).sort();
    expect(discovered).toEqual(Object.keys(OWNER_KEYED_TABLES).sort());
  });

  test("purgeOwnerData refuses the tombstone and malformed keys without touching anything", () => {
    const { fx } = setup();
    const repo = createAccountRepository(fx.db);
    const before = snapshotDatabase(fx.db);
    expect(() => repo.purgeOwnerData(DELETED_OWNER_KEY)).toThrow(RangeError);
    expect(() => repo.purgeOwnerData("seed_session_01")).toThrow(RangeError);
    expect(snapshotDatabase(fx.db)).toEqual(before);
    expect(repo.countAuthSessions("bad")).toBe(0);
    expect(Object.values(repo.countOwnedRows("bad")).every((n) => n === 0)).toBe(true);
  });

  test("countAuthSessions counts revoked and live sessions", () => {
    const { fx } = setup();
    createSession(fx.repo, fx.A.user.id);
    fx.repo.revokeAllForUser(fx.A.user.id, NOW);
    expect(createAccountRepository(fx.db).countAuthSessions(fx.A.user.id)).toBe(3);
  });
});

beforeAll(() => {
  // Sanity: the fixture is what the counts above assume.
  const fx = createFixture();
  const auth = createAuthRepository(fx.db);
  if (auth.findUserById(fx.A.user.id) === null) throw new Error("fixture broken");
});
