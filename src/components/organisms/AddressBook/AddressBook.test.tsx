import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AddressActionFn, AddressActionState } from "@/components/molecules/_contracts/address-actions";
import { isAllowedInternalHref } from "@/content/routes";
import type { SavedAddress } from "@/lib/types";
import {
  ADD_ADDRESS_TITLE,
  ADDRESS_BOOK_HEADING_ID,
  ADDRESS_BOOK_LIMIT_NOTICE_ID,
  ADDRESS_DELETED_TEXT,
  ADDRESS_SAVED_TEXT,
  AddressBook,
  EMPTY_ADDRESSES_TEXT,
  FIRST_ADDRESS_DEFAULT_TEXT,
  limitReachedText,
  type AddressBookProps,
} from "./index";
import { expectFocused, expectNotFocused } from "@/test/dom-assertions";

type Fields = Record<string, string>;

function recorder(result: AddressActionState = null) {
  const calls: Fields[] = [];
  const action: AddressActionFn = async (_prev, formData) => {
    const out: Fields = {};
    formData.forEach((value, name) => {
      if (typeof value === "string") out[name] = value;
    });
    calls.push(out);
    return result;
  };
  return { action, calls };
}

function makeActions() {
  const save = recorder({ ok: true, kind: "saved", message: "Address saved." });
  const del = recorder({ ok: true, kind: "deleted", message: "Address deleted." });
  const setDefault = recorder({ ok: true, kind: "default_set", message: "Default address updated." });
  return {
    actions: { save: save.action, delete: del.action, setDefault: setDefault.action },
    save,
    del,
    setDefault,
  };
}

let seq = 0;
function addr(overrides: Partial<SavedAddress> = {}): SavedAddress {
  seq += 1;
  return {
    id: `id-${seq}`,
    label: "",
    fullName: `Person Number${seq}`,
    line1: `${seq} Elm Street`,
    city: "Springfield",
    region: "IL",
    postalCode: "62704",
    country: "US",
    isDefault: false,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  };
}

const PII = {
  fullName: "Zelda Quixotefield",
  phone: "+1 555 987 6543",
  line1: "742 Evergreen Terrace",
  city: "Shelbyvillex",
  label: "Beach House",
  postalCode: "90210",
  id: "4f9c2d1e-0000-4000-8000-00000000abcd",
};

const PII_ADDRESS: SavedAddress = addr({
  id: PII.id,
  fullName: PII.fullName,
  phone: PII.phone,
  line1: PII.line1,
  city: PII.city,
  label: PII.label,
  postalCode: PII.postalCode,
  isDefault: true,
});

function many(n: number): SavedAddress[] {
  return Array.from({ length: n }, (_, i) => addr({ isDefault: i === 0 }));
}

function staticDom(props: Partial<AddressBookProps> & Pick<AddressBookProps, "addresses">): HTMLElement {
  const html = renderToStaticMarkup(<AddressBook actions={makeActions().actions} {...props} />);
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

const badges = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("span, div")).filter(
    (el) => el.children.length <= 1 && el.textContent?.trim() === "Default",
  );
const named = (verb: string, title: string) => new RegExp(`^${verb}\\s*, ${title}$`);
const cards = (root: HTMLElement) => Array.from(root.querySelectorAll("ul > li"));
const addForm = (root: HTMLElement) => root.querySelector(`form[aria-label="${ADD_ADDRESS_TITLE}"]`);

