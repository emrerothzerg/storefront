// QA (QA-ATOMS-4): atoms batch 4, items 1-7 and 9 of the brief (item 8, colour
// maths, lives in phase2-atoms-4.contrast.qa.test.ts). Independent of the
// colocated implementer tests; does not import from them.
import { describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Rating } from "@/components/atoms/Rating";
import { Link } from "@/components/atoms/Link";
import { Heading, Text, type HeadingTone } from "@/components/atoms/Typography";
import { Button, type ButtonPadding } from "@/components/atoms/Button";
import { IconButton } from "@/components/atoms/IconButton";
import { Chip } from "@/components/atoms/Chip";
import { SearchField, type SearchSuggestion } from "@/components/atoms/SearchField";
import { ProgressBar } from "@/components/atoms/ProgressBar";
import { expectFocused } from "@/test/dom-assertions";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ATOMS = join(ROOT, "src/components/atoms");
const cls = (el: Element) => el.getAttribute("class") ?? "";

// ------------------------------------------------------------ 1. Rating
describe("item 1: Rating requiredMarker", () => {
  const input = (extra: Record<string, unknown> = {}) => (
    <Rating mode="input" name="rating" label="Overall rating" {...extra} />
  );

  test("required: visible aria-hidden '(required)' after the legend text, text-text-secondary", () => {
    const { container } = render(input({ required: true }));
    const legend = container.querySelector("legend")!;
    expect(legend.textContent).toBe("Overall rating (required)");
    const marker = legend.querySelector("span")!;
    expect(marker.textContent).toBe(" (required)");
    expect(marker.getAttribute("aria-hidden")).toBe("true");
    expect(cls(marker).split(" ")).toContain("text-text-secondary");
    // marker comes after the label text node
    expect(legend.firstChild?.nodeType).toBe(3);
    expect(legend.lastChild).toBe(marker);
  });

  test("radiogroup accessible name stays the plain label; aria-required unchanged", () => {
    render(input({ required: true }));
    const group = screen.getByRole("radiogroup", { name: "Overall rating" });
    expect(group.getAttribute("aria-required")).toBe("true");
  });

  test("not required: no marker, no aria-required", () => {
    const { container } = render(input());
    expect(container.querySelector("legend")!.textContent).toBe("Overall rating");
    expect(screen.getByRole("radiogroup").hasAttribute("aria-required")).toBe(false);
  });

  test("hideLabel: no marker even when required (legend sr-only, plain label)", () => {
    const { container } = render(input({ required: true, hideLabel: true }));
    const legend = container.querySelector("legend")!;
    expect(legend.textContent).toBe("Overall rating");
    expect(cls(legend)).toBe("sr-only");
    expect(screen.getByRole("radiogroup").getAttribute("aria-required")).toBe("true");
  });

  test("requiredMarker={false} suppresses it; aria-required still true", () => {
    const { container } = render(input({ required: true, requiredMarker: false }));
    expect(container.querySelector("legend")!.textContent).toBe("Overall rating");
    expect(screen.getByRole("radiogroup").getAttribute("aria-required")).toBe("true");
  });

  test("requiredMarker={true} without required shows the marker but no aria-required (documented default = required)", () => {
    const { container } = render(input({ requiredMarker: true }));
    expect(container.querySelector("legend")!.textContent).toBe("Overall rating (required)");
    expect(screen.getByRole("radiogroup").hasAttribute("aria-required")).toBe(false);
  });

  test("five radios still named `rating`, labelled 'N out of 5 stars', required on each", () => {
    render(input({ required: true }));
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(5);
    radios.forEach((r, i) => {
      expect(r.name).toBe("rating");
      expect(r.value).toBe(String(i + 1));
      expect(r.required).toBe(true);
      expect(screen.getByRole("radio", { name: `${i + 1} out of 5 stars` })).toBe(r);
    });
  });

  test("no-JS static markup carries the marker", () => {
    const html = renderToStaticMarkup(input({ required: true }));
    expect(html).toMatch(/<legend[^>]*>Overall rating<span class="text-text-secondary" aria-hidden="true"> (<!-- -->)?\(required\)<\/span><\/legend>/);
  });

  test("display mode unaffected (no legend, no marker)", () => {
    const html = renderToStaticMarkup(<Rating value={4.3} count={12} />);
    expect(html).not.toContain("required");
    expect(html).not.toContain("<legend");
    expect(html).toContain("4.3 out of 5 stars");
  });

  test("hostile label text stays text", () => {
    const { container } = render(input({ required: true, label: '<img src=x onerror="alert(1)">' }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("legend")!.textContent).toContain("<img src=x");
  });
});

// ------------------------------------------------------------ 2. Link
describe("item 2: Link aria-current override", () => {
  const VALUES = ["true", "step", "location", "date", "time", "page", "false"] as const;

  for (const v of VALUES) {
    test(`isCurrent + aria-current="${v}" -> "${v}" (internal and external)`, () => {
      render(
        <>
          <Link href="/a" variant="nav" isCurrent aria-current={v}>A</Link>
          <Link href="https://x.example" external isCurrent aria-current={v}>B</Link>
        </>,
      );
      expect(screen.getByRole("link", { name: "A" }).getAttribute("aria-current")).toBe(v);
      expect(screen.getByRole("link", { name: /B/ }).getAttribute("aria-current")).toBe(v);
    });
    test(`no isCurrent + aria-current="${v}" passes through`, () => {
      render(<Link href="/a" aria-current={v}>A</Link>);
      expect(screen.getByRole("link").getAttribute("aria-current")).toBe(v);
    });
  }

  test("isCurrent alone -> page; omitted -> attribute absent", () => {
    render(
      <>
        <Link href="/a" isCurrent>A</Link>
        <Link href="/b">B</Link>
      </>,
    );
    expect(screen.getByRole("link", { name: "A" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "B" }).hasAttribute("aria-current")).toBe(false);
  });

  test("styling follows isCurrent only, not aria-current", () => {
    render(
      <>
        <Link href="/a" variant="nav" isCurrent aria-current="true">A</Link>
        <Link href="/b" variant="nav" aria-current="page">B</Link>
        <Link href="/c" variant="nav">C</Link>
      </>,
    );
    const a = cls(screen.getByRole("link", { name: "A" }));
    const b = cls(screen.getByRole("link", { name: "B" }));
    const c = cls(screen.getByRole("link", { name: "C" }));
    expect(a).toContain("underline decoration-2");
    expect(a.endsWith("text-accent underline decoration-2")).toBe(true);
    expect(b).toBe(c);
  });

  // Phase 3 (QA-ATOMS-P3): the pinned string moved from `rounded-md` to the
  // pill (`rounded-full`, now emitted by button-classes.ts after the layout).
  test("variant=button class string pinned (Phase 3 pill); aria-current applies", () => {
    render(<Link href="/c" variant="button" isCurrent aria-current="step">Go</Link>);
    const el = screen.getByRole("link");
    expect(cls(el)).toBe(
      "inline-flex min-h-touch min-w-touch select-none items-center justify-center gap-2 font-semibold transition-colors rounded-full bg-accent text-text-on-accent hover:bg-accent-hover active:bg-accent-active px-4 py-2 text-body no-underline hover:no-underline",
    );
    expect(el.getAttribute("aria-current")).toBe("step");
  });

  test("tone=inverse class strings unchanged (current and not)", () => {
    render(
      <>
        <Link href="/a" tone="inverse">A</Link>
        <Link href="/b" tone="inverse" variant="nav" isCurrent aria-current="true">B</Link>
        <Link href="/c" tone="inverse" variant="subtle" isCurrent>C</Link>
      </>,
    );
    expect(cls(screen.getByRole("link", { name: "A" }))).toBe(
      "text-text-inverse underline underline-offset-2 hover:text-text-inverse hover:decoration-2",
    );
    expect(cls(screen.getByRole("link", { name: "B" }))).toBe(
      "inline-flex min-h-touch min-w-touch items-center text-text-inverse underline-offset-4 hover:text-text-inverse hover:underline underline decoration-2",
    );
    expect(cls(screen.getByRole("link", { name: "C" }))).toBe(
      "inline-flex min-h-touch min-w-touch items-center text-text-inverse underline-offset-2 hover:text-text-inverse hover:underline underline",
    );
  });
});

// ------------------------------------------------------------ 3. Heading
describe("item 3: Heading tone", () => {
  const TONES: Array<[HeadingTone | undefined, string]> = [
    [undefined, "text-text-primary"],
    ["default", "text-text-primary"],
    ["inverse", "text-text-inverse"],
    ["secondary", "text-text-secondary"],
  ];
  for (const [tone, c] of TONES) {
    test(`tone=${tone ?? "(omitted)"} -> ${c}, exactly one text colour`, () => {
      render(<Heading level={2} tone={tone}>T</Heading>);
      const h = screen.getByRole("heading", { level: 2 });
      const list = cls(h).split(" ");
      expect(list).toContain(c);
      expect(list.filter((x) => /^text-text-/.test(x))).toEqual([c]);
    });
  }

  test("size/level unaffected by tone; default markup unchanged", () => {
    render(<Heading level={3} size="h1-lg" tone="inverse" className="mt-2">T</Heading>);
    const h = screen.getByRole("heading", { level: 3 });
    expect(h.tagName).toBe("H3");
    expect(cls(h)).toBe("text-h1-lg text-text-inverse mt-2");
    expect(renderToStaticMarkup(<Heading level={1}>X</Heading>)).toBe(
      '<h1 class="text-h1 md:text-h1-lg text-text-primary">X</h1>',
    );
    expect(renderToStaticMarkup(<Heading level={1}>X</Heading>)).toBe(
      renderToStaticMarkup(<Heading level={1} tone="default">X</Heading>),
    );
  });

  test("HeadingTone exported and closed (type-level)", () => {
    const ok: HeadingTone[] = ["default", "inverse", "secondary"];
    // @ts-expect-error "danger" is not a HeadingTone
    const bad: HeadingTone = "danger";
    expect(ok).toHaveLength(3);
    void bad;
  });

  test("Text tone=inverse unchanged", () => {
    const html = renderToStaticMarkup(<Text tone="inverse">x</Text>);
    expect(html).toContain("text-text-inverse");
    expect(html).not.toContain("text-text-primary");
  });
});

// ------------------------------------------------------------ 4. Button / IconButton
// Byte-identical Button class table. Originally the pre-batch-4 strings; Phase 3
// (QA-ATOMS-P3) regenerated it from src/components/atoms/Button/button-classes.ts
// after the pill restyle: radius `rounded-md` -> `rounded-full` (now its own
// slot after the layout), danger hover `shadow-md` -> `bg-danger-hover`, plus
// the new `outline` and `inverse` variants. The literals below are frozen; the
// "table matches the module" test catches drift in either direction.
const P3_LAYOUT =
  "inline-flex min-h-touch min-w-touch select-none items-center justify-center gap-2 font-semibold transition-colors";
const P3_PILL = "rounded-full";
const P3_STATES = "disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress";
const PRE_BASE = `${P3_LAYOUT} ${P3_PILL} ${P3_STATES}`;
const PRE_VARIANT = {
  primary: "bg-accent text-text-on-accent hover:bg-accent-hover active:bg-accent-active",
  secondary:
    "border border-border-strong bg-surface-raised text-text-primary hover:bg-accent-subtle active:bg-accent-subtle",
  ghost: "bg-transparent text-accent hover:bg-accent-subtle active:bg-accent-subtle",
  danger: "bg-danger text-text-on-accent hover:bg-danger-hover active:bg-danger-hover",
  outline:
    "border border-accent bg-surface-raised text-accent hover:bg-accent-subtle active:bg-accent-subtle",
  inverse:
    "border border-surface-raised bg-surface-raised text-text-primary hover:bg-surface-sunken active:bg-surface-sunken",
} as const;
const PRE_SIZE = { sm: "px-3 py-1 text-small", md: "px-4 py-2 text-body", lg: "min-h-12 px-6 py-3 text-body" } as const;

describe("item 4: Button / IconButton padding=none", () => {
  test("frozen class table matches Button/button-classes.ts (regenerated for Phase 3)", async () => {
    const m = await import("@/components/atoms/Button/button-classes");
    expect(m.BUTTON_LAYOUT).toBe(P3_LAYOUT);
    expect(m.BUTTON_SHAPE.pill).toBe(P3_PILL);
    expect(m.BUTTON_STATES).toBe(P3_STATES);
    for (const v of Object.keys(PRE_VARIANT) as Array<keyof typeof PRE_VARIANT>) {
      expect(m.BUTTON_VARIANT[v]).toBe(PRE_VARIANT[v]);
    }
    expect(m.BUTTON_SIZE.default).toEqual({ ...PRE_SIZE });
  });

  for (const v of Object.keys(PRE_VARIANT) as Array<keyof typeof PRE_VARIANT>) {
    for (const s of Object.keys(PRE_SIZE) as Array<keyof typeof PRE_SIZE>) {
      test(`default class string byte-identical to the frozen table: ${v}/${s}`, () => {
        const expected = `${PRE_BASE} ${PRE_VARIANT[v]} ${PRE_SIZE[s]}`;
        const a = renderToStaticMarkup(<Button variant={v} size={s}>x</Button>);
        const b = renderToStaticMarkup(<Button variant={v} size={s} padding="default">x</Button>);
        expect(a).toBe(`<button type="button" class="${expected}">x</button>`);
        expect(b).toBe(a);
      });
    }
  }

  for (const s of ["sm", "md", "lg"] as const) {
    test(`padding=none ${s}: p-0, no px/py, keeps touch minimums, radius, text size`, () => {
      render(<Button size={s} padding="none" aria-label="thumb">x</Button>);
      const list = cls(screen.getByRole("button", { name: "thumb" })).split(" ");
      expect(list).toContain("p-0");
      expect(list.some((c) => /^(px|py|pt|pb|ps|pe|pl|pr)-/.test(c))).toBe(false);
      for (const c of ["min-h-touch", "min-w-touch", "rounded-md"]) expect(list).toContain(c);
      expect(list.includes("min-h-12")).toBe(s === "lg");
      expect(list).toContain(s === "sm" ? "text-small" : "text-body");
      // focus ring is the global :focus-visible outline: nothing may remove it
      expect(list.some((c) => /outline-none|outline-0|ring-0/.test(c))).toBe(false);
    });
  }

  test("global :focus-visible outline still defined (padding none keeps the ring)", () => {
    const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\)/);
  });

  test("padding=none keeps loading/disabled behaviour", () => {
    const onClick = mock();
    render(<Button padding="none" loading onClick={onClick}>x</Button>);
    const b = screen.getByRole("button");
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    expect(b.getAttribute("aria-busy")).toBe("true");
  });

  test("IconButton padding=none keeps the square box (size-touch / size-12) and p-0", () => {
    render(
      <>
        <IconButton icon="heart" label="A" padding="none" />
        <IconButton icon="heart" label="B" size="lg" padding="none" />
        <IconButton icon="heart" label="C" />
      </>,
    );
    const a = cls(screen.getByRole("button", { name: "A" })).split(" ");
    const b = cls(screen.getByRole("button", { name: "B" })).split(" ");
    const c = cls(screen.getByRole("button", { name: "C" })).split(" ");
    expect(a).toContain("size-touch");
    expect(a).toContain("p-0");
    expect(a).not.toContain("px-3");
    expect(b).toContain("size-12");
    expect(b).toContain("p-0");
    expect(c).toContain("px-3");
    expect(c).toContain("py-1");
    for (const l of [a, b, c]) expect(l).toContain("min-h-touch");
  });

  test("IconButton default markup unchanged by the padding prop", () => {
    expect(renderToStaticMarkup(<IconButton icon="heart" label="A" />)).toBe(
      renderToStaticMarkup(<IconButton icon="heart" label="A" padding="default" />),
    );
  });

  test("ButtonPadding exported and closed (type-level)", () => {
    const ok: ButtonPadding[] = ["default", "none"];
    // @ts-expect-error "sm" is not a ButtonPadding
    const bad: ButtonPadding = "sm";
    expect(ok).toHaveLength(2);
    void bad;
  });
});

