// QA (QA-W0-D1): P2-D1 atoms batch 1, part 1 of 3: Icon, IconButton, Rating
// (criteria 1-3). Parts 2/3: phase2-batch1-forms.qa.test.tsx (Checkbox, Radio,
// Switch, Textarea), phase2-batch1-misc.qa.test.tsx (Chip, Avatar, Divider,
// VisuallyHidden, Notice, cross-cutting). Tokens: phase2-tokens.qa.test.ts.
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { Icon, ICON_NAMES, type IconName } from "@/components/atoms/Icon";
import { IconButton } from "@/components/atoms/IconButton";
import { Rating } from "@/components/atoms/Rating";
import { expectFocused } from "@/test/dom-assertions";

const ROOT = join(import.meta.dir, "..", "..", "..");
const src = (p: string) => readFileSync(join(ROOT, "src/components/atoms", p), "utf8");

/** Parse server HTML into a live DOM node (no React, no JS handlers). */
function staticDom(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

// ---------------------------------------------------------------- criterion 1
describe("Icon (criterion 1)", () => {
  const EXPECTED = [
    "search", "cart", "heart", "heart-filled", "star", "star-filled", "star-half", "chevron-down",
    "chevron-up", "chevron-left", "chevron-right", "close", "menu", "user", "check", "check-circle",
    "minus", "plus", "share", "zoom-in", "trash", "info", "warning", "error-circle", "external-link",
    "filter", "sort", "list", "package", "location", "truck", "lock", "copy", "print", "arrow-up",
    "arrow-right", "question-circle", "thumbs-up", "columns", "refresh", "clock", "tag", "gift", "home",
    "grid", "eye", "eye-off", "mail", "phone",
  ];
  const EXPECTED_ALL = [...EXPECTED, "circle", "circle-dot"];

  test("every one of the 49 required names is in ICON_NAMES, no duplicates", () => {
    expect(EXPECTED).toHaveLength(49);
    for (const n of EXPECTED) expect(ICON_NAMES as readonly string[]).toContain(n);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  // DEFECT D1: criterion 1 says "contains exactly these 49"; ICON_NAMES now has 51
  // (circle, circle-dot appended 17:23 during QA). Remove .failing once the AC is
  // amended or the extras are dropped.
  test("DEFECT D1: ICON_NAMES is exactly the 49 required names + circle, circle-dot (51)", () => {
    expect([...(ICON_NAMES as readonly string[])].sort()).toEqual([...EXPECTED_ALL].sort());
  });

  test.each(ICON_NAMES.map((n) => [n]))("every exported name (incl. extras) renders: %s", (name) => {
    const { container } = render(<Icon name={name} />);
    expect(container.querySelectorAll("svg > *").length).toBeGreaterThan(0);
  });

  test.each(EXPECTED.map((n) => [n]))("%s renders a 24x24 currentColor svg with non-empty geometry", (name) => {
    const { container } = render(<Icon name={name as IconName} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    const shapes = svg.querySelectorAll("path, circle, rect, polygon, line, polyline, ellipse");
    expect(shapes.length).toBeGreaterThan(0);
    for (const s of shapes) {
      const geom = s.getAttribute("d") ?? s.getAttribute("points") ?? s.getAttribute("r") ?? s.getAttribute("width");
      expect((geom ?? "").trim().length).toBeGreaterThan(0);
      const fill = s.getAttribute("fill");
      if (fill !== null) expect(fill).toBe("currentColor");
      const stroke = s.getAttribute("stroke");
      if (stroke !== null) expect(stroke).toBe("currentColor");
    }
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  test("source contains no hex colour and no fill/stroke other than currentColor/none", () => {
    const s = src("Icon/Icon.tsx");
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const m of s.matchAll(/(?:fill|stroke)="([^"]+)"/g)) expect(["currentColor", "none"]).toContain(m[1]!);
  });

  test.each([["sm", "size-4"], ["md", "size-5"], ["lg", "size-6"]] as const)("size %s -> %s", (size, cls) => {
    const { container } = render(<Icon name="cart" size={size} />);
    expect(container.querySelector("svg")).toHaveClass(cls);
  });

  test("default size is md (20px)", () => {
    const { container } = render(<Icon name="cart" />);
    expect(container.querySelector("svg")).toHaveClass("size-5");
  });

  test("no title: aria-hidden + focusable=false, no role, no <title>", () => {
    const { container } = render(<Icon name="truck" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).not.toHaveAttribute("role");
    expect(svg.querySelector("title")).toBeNull();
  });

  test("title: role=img named by <title>, not aria-hidden", () => {
    render(<Icon name="warning" title="Warning" />);
    const img = screen.getByRole("img", { name: "Warning" });
    expect(img.querySelector("title")?.textContent).toBe("Warning");
    expect(img).not.toHaveAttribute("aria-hidden");
    expect(img).toHaveAttribute("focusable", "false");
  });

  test("hostile: empty / whitespace title is treated as decorative (no empty-named img)", () => {
    for (const t of ["", "   "]) {
      const { container, unmount } = render(<Icon name="info" title={t} />);
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(container.querySelector("[role=img]")).toBeNull();
      unmount();
    }
  });

  test("two titled icons get distinct title ids", () => {
    const { container } = render(<><Icon name="info" title="A" /><Icon name="info" title="B" /></>);
    const ids = [...container.querySelectorAll("title")].map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("ref forwarded, className merged last", () => {
    const ref = createRef<SVGSVGElement>();
    const { container } = render(<Icon name="cart" ref={ref} className="text-accent" />);
    expect(ref.current).toBe(container.querySelector("svg"));
    expect(ref.current?.getAttribute("class")?.endsWith("text-accent")).toBe(true);
  });

  test("server-safe: renders with renderToStaticMarkup", () => {
    expect(renderToStaticMarkup(<Icon name="home" title="Home" />)).toContain("<title");
  });

  test("type contract: unknown name / size are compile errors", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error not an icon name */}
        <Icon name="not-an-icon" />
        {/* @ts-expect-error xl is not a size */}
        <Icon name="cart" size="xl" />
        {/* @ts-expect-error name is required */}
        <Icon />
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});

// ---------------------------------------------------------------- criterion 2
describe("IconButton (criterion 2)", () => {
  test("label -> aria-label; icon decorative; native button type=button", () => {
    render(<IconButton icon="heart" label="Save to wishlist" />);
    const b = screen.getByRole("button", { name: "Save to wishlist" });
    expect(b.tagName).toBe("BUTTON");
    expect(b).toHaveAttribute("type", "button");
    expect(b.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test.each([
    ["ghost", "bg-transparent"],
    ["outline", "border-border-strong"],
    ["solid", "bg-accent"],
  ] as const)("variant %s maps onto Button's classes (%s)", (variant, cls) => {
    render(<IconButton icon="close" label="Close" variant={variant} />);
    expect(screen.getByRole("button")).toHaveClass(cls);
  });

  test("pressed undefined -> no aria-pressed; true/false -> aria-pressed true/false", () => {
    const { rerender } = render(<IconButton icon="heart" label="Save" />);
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-pressed");
    rerender(<IconButton icon="heart" label="Save" pressed={false} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
    rerender(<IconButton icon="heart-filled" label="Save" pressed />);
    expect(screen.getByRole("button", { pressed: true })).toBeInTheDocument();
  });

  test("loading: aria-busy, keeps name + focusability, swallows clicks and form submit", () => {
    const onClick = mock(() => {});
    const onSubmit = mock((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <IconButton icon="trash" label="Delete" loading onClick={onClick} type="submit" />
      </form>,
    );
    const b = screen.getByRole("button", { name: "Delete" });
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b).not.toBeDisabled();
    b.focus();
    expectFocused(b);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("disabled: native disabled, click ignored", () => {
    const onClick = mock(() => {});
    render(<IconButton icon="plus" label="Add" disabled onClick={onClick} />);
    const b = screen.getByRole("button", { name: "Add" });
    expect(b).toBeDisabled();
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  test.each([["sm", "size-touch"], ["md", "size-touch"], ["lg", "size-12"]] as const)(
    "size %s keeps >=44px target (%s + min-h-touch min-w-touch)",
    (size, cls) => {
      render(<IconButton icon="plus" label="Add" size={size} />);
      expect(screen.getByRole("button")).toHaveClass(cls, "min-h-touch", "min-w-touch");
    },
  );

  test("visible focus ring: no outline suppression in classes", () => {
    render(<IconButton icon="plus" label="Add" variant="solid" pressed />);
    expect(screen.getByRole("button").className).not.toMatch(/outline-none|outline-0|ring-0/);
  });

  test("wraps Button (imports and renders it; no own click/loading logic)", () => {
    const s = src("IconButton/IconButton.tsx");
    expect(s).toMatch(/from "\.\.\/Button"/);
    expect(s).toMatch(/<Button\b/);
    expect(s).not.toMatch(/<button\b/);
    expect(s).not.toMatch(/preventDefault/);
  });

  test("ref forwarded, className merged last", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<IconButton icon="plus" label="Add" ref={ref} className="ml-2" />);
    expect(ref.current === screen.getByRole("button")).toBe(true);
    expect(ref.current?.className.endsWith("ml-2")).toBe(true);
  });

  test("keyboard-only: native button (Enter/Space activation is browser-native) fires onClick", () => {
    const onClick = mock(() => {});
    render(<IconButton icon="plus" label="Add" onClick={onClick} />);
    const b = screen.getByRole("button");
    b.focus();
    expectFocused(b);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("a stray aria-label (hyphenated JSX attrs bypass the Omit) cannot override label", () => {
    render(<IconButton icon="plus" label="Add to cart" aria-label="hijack" />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Add to cart");
  });

  test("documents behaviour: empty label yields an unnamed button (type allows '', no warning)", () => {
    render(<IconButton icon="plus" label="" />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "");
  });

  test("type contract: label + icon required; aria-label / children not accepted", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error label required */}
        <IconButton icon="plus" />
        {/* @ts-expect-error unknown icon */}
        <IconButton icon="nope" label="x" />
        {/* @ts-expect-error variant primary is a Button variant, not an IconButton one */}
        <IconButton icon="plus" label="x" variant="primary" />
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});

// ---------------------------------------------------------------- criterion 3
describe("Rating display (criterion 3)", () => {
  const stars = (c: HTMLElement) =>
    [...c.querySelectorAll("[data-testid=rating-stars] svg")].map((s) => s.getAttribute("data-icon"));
  const sr = (c: HTMLElement) => [...c.querySelectorAll(".sr-only")].map((s) => s.textContent).join("");

  test.each([
    [4.3, "4.3 out of 5 stars", ["star-filled", "star-filled", "star-filled", "star-filled", "star-half"]],
    [4.2, "4.2 out of 5 stars", ["star-filled", "star-filled", "star-filled", "star-filled", "star"]],
    [4.75, "4.8 out of 5 stars", ["star-filled", "star-filled", "star-filled", "star-filled", "star-filled"]],
    [0.25, "0.3 out of 5 stars", ["star-half", "star", "star", "star", "star"]],
    [0, "0 out of 5 stars", ["star", "star", "star", "star", "star"]],
    [5, "5 out of 5 stars", Array(5).fill("star-filled")],
  ] as const)("value %d -> '%s' with half-star rounding", (value, text, icons) => {
    const { container } = render(<Rating value={value} />);
    expect(sr(container)).toBe(text);
    expect(stars(container)).toEqual([...icons]);
  });

  test.each([
    [Number.NaN, "0"], [-3, "0"], [-0, "0"], [99, "5"], [Number.POSITIVE_INFINITY, "0"], [Number.NEGATIVE_INFINITY, "0"],
  ])("hostile value %p is clamped (text '%s out of 5 stars')", (value, shown) => {
    const { container } = render(<Rating value={value} />);
    expect(sr(container)).toBe(`${shown} out of 5 stars`);
    expect(stars(container)).toHaveLength(5);
  });

  test("count formatted with Intl.NumberFormat; visible (1,234) hidden from AT, ', 1,234 ratings' read", () => {
    const { container } = render(<Rating value={4.3} count={1234} />);
    expect(sr(container)).toBe("4.3 out of 5 stars, 1,234 ratings");
    const visible = [...container.querySelectorAll("[aria-hidden=true]")].map((e) => e.textContent).join("");
    expect(visible).toContain("(1,234)");
  });

  test.each([
    [1, ", 1 rating"], [0, ", 0 ratings"], [1e9, ", 1,000,000,000 ratings"], [2.9, ", 2 ratings"],
  ])("count %p -> '%s'", (count, tail) => {
    const { container } = render(<Rating value={3} count={count} />);
    expect(sr(container)).toBe(`3 out of 5 stars${tail}`);
  });

  test.each([[Number.NaN], [-5], [Number.POSITIVE_INFINITY]])("hostile count %p renders no count", (count) => {
    const { container } = render(<Rating value={3} count={count} />);
    expect(sr(container)).toBe("3 out of 5 stars");
    expect(container.textContent).not.toMatch(/\(/);
  });

  test("stars wrapper aria-hidden; individual svgs decorative; no interactive elements", () => {
    const { container } = render(<Rating value={2.5} count={3} />);
    expect(container.querySelector("[data-testid=rating-stars]")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("button, input, a, [tabindex]")).toHaveLength(0);
  });

  test("ref + className merged last", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(<Rating value={3} ref={ref} className="mt-1" />);
    expect(ref.current).toBe(container.firstElementChild as HTMLSpanElement);
    expect(ref.current?.className.endsWith("mt-1")).toBe(true);
  });
});

// Current implementation labels radios "N out of 5 stars"; criterion 3 says
// "1 star".."5 stars" (DEFECT D2). Functional tests accept either form.
const star = (n: number) => new RegExp(`^${n} (stars?|out of 5 stars)$`);

describe("Rating input (criterion 3)", () => {
  test("DEFECT D2: radios are labelled exactly '1 out of 5 stars' .. '5 out of 5 stars'", () => {
    render(<Rating mode="input" name="r" label="R" />);
    for (const n of ["1 out of 5 stars", "2 out of 5 stars", "3 out of 5 stars", "4 out of 5 stars", "5 out of 5 stars"]) {
      expect(screen.getByRole("radio", { name: n })).toBeInTheDocument();
    }
  });

  test("fieldset role=radiogroup named by legend; 5 native radios named '1 star'..'5 stars' in DOM order", () => {
    const { container } = render(<Rating mode="input" name="rating" label="Overall rating" />);
    const group = screen.getByRole("radiogroup", { name: "Overall rating" });
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelector("legend")?.textContent).toBe("Overall rating");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["1", "2", "3", "4", "5"]);
    expect(radios.map((r) => r.getAttribute("name"))).toEqual(Array(5).fill("rating"));
    expect([1, 2, 3, 4, 5].map((n) => screen.getByRole("radio", { name: star(n) }))).toEqual(radios);
    expect(container.querySelectorAll("input[type=radio]")).toHaveLength(5);
  });

  test("hideLabel keeps the legend for AT only", () => {
    render(<Rating mode="input" name="r" label="Your rating" hideLabel />);
    expect(screen.getByRole("radiogroup", { name: "Your rating" }).querySelector("legend")).toHaveClass("sr-only");
  });

  test("uncontrolled defaultValue checks that star; onChange gets the number", () => {
    const onChange = mock<(v: number) => void>(() => {});
    render(<Rating mode="input" name="r" label="R" defaultValue={3} onChange={onChange} />);
    expect(screen.getByRole("radio", { name: star(3) })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: star(5) }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toBe(5);
    expect(screen.getByRole("radio", { name: star(5) })).toBeChecked();
  });

  test("controlled value: null = none checked; follows parent state", () => {
    function Host() {
      const [v, setV] = useState<number | null>(null);
      return <Rating mode="input" name="r" label="R" value={v} onChange={setV} />;
    }
    render(<Host />);
    expect(screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: star(2) }));
    expect(screen.getByRole("radio", { name: star(2) })).toBeChecked();
  });

  test("controlled value that the parent refuses to change stays put", () => {
    render(<Rating mode="input" name="r" label="R" value={4} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: star(1) }));
    expect(screen.getByRole("radio", { name: star(4) })).toBeChecked();
  });

  test("hostile defaultValue (0, 6, 2.5, NaN) checks nothing and does not throw", () => {
    for (const d of [0, 6, 2.5, Number.NaN]) {
      const { unmount } = render(<Rating mode="input" name="r" label="R" defaultValue={d} />);
      expect(screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
      unmount();
    }
  });

  test("required -> native required on every radio + aria-required; invalid -> aria-invalid; describedBy passes through", () => {
    render(
      <>
        <Rating mode="input" name="r" label="R" required invalid describedBy="err" />
        <p id="err">Pick a rating</p>
      </>,
    );
    const g = screen.getByRole("radiogroup", { name: "R" });
    expect(g).toHaveAttribute("aria-invalid", "true");
    expect(g).toHaveAttribute("aria-required", "true");
    expect(g).toHaveAccessibleDescription("Pick a rating");
    for (const r of screen.getAllByRole("radio")) expect(r).toBeRequired();
  });

  test("not invalid / not required -> no aria-invalid / aria-required attributes", () => {
    render(<Rating mode="input" name="r" label="R" />);
    const g = screen.getByRole("radiogroup");
    expect(g).not.toHaveAttribute("aria-invalid");
    expect(g).not.toHaveAttribute("aria-required");
    expect(g).not.toHaveAttribute("aria-describedby");
  });

  test("posts as a normal field via FormData (client render)", () => {
    const { container } = render(
      <form><Rating mode="input" name="rating" label="R" defaultValue={4} /></form>,
    );
    expect(new FormData(container.querySelector("form")!).getAll("rating")).toEqual(["4"]);
  });

  test("no selection posts no value", () => {
    const { container } = render(<form><Rating mode="input" name="rating" label="R" /></form>);
    expect(new FormData(container.querySelector("form")!).has("rating")).toBe(false);
  });

  test("no-JS HTML (renderToStaticMarkup): native radios inside a form post the default value", () => {
    const html = renderToStaticMarkup(
      <form><Rating mode="input" name="rating" label="Overall" required defaultValue={2} /></form>,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("<legend");
    expect((html.match(/type="radio"/g) ?? []).length).toBe(5);
    expect((html.match(/required=""/g) ?? []).length).toBe(5);
    const host = staticDom(html);
    const form = host.querySelector("form")!;
    expect(new FormData(form).getAll("rating")).toEqual(["2"]);
    // user picks 5 without JS: native radio behaviour
    (host.querySelector('input[value="5"]') as HTMLInputElement).click();
    expect(new FormData(form).getAll("rating")).toEqual(["5"]);
    host.remove();
  });

  test("hover preview is CSS-only: mouseover/mouseenter changes no markup and no checked state", () => {
    const onChange = mock(() => {});
    const { container } = render(<Rating mode="input" name="r" label="R" defaultValue={2} onChange={onChange} />);
    const before = container.innerHTML;
    const label4 = screen.getByRole("radio", { name: star(4) }).closest("label")!;
    fireEvent.mouseOver(label4);
    fireEvent.mouseEnter(label4);
    fireEvent.mouseMove(label4);
    fireEvent.mouseLeave(label4);
    expect(container.innerHTML).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
    expect(src("Rating/Rating.tsx")).not.toMatch(/onMouse|onPointer|useState/);
  });

  test("star fill rules use hover only inside group/peer variants (generated under @media (hover: hover))", () => {
    const s = src("Rating/Rating.tsx");
    expect(s).toContain("group-hover/rating:fill-current");
    expect(s).toContain("peer-hover/star:fill-none");
    expect(s).toContain("group-has-checked/rating:fill-current");
  });

  // D-T131-4 fix (designer addendum): the ring is no longer pinned on the label with
  // `has-focus-visible:outline-focus-ring` (that kept a blue ring on dark bands). The focused radio is a
  // transparent `appearance-none` layer covering the 44px star, so the base :focus-visible rule draws the
  // ring (white inside bg-surface-inverse). Intent kept: native radios, 44px label, visible focus ring.
  test("keyboard: radios are native (no tabindex overrides, no key handlers); label hit area 44px; focus ring drawn by the base rule on a full-size radio layer", () => {
    render(<Rating mode="input" name="r" label="R" />);
    for (const r of screen.getAllByRole("radio")) {
      expect(r).not.toHaveAttribute("tabindex");
      expect(r).toHaveClass("absolute", "inset-0", "appearance-none", "bg-transparent");
      const rc = (r.getAttribute("class") ?? "").split(/\s+/);
      expect(rc.filter((c) => /outline-none|outline-0|focus(-visible)?:outline-none/.test(c))).toEqual([]);
      const label = r.closest("label")!;
      expect(label).toHaveClass("size-touch");
      expect((label.getAttribute("class") ?? "").split(/\s+/).filter((c) => c.includes("outline"))).toEqual([]);
    }
    expect(src("Rating/Rating.tsx")).not.toMatch(/onKey/);
  });

  test("disabled disables every radio via the fieldset", () => {
    render(<Rating mode="input" name="r" label="R" disabled />);
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
  });

  test("two Rating inputs on a page do not share selection when names differ", () => {
    render(<><Rating mode="input" name="a" label="A" /><Rating mode="input" name="b" label="B" /></>);
    const [a3] = screen.getAllByRole("radio", { name: star(3) });
    const [, b5] = screen.getAllByRole("radio", { name: star(5) });
    fireEvent.click(a3!);
    fireEvent.click(b5!);
    expect(a3).toBeChecked();
    expect(b5).toBeChecked();
  });

  test("ref -> fieldset, className merged last", () => {
    const ref = createRef<HTMLFieldSetElement>();
    render(<Rating mode="input" name="r" label="R" ref={ref} className="mt-4" />);
    expect(ref.current?.tagName).toBe("FIELDSET");
    expect(ref.current?.className.endsWith("mt-4")).toBe(true);
  });

  test("type contract: input mode requires name + label; display requires value", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error name required in input mode */}
        <Rating mode="input" label="R" />
        {/* @ts-expect-error label required in input mode */}
        <Rating mode="input" name="r" />
        {/* @ts-expect-error value required in display mode */}
        <Rating />
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});
