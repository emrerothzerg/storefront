/**
 * Phase 2 sections of the production HTTP smoke (QA task T113). Called from `http-smoke.ts` after the
 * 61 MVP checks, against the same server and the same `./data/smoke.sqlite`.
 *
 * Section ids: P (public routes), N (real 404s), SEO (sitemap/robots/manifest/head/JSON-LD),
 * F (no-JS flows), ACC (accounts), H (hostile search), RL (rate limits), ISO (two-jar isolation),
 * XSS (escaping), FM (real POST forms), GC (no Set-Cookie on GET), LOG2 (server-log leak scan).
 */
import {
  CookieJar,
  toFormData,
  type Product,
  type Resp,
  allResponses,
  attrs,
  buttonTexts,
  count,
  decodeEntities,
  dump,
  excerpt,
  formOpen,
  forms,
  GOOD_CARD,
  h1Text,
  http,
  isRedirect,
  locFull,
  locPath,
  num,
  one,
  q,
  record,
  serializeForm,
  soft404,
  state,
  submitForm,
  tags,
  textOf,
  title,
  UUID_RE,
} from "./_lib";

// ---------------------------------------------------------------- shared helpers

const PASSWORD = "Smoke-pass-1234 horse";
const XSS = "<script>alert(1)</script>";
const XSS_RAW = "<script>alert(1)";
const XSS_ESC = "&lt;script&gt;alert(1)";
const h1Count = (html: string): number => count(html, /<h1[\s>]/g);
const titleCount = (html: string): number => count(html, /<title[\s>]/g);
const robotsMeta = (html: string): string => attrs(html.match(/<meta name="robots"[^>]*>/)?.[0] ?? "<meta>").get("content") ?? "";
const canonical = (html: string): string => attrs(html.match(/<link rel="canonical"[^>]*>/)?.[0] ?? "<link>").get("href") ?? "";
const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};
const isPost = (f: string): boolean => (formOpen(f).get("method") ?? "").toUpperCase() === "POST";
const hasButton = (re: RegExp) => (f: string): boolean => buttonTexts(f).some((t) => re.test(t));
/** A cart line (not a recommendation card) for the product: the per-line quantity control's label. */
const hasLine = (r: Resp, p: Product): boolean => textOf(r.body).includes(`Quantity for ${p.name}`);
const msgNear = (html: string, re: RegExp): string => excerpt(textOf(html).match(re)?.[0] ?? "none", 120);

/** Session/owner key a jar acts as: the user's owner_key when signed in (email given), else sf_session. */
const ownerOf = (jar: CookieJar, email?: string): string =>
  (email ? one<{ owner_key: string }>("SELECT owner_key FROM users WHERE email = ?", email)?.owner_key : undefined) ??
  jar.cookies.get("sf_session") ??
  "";

type JsonLd = Record<string, unknown>;
/** Every <script type="application/ld+json"> block parsed; `blocks` keeps per-script graphs. */
function jsonLd(html: string): { blocks: JsonLd[][]; types: string[]; errors: string[] } {
  const blocks: JsonLd[][] = [];
  const errors: string[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const v = JSON.parse(m[1] ?? "") as unknown;
      const arr = (Array.isArray(v) ? v : [v]) as JsonLd[];
      const graph = arr.flatMap((x) => (Array.isArray(x["@graph"]) ? (x["@graph"] as JsonLd[]) : [x]));
      blocks.push(graph);
    } catch (e) {
      errors.push(String(e));
    }
  }
  return { blocks, types: blocks.flat().map((x) => String(x["@type"])), errors };
}

// ---------------------------------------------------------------- fixtures

export type P2Fixtures = {
  products: Product[];
  outOfStock: Product;
  topCategory: string;
  subCategory: string;
  brand: string;
  helpTopic: string;
};

export function loadFixtures(): P2Fixtures {
  const products = q<Product>(
    "SELECT id, slug, name, price_cents, stock FROM products WHERE stock >= 20 AND published_at IS NOT NULL AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY name",
  );
  const outOfStock = q<Product>(
    "SELECT id, slug, name, price_cents, stock FROM products WHERE stock = 0 AND published_at IS NOT NULL AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY name LIMIT 1",
  )[0];
  const topCategory = one<{ slug: string }>("SELECT slug FROM categories WHERE parent_id IS NULL ORDER BY slug LIMIT 1")?.slug;
  const subCategory = one<{ slug: string }>("SELECT slug FROM categories WHERE parent_id IS NOT NULL ORDER BY slug LIMIT 1")?.slug;
  const brand = one<{ slug: string }>("SELECT slug FROM brands ORDER BY slug LIMIT 1")?.slug;
  if (products.length < 12 || !outOfStock || !topCategory || !subCategory || !brand) {
    throw new Error("seed must contain >= 12 published products with stock >= 20, one with stock 0, categories on two levels and a brand");
  }
  return { products, outOfStock, topCategory, subCategory, brand, helpTopic: "shipping" };
}

// ---------------------------------------------------------------- P: public routes

export const PUBLIC_ROUTES = (fx: P2Fixtures): string[] => [
  "/",
  "/products",
  "/deals",
  "/best-sellers",
  "/new-arrivals",
  "/top-rated",
  "/brands",
  `/brand/${fx.brand}`,
  `/category/${fx.topCategory}`,
  `/category/${fx.subCategory}`,
  `/products/${fx.products[0]?.slug ?? ""}`,
  "/search?q=lamp",
  "/help",
  `/help/${fx.helpTopic}`,
  "/faq",
  "/contact",
  "/about",
  "/shipping",
  "/returns",
  "/privacy",
  "/terms",
  "/accessibility",
  "/cart",
  "/checkout",
  "/compare",
  "/lists",
  "/orders",
  "/account",
  "/account/addresses",
  "/account/alerts",
  "/account/contributions",
  "/account/history",
  "/account/messages",
  "/signin",
  "/signup",
];

/** Cookie-less GET of every public route: status, one h1, one title, no Set-Cookie (GC01). */
export async function publicRoutes(fx: P2Fixtures): Promise<Map<string, Resp>> {
  state.section = "P";
  const pages = new Map<string, Resp>();
  const bad: string[] = [];
  const cookieSetters: string[] = [];
  let n = 0;
  for (const path of PUBLIC_ROUTES(fx)) {
    const r = await http(path, { label: `GET ${path} (cookie-less)` });
    pages.set(path, r);
    n++;
    const ok = r.status === 200 && h1Count(r.body) === 1 && titleCount(r.body) === 1 && title(r.body).length > 0;
    record(
      `P${String(n).padStart(2, "0")}`,
      `${path}: 200, exactly one <h1>, one non-empty <title>`,
      ok,
      `status ${r.status}, h1 ${h1Count(r.body)} "${excerpt(h1Text(r.body), 50)}", title ${titleCount(r.body)} "${excerpt(title(r.body), 70)}", ${(r.body.length / 1024).toFixed(1)} KiB HTML, ${r.ttfbMs.toFixed(0)} ms`,
    );
    if (!ok) bad.push(path);
    if (r.setCookies.length > 0) cookieSetters.push(`${path}: ${r.setCookies.map((c) => c.split("=")[0]).join(",")}`);
  }
  const settings = await http("/account/settings", { label: "GET /account/settings (guest)" });
  record(
    "P40",
    "guest GET /account/settings → 3xx to /signin?next=%2Faccount%2Fsettings",
    isRedirect(settings) && locFull(settings) === "/signin?next=%2Faccount%2Fsettings",
    `status ${settings.status}, Location ${settings.location}${settings.status === 307 ? " (307 = Next redirect() during render; brief said 302/303, AC 12 says 'redirects')" : ""}`,
  );
  if (settings.setCookies.length > 0) cookieSetters.push(`/account/settings: ${settings.setCookies.join(",")}`);
  record(
    "GC01",
    `no Set-Cookie on cookie-less GET of all ${pages.size + 1} routes above`,
    cookieSetters.length === 0,
    cookieSetters.join(" | ") || "none",
  );
  const p2 = await http("/products?page=2", { label: "GET /products?page=2" });
  const prev = attrs(p2.body.match(/<link rel="prev"[^>]*>/)?.[0] ?? "<link>").get("href") ?? "";
  const next = attrs(p2.body.match(/<link rel="next"[^>]*>/)?.[0] ?? "<link>").get("href") ?? "";
  record(
    "SEO20",
    '/products?page=2: <link rel="prev"> → page 1, <link rel="next"> → page 3, self canonical',
    p2.status === 200 && pathOf(prev) === "/products" && pathOf(next) === "/products?page=3" && pathOf(canonical(p2.body)) === "/products?page=2",
    `status ${p2.status}, prev ${pathOf(prev)}, next ${pathOf(next)}, canonical ${pathOf(canonical(p2.body))}`,
  );
  pages.set("/products?page=2", p2);
  return pages;
}

// ---------------------------------------------------------------- N: real 404s

