import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// next/* mocks: registered before the page is imported; delegate to per-test state.
class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: string[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string): void {
    this.setCalls.push(name);
  }
  delete(name: string): void {
    this.setCalls.push(`delete:${name}`);
  }
}

let fakeStore = new FakeCookieStore();
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new Error("unexpected notFound");
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const dbClient = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const fx = await import("../_lib/test-fixtures");
const { createQaService } = await import("@/server/qa/qa-service");
const { default: Page, generateMetadata } = await import("./page");
const { GUEST_NOTICE_TEXT } = await import("@/components/organisms/AccountHub");
const { GUEST_STATE_LABEL } = await import("../_lib/guest-state");


const HOSTILE_NAME = `Tote ${fx.HOSTILE}`;

const getDatabaseSpy = spyOn(dbClient, "getDatabase");
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");

let a: import("../_lib/test-fixtures").SeededOwner;
let b: import("../_lib/test-fixtures").SeededOwner;
let user: import("../_lib/test-fixtures").SignedInFixture;

function setCookies(cookies: { guest?: string; auth?: string } = {}): void {
  fakeStore = new FakeCookieStore();
  if (cookies.guest !== undefined) fakeStore.jar.set(session.SESSION_COOKIE_NAME, cookies.guest);
  if (cookies.auth !== undefined) fakeStore.jar.set(session.AUTH_COOKIE_NAME, cookies.auth);
}

async function renderPage() {
  return render(await Page());
}

function forbidden(): string[] {
  return [fx.OWNER_A, fx.OWNER_B, user.ownerKey, user.token, a.email, b.email, a.fullName, b.fullName];
}

beforeAll(() => {
  dbClient.closeDatabase();
  const db = dbClient.getDatabase();
  seedDatabase(db);
  a = fx.seedOwner(db, fx.OWNER_A, fx.SPEC_A);
  b = fx.seedOwner(db, fx.OWNER_B, fx.SPEC_B);
  user = fx.createSignedInUser(db, "Grace Hopper");
  fx.seedOwner(db, user.ownerKey, {
    tag: "Grace",
    productId: "prod_lambswool-crew-jumper",
    waitingProductId: "prod_thinking-in-systems-field-guide",
    restockedProductId: "prod_canvas-tote-bag",
  });
  db.run("UPDATE products SET stock = 42 WHERE id = ?", ["prod_canvas-tote-bag"]);
  db.run("UPDATE products SET name = ? WHERE id = ?", [HOSTILE_NAME, fx.SPEC_A.productId]);
});

afterEach(() => {
  setCookies();
  getDatabaseSpy.mockClear();
  getOrCreateSpy.mockClear();
});

afterAll(() => {
  getDatabaseSpy.mockRestore();
  getOrCreateSpy.mockRestore();
  dbClient.closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});


function expectChrome(crumbLabel: string, h1: string | RegExp): void {
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(h1);
  const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(crumb).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  expect(within(crumb).getByRole("link", { name: "Your Account" })).toHaveAttribute("href", "/account");
  expect(within(crumb).getByText(crumbLabel)).toBeInTheDocument();
}

function expectNoWrites(): void {
  expect(getOrCreateSpy).not.toHaveBeenCalled();
  expect(fakeStore.setCalls).toEqual([]);
}

