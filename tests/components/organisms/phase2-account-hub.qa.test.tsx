// QA (QA-W4-organisms-B / T90): T87 AccountHub + account-hub-model.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthActionFn, AuthActionState } from "@/components/molecules/_contracts/auth-actions";
import type { StockAlertActionFn, StockAlertActionState } from "@/components/molecules/_contracts/stock-alert-actions";
import {
  ACCOUNT_HUB_CARDS,
  AccountHub,
  GUEST_NOTICE_TEXT,
  buildAccountHubCards,
  toBackInStockItems,
  type AccountHubCounts,
  type AccountHubProps,
} from "@/components/organisms/AccountHub";
import { CompareTable } from "@/components/organisms/CompareTable";
import { isAllowedInternalHref } from "@/content/routes";
import type { StockAlertView } from "@/server/alerts/stock-alert-service";
import type { CurrentUser } from "@/server/session/current-user";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; ‮evil`;
const ROOT = join(import.meta.dir, "../../../src/components/organisms");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const USER_ID = "3f2c1a9e-7b6d-4c5e-8a1f-0d9e8c7b6a51";
const OWNER_KEY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const ALERT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ZERO: AccountHubCounts = { orders: 0, lists: 0, addresses: 0, history: 0, reviews: 0, questions: 0, alerts: 0, messages: 0 };
const SOME: AccountHubCounts = { orders: 3, lists: 1, addresses: 2, history: 1234, reviews: 1, questions: 0, alerts: 2, messages: 1 };

// A CurrentUser as returned by readCurrentUser(): it carries a user UUID that must never be rendered.
const CURRENT: CurrentUser = { id: USER_ID, email: "qa.shopper@example.com", displayName: "QA Shopper" };

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

function props(over: Partial<AccountHubProps> = {}): AccountHubProps {
  return { user: null, counts: ZERO, backInStock: [], ...over };
}

/** Records how the organism binds an action, and what the bound function is called with. */
function recordingAction<S>() {
  const bindArgs: unknown[][] = [];
  const calls: Array<{ prev: unknown; keys: string[] }> = [];
  const fn = async (prev: S | null, fd: FormData): Promise<S | null> => {
    calls.push({ prev, keys: [...fd.keys()] });
    return null;
  };
  const originalBind = fn.bind;
  const wrapped = Object.assign(fn, {
    bind(thisArg: unknown, ...args: unknown[]) {
      bindArgs.push(args);
      return originalBind.call(fn, thisArg, ...(args as [S | null]));
    },
  });
  return { fn: wrapped, bindArgs, calls };
}

describe("T87 heading and greeting", () => {
  test("exactly one h1 'Your Account' (default level); card headings are h2", () => {
    const { container } = render(<AccountHub {...props({ user: CURRENT })} />);
    const h1 = container.querySelectorAll("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]?.textContent).toBe("Your Account");
    expect(container.querySelectorAll("h2")).toHaveLength(ACCOUNT_HUB_CARDS.length);
  });

  test("signed-in greeting shows the display name and email as text; hostile display name stays text", () => {
    const { container } = render(<AccountHub {...props({ user: { displayName: HOSTILE, email: "x@example.com" } })} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // D-T87-1: markup-like text stays escaped text; bidi/format and C1 characters are removed by cleanDisplayName.
    const cleaned = HOSTILE.replace(/\u202E/g, "");
    expect(screen.getByText(`Hello, ${cleaned}`)).toBeInTheDocument();
    expect(screen.getByText("x@example.com")).toBeInTheDocument();
    const html = renderToStaticMarkup(<AccountHub {...props({ user: { displayName: HOSTILE, email: "x@example.com" } })} />);
    expect(html).not.toContain("<script>alert(2)");
    expect(html).not.toContain("<img src=x");
    expect(/[\u202A-\u202E\u2066-\u2069\u0080-\u009F]/u.test(html)).toBe(false);
    const c1 = renderToStaticMarkup(<AccountHub {...props({ user: { displayName: "Ivy\u0085\u009B Rose", email: "x@example.com" } })} />);
    expect(/[\u0080-\u009F]/u.test(c1)).toBe(false);
    expect(c1).toContain("Hello, Ivy Rose");
  });
});

describe("T87.1 one link per card with count text; zero counts invite", () => {
  test("eight cards, each ONE link, href allowed, counts pluralised", () => {
    const { container } = render(<AccountHub {...props({ counts: SOME })} />);
    const list = screen.getByRole("list", { name: "Account sections" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    for (const li of items) {
      const links = li.querySelectorAll("a");
      expect(links).toHaveLength(1);
      expect(isAllowedInternalHref(links[0]?.getAttribute("href") ?? "")).toBe(true);
      expect(li.querySelectorAll("button, input, form")).toHaveLength(0);
    }
    const text = list.textContent ?? "";
    for (const s of ["3 orders", "1 list", "2 saved addresses", "1,234 items", "1 review, 0 questions", "2 alerts", "1 message"]) {
      expect(text).toContain(s);
    }
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("zero / garbage counts show invitations, never 'NaN', '-1' or 'error'", () => {
    const garbage = { orders: Number.NaN, lists: -1, addresses: Number.POSITIVE_INFINITY, history: 0, reviews: 0, questions: 0, alerts: 0.4, messages: 0 };
    const { container } = render(<AccountHub {...props({ counts: garbage })} />);
    const t = container.textContent ?? "";
    expect(t).not.toMatch(/NaN|Infinity|-1|error/i);
    expect(t).toContain("No orders yet. Start shopping");
    expect(t).toContain("Save something you love");
    expect(t).toContain("Share your first review");
  });

  test("buildAccountHubCards drops a card whose href is disallowed (dev warning)", () => {
    const w = spyOn(console, "warn").mockImplementation(() => {});
    spies.push(w);
    const defs = [...ACCOUNT_HUB_CARDS, { ...ACCOUNT_HUB_CARDS[0]!, key: "help" as const, href: "https://evil.example" }];
    expect(buildAccountHubCards(ZERO, defs)).toHaveLength(8);
    expect(w).toHaveBeenCalled();
  });
});

describe("T87.5 guest vs signed-in header (accounts amendment)", () => {
  test("guest: notice text equals GUEST_NOTICE_TEXT, plus Sign in / Create account links; no sign-out form", () => {
    const { container } = render(<AccountHub {...props()} />);
    expect(screen.getByText(GUEST_NOTICE_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/signup");
    expect(container.querySelector("form")).toBeNull();
    expect(renderToStaticMarkup(<AccountHub {...props()} />)).toContain(GUEST_NOTICE_TEXT);
  });

  test("signed-in: no guest notice; settings link to /account/settings; Sign out form", () => {
    const signOut = recordingAction<AuthActionState>();
    render(<AccountHub {...props({ user: CURRENT, actions: { signOut: signOut.fn as AuthActionFn } })} />);
    expect(screen.queryByText(GUEST_NOTICE_TEXT)).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("link", { name: /security|settings/i })).toHaveAttribute("href", "/account/settings");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  test("sign out: action bound with .bind(null, null); posting calls it with prev=null and NO fields", async () => {
    const signOut = recordingAction<AuthActionState>();
    const { container } = render(<AccountHub {...props({ user: CURRENT, actions: { signOut: signOut.fn as AuthActionFn } })} />);
    expect(signOut.bindArgs).toEqual([[null]]);
    const form = container.querySelector("form") as HTMLFormElement;
    expect([...new FormData(form).keys()]).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    });
    expect(signOut.calls).toHaveLength(1);
    expect(signOut.calls[0]?.prev).toBeNull();
    expect(signOut.calls[0]?.keys).toEqual([]);
  });

  test("DEFECT D-T87-1 (ruled R-T87-1): guest notice renders the shipped D1 wording", () => {
    render(<AccountHub {...props()} />);
    expect(screen.getByText(GUEST_NOTICE_TEXT)).toBeInTheDocument();
  });

  test("DEFECT D-T87-1 evidence (ruled R-T87-1): the D1 copy is kept; the criterion's sentence was illustrative", () => {
    expect(GUEST_NOTICE_TEXT).toBe(
      "Your guest data is device-bound until you sign in. Clearing cookies or switching device starts fresh.",
    );
    expect(GUEST_NOTICE_TEXT).not.toContain("lives in this browser");
  });

  test("DEFECT D-T87-2 (ruled R-T87-2): signed-in header has a settings link to /account/settings", () => {
    render(<AccountHub {...props({ user: CURRENT })} />);
    const settings = screen.getAllByRole("link").filter((a) => a.getAttribute("href") === "/account/settings");
    expect(settings.length).toBeGreaterThan(0);
  });

  test("DEFECT D-T87-2 evidence (ruled R-T87-2): the settings link is labelled 'Login & security' (Amazon parity)", () => {
    render(<AccountHub {...props({ user: CURRENT })} />);
    expect(screen.getByRole("link", { name: "Login & security" })).toHaveAttribute("href", "/account/settings");
    expect(screen.queryByRole("link", { name: "Account settings" })).toBeNull();
  });
});

describe("T87.3 back-in-stock Notice at the top with product links", () => {
  test("Notice precedes the header and cards; product names link to /products/<slug>", () => {
    const items = [{ alertId: ALERT_ID, productSlug: "blue-mug", productName: "Blue Mug" }];
    const { container } = render(<AccountHub {...props({ backInStock: items })} />);
    const link = screen.getByRole("link", { name: "Blue Mug" });
    expect(link).toHaveAttribute("href", "/products/blue-mug");
    const order = [...container.querySelectorAll("a, h1, ul[aria-label='Account sections']")];
    const h1Index = order.findIndex((el) => el.tagName === "H1");
    const linkIndex = order.indexOf(link);
    const cardsIndex = order.findIndex((el) => el.getAttribute("aria-label") === "Account sections");
    expect(h1Index).toBeLessThan(linkIndex);
    expect(linkIndex).toBeLessThan(cardsIndex);
    expect(container.textContent).toContain("Back in stock:");
  });

  test("invalid slugs render the name without a link; hostile names stay text", () => {
    spies.push(spyOn(console, "warn").mockImplementation(() => {}));
    const items = [
      { alertId: ALERT_ID, productSlug: "../evil", productName: HOSTILE },
      { alertId: "bad id with spaces", productSlug: "ok-slug", productName: "Fine" },
    ];
    const ack: StockAlertActionFn = async () => null;
    const { container } = render(<AccountHub {...props({ backInStock: items, actions: { acknowledgeAlert: ack } })} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    // non-postable alert id: no acknowledge form for that row
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });

  test("acknowledge form: bound with prev=null; posts alertId (+productSlug) only", async () => {
    const ack = recordingAction<StockAlertActionState>();
    const items = [{ alertId: ALERT_ID, productSlug: "blue-mug", productName: "Blue Mug" }];
    render(<AccountHub {...props({ backInStock: items, actions: { acknowledgeAlert: ack.fn as StockAlertActionFn } })} />);
    expect(ack.bindArgs).toEqual([[null]]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Acknowledge back-in-stock alert for Blue Mug/ }));
    });
    expect(ack.calls[0]?.prev).toBeNull();
    expect(ack.calls[0]?.keys.sort()).toEqual(["alertId", "productSlug"]);
  });

  test("no Notice when there are no alerts", () => {
    const { container } = render(<AccountHub {...props()} />);
    expect(container.textContent).not.toContain("Back in stock");
  });
});

describe("T87.4 privacy: no owner key / user id / secrets in markup or attributes", () => {
  test("signed-in static markup (no alerts): no UUID at all (user id never rendered), email only as text", () => {
    const html = renderToStaticMarkup(<AccountHub {...props({ user: CURRENT, counts: SOME })} />);
    expect(html.match(UUID_RE)).toBeNull();
    expect(html).not.toContain(USER_ID);
    expect(html).not.toContain(OWNER_KEY);
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const el of doc.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value).not.toContain(CURRENT.email);
        expect(attr.value).not.toContain(CURRENT.displayName);
      }
    }
    expect(html.split(CURRENT.email).length - 1).toBe(1);
    expect(html).not.toMatch(/owner|session|password|token/i);
  });

  test("forged extra props on the user object (owner key, session, hash) are never echoed", () => {
    const forged = {
      ...CURRENT,
      ownerKey: OWNER_KEY,
      sessionId: OWNER_KEY,
      passwordHash: "$argon2id$v=19$m=65536$secret",
      token: "tok_secret",
    } as unknown as CurrentUser;
    const html = renderToStaticMarkup(<AccountHub {...props({ user: forged })} />);
    expect(html).not.toContain(OWNER_KEY);
    expect(html).not.toContain("argon2id");
    expect(html).not.toContain("tok_secret");
  });

  test("DEFECT D-T87-3 evidence (ruled R-T87-3): the alert UUID appears only as the acknowledge form's hidden input value", () => {
    const ack: StockAlertActionFn = async () => null;
    const items = [{ alertId: ALERT_ID, productSlug: "blue-mug", productName: "Blue Mug" }];
    const html = renderToStaticMarkup(<AccountHub {...props({ user: CURRENT, backInStock: items, actions: { acknowledgeAlert: ack } })} />);
    expect(html.match(UUID_RE)).toEqual([ALERT_ID]);
    expect(html).toContain(`value="${ALERT_ID}"`);
    const src = readFileSync(join(ROOT, "AccountHub/AccountHub.tsx"), "utf8");
    expect(src).not.toContain("alert ids must not reach attributes");
    expect(src).toContain("Opaque server ids such as the alert id may");
  });

  test("DEFECT D-T87-3 (ruled R-T87-3): opaque alert ids are allowed; no user id or owner key in the markup, no email in any attribute", () => {
    const ack: StockAlertActionFn = async () => null;
    const items = [{ alertId: ALERT_ID, productSlug: "blue-mug", productName: "Blue Mug" }];
    const html = renderToStaticMarkup(<AccountHub {...props({ user: CURRENT, backInStock: items, actions: { acknowledgeAlert: ack } })} />);
    for (const uuid of html.match(UUID_RE) ?? []) expect(uuid).toBe(ALERT_ID);
    expect(html).not.toContain(USER_ID);
    expect(html).not.toContain(OWNER_KEY);
    expect(html).not.toMatch(new RegExp(`="[^"]*${CURRENT.email.replace(/\./g, "\\.")}`));
  });
});

describe("toBackInStockItems edge cases", () => {
  function view(id: string, product: StockAlertView["product"]): StockAlertView {
    return { id, productId: product?.id ?? "gone", createdAt: "2026-11-01T00:00:00.000Z", acknowledgedAt: null, status: "back_in_stock", product };
  }
  const mug = { id: "p-mug", slug: "blue-mug", name: "Blue Mug", imageUrl: "/m.jpg", priceCents: 1, currency: "USD" as const, stock: 3 };

  test("empty -> []", () => {
    expect(toBackInStockItems([])).toEqual([]);
  });

  test("product gone -> dropped; output carries only alertId/productSlug/productName", () => {
    const out = toBackInStockItems([view(ALERT_ID, mug), view("x", null)]);
    expect(out).toEqual([{ alertId: ALERT_ID, productSlug: "blue-mug", productName: "Blue Mug" }]);
    expect(Object.keys(out[0] ?? {}).sort()).toEqual(["alertId", "productName", "productSlug"]);
  });

  test("observation: duplicate views are passed through (no dedupe); the service's UNIQUE rows make this unreachable", () => {
    expect(toBackInStockItems([view(ALERT_ID, mug), view(ALERT_ID, mug)])).toHaveLength(2);
  });
});

describe("cross-cutting: landmarks with another organism, 320px, source rules", () => {
  test("hub next to a CompareTable: one h1, region names and ids unique", () => {
    const { container } = render(
      <main>
        <AccountHub {...props({ user: CURRENT })} />
        <CompareTable products={[]} selectedSlugs={[]} />
      </main>,
    );
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    const names = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label") ?? r.getAttribute("aria-labelledby"));
    expect(new Set(names).size).toBe(names.length);
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("320px: root min-w-0, grid is single column below sm, long emails break", () => {
    const { container } = render(<AccountHub {...props({ user: { displayName: "x".repeat(50), email: `${"a".repeat(64)}@example.com` } })} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("min-w-0");
    const grid = screen.getByRole("list", { name: "Account sections" });
    expect(grid.className).toContain("grid-cols-1");
    expect(screen.getByText(`${"a".repeat(64)}@example.com`).className).toContain("break-all");
  });

  test("source: no `use client`, no inline style / raw HTML, server imports type-only", () => {
    for (const f of ["AccountHub.tsx", "account-hub-model.ts"]) {
      const src = readFileSync(join(ROOT, "AccountHub", f), "utf8");
      expect(src).not.toMatch(/^\s*['"]use client['"]/m);
      expect(src).not.toMatch(/style=|dangerouslySetInnerHTML/);
      for (const line of src.split("\n").filter((l) => l.includes("@/server/"))) expect(line).toMatch(/^import type /);
    }
  });
});