export async function notFounds(): Promise<void> {
  state.section = "N";
  const cases: Array<[string, string]> = [
    ["N01", "/products/no-such-product-xyz"],
    ["N02", "/category/no-such-category-xyz"],
    ["N03", "/brand/no-such-brand-xyz"],
    ["N04", `/lists/${crypto.randomUUID()}`],
    ["N05", "/lists/not-a-uuid"],
    ["N06", `/orders/${crypto.randomUUID()}`],
    ["N07", "/orders/not-a-uuid"],
    ["N08", `/orders/${crypto.randomUUID()}/invoice`],
    ["N09", "/help/no-such-topic"],
    ["N10", "/lists/shared/not-a-real-token"],
    ["N11", "/category/%27%20OR%201%3D1%20--"],
  ];
  const shells: string[] = [];
  for (const [id, path] of cases) {
    const r = await http(path, { label: `GET ${path} (404 expected)` });
    record(id, `${path} → real 404 status (not a soft 404), noindex, no Set-Cookie`, r.status === 404 && /noindex/.test(robotsMeta(r.body)) && r.setCookies.length === 0, `${soft404(r)}, robots "${robotsMeta(r.body)}", Set-Cookie ${r.setCookies.length}, h1 ${h1Count(r.body)}${r.body.includes('id="__next_error__"') ? ", error shell" : ""}`);
    if (h1Count(r.body) !== 1 || !textOf(r.body).includes("Page not found") || r.body.includes('id="__next_error__"')) shells.push(path.split("/").slice(0, 2).join("/") || path);
  }
  const route404 = await http("/definitely-not-a-route", { label: "GET unmatched route (404 body)" });
  record(
    "N12",
    "404 body is the not-found page in the served HTML (one <h1> 'Page not found', search box, links) for in-page notFound(), as it is for an unmatched URL (known open D-T113-1, escalated to the human; not a Phase 3 regression)",
    shells.length === 0,
    `${shells.length}/${cases.length} in-page 404s serve the empty <html id="__next_error__"> shell (no <h1>, no <main>, title only; content rendered client-side): ${[...new Set(shells)].join(", ")}; unmatched URL: h1 ${h1Count(route404.body)}, error shell ${route404.body.includes('id="__next_error__"')}`,
  );
}

// ---------------------------------------------------------------- SEO

const PRIVATE_NOINDEX = [
  "/cart",
  "/checkout",
  "/compare",
  "/lists",
  "/orders",
  "/account",
  "/account/addresses",
  "/account/alerts",
  "/account/contributions",
  "/account/history",
  "/account/messages",
  "/signin",
  "/signup",
  "/contact",
  "/search?q=lamp",
];
const INDEXABLE = ["/", "/products", "/deals", "/best-sellers", "/new-arrivals", "/top-rated", "/brands", "/help", "/faq", "/about", "/shipping", "/returns", "/privacy", "/terms", "/accessibility"];

export async function seoChecks(fx: P2Fixtures, pages: Map<string, Resp>): Promise<void> {
  state.section = "SEO";
  const sm = await http("/sitemap.xml", { accept: "application/xml" });
  const smType = sm.headers.get("content-type") ?? "";
  const locs = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeEntities(m[1] ?? ""));
  record("SEO01", "/sitemap.xml 200, XML content type, <urlset> with <loc> entries", sm.status === 200 && /xml/.test(smType) && sm.body.includes("<urlset") && locs.length > 0, `status ${sm.status}, content-type ${smType}, ${locs.length} URLs`);
  const rb = await http("/robots.txt", { accept: "text/plain" });
  const rbType = rb.headers.get("content-type") ?? "";
  record("SEO02", "/robots.txt 200, text/plain", rb.status === 200 && /^text\/plain/.test(rbType), `status ${rb.status}, content-type ${rbType}`);
  const mf = await http("/manifest.webmanifest", { accept: "application/manifest+json" });
  const mfType = mf.headers.get("content-type") ?? "";
  let mfOk = false;
  try {
    const m = JSON.parse(mf.body) as Record<string, unknown>;
    mfOk = typeof m.name === "string" && typeof m.start_url === "string";
  } catch {
    mfOk = false;
  }
  record("SEO03", "/manifest.webmanifest 200, application/manifest+json, parses with name + start_url", mf.status === 200 && /application\/manifest\+json/.test(mfType) && mfOk, `status ${mf.status}, content-type ${mfType}, parsed ${mfOk}`);

  // 20 sampled sitemap URLs (spread across the list), requested against this server's origin.
  const step = Math.max(1, Math.floor(locs.length / 20));
  const sample = locs.filter((_, i) => i % step === 0).slice(0, 20);
  const sampleBad: string[] = [];
  for (const loc of sample) {
    const r = await http(pathOf(loc), { label: `GET sitemap sample ${pathOf(loc)}` });
    if (r.status !== 200) sampleBad.push(`${pathOf(loc)} ${r.status}`);
  }
  record("SEO04", `${sample.length} sampled sitemap URLs return 200`, sample.length === 20 && sampleBad.length === 0, sampleBad.join(", ") || `ok: ${sample.map(pathOf).slice(0, 6).join(" ")} …`);
  const smPaths = locs.map((l) => new URL(l).pathname);
  const forbidden = smPaths.filter((p) => /^\/(signin|signup|account|cart|checkout|orders|lists|search|compare|contact|api)(\/|$)/.test(p));
  record("SEO05", "sitemap has no private/noindex routes (/signin, /signup, /account/**, /cart, /orders, /lists, /search, /contact …)", forbidden.length === 0, forbidden.join(", ") || `clean (${locs.length} URLs; origin ${locs[0] ? new URL(locs[0]).origin : "?"})`);
  record("SEO06", "sitemap/robots absolute origin (NEXT_PUBLIC_SITE_URL)", "info", `sitemap origin ${locs[0] ? new URL(locs[0]).origin : "?"}; robots Sitemap line "${rb.body.match(/Sitemap:.*$/m)?.[0] ?? "none"}"; robots.txt and manifest are prerendered (○) at build time`);

  // robots rules
  const disallows = [...rb.body.matchAll(/^Disallow:\s*(\S+)/gim)].map((m) => m[1] ?? "");
  const blocked = (p: string): boolean => disallows.some((d) => p.startsWith(d));
  const mustAllow = ["/signin", "/signup", "/contact"];
  const mustBlock = ["/search", "/account", "/account/settings", "/cart", "/checkout", "/orders", "/lists"];
  record(
    "SEO07",
    "robots.txt: /signin /signup /contact NOT disallowed; /search /account (+ /account/settings) /cart /checkout /orders /lists disallowed",
    mustAllow.every((p) => !blocked(p)) && mustBlock.every(blocked),
    `allowed wrongly blocked [${mustAllow.filter(blocked).join(",")}], must-block not blocked [${mustBlock.filter((p) => !blocked(p)).join(",")}]; Disallow: ${disallows.join(" ")}`,
  );

  // noindex on private routes (HTML meta or X-Robots-Tag header), index on indexable ones
  const noIdxBad: string[] = [];
  for (const path of PRIVATE_NOINDEX) {
    const r = pages.get(path) ?? (await http(path));
    const hdr = r.headers.get("x-robots-tag") ?? "";
    if (!/noindex/.test(robotsMeta(r.body)) && !/noindex/.test(hdr)) noIdxBad.push(`${path} ("${robotsMeta(r.body)}")`);
  }
  record("SEO08", `noindex in served HTML or header on ${PRIVATE_NOINDEX.length} private routes`, noIdxBad.length === 0, noIdxBad.join(", ") || "all noindex");
  const idxBad: string[] = [];
  const canonBad: string[] = [];
  for (const path of INDEXABLE) {
    const r = pages.get(path) ?? (await http(path));
    if (/noindex/.test(robotsMeta(r.body)) || /noindex/.test(r.headers.get("x-robots-tag") ?? "")) idxBad.push(path);
    if (pathOf(canonical(r.body)) !== path) canonBad.push(`${path} → ${canonical(r.body) || "none"}`);
  }
  record("SEO09", `${INDEXABLE.length} indexable routes carry no noindex`, idxBad.length === 0, idxBad.join(", ") || "ok");
  record("SEO10", "served <link rel=canonical> on indexable routes is the absolute self URL", canonBad.length === 0, canonBad.join(", ") || "ok");
  const searchCanon = pathOf(canonical(pages.get("/search?q=lamp")?.body ?? ""));
  record("SEO11", "/search?q=lamp: robots noindex,follow and canonical /search?q=lamp", /noindex/.test(robotsMeta(pages.get("/search?q=lamp")?.body ?? "")) && /follow/.test(robotsMeta(pages.get("/search?q=lamp")?.body ?? "")) && searchCanon === "/search?q=lamp", `robots "${robotsMeta(pages.get("/search?q=lamp")?.body ?? "")}", canonical ${searchCanon}`);
  const faceted = await http("/products?rating=4", { label: "GET faceted /products?rating=4" });
  record("SEO12", "faceted listing /products?rating=4 → noindex,follow, canonical page-1 base", /noindex/.test(robotsMeta(faceted.body)) && /(^|[ ,])follow/.test(robotsMeta(faceted.body)) && pathOf(canonical(faceted.body)) === "/products", `robots "${robotsMeta(faceted.body)}", canonical ${pathOf(canonical(faceted.body))}`);

  // JSON-LD
  const home = pages.get("/");
  const homeLd = jsonLd(home?.body ?? "");
  const website = homeLd.blocks.flat().find((x) => x["@type"] === "WebSite");
  const action = website?.potentialAction as JsonLd | undefined;
  record(
    "SEO13",
    "layout JSON-LD parses: Organization + WebSite with SearchAction (on /)",
    homeLd.errors.length === 0 && homeLd.types.includes("Organization") && !!website && action?.["@type"] === "SearchAction",
    `types [${homeLd.types.join(", ")}], SearchAction target ${JSON.stringify((action?.target as unknown) ?? null).slice(0, 90)}, errors ${homeLd.errors.length}`,
  );
  const pdpPath = `/products/${fx.products[0]?.slug ?? ""}`;
  const pdpLd = jsonLd(pages.get(pdpPath)?.body ?? "");
  const product = pdpLd.blocks.flat().find((x) => x["@type"] === "Product");
  const offers = product?.offers as JsonLd | undefined;
  record(
    "SEO14",
    "PDP JSON-LD parses: Product (name, offers.price, priceCurrency, availability) + BreadcrumbList",
    pdpLd.errors.length === 0 && product?.name === fx.products[0]?.name && !!offers?.price && offers?.priceCurrency === "USD" && typeof offers?.availability === "string" && pdpLd.types.includes("BreadcrumbList"),
    `types [${pdpLd.types.join(", ")}], name "${String(product?.name ?? "")}", price ${String(offers?.price ?? "")} ${String(offers?.priceCurrency ?? "")}, availability ${String(offers?.availability ?? "")}`,
  );
  const listLd = jsonLd(pages.get("/products")?.body ?? "");
  const itemList = listLd.blocks.flat().find((x) => x["@type"] === "ItemList");
  const elements = (itemList?.itemListElement as JsonLd[] | undefined) ?? [];
  record(
    "SEO15",
    "listing (/products) JSON-LD parses: ItemList with ListItem positions 1..n and product URLs",
    listLd.errors.length === 0 && elements.length > 0 && elements.every((e, i) => e.position === i + 1 && /\/products\//.test(String(e.url ?? (e.item as JsonLd | undefined)?.url ?? ""))),
    `ItemList ${elements.length} elements, numberOfItems ${String(itemList?.numberOfItems ?? "")}, first ${JSON.stringify(elements[0] ?? null).slice(0, 110)}`,
  );
  const faqLd = jsonLd(pages.get("/faq")?.body ?? "");
  const faq = faqLd.blocks.flat().find((x) => x["@type"] === "FAQPage");
  const qs = (faq?.mainEntity as JsonLd[] | undefined) ?? [];
  record(
    "SEO16",
    "/faq JSON-LD parses: FAQPage with Question/acceptedAnswer entries",
    faqLd.errors.length === 0 && qs.length > 0 && qs.every((x) => x["@type"] === "Question" && !!(x.acceptedAnswer as JsonLd | undefined)?.text),
    `${qs.length} questions`,
  );
  // No page duplicates the layout's Organization/WebSite; every script parses.
  const dupBad: string[] = [];
  const parseBad: string[] = [];
  for (const [path, r] of pages) {
    if (r.status !== 200) continue;
    const ld = jsonLd(r.body);
    if (ld.errors.length) parseBad.push(path);
    const org = ld.types.filter((t) => t === "Organization").length;
    const web = ld.types.filter((t) => t === "WebSite").length;
    const prod = ld.types.filter((t) => t === "Product").length;
    if (org !== 1 || web !== 1 || prod > 1) dupBad.push(`${path} (Organization ${org}, WebSite ${web}, Product ${prod})`);
  }
  record("SEO17", `every JSON-LD block parses on ${pages.size} pages`, parseBad.length === 0, parseBad.join(", ") || "ok");
  record("SEO18", "no page JSON-LD duplicates the layout's Organization/WebSite (exactly one each per page; ≤ 1 Product)", dupBad.length === 0, dupBad.join(", ") || "ok");
  const helpPage = pages.get("/help")?.body ?? "";
  const unnamed: string[] = [];
  for (const [path, r] of pages) {
    const landmarks = tags(r.body, "form").filter((t) => t.includes('role="search"'));
    if (landmarks.length < 2) continue;
    const names = landmarks.map((t) => attrs(t).get("aria-label") ?? attrs(t).get("aria-labelledby") ?? "");
    if (names.some((nm) => !nm) || new Set(names).size !== names.length) unnamed.push(`${path} [${names.map((nm) => nm || "unnamed").join(" | ")}]`);
  }
  record(
    "SEO19",
    "pages with two role=search landmarks (header + /help search) give each a unique accessible name (T104b list)",
    unnamed.length === 0,
    `${unnamed.join(", ") || "ok"}; /help <header> inside <main>: ${/<main\b[\s\S]*<header\b[\s\S]*<\/main>/.test(helpPage)} (scoped header, not a banner landmark)`,
  );
}

