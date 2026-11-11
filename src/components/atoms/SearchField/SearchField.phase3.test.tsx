import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { SearchField } from "./SearchField";
import { expectFocused } from "@/test/dom-assertions";

const field = () => screen.getByRole("combobox", { name: "Search" }) as HTMLInputElement;

describe('SearchField variant="pill"', () => {
  test("no-JS: still a GET form; the submit button sits inside the field wrapper", () => {
    const html = renderToStaticMarkup(<SearchField variant="pill" placeholder="Find products" />);
    expect(html).toMatch(/<form[^>]*role="search"[^>]*aria-label="Site search"/);
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).toMatch(/<form[^>]*action="\/search"/);
    expect(html).toMatch(/<input[^>]*class="[^"]*bg-surface-sunken[^"]*rounded-full/);
    expect(html).toMatch(/<input[^>]*name="q"/);
    // the submit is inside the relative wrapper, positioned at the end
    expect(html).toMatch(/<div class="relative min-w-0 flex-1"><input[^>]*\/><button [^>]*type="submit"[^>]*class="[^"]*absolute top-0\.5 end-0\.5 size-touch/);
    expect(html).toContain("pe-14");
  });

  test("submit keeps a 44px target, pill shape and an accessible name", () => {
    render(<SearchField variant="pill" />);
    const submit = screen.getByRole("button", { name: "Submit search" });
    const cls = submit.getAttribute("class") ?? "";
    for (const c of ["size-touch", "min-h-touch", "min-w-touch", "rounded-full", "bg-accent"]) expect(cls).toContain(c);
  });

  test("typing shows Clear left of the inset submit and widens the end padding", () => {
    render(<SearchField variant="pill" />);
    fireEvent.change(field(), { target: { value: "lamp" } });
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear.getAttribute("class")).toContain("end-12");
    expect(field().className).toContain("pe-24");
    fireEvent.click(clear);
    expect(field().value).toBe("");
    expectFocused(field());
  });

  test("keyboard: Enter submits; Escape clears; arrow keys drive suggestions", () => {
    const onSubmit = mock((event: { preventDefault(): void }) => event.preventDefault());
    render(
      <SearchField
        variant="pill"
        onSubmit={onSubmit}
        suggestions={[{ id: "a", label: "lamp shade", href: "/search?q=lamp+shade" }]}
      />,
    );
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "lamp" } });
    expect(field().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(field().getAttribute("aria-activedescendant")).toBeTruthy();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().getAttribute("aria-expanded")).toBe("false");
    fireEvent.submit(field().form as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("default variant keeps the submit button outside the field", () => {
    const html = renderToStaticMarkup(<SearchField />);
    expect(html).toMatch(/<\/div><button [^>]*type="submit"[^>]*class="[^"]*shrink-0/);
    expect(html).not.toContain("end-0.5");
  });
});
