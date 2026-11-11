import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { RECENT_SEARCHES_KEY, SEARCH_BOX_PLACEHOLDER, SUGGEST_DEBOUNCE_MS, SearchBox } from "./index";
import { expectFocused } from "@/test/dom-assertions";

const departments = [
  { slug: "electronics", name: "Electronics" },
  { slug: "home-kitchen", name: "Home & Kitchen" },
];

type FetchFn = typeof fetch;
const realFetch = globalThis.fetch;

function setFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = mock(impl);
  globalThis.fetch = fn as unknown as FetchFn;
  return fn;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const input = () => screen.getByRole("combobox", { name: "Search products" }) as HTMLInputElement;

/** Options of the suggestions listbox only (the department select has options too). */
const options = () => within(screen.getByRole("listbox", { hidden: true })).queryAllByRole("option");

function type(value: string) {
  fireEvent.focus(input());
  fireEvent.change(input(), { target: { value } });
}

async function waitDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SUGGEST_DEBOUNCE_MS + 60));
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("SearchBox server markup (no JS)", () => {
  test("one GET form to /search with dept and q fields and no combobox attributes", () => {
    const html = renderToStaticMarkup(
      <SearchBox departments={departments} defaultQuery="desk" defaultDept="electronics" />,
    );
    const formId = html.match(/<form[^>]*\sid="([^"]+)"/)?.[1];
    expect(formId).toBeTruthy();
    expect(html).toMatch(/<form[^>]*role="search"/);
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).toMatch(/<form[^>]*action="\/search"/);
    // The select joins the form through the `form` attribute.
    const select = html.match(/<select[^>]*>/)?.[0] ?? "";
    expect(select).toContain('name="dept"');
    expect(select).toContain(`form="${formId}"`);
    expect(select).toContain('aria-label="Search in department"');
    expect(html).toContain('<option value="">All departments</option>');
    expect(html).toMatch(/<option value="electronics" selected="">Electronics<\/option>/);
    expect(html).toMatch(/<input[^>]*name="q"/);
    expect(html).toMatch(/<input[^>]*value="desk"/);
    expect(html).toMatch(/<button[^>]*type="submit"/);
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("Clear recent searches");
  });

  test("unknown defaultDept falls back to All departments", () => {
    const html = renderToStaticMarkup(<SearchBox departments={departments} defaultDept="nope" />);
    expect(html).toContain('<option value="" selected="">All departments</option>');
    expect(html.match(/selected=""/g)).toHaveLength(1);
  });
});