// ---------------------------------------------------------------- FM: real POST forms in served HTML

export function formChecks(fx: P2Fixtures, pages: Map<string, Resp>): void {
  state.section = "FM";
  const realPost = (f: string | undefined): boolean => {
    if (!f) return false;
    const o = formOpen(f);
    return (o.get("method") ?? "").toUpperCase() === "POST" && (o.get("enctype") ?? "") === "multipart/form-data" && !/^javascript:/i.test(o.get("action") ?? "") && f.includes("$ACTION_");
  };
  const pdp = pages.get(`/products/${fx.products[0]?.slug ?? ""}`)?.body ?? "";
  const cases: Array<[string, string, string | undefined]> = [
    ["FM01", "PDP write-review form", forms(pdp).find((f) => f.includes('id="write-review"'))],
    ["FM02", "PDP ask-a-question form", forms(pdp).find((f) => /aria-label="Ask a question"/.test(f))],
    ["FM03", "/contact form", forms(pages.get("/contact")?.body ?? "").find((f) => f.includes('name="message"'))],
    ["FM04", "/signin form", forms(pages.get("/signin")?.body ?? "").find((f) => f.includes('id="signin-form"'))],
    ["FM05", "/signup form", forms(pages.get("/signup")?.body ?? "").find((f) => f.includes('id="signup-form"'))],
    ["FM06", "/account/addresses new-address form", forms(pages.get("/account/addresses")?.body ?? "").find((f) => f.includes('name="line1"'))],
  ];
  for (const [id, name, f] of cases) {
    record(id, `${name}: method=POST, enctype=multipart/form-data, $ACTION_* fields, no javascript: action`, realPost(f), f ? excerpt(f.match(/<form\b[^>]*>/)?.[0]?.replace(/class="[^"]*"/, "") ?? "", 150) : "form not found");
  }
}

/** Run at the end: no response of the whole run rendered a `javascript:` form action. */
export function javascriptActionScan(): void {
  state.section = "XSS";
  const raw = allResponses.filter(({ resp }) => resp.body.includes(XSS_RAW)).map(({ label }) => label);
  record("XSS05", `no response of the whole run contains the raw "<script>alert(1)" (${allResponses.length} responses)`, raw.length === 0, raw.slice(0, 6).join(" | ") || "clean");
  state.section = "FM";
  const hits = allResponses.filter(({ resp }) => /<form\b[^>]*\saction="javascript:/i.test(resp.body)).map(({ label }) => label);
  record("FM07", `no form with action="javascript:…" in any of ${allResponses.length} responses of the run`, hits.length === 0, hits.slice(0, 8).join(" | ") || "clean");
}

// ---------------------------------------------------------------- F: no-JS flows

export interface FlowState {
  orderPath: string | null;
  orderJar: CookieJar | null;
  listId: string | null;
  listJar: CookieJar | null;
  addressName: string;
  addressJar: CookieJar | null;
  listPageBody?: string;
  reviewPageBody?: string;
  addressPageBody?: string;
  contactBody?: string;
}

async function addToCartP2(jar: CookieJar, slug: string, qty: string, label: string): Promise<Resp | null> {
  const path = `/products/${slug}`;
  const page = await http(path, { jar, label: `GET ${path} (${label})` });
  const r = await submitForm(jar, path, page.body, (f) => f.includes('name="quantity"'), { quantity: qty }, { label: `POST add-to-cart ${slug} ×${qty} (${label})` });
  return r.post;
}

async function cartPage(jar: CookieJar, label: string): Promise<Resp> {
  return http("/cart", { jar, label: `GET /cart (${label})` });
}

export async function noJsFlows(fx: P2Fixtures, st: FlowState): Promise<void> {
  state.section = "F";
  const [pA, pB, pC, pD] = fx.products;
  if (!pA || !pB || !pC || !pD) return;
  const jar = new CookieJar();

  // F01 add to cart (v2 BuyBox form)
  const add = await addToCartP2(jar, pA.slug, "1", "S");
  const sid = jar.cookies.get("sf_session") ?? "";
  record("F01", `no-JS add to cart (${pA.slug}) → cart_items row`, !!add && add.status < 400 && UUID_RE.test(sid) && num("SELECT quantity AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", sid, pA.id) === 1, `status ${add?.status}, msg ${msgNear(add?.body ?? "", /Added \d+ to your cart\.?/)}`);
  await addToCartP2(jar, pB.slug, "2", "S");

  // F02 save for later
  let cart = await cartPage(jar, "S");
  await dump("cart-S", cart);
  const sfl = await submitForm(jar, "/cart", cart.body, (f) => f.includes(`value="${pB.id}"`) && hasButton(/^Save for later$/)(f), {}, { label: "POST save for later" });
  const savedRows = (): number =>
    num("SELECT COUNT(*) AS n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.session_id = ? AND l.kind = 'save_for_later' AND li.product_id = ?", sid, pB.id);
  record("F02", "no-JS save for later → line leaves the cart, save_for_later list row", !!sfl.post && sfl.post.status < 400 && savedRows() === 1 && num("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", sid, pB.id) === 0, sfl.form ? `status ${sfl.post?.status}, saved rows ${savedRows()}` : "form not found");

  // F03 move to cart
  cart = await cartPage(jar, "S saved");
  await dump("cart-S-saved", cart);
  const mtc = await submitForm(jar, "/cart", cart.body, (f) => f.includes(`value="${pB.id}"`) && hasButton(/move to cart/i)(f), {}, { label: "POST move to cart" });
  record("F03", "no-JS move to cart → line back in the cart, saved row gone", !!mtc.post && mtc.post.status < 400 && savedRows() === 0 && num("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", sid, pB.id) === 1, mtc.form ? `status ${mtc.post?.status}, saved rows ${savedRows()}, buttons [${buttonTexts(mtc.form).join("|")}]` : `form not found; buttons on page: ${forms(cart.body).filter(isPost).flatMap(buttonTexts).filter(Boolean).slice(0, 12).join("|")}`);

  // F05 expired coupon first (once a coupon is applied the input is replaced by the applied-coupon state)
  const bad = await submitForm(jar, "/cart", (await cartPage(jar, "S bad coupon")).body, (f) => f.includes('name="couponCode"'), { couponCode: "EXPIRED10" }, { label: "POST apply coupon EXPIRED10" });
  const couponNow = one<{ coupon_code: string | null }>("SELECT coupon_code FROM carts WHERE session_id = ?", sid)?.coupon_code ?? null;
  record("F05", "no-JS expired coupon (EXPIRED10) rejected inline, nothing stored, no 500", !!bad.post && bad.post.status === 200 && couponNow === null && /expired|not valid|invalid|no longer/i.test(textOf(bad.post.body)), bad.form ? `status ${bad.post?.status}, coupon ${couponNow}, msg ${msgNear(bad.post?.body ?? "", /[^.]{0,40}(expired|not valid|invalid|no longer)[^.]{0,40}/i)}` : "form not found");

  // F04 apply coupon
  cart = await cartPage(jar, "S coupon");
  const cp = await submitForm(jar, "/cart", cart.body, (f) => f.includes('name="couponCode"'), { couponCode: "save5" }, { label: "POST apply coupon save5" });
  const coupon = (): string | null => one<{ coupon_code: string | null }>("SELECT coupon_code FROM carts WHERE session_id = ?", sid)?.coupon_code ?? null;
  record("F04", "no-JS apply coupon (lower-case 'save5') → carts.coupon_code SAVE5, discount shown", !!cp.post && cp.post.status < 400 && coupon() === "SAVE5", cp.form ? `status ${cp.post?.status}, coupon ${coupon()}, msg ${msgNear(cp.post?.body ?? "", /(SAVE5[^.]{0,60}|coupon[^.]{0,60})/i)}` : "form not found");

  // F06 select shipping
  cart = await cartPage(jar, "S shipping");
  const sh = await submitForm(jar, "/cart", cart.body, (f) => f.includes('name="shippingMethodId"'), { shippingMethodId: "express" }, { label: "POST select shipping express" });
  const ship = (): string | null => one<{ shipping_method_id: string | null }>("SELECT shipping_method_id FROM carts WHERE session_id = ?", sid)?.shipping_method_id ?? null;
  record("F06", "no-JS select shipping (express) → carts.shipping_method_id express", !!sh.post && sh.post.status < 400 && ship() === "express", sh.form ? `status ${sh.post?.status}, method ${ship()}` : "form not found");

  // F07 checkout with coupon → /orders/<id>?placed=1
  const co = await http("/checkout", { jar, label: "GET /checkout (S)" });
  await dump("checkout-S", co);
  const ordersBefore = num("SELECT COUNT(*) AS n FROM orders WHERE session_id = ?", sid);
  const place = await submitForm(
    jar,
    "/checkout",
    co.body,
    (f) => f.includes('name="idempotencyKey"'),
    {
      addressMode: "new",
      fullName: "Grace Hopper",
      email: "grace@example.com",
      line1: "2 Compiler Lane",
      line2: "",
      city: "Arlington",
      region: "VA",
      postalCode: "22201",
      country: "US",
      phone: "",
      nameOnCard: "Grace Hopper",
      number: GOOD_CARD,
      expMonth: "12",
      expYear: "2030",
      cvc: "123",
    },
    { label: "POST checkout v2 with SAVE5 + express (S)" },
  );
  const placedPath = locPath(place.post);
  const placedFull = locFull(place.post);
  const orderRow = one<{ id: string; coupon_code: string | null; discount_cents: number; shipping_method_id: string | null; status: string }>(
    "SELECT id, coupon_code, discount_cents, shipping_method_id, status FROM orders WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    sid,
  );
  record(
    "F07",
    "no-JS checkout with coupon → 303 /orders/<uuid>?placed=1; order has SAVE5, discount, express, paid",
    isRedirect(place.post) && /^\/orders\/[0-9a-f-]{36}\?placed=1(&|$)/i.test(placedFull) && orderRow?.coupon_code === "SAVE5" && (orderRow?.discount_cents ?? 0) > 0 && orderRow?.shipping_method_id === "express" && orderRow?.status === "paid" && num("SELECT COUNT(*) AS n FROM orders WHERE session_id = ?", sid) === ordersBefore + 1,
    place.form ? `status ${place.post?.status}, Location ${place.post?.location}, order ${JSON.stringify(orderRow)}${place.post && place.post.status === 200 ? `, msg ${msgNear(place.post.body, /(Some fields[^.]*|[A-Z][^.]{0,80}invalid[^.]*)/)}` : ""}` : "checkout form not found",
  );
  if (placedPath) {
    const conf = await http(placedFull, { jar, label: "GET order ?placed=1 (S)" });
    await dump("order-placed", conf);
    record("F08", "order confirmation (?placed=1) 200 with thank-you banner, SAVE5 discount line and Express", conf.status === 200 && /thank you/i.test(textOf(conf.body)) && textOf(conf.body).includes("SAVE5") && /Express/.test(textOf(conf.body)), `status ${conf.status}, thanks ${/thank you/i.test(textOf(conf.body))}, SAVE5 ${textOf(conf.body).includes("SAVE5")}, Express ${/Express/.test(textOf(conf.body))}`);
    st.orderPath = placedPath;
    st.orderJar = jar;
    const inv = await http(`${placedPath}/invoice`, { jar, label: "GET invoice (S)" });
    record("F09", "invoice page 200 for the owner, one h1, noindex", inv.status === 200 && h1Count(inv.body) === 1 && /noindex/.test(robotsMeta(inv.body)), `status ${inv.status}, h1 ${h1Count(inv.body)}, robots "${robotsMeta(inv.body)}"`);
    const list = await http("/orders", { jar, label: "GET /orders (S)" });
    record("F10", "/orders lists the new order for its owner", list.status === 200 && list.body.includes(placedPath), `status ${list.status}, link present ${list.body.includes(placedPath)}`);

    // F11 cancel order
    const op = await http(placedPath, { jar, label: "GET order (S, cancel)" });
    await dump("order-S", op);
    const cancel = await submitForm(jar, placedPath, op.body, hasButton(/^Cancel order$/i), { confirm: "yes" }, { label: "POST cancel order (S, confirm=yes)" });
    const after = one<{ fulfillment_status: string; cancelled_at: string | null }>("SELECT fulfillment_status, cancelled_at FROM orders WHERE id = ?", orderRow?.id ?? "");
    record("F11", "no-JS cancel order (confirm checkbox ticked) → fulfillment_status cancelled, cancelled_at set", !!cancel.post && cancel.post.status < 400 && after?.fulfillment_status === "cancelled" && !!after.cancelled_at, cancel.form ? `status ${cancel.post?.status}, row ${JSON.stringify(after)}, buttons [${buttonTexts(cancel.form).join("|")}]` : `cancel form not found; buttons: ${forms(op.body).filter(isPost).flatMap(buttonTexts).filter(Boolean).join("|")}`);
  }

  // F12 buy now (fresh jar so the cart is empty)
  const jarBN = new CookieJar();
  const bnPage = await http(`/products/${pC.slug}`, { jar: jarBN, label: "GET PDP (buy now)" });
  const bn = await submitForm(jarBN, `/products/${pC.slug}`, bnPage.body, (f) => f.includes('name="quantity"') && hasButton(/buy now/i)(f), { quantity: "1" }, { submitter: (_t, text) => /buy now/i.test(text), label: "POST buy now" });
  const bnSid = jarBN.cookies.get("sf_session") ?? "";
  record("F12", "no-JS Buy Now (submitter = Buy Now button's $ACTION_REF) → redirect to /checkout, item in cart", isRedirect(bn.post) && locPath(bn.post) === "/checkout" && num("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", bnSid, pC.id) === 1, bn.form ? `status ${bn.post?.status}, Location ${bn.post?.location}, cart rows ${num("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ?", bnSid)}` : "form not found");

  // F13-F15 lists: create, add to list (PDP), remove (list page)
  const jarL = new CookieJar();
  const lists = await http("/lists", { jar: jarL, label: "GET /lists (L)" });
  const listName = `Smoke list ${XSS}`;
  const cl = await submitForm(jarL, "/lists", lists.body, (f) => f.includes('name="name"'), { name: listName }, { label: "POST create list (L)" });
  const lSid = jarL.cookies.get("sf_session") ?? "";
  const created = one<{ id: string; name: string }>("SELECT id, name FROM lists WHERE session_id = ? AND kind = 'wishlist' ORDER BY created_at DESC LIMIT 1", lSid);
  record("F13", "no-JS create list → 303 /lists/<id>?created=1, lists row", isRedirect(cl.post) && !!created && locPath(cl.post) === `/lists/${created.id}`, cl.form ? `status ${cl.post?.status}, Location ${cl.post?.location}, row ${JSON.stringify(created)}` : "form not found");
  if (created) {
    st.listId = created.id;
    st.listJar = jarL;
    const pdp = await http(`/products/${pD.slug}`, { jar: jarL, label: "GET PDP (L)" });
    const add = await submitForm(jarL, `/products/${pD.slug}`, pdp.body, (f) => f.includes('name="listId"'), { listId: created.id }, { label: "POST add to list (L)" });
    const inList = (): number => num("SELECT COUNT(*) AS n FROM list_items WHERE list_id = ? AND product_id = ?", created.id, pD.id);
    record("F14", "no-JS add to list (PDP form, listId = new list) → list_items row", !!add.post && add.post.status < 400 && inList() === 1, add.form ? `status ${add.post?.status}, rows ${inList()}` : "form not found");
    const lp = await http(`/lists/${created.id}`, { jar: jarL, label: "GET list page (L)" });
    await dump("list-L", lp);
    st.listPageBody = lp.body;
    const rm = await submitForm(jarL, `/lists/${created.id}`, lp.body, (f) => f.includes(`value="${pD.id}"`) && hasButton(/^(Remove|Delete) (?!list)/i)(f), {}, { label: "POST remove from list (L)" });
    record("F15", "no-JS remove from list → list_items row gone", !!rm.post && rm.post.status < 400 && inList() === 0, rm.form ? `status ${rm.post?.status}, rows ${inList()}` : `form not found; buttons: ${forms(lp.body).filter(isPost).flatMap(buttonTexts).filter(Boolean).slice(0, 10).join("|")}`);
  }

  // F16-F19 community: review, duplicate, vote, question
  const jarR = new CookieJar();
  const rPath = `/products/${pA.slug}`;
  let rp = await http(rPath, { jar: jarR, label: "GET PDP (R)" });
  const review = {
    rating: "4",
    title: `Smoke title ${XSS}`,
    body: `Smoke review body long enough to pass validation. ${XSS}`,
    displayName: `Smoke ${XSS}`,
  };
  const rv = await submitForm(jarR, rPath, rp.body, (f) => f.includes('id="write-review"'), review, { label: "POST review (R)" });
  const rSid = jarR.cookies.get("sf_session") ?? "";
  const myReviews = (): number => num("SELECT COUNT(*) AS n FROM reviews WHERE session_id = ? AND product_id = ?", rSid, pA.id);
  record("F16", "no-JS submit review → reviews row (published)", !!rv.post && rv.post.status < 400 && myReviews() === 1, rv.form ? `status ${rv.post?.status}, rows ${myReviews()}, msg ${msgNear(rv.post?.body ?? "", /(Thanks[^.]{0,80}|review[^.]{0,60}(posted|submitted|published)[^.]{0,30})/i)}` : "form not found");
  rp = await http(rPath, { jar: jarR, label: "GET PDP (R again)" });
  st.reviewPageBody = rp.body;
  const dupForm = forms(rp.body).find((f) => f.includes('id="write-review"'));
  const dup = dupForm
    ? await submitForm(jarR, rPath, rp.body, (f) => f.includes('id="write-review"'), review, { label: "POST duplicate review (R)" })
    : null;
  // A no-JS user can resubmit the stale form (back button / second tab): replay the first POST verbatim.
  const replay = rv.form ? await http(rPath, { jar: jarR, form: toFormData(rv.fields), label: "POST stale review form replay (R)" }) : null;
  record(
    "F17b",
    "stale write-review form replayed (same fields, same session) → rejected: still one row, 'already reviewed' message, no 500",
    !!replay && replay.status === 200 && myReviews() === 1 && /already/i.test(textOf(replay.body)),
    `status ${replay?.status}, rows ${myReviews()}, msg ${msgNear(replay?.body ?? "", /[^.]{0,40}already[^.]{0,60}/i)}`,
  );
  record(
    "F17",
    "duplicate review on the same product rejected (still one row; DUPLICATE message, or the form is replaced by an 'already reviewed' state)",
    myReviews() === 1 && (dup ? dup.post !== null && dup.post.status === 200 && /already/i.test(textOf(dup.post.body)) : /already reviewed|you reviewed|your review/i.test(textOf(rp.body))),
    dup ? `status ${dup.post?.status}, rows ${myReviews()}, msg ${msgNear(dup.post?.body ?? "", /[^.]{0,40}already[^.]{0,60}/i)}` : `no write-review form on the second visit; text: ${msgNear(rp.body, /[^.]{0,40}(already|your review)[^.]{0,60}/i)}`,
  );
  const voteForm = forms(rp.body).find((f) => f.includes('name="reviewId"') && hasButton(/^Helpful/)(f) && !f.includes("rev_smoke"));
  const reviewId = voteForm ? (serializeForm(voteForm).find(([k]) => k === "reviewId")?.[1] ?? "") : "";
  const votesBefore = num("SELECT helpful_count AS n FROM reviews WHERE id = ?", reviewId);
  const vote = voteForm
    ? await submitForm(jarR, rPath, rp.body, (f) => f.includes(`value="${reviewId}"`) && hasButton(/^Helpful/)(f), {}, { label: "POST vote helpful (R)" })
    : null;
  record("F18", "no-JS vote helpful on a review → review_votes row, helpful_count +1", !!vote?.post && vote.post.status < 400 && num("SELECT COUNT(*) AS n FROM review_votes WHERE review_id = ? AND session_id = ?", reviewId, rSid) === 1 && num("SELECT helpful_count AS n FROM reviews WHERE id = ?", reviewId) === votesBefore + 1, `review ${reviewId}, count ${votesBefore} → ${num("SELECT helpful_count AS n FROM reviews WHERE id = ?", reviewId)}, status ${vote?.post?.status}`);
  rp = await http(rPath, { jar: jarR, label: "GET PDP (R question)" });
  const qBody = `Smoke question: does it ship quickly? ${XSS}`;
  const qa = await submitForm(jarR, rPath, rp.body, (f) => /aria-label="Ask a question"/.test(f), { body: qBody, displayName: "Smoke asker" }, { label: "POST ask question (R)" });
  record("F19", "no-JS ask a question → questions row", !!qa.post && qa.post.status < 400 && num("SELECT COUNT(*) AS n FROM questions WHERE session_id = ? AND product_id = ?", rSid, pA.id) === 1, qa.form ? `status ${qa.post?.status}` : "form not found");

  // F20 stock alert on the stock-0 PDP
  const oosPath = `/products/${fx.outOfStock.slug}`;
  const op = await http(oosPath, { jar: jarR, label: "GET stock-0 PDP (R)" });
  const sa = await submitForm(jarR, oosPath, op.body, hasButton(/notify me/i), {}, { label: "POST subscribe stock alert (R)" });
  record("F20", "no-JS subscribe stock alert (stock-0 PDP) → stock_alerts row", !!sa.post && sa.post.status < 400 && num("SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ? AND product_id = ?", rSid, fx.outOfStock.id) === 1, sa.form ? `status ${sa.post?.status}, msg ${msgNear(sa.post?.body ?? "", /[^.]{0,30}(notify|watching|alert)[^.]{0,60}/i)}` : "form not found");

  // F21 save address (guest address book)
  const jarA = new CookieJar();
  const ap = await http("/account/addresses", { jar: jarA, label: "GET /account/addresses (A)" });
  st.addressName = "Katherine Johnson";
  const addr = await submitForm(
    jarA,
    "/account/addresses",
    ap.body,
    (f) => f.includes('name="line1"'),
    { fullName: st.addressName, line1: "3 Orbit Road", line2: "", city: "Hampton", region: "VA", postalCode: "23666", country: "US", label: `Home ${XSS}`, phone: "" },
    { label: "POST save address (A)" },
  );
  const aSid = jarA.cookies.get("sf_session") ?? "";
  record("F21", "no-JS save address → addresses row for the guest session", !!addr.post && addr.post.status < 400 && num("SELECT COUNT(*) AS n FROM addresses WHERE session_id = ? AND full_name = ?", aSid, st.addressName) === 1, addr.form ? `status ${addr.post?.status}, Location ${addr.post?.location ?? "-"}, msg ${msgNear(addr.post?.body ?? "", /[^.]{0,30}(saved|added)[^.]{0,40}/i)}` : "form not found");
  st.addressJar = jarA;
  const ap2 = await http("/account/addresses", { jar: jarA, label: "GET /account/addresses (A after save)" });
  st.addressPageBody = ap2.body;

  // F22 contact message
  const jarC = new CookieJar();
  const cpg = await http("/contact", { jar: jarC, label: "GET /contact (C)" });
  const before = num("SELECT COUNT(*) AS n FROM contact_messages");
  const cm = await submitForm(jarC, "/contact", cpg.body, (f) => f.includes('name="message"'), { name: "Smoke Contact", email: "contact-smoke@example.com", topic: "other", message: `Hello from the smoke test, please ignore. ${XSS}` }, { label: "POST contact (C)" });
  const ref = one<{ reference: string }>("SELECT reference FROM contact_messages ORDER BY created_at DESC LIMIT 1")?.reference ?? "";
  record("F22", "no-JS contact message → contact_messages row, reference shown in the response HTML", !!cm.post && cm.post.status < 400 && num("SELECT COUNT(*) AS n FROM contact_messages") === before + 1 && !!ref && textOf(cm.post.body).includes(ref), cm.form ? `status ${cm.post?.status}, reference ${ref}, in HTML ${!!ref && textOf(cm.post?.body ?? "").includes(ref)}` : "form not found");
  st.contactBody = cm.post?.body ?? "";

  // F23 views: cookie-less PDP GET writes nothing; a session's GET records the view server-side
  const viewsBefore = num("SELECT COUNT(*) AS n FROM product_views");
  await http(`/products/${pB.slug}`, { label: "GET PDP cookie-less (views)" });
  const viewsAfterAnon = num("SELECT COUNT(*) AS n FROM product_views");
  await http(`/products/${pD.slug}`, { jar, label: "GET PDP with session (views)" });
  const recorded = num("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ? AND product_id = ?", sid, pD.id);
  record("F23", "cookie-less PDP GET writes no product_views row; GET with a session records the view server-side (ViewTracker beacon itself needs JS)", viewsAfterAnon === viewsBefore && recorded === 1, `rows ${viewsBefore} → ${viewsAfterAnon} after cookie-less GET; session row ${recorded}`);
}

// ---------------------------------------------------------------- XSS

export async function xssChecks(fx: P2Fixtures, st: FlowState): Promise<void> {
  state.section = "XSS";
  const check = (id: string, name: string, body: string | undefined): void => {
    const b = body ?? "";
    record(id, `${name}: posted "<script>alert(1)</script>" appears escaped (&lt;script&gt;), never raw`, b.includes(XSS_ESC) && !b.includes(XSS_RAW), `escaped ${b.includes(XSS_ESC)}, raw ${b.includes(XSS_RAW)}`);
  };
  check("XSS01", "list name on /lists/<id>", st.listPageBody);
  const pdp = await http(`/products/${fx.products[0]?.slug ?? ""}`, { label: "GET PDP (xss, cookie-less)" });
  check("XSS02", "review title/body/display name + question on the PDP (cookie-less visitor)", pdp.body);
  check("XSS03", "address label on /account/addresses", st.addressPageBody);
  const contactRaw = (st.contactBody ?? "").includes(XSS_RAW);
  record("XSS04", "contact response never echoes the raw <script> string", !contactRaw, `raw ${contactRaw}, escaped ${(st.contactBody ?? "").includes(XSS_ESC)} (message body is not necessarily echoed)`);
}

// ---------------------------------------------------------------- ISO: two-jar isolation

export async function isolationChecks(st: FlowState): Promise<void> {
  state.section = "ISO";
  const other = new CookieJar();
  await addToCartP2(other, one<{ slug: string }>("SELECT slug FROM products WHERE stock >= 20 ORDER BY name DESC LIMIT 1")?.slug ?? "", "1", "ISO other");
  if (st.listId) {
    const r = await http(`/lists/${st.listId}`, { jar: other, label: "GET foreign list (ISO)" });
    record("ISO01", "another session's GET /lists/<id> → 404, no list content", r.status === 404 && !r.body.includes("Smoke list"), `${soft404(r)}, name leaked ${r.body.includes("Smoke list")}`);
    const anon = await http(`/lists/${st.listId}`, { label: "GET foreign list cookie-less (ISO)" });
    record("ISO02", "cookie-less GET /lists/<id> → 404", anon.status === 404, soft404(anon));
    const own = await http("/lists", { jar: other, label: "GET /lists (ISO other)" });
    record("ISO03", "another session's /lists does not show the list", !own.body.includes("Smoke list") && !(own.location ?? "").includes(st.listId), `status ${own.status}, Location ${own.location ?? "-"}`);
  }
  const addr = await http("/account/addresses", { jar: other, label: "GET /account/addresses (ISO other)" });
  record("ISO04", "another session's /account/addresses does not show the saved address", addr.status === 200 && !addr.body.includes(st.addressName), `status ${addr.status}, leaked ${addr.body.includes(st.addressName)}`);
  if (st.orderPath) {
    const o = await http(st.orderPath, { jar: other, label: "GET foreign order (ISO)" });
    const inv = await http(`${st.orderPath}/invoice`, { jar: other, label: "GET foreign invoice (ISO)" });
    const list = await http("/orders", { jar: other, label: "GET /orders (ISO other)" });
    record("ISO05", "another session: foreign order 404, invoice 404, not in /orders", o.status === 404 && inv.status === 404 && !list.body.includes(st.orderPath) && !o.body.includes("Grace Hopper"), `order ${o.status}, invoice ${inv.status}, listed ${list.body.includes(st.orderPath)}, name leaked ${o.body.includes("Grace Hopper") || inv.body.includes("Grace Hopper")}`);
  }
}

// ---------------------------------------------------------------- H: hostile search + suggest

export async function hostileSearch(): Promise<void> {
  state.section = "H";
  const queries = [
    '"', "'", "*", "OR", "AND", "NOT", "NEAR(", "NEAR(a b, -1)", "^", "-", '"unterminated', "a AND", "name:lamp", "products_fts:lamp",
    "{}", "()", "(((", "\u0000", "%00", "‮ lamp", "lamp​", "🧪🔥", "x".repeat(1000), XSS, "../../etc/passwd", "' OR 1=1 --",
    "\\", "%_%", "lamp*", "*lamp", "+lamp -lamp ~lamp", "a:b:c", "\u0001\u0002", "SELECT * FROM users", "a".repeat(5000),
  ].slice(0, 32);
  const fails: string[] = [];
  let i = 0;
  for (const qs of queries) {
    i++;
    const enc = encodeURIComponent(qs);
    const page = await http(`/search?q=${enc}`, { label: `GET /search hostile #${i}` });
    if (page.status >= 500) fails.push(`/search #${i} ${JSON.stringify(qs.slice(0, 20))} → ${page.status}`);
    if (page.body.includes(XSS_RAW)) fails.push(`/search #${i} raw script echoed`);
  }
  record("H01", `${queries.length} hostile /search?q= queries (FTS operators, quotes, control chars, 5,000 chars, SQL, script) never 500 and never echo raw <script>`, fails.length === 0, fails.join(" | ") || "all < 500");
  const sFails: string[] = [];
  i = 0;
  for (const qs of queries.slice(0, 20)) {
    i++;
    const r = await http(`/api/search/suggest?q=${encodeURIComponent(qs)}`, { accept: "application/json", label: `GET suggest hostile #${i}` });
    if (r.status >= 500) sFails.push(`#${i} → ${r.status}`);
  }
  record("H02", "20 hostile /api/search/suggest?q= queries never 500", sFails.length === 0, sFails.join(", ") || "all < 500");
}

export async function suggestChecks(): Promise<void> {
  state.section = "RL";
  const ok = await http("/api/search/suggest?q=lam", { accept: "application/json", label: "GET suggest lam" });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(ok.body);
  } catch {
    parsed = null;
  }
  record("RL01", "/api/search/suggest?q=lam → 200 application/json, parses, no Set-Cookie", ok.status === 200 && /application\/json/.test(ok.headers.get("content-type") ?? "") && parsed !== null && ok.setCookies.length === 0, `status ${ok.status}, type ${ok.headers.get("content-type")}, body ${excerpt(ok.body, 120)}`);
  const post = await http("/api/search/suggest?q=lam", { method: "POST", accept: "application/json", label: "POST suggest" });
  record("RL02", "POST /api/search/suggest → 405", post.status === 405, `status ${post.status}`);
  // Limit: 120 / minute per session (cookie-less callers share the "anon" bucket).
  const jar = new CookieJar();
  await addToCartP2(jar, one<{ slug: string }>("SELECT slug FROM products WHERE stock >= 20 ORDER BY name LIMIT 1 OFFSET 5")?.slug ?? "", "1", "suggest jar");
  const statuses: number[] = [];
  let first429 = -1;
  let retryAfter = "";
  for (let i = 1; i <= 130; i++) {
    const r = await http(`/api/search/suggest?q=lam${i % 3}`, { jar, accept: "application/json", label: `GET suggest flood #${i}` });
    statuses.push(r.status);
    if (r.status === 429 && first429 < 0) {
      first429 = i;
      retryAfter = r.headers.get("retry-after") ?? "";
    }
  }
  record("RL03", "suggest rate limit: 429 after 120 requests/min for one session (Retry-After header)", first429 === 121 && statuses.slice(0, 120).every((s) => s === 200), `first 429 at request ${first429}, Retry-After "${retryAfter}", statuses ${[...new Set(statuses)].join("/")}`);
}

// ---------------------------------------------------------------- RL: reviews + contact rate limits over HTTP

export async function rateLimitChecks(fx: P2Fixtures): Promise<void> {
  state.section = "RL";
  // reviews: 5 / hour per session → the 6th review (6 different products) is refused
  const jar = new CookieJar();
  const outcomes: string[] = [];
  let lastBody = "";
  for (let i = 0; i < 6; i++) {
    const p = fx.products[4 + i];
    if (!p) break;
    const path = `/products/${p.slug}`;
    const page = await http(path, { jar, label: `GET PDP (RL review ${i + 1})` });
    const r = await submitForm(jar, path, page.body, (f) => f.includes('id="write-review"'), { rating: "5", title: `Rate limit ${i + 1}`, body: "Rate-limit probe review body, long enough to be valid.", displayName: "RL tester" }, { label: `POST review ${i + 1} (RL)` });
    outcomes.push(String(r.post?.status ?? "no form"));
    lastBody = r.post?.body ?? "";
  }
  const sid = jar.cookies.get("sf_session") ?? "";
  const n = num("SELECT COUNT(*) AS n FROM reviews WHERE session_id = ?", sid);
  record("RL04", "reviews: 6 submissions from one session in an hour → 5 stored, the 6th refused with a rate-limit message (no 500)", n === 5 && /too many|try again|limit/i.test(textOf(lastBody)) && !outcomes.some((s) => Number(s) >= 500), `statuses ${outcomes.join(",")}, stored ${n}, 6th msg ${msgNear(lastBody, /[^.]{0,30}(too many|try again|limit)[^.]{0,60}/i)}`);
  // contact: 3 / hour per session
  const jarC = new CookieJar();
  const cOut: string[] = [];
  let cBody = "";
  const before = num("SELECT COUNT(*) AS n FROM contact_messages");
  for (let i = 0; i < 4; i++) {
    const page = await http("/contact", { jar: jarC, label: `GET /contact (RL ${i + 1})` });
    const r = await submitForm(jarC, "/contact", page.body, (f) => f.includes('name="message"'), { name: "RL Contact", email: "rl-contact@example.com", topic: "other", message: `Rate-limit probe message number ${i + 1}, please ignore.` }, { label: `POST contact ${i + 1} (RL)` });
    cOut.push(String(r.post?.status ?? "no form"));
    cBody = r.post?.body ?? "";
  }
  const stored = num("SELECT COUNT(*) AS n FROM contact_messages") - before;
  record("RL05", "contact: 4 messages from one session in an hour → 3 stored, the 4th refused with a rate-limit message (no 500)", stored === 3 && /too many|try again|limit/i.test(textOf(cBody)) && !cOut.some((s) => Number(s) >= 500), `statuses ${cOut.join(",")}, stored ${stored}, 4th msg ${msgNear(cBody, /[^.]{0,30}(too many|try again|limit)[^.]{0,60}/i)}`);
}

// ---------------------------------------------------------------- ACC: accounts

const authTokens: string[] = [];
export const sensitiveStrings = (): string[] => [...authTokens];

function authCookie(r: Resp | null | undefined): string {
  return r?.setCookies.find((c) => c.startsWith("sf_auth=")) ?? "";
}

async function signUp(jar: CookieJar, email: string, displayName: string): Promise<Resp | null> {
  const page = await http("/signup", { jar, label: `GET /signup (${email})` });
  const r = await submitForm(jar, "/signup", page.body, (f) => f.includes('id="signup-form"'), { displayName, email, password: PASSWORD }, { label: `POST sign-up ${email}` });
  const t = jar.cookies.get("sf_auth");
  if (t) authTokens.push(t);
  return r.post;
}

async function signIn(jar: CookieJar, email: string, password: string, label: string): Promise<Resp | null> {
  const page = await http("/signin", { jar, label: `GET /signin (${label})` });
  const r = await submitForm(jar, "/signin", page.body, (f) => f.includes('id="signin-form"'), { email, password }, { label: `POST sign-in ${label}` });
  const t = jar.cookies.get("sf_auth");
  if (t && !authTokens.includes(t)) authTokens.push(t);
  return r.post;
}

async function signOut(jar: CookieJar, label: string): Promise<Resp | null> {
  const page = await http("/account", { jar, label: `GET /account (${label} sign-out)` });
  const r = await submitForm(jar, "/account", page.body, (f) => hasButton(/^Sign out$/)(f) && serializeForm(f).every(([k]) => k.startsWith("$ACTION")), {}, { label: `POST sign-out (${label})` });
  return r.post;
}

export async function accountChecks(fx: P2Fixtures): Promise<void> {
  state.section = "ACC";
  const [pA, pB, , , , , , , , , pK] = fx.products;
  const pR = fx.products[11];
  if (!pA || !pB || !pK || !pR) return;
  const email = `smoke-user-${Date.now()}@example.com`;
  const jar1 = new CookieJar();

  // sign-up (no-JS)
  const su = await signUp(jar1, email, `Smoke ${XSS}`);
  const sa = authCookie(su);
  record("ACC01", "no-JS sign-up → 303 to /account, users row, sf_auth cookie set", isRedirect(su) && locPath(su) === "/account" && num("SELECT COUNT(*) AS n FROM users WHERE email = ?", email) === 1 && !!jar1.cookies.get("sf_auth"), `status ${su?.status}, Location ${su?.location}, sf_auth set ${!!sa}`);
  record("ACC02", "Set-Cookie sf_auth: HttpOnly, SameSite=Lax, Path=/", /;\s*HttpOnly/i.test(sa) && /;\s*SameSite=Lax/i.test(sa) && /;\s*Path=\/(;|$)/i.test(sa), excerpt(sa.replace(/^sf_auth=[^;]+/, "sf_auth=<token>"), 160));
  record("ACC03", "sf_auth attributes beyond the criteria (Secure on http://localhost, Max-Age)", "info", excerpt(sa.replace(/^sf_auth=[^;]+/, "sf_auth=<token>"), 160));
  const hashRow = one<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = ?", email);
  record("ACC04", "stored password hash is argon2id (sanity, read from the smoke DB)", (hashRow?.password_hash ?? "").startsWith("$argon2id$"), `prefix ${(hashRow?.password_hash ?? "").slice(0, 10)}`);

  // signed-in: add to cart, place an order, add another line, review
  await addToCartP2(jar1, pA.slug, "1", "U1");
  const co = await http("/checkout", { jar: jar1, label: "GET /checkout (U1)" });
  const place = await submitForm(jar1, "/checkout", co.body, (f) => f.includes('name="idempotencyKey"'), {
    addressMode: "new", fullName: "Smoke User", email, line1: "4 Account Ave", line2: "", city: "Boston", region: "MA", postalCode: "02110", country: "US", phone: "",
    nameOnCard: "Smoke User", number: GOOD_CARD, expMonth: "11", expYear: "2031", cvc: "123",
  }, { label: "POST checkout (U1)" });
  const orderPath = locPath(place.post);
  await addToCartP2(jar1, pB.slug, "2", "U1");
  const rPath = `/products/${pR.slug}`;
  const rp = await http(rPath, { jar: jar1, label: "GET PDP (U1 review)" });
  const rv = await submitForm(jar1, rPath, rp.body, (f) => f.includes('id="write-review"'), { rating: "5", title: "Signed-in smoke review", body: "Signed-in review body, long enough to pass validation." }, { label: "POST review (U1)" });
  const owner = ownerOf(jar1, email);
  record("ACC05", "signed in: order placed, second cart line, review stored under the user's owner key", /^\/orders\//.test(orderPath) && num("SELECT quantity AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", owner, pB.id) === 2 && num("SELECT COUNT(*) AS n FROM reviews WHERE session_id = ? AND product_id = ?", owner, pR.id) === 1, `order ${orderPath || "none"} (status ${place.post?.status}), cart qty ${num("SELECT quantity AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", owner, pB.id)}, review rows ${num("SELECT COUNT(*) AS n FROM reviews WHERE session_id = ? AND product_id = ?", owner, pR.id)} (status ${rv.post?.status})`);
  record("ACC06", "owner key never appears in any response so far (R-1)", !allResponses.some(({ resp }) => resp.body.includes(owner) || [...resp.headers].some(([, v]) => v.includes(owner))), `owner key ${owner.slice(0, 8)}…`);

  // R-1: a guest cookie equal to the owner key is treated as no cookie, and GETs set no cookie
  const r1 = new CookieJar();
  r1.cookies.set("sf_session", owner);
  const r1Cart = await http("/cart", { jar: r1, label: "GET /cart with sf_session = owner key (R-1)" });
  const r1Home = await http("/", { jar: r1, label: "GET / with sf_session = owner key (R-1)" });
  record("GC02", "R-1: GET /cart and / with sf_session = a user's owner key → empty guest state, no Set-Cookie", r1Cart.status === 200 && /Your cart is empty/i.test(textOf(r1Cart.body)) && r1Cart.setCookies.length === 0 && r1Home.setCookies.length === 0 && !hasLine(r1Cart, pB), `cart status ${r1Cart.status}, empty ${/Your cart is empty/i.test(textOf(r1Cart.body))}, user line leaked ${hasLine(r1Cart, pB)}, Set-Cookie ${r1Cart.setCookies.length + r1Home.setCookies.length}`);

  // sign-out (jar 1)
  const so = await signOut(jar1, "U1");
  const soAuth = authCookie(so);
  record("ACC07", "no-JS sign-out: Set-Cookie sf_auth with Max-Age=0 (or epoch Expires), sf_session rotated", !!so && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(soAuth) && !!so.setCookies.find((c) => c.startsWith("sf_session=")), `status ${so?.status}, Location ${so?.location ?? "-"}, sf_auth "${excerpt(soAuth.replace(/^sf_auth=[^;]*/, "sf_auth=<v>"), 120)}"`);
  const guestCart = await cartPage(jar1, "U1 signed out");
  record("ACC08", "after sign-out jar 1 is a guest: /cart does not show the user's cart, /account/settings redirects to /signin", !hasLine(guestCart, pB) && isRedirect(await http("/account/settings", { jar: jar1, label: "GET /account/settings (U1 signed out)" })), `user line shown ${hasLine(guestCart, pB)}`);

  // sign-in on jar 2: cart, review, order history intact
  const jar2 = new CookieJar();
  const si = await signIn(jar2, email, PASSWORD, "U1 on jar 2");
  record("ACC09", "no-JS sign-in on jar 2 → 303, sf_auth set", isRedirect(si) && !!jar2.cookies.get("sf_auth"), `status ${si?.status}, Location ${si?.location}`);
  const c2 = await cartPage(jar2, "jar 2");
  const o2 = await http("/orders", { jar: jar2, label: "GET /orders (jar 2)" });
  const contrib = await http("/account/contributions", { jar: jar2, label: "GET /account/contributions (jar 2)" });
  record(
    "ACC10",
    "jar 2: cart (2 × second item), order history (the order) and review (contributions) intact",
    hasLine(c2, pB) && !!orderPath && o2.body.includes(orderPath) && textOf(contrib.body).includes("Signed-in smoke review"),
    `cart has item ${hasLine(c2, pB)}, order listed ${!!orderPath && o2.body.includes(orderPath)}, review in contributions ${textOf(contrib.body).includes("Signed-in smoke review")}`,
  );
  const st = await http("/account/settings", { jar: jar2, label: "GET /account/settings (jar 2)" });
  record("ACC11", "signed-in /account/settings 200, one h1, noindex", st.status === 200 && h1Count(st.body) === 1 && /noindex/.test(robotsMeta(st.body)), `status ${st.status}, h1 ${h1Count(st.body)}, robots "${robotsMeta(st.body)}"`);
  const stForms = forms(st.body).filter(isPost);
  const badForms = stForms.filter((f) => (formOpen(f).get("enctype") ?? "") !== "multipart/form-data" || /^javascript:/i.test(formOpen(f).get("action") ?? ""));
  record("FM08", `/account/settings: all ${stForms.length} POST forms are real no-JS forms`, stForms.length >= 4 && badForms.length === 0, `${badForms.length} bad`);

  // Read paths never set or clear cookies, also for a signed-in visitor (SR10 / R-8).
  const signedSetters: string[] = [];
  for (const path of PUBLIC_ROUTES(fx).concat(["/account/settings"])) {
    const r = await http(path, { jar: jar2.clone(), label: `GET ${path} (signed in, jar 2)` });
    if (r.setCookies.length > 0) signedSetters.push(`${path}: ${r.setCookies.map((c) => c.split("=")[0]).join(",")}`);
  }
  record("GC03", `signed-in GET of ${PUBLIC_ROUTES(fx).length + 1} routes: no Set-Cookie`, signedSetters.length === 0, signedSetters.join(" | ") || "none");

  // sign-out-everywhere on jar 2 invalidates jar 1
  await signIn(jar1, email, PASSWORD, "U1 on jar 1 again");
  const j1Before = await http("/account/settings", { jar: jar1, label: "GET /account/settings (jar 1 before everywhere)" });
  const soe = await submitForm(jar2, "/account/settings", st.body, hasButton(/sign out of all devices/i), {}, { label: "POST sign out everywhere (jar 2)" });
  const j1After = await http("/account/settings", { jar: jar1, label: "GET /account/settings (jar 1 after everywhere)" });
  const j2After = await http("/account/settings", { jar: jar2, label: "GET /account/settings (jar 2 after everywhere)" });
  const revokedReads: string[] = [];
  for (const path of ["/", "/account", "/cart", "/account/settings"]) {
    const r = await http(path, { jar: jar1.clone(), label: `GET ${path} (revoked sf_auth)` });
    if (r.setCookies.length > 0) revokedReads.push(`${path}: ${r.setCookies.join(",")}`);
  }
  record("GC04", "GET with a revoked sf_auth (jar 1 after sign-out-everywhere): treated as signed out, no Set-Cookie (read paths never clear cookies, R-8)", revokedReads.length === 0, revokedReads.join(" | ") || "none");
  record(
    "ACC12",
    "sign-out-everywhere on jar 2 → jar 1's session revoked (/account/settings redirects to /signin), jar 2 signed out too (R-2)",
    j1Before.status === 200 && !!soe.post && isRedirect(j1After) && locPath(j1After) === "/signin" && isRedirect(j2After),
    `jar1 before ${j1Before.status}, POST ${soe.post?.status} (Set-Cookie ${soe.post?.setCookies.map((c) => c.split(";")[0]?.split("=")[0] + (/Max-Age=0/i.test(c) ? "(cleared)" : "(set)")).join(",") ?? "-"}), jar1 after ${j1After.status} → ${j1After.location}, jar2 after ${j2After.status}; revoked rows ${num("SELECT COUNT(*) AS n FROM auth_sessions a JOIN users u ON u.id = a.user_id WHERE u.email = ? AND a.revoked_at IS NOT NULL", email)}`,
  );

  // wrong password vs unknown email: identical responses
  const jw = new CookieJar();
  const ju = new CookieJar();
  const wrong = await signIn(jw, email, "Wrong-password-123", "wrong password");
  const unknownEmail = `nobody-${Date.now()}@example.com`;
  const unknown = await signIn(ju, unknownEmail, "Wrong-password-123", "unknown email");
  const norm = (r: Resp | null, e: string): string => textOf(r?.body ?? "").split(e).join("<email>");
  const sameText = norm(wrong, email) === norm(unknown, unknownEmail);
  record(
    "ACC13",
    "wrong password vs unknown email: same status, same visible HTML text (email masked), same Set-Cookie names, message 'Email or password is incorrect'",
    !!wrong && !!unknown && wrong.status === unknown.status && sameText && /Email or password is incorrect/.test(textOf(wrong.body)) && wrong.setCookies.map((c) => c.split("=")[0]).join() === unknown.setCookies.map((c) => c.split("=")[0]).join(),
    `statuses ${wrong?.status}/${unknown?.status}, same text ${sameText}, cookies [${wrong?.setCookies.map((c) => c.split("=")[0]).join()}] / [${unknown?.setCookies.map((c) => c.split("=")[0]).join()}]`,
  );
  record("ACC14", "wrong-password vs unknown-email timing (server-side dummy argon2 verify)", "info", `${wrong?.ttfbMs.toFixed(0)} ms vs ${unknown?.ttfbMs.toFixed(0)} ms`);

  // lockout: 11 rapid wrong-password attempts for a fresh account from one jar
  const lockEmail = `smoke-lock-${Date.now()}@example.com`;
  await signUp(new CookieJar(), lockEmail, "Lock Tester");
  const jl = new CookieJar();
  const msgs: string[] = [];
  let last: Resp | null = null;
  for (let i = 1; i <= 11; i++) {
    last = await signIn(jl, lockEmail, `Wrong-password-${i}x`, `lockout #${i}`);
    msgs.push(/Too many attempts/.test(textOf(last?.body ?? "")) ? "TOO_MANY" : /Email or password is incorrect/.test(textOf(last?.body ?? "")) ? "INVALID" : String(last?.status));
  }
  const good = await signIn(jl, lockEmail, PASSWORD, "lockout correct password");
  record(
    "ACC15",
    "11th rapid wrong-password attempt → 'Too many attempts. Try again in N minutes.'; correct password also refused while locked; no sf_auth issued",
    msgs[10] === "TOO_MANY" && /Too many attempts\. Try again in \d+ minutes?\./.test(textOf(last?.body ?? "")) && /Too many attempts/.test(textOf(good?.body ?? "")) && !jl.cookies.get("sf_auth"),
    `sequence ${msgs.join(",")}; correct-password attempt: ${msgNear(good?.body ?? "", /Too many attempts[^.]*\.[^.]*\./)}`,
  );
  const lockedUnknown = new CookieJar();
  const lu: string[] = [];
  const ghost = `ghost-${Date.now()}@example.com`;
  for (let i = 1; i <= 11; i++) {
    const r = await signIn(lockedUnknown, ghost, `Wrong-password-${i}x`, `unknown lockout #${i}`);
    lu.push(/Too many attempts/.test(textOf(r?.body ?? "")) ? "TOO_MANY" : /Email or password is incorrect/.test(textOf(r?.body ?? "")) ? "INVALID" : String(r?.status));
  }
  record("ACC16", "unknown email: the same 11-attempt sequence is indistinguishable (R-10)", lu.join() === msgs.join(), `known ${msgs.join(",")} | unknown ${lu.join(",")}`);

  // noindex + sitemap for auth routes is covered by SEO05/SEO08; record the explicit AC 12 line.
  const signinPage = await http("/signin", { label: "GET /signin (AC12)" });
  const signupPage = await http("/signup", { label: "GET /signup (AC12)" });
  record("ACC17", "/signin, /signup, /account/settings carry noindex (AC 12; sitemap exclusion in SEO05)", /noindex/.test(robotsMeta(signinPage.body)) && /noindex/.test(robotsMeta(signupPage.body)) && /noindex/.test(robotsMeta(st.body)), `signin "${robotsMeta(signinPage.body)}", signup "${robotsMeta(signupPage.body)}", settings "${robotsMeta(st.body)}"`);

  // open redirect guard on ?next=
  const evil = new CookieJar();
  const evilPage = await http("/signin?next=%2F%2Fevil.example%2F", { jar: evil, label: "GET /signin?next=//evil" });
  const evilPost = await submitForm(evil, "/signin?next=%2F%2Fevil.example%2F", evilPage.body, (f) => f.includes('id="signin-form"'), { email, password: PASSWORD }, { label: "POST sign-in next=//evil" });
  record("ACC18", "sign-in with ?next=//evil.example/ never redirects off-site", !isRedirect(evilPost.post) || (!/evil\.example/.test(evilPost.post?.location ?? "") && (evilPost.post?.location ?? "").startsWith("/")), `status ${evilPost.post?.status}, Location ${evilPost.post?.location ?? "-"}`);
  const t = evil.cookies.get("sf_auth");
  if (t) authTokens.push(t);
}
