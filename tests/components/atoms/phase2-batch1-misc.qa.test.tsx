// QA (QA-W0-D1): P2-D1 atoms batch 1, part 3 of 3: Chip, Avatar, Divider,
// VisuallyHidden, Notice (criteria 8-12) and cross-cutting checks (criterion 14).
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { Avatar, AVATAR_TONES, avatarTone, getInitials } from "@/components/atoms/Avatar";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Chip } from "@/components/atoms/Chip";
import { Divider } from "@/components/atoms/Divider";
import { Icon } from "@/components/atoms/Icon";
import { IconButton } from "@/components/atoms/IconButton";
import { Notice, type NoticeTone } from "@/components/atoms/Notice";
import { Radio, RadioGroup } from "@/components/atoms/Radio";
import { Rating } from "@/components/atoms/Rating";
import { Switch } from "@/components/atoms/Switch";
import { Textarea } from "@/components/atoms/Textarea";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { expectFocused } from "@/test/dom-assertions";

const ROOT = join(import.meta.dir, "..", "..", "..");
const src = (p: string) => readFileSync(join(ROOT, "src/components/atoms", p), "utf8");

// ---------------------------------------------------------------- criterion 8
describe("Chip (criterion 8)", () => {
  test("default as=button; onToggle -> aria-pressed reflecting selected; called with next state", () => {
    const onToggle = mock<(v: boolean) => void>(() => {});
    const { rerender } = render(<Chip label="Prime" onToggle={onToggle} />);
    const b = screen.getByRole("button", { name: "Prime" });
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(b);
    expect(onToggle.mock.calls[0]![0]).toBe(true);
    rerender(<Chip label="Prime" selected onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "Prime", pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle.mock.calls[1]![0]).toBe(false);
  });

  test("button without onToggle -> no aria-pressed (plain action chip)", () => {
    const onClick = mock(() => {});
    render(<Chip label="Clear" onClick={onClick} />);
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-pressed");
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("disabled button chip does not toggle", () => {
    const onToggle = mock(() => {});
    render(<Chip label="X" onToggle={onToggle} disabled />);
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("as=a: link with href; selected -> aria-current='true'; unselected -> none", () => {
    const { rerender } = render(<Chip as="a" href="/search?brand=acme" label="Acme" />);
    const a = screen.getByRole("link", { name: "Acme" });
    expect(a).toHaveAttribute("href", "/search?brand=acme");
    expect(a).not.toHaveAttribute("aria-current");
    rerender(<Chip as="a" href="/search?brand=acme" label="Acme" selected />);
    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link")).not.toHaveAttribute("aria-pressed");
  });

  test("as=span: static, not focusable, no role", () => {
    const { container } = render(<Chip as="span" label="Under $25" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("span")).not.toHaveAttribute("tabindex");
  });

  test.each([
    ["button", <Chip key="b" label="L" selected onToggle={() => {}} />],
    ["a", <Chip key="a" as="a" href="/x" label="L" selected />],
    ["span", <Chip key="s" as="span" label="L" selected />],
  ] as const)("selected %s chip shows a check icon (not colour alone); unselected does not", (_k, el) => {
    const { container } = render(el);
    expect(container.querySelector('svg[data-icon="check"]')).toHaveAttribute("aria-hidden", "true");
  });

  test("unselected chip has no check icon", () => {
    const { container } = render(<Chip label="L" onToggle={() => {}} />);
    expect(container.querySelector('svg[data-icon="check"]')).toBeNull();
  });

  test.each(["button", "a", "span"] as const)("onRemove (%s): SIBLING IconButton 'Remove <label>', never nested", (as) => {
    const onRemove = mock(() => {});
    const onToggle = mock(() => {});
    const el =
      as === "a" ? <Chip as="a" href="/x" label="Acme" onRemove={onRemove} />
      : as === "span" ? <Chip as="span" label="Acme" onRemove={onRemove} />
      : <Chip label="Acme" onToggle={onToggle} onRemove={onRemove} />;
    const { container } = render(el);
    const remove = screen.getByRole("button", { name: "Remove Acme" });
    // no interactive element contains another interactive element
    for (const i of container.querySelectorAll("button, a")) {
      expect(i.querySelector("button, a")).toBeNull();
    }
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(remove).toHaveClass("size-touch");
  });

  test("keyboard: chip button and remove button are separate tab stops in DOM order", () => {
    const { container } = render(<Chip label="Acme" onToggle={() => {}} onRemove={() => {}} />);
    const stops = [...container.querySelectorAll("button")];
    expect(stops.map((b) => b.textContent || b.getAttribute("aria-label"))).toEqual(["Acme", "Remove Acme"]);
    for (const b of stops) { b.focus(); expectFocused(b); }
  });

  test.each([["sm", "text-small"], ["md", "text-body"]] as const)("size %s -> %s, min-h-touch", (size, cls) => {
    render(<Chip label="L" size={size} onToggle={() => {}} />);
    expect(screen.getByRole("button")).toHaveClass(cls, "min-h-touch");
  });

  test("ref + className last: on the main element without remove, on the wrapper with remove", () => {
    const ref = createRef<HTMLButtonElement>();
    const { container, rerender } = render(<Chip label="L" ref={ref} className="ml-1" />);
    expect(ref.current?.className.endsWith("ml-1")).toBe(true);
    rerender(<Chip label="L" ref={ref} className="ml-1" onRemove={() => {}} />);
    expect((container.firstElementChild as HTMLElement).className.endsWith("ml-1")).toBe(true);
    expect(ref.current?.tagName).toBe("BUTTON");
  });

  test("no-JS HTML: link chip is a plain <a href>, remove button is a sibling", () => {
    const html = renderToStaticMarkup(<Chip as="a" href="/s?b=1" label="B" selected onRemove={() => {}} />);
    expect(html).toMatch(/<a [^>]*href="\/s\?b=1"[^>]*aria-current="true"|<a [^>]*aria-current="true"[^>]*href="\/s\?b=1"/);
    expect(html).toMatch(/<\/a><button/);
  });

  test("documents behaviour: empty label -> remove button named 'Remove ' (type allows '')", () => {
    render(<Chip as="span" label="" onRemove={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Remove ");
  });

  test("type contract: as=a requires href; button cannot take href; span cannot take onToggle", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error href required for as=a */}
        <Chip as="a" label="x" />
        {/* @ts-expect-error href not allowed on a button chip */}
        <Chip label="x" href="/y" />
        {/* @ts-expect-error onToggle not allowed on a span chip */}
        <Chip as="span" label="x" onToggle={() => {}} />
        {/* @ts-expect-error label required */}
        <Chip />
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});

// ---------------------------------------------------------------- criterion 9
describe("Avatar (criterion 9)", () => {
  test("role=img named by name; initials hidden from AT", () => {
    const { container } = render(<Avatar name="Jane Doe" />);
    const img = screen.getByRole("img", { name: "Jane Doe" });
    expect(img.textContent).toBe("JD");
    expect(container.querySelector("[aria-hidden=true]")?.textContent).toBe("JD");
  });

  test("photo: inner <img alt=''>, root still named; no initials", () => {
    const { container } = render(<Avatar name="Jane Doe" src="/img/jane.jpg" />);
    expect(screen.getByRole("img", { name: "Jane Doe" })).toBeInTheDocument();
    const inner = container.querySelector("img")!;
    expect(inner.getAttribute("alt")).toBe("");
    expect(container.textContent).toBe("");
  });

  test.each([[""], ["   "], [null], [undefined]])("blank src %p -> initials", (s) => {
    const { container } = render(<Avatar name="Jane Doe" src={s} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("JD");
  });

  test("image error -> initials fallback (and tone class appears)", () => {
    const { container } = render(<Avatar name="Jane Doe" src="/broken.jpg" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("JD");
    expect(AVATAR_TONES.some((t) => (container.firstElementChild as HTMLElement).classList.contains(t))).toBe(true);
  });

  test("new src after an error gets a fresh attempt", () => {
    const { container, rerender } = render(<Avatar name="J" src="/a.jpg" />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<Avatar name="J" src="/b.jpg" />);
    expect(container.querySelector("img")).not.toBeNull();
  });

  test("tone: deterministic, case/whitespace-insensitive, always one of 4 token tints, spread over names", () => {
    expect(avatarTone("Jane Doe")).toBe(avatarTone("  jane doe "));
    const names = Array.from({ length: 200 }, (_, i) => `Person ${i}`);
    const tones = new Set(names.map(avatarTone));
    expect(tones.size).toBe(4);
    for (const t of tones) expect(AVATAR_TONES as readonly string[]).toContain(t);
    expect([...AVATAR_TONES].sort()).toEqual(["bg-accent-subtle", "bg-info-subtle", "bg-success-subtle", "bg-warning-subtle"]);
    expect(src("Avatar/Avatar.tsx")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test.each([["sm", "size-8"], ["md", "size-10"], ["lg", "size-14"]] as const)("size %s -> %s (32/40/56)", (size, cls) => {
    render(<Avatar name="A B" size={size} />);
    expect(screen.getByRole("img")).toHaveClass(cls);
  });

  test.each([
    ["Jane Doe", "JD"],
    ["jane", "J"],
    ["Mary Ann van der Berg", "MB"],
    ["Émile Zola", "ÉZ"],
    ["Øyvind Ødegård", "ØØ"],
    ["山田 太郎", "山太"],
    ["Ахмед Иванов", "АИ"],
    ["أحمد علي", "أع"],
    ["😀 Smile", "😀S"],
    ["𝓙ane 𝓓oe", "𝓙𝓓"],
    ["  ", "?"],
    ["", "?"],
    ["\t\n jane \t doe\n", "JD"],
  ])("initials for %p -> %p (code-point safe, no broken surrogates)", (name, expected) => {
    expect(getInitials(name)).toBe(expected);
  });

  test("blank name -> accessible name 'User', initials '?'", () => {
    render(<Avatar name="   " />);
    expect(screen.getByRole("img", { name: "User" }).textContent).toBe("?");
  });

  // DEFECT D6 (minor): initials split by code point, not grapheme cluster.
  test("DEFECT D6: decomposed accents / ZWJ emoji / flags stay whole in initials", () => {
    expect(getInitials("Émile Zola")).toBe("ÉZ");
    expect(getInitials("🇹🇷 Ali")).toBe("🇹🇷A");
    expect(getInitials("👩‍💻 Dev")).toBe("👩‍💻D");
  });

  test("decorative hides the whole avatar", () => {
    const { container } = render(<Avatar name="Jane" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  test("ref + className last", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<Avatar name="A" ref={ref} className="ring-2" />);
    expect(ref.current?.className.endsWith("ring-2")).toBe(true);
  });

  test("hostile: very long name does not throw and still yields <= 2 initials", () => {
    const name = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(" ");
    expect(getInitials(name)).toBe("WW");
    render(<Avatar name={name} />);
    expect(screen.getByRole("img").textContent).toBe("WW");
  });
});

// --------------------------------------------------------------- criterion 10
describe("Divider (criterion 10)", () => {
  test("plain -> <hr> (implicit separator), no explicit role", () => {
    const { container } = render(<Divider />);
    const hr = container.querySelector("hr")!;
    expect(hr).not.toBeNull();
    expect(hr).not.toHaveAttribute("role");
    expect(screen.getByRole("separator")).toBe(hr);
  });

  test("labelled -> role=separator, aria-orientation=horizontal, named by label", () => {
    render(<Divider label="or" />);
    const s = screen.getByRole("separator", { name: "or" });
    expect(s.tagName).not.toBe("HR");
    expect(s).toHaveAttribute("aria-orientation", "horizontal");
  });

  test("vertical -> role=separator aria-orientation=vertical; label ignored", () => {
    render(<Divider orientation="vertical" label="or" />);
    const s = screen.getByRole("separator");
    expect(s).toHaveAttribute("aria-orientation", "vertical");
    expect(s).not.toHaveAttribute("aria-label");
  });

  test("hostile: whitespace label falls back to <hr>", () => {
    const { container } = render(<Divider label="   " />);
    expect(container.querySelector("hr")).not.toBeNull();
  });

  test("ref + className last; server-safe", () => {
    const ref = createRef<HTMLElement>();
    render(<Divider ref={ref} className="my-4" />);
    expect(ref.current?.tagName).toBe("HR");
    expect(ref.current?.className.endsWith("my-4")).toBe(true);
    expect(renderToStaticMarkup(<Divider label="or" />)).toContain('role="separator"');
  });
});

// --------------------------------------------------------------- criterion 11
describe("VisuallyHidden (criterion 11)", () => {
  test("default span with sr-only, content in the accessibility tree", () => {
    const { container } = render(<VisuallyHidden>Hidden text</VisuallyHidden>);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveClass("sr-only");
    expect(screen.getByText("Hidden text")).toBeInTheDocument();
  });

  test.each(["span", "div", "p", "label", "h1", "h2", "h3", "h4"] as const)("as=%s renders that element", (as) => {
    const { container } = render(<VisuallyHidden as={as}>x</VisuallyHidden>);
    expect(container.firstElementChild!.tagName).toBe(as.toUpperCase());
  });

  test("as=a with href + focusable: skip link becomes visible on focus (focus:not-sr-only) and is a tab stop", () => {
    render(<VisuallyHidden as="a" href="#main" focusable>Skip to main content</VisuallyHidden>);
    const a = screen.getByRole("link", { name: "Skip to main content" });
    expect(a).toHaveAttribute("href", "#main");
    expect(a).toHaveClass("sr-only", "focus:not-sr-only", "focus:bg-surface-raised", "focus:z-toast");
    a.focus();
    expectFocused(a);
    expect(a.className).not.toMatch(/outline-none/);
  });

  test("non-focusable has no not-sr-only classes", () => {
    const { container } = render(<VisuallyHidden>x</VisuallyHidden>);
    expect(container.firstElementChild!.className).not.toMatch(/not-sr-only/);
  });

  test("className merged last; ref forwarded; server-safe", () => {
    const ref = createRef<HTMLElement>();
    const { container } = render(<VisuallyHidden ref={ref} className="x-extra">x</VisuallyHidden>);
    expect(container.firstElementChild!.className.endsWith("x-extra")).toBe(true);
    expect(ref.current).toBe(container.firstElementChild as HTMLElement);
    expect(renderToStaticMarkup(<VisuallyHidden as="a" href="#m" focusable>s</VisuallyHidden>)).toContain('href="#m"');
  });

  test("type contract: as=a requires href; href not allowed on other elements", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error href required */}
        <VisuallyHidden as="a">x</VisuallyHidden>
        {/* @ts-expect-error href only on as=a */}
        <VisuallyHidden as="span" href="#x">x</VisuallyHidden>
        {/* @ts-expect-error button is not a supported element */}
        <VisuallyHidden as="button">x</VisuallyHidden>
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});

// --------------------------------------------------------------- criterion 12
describe("Notice (criterion 12)", () => {
  test.each([
    ["info", "status", "info"],
    ["success", "status", "check-circle"],
    ["warning", "alert", "warning"],
    ["danger", "alert", "error-circle"],
  ] as const)("%s -> role=%s, aria-hidden %s icon", (tone, role, icon) => {
    const { container } = render(<Notice tone={tone} title="T">Body</Notice>);
    const n = screen.getByRole(role);
    expect(n).toHaveTextContent("TBody");
    const svg = container.querySelector(`svg[data-icon="${icon}"]`)!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  test("icons differ per tone (shape, not colour alone)", () => {
    const icons = (["info", "success", "warning", "danger"] as NoticeTone[]).map((t) => {
      const { container, unmount } = render(<Notice tone={t}>x</Notice>);
      const name = container.querySelector("svg")!.getAttribute("data-icon");
      unmount();
      return name;
    });
    expect(new Set(icons).size).toBe(4);
  });

  test("onDismiss: button named 'Dismiss' by default, custom dismissLabel, click calls handler", () => {
    const onDismiss = mock(() => {});
    const { rerender } = render(<Notice tone="success" onDismiss={onDismiss}>Saved</Notice>);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<Notice tone="success" onDismiss={onDismiss} dismissLabel="Close message">Saved</Notice>);
    expect(screen.getByRole("button", { name: "Close message" })).toHaveClass("size-touch");
  });

  test("no onDismiss -> no button; no title / no children -> no empty wrappers", () => {
    const { container } = render(<Notice tone="info" />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  test("ref + className last; server-safe without onDismiss", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Notice tone="info" ref={ref} className="mt-4">x</Notice>);
    expect(ref.current?.className.endsWith("mt-4")).toBe(true);
    expect(renderToStaticMarkup(<Notice tone="danger" title="Error">Bad</Notice>)).toContain('role="alert"');
  });

  test("only verified tone pairs used (tone text + text-primary on tint)", () => {
    const s = src("Notice/Notice.tsx");
    expect(s).not.toMatch(/text-text-secondary/);
  });
});

// --------------------------------------------------------------- criterion 14
describe("cross-cutting (criterion 14)", () => {
  const FILES = [
    "Icon/Icon.tsx", "IconButton/IconButton.tsx", "Rating/Rating.tsx", "Checkbox/Checkbox.tsx",
    "Radio/Radio.tsx", "Radio/RadioGroup.tsx", "Radio/RadioGroupContext.ts", "Switch/Switch.tsx",
    "Textarea/Textarea.tsx", "Chip/Chip.tsx", "Avatar/Avatar.tsx", "Divider/Divider.tsx",
    "VisuallyHidden/VisuallyHidden.tsx", "Notice/Notice.tsx",
  ];
  test.each(FILES.map((f) => [f]))("%s: no any / @ts-ignore / @ts-nocheck / eslint-disable / inline style / raw hex / outline-none", (f) => {
    const s = src(f);
    expect(s).not.toMatch(/:\s*any\b|<any>|as any\b|\bany\[\]/);
    expect(s).not.toMatch(/@ts-ignore|@ts-nocheck|eslint-disable/);
    expect(s).not.toMatch(/\bstyle=\{/);
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(s).not.toMatch(/outline-none/);
  });

  test("server-claimed atoms have no 'use client' (Icon, Divider, VisuallyHidden, Notice)", () => {
    for (const f of ["Icon/Icon.tsx", "Divider/Divider.tsx", "VisuallyHidden/VisuallyHidden.tsx", "Notice/Notice.tsx"]) {
      expect(src(f)).not.toContain('"use client"');
    }
  });

  test("no inline style attribute in any server-rendered atom markup", () => {
    const html = renderToStaticMarkup(
      <form>
        <Icon name="cart" title="Cart" />
        <IconButton icon="heart" label="Save" pressed />
        <Rating value={3.5} count={10} />
        <Rating mode="input" name="r" label="R" />
        <Checkbox label="C" indeterminate />
        <RadioGroup label="G" name="g" hint="h" errorText="e"><Radio value="a" label="A" /></RadioGroup>
        <Switch label="S" name="s" defaultChecked />
        <Textarea id="t" maxLength={10} showCount autoResize />
        <Chip label="X" selected onToggle={() => {}} onRemove={() => {}} />
        <Avatar name="Jane Doe" />
        <Divider label="or" />
        <VisuallyHidden as="a" href="#m" focusable>skip</VisuallyHidden>
        <Notice tone="warning" title="W" onDismiss={() => {}}>x</Notice>
      </form>,
    );
    expect(html).not.toContain("style=");
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  test("no new runtime dependencies (package.json deps are next/react/react-dom only)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["next", "react", "react-dom"]);
  });

  test("every class name used by these atoms is a token utility (no palette / arbitrary values)", () => {
    const all = FILES.map(src).join("\n");
    expect(all).not.toMatch(/\b(bg|text|border|fill|stroke)-(gray|slate|zinc|red|blue|green|yellow|amber|white|black)\b/);
    expect(all).not.toMatch(/[a-z]-\[[^\]]+\]/);
  });
});