describe("SearchBox with JS", () => {
  test("input gets maxLength 100 after hydration (criterion 6)", () => {
    render(<SearchBox departments={departments} />);
    expect(input()).toHaveAttribute("maxlength", "100");
    expect(input()).toHaveAttribute("name", "q");
  });

  test("server markup (no JS) carries maxlength=100 on the q input (D-T64-1)", () => {
    const html = renderToStaticMarkup(<SearchBox departments={departments} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const q = doc.querySelector('input[name="q"]');
    expect(q?.getAttribute("maxlength")).toBe("100");
  });

  test("debounced fetch for >= 2 chars; 200 shape renders plain-text suggestions; unsafe hrefs filtered", async () => {
    const fetchMock = setFetch(async () =>
      json(200, {
        suggestions: [
          { type: "product", label: "<b>Running</b> shoes", href: "/products/running-shoes" },
          { type: "category", label: "Proto", href: "//evil.example" },
          { type: "brand", label: "Script", href: "javascript:alert(1)" },
          { type: "brand", label: "Abs", href: "https://evil.example" },
          { type: "brand", label: "Runco", href: "/brands/runco" },
        ],
      }),
    );
    render(<SearchBox departments={departments} />);
    type("r");
    type("ru");
    type("run");
    expect(fetchMock).not.toHaveBeenCalled();
    await waitDebounce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/search/suggest?q=run");
    await waitFor(() => expect(options()).toHaveLength(2));
    const list = options();
    expect(list[0]?.textContent).toBe("<b>Running</b> shoes");
    expect(list[0]?.querySelector("b")).toBeNull();
    expect(list[1]?.textContent).toBe("Runco");
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status")).toHaveTextContent("2 suggestions available");
  });

  test("single character does not fetch", async () => {
    const fetchMock = setFetch(async () => json(200, { suggestions: [] }));
    render(<SearchBox departments={departments} />);
    type("r");
    await waitDebounce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("custom suggestUrl and stale requests are aborted", async () => {
    const signals: AbortSignal[] = [];
    setFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signals.push(signal);
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }
        }),
    );
    render(<SearchBox departments={departments} suggestUrl="/x/suggest" />);
    type("ru");
    await waitDebounce();
    expect(signals).toHaveLength(1);
    type("run");
    expect(signals[0]?.aborted).toBe(true);
    await waitDebounce();
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  test.each([
    ["429", () => json(429, { error: "rate_limited", retryAfterSeconds: 30 })],
    ["500", () => json(500, { error: "internal" })],
    ["400", () => json(400, { error: "query_too_long" })],
    ["invalid JSON", () => new Response("not json", { status: 200 })],
  ])("%s response hides the list silently", async (_name, make) => {
    setFetch(async () => make());
    render(<SearchBox departments={departments} />);
    type("desk");
    await waitDebounce();
    await act(async () => {});
    expect(options()).toHaveLength(0);
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  test("network error hides the list and does not throw", async () => {
    setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(<SearchBox departments={departments} />);
    type("desk");
    await waitDebounce();
    await act(async () => {});
    expect(options()).toHaveLength(0);
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  test("submit records the query in localStorage and keeps the native GET", () => {
    render(<SearchBox departments={departments} />);
    type("  Oak Desk ");
    const event = new Event("submit", { bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole("search").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]")).toEqual(["Oak Desk"]);
  });

  test("empty focused input shows recents (prefixed) and popular searches; clear removes recents", () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(["desk", "lamp"]));
    render(<SearchBox departments={departments} popularSearches={["chair", "Desk"]} />);
    fireEvent.focus(input());
    const labels = options().map((o) => o.textContent);
    expect(labels).toEqual(["Recent: desk", "Recent: lamp", "chair"]);
    const clear = screen.getByRole("button", { name: "Clear recent searches" });
    fireEvent.click(clear);
    expect(window.localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear recent searches" })).toBeNull();
    // "Desk" was hidden as a duplicate of the recent "desk"; now it is a popular entry.
    expect(options().map((o) => o.textContent)).toEqual(["chair", "Desk"]);
    expectFocused(input());
  });

  test("no clear control when there are no recents", () => {
    render(<SearchBox departments={departments} popularSearches={["chair"]} />);
    fireEvent.focus(input());
    expect(screen.queryByRole("button", { name: "Clear recent searches" })).toBeNull();
  });

  test("choosing a recent navigates to its href and re-records it first", () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(["desk", "lamp"]));
    const onNavigate = mock((href: string) => void href);
    render(<SearchBox departments={departments} onNavigate={onNavigate} />);
    fireEvent.focus(input());
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Recent: lamp" }));
    expect(onNavigate).toHaveBeenCalledWith("/search?q=lamp");
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]")).toEqual(["lamp", "desk"]);
  });

  test("choosing a remote suggestion by keyboard navigates and records the typed query", async () => {
    setFetch(async () => json(200, { suggestions: [{ type: "product", label: "Oak desk", href: "/products/oak-desk" }] }));
    const onNavigate = mock((href: string) => void href);
    render(<SearchBox departments={departments} onNavigate={onNavigate} />);
    type("oak");
    await waitDebounce();
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("/products/oak-desk");
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]")).toEqual(["oak"]);
  });

  test("recents are capped at 5 and de-duplicated across submits", () => {
    render(<SearchBox departments={departments} />);
    for (const q of ["a", "b", "A", "c", "d", "e", "f"]) {
      type(q);
      act(() => {
        screen.getByRole("search").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    }
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]")).toEqual(["f", "e", "d", "c", "A"]);
  });
});

describe("SearchBox with broken localStorage", () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

  afterEach(() => {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  });

  test("localStorage getter throwing never crashes render, focus, submit or select", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const onNavigate = mock((href: string) => void href);
    render(<SearchBox departments={departments} popularSearches={["chair"]} onNavigate={onNavigate} />);
    fireEvent.focus(input());
    expect(options().map((o) => o.textContent)).toEqual(["chair"]);
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "chair" }));
    expect(onNavigate).toHaveBeenCalledWith("/search?q=chair");
    type("desk");
    expect(() =>
      act(() => {
        screen.getByRole("search").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }),
    ).not.toThrow();
  });

  test("setItem / getItem throwing never crashes", () => {
    const throwing = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      clear: () => {},
      key: () => null,
      length: 0,
    };
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => throwing });
    render(<SearchBox departments={departments} />);
    fireEvent.focus(input());
    type("desk");
    expect(() =>
      act(() => {
        screen.getByRole("search").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }),
    ).not.toThrow();
    expect(input().value).toBe("desk");
  });
});

describe("SearchBox label prop (CONS-B1 item ay)", () => {
  test("defaults to the header label", () => {
    render(<SearchBox departments={departments} />);
    expect(input().getAttribute("name")).toBe("q");
  });

  test("a custom label names the query field; the default label is then absent", () => {
    render(<SearchBox departments={departments} label="Search the store" />);
    const field = screen.getByRole("combobox", { name: "Search the store" }) as HTMLInputElement;
    expect(field.getAttribute("name")).toBe("q");
    expect(screen.queryByRole("combobox", { name: "Search products" })).toBeNull();
  });

  test("a blank label falls back to the default (no unlabelled field)", () => {
    render(<SearchBox departments={departments} label="   " />);
    expect(input()).toBeTruthy();
  });

  test("server markup carries the custom label text", () => {
    const html = renderToStaticMarkup(<SearchBox departments={departments} label="Search the store" />);
    expect(html).toContain(">Search the store</label>");
  });
});

