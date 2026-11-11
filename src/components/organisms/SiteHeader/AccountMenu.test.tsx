import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCOUNT_NAV, AUTH_NAV } from "@/content/navigation";
import { ACCOUNT_MENU_LABEL, AccountMenu } from "./AccountMenu";
import type { HeaderAccount } from "./AccountMenu";
import { expectFocused } from "@/test/dom-assertions";

const noopSignOut = () => {};

function signedIn(displayName: string, signOutAction: (formData: FormData) => void = noopSignOut): HeaderAccount {
  return { status: "signed-in", displayName, signOutAction };
}

function renderMenu(account: HeaderAccount) {
  return render(
    <div>
      <AccountMenu account={account} accountNav={ACCOUNT_NAV} authNav={AUTH_NAV} />
      <button type="button">Outside</button>
    </div>,
  );
}

function details(): HTMLDetailsElement {
  const el = screen.getByTestId("account-menu");
  if (!(el instanceof HTMLDetailsElement)) throw new Error("account menu is not a <details>");
  return el;
}

function summary(): HTMLElement {
  const el = details().querySelector("summary");
  if (el === null) throw new Error("no summary");
  return el;
}

function openMenu() {
  // Native <details> toggling: set open and dispatch the toggle event the browser would fire.
  act(() => {
    details().open = true;
    details().dispatchEvent(new Event("toggle"));
  });
}

describe("AccountMenu: guest", () => {
  test("shows 'Hello, Sign in' linking to /signin, flyout lists AUTH_NAV and no Sign out form", () => {
    renderMenu({ status: "guest" });
    const link = screen.getByRole("link", { name: "Hello, Sign in, Account & Lists" });
    expect(link).toHaveAttribute("href", "/signin");
    expect(link).toHaveTextContent("Hello, Sign in");
    const panel = details();
    const hrefs = within(panel).getAllByRole("link", { hidden: true }).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(AUTH_NAV.map((l) => l.href));
    expect(within(panel).queryByRole("button", { name: "Sign out", hidden: true })).toBeNull();
  });
});

describe("AccountMenu: signed in", () => {
  test("shows 'Hello, <name>' linking to /account, flyout lists ACCOUNT_NAV and a Sign out form", () => {
    renderMenu(signedIn("Ada"));
    const link = screen.getByRole("link", { name: "Hello, Ada, Account & Lists" });
    expect(link).toHaveAttribute("href", "/account");
    const panel = details();
    const hrefs = within(panel).getAllByRole("link", { hidden: true }).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(ACCOUNT_NAV.map((l) => l.href));
    const button = within(panel).getByRole("button", { name: "Sign out", hidden: true });
    expect(button).toHaveAttribute("type", "submit");
    expect(button.closest("form")).not.toBeNull();
  });

  test("long names are truncated visibly (20 chars) with the full name in the accessible name", () => {
    const name = "Bartholomew Montgomery-Fitzgerald";
    renderMenu(signedIn(name));
    const link = screen.getByRole("link", { name: `Hello, ${name}, Account & Lists` });
    expect(link).toHaveTextContent("Hello, Bartholomew Montgome…");
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toBe("Hello, Bartholomew Montgome…");
  });

  test("hostile display name renders as text, never markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const { container } = renderMenu(signedIn(hostile));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: `Hello, ${hostile}, Account & Lists` })).toBeInTheDocument();
    const html = renderToStaticMarkup(<AccountMenu account={signedIn(hostile)} accountNav={ACCOUNT_NAV} authNav={AUTH_NAV} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=");
  });

  test("blank display name greets 'there' and still links to /account", () => {
    renderMenu(signedIn("   "));
    expect(screen.getByRole("link", { name: "Hello, there, Account & Lists" })).toHaveAttribute("href", "/account");
  });

  test("Sign out submits the form to the given action", async () => {
    const action = mock((formData: FormData) => void formData);
    renderMenu(signedIn("Ada", action));
    openMenu();
    const button = within(details()).getByRole("button", { name: "Sign out" });
    const form = button.closest("form");
    if (form === null) throw new Error("no form");
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toBeInstanceOf(FormData);
  });
});

describe("AccountMenu: disclosure behaviour (criterion 3)", () => {
  test("summary is a native <details>/<summary> named 'Account menu', closed by default", () => {
    renderMenu({ status: "guest" });
    expect(details().open).toBe(false);
    expect(summary()).toHaveTextContent(ACCOUNT_MENU_LABEL);
  });

  test("Escape closes the open menu and returns focus to the summary", () => {
    renderMenu(signedIn("Ada"));
    openMenu();
    expect(details().open).toBe(true);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(details().open).toBe(false);
    expectFocused(summary());
  });

  test("other keys do not close it", () => {
    renderMenu(signedIn("Ada"));
    openMenu();
    act(() => {
      fireEvent.keyDown(document, { key: "a" });
    });
    expect(details().open).toBe(true);
  });

  test("a pointer press outside closes it; inside does not", () => {
    renderMenu(signedIn("Ada"));
    openMenu();
    const inside = within(details()).getByRole("link", { name: "Your account" });
    act(() => {
      fireEvent.pointerDown(inside);
    });
    expect(details().open).toBe(true);
    act(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    });
    expect(details().open).toBe(false);
  });

  test("activating a panel link closes it", () => {
    renderMenu({ status: "guest" });
    openMenu();
    const signIn = within(details()).getByRole("link", { name: "Sign in" });
    act(() => {
      signIn.addEventListener("click", (event) => event.preventDefault(), { once: true });
      fireEvent.click(signIn);
    });
    expect(details().open).toBe(false);
  });

  test("listeners are removed once closed (Escape after close keeps it closed, no focus jump)", () => {
    renderMenu(signedIn("Ada"));
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expectFocused(outside);
  });
});
