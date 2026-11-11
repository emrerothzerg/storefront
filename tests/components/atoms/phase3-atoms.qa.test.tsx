// QA (QA-ATOMS-P3): Phase 3 atoms (T131 + atoms README) checked independently of
// the colocated implementer tests. Covers Card, CategoryTile, Button quick-add /
// outline / inverse / shape, Link button parity, Badge tones/emphasis/shape/size
// + presets, Price display="superscript", Input/SearchField variant="pill",
// Chip filled + trailing icon, Rating compact, QuantityStepper pill, plus
// cross-cutting source/markup scans (tokens only, 44px, focus, light only).
// Every rendered colour pair is resolved from its class names to the raw values
// in globals.css (./_palette) and its contrast recomputed; no colour value is
// written here. Defects are pinned with `test.failing` and a `// PIN:` tag.
import { describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { Badge, BADGE_PRESETS, type BadgeEmphasis, type BadgeTone } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import {
  BUTTON_SIZE,
  BUTTON_STATES,
  QUICK_ADD_PILL,
  buttonClassName,
} from "@/components/atoms/Button/button-classes";
import { Card, type CardTone } from "@/components/atoms/Card";
import { CategoryTile } from "@/components/atoms/CategoryTile";
import { Chip } from "@/components/atoms/Chip";
import { Input } from "@/components/atoms/Input";
import { Link, type LinkButtonVariant } from "@/components/atoms/Link";
import { Price } from "@/components/atoms/Price";
import { QuantityStepper } from "@/components/atoms/QuantityStepper";
import { Rating } from "@/components/atoms/Rating";
import { SearchField } from "@/components/atoms/SearchField";
import { expectFocused, expectNotNull, expectNull, expectSameNode } from "@/test/dom-assertions";
import { BODY, PALETTE, ROOT, ratio } from "./_palette";

const ATOMS = join(ROOT, "src/components/atoms");
const cls = (el: Element | null | undefined): string[] =>
  (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** Text a screen reader gets: textContent minus aria-hidden subtrees. */
function spokenText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return [...node.childNodes].map(spokenText).join("");
}
/** Text drawn on screen but hidden from AT: aria-hidden subtrees only. */
function hiddenText(node: Node): string {
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return node.textContent ?? "";
  return [...node.childNodes].map(hiddenText).join("");
}
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** Resolves an unprefixed `bg-*` / `text-*` utility to its palette token. */
function bgToken(list: string[]): string | null {
  const c = list.find((x) => /^bg-/.test(x) && x !== "bg-transparent");
  return c ? c.slice(3) : null;
}
function textToken(list: string[]): string | null {
  // "text-text-primary" -> "text-primary", "text-accent" -> "accent"; type steps
  // ("text-small") are not palette keys and are skipped.
  const c = list.find((x) => /^text-/.test(x) && PALETTE[x.slice(5)] !== undefined);
  return c ? c.slice(5) : null;
}
/** Contrast of the rendered text colour on the rendered fill (both from classes). */
function renderedRatio(list: string[]): number {
  const fg = textToken(list);
  const bg = bgToken(list);
  if (!fg || !bg) throw new Error(`no text/bg token pair in: ${list.join(" ")}`);
  return ratio(fg, bg);
}

/** Keyboard-reachable elements in sequential focus order (no positive tabindex allowed). */
function tabStops(root: ParentNode): Element[] {
  const all = [...root.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")];
  return all.filter((el) => {
    if ((el as HTMLButtonElement).disabled) return false;
    const ti = el.getAttribute("tabindex");
    return ti === null || Number(ti) >= 0;
  });
}
const stopName = (el: Element) =>
  `${el.tagName.toLowerCase()}:${el.getAttribute("aria-label") ?? el.getAttribute("name") ?? el.getAttribute("type") ?? ""}`;

// ======================================================================= Card
describe("Card", () => {
  const TONES: CardTone[] = ["raised", "sunken", "accent-subtle", "promo-subtle", "deal-subtle", "promo", "inverse"];

  test.each(TONES.map((t) => [t]))("tone=%s: one fill + one text colour, a verified AA pair (>= 4.5 recomputed)", (tone) => {
    const { container } = render(<Card tone={tone}>x</Card>);
    const list = cls(container.firstElementChild);
    expect(list.filter((c) => /^bg-/.test(c))).toHaveLength(1);
    expect(list.filter((c) => /^text-(text-|accent|deal)/.test(c))).toHaveLength(1);
    expect(renderedRatio(list)).toBeGreaterThanOrEqual(4.5);
  });

  test("defaults: div, raised, rounded-lg, soft border + shadow-sm, md padding", () => {
    const html = renderToStaticMarkup(<Card>x</Card>);
    expect(html).toBe(
      '<div class="relative min-w-0 rounded-lg bg-surface-raised text-text-primary border border-border-default shadow-sm p-4 sm:p-5">x</div>',
    );
  });

  test("non-raised tones: no border, no shadow by default; overrides honoured", () => {
    for (const tone of TONES.filter((t) => t !== "raised")) {
      const list = cls(render(<Card tone={tone}>x</Card>).container.firstElementChild);
      expect(list.some((c) => /^border|^shadow-/.test(c))).toBe(false);
    }
    const list = cls(render(<Card tone="sunken" bordered elevation="md" radius="xl" padding="none">x</Card>).container.firstElementChild);
    for (const c of ["border", "border-border-default", "shadow-md", "rounded-xl"]) expect(list).toContain(c);
    expect(list.some((c) => /^p-|^sm:p-|^md:p-/.test(c))).toBe(false);
  });

  test.each([["div"], ["article"], ["section"], ["li"], ["aside"]] as const)("as=%s renders that element", (as) => {
    const html = renderToStaticMarkup(as === "li" ? <ul><Card as={as}>x</Card></ul> : <Card as={as}>x</Card>);
    expect(html).toContain(`<${as} class="`);
  });

  test("never focusable itself; the link inside is the only tab stop (keyboard)", () => {
    const { container } = render(
      <Card as="article" interactive aria-labelledby="t">
        <a id="t" href="/p/lamp">Lamp</a>
      </Card>,
    );
    const card = container.firstElementChild!;
    expect(card.hasAttribute("tabindex")).toBe(false);
    expect(tabStops(container).map(stopName)).toEqual(["a:"]);
    const link = screen.getByRole("link", { name: "Lamp" });
    link.focus();
    expectFocused(link);
    expect(cls(card)).toContain("hover:shadow-md");
    expect(card.getAttribute("aria-labelledby")).toBe("t");
  });

  test("inverse tone carries the exact `bg-surface-inverse` class the white focus ring keys on", () => {
    const { container } = render(
      <Card tone="inverse">
        <Button variant="inverse">Sign up</Button>
      </Card>,
    );
    const btn = screen.getByRole("button", { name: "Sign up" });
    expectSameNode(btn.closest(".bg-surface-inverse"), container.firstElementChild);
    expect(BODY).toMatch(/\.bg-surface-inverse :focus-visible\s*\{\s*outline-color:\s*var\(--focus-ring-inverse\);/);
  });

  test("promo tone does NOT switch the ring (blue ring kept, >= 3:1 on gold)", () => {
    expect(BODY).not.toMatch(/\.bg-promo[^{]*:focus-visible/);
    expect(ratio("focus-ring", "promo")).toBeGreaterThanOrEqual(3);
  });

  test("className merged last; ref forwarded", () => {
    const ref = createRef<HTMLElement>();
    const { container } = render(<Card ref={ref} className="mt-4">x</Card>);
    expect(cls(container.firstElementChild).at(-1)).toBe("mt-4");
    expectSameNode(ref.current, container.firstElementChild);
  });
});

// =============================================================== CategoryTile
describe("CategoryTile", () => {
  test("one link, one tab stop, accessible name is exactly the label (image decorative)", () => {
    const { container } = render(<CategoryTile href="/category/kitchen" label="Kitchen" imageSrc="/images/x.jpg" />);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(tabStops(container)).toHaveLength(1);
    const link = screen.getByRole("link", { name: "Kitchen" });
    expect(link.getAttribute("href")).toBe("/category/kitchen");
    const img = container.querySelector("img");
    expectNotNull(img);
    expect(img!.getAttribute("alt")).toBe("");
    expect(spokenText(link).trim()).toBe("Kitchen");
    link.focus();
    expectFocused(link);
    expect(cls(link).some((c) => /outline-none|outline-0/.test(c))).toBe(false);
  });

  test("missing/blank src: placeholder is aria-hidden, still one named link", () => {
    for (const src of [null, undefined, "", "   "]) {
      const { container, unmount } = render(<CategoryTile href="/category/toys" label="Toys" imageSrc={src} />);
      const ph = container.querySelector("[data-placeholder]");
      expectNotNull(ph);
      expect(ph!.getAttribute("aria-hidden")).toBe("true");
      const link = screen.getByRole("link", { name: "Toys" });
      expect(spokenText(link)).toBe("Toys");
      expect(tabStops(container)).toHaveLength(1);
      unmount();
    }
  });

  // T181 (U12): sizes are responsive now (below md -> from md); the smallest width is still >= 44px.
  test.each([
    ["sm", ["w-16"], "64px", ["text-caption"], 64],
    ["md", ["w-20", "md:w-24"], "(min-width: 768px) 96px, 80px", ["text-small"], 80],
    ["lg", ["w-20", "md:w-32"], "(min-width: 768px) 128px, 80px", ["text-small", "md:text-body"], 80],
  ] as const)("size=%s: %p wide (>= 44px target), image sizes=%s, label %p", (size, w, sizes, text, px) => {
    const { container } = render(<CategoryTile href="/category/toys" label="Garden" imageSrc="/images/i.jpg" size={size} />);
    const link = container.querySelector("a")!;
    expect(cls(link)).toEqual(expect.arrayContaining([...w]));
    expect(px).toBeGreaterThanOrEqual(44);
    expect(container.querySelector("img")!.getAttribute("sizes")).toBe(sizes);
    expect(cls(link.lastElementChild)).toEqual(expect.arrayContaining([...text]));
  });

  test("default md + circle; rounded/card = rounded-lg; exactly one radius on the image frame", () => {
    const frame = (shape?: "circle" | "rounded" | "card") => {
      const { container, unmount } = render(<CategoryTile href="/category/toys" label="L" imageSrc="/images/i.jpg" shape={shape} />);
      const list = cls(container.querySelector("a")!.firstElementChild);
      unmount();
      return list;
    };
    for (const [shape, radius, aspect] of [
      [undefined, "rounded-full", "aspect-square"],
      ["circle", "rounded-full", "aspect-square"],
      ["rounded", "rounded-lg", "aspect-square"],
      ["card", "rounded-lg", "aspect-4/5"],
    ] as const) {
      const list = frame(shape);
      expect(list).toContain(radius);
      expect(list.filter((c) => /^rounded-/.test(c))).toEqual([radius]);
      expect(list).toContain(aspect);
      expect(list).toContain("overflow-hidden");
    }
  });

  test("lazy by default, eager + high priority with `priority`", () => {
    const lazy = renderToStaticMarkup(<CategoryTile href="/category/toys" label="A" imageSrc="/images/i.jpg" />);
    const eager = renderToStaticMarkup(<CategoryTile href="/category/toys" label="A" imageSrc="/images/i.jpg" priority />);
    expect(lazy).toContain('loading="lazy"');
    expect(eager).toContain('loading="eager"');
    expect(eager.toLowerCase()).toContain('fetchpriority="high"');
  });

  test("hostile label is escaped and still the name", () => {
    const label = `<script>alert(1)</script> & "Kids" ${"x".repeat(120)}`;
    const html = renderToStaticMarkup(<CategoryTile href="/category/toys" label={label} imageSrc="/images/i.jpg" />);
    expect(html).not.toContain("<script>");
    render(<CategoryTile href="/category/toys" label={label} imageSrc="/images/i.jpg" />);
    expect(screen.getByRole("link").textContent).toBe(label);
  });

  test("unsafe or unknown hrefs render '#' (one link kept), allowed routes pass through", () => {
    const orig = console.warn;
    console.warn = mock();
    try {
      for (const bad of ["javascript:alert(1)", "https://evil.example", "//evil.example", "", "/no-such-route/x"]) {
        const html = renderToStaticMarkup(<CategoryTile href={bad} label="L" imageSrc="/images/i.jpg" />);
        expect(html).toContain('href="#"');
        expect(html.match(/<a /g)?.length).toBe(1);
      }
    } finally {
      console.warn = orig;
    }
    expect(renderToStaticMarkup(<CategoryTile href="/category/toys" label="L" imageSrc={null} />)).toContain('href="/category/toys"');
  });

  test("44px minimum on the link itself (min-h-touch + min-w-touch) for every size and shape", () => {
    for (const shape of ["circle", "rounded", "card"] as const) {
      for (const size of ["sm", "md", "lg"] as const) {
        const html = renderToStaticMarkup(<CategoryTile href="/category/toys" label="L" imageSrc={null} shape={shape} size={size} />);
        const link = html.match(/<a class="([^"]*)"/)?.[1]?.split(" ") ?? [];
        expect(link).toContain("min-h-touch");
        expect(link).toContain("min-w-touch");
      }
    }
  });

  // D-T131-4 FIXED (designer addendum; verified by T147). Was: the link sets `focus-visible:outline-focus-ring` (utilities
  // layer), which beats the base-layer `.bg-surface-inverse :focus-visible`
  // white-ring rule, so on a dark band the tile keeps the blue ring (3.43:1)
  // instead of the documented automatic white ring.
  test("inside a dark band the tile does not pin the blue ring colour (white ring applies)", () => {
    render(
      <Card tone="inverse">
        <CategoryTile href="/category/toys" label="Toys" imageSrc={null} />
      </Card>,
    );
    const link = screen.getByRole("link", { name: "Toys" });
    expectNotNull(link.closest(".bg-surface-inverse"));
    expect(cls(link).filter((c) => /^focus-visible:outline-(focus-ring|text|accent)/.test(c))).toEqual([]);
  });

  test("label text on page and on a sunken band meets 4.5 (recomputed)", () => {
    const { container } = render(<CategoryTile href="/category/toys" label="L" imageSrc="/images/i.jpg" />);
    const link = container.querySelector("a")!;
    expect(cls(link)).toContain("text-text-primary");
    expect(ratio("text-primary", "surface-page")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("text-primary", "surface-sunken")).toBeGreaterThanOrEqual(4.5);
  });
});

// ===================================================================== Button
describe("Button quick-add", () => {
  test("44px transparent hit area around a small accent pill; name from aria-label", () => {
    render(<Button variant="quick-add" aria-label="Add Desk lamp to cart" />);
    const btn = screen.getByRole("button", { name: "Add Desk lamp to cart" });
    const outer = cls(btn);
    for (const c of ["min-h-touch", "min-w-touch", "p-0", "bg-transparent", "rounded-full"]) expect(outer).toContain(c);
    expect(outer.some((c) => /^p[xytblrse]-/.test(c))).toBe(false);
    const pill = btn.querySelector('[data-slot="quick-add-pill"]');
    expectNotNull(pill);
    const p = cls(pill);
    for (const c of ["rounded-full", "bg-accent", "text-text-on-accent"]) expect(p).toContain(c);
    expect(renderedRatio(p)).toBeGreaterThanOrEqual(4.5);
    // visible text "Add", plus icon decorative
    expect(pill!.textContent).toBe("Add");
    const svg = pill!.querySelector("svg");
    expectNotNull(svg);
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  test("without aria-label the name falls back to the visible 'Add' (README asks callers to name it)", () => {
    render(<Button variant="quick-add" />);
    expectNotNull(screen.getByRole("button", { name: "Add" }));
  });

  test.each([["sm"], ["md"], ["lg"]] as const)("size=%s: pill classes from QUICK_ADD_PILL, outer keeps 44px and no padding", (size) => {
    render(<Button variant="quick-add" size={size} aria-label="Add x" />);
    const btn = screen.getByRole("button", { name: "Add x" });
    expect(btn.querySelector('[data-slot="quick-add-pill"]')!.getAttribute("class")).toBe(QUICK_ADD_PILL[size]);
    expect(cls(btn)).toContain("min-h-touch");
    expect(cls(btn)).toContain("min-w-touch");
    // pill text >= 12px: caption is the smallest step used
    expect(/text-(caption|small|body)\b/.test(QUICK_ADD_PILL[size])).toBe(true);
  });

  test("shape is ignored: quick-add is always a pill", () => {
    render(<Button variant="quick-add" shape="rounded" padding="none" aria-label="Add y" />);
    const list = cls(screen.getByRole("button", { name: "Add y" }));
    expect(list.filter((c) => /^rounded-/.test(c))).toEqual(["rounded-full"]);
  });

  test("keyboard: focusable native button; Enter/Space activation = click", () => {
    const onClick = mock();
    render(<Button variant="quick-add" aria-label="Add z" onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "Add z" });
    btn.focus();
    expectFocused(btn);
    expect(btn.getAttribute("type")).toBe("button");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("loading: spinner replaces the plus, aria-busy + aria-disabled, clicks swallowed, still focusable", () => {
    const onClick = mock();
    render(<Button variant="quick-add" aria-label="Add w" loading onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "Add w" });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.hasAttribute("disabled")).toBe(false);
    expectNotNull(btn.querySelector('[role="status"]'));
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    btn.focus();
    expectFocused(btn);
  });

  test("disabled: native disabled attribute; type=submit passes through for no-JS forms", () => {
    render(
      <form action="/cart/add" method="post">
        <Button variant="quick-add" type="submit" aria-label="Add a" />
        <Button variant="quick-add" disabled aria-label="Add b" />
      </form>,
    );
    expect(screen.getByRole("button", { name: "Add a" }).getAttribute("type")).toBe("submit");
    expect(screen.getByRole("button", { name: "Add b" }).hasAttribute("disabled")).toBe(true);
  });

  // D-T131-1 ACCEPTED BY RULING (STATE.md "Rulings on QA-ATOMS-P3", AC2 amended): `variant="quick-add"`
  // IS the compact "+ Add" pill; no `size="compact"` is added. The test now pins the ruling: sizes stay
  // sm/md/lg, quick-add exists for every size with a visible pill and a 44px outer hit area.
  test('accepted: the compact "+ Add" pill is variant="quick-add" (no size="compact")', () => {
    expect(Object.keys(BUTTON_SIZE.default).sort()).toEqual(["lg", "md", "sm"]);
    for (const size of ["sm", "md", "lg"] as const) {
      const { container, unmount } = render(<Button variant="quick-add" size={size} aria-label="Add to cart: x">Add</Button>);
      const btn = container.querySelector("button");
      for (const c of ["min-h-touch", "min-w-touch", "rounded-full"]) expect({ size, c, has: cls(btn).includes(c) }).toEqual({ size, c, has: true });
      expect(btn?.querySelector('[data-slot="quick-add-pill"]')?.getAttribute("class")).toBe(QUICK_ADD_PILL[size]);
      unmount();
    }
  });
});

describe("Button outline / inverse / shape", () => {
  test("outline: accent border + accent text on white, pill; AA recomputed", () => {
    render(<Button variant="outline">Shop beauty</Button>);
    const list = cls(screen.getByRole("button", { name: "Shop beauty" }));
    for (const c of ["border", "border-accent", "bg-surface-raised", "text-accent", "rounded-full"]) expect(list).toContain(c);
    expect(renderedRatio(list)).toBeGreaterThanOrEqual(4.5);
    expect(ratio("accent", "surface-page")).toBeGreaterThanOrEqual(3); // boundary
  });

  test("inverse: white pill with near-black text, fill >= 3:1 against the dark band", () => {
    render(<Button variant="inverse">Join</Button>);
    const list = cls(screen.getByRole("button", { name: "Join" }));
    for (const c of ["bg-surface-raised", "text-text-primary", "rounded-full"]) expect(list).toContain(c);
    expect(renderedRatio(list)).toBeGreaterThanOrEqual(4.5);
    expect(ratio("surface-raised", "surface-inverse")).toBeGreaterThanOrEqual(3);
  });

  test("every variant except quick-add: exactly one radius, pill by default, rounded-md with shape=rounded", () => {
    for (const variant of ["primary", "secondary", "ghost", "danger", "outline", "inverse"] as const) {
      const pill = cls(render(<Button variant={variant}>p</Button>).container.querySelector("button"));
      expect(pill.filter((c) => /^rounded-/.test(c))).toEqual(["rounded-full"]);
      const rounded = cls(render(<Button variant={variant} shape="rounded">r</Button>).container.querySelector("button"));
      expect(rounded.filter((c) => /^rounded-/.test(c))).toEqual(["rounded-md"]);
      document.body.innerHTML = "";
    }
  });

  test("padding=none defaults to rounded (thumbnails); explicit shape=pill wins", () => {
    render(
      <>
        <Button padding="none" aria-label="t1">i</Button>
        <Button padding="none" shape="pill" aria-label="t2">i</Button>
      </>,
    );
    expect(cls(screen.getByRole("button", { name: "t1" })).filter((c) => /^rounded-/.test(c))).toEqual(["rounded-md"]);
    expect(cls(screen.getByRole("button", { name: "t2" })).filter((c) => /^rounded-/.test(c))).toEqual(["rounded-full"]);
  });

  test("every variant/size keeps min-h-touch + min-w-touch and never removes the outline", () => {
    for (const variant of ["primary", "secondary", "ghost", "danger", "outline", "inverse", "quick-add"] as const) {
      for (const size of ["sm", "md", "lg"] as const) {
        const list = buttonClassName({ variant, size }).split(" ");
        expect(list).toContain("min-h-touch");
        expect(list).toContain("min-w-touch");
        expect(list.some((c) => /outline-none|outline-0|ring-0/.test(c))).toBe(false);
      }
    }
  });
});

// ======================================================================= Link
describe("Link variant=button parity with Button", () => {
  const VARIANTS: LinkButtonVariant[] = ["primary", "secondary", "outline", "inverse"];
  const states = new Set(BUTTON_STATES.split(" "));

  test.each(VARIANTS.flatMap((v) => (["sm", "md", "lg"] as const).map((s) => [v, s] as const)))(
    "buttonVariant=%s buttonSize=%s: Button's classes minus <button>-only states, plus no-underline",
    (variant, size) => {
      render(
        <>
          <Link href="/x" variant="button" buttonVariant={variant} buttonSize={size}>Go</Link>
          <Button variant={variant} size={size}>Go</Button>
        </>,
      );
      const link = cls(screen.getByRole("link", { name: "Go" }));
      const btn = cls(screen.getByRole("button", { name: "Go" })).filter((c) => !states.has(c));
      expect(link).toEqual([...btn, "no-underline", "hover:no-underline"]);
    },
  );

  test("default buttonVariant/buttonSize = primary/md pill", () => {
    render(<Link href="/x" variant="button">Shop now</Link>);
    const list = cls(screen.getByRole("link", { name: "Shop now" }));
    expect(list).toContain("bg-accent");
    expect(list).toContain("rounded-full");
    expect(list).toContain("px-4");
  });

  test("inverse button link inside a dark Card gets the white ring rule; external keeps new-tab text", () => {
    render(
      <Card tone="inverse">
        <Link href="https://example.org" external variant="button" buttonVariant="inverse">Help</Link>
      </Card>,
    );
    const link = screen.getByRole("link", { name: /Help/ });
    expectNotNull(link.closest(".bg-surface-inverse"));
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.textContent).toBe("Help (opens in new tab)");
  });

  test("type level: actions-only looks (ghost, danger, quick-add) are not link looks", () => {
    // @ts-expect-error links are navigation; quick-add is an action
    const a = <Link href="/x" variant="button" buttonVariant="quick-add">x</Link>;
    // @ts-expect-error danger is an action look
    const b = <Link href="/x" variant="button" buttonVariant="danger">x</Link>;
    void a;
    void b;
    expect(true).toBe(true);
  });
});

// ====================================================================== Badge
describe("Badge tones, emphasis, shape, size, presets", () => {
  const TONES: BadgeTone[] = ["neutral", "success", "warning", "danger", "info", "accent", "promo", "deal"];
  const EMPH: BadgeEmphasis[] = ["subtle", "solid"];

  test.each(TONES.flatMap((t) => EMPH.map((e) => [t, e] as const)))("%s/%s: text present, one fill + one text colour, AA recomputed", (tone, emphasis) => {
    const { container } = render(<Badge tone={tone} emphasis={emphasis}>Label</Badge>);
    const el = container.firstElementChild!;
    expect(el.textContent).toBe("Label");
    const list = cls(el);
    expect(list.filter((c) => /^bg-/.test(c))).toHaveLength(1);
    expect(renderedRatio(list)).toBeGreaterThanOrEqual(4.5);
    // gold fill never carries white text
    if (tone === "promo") expect(list).toContain("text-text-primary");
  });

  test("size sm = caption (12px, T131 AC5 >= 12px) by default; md = small", () => {
    const sm = cls(render(<Badge tone="deal">S</Badge>).container.firstElementChild);
    const md = cls(render(<Badge tone="deal" size="md">M</Badge>).container.lastElementChild);
    expect(sm).toContain("text-caption");
    expect(md).toContain("text-small");
    expect(BODY).toMatch(/--text-caption:\s*0\.75rem;/); // 12px
  });

  test("shape: square (rounded-sm) default, pill = rounded-full; exactly one radius", () => {
    const sq = cls(render(<Badge tone="info">A</Badge>).container.firstElementChild);
    const pl = cls(render(<Badge tone="info" shape="pill">B</Badge>).container.lastElementChild);
    expect(sq.filter((c) => /^rounded-/.test(c))).toEqual(["rounded-sm"]);
    expect(pl.filter((c) => /^rounded-/.test(c))).toEqual(["rounded-full"]);
  });

  test.each([
    ["new", "bg-promo", "text-text-primary"],
    ["onlineOnly", "bg-accent-subtle", "text-accent"],
    ["deal", "bg-deal", "text-text-on-accent"],
    ["highlight", "bg-surface-inverse", "text-text-inverse"],
  ] as const)("preset %s spreads into props: %s + %s, text visible", (preset, bg, text) => {
    const { container } = render(<Badge {...BADGE_PRESETS[preset]}>Text</Badge>);
    const list = cls(container.firstElementChild);
    expect(list).toContain(bg);
    expect(list).toContain(text);
    expect(container.textContent).toBe("Text");
  });

  test("empty / whitespace text renders nothing (never colour-only) with one warning each", () => {
    const warn = mock();
    const orig = console.warn;
    console.warn = warn;
    try {
      expect(renderToStaticMarkup(<Badge tone="deal">{""}</Badge>)).toBe("");
      expect(renderToStaticMarkup(<Badge tone="deal" emphasis="solid">{"   "}</Badge>)).toBe("");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      console.warn = orig;
    }
  });

  test("icon is decorative (aria-hidden); spoken text is the label only", () => {
    const { container } = render(<Badge tone="deal" icon={<svg />}>Save 20%</Badge>);
    expect(container.querySelector("[aria-hidden='true']")?.querySelector("svg") ? "ok" : "missing").toBe("ok");
    expect(spokenText(container).trim()).toBe("Save 20%");
  });
});

// ====================================================================== Price
describe('Price display="superscript"', () => {
  const sup = (cents: number, extra: Record<string, unknown> = {}) =>
    render(<Price amountCents={cents} display="superscript" {...extra} />).container;

  test.each([
    [0, "$0.00", "$0"],
    [5, "$0.05", "$005"],
    [99, "$0.99", "$099"],
    [100, "$1.00", "$1"],
    [550, "$5.50", "$550"],
    [1999, "$19.99", "$1999"],
    [100000, "$1,000.00", "$1,000"],
  ] as const)("%d cents: spoken %s exactly once; visual %s is aria-hidden", (cents, spoken, visual) => {
    const c = sup(cents);
    expect(spokenText(c)).toBe(spoken);
    expect(count(c.textContent ?? "", spoken)).toBe(1);
    expect(hiddenText(c)).toBe(visual);
  });

  test(".00 is dropped visually only (README); non-zero cents keep both digits", () => {
    const whole = sup(1000);
    expect(hiddenText(whole)).toBe("$10");
    expect(spokenText(whole)).toBe("$10.00");
    const tenCents = sup(1010);
    expect(hiddenText(tenCents)).toBe("$1010");
    expect(spokenText(tenCents)).toBe("$10.10");
  });

  test("inside a link the accessible name carries $5.50, never the run-together 550", () => {
    render(
      <a href="/p/lamp">
        Lamp <Price amountCents={550} display="superscript" />
      </a>,
    );
    const link = screen.getByRole("link", { name: /\$5\.50/ });
    expect(spokenText(link)).toBe("Lamp $5.50");
    expect(/\$550|5 50/.test(spokenText(link))).toBe(false);
  });

  test('sale: "Now $5.50" and "Was $19.00" each spoken exactly once; old price struck through', () => {
    const c = sup(550, { compareAtCents: 1900 });
    const spoken = spokenText(c);
    expect(count(spoken, "$5.50")).toBe(1);
    expect(count(spoken, "Was $19.00")).toBe(1);
    expect(count(spoken, "$19.00")).toBe(1);
    expect(spoken).toBe("Now $5.50Was $19.00");
    const s = c.querySelector("s");
    expectNotNull(s);
    expect(s!.textContent).toBe("Was $19.00");
    expect(cls(s)).toContain("text-text-secondary");
  });

  test("list price equal or lower: no strike-through, no Now/Was", () => {
    for (const compare of [550, 500, 0]) {
      const c = sup(550, { compareAtCents: compare });
      expectNull(c.querySelector("s"));
      expect(spokenText(c)).toBe("$5.50");
      document.body.innerHTML = "";
    }
  });

  test("invalid input renders nothing and never throws (negative, fraction, NaN, Infinity, bad currency)", () => {
    const orig = console.warn;
    console.warn = mock();
    try {
      for (const cents of [-1, -550, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(renderToStaticMarkup(<Price amountCents={cents} display="superscript" />)).toBe("");
      }
      expect(renderToStaticMarkup(<Price amountCents={550} display="superscript" currency="NOPE" />)).toBe("");
      expect(renderToStaticMarkup(<Price amountCents={550} compareAtCents={-1} display="superscript" />)).toBe("");
    } finally {
      console.warn = orig;
    }
  });

  test('tone="deal" colours only the current price; deal text AA on every surface (recomputed)', () => {
    const c = sup(550, { compareAtCents: 1900, tone: "deal" });
    const current = c.firstElementChild!.firstElementChild!;
    expect(cls(current)).toContain("text-deal");
    expect(cls(c.querySelector("s"))).not.toContain("text-deal");
    for (const s of ["surface-page", "surface-raised", "surface-sunken"]) expect(ratio("deal", s)).toBeGreaterThanOrEqual(4.5);
  });

  test("zero-decimal currency: no cents part at all", () => {
    const c = sup(500, { currency: "JPY" });
    expect(spokenText(c)).toBe("¥500");
    expect(hiddenText(c)).toBe("¥500");
  });

  // D-T131-2 ACCEPTED BY RULING (STATE.md "Rulings on QA-ATOMS-P3", R11 amended): the flex superscript
  // (aria-hidden visual, raised with `items-start`) is the spec as long as the screen-reader text is the
  // full amount; dropping ".00" visually IS the product spec. Pinned: one sr-only full amount, an
  // aria-hidden visual, no <sup> required, ".00" dropped only visually.
  test("accepted: flex superscript with an aria-hidden visual and the full amount as SR text; .00 dropped visually", () => {
    for (const [cents, spoken, visual] of [[550, "$5.50", "$550"], [1000, "$10.00", "$10"], [0, "$0.00", "$0"]] as const) {
      const c = sup(cents);
      const visualEl = c.querySelector('[data-slot="price-superscript"]');
      expect(visualEl?.getAttribute("aria-hidden")).toBe("true");
      expect(cls(visualEl)).toContain("items-start");
      expect([...c.querySelectorAll(".sr-only")].map((e) => e.textContent)).toEqual([spoken]);
      expect(spokenText(c)).toBe(spoken);
      expect(hiddenText(c)).toBe(visual);
      document.body.innerHTML = "";
    }
  });
});

// ============================================================ Input / Search
describe('Input / SearchField variant="pill"', () => {
  test("Input pill: rounded-full sunken 48px field that keeps the border-strong boundary; invalid -> danger", () => {
    render(
      <>
        <label htmlFor="a">Find</label>
        <Input id="a" variant="pill" />
        <label htmlFor="b">Bad</label>
        <Input id="b" variant="pill" invalid />
      </>,
    );
    const a = cls(screen.getByLabelText("Find"));
    for (const c of ["rounded-full", "bg-surface-sunken", "border", "border-border-strong", "min-h-12"]) expect(a).toContain(c);
    expect(a.filter((c) => /^rounded-/.test(c))).toEqual(["rounded-full"]);
    const b = screen.getByLabelText("Bad");
    expect(b.getAttribute("aria-invalid")).toBe("true");
    expect(cls(b)).toContain("border-danger");
    expect(ratio("border-strong", "surface-sunken")).toBeGreaterThanOrEqual(3);
    expect(ratio("danger", "surface-sunken")).toBeGreaterThanOrEqual(3);
  });

  test("Input default variant unchanged (rounded-md, raised)", () => {
    render(<><label htmlFor="d">D</label><Input id="d" /></>);
    const list = cls(screen.getByLabelText("D"));
    expect(list).toContain("rounded-md");
    expect(list).toContain("bg-surface-raised");
  });

  test("no-JS server markup: GET form to /search, name=q, label for=id, submit inside the form, named landmark", () => {
    const html = renderToStaticMarkup(<SearchField variant="pill" inputId="s1" placeholder="Find products" />);
    expect(html).toMatch(/<form[^>]*role="search"/);
    expect(html).toMatch(/<form[^>]*aria-label="Site search"/);
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).toMatch(/<form[^>]*action="\/search"/);
    expect(html).toContain('<label for="s1"');
    expect(html).toMatch(/<input[^>]*name="q"/);
    expect(html).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*aria-label="Submit search")[^>]*>/);
    expect(html.indexOf('type="submit"')).toBeLessThan(html.indexOf("</form>"));
    // no combobox semantics before hydration
    expect(html).not.toContain('role="combobox"');
  });

  test("hydrated ARIA: combobox with aria-expanded/aria-controls, same as the default variant", () => {
    const attrs = (variant: "default" | "pill") => {
      const { unmount } = render(<SearchField variant={variant} inputId={`id-${variant}`} />);
      const input = screen.getByRole("combobox", { name: "Search" });
      const out = [input.getAttribute("aria-autocomplete"), input.getAttribute("aria-expanded"), input.hasAttribute("aria-controls")];
      unmount();
      return out;
    };
    expect(attrs("pill")).toEqual(attrs("default"));
    expect(attrs("pill")).toEqual(["list", "false", true]);
  });

  test("Tab order unchanged vs the default variant (empty and with a value); no positive tabindex", () => {
    const order = (variant: "default" | "pill", typed: boolean) => {
      const { container, unmount } = render(<SearchField variant={variant} />);
      if (typed) fireEvent.change(screen.getByRole("combobox"), { target: { value: "lamp" } });
      const stops = tabStops(container).map(stopName);
      expect([...container.querySelectorAll("[tabindex]")].some((e) => Number(e.getAttribute("tabindex")) > 0)).toBe(false);
      unmount();
      return stops;
    };
    expect(order("pill", false)).toEqual(order("default", false));
    expect(order("pill", true)).toEqual(order("default", true));
    expect(order("pill", true)).toEqual(["input:q", "button:Clear search", "button:Submit search"]);
  });

  test("pill submit and clear buttons are 44px (size-touch) and round", () => {
    render(<SearchField variant="pill" />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "x" } });
    for (const name of ["Submit search", "Clear search"]) {
      const list = cls(screen.getByRole("button", { name }));
      expect(list).toContain("size-touch");
      expect(list).toContain("rounded-full");
    }
  });
});

