import { describe, expect, mock, test } from "bun:test";
import { createRef, useState } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { SEARCH_FIELD_DEFAULT_LANDMARK_LABEL, SearchField } from "./SearchField";
import type { SearchFieldProps, SearchSuggestion } from "./SearchField";
import { expectFocused } from "@/test/dom-assertions";

const suggestions: SearchSuggestion[] = [
  { id: "1", label: "running shoes", href: "/search?q=running+shoes" },
  { id: "2", label: "running shorts", href: "/search?q=running+shorts" },
  { id: "3", label: "running watch", href: "/search?q=running+watch" },
];

function WithSuggestions(props: Partial<SearchFieldProps>) {
  const [items, setItems] = useState<SearchSuggestion[]>([]);
  return (
    <SearchField
      {...props}
      suggestions={items}
      onChange={(v) => setItems(v.startsWith("run") ? suggestions : [])}
    />
  );
}

const input = () => screen.getByRole("combobox", { name: "Search" }) as HTMLInputElement;

function typeQuery(value: string) {
  fireEvent.focus(input());
  fireEvent.change(input(), { target: { value } });
}

describe("SearchField", () => {
  test("no-JS: server HTML is a plain GET search form", () => {
    const html = renderToStaticMarkup(<SearchField defaultValue="shoes" placeholder="Search products" />);
    expect(html).toMatch(/<form[^>]*role="search"/);
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).toMatch(/<form[^>]*action="\/search"/);
    expect(html).toMatch(/<input[^>]*name="q"/);
    expect(html).toMatch(/<input[^>]*value="shoes"/);
    expect(html).toMatch(/<button[^>]*type="submit"/);
    // JS-only affordances are absent from server HTML.
    expect(html).not.toContain("Clear search");
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('role="listbox"');
  });

  test("renders a labelled search landmark with a visually hidden label", () => {
    render(<SearchField />);
    expect(screen.getByRole("search")).toHaveAttribute("action", "/search");
    expect(screen.getByText("Search", { selector: "label" })).toHaveClass("sr-only");
    expect(input()).toHaveAttribute("name", "q");
    expect(screen.getByRole("button", { name: "Submit search" })).toHaveAttribute("type", "submit");
  });

  test("showLabel, custom name/action/placeholder", () => {
    render(
      <SearchField label="Search reviews" showLabel name="term" action="/reviews" placeholder="Find" />,
    );
    expect(screen.getByText("Search reviews")).not.toHaveClass("sr-only");
    const field = screen.getByRole("combobox", { name: "Search reviews" });
    expect(field).toHaveAttribute("name", "term");
    expect(field).toHaveAttribute("placeholder", "Find");
    expect(screen.getByRole("search")).toHaveAttribute("action", "/reviews");
  });

  test("onChange fires per edit; clear button appears when non-empty", () => {
    const onChange = mock();
    render(<SearchField onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(input(), { target: { value: "lamp" } });
    expect(onChange).toHaveBeenCalledWith("lamp");
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toHaveClass("size-touch");
    fireEvent.click(clear);
    expect(input().value).toBe("");
    expect(onChange).toHaveBeenLastCalledWith("");
    expectFocused(input());
  });

  test("combobox ARIA wiring; listbox hidden without suggestions", () => {
    render(<WithSuggestions />);
    const listbox = screen.getByRole("listbox", { hidden: true });
    expect(input()).toHaveAttribute("aria-controls", listbox.id);
    expect(input()).toHaveAttribute("aria-autocomplete", "list");
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(listbox).toHaveAttribute("hidden");
  });

  test("suggestions open on typing and announce the count", () => {
    render(<WithSuggestions />);
    typeQuery("run");
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent("3 suggestions available");
  });

  test("ArrowDown/ArrowUp move aria-activedescendant with wrap", () => {
    render(<WithSuggestions />);
    typeQuery("run");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(input()).toHaveAttribute("aria-activedescendant", options[0]?.id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(input()).toHaveAttribute("aria-activedescendant", options[2]?.id);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", options[0]?.id);
    expect(options[0]).toHaveClass("bg-accent-subtle", "underline");
  });

  test("Enter on an active option calls onSelect and does not submit", () => {
    const onSelect = mock();
    const onSubmit = mock();
    render(<WithSuggestions onSelect={onSelect} onSubmit={onSubmit} />);
    typeQuery("run");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(suggestions[1]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input().value).toBe("running shorts");
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  test("clicking an option selects it", () => {
    const onSelect = mock();
    render(<WithSuggestions onSelect={onSelect} />);
    typeQuery("run");
    const option = screen.getByRole("option", { name: "running watch" });
    expect(fireEvent.mouseDown(option)).toBe(false); // keeps focus in the input
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith(suggestions[2]);
  });

  test("Escape closes the listbox, then clears the query", () => {
    render(<WithSuggestions />);
    typeQuery("run");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input().value).toBe("run");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().value).toBe("");
  });

  test("blur closes the listbox", () => {
    render(<WithSuggestions />);
    typeQuery("run");
    fireEvent.blur(input());
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  test("Enter without an active option submits with the query", () => {
    const onSubmit = mock((event: { preventDefault: () => void }, query: string) => {
      event.preventDefault();
      return query;
    });
    render(<SearchField defaultValue="desk" onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByRole("search"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[1]).toBe("desk");
  });

  test("forwards form ref and inputRef; merges className last", () => {
    const ref = createRef<HTMLFormElement>();
    const inputRef = createRef<HTMLInputElement>();
    render(<SearchField ref={ref} inputRef={inputRef} className="x-search" />);
    expect(ref.current).toBe(screen.getByRole("search") as HTMLFormElement);
    expect(inputRef.current).toBe(input());
    expect(ref.current?.className.endsWith("x-search")).toBe(true);
  });

  test("maxLength is forwarded to the input, including the no-JS server HTML", () => {
    const html = renderToStaticMarkup(<SearchField maxLength={100} />);
    expect(html).toMatch(/<input[^>]*maxLength="100"/i);
    render(<SearchField maxLength={100} />);
    expect(input()).toHaveAttribute("maxlength", "100");
  });

  test("maxLength omitted: no maxlength attribute (default unchanged)", () => {
    render(<SearchField />);
    expect(input()).not.toHaveAttribute("maxlength");
  });

  const recent: SearchSuggestion[] = [
    { id: "r1", label: "Recent: lamp", value: "lamp", icon: "clock", href: "/search?q=lamp" },
    { id: "s1", label: "lamp shade", href: "/search?q=lamp+shade" },
  ];

  test("suggestion icon is decorative and does not change the option name", () => {
    render(<SearchField suggestions={recent} />);
    fireEvent.focus(input());
    const option = screen.getByRole("option", { name: "Recent: lamp" });
    const svg = option.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("data-icon", "clock");
    expect(screen.getByRole("option", { name: "lamp shade" }).querySelector("svg")).toBeNull();
  });

  test("suggestion value is inserted when chosen; label is the fallback", () => {
    const onSelect = mock();
    render(<SearchField suggestions={recent} onSelect={onSelect} />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(recent[0]);
    expect(input().value).toBe("lamp");
    fireEvent.keyDown(input(), { key: "ArrowDown" }); // reopen after choosing
    fireEvent.click(screen.getByRole("option", { name: "lamp shade" }));
    expect(input().value).toBe("lamp shade");
  });

  test("no listFooter: listbox keeps the original popup classes and no wrapper", () => {
    render(<SearchField suggestions={recent} />);
    fireEvent.focus(input());
    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveClass("absolute", "z-dropdown", "border-border-strong", "bg-surface-raised");
    expect(screen.queryByTestId("search-suggestions-popup")).toBeNull();
  });

  test("listFooter renders inside the popup but outside the option list", () => {
    const onClear = mock();
    render(
      <SearchField
        suggestions={recent}
        listFooter={
          <button type="button" onClick={onClear}>
            Clear recent searches
          </button>
        }
      />,
    );
    fireEvent.focus(input());
    const popup = screen.getByTestId("search-suggestions-popup");
    expect(popup).not.toHaveAttribute("hidden");
    expect(popup).toHaveClass("absolute", "z-dropdown");
    const listbox = screen.getByRole("listbox");
    const clear = screen.getByRole("button", { name: "Clear recent searches" });
    expect(popup.contains(clear)).toBe(true);
    expect(listbox.contains(clear)).toBe(false);
    expect(clear.closest('[role="option"]')).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    // Mouse: mousedown is prevented so the input keeps focus; click still fires.
    expect(fireEvent.mouseDown(clear)).toBe(false);
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(input()).toHaveAttribute("aria-expanded", "true");
  });

  test("listFooter keyboard: Tab into it keeps the popup open; Escape returns to the input", () => {
    render(
      <SearchField
        suggestions={recent}
        listFooter={<button type="button">Clear recent searches</button>}
      />,
    );
    const field = input();
    field.focus();
    fireEvent.focus(field);
    const clear = screen.getByRole("button", { name: "Clear recent searches" });
    fireEvent.blur(field, { relatedTarget: clear });
    clear.focus();
    expect(field).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("search-suggestions-popup")).not.toHaveAttribute("hidden");
    fireEvent.keyDown(clear, { key: "Escape" });
    expectFocused(field);
    expect(field).toHaveAttribute("aria-expanded", "false");
  });

  test("listFooter: focus leaving the footer to elsewhere closes the popup", () => {
    render(
      <SearchField
        suggestions={recent}
        listFooter={<button type="button">Clear recent searches</button>}
      />,
    );
    fireEvent.focus(input());
    const clear = screen.getByRole("button", { name: "Clear recent searches" });
    fireEvent.blur(input(), { relatedTarget: clear });
    fireEvent.blur(clear, { relatedTarget: screen.getByRole("button", { name: "Submit search" }) });
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("search-suggestions-popup")).toHaveAttribute("hidden");
  });

  test("listFooter is hidden with the popup when there are no suggestions", () => {
    render(<SearchField suggestions={[]} listFooter={<button type="button">Clear</button>} />);
    fireEvent.focus(input());
    expect(screen.getByTestId("search-suggestions-popup")).toHaveAttribute("hidden");
  });

  test("listFooter + typed query: Clear button is part of the composite (D-ATOMS4-1)", () => {
    render(
      <SearchField
        defaultValue="la"
        suggestions={recent}
        listFooter={<button type="button">Clear recent searches</button>}
      />,
    );
    fireEvent.focus(input());
    const clearQuery = screen.getByRole("button", { name: "Clear search" });
    const footerButton = screen.getByRole("button", { name: "Clear recent searches" });
    fireEvent.blur(input(), { relatedTarget: clearQuery });
    expect(input()).toHaveAttribute("aria-expanded", "true");
    fireEvent.blur(clearQuery, { relatedTarget: footerButton });
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("search-suggestions-popup")).not.toHaveAttribute("hidden");
    fireEvent.blur(footerButton, { relatedTarget: clearQuery }); // Shift+Tab back
    expect(input()).toHaveAttribute("aria-expanded", "true");
    fireEvent.blur(clearQuery, { relatedTarget: screen.getByRole("button", { name: "Submit search" }) });
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  test("no listFooter: Tab to the Clear button still closes the popup (unchanged)", () => {
    render(<SearchField defaultValue="la" suggestions={recent} />);
    fireEvent.focus(input());
    fireEvent.blur(input(), { relatedTarget: screen.getByRole("button", { name: "Clear search" }) });
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  test("listFooter false / '' / null: DOM identical to no footer (D-ATOMS4-2)", () => {
    const html = (footer?: ReactNode) => {
      const { container, unmount } = render(
        <SearchField inputId="s" suggestions={recent} listFooter={footer} />,
      );
      fireEvent.focus(container.querySelector("input")!);
      const out = container.innerHTML;
      unmount();
      return out;
    };
    const base = html();
    expect(html(false)).toBe(base);
    expect(html("")).toBe(base);
    expect(html(null)).toBe(base);
    expect(html(<span>x</span>)).not.toBe(base);
  });

  describe("landmark name (D-T113-2)", () => {
    test("default: the landmark is named \"Site search\" (server HTML too)", () => {
      expect(SEARCH_FIELD_DEFAULT_LANDMARK_LABEL).toBe("Site search");
      const html = renderToStaticMarkup(<SearchField />);
      expect(html).toMatch(/<form[^>]*aria-label="Site search"/);
      render(<SearchField />);
      expect(screen.getByRole("search", { name: "Site search" })).toBeInTheDocument();
    });

    test("two instances with different landmarkLabels are two distinctly named landmarks", () => {
      render(
        <>
          <SearchField landmarkLabel="Search the store" />
          <SearchField landmarkLabel="Help" action="/help" />
        </>,
      );
      const landmarks = screen.getAllByRole("search");
      expect(landmarks).toHaveLength(2);
      expect(screen.getByRole("search", { name: "Search the store" })).toHaveAttribute("action", "/search");
      expect(screen.getByRole("search", { name: "Help" })).toHaveAttribute("action", "/help");
      expect(new Set(landmarks.map((form) => form.getAttribute("aria-label"))).size).toBe(2);
    });

    test("a default instance next to a named one: two distinct names", () => {
      render(
        <>
          <SearchField />
          <SearchField landmarkLabel="Search orders" />
        </>,
      );
      expect(screen.getByRole("search", { name: "Site search" })).toBeInTheDocument();
      expect(screen.getByRole("search", { name: "Search orders" })).toBeInTheDocument();
    });

    test("landmark name is independent of the field label; blank landmarkLabel falls back", () => {
      const { unmount } = render(<SearchField label="Search products" showLabel />);
      expect(screen.getByRole("search", { name: "Site search" })).toBeInTheDocument();
      // The input stays the only element labelled by the field label.
      expect(screen.getByLabelText("Search products")).toHaveAttribute("name", "q");
      unmount();
      render(<SearchField landmarkLabel="   " />);
      expect(screen.getByRole("search", { name: "Site search" })).toBeInTheDocument();
    });

    test("landmarkLabel does not change the input's name", () => {
      render(<SearchField label="Search help" landmarkLabel="Help" />);
      expect(screen.getByRole("search", { name: "Help" })).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Search help" })).toBeInTheDocument();
    });

    test("explicit aria-label / aria-labelledby on the form win (existing callers)", () => {
      const { unmount } = render(<SearchField label="Search help" aria-label="Help" landmarkLabel="Ignored" />);
      expect(screen.getByRole("search", { name: "Help" })).toBeInTheDocument();
      unmount();
      render(
        <>
          <h2 id="ext">Find a review</h2>
          <SearchField aria-labelledby="ext" landmarkLabel="Ignored" />
        </>,
      );
      expect(screen.getByRole("search", { name: "Find a review" })).not.toHaveAttribute("aria-label");
    });
  });
});
