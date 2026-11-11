// QA (QA-W4-organisms-E / T90): T84 AddressBook (+ AddressBookList island, address-book-model).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AddressActionFn, AddressActionState } from "@/components/molecules/_contracts/address-actions";
import {
  ADD_ADDRESS_TITLE,
  ADDRESS_BOOK_HEADING_ID,
  ADDRESS_BOOK_LIMIT,
  ADDRESS_BOOK_LIMIT_NOTICE_ID,
  AddressBook,
  EMPTY_ADDRESSES_TEXT,
  FIRST_ADDRESS_DEFAULT_TEXT,
  limitReachedText,
  sortAddresses,
  type AddressBookProps,
} from "@/components/organisms/AddressBook";
import { MAX_ADDRESSES_PER_SESSION } from "@/server/addresses/address-service";
import type { SavedAddress } from "@/lib/types";
import { expectFocused, expectNotFocused } from "@/test/dom-assertions";

const SRC = join(import.meta.dir, "../../../src/components/organisms/AddressBook");
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp;`;
const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

function serverLike(): AddressActionFn {
  const formFields = () => ({ name: "$ACTION_REF_1", action: "", encType: "multipart/form-data", method: "POST", data: null });
  const fn: AddressActionFn = async () => null;
  return Object.assign(fn, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}

function recorder(result: AddressActionState = null) {
  const calls: Array<Record<string, string>> = [];
  const action: AddressActionFn = async (_prev, fd) => {
    const out: Record<string, string> = {};
    fd.forEach((v, k) => {
      if (typeof v === "string") out[k] = v;
    });
    calls.push(out);
    return result;
  };
  return { action, calls };
}

const noop: AddressActionFn = async () => null;
const ACTIONS = { save: noop, delete: noop, setDefault: noop };

let seq = 0;
function addr(over: Partial<SavedAddress> = {}): SavedAddress {
  seq += 1;
  return {
    id: `0f8fad5b-d9cb-469f-a165-${String(seq).padStart(12, "0")}`,
    label: "",
    fullName: `Person Q${seq}`,
    line1: `${seq} Elm Street`,
    city: "Springfield",
    region: "IL",
    postalCode: "62704",
    country: "US",
    isDefault: false,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...over,
  };
}
const many = (n: number, defaultIndex = 0) => Array.from({ length: n }, (_, i) => addr({ isDefault: i === defaultIndex }));

function book(over: Partial<AddressBookProps> = {}): AddressBookProps {
  return { addresses: [], actions: ACTIONS, ...over };
}

// T164 (T162 restyle): the "Default" badge is no longer a pill (square Badge, success tone);
// still matched as a badge by its text plus the success tone, not by any "Default" text.
const defaultBadges = (root: ParentNode): number =>
  [...root.querySelectorAll("article span")].filter((s) => s.textContent?.trim() === "Default" && /(^|\s)text-success(\s|$)/.test(s.className)).length;

// --------------------------------------------------------------------------------------------
describe("T84 criterion 1: empty state and limit", () => {
  test("empty: empty text, add form, first-address-becomes-default note, no default checkbox", () => {
    render(<AddressBook {...book()} />);
    expect(screen.getByText(EMPTY_ADDRESSES_TEXT)).toBeInTheDocument();
    expect(screen.getByText(FIRST_ADDRESS_DEFAULT_TEXT)).toBeInTheDocument();
    const form = screen.getByRole("form", { name: ADD_ADDRESS_TITLE });
    expect(within(form).queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("9 addresses: add form shown with a default checkbox; no notice; no first-address note", () => {
    render(<AddressBook {...book({ addresses: many(9) })} />);
    const form = screen.getByRole("form", { name: ADD_ADDRESS_TITLE });
    expect(within(form).getByRole("checkbox")).toBeInTheDocument();
    expect(document.getElementById(ADDRESS_BOOK_LIMIT_NOTICE_ID)).toBeNull();
    expect(screen.queryByText(FIRST_ADDRESS_DEFAULT_TEXT)).toBeNull();
  });

  for (const n of [10, 11]) {
    test(`${n} addresses: add form hidden; info Notice role="status" with the limit text`, () => {
      render(<AddressBook {...book({ addresses: many(n) })} />);
      expect(screen.queryByRole("form", { name: ADD_ADDRESS_TITLE })).toBeNull();
      const notice = document.getElementById(ADDRESS_BOOK_LIMIT_NOTICE_ID);
      expect(notice?.getAttribute("role")).toBe("status");
      expect(notice?.getAttribute("data-tone")).toBe("info");
      expect(notice?.textContent).toContain(limitReachedText(10));
      expect(screen.getAllByRole("article")).toHaveLength(n);
    });
  }

  test("limit prop: custom 3 honoured; invalid values fall back to 10", () => {
    const { unmount } = render(<AddressBook {...book({ addresses: many(3), limit: 3 })} />);
    expect(screen.queryByRole("form", { name: ADD_ADDRESS_TITLE })).toBeNull();
    expect(screen.getByText(limitReachedText(3))).toBeInTheDocument();
    unmount();
    for (const limit of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const html = renderToStaticMarkup(<AddressBook {...book({ addresses: many(9), limit })} />);
      expect(html).toContain('aria-label="Add a new address"');
    }
  });

  test("ADDRESS_BOOK_LIMIT === MAX_ADDRESSES_PER_SESSION (10)", () => {
    expect(ADDRESS_BOOK_LIMIT).toBe(MAX_ADDRESSES_PER_SESSION);
    expect(ADDRESS_BOOK_LIMIT).toBe(10);
  });
});

// --------------------------------------------------------------------------------------------
describe("T84 criterion 2: exactly one Default badge, default first", () => {
  test("0/1/2/3 flagged entries -> 0/1/1/1 badges, first flagged wins and is sorted first", () => {
    const cases: Array<[boolean[], number, number | null]> = [
      [[false, false, false, false], 0, null],
      [[false, false, true, false], 1, 2],
      [[false, true, false, true], 1, 1],
      [[true, false, true, true], 1, 0],
    ];
    for (const [flags, expected, winner] of cases) {
      const list = flags.map((isDefault, i) => addr({ isDefault, fullName: `Name ${i}` }));
      const { container, unmount } = render(<AddressBook {...book({ addresses: list })} />);
      expect(defaultBadges(container)).toBe(expected);
      const firstCard = container.querySelector("ul[role=list] > li article");
      if (winner !== null) expect(firstCard?.textContent).toContain(`Name ${winner}`);
      unmount();
    }
  });

  test("no default: service order preserved; with default: others keep relative order", () => {
    const list = [addr({ fullName: "A" }), addr({ fullName: "B" }), addr({ fullName: "C", isDefault: true }), addr({ fullName: "D" })];
    expect(sortAddresses(list).map((a) => a.fullName)).toEqual(["C", "A", "B", "D"]);
    const none = list.map((a) => ({ ...a, isDefault: false }));
    expect(sortAddresses(none).map((a) => a.fullName)).toEqual(["A", "B", "C", "D"]);
    expect(sortAddresses(list.map((a) => ({ ...a, isDefault: true }))).filter((a) => a.isDefault)).toHaveLength(1);
    // input not mutated
    expect(list[2]?.isDefault).toBe(true);
    expect(list.map((a) => a.fullName)).toEqual(["A", "B", "C", "D"]);
  });
});

// --------------------------------------------------------------------------------------------
describe("T84 criterion 3: no-JS forms", () => {
  function staticDoc(addresses: SavedAddress[]): Document {
    const a = serverLike();
    return parse(renderToStaticMarkup(<AddressBook addresses={addresses} actions={{ save: a, delete: a, setDefault: a }} />));
  }

  test("every form is POST multipart with a server action; none nested", () => {
    const doc = staticDoc(many(3));
    const forms = [...doc.querySelectorAll("form")];
    // 3 x (delete + edit) + 2 x set-default + add = 9
    expect(forms.length).toBe(9);
    for (const f of forms) {
      expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(f.getAttribute("enctype")).toBe("multipart/form-data");
      expect(f.getAttribute("action") ?? "").not.toContain("javascript:");
    }
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
  });

  test("delete: inside <details>, required confirm=yes checkbox + hidden addressId (static markup)", () => {
    const list = many(2);
    const doc = staticDoc(list);
    const deleteForms = [...doc.querySelectorAll("form")].filter((f) => f.querySelector('input[name="confirm"]'));
    expect(deleteForms).toHaveLength(2);
    deleteForms.forEach((f, i) => {
      expect(f.closest("details")).not.toBeNull();
      expect(f.closest("details")?.hasAttribute("open")).toBe(false);
      const confirm = f.querySelector('input[name="confirm"]');
      expect(confirm?.getAttribute("type")).toBe("checkbox");
      expect(confirm?.hasAttribute("required")).toBe(true);
      expect(confirm?.getAttribute("value")).toBe("yes");
      const hidden = f.querySelector('input[type="hidden"][name="addressId"]');
      expect(hidden?.getAttribute("value")).toBe(list[i]?.id);
      expect(f.querySelector("button[type=submit]")?.textContent).toMatch(/^Delete/);
    });
  });

  test("set default: one-button form with hidden addressId on non-default cards only", () => {
    const list = many(3, 1);
    const doc = staticDoc(list);
    const sd = [...doc.querySelectorAll("form")].filter(
      (f) => !f.querySelector('input[name="confirm"]') && !f.hasAttribute("id") && f.querySelector('input[name="addressId"]'),
    );
    expect(sd).toHaveLength(2);
    const ids = sd.map((f) => f.querySelector('input[name="addressId"]')?.getAttribute("value"));
    expect(ids).not.toContain(list[1]?.id);
  });

  test("Edit: sibling <details> after the card, form idPrefix address-form-<index>, hidden addressId", () => {
    const list = many(3);
    const doc = staticDoc(list);
    const items = [...doc.querySelectorAll("ul[role=list] > li")];
    expect(items).toHaveLength(3);
    items.forEach((li, i) => {
      const article = li.querySelector(":scope > article");
      const details = li.querySelector(":scope > details");
      expect(article).not.toBeNull();
      expect(details).not.toBeNull();
      expect(article?.contains(details as Node)).toBe(false);
      expect(details?.querySelector("summary")?.textContent).toMatch(/^Edit/);
      const form = details?.querySelector("form");
      expect(form?.getAttribute("id")).toBe(`address-form-${i}`);
      expect(form?.querySelector('input[type="hidden"][name="addressId"]')?.getAttribute("value")).toBe(sortAddresses(list)[i]?.id);
    });
  });

  test("actions passed unwrapped: delete / setDefault / save receive the posted fields", async () => {
    const del = recorder({ ok: true, kind: "deleted", message: "Address deleted." } as unknown as AddressActionState);
    const sd = recorder();
    const save = recorder();
    const list = many(2);
    const { container } = render(<AddressBook addresses={list} actions={{ save: save.action, delete: del.action, setDefault: sd.action }} />);
    const deleteForm = [...container.querySelectorAll("form")].find((f) => f.querySelector('input[name="confirm"]')) as HTMLFormElement;
    (deleteForm.querySelector('input[name="confirm"]') as HTMLInputElement).checked = true;
    await act(async () => {
      fireEvent.submit(deleteForm);
    });
    await waitFor(() => expect(del.calls.length).toBe(1));
    expect(del.calls[0]).toEqual({ addressId: list[0]?.id ?? "", confirm: "yes" });
    const editForm = container.querySelector("form#address-form-1") as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(editForm);
    });
    await waitFor(() => expect(save.calls.length).toBe(1));
    expect(save.calls[0]?.addressId).toBe(list[1]?.id);
  });
});

// --------------------------------------------------------------------------------------------
describe("T84 criterion 3: focus after JS actions is never lost to <body>", () => {
  function setup(addresses: SavedAddress[]) {
    const r = render(<AddressBook addresses={addresses} actions={ACTIONS} />);
    return {
      ...r,
      update: (next: SavedAddress[]) => r.rerender(<AddressBook addresses={next} actions={ACTIONS} />),
    };
  }

  test("delete middle card: focus goes to the heading of the card that took its place", async () => {
    const list = many(3);
    const { container, update } = setup(list);
    const forms = [...container.querySelectorAll("form")].filter((f) => f.querySelector('input[name="confirm"]'));
    const btn = forms[1]?.querySelector("button") as HTMLButtonElement;
    btn.focus();
    expectFocused(btn);
    await act(async () => {
      update([list[0] as SavedAddress, list[2] as SavedAddress]);
    });
    await waitFor(() => expectNotFocused(document.body));
    expect(document.activeElement?.textContent).toContain("Person");
    expect(document.activeElement?.textContent).toContain(list[2]?.fullName ?? "?");
  });

  test("delete last remaining card: focus goes to the book heading", async () => {
    const list = many(1);
    const { container, update } = setup(list);
    const btn = [...container.querySelectorAll("form")].find((f) => f.querySelector('input[name="confirm"]'))?.querySelector("button") as HTMLButtonElement;
    btn.focus();
    await act(async () => {
      update([]);
    });
    await waitFor(() => expect(document.activeElement?.id).toBe(ADDRESS_BOOK_HEADING_ID));
  });

  test("set default on card 3: focus moves to the new default card heading (index 0)", async () => {
    const list = many(3, 0);
    const { container, update } = setup(list);
    const sdForms = [...container.querySelectorAll("form")].filter(
      (f) => !f.querySelector('input[name="confirm"]') && !f.hasAttribute("id") && f.querySelector('input[name="addressId"]'),
    );
    const target = sdForms.find((f) => f.querySelector("input")?.getAttribute("value") === list[2]?.id);
    const btn = target?.querySelector("button") as HTMLButtonElement;
    btn.focus();
    await act(async () => {
      update([{ ...(list[0] as SavedAddress), isDefault: false }, list[1] as SavedAddress, { ...(list[2] as SavedAddress), isDefault: true }]);
    });
    await waitFor(() => expectNotFocused(document.body));
    const first = container.querySelector("ul[role=list] > li article h2");
    expectFocused(first);
    expect(first?.textContent).toContain(list[2]?.fullName ?? "?");
  });

  test("add reaching the limit (9 -> 10): focus goes to the limit notice", async () => {
    const list = many(9);
    const { update } = setup(list);
    const submit = within(screen.getByRole("form", { name: ADD_ADDRESS_TITLE })).getByRole("button", { name: "Add address" });
    submit.focus();
    await act(async () => {
      update([...list, addr()]);
    });
    await waitFor(() => expect(document.activeElement?.id).toBe(ADDRESS_BOOK_LIMIT_NOTICE_ID));
  });

  test("focus that was not lost is left alone (e.g. user moved on)", async () => {
    const list = many(3);
    const { update } = setup(list);
    const heading = document.getElementById(ADDRESS_BOOK_HEADING_ID) as HTMLElement;
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    await act(async () => {
      update([list[0] as SavedAddress, list[2] as SavedAddress]);
    });
    expectFocused(outside);
    expect(heading).toBeInTheDocument();
    outside.remove();
  });
});

// --------------------------------------------------------------------------------------------
describe("T84 criterion 4: no PII in attributes", () => {
  const PII: SavedAddress = {
    id: "9b2f3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    label: "Grandmas Cottage",
    fullName: "Zelda Quixotefield",
    phone: "+1 555 987 6543",
    line1: "742 Evergreen Terrace",
    line2: "Apartment Seventeen",
    city: "Shelbyvillex",
    region: "Ontarioz",
    postalCode: "K1A0B1",
    country: "CA",
    isDefault: false,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  };
  const NEEDLES = [PII.label, PII.fullName, PII.phone ?? "", PII.line1, PII.line2 ?? "", PII.city, PII.region, PII.postalCode, PII.id, "Zelda", "Evergreen"];

  function attrScan(doc: Document) {
    const hits: string[] = [];
    for (const el of doc.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        if (!/^(id|name|for|data-.*|aria-.*|class|title|href|form|list|headers)$/i.test(attr)) continue;
        const value = el.getAttribute(attr) ?? "";
        for (const n of NEEDLES) if (value.includes(n)) hits.push(`${el.tagName.toLowerCase()}[${attr}]="${value}"`);
      }
      // the address id may appear only as the value of a hidden addressId input
      for (const attr of el.getAttributeNames()) {
        if ((el.getAttribute(attr) ?? "").includes(PII.id)) {
          const ok = attr === "value" && el.tagName === "INPUT" && el.getAttribute("type") === "hidden" && el.getAttribute("name") === "addressId";
          if (!ok) hits.push(`address id in ${el.tagName.toLowerCase()}[${attr}]`);
        }
      }
    }
    return hits;
  }

  test("static markup (with a second, default address and at the limit) carries PII only in text and form values", () => {
    for (const addresses of [[addr({ isDefault: true }), PII], [PII, ...many(9, 1)]]) {
      const html = renderToStaticMarkup(<AddressBook addresses={addresses} actions={ACTIONS} />);
      expect(attrScan(parse(html))).toEqual([]);
      expect(html).toContain("Zelda Quixotefield");
    }
  });

  test("hydrated DOM after opening Edit/Delete disclosures: still no PII in attributes", () => {
    const { container } = render(<AddressBook addresses={[PII]} actions={ACTIONS} />);
    for (const d of container.querySelectorAll("details")) {
      act(() => {
        (d as HTMLDetailsElement).open = true;
        d.dispatchEvent(new Event("toggle"));
      });
    }
    expect(attrScan(container.ownerDocument)).toEqual([]);
  });

  test("ids are unique and the fixed ids appear exactly once", () => {
    const html = renderToStaticMarkup(<AddressBook addresses={many(4)} actions={ACTIONS} />);
    const ids = [...parse(html).querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const fixed of [ADDRESS_BOOK_HEADING_ID, "address-book-add-heading", "address-form-new", "address-form-0", "address-form-3"]) {
      expect(ids.filter((id) => id === fixed)).toHaveLength(1);
    }
    const full = renderToStaticMarkup(<AddressBook addresses={many(10)} actions={ACTIONS} />);
    const fullIds = [...parse(full).querySelectorAll("[id]")].map((el) => el.id);
    expect(fullIds.filter((id, i) => fullIds.indexOf(id) !== i)).toEqual([]);
    expect(fullIds).toContain(ADDRESS_BOOK_LIMIT_NOTICE_ID);
  });
});

// --------------------------------------------------------------------------------------------
describe("T84 a11y, hostile text, hygiene", () => {
  test("headings: h1 book title, h2 per card and h2 'Add a new address'; headingLevel=2 shifts to h2/h3", () => {
    const { unmount } = render(<AddressBook {...book({ addresses: many(2) })} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
    unmount();
    render(<AddressBook {...book({ addresses: many(2), headingLevel: 2 })} />);
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3);
  });

  test("region landmarks are named; Edit/Delete summaries and buttons are distinct per card", () => {
    const list = [addr({ label: "Home" }), addr({ label: "Work" })];
    const { container } = render(<AddressBook {...book({ addresses: list })} />);
    const regions = screen.getAllByRole("region").map((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent);
    expect(regions).toEqual(["Your addresses", "Add a new address"]);
    const summaries = [...container.querySelectorAll("summary")].map((s) => s.textContent);
    expect(new Set(summaries).size).toBe(summaries.length);
    // After hydration "Delete" is a dialog trigger (type=button); names must still be distinct per card.
    const deleteNames = [...container.querySelectorAll("button")].filter((b) => b.closest("dialog") === null).map((b) => b.textContent ?? "").filter((n) => n.startsWith("Delete"));
    expect(deleteNames).toHaveLength(2);
    expect(new Set(deleteNames).size).toBe(2);
    const formNames = [...container.querySelectorAll("form[aria-label]")].map((f) => f.getAttribute("aria-label"));
    expect(new Set(formNames).size).toBe(formNames.length);
  });

  test("every input in the add form has an associated label", () => {
    render(<AddressBook {...book({ addresses: many(1) })} />);
    const form = screen.getByRole("form", { name: ADD_ADDRESS_TITLE });
    for (const input of form.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      const id = input.getAttribute("id");
      const label = id ? form.querySelector(`label[for="${id}"]`) : null;
      expect({ name: input.getAttribute("name"), labelled: label !== null || input.closest("label") !== null }).toEqual({
        name: input.getAttribute("name"),
        labelled: true,
      });
    }
  });

  test("hostile address text renders as text only", () => {
    const evil = addr({ label: HOSTILE, fullName: HOSTILE, line1: HOSTILE, city: HOSTILE, isDefault: true });
    const { container } = render(<AddressBook {...book({ addresses: [evil, addr()] })} />);
    expect(container.querySelector("script")).toBeNull();
    for (const el of container.querySelectorAll("*")) expect(el.hasAttribute("onerror")).toBe(false);
    for (const img of container.querySelectorAll("img")) expect(img.getAttribute("src")).not.toBe("x");
    expect(container.textContent).toContain(HOSTILE);
  });

  test("touch targets: summaries and submit buttons carry min-h-touch", () => {
    const { container } = render(<AddressBook {...book({ addresses: many(2) })} />);
    for (const el of container.querySelectorAll("summary, button")) expect(el.className).toMatch(/min-h-touch|size-touch|\bh-touch/);
  });

  test("source: no any / ts-ignore / eslint-disable / dangerouslySetInnerHTML / style=; server imports type-only", () => {
    for (const f of ["AddressBook.tsx", "AddressBookList.tsx", "address-book-model.ts", "index.ts"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect({ f, bad: /:\s*any\b|as any\b|@ts-ignore|@ts-expect-error|eslint-disable|dangerouslySetInnerHTML|\sstyle=\{/.test(src) }).toEqual({ f, bad: false });
      for (const line of src.split("\n").filter((l) => /from "@\/server\//.test(l))) expect(line).toMatch(/^import type /);
    }
  });

  test("rendered markup: no arbitrary or palette classes, no inline styles", () => {
    const html = renderToStaticMarkup(<AddressBook {...book({ addresses: many(10) })} />);
    expect(html).not.toMatch(/\sstyle="/);
    const classes = [...parse(html).querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /(^|:)(bg|text|border|ring)-(gray|slate|red|blue|green|yellow|white|black)(-\d+)?$/.test(c))).toEqual([]);
  });
});