// ======================================================================= Chip
describe('Chip variant="filled" + trailing icon', () => {
  test("filled: borderless grey pill, 44px tall, hover on border-default; AA recomputed", () => {
    render(<Chip as="a" href="/search?q=lego" label="Lego" variant="filled" />);
    const list = cls(screen.getByRole("link", { name: "Lego" }));
    for (const c of ["rounded-full", "min-h-touch", "border-transparent", "bg-surface-sunken", "text-text-primary", "hover:bg-border-default"]) {
      expect(list).toContain(c);
    }
    expect(renderedRatio(list)).toBeGreaterThanOrEqual(4.5);
    expect(ratio("text-primary", "border-default")).toBeGreaterThanOrEqual(4.5);
  });

  test("trailingIcon is decorative: name stays exactly the label, svg aria-hidden", () => {
    render(<Chip as="a" href="/search?q=lego" label="Lego" variant="filled" trailingIcon="search" />);
    const link = screen.getByRole("link", { name: "Lego" });
    const svgs = [...link.querySelectorAll("svg")];
    expect(svgs).toHaveLength(1);
    expect(svgs[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(spokenText(link)).toBe("Lego");
  });

  test("filled + selected: accent look with check icon (not colour alone), aria-current=true", () => {
    render(<Chip as="a" href="?b=1" label="Acme" variant="filled" selected trailingIcon="search" />);
    const link = screen.getByRole("link", { name: "Acme" });
    const list = cls(link);
    expect(list).toContain("bg-accent-subtle");
    expect(list).toContain("border-accent");
    expect(link.getAttribute("aria-current")).toBe("true");
    expect(link.querySelectorAll("svg")).toHaveLength(2);
  });

  test("filled toggle button: aria-pressed, keyboard focus; removable keeps a named 44px remove button", () => {
    const onToggle = mock();
    render(
      <>
        <Chip label="Red" variant="filled" onToggle={onToggle} />
        <Chip as="span" label="Blue" variant="filled" onRemove={() => {}} />
      </>,
    );
    const b = screen.getByRole("button", { name: "Red" });
    expect(b.getAttribute("aria-pressed")).toBe("false");
    b.focus();
    expectFocused(b);
    fireEvent.click(b);
    expect(onToggle).toHaveBeenCalledTimes(1);
    const rm = cls(screen.getByRole("button", { name: "Remove Blue" }));
    expect(rm.some((c) => c === "size-touch" || c === "min-h-touch")).toBe(true);
  });
});

describe("Card tone=accent (designer request by) and Chip title? (bu)", () => {
  test('Card tone="accent": solid accent band, on-accent text >= 4.5, descendants get the white focus ring', () => {
    const { container } = render(<Card tone="accent"><a href="/deals">Deals</a></Card>);
    const card = container.firstElementChild;
    const list = cls(card);
    for (const c of ["bg-accent", "text-text-on-accent", "**:focus-visible:outline-focus-ring-inverse"]) expect(list).toContain(c);
    expect(ratio("text-on-accent", "accent")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("focus-ring-inverse", "accent")).toBeGreaterThanOrEqual(3);
  });

  test("Chip title: set when non-blank (as text), omitted when blank; label unchanged", () => {
    const hostile = '<b onmouseover="x">full</b>';
    const { container, unmount } = render(<Chip as="a" href="/search?q=s" label="Short" title={hostile} />);
    const withTitle = container.querySelector("[title]");
    expect(withTitle?.getAttribute("title")).toBe(hostile);
    expect(container.querySelector("b, [onmouseover]")).toBeNull();
    expect(container.textContent).toContain("Short");
    unmount();
    const blank = render(<Chip as="a" href="/search?q=s" label="Short" title="   " />);
    expect(blank.container.querySelector("[title]")).toBeNull();
  });
});

describe("Chip 44px width", () => {
  // D-T131-3 FIXED (designer addendum; verified by T147). Was: Chip pills set min-h-touch but no min-w-touch, so a short
  // label ("S", "XL", "4+") gives a hit area narrower than 44px (README
  // touch-target rule: "Every interactive atom ... at least 44 x 44 px").
  test("every Chip variant carries min-w-touch", () => {
    for (const variant of ["outline", "filled"] as const) {
      const { container, unmount } = render(<Chip as="a" href="/search?q=s" label="S" variant={variant} />);
      expect(cls(container.querySelector("a"))).toContain("min-w-touch");
      unmount();
    }
  });
});

// ===================================================================== Rating
describe('Rating variant="compact"', () => {
  test("one star + '4.6' + '(84)' visible; spoken once as '4.6 out of 5 stars, 84 ratings'", () => {
    const { container } = render(<Rating value={4.6} count={84} variant="compact" size="sm" />);
    const stars = container.querySelector('[data-testid="rating-stars"]')!;
    expect(stars.querySelectorAll("svg")).toHaveLength(1);
    expect(stars.getAttribute("aria-hidden")).toBe("true");
    expect(hiddenText(container)).toBe("4.6(84)");
    expect(spokenText(container)).toBe("4.6 out of 5 stars, 84 ratings");
    expect(cls(stars)).toContain("text-rating");
  });

  test("full variant still draws five stars", () => {
    const { container } = render(<Rating value={4.6} count={84} />);
    expect(container.querySelector('[data-testid="rating-stars"]')!.querySelectorAll("svg")).toHaveLength(5);
  });

  test("edge values: clamp above 5, NaN/negative never print NaN; no count -> no brackets", () => {
    for (const v of [7, -2, Number.NaN]) {
      const { container, unmount } = render(<Rating value={v} variant="compact" />);
      const text = container.textContent ?? "";
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("(");
      expect(Number(hiddenText(container))).toBeGreaterThanOrEqual(0);
      expect(Number(hiddenText(container))).toBeLessThanOrEqual(5);
      unmount();
    }
  });

  test("singular count and big counts are formatted", () => {
    const one = render(<Rating value={5} count={1} variant="compact" />).container;
    expect(spokenText(one)).toBe("5 out of 5 stars, 1 rating");
    document.body.innerHTML = "";
    const big = render(<Rating value={4} count={12345} variant="compact" />).container;
    expect(hiddenText(big)).toBe("4.0(12,345)");
  });
});

// ============================================================ QuantityStepper
describe("QuantityStepper pill", () => {
  test("pill group with a border-strong boundary; 44px round-ended buttons; Tab order dec, input, inc", () => {
    const { container } = render(<QuantityStepper id="q" value={2} max={5} onChange={() => {}} name="qty" />);
    const group = screen.getByRole("group", { name: "Quantity" });
    for (const c of ["rounded-full", "border", "border-border-strong", "bg-surface-raised"]) expect(cls(group)).toContain(c);
    const dec = cls(screen.getByRole("button", { name: "Decrease quantity" }));
    const inc = cls(screen.getByRole("button", { name: "Increase quantity" }));
    expect(dec).toContain("size-touch");
    expect(dec).toContain("rounded-l-full");
    expect(inc).toContain("size-touch");
    expect(inc).toContain("rounded-r-full");
    expect(cls(screen.getByRole("textbox", { name: "Quantity" }))).toContain("min-h-touch");
    expect(tabStops(container).map(stopName)).toEqual([
      "button:Decrease quantity",
      "input:qty",
      "button:Increase quantity",
    ]);
    expect(ratio("border-strong", "surface-page")).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================== cross-cutting
const P3_FOLDERS = ["Button", "Link", "Card", "CategoryTile", "Badge", "Price", "Input", "SearchField", "Chip", "Rating", "QuantityStepper"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("cross-cutting: Phase 3 atom sources", () => {
  const files = P3_FOLDERS.flatMap((f) => sourceFiles(join(ATOMS, f)));
  const scan = (re: RegExp) =>
    files.flatMap((p) =>
      readFileSync(p, "utf8")
        .split("\n")
        .map((line, i) => ({ p, i, line }))
        .filter(({ line }) => re.test(line))
        .map(({ p, i, line }) => `${p.slice(ATOMS.length + 1)}:${i + 1}: ${line.trim()}`),
    );

  test("sources found", () => {
    expect(files.length).toBeGreaterThanOrEqual(P3_FOLDERS.length);
  });
  test("no hardcoded colours (hex, rgb(), hsl(), oklch())", () => {
    expect(scan(/\x23[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/)).toEqual([]);
  });
  test("no Tailwind arbitrary values in class strings", () => {
    expect(scan(/["'`\s](?:[a-z-]+:)*-?[a-z][a-z0-9-]*-\[[^\]]+\]/)).toEqual([]);
  });
  test("no inline style objects", () => {
    expect(scan(/style=\{\{/)).toEqual([]);
  });
  test("no focus-outline removal", () => {
    expect(scan(/outline-none|focus:outline-0|focus-visible:outline-0|ring-0/)).toEqual([]);
  });
  test("no `any`, no @ts-ignore / @ts-nocheck", () => {
    expect(scan(/:\s*any\b|\bas any\b|<any>|@ts-ignore|@ts-nocheck/)).toEqual([]);
  });

  test("light only: no dark:, data-theme or prefers-color-scheme anywhere in atoms (incl. tests and README)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|md|css)$/.test(name) && !/tokens\.phase3\.test\.ts$/.test(name)) {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/(^|[\s"'`:])dark:|data-theme|prefers-color-scheme/.test(line)) hits.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk(ATOMS);
    // The README states the rule in prose ("no `prefers-color-scheme` block,
    // no `data-theme` attribute ... no `dark:` utilities"): allow only lines
    // that negate it, as tests/redesign/guards.test.ts does.
    const real = hits.filter((h) => {
      const [file, ln] = [h.slice(0, h.lastIndexOf(":")), Number(h.slice(h.lastIndexOf(":") + 1))];
      const line = readFileSync(file, "utf8").split("\n")[ln - 1] ?? "";
      return !(file.endsWith(".md") && /\bno\b|\bnot\b|\bnever\b/i.test(line));
    });
    expect(real).toEqual([]);
  });
});

describe("cross-cutting: rendered markup of the new variants", () => {
  const SAMPLES = [
    <Card key="1" tone="promo" interactive>c</Card>,
    <Card key="2" tone="inverse">c</Card>,
    <CategoryTile key="3" href="/category/toys" label="L" imageSrc="/images/i.jpg" shape="rounded" size="lg" />,
    <Button key="4" variant="quick-add" aria-label="Add">x</Button>,
    <Button key="5" variant="outline" shape="rounded">x</Button>,
    <Button key="6" variant="inverse">x</Button>,
    <Link key="7" href="/x" variant="button" buttonVariant="outline">x</Link>,
    <Badge key="8" {...BADGE_PRESETS.new} shape="pill" size="md">New</Badge>,
    <Price key="9" amountCents={550} compareAtCents={900} display="superscript" tone="deal" size="h2" />,
    <Input key="10" id="i" variant="pill" />,
    <SearchField key="11" variant="pill" />,
    // D-T131-3 fixed: Chip is back in the sweep (outline + filled, with title).
    <Chip key="12a" as="a" href="/search?q=s" label="S" variant="outline" />,
    <Chip key="12b" as="a" href="/search?q=s" label="S" variant="filled" title="Full chip text" />,
    <Card key="15" tone="accent">c</Card>,
    <Rating key="13" value={4} count={3} variant="compact" />,
    <QuantityStepper key="14" id="qs" value={1} max={3} onChange={() => {}} />,
  ];
  const html = renderToStaticMarkup(<>{SAMPLES}</>);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean);

  test("no arbitrary, hex or dark: classes reach the DOM", () => {
    expect(classes.filter((c) => /\[|\x23|^dark:/.test(c))).toEqual([]);
  });

  test("every colour utility resolves to a defined role token", () => {
    const colour = classes
      .map((c) => c.replace(/^(?:[a-z-]+:)+/, ""))
      .filter((c) => /^(bg|text|border|ring|outline|fill|stroke)-/.test(c))
      .map((c) => c.replace(/^(bg|text|border|ring|outline|fill|stroke)-/, ""))
      .filter((t) => !/^(caption|small|body|h[1-4]|h1-lg|price|price-lg|center|left|right|start|end)$/.test(t))
      .filter((t) => !/^(0|2|4|x|y|t|b|l|r|s|e|none|current|transparent|inherit|solid|dashed)$/.test(t))
      .filter((t) => !/^(offset-\d+|\d+)$/.test(t));
    const unknown = [...new Set(colour)].filter((t) => !PALETTE[t]);
    expect(unknown).toEqual([]);
  });

  test("every interactive element is >= 44px (touch utilities) in each sample", () => {
    const { container } = render(<>{SAMPLES}</>);
    const small = tabStops(container).filter((el) => {
      const l = cls(el);
      const h = l.some((c) => /^(min-h-touch|size-touch|h-touch|min-h-12|size-12)$/.test(c)) ||
        // CategoryTile: the image square alone is >= 64px tall
        l.some((c) => /^w-(16|24|32)$/.test(c));
      const w = l.some((c) => /^(min-w-touch|size-touch|w-touch|w-full|size-12|w-12|w-16|w-24|w-32)$/.test(c));
      return !(h && w);
    });
    expect(small.map((el) => `${el.tagName}.${cls(el).join(".")}`)).toEqual([]);
  });
});
