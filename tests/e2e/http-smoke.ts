/**
 * Production HTTP smoke test (QA tasks T27a MVP + T113 Phase 2 + T175 Phase 3; Phase 2 sections in
 * ./_phase2.ts, Phase 3 redesign sections in ./_phase3.ts, shared helpers in ./_lib.ts; SMOKE_MVP_ONLY=1
 * skips Phase 2 and 3, SMOKE_DUMP=<dir> saves debug bodies).
 *
 *   bun run tests/e2e/http-smoke.ts            # needs a prior `bun run build`
 *   SMOKE_PORT=3105 bun run tests/e2e/http-smoke.ts
 *
 * This is a plain Bun script, not a `*.test.ts`, so `bun test` never picks it up.
 * It seeds a dedicated SQLite DB (./data/smoke.sqlite), starts `bun run start` (production) on a free
 * port, drives every route plus the no-JS add-to-cart and checkout flows with `fetch`
 * and a cookie jar, prints a PASS/FAIL table, stops the server process tree by PID, deletes the DB
 * files and exits 1 on any failure. No dependencies beyond Bun.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CookieJar,
  CVC,
  DB_ABS,
  DB_REL,
  DECLINE_CARD,
  GOOD_CARD,
  type Product,
  type Resp,
  ROOT,
  UUID_RE,
  allResponses,
  attrs,
  cartQty,
  childPids,
  count,
  excerpt,
  firstStreamedDiv,
  formWith,
  forms,
  h1Text,
  hiddenFields,
  htmlOnly,
  http,
  logMarks,
  markLog,
  orderCount,
  portAccepts,
  portFree,
  pump,
  q,
  record,
  rows,
  run,
  scanned,
  soft404,
  state,
  stockOf,
  stripTestCardHint,
  tags,
  textOf,
  title,
  toFormData,
  unlabelledControls,
  usd,
} from "./_lib";
import * as P2 from "./_phase2";
import * as P3 from "./_phase3";

/** At least two in-stock products (checked in main). */
type Products = readonly [Product, Product, ...Product[]];

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(DB_ABS + suffix, { force: true });
}

// ---------------------------------------------------------------- the checks

let randomOrderTitle = "";
const noJsFeedback: Array<[string, boolean]> = [];

