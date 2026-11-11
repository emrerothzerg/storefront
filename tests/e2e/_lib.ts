/**
 * Shared helpers for the production HTTP smoke (`http-smoke.ts`, MVP checks) and its Phase 2
 * sections (`_phase2.ts`). Plain Bun, no dependencies. Not a test file: `bun test` never loads it.
 */
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const DB_REL = "./data/smoke.sqlite";
export const DB_ABS = join(ROOT, "data", "smoke.sqlite");
export const GOOD_CARD = "4242424242424242";
export const DECLINE_CARD = "4000000000000002";
export const CVC = "123";

// ---------------------------------------------------------------- results

export type Status = "PASS" | "FAIL" | "INFO";
export type Row = { id: string; status: Status; name: string; detail: string; section: string };

export const state = {
  BASE: "",
  serverLog: "",
  currentCheck: "startup",
  section: "MVP",
  scanning: false,
};
export const rows: Row[] = [];
export const logMarks: Array<{ at: number; check: string }> = [];

export function record(id: string, name: string, ok: boolean | "info", detail = ""): boolean {
  const status: Status = ok === "info" ? "INFO" : ok ? "PASS" : "FAIL";
  rows.push({ id, status, name, detail, section: state.section });
  state.currentCheck = id;
  return ok === true || ok === "info";
}

export function markLog(): void {
  logMarks.push({ at: state.serverLog.length, check: state.currentCheck });
}

export async function pump(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    state.serverLog += decoder.decode(value, { stream: true });
  }
}

// ---------------------------------------------------------------- HTTP + cookies

export class CookieJar {
  readonly cookies = new Map<string, string>();
  readonly setCookieHeaders: string[] = [];
  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      this.setCookieHeaders.push(raw);
      const pair = raw.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // Max-Age=0 / past Expires / empty value deletes the cookie, as a browser would.
      const expired = /;\s*max-age=0(\s*;|\s*$)/i.test(raw) || /;\s*expires=Thu, 01 Jan 1970/i.test(raw) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  clone(): CookieJar {
    const j = new CookieJar();
    for (const [k, v] of this.cookies) j.cookies.set(k, v);
    return j;
  }
}

export type Resp = {
  status: number;
  headers: Headers;
  body: string;
  ttfbMs: number;
  location: string | null;
  setCookies: string[];
  url: string;
};

export const scanned: Array<{ label: string; resp: Resp }> = [];
/** Every response of the run (label + status + headers + body), for the leak scans at the end. */
export const allResponses: Array<{ label: string; resp: Resp }> = [];

export async function http(
  path: string,
  opts: { jar?: CookieJar; method?: string; form?: FormData; label?: string; accept?: string; headers?: Record<string, string> } = {},
): Promise<Resp> {
  const headers: Record<string, string> = { Accept: opts.accept ?? "text/html", ...(opts.headers ?? {}) };
  if (opts.jar && opts.jar.cookies.size > 0) headers.Cookie = opts.jar.header();
  if (opts.form) headers.Origin = state.BASE; // browsers always send Origin on a form POST
  const label = opts.label ?? `${opts.form ? "POST" : (opts.method ?? "GET")} ${path}`;
  logMarks.push({ at: state.serverLog.length, check: `${state.currentCheck} > ${label}` });
  const t0 = performance.now();
  const res = await fetch(state.BASE + path, {
    method: opts.method ?? (opts.form ? "POST" : "GET"),
    headers,
    body: opts.form,
    redirect: "manual",
  });
  const ttfbMs = performance.now() - t0;
  opts.jar?.absorb(res);
  // React SSR separates adjacent text/expressions with <!-- -->; drop it so text assertions see "Card ending in 4242".
  const body = (await res.text()).replace(/<!-- -->/g, "");
  const resp: Resp = {
    status: res.status,
    headers: res.headers,
    body,
    ttfbMs,
    location: res.headers.get("location"),
    setCookies: res.headers.getSetCookie(),
    url: path,
  };
  if (state.scanning) scanned.push({ label, resp });
  allResponses.push({ label, resp });
  return resp;
}

// ---------------------------------------------------------------- HTML helpers

export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const inner = tag.replace(/^<[a-zA-Z0-9]+/, "").replace(/\/?>$/, "");
  for (const m of inner.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) out.set((m[1] ?? "").toLowerCase(), decodeEntities(m[2] ?? ""));
  return out;
}