// ------------------------------------------------------------ 5. Chip
describe("item 5: Chip", () => {
  test("as=a: selected alone -> aria-current=true; explicit wins (incl. false); pass-through without selected", () => {
    render(
      <>
        <Chip as="a" href="?s=1" label="One" selected />
        <Chip as="a" href="?s=2" label="Two" selected aria-current="page" />
        <Chip as="a" href="?s=3" label="Three" selected aria-current="false" />
        <Chip as="a" href="?s=4" label="Four" aria-current="location" />
        <Chip as="a" href="?s=5" label="Five" />
      </>,
    );
    const get = (n: string) => screen.getByRole("link", { name: n });
    expect(get("One").getAttribute("aria-current")).toBe("true");
    expect(get("Two").getAttribute("aria-current")).toBe("page");
    expect(get("Three").getAttribute("aria-current")).toBe("false");
    expect(get("Four").getAttribute("aria-current")).toBe("location");
    expect(get("Five").hasAttribute("aria-current")).toBe(false);
    // styling follows selected only
    expect(cls(get("Four"))).toBe(cls(get("Five")).replace("?s=5", "?s=4"));
    expect(cls(get("Two"))).toBe(cls(get("One")));
  });

  test("type-level: aria-current is never on button/span chips; aria-label never on span", () => {
    const fn = () => (
      <>
        {/* @ts-expect-error aria-current not allowed on a button chip */}
        <Chip label="a" aria-current="true" />
        {/* @ts-expect-error aria-current not allowed on a span chip */}
        <Chip as="span" label="b" aria-current="true" />
        {/* @ts-expect-error aria-label not allowed on a span chip */}
        <Chip as="span" label="c" aria-label="C" />
        <Chip as="a" href="/x" label="d" aria-current="page" aria-label="D d" />
        <Chip label="e" aria-label="E e" removeLabel="Remove e" onRemove={() => {}} />
      </>
    );
    expect(typeof fn).toBe("function");
  });

  test("removeLabel overrides the remove button name on button, link and span chips; default is 'Remove <label>'", () => {
    const onRemove = mock();
    render(
      <>
        <Chip label="Acme" onRemove={onRemove} removeLabel="Remove filter: Brand Acme" />
        <Chip as="a" href="/x" label="Blue" onRemove={onRemove} removeLabel="Remove filter: Colour Blue" />
        <Chip as="span" label="Big" onRemove={onRemove} removeLabel="Remove filter: Size Big" />
        <Chip as="span" label="Under $25" onRemove={onRemove} />
      </>,
    );
    for (const n of ["Remove filter: Brand Acme", "Remove filter: Colour Blue", "Remove filter: Size Big", "Remove Under $25"]) {
      fireEvent.click(screen.getByRole("button", { name: n }));
    }
    expect(onRemove).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole("button", { name: "Remove Acme" })).toBeNull();
  });

  test("aria-label renames button and link chips (removable or not); visible text kept", () => {
    render(
      <>
        <Chip label="Acme" aria-label="Brand: Acme" onToggle={() => {}} />
        <Chip as="a" href="/x" label="Blue" aria-label="Colour: Blue" />
        <Chip label="Red" aria-label="Colour: Red" onRemove={() => {}} />
      </>,
    );
    const btn = screen.getByRole("button", { name: "Brand: Acme" });
    expect(btn.textContent).toBe("Acme");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("link", { name: "Colour: Blue" }).textContent).toBe("Blue");
    expect(screen.getByRole("button", { name: "Colour: Red" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Red" })).toBeTruthy();
  });

  test("defaults unchanged: no aria-label attribute when not passed", () => {
    const html = renderToStaticMarkup(<Chip label="A" />);
    expect(html).not.toContain("aria-label");
    expect(renderToStaticMarkup(<Chip as="a" href="/x" label="A" />)).not.toContain("aria-label");
  });

  test("hostile label / removeLabel / aria-label stay text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <>
        <Chip label={evil} onRemove={() => {}} removeLabel={`Remove ${evil}`} aria-label={`x ${evil}`} />
        <Chip as="a" href="/x" label={evil} aria-label={evil} />
      </>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: `Remove ${evil}` })).toBeTruthy();
    expect(screen.getByRole("link", { name: evil }).textContent).toBe(evil);
  });
});

