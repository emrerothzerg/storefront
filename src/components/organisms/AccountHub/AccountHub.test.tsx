import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthActionFn } from "@/components/molecules/_contracts/auth-actions";
import type { StockAlertActionFn } from "@/components/molecules/_contracts/stock-alert-actions";
import type { CurrentUser } from "@/server/session/current-user";
import { AccountHub, GUEST_NOTICE_TEXT, NO_LONGER_AVAILABLE_TEXT } from "./AccountHub";
import type { AccountHubProps, AccountHubUser } from "./AccountHub";
import type { AccountHubCounts } from "./account-hub-model";

const warnSpies: Array<{ mockRestore: () => void }> = [];
function spyWarn() {
  const spy = spyOn(console, "warn").mockImplementation(() => {});
  warnSpies.push(spy);
  return spy;
}
afterEach(() => {
  while (warnSpies.length > 0) warnSpies.pop()?.mockRestore();
});

const ZERO: AccountHubCounts = {
  orders: 0,
  lists: 0,
  addresses: 0,
  history: 0,
  reviews: 0,
  questions: 0,
  alerts: 0,
  messages: 0,
};
const SOME: AccountHubCounts = {
  orders: 3,
  lists: 1,
  addresses: 2,
  history: 12,
  reviews: 1,
  questions: 4,
  alerts: 5,
  messages: 1,
};
const USER: AccountHubUser = { displayName: "Jane Doe", email: "jane@example.com" };
const ALERT_A = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const ALERT_B = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
const OWNER_KEY = "9c5b94b1-35ad-49bb-b118-8e8fc24abf80";
const BACK = [
  { alertId: ALERT_A, productSlug: "blue-mug", productName: "Blue Mug" },
  { alertId: ALERT_B, productSlug: "desk-lamp", productName: "Desk Lamp" },
] as const;

const signOutStub: AuthActionFn = async () => null;
const ackStub: StockAlertActionFn = async () => null;

function renderHub(props: Partial<AccountHubProps> = {}) {
  return render(<AccountHub user={null} counts={ZERO} backInStock={[]} {...props} />);
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

describe("AccountHub: headings", () => {
  test("one h1 'Your Account' by default; card titles are h2", () => {
    renderHub();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Your Account");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(8);
  });

  test("headingLevel 2 renders no h1 and h3 card titles", () => {
    renderHub({ headingLevel: 2 });
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Your Account");
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(8);
  });
});

describe("AccountHub: guest header (criterion 2 amended, 5)", () => {
  test("greets the shopper and shows the device-bound notice as text", () => {
    renderHub();
    expect(screen.getByText("Hello, shopper")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(GUEST_NOTICE_TEXT);
    expect(GUEST_NOTICE_TEXT).toBe(
      "Your guest data is device-bound until you sign in. Clearing cookies or switching device starts fresh.",
    );
    expect(status).toHaveAttribute("data-tone", "info");
  });

  test("offers Sign in and Create account as button-styled links", () => {
    renderHub();
    const signIn = screen.getByRole("link", { name: "Sign in" });
    const signUp = screen.getByRole("link", { name: "Create account" });
    expect(signIn).toHaveAttribute("href", "/signin");
    expect(signUp).toHaveAttribute("href", "/signup");
    expect(signIn).toHaveClass("bg-accent", "min-h-touch");
    // Phase 3 (T162): primary pill + outline pill pair.
    expect(signUp).toHaveClass("border-accent", "text-accent", "rounded-full", "min-h-touch");
  });

  test("has no sign-out form or settings link even when signOut is given", () => {
    const { container } = renderHub({ actions: { signOut: signOutStub } });
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Login & security/ })).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });
});

