/**
 * Obvious passwords rejected at sign-up and password change (T116, AR3).
 *
 * Entries are lower case; the policy compares `password.toLowerCase()`, so
 * every case variant of an entry is rejected too. Most entries are at least
 * PASSWORD_MIN (8) characters, because anything shorter already fails the
 * length rule; a few famous short ones are kept for documentation value.
 * No composition rules exist (BACKLOG section 0): this list plus "password
 * equals the email or its local part" is the whole strength check.
 */

const COMMON: readonly string[] = [
  // The classics
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "password!",
  "passw0rd",
  "p@ssw0rd",
  "p@ssword",
  "pa55word",
  "iloveyou",
  "iloveyou1",
  "letmein",
  "letmein1",
  "letmein123",
  "welcome1",
  "welcome123",
  "admin123",
  "admin1234",
  "administrator",
  "changeme",
  "changeme1",
  "trustno1",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "superman",
  "starwars",
  "whatever",
  "computer",
  "internet",
  "dragon123",
  "monkey123",
  "master123",
  "shadow123",
  "michael1",
  "secret123",
  "default1",
  "login123",
  "test1234",
  "testtest",
  "abc12345",
  "abcd1234",
  "abcdefgh",
  // Digit runs and repeats
  "12345678",
  "123456789",
  "1234567890",
  "0123456789",
  "87654321",
  "11111111",
  "00000000",
  "88888888",
  "12341234",
  "11223344",
  "123123123",
  "aaaaaaaa",
  // Keyboard walks
  "qwertyui",
  "qwertyuiop",
  "qwerty12",
  "qwerty123",
  "qwer1234",
  "1234qwer",
  "1q2w3e4r",
  "1q2w3e4r5t",
  "q1w2e3r4",
  "1qaz2wsx",
  "zaq12wsx",
  "qazwsxedc",
  "asdfghjk",
  "asdfghjkl",
  "asdf1234",
  "zxcvbnm1",
  "zxcvbnma",
  // Site name variants ("Northwind Goods", SITE_NAME placeholder)
  "northwind",
  "northwind1",
  "northwind123",
  "northwindgoods",
  "northwind goods",
  "northwind2026",
  "goods123",
  "storefront",
  "storefront1",
];

const YEAR_FIRST = 1990;
const YEAR_LAST = 2026;

function yearVariants(): string[] {
  const out: string[] = [];
  for (let year = YEAR_FIRST; year <= YEAR_LAST; year++) out.push(`password${year}`);
  return out;
}

/** Lower-case set of rejected passwords (about 125 entries). */
export const WEAK_PASSWORDS: ReadonlySet<string> = new Set([...COMMON, ...yearVariants()]);