// ------------------------------------------------------------ 6. SearchField
const SUGG: SearchSuggestion[] = [
  { id: "r1", label: "Recent: lamp", value: "lamp", icon: "clock", href: "/search?q=lamp" },
  { id: "r2", label: "lamp shade", href: "/search?q=lamp+shade" },
  { id: "r3", label: "desk lamp", href: "/search?q=desk+lamp" },
];
const PRE_LISTBOX =
  "absolute left-0 right-0 top-full z-dropdown mt-1 max-h-80 overflow-y-auto rounded-md border border-border-strong bg-surface-raised py-1 shadow-md";
const PRE_OPTION = "flex min-h-touch cursor-pointer items-center px-3 py-2 text-body text-text-primary";
const field = () => screen.getByRole("combobox") as HTMLInputElement;

// Keyboard Tab order approximation: focusable elements in DOM order, skipping
// anything inside a [hidden] subtree or disabled.
function tabbables(root: ParentNode = document): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("input:not([type=hidden]),button,a[href],select,textarea,[tabindex]"),
  ).filter((el) => !el.closest("[hidden]") && !(el as HTMLButtonElement).disabled && el.tabIndex >= 0);
}
function pressTab() {
  const from = document.activeElement as HTMLElement;
  const list = tabbables();
  const next = list[list.indexOf(from) + 1]!;
  fireEvent.blur(from, { relatedTarget: next });
  next.focus();
  fireEvent.focus(next);
  return next;
}