describe("SearchBox landmarkLabel prop (D-T113-2 follow-up)", () => {
  test("omitted: the landmark keeps SearchField's default name", () => {
    render(<SearchBox departments={departments} />);
    expect(screen.getByRole("search", { name: "Site search" })).toBeTruthy();
  });

  test("forwards landmarkLabel to the search landmark; the default name is then absent", () => {
    render(<SearchBox departments={departments} label="Search the store" landmarkLabel="Search the store" />);
    expect(screen.getByRole("search", { name: "Search the store" })).toBeTruthy();
    expect(screen.queryByRole("search", { name: "Site search" })).toBeNull();
    // The query field's own label is independent of the landmark name.
    expect(screen.getByRole("combobox", { name: "Search the store" })).toBeTruthy();
  });

  test("landmarkLabel does not change the field label", () => {
    render(<SearchBox departments={departments} landmarkLabel="Search the store" />);
    expect(input().getAttribute("name")).toBe("q");
  });

  test("server markup carries the landmark name (no JS)", () => {
    const withLabel = renderToStaticMarkup(<SearchBox departments={departments} landmarkLabel="Search the store" />);
    expect(withLabel).toContain('aria-label="Search the store"');
    expect(withLabel).not.toContain('aria-label="Site search"');
    const byDefault = renderToStaticMarkup(<SearchBox departments={departments} />);
    expect(byDefault).toContain('aria-label="Site search"');
  });
});

describe("SearchBox Phase 3 pill (T143)", () => {
  test("no JS: wide pill field, placeholder, visually hidden label, round submit inside the pill, maxlength 100", () => {
    const html = renderToStaticMarkup(<SearchBox departments={departments} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector('form[role="search"]');
    expect(form?.getAttribute("action")).toBe("/search");
    expect(form?.getAttribute("method")).toBe("get");
    const q = doc.querySelector('input[name="q"]');
    expect(q?.getAttribute("placeholder")).toBe("Search products, categories and more");
    expect(SEARCH_BOX_PLACEHOLDER).toBe("Search products, categories and more");
    expect(q?.getAttribute("maxlength")).toBe("100");
    expect(q?.className).toMatch(/\brounded-full\b/);
    const label = doc.querySelector(`label[for="${q?.getAttribute("id")}"]`);
    expect(label?.textContent).toBe("Search products");
    expect(label?.className).toMatch(/\bsr-only\b/);
    // The submit button sits inside the pill's positioned wrapper (same parent as the input).
    const submit = form?.querySelector('button[type="submit"]');
    expect(submit?.getAttribute("aria-label")).toBe("Submit search");
    expect(submit?.parentElement).toBe(q?.parentElement ?? null);
    expect(submit?.className).toMatch(/\bsize-touch\b/);
    expect(q?.hasAttribute("required")).toBe(false);
  });

  test("empty and whitespace-only submits are not blocked (browse-all on /search) and record nothing", () => {
    render(<SearchBox departments={departments} />);
    for (const value of ["", "   "]) {
      type(value);
      const event = new Event("submit", { bubbles: true, cancelable: true });
      act(() => {
        screen.getByRole("search").dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(window.localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
  });

  test("combobox ARIA unchanged after hydration; landmark keeps the default name", () => {
    render(<SearchBox departments={departments} />);
    expect(input()).toHaveAttribute("aria-autocomplete", "list");
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input().getAttribute("aria-controls")).toBeTruthy();
    expect(input()).toHaveAttribute("placeholder", SEARCH_BOX_PLACEHOLDER);
    expect(screen.getByRole("search", { name: "Site search" })).toBeInTheDocument();
  });
});

describe("SearchBox without departments (T148 ruling: header has no department select)", () => {
  test("no JS: no select, no form= link, no dept field; the form posts only q", () => {
    const html = renderToStaticMarkup(<SearchBox />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("select")).toBeNull();
    expect(doc.querySelector("[form]")).toBeNull();
    expect(doc.querySelector('[name="dept"]')).toBeNull();
    const form = doc.querySelector('form[action="/search"]');
    expect(form).not.toBeNull();
    expect([...(form?.querySelectorAll("[name]") ?? [])].map((el) => el.getAttribute("name"))).toEqual(["q"]);
    expect(html).not.toContain("All departments");
  });

  test("hydrated: no department combobox; query field and suggestions still work", () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(["lamp"]));
    render(<SearchBox popularSearches={["Books"]} />);
    expect(screen.queryByRole("combobox", { name: "Search in department" })).toBeNull();
    fireEvent.focus(input());
    expect(options().map((o) => o.textContent)).toEqual(["Recent: lamp", "Books"]);
  });

  test("an empty departments array still renders the select (backward compatible)", () => {
    render(<SearchBox departments={[]} />);
    const select = screen.getByRole("combobox", { name: "Search in department" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["All departments"]);
  });
});