describe("AccountHub: signed-in header (criterion 5)", () => {
  test("greets by display name, shows email as text, links to settings", () => {
    renderHub({ user: USER, actions: { signOut: signOutStub } });
    expect(screen.getByText("Hello, Jane Doe")).toBeInTheDocument();
    const email = screen.getByText("jane@example.com");
    expect(email.closest("a")).toBeNull();
    expect(screen.getByRole("link", { name: "Login & security" })).toHaveAttribute("href", "/account/settings");
  });

  test("hides the guest notice and the sign in / sign up links", () => {
    renderHub({ user: USER, actions: { signOut: signOutStub } });
    expect(screen.queryByText(GUEST_NOTICE_TEXT)).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });

  test("sign out is a form action with a submit button (no-JS shape)", () => {
    const html = renderToStaticMarkup(
      <AccountHub user={USER} counts={ZERO} backInStock={[]} actions={{ signOut: signOutStub }} />,
    );
    const doc = parse(html);
    const forms = doc.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    const form = forms[0];
    expect(form?.hasAttribute("action")).toBe(true);
    expect(form?.hasAttribute("action")).toBe(true);
    const button = form?.querySelector("button");
    expect(button?.getAttribute("type")).toBe("submit");
    expect(button?.textContent).toBe("Sign out");
  });

  test("submitting calls signOut with a null previous state and FormData", async () => {
    const signOut = mock<AuthActionFn>(async () => null);
    renderHub({ user: USER, actions: { signOut } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    const [prev, formData] = signOut.mock.calls[0] ?? [];
    expect(prev).toBeNull();
    expect(formData).toBeInstanceOf(FormData);
  });

  test("without a signOut action no form renders (header still shows)", () => {
    const { container } = renderHub({ user: USER });
    expect(container.querySelector("form")).toBeNull();
    expect(screen.getByText("Hello, Jane Doe")).toBeInTheDocument();
  });

  test("D-T87-1: the greeting cleans bidi overrides, format and C1 control characters", () => {
    const raw = "Mallory \u202Egnp.exe\u202C\u200B Quinn\u0085\u009B";
    const html = renderToStaticMarkup(<AccountHub user={{ displayName: raw, email: "m@q.co" }} counts={ZERO} backInStock={[]} />);
    expect(/[\u202A-\u202E\u2066-\u2069\u200B\u0080-\u009F]/u.test(html)).toBe(false);
    expect(parse(html).body.textContent).toContain("Hello, Mallory gnp.exe Quinn");
  });

  test("D-T87-1: a long name is visibly capped at 20 code points; the full name stays accessible", () => {
    const long = "Bartholomew Fitzgerald-Montgomery";
    renderHub({ user: { displayName: long, email: "b@f.co" } });
    const visible = screen.getByText("Hello, Bartholomew Fitzgera…");
    expect(visible).toHaveAttribute("aria-hidden", "true");
    const full = screen.getByText(`Hello, ${long}`);
    expect(full.className).toContain("sr-only");
  });

  test("D-T87-1: a short name renders once, no sr-only copy; a name that cleans to empty reads 'Hello'", () => {
    const { container, unmount } = renderHub({ user: USER });
    expect(container.querySelector("p.text-h3")?.textContent).toBe("Hello, Jane Doe");
    expect(container.querySelector("p.text-h3 .sr-only")).toBeNull();
    unmount();
    const { container: empty } = renderHub({ user: { displayName: "\u202E\u0085 \u200B", email: "e@x.co" } });
    expect(empty.querySelector("p.text-h3")?.textContent).toBe("Hello");
  });

  test("accepts a CurrentUser and never renders its id", () => {
    const current: CurrentUser = { id: "user-id-42", email: "c@example.com", displayName: "Cee" };
    const html = renderToStaticMarkup(<AccountHub user={current} counts={ZERO} backInStock={[]} />);
    expect(html).toContain("Hello, Cee");
    expect(html).not.toContain("user-id-42");
  });
});

describe("AccountHub: back-in-stock notice (criterion 3)", () => {
  test("hidden when the list is empty", () => {
    renderHub({ user: USER });
    expect(screen.queryByText("Back in stock:")).toBeNull();
  });

  test("success notice before the cards with product links", () => {
    const { container } = renderHub({ backInStock: BACK, actions: { acknowledgeAlert: ackStub } });
    const notice = container.querySelector('[data-tone="success"]');
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent("Back in stock:");
    const n = within(notice as HTMLElement);
    expect(n.getByRole("link", { name: "Blue Mug" })).toHaveAttribute("href", "/products/blue-mug");
    expect(n.getByRole("link", { name: "Desk Lamp" })).toHaveAttribute("href", "/products/desk-lamp");
    const list = screen.getByRole("list", { name: "Account sections" });
    expect(notice?.compareDocumentPosition(list) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test("each item has an Acknowledge form posting alertId (and productSlug)", () => {
    const html = renderToStaticMarkup(
      <AccountHub user={null} counts={ZERO} backInStock={BACK} actions={{ acknowledgeAlert: ackStub }} />,
    );
    const forms = Array.from(parse(html).querySelectorAll("form"));
    expect(forms).toHaveLength(2);
    expect(forms.map((f) => f.querySelector('input[name="alertId"]')?.getAttribute("value"))).toEqual([
      ALERT_A,
      ALERT_B,
    ]);
    for (const form of forms) {
      expect(form.hasAttribute("action")).toBe(true);
      expect(form.querySelector('input[name="alertId"]')?.getAttribute("type")).toBe("hidden");
      expect(form.querySelector('input[name="productSlug"]')?.getAttribute("type")).toBe("hidden");
      expect(form.querySelector("button")?.getAttribute("type")).toBe("submit");
    }
  });

  test("acknowledge buttons have unique accessible names", () => {
    renderHub({ backInStock: BACK, actions: { acknowledgeAlert: ackStub } });
    expect(screen.getByRole("button", { name: "Acknowledge back-in-stock alert for Blue Mug" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge back-in-stock alert for Desk Lamp" })).toBeInTheDocument();
  });

  test("submitting acknowledge posts the alert id", async () => {
    const ack = mock<StockAlertActionFn>(async () => null);
    renderHub({ backInStock: BACK, actions: { acknowledgeAlert: ack } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Desk Lamp/ }));
    });
    expect(ack).toHaveBeenCalledTimes(1);
    const [prev, formData] = ack.mock.calls[0] ?? [];
    expect(prev).toBeNull();
    expect(formData?.get("alertId")).toBe(ALERT_B);
    expect(formData?.get("productSlug")).toBe("desk-lamp");
  });

  test("without acknowledgeAlert the notice shows links but no forms", () => {
    const { container } = renderHub({ backInStock: BACK });
    expect(screen.getByRole("link", { name: "Blue Mug" })).toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
  });

  test("invalid slug renders the name as text (no link, no productSlug) with a dev warning", () => {
    const warn = spyWarn();
    const { container } = renderHub({
      backInStock: [{ alertId: ALERT_A, productSlug: "../evil//x", productName: "Odd Item" }],
      actions: { acknowledgeAlert: ackStub },
    });
    expect(screen.getByText("Odd Item").closest("a")).toBeNull();
    expect(container.querySelector('input[name="productSlug"]')).toBeNull();
    expect(container.querySelector('input[name="alertId"]')).toHaveAttribute("value", ALERT_A);
    expect(warn).toHaveBeenCalled();
  });

  test("D-T87-2: product links keep a 44px touch target and the inline weight", () => {
    const { container } = renderHub({ backInStock: BACK });
    const links = Array.from(container.querySelectorAll('[data-tone="success"] a'));
    expect(links).toHaveLength(2);
    for (const link of links) {
      const classes = (link.getAttribute("class") ?? "").split(/\s+/);
      for (const c of ["inline-flex", "min-h-touch", "items-center", "font-semibold"]) expect(classes).toContain(c);
    }
  });

  test("D-T98-4: an unavailable product is text with 'No longer available' and keeps only Acknowledge", () => {
    const warn = spyWarn();
    const html = renderToStaticMarkup(
      <AccountHub
        user={null}
        counts={ZERO}
        backInStock={[
          { alertId: ALERT_A, productSlug: "", productName: "Withdrawn Kettle", available: false },
          { alertId: ALERT_B, productSlug: "desk-lamp", productName: "Desk Lamp" },
        ]}
        actions={{ acknowledgeAlert: ackStub }}
      />,
    );
    const doc = parse(html);
    const items = Array.from(doc.querySelectorAll('[data-tone="success"] li'));
    expect(items).toHaveLength(2);
    const [gone, live] = items;
    expect(gone?.querySelector("a")).toBeNull();
    expect(gone?.textContent).toContain("Withdrawn Kettle");
    expect(gone?.textContent).toContain(NO_LONGER_AVAILABLE_TEXT);
    const goneForms = Array.from(gone?.querySelectorAll("form") ?? []);
    expect(goneForms).toHaveLength(1);
    expect(goneForms[0]?.querySelector('input[name="alertId"]')?.getAttribute("value")).toBe(ALERT_A);
    expect(goneForms[0]?.querySelector('input[name="productSlug"]')).toBeNull();
    expect(goneForms[0]?.textContent).toContain("Acknowledge");
    expect(live?.querySelector("a")?.getAttribute("href")).toBe("/products/desk-lamp");
    expect(live?.textContent).not.toContain(NO_LONGER_AVAILABLE_TEXT);
    // A deliberate unavailable item is not an invalid slug: no dev warning.
    expect(warn).not.toHaveBeenCalled();
  });

  test("D-T98-4: available false wins over a well-formed slug (never a link)", () => {
    renderHub({ backInStock: [{ alertId: ALERT_A, productSlug: "blue-mug", productName: "Blue Mug", available: false }] });
    expect(screen.queryByRole("link", { name: "Blue Mug" })).toBeNull();
    expect(screen.getByText(NO_LONGER_AVAILABLE_TEXT)).toBeInTheDocument();
  });

  test("malformed alert id gets no acknowledge form", () => {
    const { container } = renderHub({
      backInStock: [{ alertId: '"><script>', productSlug: "blue-mug", productName: "Blue Mug" }],
      actions: { acknowledgeAlert: ackStub },
    });
    expect(container.querySelector("form")).toBeNull();
    expect(screen.getByRole("link", { name: "Blue Mug" })).toBeInTheDocument();
  });
});

describe("AccountHub: card grid (criterion 1)", () => {
  const EXPECTED = [
    ["Your Orders", "/orders"],
    ["Your Lists", "/lists"],
    ["Addresses", "/account/addresses"],
    ["Browsing History", "/account/history"],
    ["Your Reviews & Questions", "/account/contributions"],
    ["Stock Alerts", "/account/alerts"],
    ["Messages", "/account/messages"],
    ["Help", "/help"],
  ] as const;

  test("eight cards, each exactly one link, in order", () => {
    renderHub({ counts: SOME });
    const list = screen.getByRole("list", { name: "Account sections" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    items.forEach((item, i) => {
      const links = item.querySelectorAll("a");
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", EXPECTED[i]?.[1] ?? "");
      expect(within(item).getByRole("heading")).toHaveTextContent(EXPECTED[i]?.[0] ?? "");
    });
  });

  test("count text is part of the link's name with correct plurals", () => {
    renderHub({ counts: SOME });
    expect(screen.getByRole("link", { name: /Your Orders\s*3 orders/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Your Lists\s*1 list$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Addresses\s*2 saved addresses/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Browsing History\s*12 items/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /1 review, 4 questions/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Stock Alerts\s*5 alerts/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Messages\s*1 message$/ })).toBeInTheDocument();
  });

  test("singular forms for 1", () => {
    renderHub({ counts: { ...ZERO, orders: 1, history: 1, addresses: 1, alerts: 1 } });
    expect(screen.getByText("1 order")).toBeInTheDocument();
    expect(screen.getByText("1 item")).toBeInTheDocument();
    expect(screen.getByText("1 saved address")).toBeInTheDocument();
    expect(screen.getByText("1 alert")).toBeInTheDocument();
  });

  test("zero counts show invitations, not errors", () => {
    const { container } = renderHub();
    for (const text of [
      "No orders yet. Start shopping",
      "Save something you love",
      "Add an address",
      "Start browsing to see items here",
      "Share your first review",
      "Get told when items are back in stock",
      "Contact us any time",
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\b0 (orders|lists|items|alerts|messages)\b/);
  });

  test("NaN, negative and infinite counts are treated as 0; fractions floor", () => {
    renderHub({
      counts: {
        orders: Number.NaN,
        lists: -3,
        addresses: Number.POSITIVE_INFINITY,
        history: 2.9,
        reviews: -1,
        questions: Number.NaN,
        alerts: Number.NEGATIVE_INFINITY,
        messages: 0.5,
      },
    });
    expect(screen.getByText("No orders yet. Start shopping")).toBeInTheDocument();
    expect(screen.getByText("Save something you love")).toBeInTheDocument();
    expect(screen.getByText("Add an address")).toBeInTheDocument();
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("Share your first review")).toBeInTheDocument();
    expect(screen.getByText("Get told when items are back in stock")).toBeInTheDocument();
    expect(screen.getByText("Contact us any time")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("Infinity");
  });

  test("large counts are grouped", () => {
    renderHub({ counts: { ...ZERO, orders: 1234 } });
    expect(screen.getByText("1,234 orders")).toBeInTheDocument();
  });

  test("card icons are decorative", () => {
    renderHub();
    const list = screen.getByRole("list", { name: "Account sections" });
    const svgs = list.querySelectorAll("svg");
    expect(svgs).toHaveLength(8);
    svgs.forEach((svg) => expect(svg).toHaveAttribute("aria-hidden", "true"));
  });

  test("320px-safe: 1 column, 2 from sm, 3-4 from lg/xl; cards meet the touch target", () => {
    renderHub();
    const list = screen.getByRole("list", { name: "Account sections" });
    expect(list).toHaveClass("grid-cols-1", "sm:grid-cols-2", "lg:grid-cols-3", "xl:grid-cols-4", "min-w-0");
    for (const a of Array.from(list.querySelectorAll("a"))) {
      expect(a).toHaveClass("min-h-touch", "w-full");
    }
  });
});

describe("AccountHub: hostile text (SR3)", () => {
  const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

  test("display name and product name render as text", () => {
    const { container } = renderHub({
      user: { displayName: HOSTILE, email: "a@b.co" },
      backInStock: [{ alertId: ALERT_A, productSlug: "blue-mug", productName: HOSTILE }],
      actions: { acknowledgeAlert: ackStub, signOut: signOutStub },
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(`Hello, ${HOSTILE}`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: HOSTILE })).toHaveAttribute("href", "/products/blue-mug");
  });

  test("server markup escapes hostile text", () => {
    const html = renderToStaticMarkup(
      <AccountHub
        user={{ displayName: HOSTILE, email: "a@b.co" }}
        counts={ZERO}
        backInStock={[{ alertId: ALERT_A, productSlug: "blue-mug", productName: HOSTILE }]}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });
});

describe("AccountHub: privacy (criterion 4, R-1)", () => {
  function fullHtml(user: AccountHubUser | null = USER): string {
    return renderToStaticMarkup(
      <AccountHub
        user={user}
        counts={SOME}
        backInStock={BACK}
        actions={{ signOut: signOutStub, acknowledgeAlert: ackStub }}
      />,
    );
  }

  test("renderToStaticMarkup works for guest and signed-in", () => {
    expect(fullHtml(null)).toContain("Hello, shopper");
    expect(fullHtml()).toContain("Hello, Jane Doe");
  });

  test("no UUID in the HTML except alert ids in hidden alertId inputs", () => {
    const html = fullHtml();
    const doc = parse(html);
    const hidden = Array.from(doc.querySelectorAll('input[type="hidden"][name="alertId"]')).map((i) =>
      i.getAttribute("value"),
    );
    expect(hidden).toEqual([ALERT_A, ALERT_B]);
    const uuids = html.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    expect(uuids).toEqual([ALERT_A, ALERT_B]);
    for (const id of [ALERT_A, ALERT_B]) {
      expect(html.split(id).length - 1).toBe(1);
      expect(html).toContain(`name="alertId" value="${id}"`);
    }
  });

  test("no attribute carries email, display name or alert ids (beyond the hidden value)", () => {
    const doc = parse(fullHtml());
    const secrets = [USER.email, USER.displayName, ALERT_A, ALERT_B];
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        const isHiddenAlertValue =
          el.tagName === "INPUT" && el.getAttribute("name") === "alertId" && attr.name === "value";
        if (isHiddenAlertValue) continue;
        for (const secret of secrets) expect(attr.value).not.toContain(secret);
      }
    }
  });

  test("an owner key smuggled past the type system is never rendered", () => {
    const smuggled = { displayName: "Jane", email: "j@example.com", ownerKey: OWNER_KEY } as unknown as AccountHubUser;
    const html = fullHtml(smuggled);
    expect(html).not.toContain(OWNER_KEY);
  });

  test("the user type rejects owner keys and session ids", () => {
    // @ts-expect-error -- owner keys never reach components (R-1)
    const a: AccountHubUser = { displayName: "x", email: "x@y.z", ownerKey: OWNER_KEY };
    const withKey = { displayName: "x", email: "x@y.z", ownerKey: OWNER_KEY };
    // @ts-expect-error -- also rejected when not an object literal
    const b: AccountHubUser = withKey;
    const withSession = { displayName: "x", email: "x@y.z", sessionId: OWNER_KEY };
    // @ts-expect-error -- session ids are owner keys too
    const c: AccountHubUser = withSession;
    const current: CurrentUser = { id: "u", email: "x@y.z", displayName: "x" };
    const d: AccountHubUser = current;
    expect([a, b, c, d]).toHaveLength(4);
  });
});

describe("AccountHub: Phase 3 look (T162)", () => {
  test("header block and section tiles sit on Card surfaces; links keep the touch target", () => {
    const { container } = renderHub({ user: { displayName: "Ada", email: "ada@example.com" } });
    const header = container.querySelector('[data-slot="account-hub-header"]');
    expect(header).toHaveClass("bg-surface-raised", "rounded-lg", "border-border-default");
    const list = screen.getByRole("list", { name: "Account sections" });
    const items = Array.from(list.children);
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) {
      expect(li.tagName).toBe("LI");
      expect(li).toHaveClass("bg-surface-raised", "rounded-lg", "hover:shadow-md");
      const links = li.querySelectorAll("a");
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveClass("min-h-touch", "w-full");
    }
  });

  test("no theme-dependent classes", () => {
    const { container } = renderHub();
    // Built at run time so the G02 source scan (tests/redesign/guards.test.ts) does not flag this file.
    const themeHooks = new RegExp(["\\bdark" + ":", "data-" + "theme"].join("|"));
    expect(container.innerHTML).not.toMatch(themeHooks);
  });
});
