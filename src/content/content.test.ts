import { describe, expect, test } from "bun:test";
import { FAQ_ENTRIES } from "./faq";
import { HELP_TOPICS } from "./help-topics";
import { ACCOUNT_NAV, AUTH_NAV, DEPARTMENT_NAV, FOOTER_COLUMNS, PRIMARY_NAV } from "./navigation";
import { POLICY_PAGES, SAMPLE_POLICY_NOTICE } from "./policies";
import { POPULAR_SEARCHES, SEARCH_TIPS } from "./search-help";

/** Collects every string reachable from a value. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

const CONTENT = {
  FAQ_ENTRIES,
  HELP_TOPICS,
  PRIMARY_NAV,
  ACCOUNT_NAV,
  AUTH_NAV,
  DEPARTMENT_NAV,
  FOOTER_COLUMNS,
  POLICY_PAGES,
  SAMPLE_POLICY_NOTICE,
  SEARCH_TIPS,
  POPULAR_SEARCHES,
};

describe("static content is plain text", () => {
  const strings = collectStrings(CONTENT);

  test("collects a meaningful amount of copy", () => {
    expect(strings.length).toBeGreaterThan(200);
  });

  test("no string contains < or > (no HTML)", () => {
    const offenders = strings.filter((s) => s.includes("<") || s.includes(">"));
    expect(offenders).toEqual([]);
  });

  test("no markdown links, entities, control characters or leading/trailing whitespace", () => {
    for (const s of strings) {
      expect(s, s).not.toMatch(/\]\(|&[a-z]+;|&#\d+;/i);
      expect(s, s).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(s).toBe(s.trim());
    }
  });

  test("no claims of email verification, reset by email, 2FA or social login (T126)", () => {
    const forbidden = [
      /verif(y|ied|ication)[^.]*email/i,
      /email[^.]*verif(y|ied|ication)/i,
      /confirm your email|verification (email|link|code)/i,
      /reset (link|email|code)/i,
      /(email|send)[^.]*reset/i,
      /forgot(ten)? password\?/i,
      /two-factor|2fa|two-step|authenticator|one-time code/i,
      /social (login|sign|account)|sign in with (google|facebook|apple|github|a social)|google|facebook|apple id|github/i,
      /magic link/i,
    ];
    const offenders = strings.filter((s) => forbidden.some((re) => re.test(s)));
    expect(offenders).toEqual([]);
  });

  test("no stale guest-only account claims remain", () => {
    for (const stale of ["no user accounts", "There is no sign-up", "no username or password", "Your account is device-bound", "Because there is no sign-in"]) {
      expect(strings.some((s) => s.includes(stale)), stale).toBe(false);
    }
  });
});