describe("item 6: SearchField", () => {
  test("maxLength forwarded in static (no-JS) markup and after hydration; absent by default", () => {
    const html = renderToStaticMarkup(<SearchField maxLength={100} />);
    expect(html).toMatch(/<input[^>]*maxLength="100"/);
    expect(renderToStaticMarkup(<SearchField />)).not.toMatch(/maxLength/i);
    render(<SearchField maxLength={5} />);
    expect(field().maxLength).toBe(5);
  });

  test("static markup: no listbox/footer even with listFooter (popup is JS-only)", () => {
    const html = renderToStaticMarkup(<SearchField suggestions={SUGG} listFooter={<button type="button">Clear</button>} />);
    expect(html).not.toContain("listbox");
    expect(html).not.toContain("Clear");
  });

  test("suggestion icon: decorative svg (aria-hidden, text-current) inside the option; option name = label", () => {
    render(<SearchField suggestions={SUGG} />);
    fireEvent.focus(field());
    const opt = screen.getByRole("option", { name: "Recent: lamp" });
    const svg = opt.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(cls(svg).split(" ")).toContain("text-current");
    expect(screen.getByRole("option", { name: "lamp shade" }).querySelector("svg")).toBeNull();
  });

  test("value is inserted when chosen (Enter and click); label is the default", () => {
    const onSelect = mock();
    render(<SearchField suggestions={SUGG} onSelect={onSelect} />);
    fireEvent.focus(field());
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("lamp");
    expect(onSelect).toHaveBeenLastCalledWith(SUGG[0]);
    fireEvent.change(field(), { target: { value: "la" } });
    fireEvent.click(screen.getByRole("option", { name: "desk lamp" }));
    expect(field().value).toBe("desk lamp");
  });

  test("without listFooter: listbox is the pre-batch element (classes, parent, no wrapper)", () => {
    const { container } = render(<SearchField inputId="s" suggestions={SUGG} />);
    fireEvent.focus(field());
    const lb = screen.getByRole("listbox");
    expect(cls(lb)).toBe(PRE_LISTBOX);
    expect(lb.parentElement!.className).toBe("relative min-w-0 flex-1");
    expect(container.querySelector("[data-testid=search-suggestions-popup]")).toBeNull();
    expect(cls(screen.getByRole("option", { name: "lamp shade" }))).toBe(PRE_OPTION);
  });

  test("without listFooter: DOM identical for omitted / undefined / null", () => {
    const html = (lf?: null) => {
      const r = render(<SearchField inputId="s" suggestions={SUGG} {...(lf === undefined ? {} : { listFooter: lf })} />);
      fireEvent.focus(r.container.querySelector("input")!);
      const out = r.container.innerHTML;
      r.unmount();
      return out;
    };
    const base = html();
    expect(html(null)).toBe(base);
    expect(base).not.toContain("search-suggestions-popup");
  });

  test("listFooter: outside the listbox, visible only while open", () => {
    render(<SearchField suggestions={SUGG} listFooter={<button type="button">Clear recent searches</button>} />);
    const clear = () => screen.getByRole("button", { name: "Clear recent searches", hidden: true });
    expect(clear().closest("[hidden]")).not.toBeNull(); // closed: hidden
    fireEvent.focus(field());
    expect(clear().closest("[hidden]")).toBeNull();
    expect(screen.getByRole("listbox").contains(clear())).toBe(false);
    expect(clear().closest("[role=option]")).toBeNull();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(clear().closest("[hidden]")).not.toBeNull();
  });

  test("Tab from an EMPTY input reaches the footer with the popup kept open", () => {
    render(<SearchField suggestions={SUGG} listFooter={<button type="button">Clear recent searches</button>} />);
    field().focus();
    fireEvent.focus(field());
    const next = pressTab();
    expect(next.textContent).toBe("Clear recent searches");
    expect(field().getAttribute("aria-expanded")).toBe("true");
  });

  test("fixed (was evidence for D-ATOMS4-1): Tab to the Clear-search button keeps the popup and footer reachable", () => {
    render(<SearchField suggestions={SUGG} listFooter={<button type="button">Clear recent searches</button>} />);
    field().focus();
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "la" } });
    expect(field().getAttribute("aria-expanded")).toBe("true");
    const order = tabbables().map((el) => el.getAttribute("aria-label") ?? el.textContent);
    const idxInput = tabbables().indexOf(field());
    expect(order[idxInput + 1]).toBe("Clear search");
    const next = pressTab();
    expect(next.getAttribute("aria-label")).toBe("Clear search");
    // Clear is part of the composite: the popup stays open and the footer stays tabbable.
    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(tabbables().some((el) => el.textContent === "Clear recent searches")).toBe(true);
    // Leaving the composite from the Clear button closes the popup.
    fireEvent.blur(next, { relatedTarget: screen.getByRole("button", { name: "Submit search" }) });
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  test("DEFECT D-ATOMS4-1 (fixed): Tab from a non-empty input reaches the listFooter (popup kept open)", () => {
    render(<SearchField suggestions={SUGG} listFooter={<button type="button">Clear recent searches</button>} />);
    field().focus();
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "la" } });
    let reached = false;
    for (let n = 0; n < 2; n++) {
      const el = pressTab();
      if (el.textContent === "Clear recent searches") {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    expect(field().getAttribute("aria-expanded")).toBe("true");
  });

  test("focus leaving the footer to elsewhere closes; back to the input keeps open", () => {
    render(
      <SearchField
        suggestions={SUGG}
        listFooter={
          <>
            <button type="button">One</button>
            <button type="button">Two</button>
          </>
        }
      />,
    );
    fireEvent.focus(field());
    const one = screen.getByRole("button", { name: "One" });
    const two = screen.getByRole("button", { name: "Two" });
    fireEvent.blur(field(), { relatedTarget: one });
    fireEvent.blur(one, { relatedTarget: two }); // within footer
    expect(field().getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(two, { relatedTarget: field() }); // back to input
    expect(field().getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(field(), { relatedTarget: two });
    fireEvent.blur(two, { relatedTarget: null }); // to body
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  test("Escape in the footer closes and refocuses the input; re-open with ArrowDown", () => {
    render(<SearchField suggestions={SUGG} listFooter={<button type="button">Clear</button>} />);
    field().focus();
    fireEvent.focus(field());
    const clear = screen.getByRole("button", { name: "Clear" });
    fireEvent.blur(field(), { relatedTarget: clear });
    clear.focus();
    fireEvent.keyDown(clear, { key: "Escape" });
    expectFocused(field());
    expect(field().getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(field().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
  });

  test("mouse in footer: mousedown prevented (input keeps focus), click fires, popup stays open", () => {
    const onClear = mock();
    render(<SearchField suggestions={SUGG} listFooter={<button type="button" onClick={onClear}>Clear</button>} />);
    field().focus();
    fireEvent.focus(field());
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(fireEvent.mouseDown(clear)).toBe(false);
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
    expectFocused(field());
    expect(field().getAttribute("aria-expanded")).toBe("true");
  });

  test("keyboard nav + aria-activedescendant correct with the footer wrapper present", () => {
    const onSelect = mock();
    render(<SearchField suggestions={SUGG} onSelect={onSelect} listFooter={<button type="button">Clear</button>} />);
    fireEvent.focus(field());
    const ids = screen.getAllByRole("option").map((o) => o.id);
    const ad = () => field().getAttribute("aria-activedescendant");
    expect(ad()).toBeNull();
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(ad()).toBe(ids[0]!);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(ad()).toBe(ids[2]!);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(ad()).toBe(ids[0]!); // wraps
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(ad()).toBe(ids[2]!);
    expect(screen.getByRole("option", { name: "desk lamp" }).getAttribute("aria-selected")).toBe("true");
    for (const id of ids) expect(document.getElementById(id)!.closest("[role=listbox]")).not.toBeNull();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(SUGG[2]);
    expect(field().getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(ad()).toBeNull();
  });

  test("fixed (was evidence for D-ATOMS4-2): listFooter={false} / \"\" render no footer wrapper", () => {
    for (const empty of [false, ""] as const) {
      const { container, unmount } = render(<SearchField inputId="s" suggestions={SUGG} listFooter={empty} />);
      fireEvent.focus(field());
      expect(container.querySelector("[data-testid=search-suggestions-popup]")).toBeNull();
      expect(container.querySelector(".border-t")).toBeNull();
      unmount();
    }
  });

  test("DEFECT D-ATOMS4-2 (fixed): listFooter={false} renders no empty bordered footer (same DOM as no footer)", () => {
    const a = render(<SearchField inputId="s" suggestions={SUGG} />);
    fireEvent.focus(a.container.querySelector("input")!);
    const base = a.container.innerHTML;
    a.unmount();
    const b = render(<SearchField inputId="s" suggestions={SUGG} listFooter={false} />);
    fireEvent.focus(b.container.querySelector("input")!);
    expect(b.container.innerHTML).toBe(base);
  });

  test("hostile suggestion label / value stay text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const onSelect = mock();
    const { container } = render(
      <SearchField suggestions={[{ id: "e", label: evil, value: evil, href: "/s" }]} onSelect={onSelect} />,
    );
    fireEvent.focus(field());
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: evil }));
    expect(field().value).toBe(evil);
    expect(within(container).queryByRole("img")).toBeNull();
  });
});

// ------------------------------------------------------------ 7. ProgressBar
describe("item 7: ProgressBar hideValueText", () => {
  const props = { label: "Free shipping", value: 30, max: 50, valueText: "$20.00 away from free shipping" };

  test("hides only the visible valueText <p>; aria-valuetext/now/min/max kept", () => {
    const { container } = render(<ProgressBar {...props} hideValueText />);
    expect(container.querySelector("p")).toBeNull();
    const bar = screen.getByRole("progressbar", { name: "Free shipping" });
    expect(bar.getAttribute("aria-valuetext")).toBe(props.valueText);
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("50");
    expect(screen.getByText("Free shipping")).toBeTruthy();
  });

  test("hideValueText=false/omitted keeps the aria-hidden <p>; markup byte-identical", () => {
    const a = renderToStaticMarkup(<ProgressBar id="p" {...props} />);
    const b = renderToStaticMarkup(<ProgressBar id="p" {...props} hideValueText={false} />);
    expect(a).toBe(b);
    expect(a).toContain(`<p aria-hidden="true" class="text-small text-text-primary">${props.valueText}</p>`);
    const c = renderToStaticMarkup(<ProgressBar id="p" {...props} hideValueText />);
    expect(c).toBe(a.replace(`<p aria-hidden="true" class="text-small text-text-primary">${props.valueText}</p>`, ""));
  });

  test("showValue independent of hideValueText", () => {
    const noText = { label: "Upload", value: 42 };
    const a = renderToStaticMarkup(<ProgressBar id="u" {...noText} showValue />);
    const b = renderToStaticMarkup(<ProgressBar id="u" {...noText} showValue hideValueText />);
    expect(a).toBe(b);
    expect(a).toContain('<span aria-hidden="true" class="tabular-nums">42%</span>');
    expect(b).toContain('aria-valuetext="42%"');
  });

  test("indeterminate + hideValueText: no aria-valuenow, valuetext kept, no <p>", () => {
    const { container } = render(<ProgressBar label="Loading" indeterminate valueText="Preparing" hideValueText />);
    const bar = screen.getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("aria-valuetext")).toBe("Preparing");
    expect(container.querySelector("p")).toBeNull();
  });
});