export const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length;
export const tags = (html: string, name: string): string[] => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
export const forms = (html: string): string[] => html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
export const title = (html: string): string => decodeEntities(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
export const h1Text = (html: string): string =>
  decodeEntities((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(/<[^>]+>/g, "")).trim();
export const formOpen = (form: string): Map<string, string> => attrs(form.match(/<form\b[^>]*>/)?.[0] ?? "<form>");

/** Server-rendered markup with <script>/<template> removed: action state present ONLY in the RSC payload is gone. */
export const htmlOnly = (html: string): string =>
  html.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<template\b[\s\S]*?<\/template>/g, "");
/** Visible-ish text of the server HTML (tags stripped, entities decoded, whitespace collapsed). */
export const textOf = (html: string): string =>
  decodeEntities(htmlOnly(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** Offset of the first PPR-streamed `<div hidden id="S:n">` (content after it is only shown by inline JS). */
export const firstStreamedDiv = (html: string): number => html.search(/<div hidden id="S:\d+">/);
/** The static test-card hint inside PaymentFields (a fixed list, not user data). */
export const stripTestCardHint = (html: string): string => html.replace(/<div id="[^"]*-test-mode"[\s\S]*?<\/ul>/g, "");

/** All hidden inputs of a form (the `$ACTION_*` progressive-enhancement fields plus the form's own). */
export function hiddenFields(formHtml: string): Array<[string, string]> {
  return tags(formHtml, "input")
    .map(attrs)
    .filter((a) => a.get("type") === "hidden" && a.has("name"))
    .map((a) => [a.get("name") as string, a.get("value") ?? ""]);
}

export function formWith(html: string, fieldName: string): string | undefined {
  return forms(html).find((f) => f.includes(`name="${fieldName}"`));
}

export function toFormData(fields: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  return fd;
}

/**
 * Serialises a form the way a browser does before hydration: every successful control in document
 * order (hidden/text inputs, checked radios/checkboxes, selected option, textarea text) plus the
 * clicked submit button's name/value only. `submitter` picks the button (by its tag + inner text);
 * by default no named button is included (the form's own action is used).
 */
export function serializeForm(formHtml: string, submitter?: (buttonTag: string, text: string) => boolean): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const inner = formHtml.replace(/^<form\b[^>]*>/, "");
  // Button content is NOT skipped: React renders a formAction button's hidden $ACTION_* inputs inside it.
  const re = /<(input)\b[^>]*>|<(select)\b[^>]*>([\s\S]*?)<\/select>|<(textarea)\b[^>]*>([\s\S]*?)<\/textarea>|<(button)\b[^>]*>/g;
  let pickedSubmitter = false;
  for (const m of inner.matchAll(re)) {
    const whole = m[0];
    const openTag = whole.match(/^<[a-z]+\b[^>]*>/)?.[0] ?? whole;
    const a = attrs(openTag);
    const name = a.get("name");
    if (a.has("disabled")) continue;
    if (m[1]) {
      if (!name) continue;
      const type = (a.get("type") ?? "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (a.has("checked")) out.push([name, a.get("value") ?? "on"]);
      } else if (type === "submit" || type === "image") {
        if (!pickedSubmitter && submitter?.(openTag, a.get("value") ?? "")) {
          out.push([name, a.get("value") ?? ""]);
          pickedSubmitter = true;
        }
      } else if (type !== "button" && type !== "reset" && type !== "file") {
        out.push([name, a.get("value") ?? ""]);
      }
    } else if (m[2]) {
      if (!name) continue;
      const options = (m[3] ?? "").match(/<option\b[^>]*>/g) ?? [];
      const sel = options.find((o) => /\sselected(="")?[\s>/]/.test(o)) ?? options[0];
      if (sel) out.push([name, attrs(sel).get("value") ?? ""]);
    } else if (m[4]) {
      if (!name) continue;
      out.push([name, decodeEntities((m[5] ?? "").replace(/^\n/, ""))]);
    } else if (m[6]) {
      const rest = inner.slice((m.index ?? 0) + whole.length);
      const text = decodeEntities((rest.slice(0, Math.max(0, rest.indexOf("</button>"))) || "").replace(/<[^>]+>/g, "")).trim();
      const type = (a.get("type") ?? "submit").toLowerCase();
      if (type !== "submit" || !name) continue;
      if (!pickedSubmitter && submitter?.(openTag, text)) {
        out.push([name, a.get("value") ?? ""]);
        pickedSubmitter = true;
      }
    }
  }
  return out;
}

/** Applies overrides: replaces every entry of a name with the given value(s) at the first position, or appends. */
export function withOverrides(fields: Array<[string, string]>, overrides: Record<string, string | string[]>): Array<[string, string]> {
  let out = [...fields];
  for (const [name, raw] of Object.entries(overrides)) {
    const values = Array.isArray(raw) ? raw : [raw];
    const idx = out.findIndex(([k]) => k === name);
    out = out.filter(([k]) => k !== name);
    const entries = values.map((v): [string, string] => [name, v]);
    if (idx < 0) out.push(...entries);
    else out.splice(Math.min(idx, out.length), 0, ...entries);
  }
  return out;
}

/** Visible submit-button texts of a form. */
export const buttonTexts = (formHtml: string): string[] =>
  [...formHtml.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((b) => decodeEntities((b[1] ?? "").replace(/<[^>]+>/g, "")).trim());

export type SubmitResult = { form: string | undefined; post: Resp | null; fields: Array<[string, string]> };

/**
 * Finds a POST form on `pageHtml` with `pick`, serialises it (no-JS browser semantics), applies
 * overrides and posts it as multipart/form-data to the form action (or the page URL for action="").
 */
export async function submitForm(
  jar: CookieJar,
  pagePath: string,
  pageHtml: string,
  pick: (form: string) => boolean,
  overrides: Record<string, string | string[]> = {},
  opts: { submitter?: (buttonTag: string, text: string) => boolean; label?: string } = {},
): Promise<SubmitResult> {
  const form = forms(pageHtml).find((f) => (formOpen(f).get("method") ?? "").toUpperCase() === "POST" && pick(f));
  if (!form) return { form: undefined, post: null, fields: [] };
  const action = formOpen(form).get("action") ?? "";
  const target = action && action.startsWith("/") ? action : pagePath;
  const fields = withOverrides(serializeForm(form, opts.submitter), overrides);
  const post = await http(target, { jar, form: toFormData(fields), label: opts.label ?? `POST form on ${pagePath}` });
  return { form, post, fields };
}

/** Every visible form control has a <label for=id>, a wrapping <label>, aria-label or aria-labelledby. Returns offenders. */
export function unlabelledControls(html: string): string[] {
  const labelFor = new Set(tags(html, "label").map((t) => attrs(t).get("for")).filter(Boolean));
  // Controls nested inside a <label>…</label> are implicitly labelled: blank them out first.
  const withoutWrapped = html.replace(/<label\b(?![^>]*\sfor=)[^>]*>[\s\S]*?<\/label>/g, "");
  const skipTypes = new Set(["hidden", "submit", "button", "reset", "image"]);
  const bad: string[] = [];
  for (const tag of [...tags(withoutWrapped, "input"), ...tags(withoutWrapped, "select"), ...tags(withoutWrapped, "textarea")]) {
    const a = attrs(tag);
    if (tag.startsWith("<input") && skipTypes.has(a.get("type") ?? "text")) continue;
    const id = a.get("id");
    if ((id && labelFor.has(id)) || a.has("aria-label") || a.has("aria-labelledby")) continue;
    bad.push(`${a.get("name") ?? "?"}#${id ?? "-"}`);
  }
  return bad;
}

export const usd = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const excerpt = (s: string, n = 160): string => s.replace(/\s+/g, " ").slice(0, n);
export const isRedirect = (r: Resp | null | undefined): boolean => !!r && r.status >= 300 && r.status < 400;
export const locPath = (r: Resp | null | undefined): string => (r?.location ? new URL(r.location, state.BASE).pathname : "");
export const locFull = (r: Resp | null | undefined): string => {
  if (!r?.location) return "";
  const u = new URL(r.location, state.BASE);
  return u.pathname + u.search;
};
export const soft404 = (r: Resp): string =>
  `status ${r.status}${r.status === 200 ? `, soft 404 in stream: ${r.body.includes("NEXT_HTTP_ERROR_FALLBACK;404")}, noindex meta: ${r.body.includes('<meta name="robots" content="noindex"/>')}` : ""}`;

// ---------------------------------------------------------------- DB helpers (read-only queries)

export type Product = { id: string; slug: string; name: string; price_cents: number; stock: number };

export function q<T>(sql: string, ...params: Array<string | number | null>): T[] {
  const db = new Database(DB_ABS);
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
export const one = <T>(sql: string, ...params: Array<string | number | null>): T | undefined => q<T>(sql, ...params)[0];
export const num = (sql: string, ...params: Array<string | number | null>): number =>
  one<{ n: number }>(sql, ...params)?.n ?? -1;
export const stockOf = (id: string): number => one<{ stock: number }>("SELECT stock FROM products WHERE id = ?", id)?.stock ?? -1;
export const orderCount = (status?: string): number =>
  status ? num("SELECT COUNT(*) AS n FROM orders WHERE status = ?", status) : num("SELECT COUNT(*) AS n FROM orders");
export const cartQty = (session: string, productId: string): number =>
  one<{ quantity: number }>("SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?", session, productId)?.quantity ?? 0;

// ---------------------------------------------------------------- process helpers

export async function run(cmd: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
}

export async function portFree(port: number): Promise<boolean> {
  try {
    const s = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

export async function portAccepts(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

export async function childPids(pid: number): Promise<number[]> {
  const { out } = await run(["pgrep", "-P", String(pid)], {});
  const kids = out.split(/\s+/).filter(Boolean).map(Number);
  const deeper = await Promise.all(kids.map(childPids));
  return [...kids, ...deeper.flat()];
}

/** Optional debugging: SMOKE_DUMP=<dir> writes the body of a response to <dir>/<name>.html. */
export async function dump(name: string, r: Resp | null | undefined): Promise<void> {
  const dir = process.env.SMOKE_DUMP;
  if (!dir || !r) return;
  await Bun.write(join(dir, `${name.replace(/[^a-z0-9]+/gi, "_")}.html`), `<!-- ${r.status} ${r.location ?? ""} -->\n${r.body}`);
}