describe("/account/contributions", () => {
  test("metadata: noindex", async () => {
    const m = await generateMetadata();
    expect(m.title).toBe("Your Reviews & Questions");
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  test("no cookie: both empty states, unique headings, no DB read, no session", async () => {
    getDatabaseSpy.mockClear();
    const { container } = await renderPage();
    expectChrome("Your Reviews & Questions", "Your reviews & questions");
    expect(screen.getByText("You haven't reviewed any products yet.")).toBeInTheDocument();
    expect(screen.getByText("You haven't asked any questions yet.")).toBeInTheDocument();
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(new Set(h2).size).toBe(h2.length);
    expect(getDatabaseSpy).not.toHaveBeenCalled();
    expectNoWrites();
    expect(fx.markupViolations(container, { forbidden: forbidden() }, isAllowedInternalHref)).toEqual([]);
  });

  test("owner A: own review (no vote form) and own question as a read-only QuestionCard, product links, nothing of B's", async () => {
    setCookies({ guest: fx.OWNER_A });
    const { container } = await renderPage();
    expectChrome("Your Reviews & Questions", "Your reviews & questions");
    const reviews = screen.getByRole("list", { name: "Your reviews" });
    expect(within(reviews).getAllByRole("listitem")).toHaveLength(1);
    expect(within(reviews).getByText(`Alpha review ${fx.HOSTILE}`)).toBeInTheDocument();
    expect(within(reviews).getByRole("link", { name: HOSTILE_NAME })).toHaveAttribute("href", "/products/canvas-tote-bag");
    expect(within(reviews).queryByRole("button")).toBeNull();
    const questions = screen.getByRole("list", { name: "Your questions" });
    expect(within(questions).getByText(`Alpha question ${fx.HOSTILE}?`)).toBeInTheDocument();
    expect(within(questions).getByRole("link", { name: HOSTILE_NAME })).toHaveAttribute(
      "href",
      "/products/canvas-tote-bag#questions",
    );
    // CONS-B4 (an): QuestionCard without answerAction — no answer form, no question vote form.
    expect(within(questions).getAllByRole("article")).toHaveLength(1);
    expect(within(questions).queryByText("Answer this question")).toBeNull();
    expect(questions.querySelector("textarea, form")).toBeNull();
    expect(within(questions).queryByRole("button")).toBeNull();
    expect(within(questions).getByText("No answers yet.")).toBeInTheDocument();
    expect(within(questions).queryByText("Not published")).toBeNull();
    expect(container.textContent).not.toContain("Bravo");
    expectNoWrites();
    expect(fx.markupViolations(container, { forbidden: forbidden() }, isAllowedInternalHref)).toEqual([]);
  });

  test("another shopper's answer on an own question is listed read-only: count as text, no form, no button", async () => {
    const qa = createQaService({ db: dbClient.getDatabase() });
    const answered = qa.answer(fx.OWNER_B, { questionId: a.questionId, body: "Yes, it fits a laptop." });
    if (!answered.ok) throw new Error(answered.error.code);
    const voted = qa.voteAnswer(user.ownerKey, answered.value.id);
    if (!voted.ok) throw new Error(voted.error.code);
    setCookies({ guest: fx.OWNER_A });
    const { container } = await renderPage();
    const questions = screen.getByRole("list", { name: "Your questions" });
    expect(within(questions).getByText("Yes, it fits a laptop.")).toBeInTheDocument();
    expect(within(questions).getByText("1 person found this helpful")).toBeInTheDocument();
    expect(container.querySelector("form, textarea")).toBeNull();
    expect(within(questions).queryByRole("button")).toBeNull();
    expectNoWrites();
    expect(fx.markupViolations(container, { forbidden: forbidden() }, isAllowedInternalHref)).toEqual([]);
  });

  test("hidden own review is labelled Not published", async () => {
    dbClient.getDatabase().run("UPDATE reviews SET status = 'hidden' WHERE id = ?", [b.reviewId]);
    setCookies({ guest: fx.OWNER_B });
    const { container } = await renderPage();
    expect(screen.getByText("Not published")).toBeInTheDocument();
    expect(container.textContent).toContain("Bravo review");
    expect(container.textContent).not.toContain("Alpha");
  });

  test("hidden own question is labelled Not published inside its card", async () => {
    dbClient.getDatabase().run("UPDATE questions SET status = 'hidden' WHERE id = ?", [b.questionId]);
    setCookies({ guest: fx.OWNER_B });
    await renderPage();
    const questions = screen.getByRole("list", { name: "Your questions" });
    const card = within(questions).getByRole("article");
    expect(within(card).getByText("Not published")).toBeInTheDocument();
    expect(card.textContent).toContain("Bravo question");
    expect(card.querySelector("textarea, form")).toBeNull();
  });

  test("signed in: the user's contributions only", async () => {
    setCookies({ auth: user.token });
    const { container } = await renderPage();
    expect(container.textContent).toContain("Grace review");
    expect(container.textContent).not.toContain("Alpha");
    expectNoWrites();
  });

  describe("guest sign-in invitation (D-T98-1)", () => {
    const next = encodeURIComponent("/account/contributions");

    function invitation(container: HTMLElement): HTMLElement {
      const group = within(container).getByRole("group", { name: GUEST_STATE_LABEL });
      expect(group).toHaveTextContent(GUEST_NOTICE_TEXT);
      expect(within(group).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", `/signin?next=${next}`);
      expect(within(group).getByRole("link", { name: "Create account" })).toHaveAttribute("href", `/signup?next=${next}`);
      return group;
    }

    test("no cookie: invitation above the still-rendered empty states; one h1, no DB read, no cookie writes", async () => {
      getDatabaseSpy.mockClear();
      const { container } = await renderPage();
      const group = invitation(container);
      const empty = within(container).getByText("You haven't reviewed any products yet.");
      expect(group.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(container).getByText("You haven't asked any questions yet.")).toBeInTheDocument();
      expect(within(container).getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(within(group).queryByRole("heading")).toBeNull();
      expect(getDatabaseSpy).not.toHaveBeenCalled();
      expectNoWrites();
    });

    test("garbage cookie and a guest cookie with data: invitation shown, no cookie writes", async () => {
      for (const guest of ["garbage", fx.OWNER_A]) {
        setCookies({ guest });
        const { container, unmount } = await renderPage();
        invitation(container);
        expectNoWrites();
        unmount();
      }
    });

    test("signed in: no invitation and no device-bound notice", async () => {
      setCookies({ auth: user.token });
      const { container } = await renderPage();
      expect(within(container).queryByRole("group", { name: GUEST_STATE_LABEL })).toBeNull();
      expect(container.textContent).not.toContain(GUEST_NOTICE_TEXT);
      expectNoWrites();
    });
  });
});
