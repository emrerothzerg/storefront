import type { Database } from "bun:sqlite";

import { createAddressService } from "@/server/addresses/address-service";
import { createStockAlertService } from "@/server/alerts/stock-alert-service";
import { createAuthRepository } from "@/server/auth/auth-repository";
import { createContactService } from "@/server/contact/contact-service";
import { createQaService } from "@/server/qa/qa-service";
import { createRecommendationService } from "@/server/recommendations/recommendation-service";
import { createReviewService } from "@/server/reviews/review-service";

/**
 * Test-only fixtures for the account page and loader tests (T98). Not
 * imported by any page. Writes go through the real services so the rows are
 * exactly what the app would store.
 */

export const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OWNER_B = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
export const UNKNOWN_OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const HOSTILE = '<img src=x onerror="alert(1)">';
export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface OwnerSpec {
  /** Unique text marker put in every user-supplied string of this owner. */
  readonly tag: string;
  /** Product viewed + reviewed + asked about. */
  readonly productId: string;
  /** Product watched while out of stock (status "Watching"). */
  readonly waitingProductId: string;
  /** Product watched and restocked (status "Back in stock", unacknowledged). */
  readonly restockedProductId: string;
}

export interface SeededOwner {
  readonly addressId: string;
  readonly reviewId: string;
  readonly questionId: string;
  readonly waitingAlertId: string;
  readonly restockedAlertId: string;
  readonly reference: string;
  readonly email: string;
  readonly fullName: string;
}

export const SPEC_A: OwnerSpec = {
  tag: "Alpha",
  productId: "prod_canvas-tote-bag",
  waitingProductId: "prod_foam-roller",
  restockedProductId: "prod_walnut-desk",
};

export const SPEC_B: OwnerSpec = {
  tag: "Bravo",
  productId: "prod_enamel-pin-set",
  waitingProductId: "prod_the-hidden-life-of-soil",
  restockedProductId: "prod_reed-diffuser-amber",
};

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }, what: string): T {
  if (!r.ok) throw new Error(`fixture ${what} failed: ${r.error.code}`);
  return r.value;
}

/** Seeds one row of every account data type for `owner`. Requires a migrated + seeded DB. */
export function seedOwner(db: Database, owner: string, spec: OwnerSpec, now: number = Date.now()): SeededOwner {
  const { tag } = spec;
  const email = `${tag.toLowerCase()}-private@example.test`;
  const fullName = `${tag} Private Person`;
  const address = must(
    createAddressService({ db }).create(
      owner,
      {
        fullName,
        email,
        line1: `1 ${tag} Street`,
        line2: "",
        city: `${tag}ville`,
        region: "CA",
        postalCode: "94110",
        country: "US",
        label: `${tag} home`,
      },
      now,
    ),
    "address",
  );
  must(createRecommendationService({ db }).recordView(owner, spec.productId, now), "recordView");
  const review = must(
    createReviewService({ db }).create(
      owner,
      { productId: spec.productId, rating: 4, title: `${tag} review ${HOSTILE}`, body: `${tag} review body is long enough.` },
      now,
    ),
    "review",
  );
  const question = must(
    createQaService({ db }).ask(owner, { productId: spec.productId, body: `${tag} question ${HOSTILE}?` }, now),
    "question",
  );
  const alerts = createStockAlertService({ db });
  const setStock = db.query<never, [number, string]>("UPDATE products SET stock = ? WHERE id = ?");
  setStock.run(0, spec.waitingProductId);
  setStock.run(0, spec.restockedProductId);
  const waiting = must(alerts.subscribe(owner, spec.waitingProductId, now), "subscribe waiting").alert;
  const restocked = must(alerts.subscribe(owner, spec.restockedProductId, now), "subscribe restocked").alert;
  setStock.run(5, spec.restockedProductId);
  const receipt = must(
    createContactService({ db }).submit(
      owner,
      { name: fullName, email, topic: "shipping", message: `${tag} message ${HOSTILE} about delivery.` },
      now,
    ),
    "contact",
  );
  return {
    addressId: address.id,
    reviewId: review.id,
    questionId: question.id,
    waitingAlertId: waiting.id,
    restockedAlertId: restocked.id,
    reference: receipt.reference,
    email,
    fullName,
  };
}

export interface SignedInFixture {
  readonly token: string;
  readonly ownerKey: string;
  readonly email: string;
  readonly displayName: string;
}

function sha256hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** A user with a live `sf_auth` token (same recipe as current-user.test.ts). */
export function createSignedInUser(db: Database, displayName: string, now: number = Date.now()): SignedInFixture {
  const repo = createAuthRepository(db);
  const email = `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const user = must(repo.createUser({ email, passwordHash: "$argon2id$v=19$fixture-hash", displayName }), "createUser");
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  must(
    repo.createAuthSession(
      { userId: user.id, tokenHash: sha256hex(token), expiresAt: new Date(now + 30 * 86_400_000).toISOString() },
      now,
    ),
    "createAuthSession",
  );
  return { token, ownerKey: user.ownerKey, email: user.email, displayName };
}

/**
 * Problems in rendered markup: hrefs that fail `isAllowedInternalHref`,
 * forbidden substrings (owner keys, emails, tokens...), UUIDs other than
 * the allowed opaque ids (R-T87-3), and live `<img onerror>` injections.
 */
export function markupViolations(
  container: HTMLElement,
  options: { readonly forbidden: readonly string[]; readonly allowedIds?: readonly string[] },
  isAllowedHref: (href: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const a of container.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!isAllowedHref(href)) problems.push(`href:${href}`);
  }
  const html = container.innerHTML;
  for (const value of options.forbidden) if (value !== "" && html.includes(value)) problems.push(`forbidden:${value}`);
  const allowed = new Set((options.allowedIds ?? []).map((id) => id.toLowerCase()));
  for (const match of html.match(UUID_RE) ?? []) if (!allowed.has(match.toLowerCase())) problems.push(`uuid:${match}`);
  if (container.querySelector("img[onerror]") !== null) problems.push("img[onerror]");
  return problems;
}
