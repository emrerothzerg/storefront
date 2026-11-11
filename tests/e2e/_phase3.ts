/**
 * Phase 3 (visual redesign) sections of the production HTTP smoke (QA task T175). Called from
 * `http-smoke.ts` after the Phase 2 sections, against the same server and `./data/smoke.sqlite`.
 *
 * Section ids:
 *   BR  brand-free + brand present (retailer/payment/social/membership/app/copy words built at run time)
 *   LT  light-only (served HTML + served CSS; theme-color = the primary raw value read from globals.css)
 *   ST  structure per tests/redesign/CONTRACTS.md (global G rows, home H rows, listing L rows, PDP P rows)
 *   NJ3 no-JS replays (quick add, filter GET keeps sort, hero dot anchors, tabs) + cookies-disabled AC4
 *   SD  seed sanity (sitemap count vs DB, future-dated products, /new-arrivals "New", /deals >= 40, OOS PDP)
 *   LD3 JSON-LD on Phase 3 pages
 *   GC3 no Set-Cookie on Phase 3 GETs
 *   SZ  served HTML / referenced JS sizes and TTFB (INFO)
 *
 * Forbidden words are assembled at run time so this file never contains them as literals (guards G01/G02
 * scan src/ and public/ only, but the habit keeps grep-based audits clean).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CookieJar,
  type Resp,
  ROOT,
  attrs,
  count,
  decodeEntities,
  excerpt,
  formOpen,
  forms,
  h1Text,
  htmlOnly,
  http,
  isRedirect,
  locPath,
  num,
  one,
  q,
  record,
  serializeForm,
  state,
  submitForm,
  tags,
  textOf,
  title,
} from "./_lib";

// ---------------------------------------------------------------- vocabulary (built at run time)

const j = (...p: string[]): string => p.join("");
type Word = { label: string; re: RegExp };
const word = (src: string, flags = "i"): RegExp => new RegExp(`\\b${src}\\b`, flags);
const WORDS: readonly Word[] = [
  { label: j("k", "mart"), re: word(j("k", "mart")) },
  { label: j("one", "pass"), re: word(j("one", "\\s?", "pass")) },
  { label: j("an", "ko"), re: word(j("an", "ko")) },
  { label: j("J", "oy"), re: word(j("J", "oy"), "") },
  { label: j("Tar", "get"), re: word(j("Tar", "get"), "") },
  { label: j("u", "ber"), re: word(j("u", "ber")) },
  { label: j("after", "pay"), re: word(j("after", "pay")) },
  { label: j("zip", " pay"), re: word(j("zip", " pay")) },
  { label: j("pay", "pal"), re: word(j("pay", "pal")) },
  { label: j("kla", "rna"), re: word(j("kla", "rna")) },
  { label: j("apple", " pay"), re: word(j("apple", " pay")) },
  { label: j("google", " pay"), re: word(j("google", " pay")) },
  { label: j("vi", "sa"), re: word(j("vi", "sa")) },
  { label: j("master", "card"), re: word(j("master", "card")) },
  { label: j("american", " express"), re: word(j("american", " express")) },
  { label: j("am", "ex"), re: word(j("am", "ex")) },
  { label: "pay in 4", re: word(j("pay", " in 4")) },
  { label: j("face", "book"), re: word(j("face", "book")) },
  { label: j("insta", "gram"), re: word(j("insta", "gram")) },
  { label: j("twit", "ter"), re: word(j("twit", "ter")) },
  { label: j("tik", "tok"), re: word(j("tik", "tok")) },
  { label: j("you", "tube"), re: word(j("you", "tube")) },
  { label: j("pin", "terest"), re: word(j("pin", "terest")) },
  { label: j("linked", "in"), re: word(j("linked", "in")) },
  { label: j("member", "ship"), re: word(j("member", "ships?")) },
  { label: j("member", "s"), re: word(j("member", "s?")) },
  { label: j("loy", "alty"), re: word(j("loy", "alty")) },
  { label: j("re", "wards"), re: word(j("re", "wards?")) },
  { label: j("news", "letter"), re: word(j("news", "letters?")) },
  { label: "subscribe to our", re: word(j("subscribe", " to our")) },
  { label: j("app", " store"), re: word(j("app", " store")) },
  { label: j("google", " play"), re: word(j("google", " play")) },
  { label: "download the app", re: word(j("download", " the app")) },
  { label: "low prices", re: word(j("low", " prices")) },
  { label: "delivered faster", re: word(j("delivered", " faster")) },
  { label: "click and collect", re: new RegExp(j("click", "\\s*(&|and)\\s*", "collect"), "i") },
  { label: "same day", re: word(j("same", " day")) },
  { label: j("cata", "logue"), re: word(j("cata", "logues?")) },
];
const BRAND = "Northwind Goods";
const DARK_CLASS = new RegExp(j("(^|[\\s\"'`])", "da", "rk:[a-z]"));
const PCS = j("prefers-", "color-scheme");
const DATA_THEME = j("data-", "theme");
const TOGGLE_NAME = new RegExp(j("\\b(the", "me|da", "rk mode|li", "ght mode)\\b"), "i");

// ---------------------------------------------------------------- HTML helpers

const h1Count = (html: string): number => count(html, /<h1[\s>]/g);
const canonical = (html: string): string => attrs(html.match(/<link rel="canonical"[^>]*>/)?.[0] ?? "<link>").get("href") ?? "";
const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

/** Inner HTML of the first element whose open tag matches `openRe`, by tag-depth counting. */
function elementAt(html: string, start: number): string {
  const open = html.slice(start).match(/^<([a-zA-Z0-9]+)/);
  if (!open) return "";
  const name = open[1] ?? "";
  const re = new RegExp(`<${name}\\b[^>]*?(/?)>|</${name}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].startsWith("</")) depth--;
    else if (m[1] !== "/") depth++;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}
const elementBy = (html: string, openRe: RegExp): string => {
  const idx = html.search(openRe);
  return idx < 0 ? "" : elementAt(html, idx);
};
/** Top-level <li> children of the list element `listHtml` (which starts with its own open tag). */
function topLevelItems(listHtml: string): string[] {
  const out: string[] = [];
  const inner = listHtml.replace(/^<[^>]+>/, "");
  let i = 0;
  while (i < inner.length) {
    const next = inner.slice(i).search(/<li\b/);
    if (next < 0) break;
    const li = elementAt(inner, i + next);
    out.push(li);
    i = i + next + Math.max(li.length, 1);
  }
  return out;
}
const mainOf = (html: string): string => elementBy(htmlOnly(html), /<main\b/);
const headingsIn = (html: string): number[] => [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
const textIn = (fragment: string): string => decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Accessible names of every <nav> (aria-label, or the text of the aria-labelledby target). */
function navNames(html: string): string[] {
  const body = htmlOnly(html);
  return tags(body, "nav").map((t) => {
    const a = attrs(t);
    if (a.get("aria-label")) return a.get("aria-label") ?? "";
    const by = a.get("aria-labelledby");
    if (by) {
      const target = elementBy(body, new RegExp(`<[a-zA-Z0-9]+\\b[^>]*\\sid="${by.replace(/[^\w-]/g, "")}"`));
      return textIn(target);
    }
    return "";
  });
}

/** Visible text plus aria-label/alt/title/placeholder values of the server HTML (scripts removed). */
function scanText(html: string): string {
  const body = htmlOnly(html);
  const attrText = [...body.matchAll(/\s(?:aria-label|alt|title|placeholder)="([^"]*)"/g)].map((m) => decodeEntities(m[1] ?? "")).join(" ");
  return `${textOf(html)} ${attrText} ${title(html)}`;
}

type JsonLd = Record<string, unknown>;
function jsonLd(html: string): { types: string[]; errors: string[]; nodes: JsonLd[] } {
  const nodes: JsonLd[] = [];
  const errors: string[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const v = JSON.parse(m[1] ?? "") as unknown;
      const arr = (Array.isArray(v) ? v : [v]) as JsonLd[];
      nodes.push(...arr.flatMap((x) => (Array.isArray(x["@graph"]) ? (x["@graph"] as JsonLd[]) : [x])));
    } catch (e) {
      errors.push(String(e));
    }
  }
  return { types: nodes.map((x) => String(x["@type"])), errors, nodes };
}

/** Primary raw colour value: `--accent` in the top-level `:root` of globals.css (read at run time). */
function primaryRaw(): string {
  const css = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return (css.match(/^\s*--accent:\s*([^;]+);/m)?.[1] ?? "").trim().toLowerCase();
}

/** Every `/_next/static/**.js` referenced by a page, with its size on disk. */
function jsRefs(html: string): { n: number; kib: number } {
  const srcs = new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1] ?? ""));
  let bytes = 0;
  for (const s of srcs) {
    try {
      bytes += statSync(join(ROOT, ".next", s.replace(/^\/_next\//, ""))).size;
    } catch {
      /* not on disk: ignore */
    }
  }
  return { n: srcs.size, kib: bytes / 1024 };
}

// ---------------------------------------------------------------- fixtures

export type P3Fixtures = {
  dept: string;
  brand: string;
  pdp: { id: string; slug: string; name: string };
  oos: { id: string; slug: string; name: string };
  published: number;
  total: number;
  future: string[];
};

export function loadFixtures3(): P3Fixtures {
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const dept = one<{ slug: string }>("SELECT slug FROM categories WHERE parent_id IS NULL ORDER BY slug LIMIT 1")?.slug ?? "";
  const brand = one<{ slug: string }>("SELECT slug FROM brands ORDER BY slug LIMIT 1")?.slug ?? "";
  const pdp = one<{ id: string; slug: string; name: string }>(
    `SELECT id, slug, name FROM products WHERE stock >= 20 AND list_price_cents > price_cents AND published_at <= ${now} ORDER BY name LIMIT 1`,
  );
  const oos = one<{ id: string; slug: string; name: string }>(`SELECT id, slug, name FROM products WHERE stock = 0 AND published_at <= ${now} ORDER BY name LIMIT 1`);
  const published = num(`SELECT COUNT(*) AS n FROM products WHERE published_at <= ${now}`);
  const total = num("SELECT COUNT(*) AS n FROM products");
  const future = q<{ slug: string }>(`SELECT slug FROM products WHERE published_at > ${now} ORDER BY slug`).map((r) => r.slug);
  if (!dept || !brand || !pdp || !oos) throw new Error("Phase 3 fixtures: need a department, a brand, a discounted in-stock product and an out-of-stock product");
  return { dept, brand, pdp, oos, published, total, future };
}

// ---------------------------------------------------------------- main entry

const HOME_ORDER = [
  "home-hero",
  "home-categories",
  "home-shipping-promo",
  "home-discovery",
  "home-lifestyle-banner",
  "top-picks",
  "home-lifestyle-cards",
  "home-lifestyle-make-room",
  "home-popular-searches",
  "home-promo-pair",
  "home-recently-viewed",
  "home-brands",
  "home-services",
];
const TABS: Array<[string, string]> = [
  ["Best sellers", "/?rail=best-sellers#top-picks"],
  ["Deals", "/?rail=deals#top-picks"],
  ["New arrivals", "/?rail=new-arrivals#top-picks"],
  ["Top rated", "/?rail=top-rated#top-picks"],
];
const PASSWORD = "Smoke-pass-1234 horse";

type Page = { label: string; path: string; resp: Resp; signedIn: boolean };

/** Home section ids in document order (elements carrying one of the contract ids inside <main>). */
const homeIds = (html: string): string[] =>
  [...mainOf(html).matchAll(/<[a-z]+\b[^>]*\sid="([^"]+)"/g)].map((m) => m[1] ?? "").filter((id) => HOME_ORDER.includes(id));
const sectionById = (html: string, id: string): string => elementBy(mainOf(html), new RegExp(`<[a-z]+\\b[^>]*\\sid="${id}"`));
const currentTab = (html: string): string => {
  const nav = elementBy(htmlOnly(html), /<nav aria-label="Top picks lists"/);
  const a = tags(nav, "a").find((t) => /aria-current="page"/.test(t));
  return a ? (attrs(a).get("href") ?? "") : "";
};
const productHrefs = (fragment: string): string[] => [...new Set([...fragment.matchAll(/href="(\/products\/[^"#?]+)"/g)].map((m) => m[1] ?? ""))];

export async function phase3(fx: P3Fixtures): Promise<void> {
  state.section = "ST";
  const pages: Page[] = [];
  const get = async (label: string, path: string, jar?: CookieJar): Promise<Resp> => {
    const resp = await http(path, { jar: jar?.clone(), label: `GET ${path} (P3 ${label})` });
    pages.push({ label, path, resp, signedIn: !!jar });
    return resp;
  };

  // ---- signed-in jar (no-JS sign-up), quick-add jar (filled cart)
  const email = `p3-smoke-${Date.now()}@example.com`;
  const userJar = new CookieJar();
  const su = await http("/signup", { jar: userJar, label: "GET /signup (P3 user)" });
  const sup = await submitForm(userJar, "/signup", su.body, (f) => f.includes('id="signup-form"'), { displayName: "Phase Three", email, password: PASSWORD }, { label: "POST sign-up (P3 user)" });
  const signedIn = !!userJar.cookies.get("sf_auth") && isRedirect(sup.post);

  // ---- pages
  const home = await get("home guest", "/");
  await http(`/products/${fx.pdp.slug}`, { jar: userJar, label: "GET PDP (P3 user view, for recently viewed)" });
  const homeUser = await get("home signed in", "/", userJar);
  const products = await get("products", "/products");
  const products2 = await get("products page 2", "/products?page=2");
  const productsFacet = await get("products facet", `/products?brand=${encodeURIComponent(fx.brand)}`);
  const category = await get("category", `/category/${fx.dept}`);
  const brand = await get("brand", `/brand/${fx.brand}`);
  const search = await get("search", "/search?q=desk");
  const searchZero = await get("search zero", "/search?q=zzzzzz");
  const pdp = await get("pdp", `/products/${fx.pdp.slug}`);
  const oos = await get("pdp out of stock", `/products/${fx.oos.slug}`);
  await get("cart guest", "/cart");
  await get("checkout guest", "/checkout");
  await get("account guest", "/account");
  await get("account signed in", "/account", userJar);
  await get("signin", "/signin");
  await get("help", "/help");
  await get("policy", "/privacy");
  const deals = await get("deals", "/deals");
  const newArrivals = await get("new arrivals", "/new-arrivals");
  const faq = await get("faq", "/faq");
  const contactFeedback = await get("contact feedback", "/contact?topic=feedback");
  const notFoundPage = await http("/nope", { label: "GET /nope (P3 not found)" });
  pages.push({ label: "not found", path: "/nope", resp: notFoundPage, signedIn: false });

  // Filled cart + checkout for the visual pass (quick add from the listing; the NJ3 row checks the DB).
  const qaJar = new CookieJar();
  const qaPage = await http("/products", { jar: qaJar, label: "GET /products (P3 quick add)" });
  const quickForm = (f: string): boolean => f.includes('name="productId"') && /name="quantity" value="1"/.test(f);
  const qa = await submitForm(qaJar, "/products", qaPage.body, quickForm, {}, { label: "POST quick add from listing card (P3)" });
  const qaPid = qa.fields.find(([k]) => k === "productId")?.[1] ?? "";
  const cartFilled = await get("cart filled", "/cart", qaJar);
  const checkoutFilled = await get("checkout filled", "/checkout", qaJar);

  // ======================================================== BR: brand-free + brand present
  state.section = "BR";
  const visualPages = pages.filter((p) => p.resp.status === 200 || p.path === "/nope");
  const hits: string[] = [];
  for (const p of visualPages) {
    const text = scanText(p.resp.body);
    for (const w of WORDS) {
      const m = text.match(w.re);
      if (m) hits.push(`${p.label} [${w.label}] "${excerpt(text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 40), 80)}"`);
    }
  }
  record("BR01", `no retailer/payment/social/membership/newsletter/app/copied-copy words in served text + aria-label/alt/title/placeholder of ${visualPages.length} pages (words built at run time, ${WORDS.length} patterns)`, hits.length === 0, hits.slice(0, 6).join(" | ") || "clean");
  const titleBad = visualPages.filter((p) => !title(p.resp.body).includes(BRAND)).map((p) => `${p.label} "${title(p.resp.body)}"`);
  record("BR02", `"${BRAND}" in the <title> of every page`, titleBad.length === 0, titleBad.join(" | ") || "all titles carry the brand");
  const headerBad: string[] = [];
  const footerBad: string[] = [];
  const year = String(new Date().getFullYear());
  for (const p of visualPages) {
    const body = htmlOnly(p.resp.body);
    const header = elementBy(body, /<header\b/);
    const wordmark = tags(header, "a").find((t) => attrs(t).get("href") === "/");
    const wmText = wordmark ? textIn(elementAt(header, header.indexOf(wordmark))) : "";
    if (!wmText.includes(BRAND) || /<img\b/.test(wordmark ? elementAt(header, header.indexOf(wordmark)) : "")) headerBad.push(`${p.label} wordmark "${wmText}"`);
    const footer = elementBy(body, /<footer\b/);
    const ft = textIn(footer);
    if (!ft.includes(BRAND) || !ft.includes(`© ${year}`) || /Storefront/.test(ft)) footerBad.push(`${p.label}`);
  }
  record("BR03", `header wordmark is a text link to "/" reading "${BRAND}" (no image) on every page`, headerBad.length === 0, headerBad.join(" | ") || "ok");
  record("BR04", `footer text carries "${BRAND}" and "© ${year}", never "Storefront", on every page`, footerBad.length === 0, footerBad.join(" | ") || "ok");
  const ldBrand = jsonLd(home.body).nodes.filter((n) => n["@type"] === "Organization" || n["@type"] === "WebSite");
  record("BR05", `JSON-LD Organization + WebSite name = "${BRAND}" (home)`, ldBrand.length === 2 && ldBrand.every((n) => n.name === BRAND), ldBrand.map((n) => `${String(n["@type"])}: ${String(n.name)}`).join(", "));
  const mf = await http("/manifest.webmanifest", { accept: "application/manifest+json", label: "GET manifest (P3)" });
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(mf.body) as Record<string, unknown>;
  } catch {
    manifest = {};
  }
  const og = attrs(home.body.match(/<meta property="og:site_name"[^>]*>/)?.[0] ?? "<meta>").get("content") ?? "";
  record("BR06", `manifest name "${BRAND}", short_name starts "Northwind", og:site_name "${BRAND}"`, manifest.name === BRAND && String(manifest.short_name ?? "").startsWith("Northwind") && og === BRAND, `name ${String(manifest.name)}, short_name ${String(manifest.short_name)}, og:site_name ${og || "absent"}`);

  // ======================================================== LT: light-only
  state.section = "LT";
  const primary = primaryRaw();
  const ltBad: string[] = [];
  const themeBad: string[] = [];
  for (const p of visualPages) {
    const b = p.resp.body;
    const why = [
      DARK_CLASS.test(b) ? "dark variant class" : "",
      b.includes(PCS) ? PCS : "",
      b.includes(DATA_THEME) ? DATA_THEME : "",
      /<meta name="color-scheme"(?![^>]*content="light")/.test(b) ? "color-scheme meta not light" : "",
    ].filter(Boolean);
    if (why.length) ltBad.push(`${p.label}: ${why.join(", ")}`);
    const tc = tags(b, "meta").filter((t) => attrs(t).get("name") === "theme-color").map((t) => (attrs(t).get("content") ?? "").toLowerCase());
    if (tc.length !== 1 || tc[0] !== primary) themeBad.push(`${p.label}: [${tc.join(", ")}]`);
  }
  record("LT01", `no dark-variant class, no ${PCS}, no ${DATA_THEME}, color-scheme meta absent or light: whole served body (incl. RSC payload) of ${visualPages.length} pages`, ltBad.length === 0, ltBad.slice(0, 5).join(" | ") || "clean");
  record("LT02", "exactly one <meta name=theme-color> per page and it equals the primary raw value (--accent in globals.css, read at run time)", themeBad.length === 0 && primary.length > 0, themeBad.slice(0, 4).join(" | ") || `all pages: the --accent value (${primary.length} chars)`);
  const toggles: string[] = [];
  for (const p of visualPages) {
    const body = htmlOnly(p.resp.body);
    for (const t of [...tags(body, "button"), ...tags(body, "a"), ...tags(body, "input")]) {
      const a = attrs(t);
      const name = `${a.get("aria-label") ?? ""} ${a.get("title") ?? ""} ${a.get("name") ?? ""}`;
      if (TOGGLE_NAME.test(name)) toggles.push(`${p.label}: ${excerpt(t, 80)}`);
    }
    const buttons = [...body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textIn(m[1] ?? ""));
    for (const bt of buttons) if (TOGGLE_NAME.test(bt)) toggles.push(`${p.label}: button "${bt}"`);
  }
  record("LT03", "no theme toggle (no button/link/input named theme / dark mode / light mode)", toggles.length === 0, toggles.slice(0, 4).join(" | ") || "none");
  const cssHrefs = [...new Set([...home.body.matchAll(/<link rel="stylesheet" href="([^"]+\.css)"/g)].map((m) => m[1] ?? ""))];
  let cssText = "";
  for (const href of cssHrefs) cssText += (await http(href, { accept: "text/css", label: `GET ${href} (P3 css)` })).body;
  const schemes = [...cssText.matchAll(/color-scheme:\s*([^;}]+)/g)].map((m) => (m[1] ?? "").trim());
  const cssWhy = [
    cssText.includes(PCS) ? PCS : "",
    cssText.includes(DATA_THEME) ? DATA_THEME : "",
    new RegExp(j("\\.da", "rk\\\\:")).test(cssText) ? "dark variant selector" : "",
    new RegExp(j("\\.da", "rk[\\s{,.]")).test(cssText) ? ".dark class selector" : "",
  ].filter(Boolean);
  record("LT04", `served CSS (${cssHrefs.length} file, ${(cssText.length / 1024).toFixed(1)} KiB): every color-scheme declaration is "light" and at least one exists; no ${PCS}, ${DATA_THEME}, dark selectors`, cssHrefs.length > 0 && schemes.length > 0 && schemes.every((s) => s === "light") && cssWhy.length === 0, `color-scheme values [${schemes.join(", ")}]; ${cssWhy.join(", ") || "no dark selectors"}`);
  const lcss = cssText.match(/--lightningcss-[a-z]+:[^;]*;/g) ?? [];
  record("LT05", "lightningcss helper variables in the built CSS (emitted by the CSS minifier for color-scheme: light; not a dark theme)", "info", lcss.join(" ") || "none");

  // ======================================================== ST: structure (G rows on every page)
  state.section = "ST";
  const gBad: string[] = [];
  for (const p of visualPages) {
    const body = htmlOnly(p.resp.body);
    const before = body.slice(0, Math.max(0, body.indexOf("<main")));
    const after = body.slice(body.indexOf("</main>"));
    const banners = count(before, /<header\b/g);
    const header = elementBy(body, /<header\b/);
    const primaryNav = /<nav aria-label="Primary"/.test(header);
    const siteSearch = /<form\b[^>]*role="search"[^>]*aria-label="Site search"[^>]*action="\/search"/.test(header);
    const footers = count(after, /<footer\b/g);
    const footer = elementBy(body, /<footer\b/);
    const footerNavs = tags(footer, "nav").map((t) => attrs(t).get("aria-label") ?? "");
    const firstFocusable = body.slice(body.indexOf("<body")).match(/<a\b[^>]*\shref=[^>]*>|<button\b[^>]*>|<input\b(?![^>]*type="hidden")[^>]*>|<select\b[^>]*>|<textarea\b[^>]*>|<[a-z]+\b[^>]*tabindex="0"[^>]*>/)?.[0] ?? "";
    const names = navNames(p.resp.body);
    const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
    const main = mainOf(p.resp.body);
    const hs = headingsIn(main);
    const issues = [
      banners !== 1 ? `banner headers ${banners}` : "",
      !primaryNav ? 'no nav "Primary" in banner' : "",
      !siteSearch ? 'no role=search "Site search" GET /search form in banner' : "",
      footers !== 1 ? `footers ${footers}` : "",
      !(footerNavs.includes("Footer: Quick links") && footerNavs.filter((n) => n.startsWith("Footer: ")).length >= 5 && footerNavs.every((n) => n.startsWith("Footer: "))) ? `footer navs [${footerNavs.join("|")}]` : "",
      attrs(firstFocusable).get("href") !== "#main" ? `first focusable ${excerpt(firstFocusable, 60)}` : "",
      names.some((n) => !n) ? "unnamed nav" : "",
      dupNames.length ? `duplicate nav names [${dupNames.join("|")}]` : "",
      h1Count(p.resp.body) !== 1 ? `h1 count ${h1Count(p.resp.body)}` : "",
      hs[0] !== 1 ? `first heading in main is h${hs[0] ?? "-"}` : "",
      hs.some((h, i) => i > 0 && h > (hs[i - 1] ?? 1) + 1) ? `skipped level in main [${hs.join("")}]` : "",
    ].filter(Boolean);
    if (issues.length) gBad.push(`${p.label}: ${issues.join("; ")}`);
  }
  record("ST01", `global rows on ${visualPages.length} pages: one banner <header> with nav "Primary" + role=search "Site search" (GET /search), one <footer> with "Footer: Quick links" + >= 4 "Footer: *" navs, skip link "#main" first focusable, every nav named and unique, one h1 that is the first heading in <main>, no skipped heading level in <main>`, gBad.length === 0, gBad.slice(0, 5).join(" | ") || "all pages");

  // ---- home
  const ids = homeIds(home.body);
  const idsUser = homeIds(homeUser.body);
  const expectedGuest = HOME_ORDER.filter((id) => id !== "home-recently-viewed");
  record("ST02", "home (guest): section ids in contract order (H-order: hero first … services; no recently-viewed without an owner key)", ids.join(",") === expectedGuest.join(","), `[${ids.join(", ")}]`);
  record("ST03", "home (signed in, after one PDP view): the same order with #home-recently-viewed between the promo pair and the brands", signedIn && idsUser.join(",") === HOME_ORDER.join(","), `signed in ${signedIn}; [${idsUser.join(", ")}]`);
  const hero = sectionById(home.body, "home-hero");
  const heroOpen = attrs(hero.match(/^<[^>]+>/)?.[0] ?? "<div>");
  const slides = [...hero.matchAll(/<[a-z]+\b[^>]*\sid="(slide-\d+)"[^>]*aria-roledescription="slide"[^>]*aria-label="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
  const dots = tags(hero, "a").filter((t) => /href="#slide-\d+"/.test(t));
  const dotTargets = dots.map((t) => (attrs(t).get("href") ?? "").slice(1));
  const heroImgs = tags(hero, "img").map(attrs);
  const firstHeading = mainOf(home.body).match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/);
  record(
    "ST04",
    'home hero: role=region + aria-roledescription=carousel + name; one h1 (first heading in main) in #home-hero; slides "n of 3"; dot links #slide-1..3 each with a matching id, exactly one aria-current; first image eager, the rest lazy',
    heroOpen.get("role") === "region" && heroOpen.get("aria-roledescription") === "carousel" && !!heroOpen.get("aria-label") && /<h1\b/.test(hero) && /^<h1/.test(firstHeading?.[0] ?? "") && slides.length === 3 && slides.every((s, i) => s === `slide-${i + 1}=${i + 1} of 3`) && dots.length === 3 && dotTargets.every((id) => hero.includes(`id="${id}"`)) && dots.filter((t) => /aria-current=/.test(t)).length === 1 && heroImgs[0]?.get("loading") === "eager" && heroImgs.slice(1, 3).every((a) => a.get("loading") === "lazy"),
    `name "${heroOpen.get("aria-label")}", h1 "${h1Text(home.body)}", slides [${slides.join(", ")}], dots [${dotTargets.join(",")}], img loading [${heroImgs.map((a) => a.get("loading")).join(",")}]`,
  );
  const tabNav = elementBy(htmlOnly(home.body), /<nav aria-label="Top picks lists"/);
  const tabLinks = tags(tabNav, "a").map((t) => [textIn(elementAt(tabNav, tabNav.indexOf(t))), attrs(t).get("href") ?? ""] as [string, string]);
  record("ST05", 'home top-picks tabs: nav "Top picks lists" with 4 links in order Best sellers / Deals / New arrivals / Top rated → /?rail=…#top-picks, exactly one aria-current="page", no role=tab', JSON.stringify(tabLinks) === JSON.stringify(TABS) && count(tabNav, /aria-current="page"/g) === 1 && !/role="tab"/.test(tabNav), `${tabLinks.map(([t, h]) => `${t}→${h}`).join(", ")}; current ${currentTab(home.body)}`);
  const pop = elementBy(sectionById(home.body, "home-popular-searches"), /<nav\b/);
  const popLinks = tags(pop, "a").map((t) => attrs(t).get("href") ?? "");
  record("ST06", "home popular searches: named nav, 1–12 links to /search?q=<term>", !!attrs(pop.match(/^<[^>]+>/)?.[0] ?? "<nav>").get("aria-label") && popLinks.length >= 1 && popLinks.length <= 12 && popLinks.every((h) => /^\/search\?q=[^&]+$/.test(h)), `${popLinks.length} links, e.g. ${popLinks.slice(0, 3).join(" ")}`);
  const pair = sectionById(home.body, "home-promo-pair");
  const services = sectionById(home.body, "home-services");
  const svcLinks = tags(services, "a").map((t) => attrs(t).get("href") ?? "");
  const needSvc = ["/orders", "/returns", "/shipping", "/help", "/faq", "/contact"];
  record(
    "ST07",
    "home promo pair links /new-arrivals + /top-rated; services band links /orders /returns /shipping /help /faq /contact; no email input on home (no newsletter)",
    pair.includes('href="/new-arrivals"') && pair.includes('href="/top-rated"') && needSvc.every((h) => svcLinks.includes(h)) && !/<input\b[^>]*type="email"/.test(mainOf(home.body)),
    `pair new ${pair.includes('href="/new-arrivals"')} top ${pair.includes('href="/top-rated"')}; services [${[...new Set(svcLinks)].join(" ")}]; email input ${/<input\b[^>]*type="email"/.test(mainOf(home.body))}`,
  );
  record("ST08", "home canonical is / for / and /?rail=deals (H-22)", pathOf(canonical(home.body)) === "/", `canonical ${canonical(home.body)}`);
  const userHeader = textIn(elementBy(htmlOnly(homeUser.body), /<header\b/));
  record("ST09", 'home signed in: header greets the user ("Phase Three") and has no "Sign in" link; guest header links /signin', signedIn && userHeader.includes("Phase Three") && !/<a\b[^>]*href="\/signin"/.test(elementBy(htmlOnly(homeUser.body), /<header\b/)) && /<a\b[^>]*href="\/signin"/.test(elementBy(htmlOnly(home.body), /<header\b/)), `signed in ${signedIn}; header text "${excerpt(userHeader, 120)}"`);

  // ---- listing template (L rows) on six listing pages
  const listingPages: Array<[string, Resp]> = [
    ["products", products],
    ["category", category],
    ["brand", brand],
    ["search", search],
    ["deals", deals],
    ["new arrivals", newArrivals],
  ];
  const lBad: string[] = [];
  for (const [label, r] of listingPages) {
    const main = mainOf(r.body);
    const crumbAt = main.search(/<nav aria-label="Breadcrumb"/);
    const firstChildNav = main.replace(/^<main\b[^>]*>/, "").replace(/^(\s*<div\b[^>]*>)+/, "").startsWith('<nav aria-label="Breadcrumb"');
    const details = elementBy(main, /<details\b[^>]*data-filter-panel/);
    const detailsOpen = attrs(details.match(/^<details\b[^>]*>/)?.[0] ?? "<details>");
    const summary = textIn(elementBy(details, /<summary\b/));
    const filterForm = forms(details).find((f) => (formOpen(f).get("method") ?? "").toLowerCase() === "get");
    const sortAt = main.search(/<select\b[^>]*name="sort"/);
    const detailsAt = main.indexOf(details);
    const asideOutside = main.replace(details, "").match(/<aside\b/);
    const grid = elementBy(main, /<ul\b[^>]*data-layout="grid"/);
    const items = topLevelItems(grid);
    const cards = items.filter((li) => /<article\b/.test(li));
    const cardBad = cards.filter((li) => {
      const link = tags(li, "a").find((t) => /href="\/products\//.test(t));
      const linkEl = link ? elementAt(li, li.indexOf(link)) : "";
      const form = forms(li).find((f) => f.includes('name="productId"'));
      const oosCard = /Out of stock/.test(textIn(li));
      const badgeBox = elementBy(li, /<div\b[^>]*data-testid="product-card-badges"/);
      const badges = badgeBox ? [...badgeBox.replace(/^<div\b[^>]*>/, "").matchAll(/<span\b[^>]*>([^<]+)<\/span>/g)].map((m) => (m[1] ?? "").trim()) : [];
      if (badges.length > 2 || badges.some((b) => !["Sale", "New", "Top pick"].includes(b))) return true;
      return !link || /<(a|button|input|form)\b/.test(linkEl.replace(/^<a\b[^>]*>/, "")) || (oosCard ? !!form : !form || !/name="quantity" value="1"/.test(form) || /name="(price|priceCents|total)"/.test(form ?? ""));
    });
    const fbHeading = /<h2\b[^>]*>Did you find what you were looking for\?<\/h2>/.test(main);
    const fbLink = /<a\b[^>]*href="\/contact\?topic=feedback"[^>]*>Give feedback<\/a>/.test(main);
    const issues = [
      crumbAt < 0 || !firstChildNav ? "breadcrumb not first in main" : "",
      h1Count(r.body) !== 1 || !/<h1\b[^>]*\sid="listing-title"/.test(main) ? "h1#listing-title" : "",
      !/id="listing-result-count">\d+–\d+ of \d+ results?</.test(main) ? "result count line" : "",
      !details ? "no details[data-filter-panel]" : "",
      detailsOpen.has("open") ? "filter panel open by default" : "",
      !/^Filter( \d+)?$/.test(summary) ? `summary "${summary}"` : "",
      !filterForm || !buttonsOf(filterForm).some((b) => /^Apply/.test(b)) ? "filter GET form with Apply" : "",
      !(sortAt > detailsAt) ? "sort select not after the Filter control" : "",
      asideOutside ? "aside outside the filter panel" : "",
      cards.length === 0 ? "no product cards" : "",
      cardBad.length ? `${cardBad.length} cards break L-12` : "",
      !fbHeading || !fbLink ? "feedback block" : "",
    ].filter(Boolean);
    if (issues.length) lBad.push(`${label}: ${issues.join("; ")}`);
  }
  record("ST10", "listing template on /products, /category/<dept>, /brand/<slug>, /search?q=desk, /deals, /new-arrivals: breadcrumb first, h1#listing-title, result count, closed details[data-filter-panel] with summary \"Filter\" + GET form + Apply, sort select after it, no aside outside the panel, cards = one /products link (nothing interactive inside) + sibling quick-add form (productId, quantity=1, no price), feedback h2 + \"Give feedback\" → /contact?topic=feedback", lBad.length === 0, lBad.join(" | ") || `ok (${listingPages.length} pages)`);
  const promoInfo = (r: Resp): { promos: number; positions: number[]; total: number; last: boolean } => {
    const items = topLevelItems(elementBy(mainOf(r.body), /<ul\b[^>]*data-layout="grid"/));
    const positions = items.map((li, i) => (/^<li\b[^>]*data-promo-/.test(li) ? i + 1 : 0)).filter(Boolean);
    return { promos: positions.length, positions, total: items.length, last: positions.includes(items.length) };
  };
  const pr1 = promoInfo(products);
  const pr2 = promoInfo(products2);
  const prF = promoInfo(productsFacet);
  const promoLinksOk = topLevelItems(elementBy(mainOf(products.body), /<ul\b[^>]*data-layout="grid"/))
    .filter((li) => /^<li\b[^>]*data-promo-/.test(li))
    .every((li) => tags(li, "a").length === 1 && !/<h[12]\b/.test(li));
  record(
    "ST11",
    "promo tiles: /products page 1 has 1–3 promo <li> in the grid list at li positions 3/10/17 (never last), each with one link and no h1/h2; page 2 and a faceted page have none",
    pr1.promos >= 1 && pr1.promos <= 3 && pr1.positions.every((p, i) => p === [3, 10, 17][i]) && !pr1.last && promoLinksOk && pr2.promos === 0 && prF.promos === 0,
    `page 1: ${pr1.promos} promos at [${pr1.positions.join(",")}] of ${pr1.total} li; page 2: ${pr2.promos} of ${pr2.total}; ?brand=: ${prF.promos} of ${prF.total}; one link each ${promoLinksOk}`,
  );
  const pager = elementBy(htmlOnly(products.body), /<nav aria-label="Listing pages"/);
  record("ST12", '/products pagination: nav "Listing pages", current page aria-current="page", rel=next link', /aria-current="page"/.test(pager) && /rel="next"/.test(pager), `nav ${pager.length > 0}, current ${/aria-current="page"/.test(pager)}, rel=next ${/rel="next"/.test(pager)}`);
  const chipsNav = navNames(search.body).find((n) => n === "Related searches");
  const chipsEl = elementBy(htmlOnly(search.body), /<nav\b[^>]*aria-labelledby=/);
  const chipHrefs = tags(chipsEl, "a").map((t) => attrs(t).get("href") ?? "");
  record(
    "ST13",
    '/search?q=desk: h1 "Showing results for “desk”", chips nav named "Related searches" with 1–12 links to /search?q=… (never the current query)',
    h1Text(search.body) === "Showing results for “desk”" && !!chipsNav && chipHrefs.length >= 1 && chipHrefs.length <= 12 && chipHrefs.every((h) => /^\/search\?q=./.test(h) && decodeURIComponent(h.split("q=")[1] ?? "").toLowerCase() !== "desk"),
    `h1 "${h1Text(search.body)}", chips nav ${!!chipsNav}, ${chipHrefs.length} chips: ${chipHrefs.slice(0, 4).join(" ")}`,
  );
  const zeroNavs = navNames(searchZero.body);
  record("ST14", "/search?q=zzzzzz (zero results): 200, popular-search chips nav, feedback block still rendered, noindex", searchZero.status === 200 && zeroNavs.includes("Popular searches") && /href="\/contact\?topic=feedback"/.test(searchZero.body) && /<meta name="robots" content="noindex/.test(searchZero.body), `status ${searchZero.status}, navs [${zeroNavs.join("|")}]`);
  const fbOption = (contactFeedback.body.match(/<select\b[^>]*name="topic"[\s\S]*?<\/select>/)?.[0] ?? "").match(/<option\b[^>]*selected[^>]*>/)?.[0] ?? "";
  record("ST15", '/contact?topic=feedback preselects the "feedback" topic (L-21)', contactFeedback.status === 200 && attrs(fbOption).get("value") === "feedback", `status ${contactFeedback.status}, selected ${fbOption || "none"}`);

  // ---- PDP (P rows; reference pending)
  const pmain = mainOf(pdp.body);
  const titleBlock = elementBy(pmain, /<div\b[^>]*data-testid="pdp-title-block"/);
  const buyBoxOpen = pmain.match(/<[a-z]+\b[^>]*aria-labelledby="buy-box-[^"]*"[^>]*>/)?.[0] ?? "";
  const buyBoxCls = attrs(buyBoxOpen).get("class") ?? "";
  const galleryAt = pmain.search(/\sid="gallery"/);
  const titleAt = pmain.indexOf(titleBlock);
  const buyAt = pmain.indexOf(buyBoxOpen);
  record(
    "ST16",
    'PDP title block (data-testid="pdp-title-block": h1 product name, brand link /brand/<slug>, rating link #reviews) and buy box with data-sticky + lg:sticky lg:top-*; DOM order gallery → title block → buy box; breadcrumb first',
    !!titleBlock && /<h1\b[^>]*>[\s\S]*?<\/h1>/.test(titleBlock) && h1Text(titleBlock) === fx.pdp.name && /href="\/brand\/[^"]+"/.test(titleBlock) && /href="#reviews"/.test(titleBlock) && /\sdata-sticky(=|\s|>)/.test(buyBoxOpen) && /(^|\s)lg:sticky(\s|$)/.test(buyBoxCls) && /(^|\s)lg:top-\S+/.test(buyBoxCls) && galleryAt >= 0 && galleryAt < titleAt && titleAt < buyAt && /^<main\b[^>]*>\s*(<div\b[^>]*>\s*)*<nav aria-label="Breadcrumb"/.test(pmain),
    `title block ${!!titleBlock}, h1 "${h1Text(titleBlock)}", brand link ${/href="\/brand\//.test(titleBlock)}, #reviews ${/href="#reviews"/.test(titleBlock)}, buy box sticky classes [${buyBoxCls.split(/\s+/).filter((c) => /sticky|top-/.test(c)).join(" ")}], data-sticky ${/data-sticky/.test(buyBoxOpen)}, order gallery ${galleryAt} < title ${titleAt} < buy ${buyAt}`,
  );
  const rails = [...pmain.matchAll(/<section\b[^>]*\sid="(rail-[a-z-]+)"[^>]*>/g)].map((m) => m[1] ?? "");
  const railBad = rails.filter((id) => {
    const sec = elementBy(pmain, new RegExp(`<section\\b[^>]*\\sid="${id}"`));
    return !/<h2\b/.test(sec) || sec.includes(`href="/products/${fx.pdp.slug}"`) || !forms(sec).some((f) => f.includes('name="productId"'));
  });
  record("ST17", "PDP rails (section#rail-*): >= 1, each with an h2 and quick-add forms, none links the current product", rails.length >= 1 && railBad.length === 0, `rails [${rails.join(", ")}], bad [${railBad.join(", ")}]`);
  const priceText = textIn(elementBy(pmain, /<[a-z]+\b[^>]*data-slot="buy-box-price"/));
  record("ST18", 'PDP buy box price for a discounted product: "Was $X" in <s> and "Save $Y (Z%)" (P-6)', /Was \$[\d,.]+/.test(priceText) && /Save \$[\d,.]+ \(\d+%\)/.test(priceText) && /<s\b/.test(elementBy(pmain, /<[a-z]+\b[^>]*data-slot="buy-box-price"/)), `"${excerpt(priceText, 140)}"`);

  // ======================================================== NJ3: no-JS replays
  state.section = "NJ3";
  const qaSid = qaJar.cookies.get("sf_session") ?? "";
  const qaRow = num("SELECT quantity AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", qaSid, qaPid);
  record(
    "NJ3-01",
    "quick add from a /products card (multipart replay: $ACTION_* + productId + quantity=1) → 200, \"Added 1 to your cart.\" in the server HTML, cart_items row qty 1, line on /cart",
    !!qa.post && qa.post.status === 200 && htmlOnly(qa.post.body).includes("Added 1 to your cart.") && qaRow === 1 && textOf(cartFilled.body).includes("Quantity for "),
    qa.form ? `status ${qa.post?.status}, product ${qaPid}, DB qty ${qaRow}, fields [${qa.fields.map(([k]) => k.replace(/\d+/g, "n")).join(",")}]` : "no quick-add form on /products",
  );
  const homeJar = new CookieJar();
  const homeForQa = await http("/", { jar: homeJar, label: "GET / (P3 rail quick add)" });
  const topPicks = sectionById(homeForQa.body, "top-picks");
  const railForm = forms(topPicks).find(quickForm);
  const railPid = railForm ? (serializeForm(railForm).find(([k]) => k === "productId")?.[1] ?? "") : "";
  const railPost = railForm ? await submitForm(homeJar, "/", homeForQa.body, (f) => quickForm(f) && f.includes(`value="${railPid}"`), {}, { label: "POST quick add from home top-picks rail (P3)" }) : null;
  const railRow = num("SELECT quantity AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", homeJar.cookies.get("sf_session") ?? "", railPid);
  record("NJ3-02", "quick add from the home top-picks rail (\"+ Add\" compact card, multipart replay to /) → cart_items row qty 1", !!railPost?.post && railPost.post.status === 200 && railRow === 1, railForm ? `status ${railPost?.post?.status}, product ${railPid}, DB qty ${railRow}` : "no quick-add form in #top-picks");

  const sorted = await http("/products?sort=price_asc", { label: "GET /products?sort=price_asc (P3 filter)" });
  const fForm = forms(elementBy(mainOf(sorted.body), /<details\b[^>]*data-filter-panel/)).find((f) => (formOpen(f).get("method") ?? "").toLowerCase() === "get");
  let filtered: Resp | null = null;
  let query = "";
  if (fForm) {
    const firstBrand = tags(fForm, "input").map(attrs).find((a) => a.get("type") === "checkbox" && a.get("name") === "brand");
    const fields = serializeForm(fForm);
    if (firstBrand) fields.push(["brand", firstBrand.get("value") ?? ""]);
    query = new URLSearchParams(fields).toString();
    filtered = await http(`${formOpen(fForm).get("action") ?? "/products"}?${query}`, { label: "GET filter form submit (P3)" });
  }
  const selSort = (filtered?.body.match(/<select\b[^>]*name="sort"[\s\S]*?<\/select>/)?.[0] ?? "").match(/<option\b[^>]*selected[^>]*>/)?.[0] ?? "";
  const fSummary = textIn(elementBy(elementBy(mainOf(filtered?.body ?? ""), /<details\b[^>]*data-filter-panel/), /<summary\b/));
  const fPromo = filtered ? promoInfo(filtered).promos : -1;
  record(
    "NJ3-03",
    "filter form GET (from /products?sort=price_asc, one brand ticked) keeps sort: 200, query has sort=price_asc, sort select still price_asc, summary \"Filter 1\", no promo tiles",
    !!filtered && filtered.status === 200 && /(^|&)sort=price_asc(&|$)/.test(query) && attrs(selSort).get("value") === "price_asc" && fSummary === "Filter 1" && fPromo === 0,
    `query ?${excerpt(query, 90)}, status ${filtered?.status}, selected ${attrs(selSort).get("value") ?? "none"}, summary "${fSummary}", promos ${fPromo}`,
  );
  const sortForm = forms(mainOf(products.body)).find((f) => /<select\b[^>]*name="sort"/.test(f) && (formOpen(f).get("method") ?? "").toLowerCase() === "get");
  const sortFields = sortForm ? serializeForm(sortForm).map(([k, v]): [string, string] => [k, k === "sort" ? "price_desc" : v]) : [];
  const sortResp = sortForm ? await http(`${formOpen(sortForm).get("action") ?? "/products"}?${new URLSearchParams(sortFields).toString()}`, { label: "GET sort form submit (P3)" }) : null;
  const firstCardPrices = (r: Resp | null): number[] =>
    topLevelItems(elementBy(mainOf(r?.body ?? ""), /<ul\b[^>]*data-layout="grid"/))
      .filter((li) => /<article\b/.test(li))
      .slice(0, 4)
      .map((li) => Number((textIn(li).match(/\$([\d,]+\.\d{2})/)?.[1] ?? "0").replace(/,/g, "")));
  const sp = firstCardPrices(sortResp);
  record("NJ3-04", "sort form GET (price_desc) → 200, first 4 cards in non-increasing price", !!sortResp && sortResp.status === 200 && sp.length === 4 && sp.every((v, i) => i === 0 || v <= (sp[i - 1] ?? 0)), `status ${sortResp?.status}, prices [${sp.join(", ")}]`);
  const dot2 = /<a\b[^>]*href="#slide-2"/.test(hero) && /\sid="slide-2"/.test(hero);
  record("NJ3-05", 'hero dot "Slide 2 of 3" is a plain anchor href="#slide-2" whose target id="slide-2" is in the same server HTML (no JS needed to move the slide)', dot2, `anchor ${/<a\b[^>]*href="#slide-2"/.test(hero)}, target ${/\sid="slide-2"/.test(hero)}`);
  const railDeals = await http("/?rail=deals", { label: "GET /?rail=deals (P3 tab)" });
  const railNew = await http("/?rail=new-arrivals", { label: "GET /?rail=new-arrivals (P3 tab)" });
  const railTop = await http("/?rail=top-rated", { label: "GET /?rail=top-rated (P3 tab)" });
  const hostile = await Promise.all(["x", "", "__proto__", "a".repeat(500)].map((v) => http(`/?rail=${encodeURIComponent(v)}`, { label: `GET /?rail=<hostile ${v.length}> (P3)` })));
  const hostile2 = await http("/?rail=deals&rail=top-rated", { label: "GET /?rail=a&rail=b (P3)" });
  const setOf = (r: Resp): string => productHrefs(sectionById(r.body, "top-picks")).sort().join(",");
  record(
    "NJ3-06",
    '?rail= tab links work without JS: /?rail=deals, new-arrivals, top-rated each 200 with aria-current on that tab and a different product set; canonical stays /; hostile values (x, empty, __proto__, 500 chars, repeated) → 200 with the default tab',
    railDeals.status === 200 && currentTab(railDeals.body) === "/?rail=deals#top-picks" && currentTab(railNew.body) === "/?rail=new-arrivals#top-picks" && currentTab(railTop.body) === "/?rail=top-rated#top-picks" && setOf(railDeals) !== setOf(railNew) && setOf(railNew) !== setOf(railTop) && pathOf(canonical(railDeals.body)) === "/" && [...hostile, hostile2].every((r) => r.status === 200 && currentTab(r.body) === currentTab(home.body)),
    `default ${currentTab(home.body)}; deals ${currentTab(railDeals.body)} (${productHrefs(sectionById(railDeals.body, "top-picks")).length} cards), new ${currentTab(railNew.body)}, top ${currentTab(railTop.body)}; canonical ${pathOf(canonical(railDeals.body))}; hostile [${[...hostile, hostile2].map((r) => `${r.status}:${currentTab(r.body).replace(/^\/\?rail=|#top-picks$/g, "")}`).join(" ")}]`,
  );

  // AC4 (T175): cookies disabled — every request below carries no Cookie header; responses' cookies are dropped.
  const noCookie = (): CookieJar => new CookieJar();
  const sGet = await http("/search?q=lamp", { label: "GET /search?q=lamp (cookies disabled)" });
  const tGet = await http("/?rail=top-rated", { label: "GET tab link (cookies disabled)" });
  const lp = await http("/products", { label: "GET /products (cookies disabled)" });
  const qaNc = await submitForm(noCookie(), "/products", lp.body, quickForm, {}, { label: "POST quick add (cookies disabled)" });
  const siPage = await http("/signin", { label: "GET /signin (cookies disabled)" });
  const siPost = await submitForm(noCookie(), "/signin", siPage.body, (f) => f.includes('id="signin-form"'), { email, password: PASSWORD }, { label: "POST sign-in (cookies disabled)" });
  const siBad = await submitForm(noCookie(), "/signin", siPage.body, (f) => f.includes('id="signin-form"'), { email, password: "Wrong-password-p3" }, { label: "POST sign-in wrong password (cookies disabled)" });
  const after = await http("/account", { label: "GET /account after cookie-less sign-in (cookies disabled)" });
  record(
    "NJ3-07",
    'cookies disabled (no Cookie header ever sent): search GET 200 with results; tab link 200; quick-add POST 200 with "Added 1 to your cart."; sign-in POST with the right password → 303 /account, wrong password → 200 "Email or password is incorrect"; the next GET /account is the guest view (no session without cookies)',
    sGet.status === 200 && /\d+ results?/.test(textOf(sGet.body)) && tGet.status === 200 && qaNc.post?.status === 200 && htmlOnly(qaNc.post.body).includes("Added 1 to your cart.") && isRedirect(siPost.post) && locPath(siPost.post) === "/account" && siBad.post?.status === 200 && /Email or password is incorrect/.test(textOf(siBad.post.body)) && after.status === 200 && !textOf(after.body).includes("Phase Three"),
    `search ${sGet.status}, tab ${tGet.status}, quick add ${qaNc.post?.status} added ${htmlOnly(qaNc.post?.body ?? "").includes("Added 1 to your cart.")}, sign-in ${siPost.post?.status} → ${siPost.post?.location}, wrong ${siBad.post?.status}, /account after: guest ${!textOf(after.body).includes("Phase Three")}`,
  );

  // ======================================================== SD: seed sanity
  state.section = "SD";
  const sm = await http("/sitemap.xml", { accept: "application/xml", label: "GET /sitemap.xml (P3)" });
  const locs = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(decodeEntities(m[1] ?? "")).pathname);
  const pdpLocs = locs.filter((p) => /^\/products\/[^/]+$/.test(p));
  const futureIn = fx.future.filter((s) => pdpLocs.includes(`/products/${s}`));
  record(
    "SD01",
    `seed: ${fx.total} products in the DB (${fx.published} published + ${fx.future.length} future-dated); /sitemap.xml lists exactly the ${fx.published} published PDPs and none of the future-dated ones`,
    fx.total === 125 && fx.published === 123 && pdpLocs.length === fx.published && futureIn.length === 0,
    `${locs.length} URLs: ${pdpLocs.length} PDPs + ${locs.length - pdpLocs.length} other routes; future-dated in sitemap [${futureIn.join(",")}]`,
  );
  const futureResp = await Promise.all(fx.future.map((s) => http(`/products/${s}`, { label: `GET future-dated PDP ${s} (P3)` })));
  record("SD02", `future-dated products (${fx.future.join(", ")}) → 404 on their PDP`, futureResp.length === fx.future.length && futureResp.every((r) => r.status === 404), futureResp.map((r) => r.status).join(","));
  const naItems = topLevelItems(elementBy(mainOf(newArrivals.body), /<ul\b[^>]*data-layout="grid"/)).filter((li) => /<article\b/.test(li));
  const withNew = naItems.filter((li) => /<div\b[^>]*data-testid="product-card-badges"[\s\S]*?>New</.test(li));
  record("SD03", '/new-arrivals: every product card on page 1 carries a "New" badge', naItems.length > 0 && withNew.length === naItems.length, `${withNew.length}/${naItems.length} cards with "New"; result line "${textIn(mainOf(newArrivals.body).match(/id="listing-result-count">([^<]*)</)?.[1] ?? "")}"`);
  const dealTotal = Number(mainOf(deals.body).match(/id="listing-result-count">[^<]*? of (\d+) results?</)?.[1] ?? "0");
  record("SD04", "/deals lists at least 40 deals", dealTotal >= 40, `${dealTotal} results`);
  const oosForms = forms(oos.body).filter((f) => f.includes(`value="${fx.oos.id}"`) && f.includes('name="quantity"'));
  const visibleQty = tags(htmlOnly(oos.body), "input").map(attrs).filter((a) => a.get("name") === "quantity" && a.get("type") !== "hidden");
  record("SD05", `out-of-stock PDP (${fx.oos.slug}): "Out of stock", "Notify me when available" form, no add-to-cart form for this product, no visible quantity input`, oos.status === 200 && textOf(oos.body).includes("Out of stock") && forms(oos.body).some((f) => /Notify me when available/.test(textIn(f))) && oosForms.length === 0 && visibleQty.length === 0, `status ${oos.status}, notify ${forms(oos.body).some((f) => /Notify me when available/.test(textIn(f)))}, own add-to-cart forms ${oosForms.length}, visible quantity inputs ${visibleQty.length}`);

  // ======================================================== LD3: JSON-LD on Phase 3 pages
  state.section = "LD3";
  const want: Array<[string, Resp, string[]]> = [
    ["home", home, ["Organization", "WebSite", "ItemList"]],
    ["pdp", pdp, ["Product", "BreadcrumbList"]],
    ["products", products, ["ItemList"]],
    ["category", category, ["ItemList", "BreadcrumbList"]],
    ["brand", brand, ["ItemList"]],
    ["faq", faq, ["FAQPage"]],
  ];
  const ldBad: string[] = [];
  for (const [label, r, types] of want) {
    const ld = jsonLd(r.body);
    const missing = types.filter((t) => !ld.types.includes(t));
    if (ld.errors.length || missing.length) ldBad.push(`${label}: errors ${ld.errors.length}, missing [${missing.join(",")}], has [${ld.types.join(",")}]`);
  }
  const parseBad = visualPages.filter((p) => jsonLd(p.resp.body).errors.length > 0).map((p) => p.label);
  record("LD3-01", "JSON-LD parses and has the expected types: home (Organization, WebSite, ItemList), PDP (Product, BreadcrumbList), /products (ItemList), category (ItemList, BreadcrumbList), brand (ItemList), FAQ (FAQPage)", ldBad.length === 0, ldBad.join(" | ") || "ok");
  record("LD3-02", `every JSON-LD block on the ${visualPages.length} Phase 3 pages parses`, parseBad.length === 0, parseBad.join(", ") || "ok");

  // ======================================================== GC3: no Set-Cookie on GETs
  state.section = "GC3";
  const setters = pages.filter((p) => p.resp.setCookies.length > 0).map((p) => `${p.label}: ${p.resp.setCookies.map((c) => c.split("=")[0]).join(",")}`);
  record("GC3-01", `no Set-Cookie on any of the ${pages.length} Phase 3 page GETs (guest, signed-in and filled-cart jars)`, setters.length === 0, setters.join(" | ") || "none");
  const extraGets = [sGet, tGet, railDeals, railNew, railTop, ...hostile, hostile2, sorted, ...(filtered ? [filtered] : []), ...(sortResp ? [sortResp] : []), sm];
  const extraSetters = extraGets.filter((r) => r.setCookies.length > 0).map((r) => r.url);
  record("GC3-02", `no Set-Cookie on the ${extraGets.length} replayed GETs (tabs, hostile rail values, filter/sort form submits, sitemap)`, extraSetters.length === 0, extraSetters.join(", ") || "none");

  // ======================================================== SZ: sizes + timings
  state.section = "SZ";
  for (const [label, r] of [["home", home], ["home signed in", homeUser], ["/products", products], [`/category/${fx.dept}`, category], ["/search?q=desk", search], [`PDP ${fx.pdp.slug}`, pdp], ["/cart (filled)", cartFilled], ["/checkout (filled)", checkoutFilled]] as Array<[string, Resp]>) {
    const js = jsRefs(r.body);
    const scriptsBytes = (r.body.match(/<script\b[\s\S]*?<\/script>/g) ?? []).join("").length;
    record("SZ", `${label}: served HTML size, RSC/inline script share, JS chunks referenced, TTFB`, "info", `${(r.body.length / 1024).toFixed(1)} KiB HTML (${((scriptsBytes / Math.max(1, r.body.length)) * 100).toFixed(0)}% inline <script>), ${js.n} JS files = ${js.kib.toFixed(1)} KiB, ${r.ttfbMs.toFixed(0)} ms`);
  }
}

function buttonsOf(formHtml: string): string[] {
  return [...formHtml.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((b) => textIn(b[1] ?? ""));
}
