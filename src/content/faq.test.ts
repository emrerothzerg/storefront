import { describe, expect, test } from "bun:test";
import { faqPageJsonLd } from "@/lib/seo/json-ld";
import { SITE_NAME } from "@/lib/seo/site";
import { MOCK_CARDS } from "@/server/payments/mock-payment-provider";
import { SEED_SHIPPING_METHODS } from "@/server/db/seed-data/commerce";
import { FAQ_ENTRIES, getFaqEntries, getFaqEntry, toFaqJsonLdInput } from "./faq";
import { HELP_TOPICS } from "./help-topics";
import { isAllowedInternalHref } from "./routes";

const allText = (): string =>
  FAQ_ENTRIES.map((entry) => `${entry.question} ${entry.answer.join(" ")}`).join(" ");

/** "$4.99", or "$35" for whole dollars (how the copy writes thresholds). */
function dollars(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, "0")}`;
}

describe("FAQ_ENTRIES", () => {
  test("has about 25 or more entries with unique, URL-safe slugs", () => {
    expect(FAQ_ENTRIES.length).toBeGreaterThanOrEqual(25);
    const slugs = FAQ_ENTRIES.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  test("questions and answers are non-empty plain strings", () => {
    for (const entry of FAQ_ENTRIES) {
      expect(entry.question.trim().length).toBeGreaterThan(0);
      expect(entry.question.endsWith("?")).toBe(true);
      expect(entry.answer.length).toBeGreaterThan(0);
      for (const paragraph of entry.answer) {
        expect(typeof paragraph).toBe("string");
        expect(paragraph.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("every relatedHref is an allowed internal route", () => {
    for (const entry of FAQ_ENTRIES) {
      for (const href of entry.relatedHrefs ?? []) {
        expect(isAllowedInternalHref(href), `${entry.slug}: ${href}`).toBe(true);
      }
    }
  });

  test("every entry is listed by its own topic", () => {
    for (const entry of FAQ_ENTRIES) {
      const topic = HELP_TOPICS.find((candidate) => candidate.slug === entry.topic);
      expect(topic?.faqSlugs, entry.slug).toContain(entry.slug);
    }
  });

  test("uses SITE_NAME instead of another hard-coded store name", () => {
    expect(allText()).toContain(SITE_NAME);
  });

  test("lists the mock test cards that match the payment provider", () => {
    const text = allText().replace(/ /g, "");
    for (const card of Object.values(MOCK_CARDS)) expect(text).toContain(card);
    const cards = getFaqEntry("which-test-card-numbers-can-i-use")?.answer.join(" ") ?? "";
    expect(cards).toContain("4242 4242 4242 4242: the payment succeeds");
    expect(cards).toContain("4000 0000 0000 0002: the card is declined");
    expect(cards).toContain("4000 0000 0000 9995: the payment fails for insufficient funds");
    expect(cards).toContain("4000 0000 0000 0119: the payment fails with a processing error");
  });

  test("shipping prices, threshold and day ranges match the seeded shipping methods", () => {
    const text = getFaqEntry("what-shipping-options-are-there")?.answer.join(" ") ?? "";
    for (const method of SEED_SHIPPING_METHODS) {
      expect(text).toContain(method.name);
      expect(text).toContain(dollars(method.priceCents));
      if (method.freeOverCents !== null) expect(text).toContain(`free on orders of ${dollars(method.freeOverCents)} or more`);
      if (method.minDays !== method.maxDays) expect(text).toContain(`${method.minDays} to ${method.maxDays} business days`);
    }
  });

  test("states the decided behaviour", () => {
    const text = allText();
    for (const fact of [
      "guest checkout",
      "business-day estimates",
      "Tracking is simulated",
      "within 30 minutes of placing the order while it is still processing",
      "puts the items back in stock",
      "one review per product",
      "Verified Purchase",
      "Anonymous shopper",
      "Alerts are in-app only",
      "does not collect an email address",
      "device-bound until you sign in",
      "sf_session",
      "share link",
      "Save for later",
      "mock payment",
    ]) {
      expect(text, fact).toContain(fact);
    }
  });
});

describe("accounts copy (T126)", () => {
  const ACCOUNT_SLUGS = [
    "how-do-i-create-an-account",
    "how-do-i-sign-in",
    "what-happens-to-my-guest-data-when-i-sign-in",
    "how-do-i-sign-out-everywhere",
    "how-do-i-delete-my-account",
    "i-cannot-reset-my-password",
  ];

  test("the account entries exist under the account topic", () => {
    const topic = HELP_TOPICS.find((candidate) => candidate.slug === "account");
    for (const slug of ACCOUNT_SLUGS) {
      expect(getFaqEntry(slug)?.topic, slug).toBe("account");
      expect(topic?.faqSlugs, slug).toContain(slug);
    }
  });

  test("guest data is device-bound until you sign in (T43 criterion 4, updated)", () => {
    expect(allText()).toContain("Guest data is device-bound until you sign in");
    expect(allText()).not.toContain("Your account is device-bound");
  });

  test("password reset is stated as not available and points to the contact form", () => {
    const entry = getFaqEntry("i-cannot-reset-my-password");
    const text = entry?.answer.join(" ") ?? "";
    expect(text).toContain("Password reset is not available");
    expect(text).toContain("contact form");
    expect(entry?.relatedHrefs).toContain("/contact");
  });

  test("sign-in merge, sign-out, sign out everywhere and deletion facts", () => {
    const text = (slug: string): string => getFaqEntry(slug)?.answer.join(" ") ?? "";
    expect(text("what-happens-to-my-guest-data-when-i-sign-in")).toContain("moves into your account");
    expect(text("what-happens-to-my-guest-data-when-i-sign-in")).toContain("new, empty guest session");
    expect(text("how-do-i-sign-out-everywhere")).toContain("every browser and device");
    expect(text("how-do-i-delete-my-account")).toContain("anonymised");
    expect(text("how-do-i-delete-my-account")).toContain("amounts");
    // Ruling R-7: questions/answers are anonymised as "[deleted]", not removed.
    expect(text("how-do-i-delete-my-account")).toContain("“[deleted]”");
    expect(text("how-do-i-delete-my-account")).not.toMatch(/removes[^.]*questions and answers/);
    expect(text("how-do-i-sign-in")).toContain("email or password is incorrect");
    expect(text("how-do-i-create-an-account")).toContain("8 to 128 characters");
    expect(getFaqEntry("how-do-i-delete-my-account")?.relatedHrefs).toContain("/account/settings");
  });
});

describe("getFaqEntry / getFaqEntries", () => {
  test("resolve slugs and skip unknown ones", () => {
    expect(getFaqEntry("how-do-i-cancel-an-order")?.topic).toBe("returns");
    expect(getFaqEntry("missing")).toBeUndefined();
    expect(getFaqEntries(["how-do-i-cancel-an-order", "missing", "how-do-refunds-work"]).map((e) => e.slug)).toEqual([
      "how-do-i-cancel-an-order",
      "how-do-refunds-work",
    ]);
  });
});

describe("toFaqJsonLdInput", () => {
  test("joins paragraphs with a single space and keeps the question", () => {
    const [first] = toFaqJsonLdInput([
      { slug: "x", question: "Q?", answer: ["One.", "Two."], topic: "ordering" },
    ]);
    expect(first).toEqual({ question: "Q?", answer: "One. Two." });
    expect(toFaqJsonLdInput([])).toEqual([]);
  });

  test("feeds faqPageJsonLd directly", () => {
    const doc = faqPageJsonLd(toFaqJsonLdInput(FAQ_ENTRIES));
    expect(doc["@type"]).toBe("FAQPage");
    expect(doc.mainEntity).toHaveLength(FAQ_ENTRIES.length);
    expect(doc.mainEntity[0]?.name).toBe(FAQ_ENTRIES[0]?.question ?? "");
    expect(doc.mainEntity[0]?.acceptedAnswer.text).toBe(FAQ_ENTRIES[0]?.answer.join(" ") ?? "");
  });
});