describe("AddressBook static markup (no JS)", () => {
  test("empty state shows text, first-address note and the add form", () => {
    const root = staticDom({ addresses: [] });
    expect(root.querySelector("h1")?.textContent).toBe("Your addresses");
    expect(root.textContent).toContain(EMPTY_ADDRESSES_TEXT);
    expect(root.textContent).toContain(FIRST_ADDRESS_DEFAULT_TEXT);
    expect(root.querySelector("ul")).toBeNull();
    const form = addForm(root);
    expect(form).not.toBeNull();
    // first address always becomes default: no checkbox, the note says so
    expect(form?.querySelector('input[name="isDefault"]')).toBeNull();
    expect(root.querySelector(`#${ADDRESS_BOOK_LIMIT_NOTICE_ID}`)).toBeNull();
  });

  test("limit boundary: 9 -> add form shown with default checkbox", () => {
    const root = staticDom({ addresses: many(9) });
    expect(cards(root)).toHaveLength(9);
    expect(addForm(root)).not.toBeNull();
    expect(addForm(root)?.querySelector('input[name="isDefault"]')).not.toBeNull();
    expect(root.textContent).not.toContain(FIRST_ADDRESS_DEFAULT_TEXT);
    expect(root.querySelector(`#${ADDRESS_BOOK_LIMIT_NOTICE_ID}`)).toBeNull();
  });

  test("limit boundary: 10 -> add form hidden, notice shown", () => {
    const root = staticDom({ addresses: many(10) });
    expect(cards(root)).toHaveLength(10);
    expect(addForm(root)).toBeNull();
    const notice = root.querySelector(`#${ADDRESS_BOOK_LIMIT_NOTICE_ID}`);
    expect(notice?.textContent).toContain("You've reached the limit of 10 addresses. Delete one to add another.");
    expect(notice?.getAttribute("role")).toBe("status");
  });

  test("custom and invalid limit", () => {
    expect(addForm(staticDom({ addresses: many(3), limit: 3 }))).toBeNull();
    expect(staticDom({ addresses: many(3), limit: 3 }).textContent).toContain(limitReachedText(3));
    expect(addForm(staticDom({ addresses: many(3), limit: 0 }))).not.toBeNull();
    expect(addForm(staticDom({ addresses: many(11) }))).toBeNull();
  });

  test.each([
    ["0 flagged", [false, false, false], 0],
    ["1 flagged", [false, true, false], 1],
    ["2 flagged", [false, true, true], 1],
    ["3 flagged", [true, true, true], 1],
  ] as const)("exactly-one badge: %s", (_name, flags, expected) => {
    const list = flags.map((isDefault) => addr({ isDefault }));
    const root = staticDom({ addresses: list });
    expect(badges(root)).toHaveLength(expected);
    if (expected === 1) {
      const firstFlagged = list.find((a) => a.isDefault);
      // the badge sits on the first card, which is the first flagged address
      expect(badges(cards(root)[0] as HTMLElement)).toHaveLength(1);
      expect(cards(root)[0]?.querySelector("h2")?.textContent).toBe(firstFlagged?.fullName);
    }
  });

  test("default sorted first, others in service order", () => {
    const a = addr();
    const b = addr();
    const c = addr({ isDefault: true });
    const root = staticDom({ addresses: [a, b, c] });
    expect(cards(root).map((li) => li.querySelector("h2")?.textContent)).toEqual([
      c.fullName,
      a.fullName,
      b.fullName,
    ]);
  });

  test("headings: level 1 default, cards and add heading one below; level 2 shifts", () => {
    const one = staticDom({ addresses: many(2) });
    expect(one.querySelectorAll("h1")).toHaveLength(1);
    expect(one.querySelectorAll("ul > li article h2")).toHaveLength(2);
    expect(one.querySelector(`h2#address-book-add-heading`)?.textContent).toBe(ADD_ADDRESS_TITLE);
    const two = staticDom({ addresses: many(2), headingLevel: 2 });
    expect(two.querySelector("h1")).toBeNull();
    expect(two.querySelector(`h2#${ADDRESS_BOOK_HEADING_ID}`)).not.toBeNull();
    expect(two.querySelectorAll("ul > li article h3")).toHaveLength(2);
  });

  test("delete confirm works without JS: details + required confirm checkbox", () => {
    const list = many(3);
    const root = staticDom({ addresses: list });
    cards(root).forEach((li, i) => {
      const deleteForm = Array.from(li.querySelectorAll("article details form")).find(
        (f) => f.querySelector('input[name="confirm"]') !== null,
      );
      expect(deleteForm).toBeDefined();
      const confirm = deleteForm?.querySelector('input[name="confirm"]');
      expect(confirm?.getAttribute("type")).toBe("checkbox");
      expect(confirm?.getAttribute("value")).toBe("yes");
      expect(confirm?.hasAttribute("required")).toBe(true);
      expect(deleteForm?.querySelector('input[name="addressId"]')?.getAttribute("value")).toBe(list[i]?.id);
      expect(deleteForm?.querySelector('button[type="submit"]')).not.toBeNull();
    });
  });

  test("edit form per card inside an Edit disclosure, sibling of the card", () => {
    const list = many(3);
    const root = staticDom({ addresses: list });
    cards(root).forEach((li, i) => {
      const details = li.querySelector(":scope > details");
      expect(details?.querySelector("summary")?.textContent).toContain("Edit");
      const form = details?.querySelector("form");
      expect(form?.id).toBe(`address-form-${i}`);
      expect(form?.querySelector('input[name="addressId"]')?.getAttribute("value")).toBe(list[i]?.id);
      expect(form?.querySelector('input[name="fullName"]')?.getAttribute("value")).toBe(list[i]?.fullName);
    });
  });

  test("D-T98-3: each edit submit names its address (sr-only suffix); visible text unchanged", () => {
    const list = [addr({ label: "Home", isDefault: true }), addr(), addr()];
    const root = staticDom({ addresses: list });
    const submits = cards(root).map((li) => li.querySelector(":scope > details form button[type=submit]"));
    expect(submits.map((b) => b?.textContent)).toEqual([
      "Update address: Home",
      `Update address: ${list[1]?.fullName}`,
      `Update address: ${list[2]?.fullName}`,
    ]);
    for (const b of submits) {
      expect(b?.querySelector(".sr-only")?.textContent?.startsWith(": ")).toBe(true);
      // The visible (non-sr-only) text stays "Update address".
      const visible = Array.from(b?.childNodes ?? [])
        .filter((n) => !(n instanceof HTMLElement && n.classList.contains("sr-only")))
        .map((n) => n.textContent ?? "")
        .join("");
      expect(visible).toBe("Update address");
    }
    const names = Array.from(root.querySelectorAll("form button[type=submit]")).map((b) => b.textContent);
    expect(new Set(names).size).toBe(names.length);
  });

  test("D-T98-2: add and edit forms render no email input and no email text", () => {
    const root = staticDom({ addresses: many(2) });
    expect(root.querySelectorAll('[name="email"], input[type="email"]')).toHaveLength(0);
    expect(root.textContent ?? "").not.toMatch(/email/i);
    expect(root.innerHTML).not.toContain("nth-2");
  });

  test("no nested forms; every id unique; expected form count", () => {
    const root = staticDom({ addresses: many(4) });
    expect(root.querySelectorAll("form form")).toHaveLength(0);
    // 3 set-default + 4 delete + 4 edit + 1 add
    expect(root.querySelectorAll("form")).toHaveLength(12);
    const allIds = Array.from(root.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  test("criterion 4: no address content in id/name/for/data-*/aria-* attributes", () => {
    const root = staticDom({ addresses: [PII_ADDRESS, addr()] });
    const needles = Object.values(PII).map((v) => v.toLowerCase());
    const offenders: string[] = [];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        const n = attr.name;
        if (n === "id" || n === "name" || n === "for" || n.startsWith("data-") || n.startsWith("aria-")) {
          const v = attr.value.toLowerCase();
          for (const needle of needles) if (v.includes(needle)) offenders.push(`${n}="${attr.value}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // the content itself is there as text
    expect(root.textContent).toContain(PII.fullName);
    expect(root.textContent).toContain(PII.line1);
  });

  test("hostile names and streets render as text", () => {
    const hostile = addr({
      fullName: '<img src=x onerror="alert(1)">',
      line1: "<script>alert(2)</script>",
      label: "\"><svg onload=alert(3)>",
      isDefault: true,
    });
    const root = staticDom({ addresses: [hostile] });
    expect(root.querySelector("img, svg[onload]")).toBeNull();
    // the only <script> is React's form-replay helper, never address text
    for (const script of Array.from(root.querySelectorAll("script"))) {
      expect(script.textContent).not.toContain("alert(");
    }
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(root.textContent).toContain("<script>alert(2)</script>");
  });

  test("every href passes isAllowedInternalHref; status region and 320px classes", () => {
    const root = staticDom({ addresses: many(3) });
    for (const a of Array.from(root.querySelectorAll("[href]"))) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
    expect(root.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    const section = root.querySelector("section");
    expect(section?.className).toContain("min-w-0");
    expect(root.querySelector("ul")?.className).toContain("grid-cols-1");
  });
});

describe("AddressBook with JS", () => {
  test("actions are wired: delete via dialog, set default, edit save", async () => {
    const { actions, del, setDefault, save } = makeActions();
    const a = addr({ isDefault: true, label: "Home" });
    const b = addr({ label: "Work" });
    render(<AddressBook addresses={[a, b]} actions={actions} />);

    const work = screen.getAllByRole("listitem")[1] as HTMLElement;
    fireEvent.submit(within(work).getByRole("button", { name: named("Set as default", "Work") }).closest("form") as HTMLFormElement);
    await waitFor(() => expect(setDefault.calls).toEqual([{ addressId: b.id }]));

    fireEvent.click(await within(work).findByRole("button", { name: named("Delete", "Work") }));
    const dialog = work.querySelector("dialog") as HTMLDialogElement;
    await waitFor(() => expect(dialog.open).toBe(true));
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(del.calls).toEqual([{ addressId: b.id, confirm: "yes" }]));

    const editForm = work.querySelector("details form") as HTMLFormElement;
    fireEvent.submit(editForm);
    await waitFor(() => expect(save.calls).toHaveLength(1));
    expect(save.calls[0]?.addressId).toBe(b.id);
    expect(save.calls[0]?.fullName).toBe(b.fullName);
  });

  test("after a delete, focus moves to the next card heading (not body) and it is announced", async () => {
    const { actions } = makeActions();
    const list = [addr({ isDefault: true }), addr(), addr()];
    const { rerender } = render(<AddressBook addresses={list} actions={actions} />);
    const second = screen.getAllByRole("listitem")[1] as HTMLElement;
    const trigger = await within(second).findByRole("button", { name: named("Delete", list[1]?.fullName ?? "") });
    trigger.focus();
    expectFocused(trigger);

    await act(async () => {
      rerender(<AddressBook addresses={[list[0] as SavedAddress, list[2] as SavedAddress]} actions={actions} />);
    });
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    expectNotFocused(document.body);
    expect(document.activeElement?.textContent).toBe(list[2]?.fullName);
    expect(screen.getByText(ADDRESS_DELETED_TEXT)).toBeInTheDocument();
  });

  test("deleting the last card moves focus to the book heading and shows the empty state", async () => {
    const { actions } = makeActions();
    const only = addr({ isDefault: true });
    const { rerender } = render(<AddressBook addresses={[only]} actions={actions} />);
    const trigger = await screen.findByRole("button", { name: named("Delete", only.fullName) });
    trigger.focus();
    await act(async () => {
      rerender(<AddressBook addresses={[]} actions={actions} />);
    });
    await waitFor(() => expect(document.activeElement?.id).toBe(ADDRESS_BOOK_HEADING_ID));
    expect(screen.getByText(EMPTY_ADDRESSES_TEXT)).toBeInTheDocument();
  });

  test("reaching the limit by adding moves focus to the limit notice and announces the save", async () => {
    const { actions } = makeActions();
    const nine = many(9);
    const { rerender } = render(<AddressBook addresses={nine} actions={actions} />);
    const submit = screen.getByRole("button", { name: "Add address" });
    submit.focus();
    await act(async () => {
      rerender(<AddressBook addresses={[...nine, addr()]} actions={actions} />);
    });
    await waitFor(() => expect(document.activeElement?.id).toBe(ADDRESS_BOOK_LIMIT_NOTICE_ID));
    expect(screen.queryByRole("button", { name: "Add address" })).toBeNull();
    expect(screen.getByText(ADDRESS_SAVED_TEXT)).toBeInTheDocument();
  });

  test("set as default: focus follows the new default card when its button disappears", async () => {
    const { actions } = makeActions();
    const a = addr({ isDefault: true });
    const b = addr();
    const { rerender } = render(<AddressBook addresses={[a, b]} actions={actions} />);
    const button = screen.getByRole("button", { name: named("Set as default", b.fullName) });
    button.focus();
    await act(async () => {
      rerender(<AddressBook addresses={[{ ...a, isDefault: false }, { ...b, isDefault: true }]} actions={actions} />);
    });
    await waitFor(() => expect(document.activeElement?.textContent).toBe(b.fullName));
    expect(screen.getAllByRole("listitem")[0]?.querySelector("h2")?.textContent).toBe(b.fullName);
  });

  test("focus is left alone when it was not lost", async () => {
    const { actions } = makeActions();
    const list = [addr({ isDefault: true }), addr()];
    const { rerender } = render(
      <>
        <button type="button">Outside</button>
        <AddressBook addresses={list} actions={actions} />
      </>,
    );
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    await act(async () => {
      rerender(
        <>
          <button type="button">Outside</button>
          <AddressBook addresses={[list[0] as SavedAddress]} actions={actions} />
        </>,
      );
    });
    expectFocused(outside);
    expect(screen.getByText(ADDRESS_DELETED_TEXT)).toBeInTheDocument();
  });
});

describe("AddressBook: Phase 3 look (T162)", () => {
  test("add form is a Card section; empty text on a sunken Card; headings unchanged", () => {
    const root = staticDom({ addresses: [] });
    const add = root.querySelector('[data-slot="address-book-add"]');
    expect(add?.tagName).toBe("SECTION");
    expect(add?.getAttribute("aria-labelledby")).toBe("address-book-add-heading");
    expect(add).toHaveClass("bg-surface-raised", "rounded-lg");
    expect(add?.querySelector(`form[aria-label="${ADD_ADDRESS_TITLE}"]`)).not.toBeNull();
    const empty = root.querySelector('[data-slot="address-book-empty"]');
    expect(empty).toHaveClass("bg-surface-sunken");
    expect(empty?.textContent).toBe(EMPTY_ADDRESSES_TEXT);
  });

  test("edit disclosures keep the bordered look", () => {
    const root = staticDom({ addresses: [addr()] });
    const details = root.querySelector("ul > li > details");
    expect(details).toHaveClass("rounded-lg", "border-border-default", "shadow-sm");
  });
});