// ------------------------------------------------------------ 9. Regression greps
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}
const SOURCES = walk(ATOMS).map((p) => ({ p: p.slice(ROOT.length + 1), s: readFileSync(p, "utf8") }));
const hits = (re: RegExp) =>
  SOURCES.flatMap(({ p, s }) => s.split("\n").flatMap((l, i) => (re.test(l) ? [`${p}:${i + 1}: ${l.trim()}`] : [])));

describe("item 9: regression greps over atom sources (non-test)", () => {
  test("no `any`", () => {
    expect(hits(/(:\s*any\b|<any>|\bas any\b|any\[\])/)).toEqual([]);
  });
  test("no @ts-ignore / @ts-expect-error / eslint-disable", () => {
    expect(hits(/@ts-ignore|@ts-expect-error|eslint-disable/)).toEqual([]);
  });
  test("only ProgressBar uses style= (fill width)", () => {
    const h = hits(/\bstyle=/);
    expect(h.every((l) => l.startsWith("src/components/atoms/ProgressBar/ProgressBar.tsx"))).toBe(true);
    expect(h.length).toBeLessThanOrEqual(1);
  });
  test("no raw hex colours", () => {
    expect(hits(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b(?![\w-])/).filter((l) => !/href|#main|"#"/.test(l))).toEqual([]);
  });
  test("bun run check:tokens exits 0", () => {
    const r = spawnSync("bun", ["run", "check:tokens"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