async function routeChecks(products: Products, outOfStock: Product): Promise<void> {
  const home = await http("/");
  const productHrefs = new Set([...home.body.matchAll(/href="(\/products\/[^"]+)"/g)].map((m) => m[1]));
  const imgs = tags(home.body, "img");
  record("R01", "/ status 200", home.status === 200, `status ${home.status}`);
  record("R02", "/ exactly one <h1>", count(home.body, /<h1[\s>]/g) === 1, `h1 count ${count(home.body, /<h1[\s>]/g)}`);
  record(
    "R03",
    '/ exactly one <main id="main"> (and one <main>)',
    count(home.body, /<main id="main"/g) === 1 && count(home.body, /<main[\s>]/g) === 1,
    `main id=main ${count(home.body, /<main id="main"/g)}, <main ${count(home.body, /<main[\s>]/g)}`,
  );
  record("R04", '/ skip link href="#main"', home.body.includes('href="#main"'));
  record("R05", '/ <html lang="en"> and viewport meta', home.body.includes('<html lang="en"') && /<meta name="viewport"/.test(home.body));
  // Phase 2 (T96 home v2): rails replaced the 15-card MVP grid, so "exactly 15" became "at least 15".
  // Phase 3 (T166 home v3): the Phase 2 rails became ONE tabbed top-picks rail capped at RAIL_LIMIT 12
  // (contract H-16) plus the deal-of-the-day link, so the floor is now 12.
  record("R06", "/ at least 12 distinct product links (MVP: exactly 15; Phase 2: >= 15; Phase 3: one top-picks rail of <= 12, T166/H-16)", productHrefs.size >= 12, `${productHrefs.size} distinct /products/* hrefs`);
  const noAlt = imgs.filter((t) => !/\salt="/.test(t));
  record("R07", "/ every <img> has alt=", imgs.length > 0 && noAlt.length === 0, `${imgs.length} imgs, ${noAlt.length} without alt`);

  const p = products[0];
  const pdp = await http(`/products/${p.slug}`);
  record("R08", `/products/${p.slug} status 200`, pdp.status === 200, `status ${pdp.status}`);
  record(
    "R09",
    "PDP one <h1> with the product name",
    count(pdp.body, /<h1[\s>]/g) === 1 && h1Text(pdp.body) === p.name,
    `h1 count ${count(pdp.body, /<h1[\s>]/g)}, text "${h1Text(pdp.body)}"`,
  );
  record("R10", "PDP <title> contains the name", title(pdp.body).includes(p.name), `title "${title(pdp.body)}"`);
  const atc = formWith(pdp.body, "productId");
  record(
    "R11",
    "PDP has an add-to-cart form (productId + quantity + $ACTION fields)",
    !!atc && atc.includes('name="quantity"') && atc.includes("$ACTION_"),
    atc ? excerpt(atc.match(/<form[^>]*>/)?.[0] ?? "") : "no form with productId",
  );

  const oos = await http(`/products/${outOfStock.slug}`);
  record("R12", `/products/${outOfStock.slug} (stock 0) status 200`, oos.status === 200, `status ${oos.status}`);
  // Phase 2 (T78 BuyBox v2): the disabled "Out of stock" button became "Out of stock" text plus a
  // back-in-stock "Notify me" form and an add-to-list form, so the MVP "no productId form" rule now means
  // "no add-to-cart form" (no quantity field, no Add to cart / Buy Now button).
  // Phase 3 (T169 PDP v3): the related/also-bought/also-viewed rails carry quick-add forms (hidden
  // productId + quantity=1) for OTHER products, so the rule is now scoped to this product: no form posting
  // its productId with a quantity, no Add to cart / Buy Now button for it, and no visible quantity input.
  const oosText = textOf(oos.body);
  const cartForm = forms(oos.body).find(
    (f) => f.includes(`value="${outOfStock.id}"`) && (f.includes('name="quantity"') || />\s*(Add to cart|Buy Now)\s*</.test(f)),
  );
  const visibleQty = tags(htmlOnly(oos.body), "input").map(attrs).filter((a) => a.get("name") === "quantity" && a.get("type") !== "hidden");
  const railForms = forms(oos.body).filter((f) => f.includes('name="quantity" value="1"') && !f.includes(`value="${outOfStock.id}"`)).length;
  record(
    "R13",
    'stock-0 PDP: "Out of stock" shown, no visible quantity input, no add-to-cart/Buy Now form for this product (v2: "Notify me" form instead; v3: rail quick-add forms for other products allowed)',
    oosText.includes("Out of stock") && visibleQty.length === 0 && !cartForm && /Notify me when available/.test(oosText),
    `"Out of stock" ${oosText.includes("Out of stock")}; visible quantity inputs ${visibleQty.length}; own add-to-cart form ${!!cartForm}; notify form ${/Notify me when available/.test(oosText)}; rail quick-add forms for other products ${railForms}`,
  );

  const nope = await http("/products/nope");
  record("R14", "/products/nope 404", nope.status === 404, soft404(nope));
  const logBefore = state.serverLog.length;
  const sqli = await http("/products/%27%20OR%201%3D1%20--");
  await Bun.sleep(150);
  const sqlErr = /sqlite|SQL|syntax error/i.test(state.serverLog.slice(logBefore));
  record("R15", "/products/%27%20OR%201%3D1%20-- 404, no SQL error in server log", sqli.status === 404 && !sqlErr, `${soft404(sqli)}, sql error in log: ${sqlErr}`);

  const cart = await http("/cart");
  record(
    "R16",
    "/cart (no cookie) 200, empty state, no checkout link",
    cart.status === 200 && cart.body.includes("Your cart is empty") && !cart.body.includes('href="/checkout"'),
    `status ${cart.status}, empty: ${cart.body.includes("Your cart is empty")}, checkout link: ${cart.body.includes('href="/checkout"')}`,
  );

  // Ruling D-T109-1 (accepted): an empty/blocked cart gets a 200 page linking to /cart instead of a redirect.
  const co = await http("/checkout");
  record(
    "R17",
    "/checkout (no cookie): 200 empty state with a link to /cart, no checkout form, no meta refresh (MVP: 3xx; ruling D-T109-1)",
    co.status === 200 && co.body.includes('href="/cart"') && !co.body.includes('name="idempotencyKey"') && !/http-equiv="refresh"/.test(co.body),
    `status ${co.status}, location ${co.location}, /cart link ${co.body.includes('href="/cart"')}, form ${co.body.includes('name="idempotencyKey"')}`,
  );

  const rnd = await http(`/orders/${crypto.randomUUID()}`);
  record("R18", "/orders/<random uuid> 404", rnd.status === 404, soft404(rnd));
  randomOrderTitle = title(rnd.body);
  const bad = await http("/orders/not-a-uuid");
  record("R19", "/orders/not-a-uuid 404", bad.status === 404, soft404(bad));
  record(
    "R21",
    "JS disabled: / page content (h1) is in the static HTML, not only inside PPR-streamed <div hidden> blocks",
    "info",
    `first <h1> at ${home.body.indexOf("<h1")}, first streamed hidden div at ${firstStreamedDiv(home.body)}: ${home.body.indexOf("<h1") > firstStreamedDiv(home.body) && firstStreamedDiv(home.body) > 0 ? "h1 only in a hidden streamed block (a JS-disabled browser shows only the Loading… fallback)" : "h1 in shell"}`,
  );
  const nf = await http("/definitely-not-a-route");
  record(
    "R20",
    '/definitely-not-a-route 404 with "Page not found" and a link home',
    nf.status === 404 && nf.body.includes("Page not found") && nf.body.includes('href="/"'),
    `status ${nf.status}, text: ${nf.body.includes("Page not found")}`,
  );
}

type FlowCtx = { orderUrl: string | null; filledCartJar: CookieJar | null; checkoutJar: CookieJar | null; orderJar: CookieJar | null };

async function addToCart(jar: CookieJar, slug: string, quantity: string, label: string): Promise<{ page: Resp; post: Resp } | null> {
  const page = await http(`/products/${slug}`, { jar, label: `GET /products/${slug} (${label})` });
  const form = formWith(page.body, "productId");
  if (!form) return null;
  const action = attrs(form.match(/<form\b[^>]*>/)?.[0] ?? "").get("action") || `/products/${slug}`;
  const fields = hiddenFields(form);
  fields.push(["quantity", quantity]);
  const post = await http(action.startsWith("/") ? action : `/products/${slug}`, {
    jar,
    form: toFormData(fields),
    label: `POST add-to-cart ${slug} qty=${quantity} (${label})`,
  });
  return { page, post };
}

function checkoutFields(form: string, card: string): Array<[string, string]> {
  return [
    ...hiddenFields(form),
    ["fullName", "Ada Lovelace"],
    ["email", "ada@example.com"],
    ["line1", "1 Analytical Way"],
    ["line2", ""],
    ["city", "Springfield"],
    ["region", "IL"],
    ["postalCode", "62701"],
    ["country", "US"],
    ["nameOnCard", "Ada Lovelace"],
    ["number", card],
    ["expMonth", "12"],
    ["expYear", "2030"],
    ["cvc", CVC],
  ];
}

async function cartFlow(products: Products, ctx: FlowCtx): Promise<void> {
  const p = products[0];
  const limited = q<Product>("SELECT * FROM products WHERE stock BETWEEN 1 AND 5 ORDER BY stock LIMIT 1")[0];
  const jar = new CookieJar();

  const r = await addToCart(jar, p.slug, "2", "A");
  if (!r) {
    record("C01", "no-JS add-to-cart form replay (multipart, $ACTION_* fields)", false, "add-to-cart form not found");
    return;
  }
  const setCookie = jar.setCookieHeaders.find((h) => h.startsWith("sf_session=")) ?? "";
  record(
    "C01",
    "no-JS add-to-cart POST (multipart/form-data, $ACTION_* replay) 2xx/3xx",
    r.post.status >= 200 && r.post.status < 400,
    `status ${r.post.status}; "Added 2 to your cart." in response: ${r.post.body.includes("Added 2 to your cart.")}`,
  );
  noJsFeedback.push(['"Added 2 to your cart."', htmlOnly(r.post.body).includes("Added 2 to your cart.")]);
  record(
    "C02",
    "Set-Cookie sf_session=<uuid>; HttpOnly",
    /^sf_session=[0-9a-f-]{36};/i.test(setCookie) && /;\s*HttpOnly/i.test(setCookie),
    excerpt(setCookie.replace(/=[0-9a-f-]{36}/, "=<uuid>"), 140),
  );
  const session = jar.cookies.get("sf_session") ?? "";

  const cart = await http("/cart", { jar, label: "GET /cart (A)" });
  const qtyInput = tags(cart.body, "input").map(attrs).find((a) => a.get("name") === "quantity");
  const lineTotal = usd(p.price_cents * 2);
  record(
    "C03",
    `/cart with cookie: 200, quantity 2, line total ${lineTotal}, "Proceed to checkout" link`,
    cart.status === 200 &&
      qtyInput?.get("value") === "2" &&
      cart.body.includes(lineTotal) &&
      /<a\b[^>]*href="\/checkout"[^>]*>\s*Proceed to checkout/.test(cart.body),
    `status ${cart.status}, qty ${qtyInput?.get("value")}, total present ${cart.body.includes(lineTotal)}`,
  );

  const home = await http("/", { jar, label: "GET / (A)" });
  record("C04", '/ with cookie contains "Cart, 2 items"', home.body.includes("Cart, 2 items"), `streamed count present: ${home.body.includes("Cart, 2 items")}`);

  const big = await addToCart(jar, p.slug, "999", "A");
  record(
    "C05",
    "POST quantity=999: no 500, inline error, cart unchanged (DB qty 2)",
    !!big && big.post.status < 500 && cartQty(session, p.id) === 2 && /between 1 and|whole number/i.test(big.post.body),
    big
      ? `status ${big.post.status}, DB qty ${cartQty(session, p.id)}, message: ${excerpt(big.post.body.match(/Please (choose|enter)[^<"]*/)?.[0] ?? "none")}`
      : "no form",
  );
  if (big) noJsFeedback.push(["qty 999 error", /Please choose a quantity between 1 and/.test(htmlOnly(big.post.body))]);

  if (limited) {
    const over = await addToCart(jar, limited.slug, String(limited.stock + 1), "A");
    record(
      "C06",
      `over-stock add (${limited.slug}, stock ${limited.stock}, qty ${limited.stock + 1}): inline "Only N left" error, no cart line`,
      !!over && over.post.status < 500 && cartQty(session, limited.id) === 0 && over.post.body.includes(`Only ${limited.stock} left in stock.`),
      over ? `status ${over.post.status}, DB qty ${cartQty(session, limited.id)}` : "no form",
    );
    if (over) noJsFeedback.push([`"Only ${limited.stock} left in stock."`, htmlOnly(over.post.body).includes(`Only ${limited.stock} left in stock.`)]);
  }

  const cart2 = await http("/cart", { jar, label: "GET /cart (A, after rejected adds)" });
  const qty2 = tags(cart2.body, "input").map(attrs).find((a) => a.get("name") === "quantity")?.get("value");
  record("C07", "/cart after rejected adds still shows exactly the one line, quantity 2", qty2 === "2" && count(cart2.body, /name="quantity"/g) === 1, `qty ${qty2}, quantity inputs ${count(cart2.body, /name="quantity"/g)}`);

  // Garbage cookie (T27 criterion 5)
  const garbage = new CookieJar();
  garbage.cookies.set("sf_session", "not-a-session'--");
  const gCart = await http("/cart", { jar: garbage, label: "GET /cart (garbage cookie)" });
  record("C08", "garbage sf_session: /cart 200 empty state", gCart.status === 200 && gCart.body.includes("Your cart is empty"), `status ${gCart.status}`);
  const gAdd = await addToCart(garbage, products[1].slug, "1", "garbage");
  const fresh = garbage.cookies.get("sf_session") ?? "";
  record("C09", "garbage sf_session: first add mints a fresh UUID session", !!gAdd && gAdd.post.status < 400 && UUID_RE.test(fresh), `new cookie is uuid: ${UUID_RE.test(fresh)}`);

  // Cart page no-JS update / over-stock update / remove (T23 criteria 2 and 3), on the fresh session
  const gp = products[1];
  const gSession = garbage.cookies.get("sf_session") ?? "";
  const cartForm = async (kind: "update" | "remove"): Promise<string | undefined> => {
    const page = await http("/cart", { jar: garbage, label: `GET /cart (garbage→fresh, ${kind})` });
    return forms(page.body).find(
      (f) => f.includes(`name="productId"`) && (kind === "update" ? f.includes('name="quantity"') : !f.includes('name="quantity"')),
    );
  };
  const upd = await cartForm("update");
  if (upd) {
    const res = await http("/cart", { jar: garbage, form: toFormData([...hiddenFields(upd), ["quantity", "3"]]), label: "POST cart update qty=3" });
    const cartNow = await http("/cart", { jar: garbage, label: "GET /cart after update" });
    record(
      "C10",
      `no-JS cart update to 3: DB qty 3, line total ${usd(gp.price_cents * 3)} on /cart`,
      res.status < 400 && cartQty(gSession, gp.id) === 3 && cartNow.body.includes(usd(gp.price_cents * 3)),
      `status ${res.status}, DB qty ${cartQty(gSession, gp.id)}`,
    );
    const upd2 = await cartForm("update");
    const over = upd2
      ? await http("/cart", { jar: garbage, form: toFormData([...hiddenFields(upd2), ["quantity", String(Math.min(gp.stock + 1, 99))]]), label: "POST cart update over stock" })
      : null;
    record(
      "C11",
      `no-JS cart update above stock (${Math.min(gp.stock + 1, 99)} > ${gp.stock}): no 500, quantity stays 3, error in response`,
      !!over && over.status < 500 && cartQty(gSession, gp.id) === 3 && /Only \d+ left in stock\.|between 1 and/.test(over.body),
      over ? `status ${over.status}, DB qty ${cartQty(gSession, gp.id)}, message ${excerpt(over.body.match(/Only \d+ left in stock\.|Please choose[^"<]*/)?.[0] ?? "none")}` : "no update form",
    );
  } else record("C10", "no-JS cart update form found on /cart", false, "no form with productId + quantity");
  const rem = await cartForm("remove");
  if (rem) {
    const res = await http("/cart", { jar: garbage, form: toFormData(hiddenFields(rem)), label: "POST cart remove" });
    const after = await http("/cart", { jar: garbage, label: "GET /cart after remove" });
    record(
      "C12",
      "no-JS remove of the last line: empty state, no checkout link",
      res.status < 400 && cartQty(gSession, gp.id) === 0 && after.body.includes("Your cart is empty") && !after.body.includes('href="/checkout"'),
      `status ${res.status}, DB qty ${cartQty(gSession, gp.id)}`,
    );
    const co = await http("/checkout", { jar: garbage, label: "GET /checkout (valid session, empty cart)" });
    record(
      "C13",
      "/checkout with a valid session but empty cart: 200 empty state linking /cart, no form (MVP: redirect; ruling D-T109-1)",
      co.status === 200 && co.body.includes('href="/cart"') && !co.body.includes('name="idempotencyKey"') && !/http-equiv="refresh"/.test(co.body),
      `status ${co.status}, location ${co.location}, form ${co.body.includes('name="idempotencyKey"')}, meta refresh ${/http-equiv="refresh" content="[^"]*url=\/cart"/.test(co.body)}`,
    );
  } else record("C12", "no-JS remove form found on /cart", false, "no form with productId only");

  ctx.checkoutJar = jar;
}

async function checkoutFlow(products: Products, ctx: FlowCtx): Promise<void> {
  const jar = ctx.checkoutJar;
  if (!jar) return;
  const p = products[0];

  const page = await http("/checkout", { jar, label: "GET /checkout (A)" });
  const form = formWith(page.body, "idempotencyKey");
  const key = form ? hiddenFields(form).find(([k]) => k === "idempotencyKey")?.[1] ?? "" : "";
  const fieldNames = ["fullName", "email", "line1", "line2", "city", "region", "postalCode", "country", "nameOnCard", "number", "expMonth", "expYear", "cvc"];
  const missing = fieldNames.filter((n) => !form?.includes(`name="${n}"`));
  record(
    "K01",
    "/checkout with cookie: 200, hidden idempotencyKey (UUID), all address/card fields",
    page.status === 200 && UUID_RE.test(key) && missing.length === 0,
    `status ${page.status}, key uuid ${UUID_RE.test(key)}, missing ${missing.join(",") || "none"}`,
  );
  if (!form) return;

  const stockBefore = stockOf(p.id);
  const fields = checkoutFields(form, GOOD_CARD);
  const post = await http("/checkout", { jar, form: toFormData(fields), label: "POST checkout 4242 (A)" });
  const orderPath = post.location ? new URL(post.location, state.BASE).pathname : "";
  record(
    "K02",
    "no-JS checkout POST (4242) redirects to /orders/<uuid> (v2: ?placed=1 query)",
    post.status >= 300 && post.status < 400 && /^\/orders\/[0-9a-f-]{36}$/i.test(orderPath),
    `status ${post.status}, Location ${post.location}`,
  );
  if (!orderPath) return;
  ctx.orderUrl = orderPath;
  ctx.orderJar = jar;

  // FIX-checkout-placed: the success redirect carries ?placed=1, which alone shows the thank-you banner.
  const placedUrl = post.location ? new URL(post.location, state.BASE) : null;
  const order = await http(placedUrl ? placedUrl.pathname + placedUrl.search : orderPath, { jar, label: "GET order ?placed=1 (A)" });
  const total = usd(p.price_cents * 2);
  record(
    "K03",
    `order page (Location incl. ?placed=1) with cookie: 200, "Thank you for your order", item, "Card ending in 4242", total ${total}`,
    order.status === 200 &&
      order.body.includes("Thank you for your order") &&
      order.body.includes(p.name) &&
      order.body.includes("Card ending in 4242") &&
      order.body.includes(total),
    `status ${order.status}, thanks ${order.body.includes("Thank you for your order")}, item ${order.body.includes(p.name)}, last4 ${order.body.includes("Card ending in 4242")}, total ${order.body.includes(total)}`,
  );
  const anon = await http(orderPath, { label: "GET order (no cookie)" });
  record("K04", "order page without cookie: 404", anon.status === 404, soft404(anon));

  const emptied = await http("/cart", { jar, label: "GET /cart (A, after order)" });
  record("K05", "/cart after order: empty state", emptied.body.includes("Your cart is empty"), `empty ${emptied.body.includes("Your cart is empty")}`);
  record("K06", "stock decremented by 2 after paid order", stockOf(p.id) === stockBefore - 2, `before ${stockBefore}, after ${stockOf(p.id)}`);

  const replay = await http("/checkout", { jar, form: toFormData(fields), label: "POST checkout replay same key (A)" });
  const replayPath = replay.location ? new URL(replay.location, state.BASE).pathname : "";
  record(
    "K07",
    "replay same POST (same idempotencyKey): same order URL, orders count still 1, stock unchanged",
    replayPath === orderPath && orderCount() === 1 && stockOf(p.id) === stockBefore - 2,
    `status ${replay.status}, Location ${replay.location}, orders ${orderCount()}, stock ${stockOf(p.id)}`,
  );

  // Decline path with a new session + new key
  const jarB = new CookieJar();
  const q2 = products[1];
  await addToCart(jarB, q2.slug, "1", "B");
  const coB = await http("/checkout", { jar: jarB, label: "GET /checkout (B)" });
  const formB = formWith(coB.body, "idempotencyKey");
  if (!formB) {
    record("K08", "decline: checkout form for session B", false, `status ${coB.status}`);
    return;
  }
  const keyB = hiddenFields(formB).find(([k]) => k === "idempotencyKey")?.[1];
  const stockB = stockOf(q2.id);
  const paidBefore = orderCount("paid");
  const decl = await http("/checkout", { jar: jarB, form: toFormData(checkoutFields(formB, DECLINE_CARD)), label: "POST checkout 4000...0002 (B)" });
  record(
    "K08",
    "decline (4000000000000002, new session, new key): response carries PAYMENT_FAILED + decline message, no redirect",
    decl.status < 300 && decl.body.includes("Your card was declined.") && decl.body.includes("PAYMENT_FAILED") && keyB !== key,
    `status ${decl.status}, Location ${decl.location}, message: ${excerpt(decl.body.match(/Your card was declined[^<"]*/)?.[0] ?? "none")}`,
  );
  noJsFeedback.push(['"Your card was declined."', htmlOnly(decl.body).includes("Your card was declined.")]);
  noJsFeedback.push([
    "fullName re-filled",
    /name="fullName"[^>]*value="Ada Lovelace"|value="Ada Lovelace"[^>]*name="fullName"/.test(htmlOnly(decl.body)),
  ]);
  const cartB = await http("/cart", { jar: jarB, label: "GET /cart (B, after decline)" });
  const qtyB = tags(cartB.body, "input").map(attrs).find((a) => a.get("name") === "quantity")?.get("value");
  record("K10", "decline: /cart still has the line", cartB.status === 200 && qtyB === "1" && cartB.body.includes(q2.name), `qty ${qtyB}`);
  record("K11", "decline: stock unchanged, no new paid order", stockOf(q2.id) === stockB && orderCount("paid") === paidBefore, `stock ${stockB} -> ${stockOf(q2.id)}, paid orders ${paidBefore} -> ${orderCount("paid")}`);
  ctx.filledCartJar = jarB;

  const crossB = await http(orderPath, { jar: jarB, label: "GET order A with session B" });
  record("K12", "order page with another session's cookie: 404", crossB.status === 404, soft404(crossB));
  const leaks = (r: Resp): string[] =>
    [p.name, "Ada Lovelace", "1 Analytical Way", "Card ending in", "Thank you for your order"].filter((t) => r.body.includes(t));
  record(
    "K14",
    "no existence leak: no-cookie and other-session order responses carry no order data and the same <title> as a random id",
    leaks(anon).length === 0 && leaks(crossB).length === 0 && title(anon.body) === randomOrderTitle && title(crossB.body) === randomOrderTitle,
    `no-cookie leaks [${leaks(anon).join(", ")}], cross-session leaks [${leaks(crossB).join(", ")}], titles "${title(anon.body)}" / "${title(crossB.body)}" / random "${randomOrderTitle}"`,
  );

  // Retry after decline with a fresh key and the good card (T27 criterion 2)
  const coB2 = await http("/checkout", { jar: jarB, label: "GET /checkout (B, retry)" });
  const formB2 = formWith(coB2.body, "idempotencyKey");
  const keyB2 = formB2 ? hiddenFields(formB2).find(([k]) => k === "idempotencyKey")?.[1] : undefined;
  if (formB2) {
    // a11y snapshot of checkout must be taken before the cart is emptied
    a11ySnapshots.push(["/checkout (filled cart)", coB2.body]);
    a11ySnapshots.push(["/cart (filled)", cartB.body]);
    const retry = await http("/checkout", { jar: jarB, form: toFormData(checkoutFields(formB2, GOOD_CARD)), label: "POST checkout retry 4242 (B)" });
    record(
      "K13",
      "retry after decline with a fresh key + 4242 succeeds (redirect to a new order)",
      retry.status >= 300 && retry.status < 400 && /\/orders\//.test(retry.location ?? "") && keyB2 !== keyB && orderCount("paid") === paidBefore + 1,
      `status ${retry.status}, Location ${retry.location}, fresh key ${keyB2 !== keyB}, paid orders ${orderCount("paid")}`,
    );
  }

  const checkoutForm = async (jarX: CookieJar, who: string): Promise<string | undefined> =>
    formWith((await http("/checkout", { jar: jarX, label: `GET /checkout (${who})` })).body, "idempotencyKey");

  // Validation failure (T24 criterion 6): bad card number, blank city
  const jarV = new CookieJar();
  await addToCart(jarV, products[1].slug, "1", "V");
  const formV = await checkoutForm(jarV, "V");
  if (formV) {
    const fields = checkoutFields(formV, "1234567812345678").map(([k, v]): [string, string] => [k, k === "city" ? "" : v]);
    const res = await http("/checkout", { jar: jarV, form: toFormData(fields), label: "POST checkout invalid card + blank city (V)" });
    record(
      "K15",
      "validation failure (non-Luhn card, blank city): no redirect, VALIDATION_FAILED with per-field errors for number and city",
      res.status < 300 && res.body.includes("VALIDATION_FAILED") && /\\?"number\\?":\{/.test(res.body) && /\\?"city\\?":\{/.test(res.body) && !res.body.includes("1234567812345678"),
      `status ${res.status}, VALIDATION_FAILED ${res.body.includes("VALIDATION_FAILED")}, card echoed ${res.body.includes("1234567812345678")}`,
    );
  }

  // Concurrent double submit with one key (T24 criterion 4)
  const jarC = new CookieJar();
  await addToCart(jarC, products[1].slug, "1", "C");
  const formC = await checkoutForm(jarC, "C");
  if (formC) {
    const paid0 = orderCount("paid");
    const stock0 = stockOf(products[1].id);
    const fields = checkoutFields(formC, GOOD_CARD);
    const [a, b] = await Promise.all([
      http("/checkout", { jar: jarC, form: toFormData(fields), label: "POST checkout concurrent #1 (C)" }),
      http("/checkout", { jar: jarC, form: toFormData(fields), label: "POST checkout concurrent #2 (C)" }),
    ]);
    record(
      "K16",
      "concurrent double submit (same key, Promise.all): both redirect to the same order, exactly one new paid order, stock -1",
      !!a.location && a.location === b.location && orderCount("paid") === paid0 + 1 && stockOf(products[1].id) === stock0 - 1,
      `statuses ${a.status}/${b.status}, locations ${a.location} / ${b.location}, paid ${paid0} -> ${orderCount("paid")}, stock ${stock0} -> ${stockOf(products[1].id)}`,
    );
  }

  // Last-unit contention between two sessions (T27 criterion 3, T24 criterion 5)
  const last = q<Product>("SELECT * FROM products WHERE stock = 1 LIMIT 1")[0];
  if (last) {
    const jarD = new CookieJar();
    const jarE = new CookieJar();
    await addToCart(jarD, last.slug, "1", "D");
    await addToCart(jarE, last.slug, "1", "E");
    const [fD, fE] = await Promise.all([checkoutForm(jarD, "D"), checkoutForm(jarE, "E")]);
    if (fD && fE) {
      const paid0 = orderCount("paid");
      const [d, e] = await Promise.all([
        http("/checkout", { jar: jarD, form: toFormData(checkoutFields(fD, GOOD_CARD)), label: "POST checkout last unit (D)" }),
        http("/checkout", { jar: jarE, form: toFormData(checkoutFields(fE, GOOD_CARD)), label: "POST checkout last unit (E)" }),
      ]);
      const isRedirectTo = (r: Resp, re: RegExp): boolean =>
        r.status >= 300 && r.status < 400 && re.test(r.location ? new URL(r.location, state.BASE).pathname : "");
      const pairs: Array<[Resp, CookieJar]> = [[d, jarD], [e, jarE]];
      const winners = pairs.filter(([r]) => isRedirectTo(r, /^\/orders\/[0-9a-f-]{36}$/i));
      const loserPair = pairs.find(([r]) => !isRedirectTo(r, /^\/orders\//));
      // The loser may (a) get an inline STOCK_CHANGED re-render naming the item, or (b) without JS, have the
      // re-render find canCheckout === false and get a real 3xx to /cart, where the line shows as unavailable.
      let loserMode = "none";
      let loserOk = false;
      if (loserPair) {
        const [lr, lj] = loserPair;
        if (lr.status < 300 && lr.body.includes("STOCK_CHANGED") && lr.body.includes(last.name)) {
          loserMode = "inline STOCK_CHANGED";
          loserOk = true;
        } else if (isRedirectTo(lr, /^\/cart$/)) {
          const lc = await http("/cart", { jar: lj, label: "GET /cart (last-unit loser)" });
          const warn = lc.body.includes("Remove unavailable items to continue to checkout");
          const noLink = !lc.body.includes('href="/checkout"');
          loserMode = `${lr.status} -> /cart (unavailable warning ${warn}, item ${lc.body.includes(last.name)}, no checkout link ${noLink})`;
          loserOk = lc.status === 200 && warn && noLink && lc.body.includes(last.name);
        } else loserMode = `unexpected status ${lr.status} Location ${lr.location}`;
      }
      record(
        "K17",
        `last-unit contention (${last.slug}, stock 1, two sessions): exactly one order, stock 0, loser gets inline STOCK_CHANGED naming the item OR a 3xx to /cart showing the unavailable warning without a checkout link`,
        winners.length === 1 && orderCount("paid") === paid0 + 1 && stockOf(last.id) === 0 && loserOk,
        `statuses ${d.status}/${e.status}, paid ${paid0} -> ${orderCount("paid")}, stock ${stockOf(last.id)}, loser: ${loserMode}`,
      );
    }
  }
  record("K18", "orders table after all flows (incl. payment_failed rows written by declines)", "info", `paid ${orderCount("paid")}, payment_failed ${orderCount("payment_failed")}`);
}

const a11ySnapshots: Array<[string, string]> = [];

function a11yChecks(): void {
  for (const [label, html] of a11ySnapshots) {
    const h1 = count(html, /<h1[\s>]/g);
    const main = count(html, /<main[\s>]/g);
    const unl = unlabelledControls(html);
    const outline = html.includes("outline-none");
    const t = title(html);
    const ok = h1 === 1 && main === 1 && unl.length === 0 && !outline && t.length > 0;
    record("A11Y", `${label}: one h1, one main, labelled controls, no outline-none, title`, ok, `h1 ${h1}, main ${main}, unlabelled [${unl.join(", ")}], outline-none ${outline}, title "${t}"`);
  }
}

function sensitiveScan(): void {
  const hits: string[] = [];
  for (const { label, resp } of scanned) {
    const hay = `${resp.location ?? ""}\n${[...resp.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${stripTestCardHint(resp.body)}`;
    const spaced = (n: string) => n.replace(/(\d{4})(?=\d)/g, "$1 ");
    for (const card of [GOOD_CARD, DECLINE_CARD]) {
      if (hay.includes(card) || hay.includes(spaced(card))) hits.push(`${label}: full card ${card}`);
    }
    if (/name="cvc"[^>]*\svalue="[^"]+"|\svalue="[^"]+"[^>]*name="cvc"|"cvc"\s*:\s*"|cvc=\d/.test(hay)) hits.push(`${label}: cvc value`);
    if (/name="number"[^>]*\svalue="\d|"number"\s*:\s*"\d{12,}/.test(hay)) hits.push(`${label}: card number field echoed`);
  }
  record("S01", `no full card number / CVC in any step 4-5 response (${scanned.length} responses scanned, static test-card hint excluded)`, hits.length === 0, hits.join("; ") || "clean");
  const hinted = scanned.filter(({ resp }) => resp.body.includes(GOOD_CARD)).length;
  record("S02", "static \"Test mode\" hint lists the mock card numbers in production HTML", "info", `${hinted} responses contain it (fixed list from PaymentFields, not user input)`);
}

// ---------------------------------------------------------------- Phase 2 log scan (criterion 10, AR1)

const sectionTimes: string[] = [];

function logLeakScan(): void {
  state.section = "LOG2";
  const log = state.serverLog;
  const unstable = log.split("\n").filter((l) => /unstable value|while prerendering|Date\.now\(\)|Math\.random\(\)|crypto\.randomUUID\(\)/i.test(l));
  record("LOG2-01", "server log: no unstable-value / prerender warnings", unstable.length === 0, unstable.slice(0, 3).map((l) => excerpt(l, 120)).join(" | ") || "clean");
  const unhandled = log.split("\n").filter((l) => /unhandled|uncaught|TypeError|ReferenceError|SyntaxError|RangeError|SQLITE_|digest:/i.test(l));
  record("LOG2-02", "server log: no unhandled errors / exceptions / SQLite errors", unhandled.length === 0, unhandled.slice(0, 3).map((l) => excerpt(l, 120)).join(" | ") || "clean");
  const argon = /\$argon2/.test(log);
  const tokens = P2.sensitiveStrings().filter((t) => t.length > 10 && log.includes(t));
  const cards = [GOOD_CARD, DECLINE_CARD, "1234567812345678"].filter((c) => log.includes(c));
  const emails = [...new Set(log.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])];
  const passwords = ["Smoke-pass-1234 horse", "Wrong-password-"].filter((p) => log.includes(p));
  record(
    "LOG2-03",
    "server log: no $argon2 hash, sf_auth token, password, card number or email address",
    !argon && tokens.length === 0 && cards.length === 0 && emails.length === 0 && passwords.length === 0,
    `argon2 ${argon}, tokens ${tokens.length}, passwords ${passwords.length}, cards [${cards.join(",")}], emails [${emails.slice(0, 5).join(",")}]`,
  );
  record("LOG2-04", "server log size and line count", "info", `${log.length} bytes, ${log.split("\n").length} lines${log.trim() ? `; first lines: ${excerpt(log.trim().split("\n").slice(0, 4).join(" / "), 200)}` : ""}`);
  const leakedTokens = P2.sensitiveStrings().filter((t) =>
    allResponses.some(({ resp }) => resp.body.includes(t) || (resp.location ?? "").includes(t)),
  );
  const hashLeak = allResponses.filter(({ resp }) => /\$argon2/.test(resp.body)).map(({ label }) => label);
  record("LOG2-05", "no sf_auth token (outside Set-Cookie) or $argon2 hash in any response body/Location", leakedTokens.length === 0 && hashLeak.length === 0, `tokens ${leakedTokens.length}, argon2 in [${hashLeak.slice(0, 3).join(" | ")}]`);
  state.section = "MVP"; // TEARDOWN rows belong to the MVP set
}

// ---------------------------------------------------------------- main

const runStart = performance.now();

async function main(): Promise<number> {
  if (!existsSync(join(ROOT, ".next", "BUILD_ID"))) {
    console.error("No production build found (.next/BUILD_ID). Run `bun run build` first.");
    return 2;
  }
  let port = Number(process.env.SMOKE_PORT ?? 3105);
  while (!(await portFree(port))) port++;
  state.BASE = `http://localhost:${port}`;

  cleanDbFiles();
  const seed = await run(["bun", "run", "seed"], { DATABASE_PATH: DB_REL });
  if (seed.code !== 0) {
    console.error("seed failed:\n" + seed.out);
    return 2;
  }
  record("SETUP", `seed ${DB_REL}`, true, excerpt(seed.out.trim().split("\n").pop() ?? ""));

  const server = Bun.spawn(["bun", "run", "start"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_PATH: DB_REL, PORT: String(port), NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  void pump(server.stdout);
  void pump(server.stderr);

  const latency: string[] = [];
  try {
    const deadline = Date.now() + 30_000;
    while (!(await portAccepts(port))) {
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`server did not accept connections on ${port}\n${state.serverLog}`);
      await Bun.sleep(100);
    }
    record("SETUP", `next start (production) on :${port}, pid ${server.pid}`, true);

    const products = q<Product>("SELECT * FROM products WHERE stock >= 10 ORDER BY name");
    const outOfStock = q<Product>("SELECT * FROM products WHERE stock = 0 LIMIT 1")[0];
    const first = products[0];
    if (!first || !products[1] || !outOfStock) throw new Error("seed must contain 2 products with stock >= 10 and one with stock 0");
    const pdpPath = `/products/${first.slug}`;
    const inStock = products as unknown as Products;

    // Step 7 (first, so "cold" is the first HTTP request the server sees)
    const coldHome = await http("/");
    const coldPdp = await http(pdpPath);
    const warm = async (path: string): Promise<number> => {
      const t: number[] = [];
      for (let i = 0; i < 7; i++) t.push((await http(path)).ttfbMs);
      return t.sort((a, b) => a - b)[3] ?? Number.NaN;
    };
    const warmHome = await warm("/");
    const warmPdp = await warm(pdpPath);
    latency.push(`/ cold ${coldHome.ttfbMs.toFixed(1)} ms, warm median ${warmHome.toFixed(1)} ms`);
    latency.push(`${pdpPath} cold ${coldPdp.ttfbMs.toFixed(1)} ms, warm median ${warmPdp.toFixed(1)} ms`);
    for (const l of latency) record("TTFB", l, "info");

    markLog();
    await routeChecks(inStock, outOfStock);
    markLog();

    const homeForA11y = await http("/");
    const pdpForA11y = await http(pdpPath);
    a11ySnapshots.push(["/", homeForA11y.body], [pdpPath, pdpForA11y.body]);

    state.scanning = true;
    const ctx: FlowCtx = { orderUrl: null, filledCartJar: null, checkoutJar: null, orderJar: null };
    await cartFlow(inStock, ctx);
    markLog();
    await checkoutFlow(inStock, ctx);
    markLog();
    state.scanning = false;
    record(
      "NJ01",
      "no-JS: action results are rendered in the server HTML (not only in the RSC payload applied at hydration)",
      noJsFeedback.length > 0 && noJsFeedback.every(([, ok]) => ok),
      noJsFeedback.map(([n, ok]) => `${n}: ${ok ? "in HTML" : "payload only"}`).join("; "),
    );
    sensitiveScan();

    if (ctx.orderUrl && ctx.orderJar) {
      const orderPage = await http(ctx.orderUrl, { jar: ctx.orderJar });
      a11ySnapshots.push([`order page ${ctx.orderUrl.slice(0, 16)}…`, orderPage.body]);
    }
    a11yChecks();

    // Informational: urlencoded replay of the add-to-cart form
    const jarU = new CookieJar();
    const pageU = await http(pdpPath, { jar: jarU });
    const formU = formWith(pageU.body, "productId");
    if (formU) {
      const body = new URLSearchParams([...hiddenFields(formU), ["quantity", "1"]]);
      const res = await fetch(state.BASE + pdpPath, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: state.BASE },
        body,
        redirect: "manual",
      });
      const text = await res.text();
      record(
        "INFO",
        "add-to-cart replayed as application/x-www-form-urlencoded (form declares multipart)",
        "info",
        `status ${res.status}, Set-Cookie ${res.headers.getSetCookie().length > 0}, "Added" in body ${text.includes("Added 1")} (not treated as an action by Next)`,
      );
    }
    markLog();

    // ------------------------------------------------------------ Phase 2 (T113)
    if (!process.env.SMOKE_MVP_ONLY) {
      const timed = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
        const t0 = performance.now();
        try {
          await fn();
        } catch (e) {
          record("FATAL", `exception in Phase 2 section ${name}`, false, excerpt(String(e instanceof Error ? e.stack : e), 400));
        }
        sectionTimes.push(`${name} ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        markLog();
      };
      const fx = P2.loadFixtures();
      let pages = new Map<string, Resp>();
      const flow: P2.FlowState = { orderPath: null, orderJar: null, listId: null, listJar: null, addressName: "", addressJar: null };
      await timed("P/GC public routes", async () => {
        pages = await P2.publicRoutes(fx);
      });
      await timed("N 404s", () => P2.notFounds());
      await timed("SEO", () => P2.seoChecks(fx, pages));
      await timed("FM forms", () => P2.formChecks(fx, pages));
      await timed("F no-JS flows", () => P2.noJsFlows(fx, flow));
      await timed("XSS", () => P2.xssChecks(fx, flow));
      await timed("ISO isolation", () => P2.isolationChecks(flow));
      await timed("H hostile search", () => P2.hostileSearch());
      await timed("RL rate limits", () => P2.rateLimitChecks(fx));
      await timed("ACC accounts", () => P2.accountChecks(fx));
      await timed("RL suggest", () => P2.suggestChecks());
      await timed("P3 redesign", async () => {
        await P3.phase3(P3.loadFixtures3());
      });
      P2.javascriptActionScan();
    }
    await Bun.sleep(300);
  } catch (e) {
    record("FATAL", "unexpected exception", false, String(e instanceof Error ? e.stack : e));
  } finally {
    state.section = "MVP";
    // Server log: any error line is a failure; attribute it to the check that preceded it.
    const errLines: string[] = [];
    let offset = 0;
    for (const line of state.serverLog.split("\n")) {
      if (/^\s*(Error|⨯|error:)/.test(line) && !/exited with code 143/.test(line)) {
        const mark = [...logMarks].reverse().find((m) => m.at <= offset);
        errLines.push(`${excerpt(line, 110)} (after ${mark?.check ?? "start"})`);
      }
      offset += line.length + 1;
    }
    record("LOG", "server log has no error lines during the run", errLines.length === 0, errLines.join(" | ") || "clean");
    logLeakScan();

    const pids = await childPids(server.pid);
    for (const pid of [...pids].reverse()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    server.kill("SIGTERM");
    await Promise.race([server.exited, Bun.sleep(5000)]);
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    let free = false;
    for (let i = 0; i < 50 && !free; i++) {
      free = !(await portAccepts(port));
      if (!free) await Bun.sleep(100);
    }
    record("TEARDOWN", `server stopped by PID (${[server.pid, ...pids].join(", ")}), port ${port} free`, free);
    cleanDbFiles();
    const left = readdirSync(join(ROOT, "data")).filter((f) => f.startsWith("smoke.sqlite"));
    record("TEARDOWN", "smoke DB files deleted", left.length === 0, `data/: ${readdirSync(join(ROOT, "data")).join(", ")}`);
  }

  // ---------------------------------------------------------------- report
  const w = { id: 8, st: 4, name: 90 };
  console.log(`\nHTTP smoke against ${state.BASE} (${new Date().toISOString()})\n`);
  console.log(`${"ID".padEnd(w.id)} ${"RES".padEnd(w.st)}  CHECK / DETAIL`);
  console.log("-".repeat(120));
  for (const r of rows) {
    console.log(`${r.id.padEnd(w.id)} ${r.status.padEnd(w.st)}  ${r.name}`);
    if (r.detail) console.log(`${"".padEnd(w.id + w.st + 3)}  ${r.detail}`);
  }
  const fails = rows.filter((r) => r.status === "FAIL");
  const passes = rows.filter((r) => r.status === "PASS");
  console.log("-".repeat(120));
  console.log(`${passes.length} PASS, ${fails.length} FAIL, ${rows.length - passes.length - fails.length} INFO`);
  for (const sec of [...new Set(rows.map((r) => r.section))]) {
    const rs = rows.filter((r) => r.section === sec);
    console.log(`  ${sec.padEnd(5)} ${rs.filter((r) => r.status === "PASS").length} PASS / ${rs.filter((r) => r.status === "FAIL").length} FAIL / ${rs.filter((r) => r.status === "INFO").length} INFO`);
  }
  console.log(`Run time ${((performance.now() - runStart) / 1000).toFixed(1)} s; ${allResponses.length} HTTP responses${sectionTimes.length ? `; sections: ${sectionTimes.join(", ")}` : ""}`);
  if (process.env.SMOKE_VERBOSE) console.log("\n--- server log ---\n" + state.serverLog);
  return fails.length === 0 ? 0 : 1;
}

process.exit(await main());
