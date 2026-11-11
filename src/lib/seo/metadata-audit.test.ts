import { afterAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// T112 criterion 5: metadata audit of every page against the policy table.
// mock.module is process-wide in bun test: each mock spreads the real module
// and only replaces the request-bound functions.
// ---------------------------------------------------------------------------

class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND (seo audit sentinel)");
  }
}
class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT (seo audit sentinel) ${url}`);
  }
}

const emptyCookies = {
  get: (): undefined => undefined,
  has: (): boolean => false,
  getAll: (): never[] => [],
  set: (): void => undefined,
  delete: (): void => undefined,
};

const realServer = { ...(await import("next/server")) };
const realHeaders = { ...(await import("next/headers")) };
const realNavigation = { ...(await import("next/navigation")) };
const realCache = { ...(await import("next/cache")) };
mock.module("next/server", () => ({ ...realServer, connection: async (): Promise<void> => {} }));
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: async () => emptyCookies,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new NotFoundSentinel();
  },
  redirect: (url: string): never => {
    throw new RedirectSentinel(url);
  },
}));
mock.module("next/cache", () => ({ ...realCache, revalidatePath: (): void => undefined }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
const originalSiteUrl = env.NEXT_PUBLIC_SITE_URL;
env.DATABASE_PATH = ":memory:";
env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { HELP_TOPIC_SLUGS } = await import("@/content/help-topics");
const { ROUTE_POLICIES, fillRoute } = await import("./routes");
const { SITE_NAME } = await import("./site");

closeDatabase();
seedDatabase(getDatabase());

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
  if (originalSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

type Policy = (typeof ROUTE_POLICIES)[number];
type Indexing = Policy["indexing"];

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const MIN_DESCRIPTION = 70;
const MAX_DESCRIPTION = 160;
const MAX_TITLE = 60;

/** Metadata after a JSON round trip (URL objects become strings). */
interface PlainMetadata {
  readonly title?: string | { readonly absolute?: string; readonly default?: string };
  readonly description?: string;
  readonly alternates?: { readonly canonical?: string };
  readonly robots?: { readonly index?: boolean; readonly follow?: boolean } | string;
  readonly openGraph?: Readonly<Record<string, unknown>>;
  readonly twitter?: Readonly<Record<string, unknown>>;
}

interface Sample {
  readonly label: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly searchParams: Readonly<Record<string, string>>;
  readonly indexing: Indexing;
  /** Expected canonical path+query, or null for "no canonical"; undefined = only "present and absolute". */
  readonly canonicalPath: string | null | undefined;
}

interface Violation {
  readonly route: string;
  readonly sample: string;
  readonly field: string;
  readonly actual: string;
  readonly expected: string;
}

function column(sql: string): string[] {
  return getDatabase()
    .query<{ v: string }, []>(sql)
    .all()
    .map((row) => row.v);
}

const PUBLISHED_PRODUCTS = column(
  "SELECT slug AS v FROM products WHERE published_at <> '' AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY slug",
);
const CATEGORIES = column("SELECT slug AS v FROM categories ORDER BY slug");
const BRANDS = column("SELECT slug AS v FROM brands ORDER BY slug");

/** Every value the sitemap lists for an indexable dynamic route; one placeholder for private routes. */
function slugSamples(route: string): string[] {
  switch (route) {
    case "/products/[slug]":
      return PUBLISHED_PRODUCTS;
    case "/category/[slug]":
      return CATEGORIES;
    case "/brand/[slug]":
      return BRANDS;
    case "/help/[topic]":
      return [...HELP_TOPIC_SLUGS];
    case "/lists/shared/[token]":
      return ["sample-token"];
    default:
      return ["sample-id"];
  }
}

function paramName(route: string): string | undefined {
  return /\[([^\]]+)\]/.exec(route)?.[1];
}

function expectedCanonical(policy: Policy, path: string): string | null | undefined {
  switch (policy.canonical) {
    case "self":
    case "listing":
      return path;
    case "search":
      return "/search";
    case "none":
      return null;
  }
}

function samplesFor(policy: Policy): Sample[] {
  const name = paramName(policy.route);
  const slugs = name === undefined ? [""] : slugSamples(policy.route);
  const out: Sample[] = [];
  for (const slug of slugs) {
    const params: Record<string, string> = name === undefined ? {} : { [name]: slug };
    const path = name === undefined ? policy.route : fillRoute(policy.route, slug);
    out.push({
      label: path,
      path,
      params,
      searchParams: {},
      indexing: policy.indexing,
      canonicalPath: expectedCanonical(policy, path),
    });
    for (const variant of policy.variants ?? []) {
      out.push({
        label: `${path}?${new URLSearchParams(variant.sampleSearchParams).toString()}`,
        path,
        params,
        searchParams: variant.sampleSearchParams,
        indexing: variant.indexing,
        // Faceted listings point at the page-1 base; help search keeps /help.
        canonicalPath: policy.canonical === "listing" || policy.canonical === "self" ? path : undefined,
      });
    }
  }
  return out;
}

interface MetadataModule {
  readonly metadata?: unknown;
  readonly generateMetadata?: unknown;
}

async function metadataOf(file: string, sample: Sample): Promise<PlainMetadata> {
  const mod = (await import(join(PROJECT_ROOT, file))) as MetadataModule;
  let raw: unknown = mod.metadata;
  if (typeof mod.generateMetadata === "function") {
    const generate = mod.generateMetadata as (props: unknown) => unknown;
    raw = await generate({ params: Promise.resolve(sample.params), searchParams: Promise.resolve(sample.searchParams) });
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`${file} exports no metadata`);
  return JSON.parse(JSON.stringify(raw)) as PlainMetadata;
}

function titleText(m: PlainMetadata): string {
  if (typeof m.title === "string") return `${m.title} | ${SITE_NAME}`;
  return m.title?.absolute ?? m.title?.default ?? "";
}

function robotsClass(m: PlainMetadata): string {
  const robots = m.robots;
  if (robots === undefined) return "indexable";
  if (typeof robots === "string") return robots;
  if (robots.index !== false) return "indexable";
  return robots.follow === true ? "noindex-follow" : "noindex";
}

function canonicalOf(m: PlainMetadata): string | undefined {
  return m.alternates?.canonical;
}

function pathOfUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function audit(policy: Policy, sample: Sample, m: PlainMetadata, warnings: string[]): Violation[] {
  const out: Violation[] = [];
  const add = (field: string, actual: string, expected: string): void => {
    out.push({ route: policy.route, sample: sample.label, field, actual, expected });
  };

  const robots = robotsClass(m);
  if (robots !== sample.indexing) add("robots", robots, sample.indexing);

  const canonical = canonicalOf(m);
  if (sample.canonicalPath === null) {
    if (canonical !== undefined) add("canonical", canonical, "absent (private id in URL)");
    if (m.openGraph?.url !== undefined) add("openGraph.url", String(m.openGraph.url), "absent (private id in URL)");
  } else if (canonical === undefined) {
    add("canonical", "missing", sample.canonicalPath ?? "absolute URL");
  } else if (!/^https?:\/\/[^/]+/.test(canonical)) {
    add("canonical", canonical, "absolute URL");
  } else if (sample.canonicalPath !== undefined && pathOfUrl(canonical) !== sample.canonicalPath) {
    add("canonical", pathOfUrl(canonical), sample.canonicalPath);
  }

  // Content checks apply to the indexable form of indexable routes only.
  if (sample.indexing !== "indexable") return out;

  const title = titleText(m);
  if (title.length > MAX_TITLE) warnings.push(`${sample.label}: title ${title.length} chars > ${MAX_TITLE}: "${title}"`);

  const description = m.description ?? "";
  if (description.length < MIN_DESCRIPTION || description.length > MAX_DESCRIPTION) {
    add("description", `${description.length} chars: "${description}"`, `${MIN_DESCRIPTION}-${MAX_DESCRIPTION} chars`);
  }

  const og = m.openGraph;
  for (const key of ["title", "description", "url", "type", "siteName"]) {
    if (og?.[key] === undefined || og[key] === "") add(`openGraph.${key}`, "missing", "present");
  }
  if (og?.url !== undefined && canonical !== undefined && og.url !== canonical) {
    add("openGraph.url", String(og.url), canonical);
  }
  const twitter = m.twitter;
  for (const key of ["card", "title", "description"]) {
    if (twitter?.[key] === undefined || twitter[key] === "") add(`twitter.${key}`, "missing", "present");
  }
  return out;
}

/**
 * Violations in pages T112 does not own, reported to the orchestrator for
 * routing, keyed `<route pattern> <field>` (dynamic routes are audited for
 * every slug the sitemap lists). The audit fails when a NEW key appears and
 * when a listed one is fixed (so this list stays accurate).
 */
const KNOWN_VIOLATIONS: readonly string[] = [
];

const warnings: string[] = [];
const found: Violation[] = [];

function key(v: Violation): string {
  return `${v.route} ${v.field}`;
}

describe("criterion 5: page metadata vs the route policy table", () => {
  for (const policy of ROUTE_POLICIES) {
    test(`${policy.route} [${policy.indexing}]`, async () => {
      const samples = samplesFor(policy);
      expect(samples.length).toBeGreaterThan(0);
      const violations: Violation[] = [];
      for (const sample of samples) {
        violations.push(...audit(policy, sample, await metadataOf(policy.file, sample), warnings));
      }
      found.push(...violations);
      expect(violations.filter((v) => !KNOWN_VIOLATIONS.includes(key(v)))).toEqual([]);
    });
  }

  test("known-violation list is exact (no fixed entries left behind)", () => {
    const keys = new Set(found.map(key));
    expect(KNOWN_VIOLATIONS.filter((k) => !keys.has(k))).toEqual([]);
    const byKey = new Map<string, Violation[]>();
    for (const v of found) byKey.set(key(v), [...(byKey.get(key(v)) ?? []), v]);
    for (const [k, list] of byKey) {
      console.warn(`[seo audit] known violation ${k}: ${list.length} sample(s)`);
      for (const v of list.slice(0, 3)) console.warn(`  ${v.sample} | actual: ${v.actual} | expected: ${v.expected}`);
      if (list.length > 3) console.warn(`  ... and ${list.length - 3} more`);
    }
    for (const w of warnings) console.warn(`[seo audit] warn: ${w}`);
  });
});
