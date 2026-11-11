// QA (QA-W0-D1): P2-D1 atoms batch 1, part 2 of 3: Checkbox, Radio/RadioGroup,
// Switch, Textarea (criteria 4-7) + Rating errorText (added during QA).
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { Checkbox } from "@/components/atoms/Checkbox";
import { FormField } from "@/components/atoms/FormField";
import { Radio, RadioGroup } from "@/components/atoms/Radio";
import { Rating } from "@/components/atoms/Rating";
import { Switch } from "@/components/atoms/Switch";
import { Textarea } from "@/components/atoms/Textarea";
import { expectFocused } from "@/test/dom-assertions";

const ROOT = join(import.meta.dir, "..", "..", "..");
const src = (p: string) => readFileSync(join(ROOT, "src/components/atoms", p), "utf8");
const formData = (c: HTMLElement) => new FormData(c.querySelector("form")!);
function staticDom(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

// ---------------------------------------------------------------- criterion 4
describe("Checkbox (criterion 4)", () => {
  test("native checkbox named by its label; description linked via aria-describedby", () => {
    render(<Checkbox name="brand" value="acme" label="Acme" description="12 items" />);
    const cb = screen.getByRole("checkbox", { name: "Acme" });
    expect(cb.tagName).toBe("INPUT");
    expect(cb).toHaveAttribute("type", "checkbox");
    expect(cb).toHaveAccessibleDescription("12 items");
  });

  test("no description -> no aria-describedby; external aria-describedby merged with description", () => {
    const { rerender } = render(<Checkbox label="A" />);
    expect(screen.getByRole("checkbox")).not.toHaveAttribute("aria-describedby");
    rerender(<><p id="ext">Ext</p><Checkbox label="A" description="Desc" aria-describedby="ext" /></>);
    expect(screen.getByRole("checkbox")).toHaveAccessibleDescription("Ext Desc");
  });

  test("label click toggles (uncontrolled) and posts name=value; unchecked posts nothing", () => {
    const { container } = render(<form><Checkbox name="brand" value="acme" label="Acme" /></form>);
    expect(formData(container).has("brand")).toBe(false);
    fireEvent.click(screen.getByText("Acme"));
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(formData(container).getAll("brand")).toEqual(["acme"]);
  });

  test("default value posts 'on'", () => {
    const { container } = render(<form><Checkbox name="tos" label="Agree" defaultChecked /></form>);
    expect(formData(container).get("tos")).toBe("on");
  });

  test("no-JS HTML: native input inside label, posts when checked", () => {
    const html = renderToStaticMarkup(<form><Checkbox name="x" value="1" label="X" defaultChecked /></form>);
    expect(html).toMatch(/<label[^>]*for="[^"]+"/);
    const host = staticDom(html);
    expect(new FormData(host.querySelector("form")!).get("x")).toBe("1");
    (host.querySelector("input") as HTMLInputElement).click();
    expect(new FormData(host.querySelector("form")!).has("x")).toBe(false);
    host.remove();
  });

  test("indeterminate sets the DOM property and aria-checked=mixed; removed when it turns off", () => {
    const { rerender } = render(<Checkbox label="All" indeterminate />);
    const cb = screen.getByRole("checkbox") as HTMLInputElement;
    expect(cb.indeterminate).toBe(true);
    expect(cb).toHaveAttribute("aria-checked", "mixed");
    rerender(<Checkbox label="All" indeterminate={false} />);
    expect(cb.indeterminate).toBe(false);
    expect(cb).not.toHaveAttribute("aria-checked");
  });

  test("not indeterminate -> no aria-checked attribute at all (native state is the truth)", () => {
    render(<Checkbox label="A" defaultChecked />);
    expect(screen.getByRole("checkbox")).not.toHaveAttribute("aria-checked");
  });

  test("documents behaviour: clicking an indeterminate box clears the DOM flag but aria-checked stays 'mixed' until the parent clears the prop", () => {
    render(<Checkbox label="All" indeterminate onChange={() => {}} />);
    const cb = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(cb);
    expect(cb.indeterminate).toBe(false);
    expect(cb).toHaveAttribute("aria-checked", "mixed");
  });

  test("controlled select-all pattern keeps aria-checked in sync", () => {
    function Host() {
      const [state, setState] = useState<"none" | "some" | "all">("some");
      return (
        <Checkbox
          label="Select all"
          checked={state === "all"}
          indeterminate={state === "some"}
          onChange={() => setState(state === "all" ? "none" : "all")}
        />
      );
    }
    render(<Host />);
    const cb = screen.getByRole("checkbox") as HTMLInputElement;
    expect(cb).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
    expect(cb.indeterminate).toBe(false);
    expect(cb).not.toHaveAttribute("aria-checked");
  });

  test.each([
    ["invalid", { invalid: true }],
    ["aria-invalid", { "aria-invalid": "true" as const }],
  ])("%s -> aria-invalid=true + danger border", (_l, p) => {
    render(<Checkbox label="A" {...p} />);
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("checkbox")).toHaveClass("border-danger");
  });

  test("disabled: not toggled by label click, not posted", () => {
    const { container } = render(<form><Checkbox name="d" label="D" disabled /></form>);
    fireEvent.click(screen.getByText("D"));
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(formData(container).has("d")).toBe(false);
  });

  test.each([["sm", "size-4"], ["md", "size-5"], ["lg", "size-6"]] as const)("size %s -> %s box; label row min-h-touch", (size, cls) => {
    render(<Checkbox label="A" size={size} />);
    const cb = screen.getByRole("checkbox");
    expect(cb).toHaveClass(cls);
    expect(cb.closest("label")).toHaveClass("min-h-touch");
  });

  test("keyboard: native input, no tabindex override, no outline suppression", () => {
    render(<Checkbox label="A" />);
    const cb = screen.getByRole("checkbox");
    expect(cb).not.toHaveAttribute("tabindex");
    expect(cb.className).not.toMatch(/outline-none/);
    cb.focus();
    expectFocused(cb);
  });

  test("ref -> input, className merged last on the root; custom id respected", () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<Checkbox label="A" id="cb1" ref={ref} className="mt-2" />);
    expect(ref.current?.id).toBe("cb1");
    expect((container.firstElementChild as HTMLElement).className.endsWith("mt-2")).toBe(true);
  });

  test("callback ref receives node and null on unmount", () => {
    const calls: Array<HTMLInputElement | null> = [];
    const { unmount } = render(<Checkbox label="A" ref={(n) => { calls.push(n); }} />);
    unmount();
    expect(calls[0]).toBeInstanceOf(HTMLInputElement);
    expect(calls.at(-1)).toBeNull();
  });

  test("documents behaviour: empty label renders an unnamed checkbox (type allows '')", () => {
    render(<Checkbox label="" />);
    expect(screen.getByRole("checkbox")).toHaveAccessibleName("");
  });

  test("type contract: label required", () => {
    // @ts-expect-error label required
    const compileOnly = () => <Checkbox name="x" />;
    expect(typeof compileOnly).toBe("function");
  });
});

// ---------------------------------------------------------------- criterion 5
describe("RadioGroup / Radio (criterion 5)", () => {
  const Shipping = (p: Partial<Parameters<typeof RadioGroup>[0]>) => (
    <RadioGroup label="Shipping speed" name="shipping" {...p}>
      <Radio value="standard" label="Standard" description="5-7 business days" />
      <Radio value="express" label="Express" />
      <Radio value="overnight" label="Overnight" disabled />
    </RadioGroup>
  );

  test("fieldset role=radiogroup named by legend; radios share name; description linked", () => {
    render(<Shipping />);
    const g = screen.getByRole("radiogroup", { name: "Shipping speed" });
    expect(g.tagName).toBe("FIELDSET");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("name"))).toEqual(["shipping", "shipping", "shipping"]);
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAccessibleDescription("5-7 business days");
  });

  test("uncontrolled defaultValue + onChange(value)", () => {
    const onChange = mock<(v: string) => void>(() => {});
    render(<Shipping defaultValue="standard" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Standard" })).toBeChecked();
    fireEvent.click(screen.getByText("Express"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toBe("express");
    expect(screen.getByRole("radio", { name: "Express" })).toBeChecked();
  });

  test("controlled value follows parent; '' = none", () => {
    function Host() {
      const [v, setV] = useState("");
      return <Shipping value={v} onChange={setV} />;
    }
    render(<Host />);
    expect(screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: "Express" }));
    expect(screen.getByRole("radio", { name: "Express" })).toBeChecked();
  });

  test("orientation: vertical default (flex-col), horizontal wraps (flex-row flex-wrap)", () => {
    const { container, rerender } = render(<Shipping />);
    expect(container.querySelector("fieldset > div")).toHaveClass("flex-col");
    rerender(<Shipping orientation="horizontal" />);
    expect(container.querySelector("fieldset > div")).toHaveClass("flex-row", "flex-wrap");
  });

  test("errorText: role=alert, group aria-invalid, linked with hint in aria-describedby (hint first)", () => {
    render(<Shipping hint="Pick one" errorText="Choose a shipping speed" />);
    const g = screen.getByRole("radiogroup");
    expect(g).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a shipping speed");
    expect(g).toHaveAccessibleDescription("Pick one Choose a shipping speed");
    for (const r of screen.getAllByRole("radio")) expect(r).toHaveClass("border-danger");
  });

  test("invalid without errorText: aria-invalid but no alert", () => {
    render(<Shipping invalid />);
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("no hint/error -> no aria-describedby, no aria-invalid", () => {
    render(<Shipping />);
    const g = screen.getByRole("radiogroup");
    expect(g).not.toHaveAttribute("aria-describedby");
    expect(g).not.toHaveAttribute("aria-invalid");
  });

  // DEFECT D3: errorText="" (common "no error" value from form state) marks the
  // group invalid with danger borders but renders no message and no describedby.
  test("DEFECT D3: errorText='' does not mark the group invalid", () => {
    render(<Shipping errorText="" />);
    expect(screen.getByRole("radiogroup").getAttribute("aria-invalid")).toBeNull();
    for (const r of screen.getAllByRole("radio")) expect(r.className.includes("border-danger")).toBe(false);
  });

  test("required: native required on every radio + aria-required on the group; visible '(required)' aria-hidden", () => {
    render(<Shipping required />);
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-required", "true");
    for (const r of screen.getAllByRole("radio")) expect(r).toBeRequired();
    expect(screen.getByRole("radiogroup", { name: "Shipping speed" })).toBeInTheDocument();
  });

  test("posts the checked value; nothing when none checked; disabled radio cannot be chosen", () => {
    const { container } = render(<form><Shipping /></form>);
    expect(formData(container).has("shipping")).toBe(false);
    fireEvent.click(screen.getByText("Overnight"));
    expect(formData(container).has("shipping")).toBe(false);
    fireEvent.click(screen.getByText("Express"));
    expect(formData(container).getAll("shipping")).toEqual(["express"]);
  });

  test("group disabled disables all radios", () => {
    render(<Shipping disabled />);
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
  });

  test("no-JS HTML: default checked radio posts; switching natively posts the new value", () => {
    const html = renderToStaticMarkup(<form><Shipping defaultValue="standard" errorText="Err" hint="H" /></form>);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="alert"');
    const host = staticDom(html);
    const form = host.querySelector("form")!;
    expect(new FormData(form).get("shipping")).toBe("standard");
    (host.querySelector('input[value="express"]') as HTMLInputElement).click();
    expect(new FormData(form).getAll("shipping")).toEqual(["express"]);
    host.remove();
  });

  test("native arrow-key behaviour: plain type=radio inputs, no tabindex/roving logic, no key handlers", () => {
    render(<Shipping defaultValue="express" />);
    for (const r of screen.getAllByRole("radio")) {
      expect(r.tagName).toBe("INPUT");
      expect(r).not.toHaveAttribute("tabindex");
    }
    expect(src("Radio/Radio.tsx") + src("Radio/RadioGroup.tsx")).not.toMatch(/onKey|tabIndex/);
  });

  test("hostile: 0 radios renders an empty named group without crashing", () => {
    const { container } = render(<form><RadioGroup label="Empty" name="e">{null}</RadioGroup></form>);
    expect(screen.getByRole("radiogroup", { name: "Empty" })).toBeInTheDocument();
    expect(formData(container).has("e")).toBe(false);
  });

  test("hostile: 500 radios render with unique ids and the chosen one posts", () => {
    const { container } = render(
      <form>
        <RadioGroup label="Many" name="m" defaultValue="v250">
          {Array.from({ length: 500 }, (_, i) => <Radio key={i} value={`v${i}`} label={`Option ${i}`} />)}
        </RadioGroup>
      </form>,
    );
    const radios = container.querySelectorAll("input[type=radio]");
    expect(radios).toHaveLength(500);
    expect(new Set([...radios].map((r) => r.id)).size).toBe(500);
    expect(formData(container).get("m")).toBe("v250");
    fireEvent.click(screen.getByText("Option 499"));
    expect(formData(container).get("m")).toBe("v499");
  });

  test("Radio outside a group works with its own name", () => {
    const { container } = render(<form><Radio name="solo" value="a" label="A" /></form>);
    fireEvent.click(screen.getByText("A"));
    expect(formData(container).get("solo")).toBe("a");
  });

  test("refs: RadioGroup -> fieldset, Radio -> input; className last", () => {
    const g = createRef<HTMLFieldSetElement>();
    const r = createRef<HTMLInputElement>();
    render(<RadioGroup label="L" name="n" ref={g} className="mt-3"><Radio value="a" label="A" ref={r} /></RadioGroup>);
    expect(g.current?.tagName).toBe("FIELDSET");
    expect(g.current?.className.endsWith("mt-3")).toBe(true);
    expect(r.current?.type).toBe("radio");
  });

  test("type contract: RadioGroup label+name required, Radio value+label required", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error label required */}
        <RadioGroup name="n"><span /></RadioGroup>
        {/* @ts-expect-error value required */}
        <Radio label="x" />
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});

// ---------------------------------------------------------------- criterion 6
describe("Switch (criterion 6)", () => {
  test("role=switch on a native button type=button, named by visible label", () => {
    render(<Switch label="Email me about price drops" />);
    const sw = screen.getByRole("switch", { name: "Email me about price drops" });
    expect(sw.tagName).toBe("BUTTON");
    expect(sw).toHaveAttribute("type", "button");
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).not.toHaveAttribute("aria-label");
  });

  test("hideLabel -> aria-label, no visible text", () => {
    render(<Switch label="Dark mode" hideLabel />);
    const sw = screen.getByRole("switch", { name: "Dark mode" });
    expect(sw).toHaveAttribute("aria-label", "Dark mode");
    expect(sw.textContent).toBe("");
  });

  test("uncontrolled: defaultChecked, click toggles, onCheckedChange(next)", () => {
    const onChange = mock<(v: boolean) => void>(() => {});
    render(<Switch label="S" defaultChecked onCheckedChange={onChange} />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(onChange.mock.calls).toEqual([[false]]);
  });

  test("controlled: stays put unless the parent updates", () => {
    const onChange = mock<(v: boolean) => void>(() => {});
    const { rerender } = render(<Switch label="S" checked={false} onCheckedChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(onChange.mock.calls).toEqual([[true]]);
    rerender(<Switch label="S" checked onCheckedChange={onChange} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  test("keyboard: focusable native button; Space/Enter map to click natively (no key handlers needed)", () => {
    render(<Switch label="S" />);
    const sw = screen.getByRole("switch");
    sw.focus();
    expectFocused(sw);
    expect(sw.className).not.toMatch(/outline-none/);
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(src("Switch/Switch.tsx")).not.toMatch(/onKeyDown/);
  });

  test("disabled: not toggled", () => {
    const onChange = mock(() => {});
    render(<Switch label="S" disabled onCheckedChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  test("onClick preventDefault cancels the toggle", () => {
    render(<Switch label="S" onClick={(e) => e.preventDefault()} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  test("name: hidden input posts 'on' only while checked; custom value; no name -> nothing", () => {
    const { container } = render(<form><Switch label="S" name="alerts" /><Switch label="T" name="t" value="yes" defaultChecked /><Switch label="U" defaultChecked /></form>);
    expect(formData(container).has("alerts")).toBe(false);
    expect(formData(container).get("t")).toBe("yes");
    fireEvent.click(screen.getByRole("switch", { name: "S" }));
    expect(formData(container).get("alerts")).toBe("on");
    fireEvent.click(screen.getByRole("switch", { name: "S" }));
    expect(formData(container).has("alerts")).toBe(false);
    expect([...formData(container).keys()]).toEqual(["t"]);
  });

  test("no-JS HTML: defaultChecked posts via hidden input; off posts nothing", () => {
    const on = staticDom(renderToStaticMarkup(<form><Switch label="S" name="a" defaultChecked /></form>));
    expect(new FormData(on.querySelector("form")!).get("a")).toBe("on");
    expect(on.innerHTML).toContain('role="switch"');
    on.remove();
    const off = staticDom(renderToStaticMarkup(<form><Switch label="S" name="a" /></form>));
    expect(new FormData(off.querySelector("form")!).has("a")).toBe(false);
    off.remove();
  });

  // DEFECT D4: the name prop doc says "same as a checkbox", but a disabled switch
  // that is on still posts its value (a disabled checkbox never posts).
  test("DEFECT D4: disabled + checked switch does not post (checkbox parity)", () => {
    const { container } = render(<form><Switch label="S" name="a" defaultChecked disabled /></form>);
    expect(formData(container).has("a")).toBe(false);
  });

  test("known limitation (cannot toggle without JS) is documented", () => {
    const readme = src("README.md");
    expect(readme).toMatch(/Switch[^\n]*cannot toggle without JS/);
  });

  test("description linked; ref -> button; className last on root", () => {
    const ref = createRef<HTMLButtonElement>();
    const { container } = render(<Switch label="S" description="Weekly" ref={ref} className="mt-2" />);
    expect(screen.getByRole("switch")).toHaveAccessibleDescription("Weekly");
    expect(ref.current === screen.getByRole("switch")).toBe(true);
    expect((container.firstElementChild as HTMLElement).className.endsWith("mt-2")).toBe(true);
  });

  test("touch target: min-h-touch min-w-touch on the button", () => {
    render(<Switch label="S" hideLabel />);
    expect(screen.getByRole("switch")).toHaveClass("min-h-touch", "min-w-touch");
  });

  test("documents behaviour: hideLabel with empty label yields an unnamed switch", () => {
    render(<Switch label="" hideLabel />);
    expect(screen.getByRole("switch")).toHaveAccessibleName("");
  });
});

// ---------------------------------------------------------------- criterion 7
describe("Textarea (criterion 7)", () => {
  test("rows default 4; id; no inline style; resize-y by default", () => {
    const { container } = render(<Textarea id="t" />);
    const ta = container.querySelector("textarea")!;
    expect(ta).toHaveAttribute("rows", "4");
    expect(ta.id).toBe("t");
    expect(ta).not.toHaveAttribute("style");
    expect(ta).toHaveClass("resize-y", "border-border-strong");
  });

  test.each([
    ["invalid", { invalid: true }],
    ["aria-invalid='true'", { "aria-invalid": "true" as const }],
    ["aria-invalid={true}", { "aria-invalid": true }],
  ])("%s -> aria-invalid=true + danger border (mirrors Input)", (_l, p) => {
    const { container } = render(<Textarea id="t" {...p} />);
    expect(container.querySelector("textarea")).toHaveAttribute("aria-invalid", "true");
    expect(container.querySelector("textarea")).toHaveClass("border-danger");
  });

  test("works with FormField: label, hint + error + counter in aria-describedby, required", () => {
    render(
      <FormField id="review" label="Your review" required hint="Be kind" error="Too short">
        {(p) => <Textarea {...p} name="body" maxLength={100} showCount />}
      </FormField>,
    );
    const ta = screen.getByRole("textbox", { name: /Your review/ });
    expect(ta).toBeRequired();
    expect(ta).toHaveAttribute("aria-invalid", "true");
    expect(ta.getAttribute("aria-describedby")).toBe("review-hint review-error review-count");
    expect(ta).toHaveAccessibleDescription("Be kind Too short 0 / 100 characters");
  });

  test("maxLength passes through natively", () => {
    const { container } = render(<Textarea id="t" maxLength={10} />);
    expect(container.querySelector("textarea")).toHaveAttribute("maxlength", "10");
  });

  test("showCount without maxLength (or maxLength <= 0) renders no counter", () => {
    for (const m of [undefined, 0, -5]) {
      const { container, unmount } = render(<Textarea id="t" showCount maxLength={m} />);
      expect(container.querySelector("#t-count")).toBeNull();
      expect(container.querySelector("textarea")).not.toHaveAttribute("aria-describedby");
      unmount();
    }
  });

  test("counter reflects defaultValue and typing; turns danger at the limit", () => {
    const { container } = render(<Textarea id="t" maxLength={10} showCount defaultValue="abc" />);
    const count = container.querySelector("#t-count")!;
    expect(count.textContent).toBe("3 / 10 characters");
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "abcdefghij" } });
    expect(count.textContent).toBe("10 / 10 characters");
    expect(count).toHaveClass("text-danger");
  });

  test("live region announces only on rising crossings of 80/90/100% (not every keystroke)", () => {
    const { container } = render(<Textarea id="t" maxLength={10} showCount />);
    const ta = container.querySelector("textarea")!;
    const live = container.querySelector("[aria-live=polite]")!;
    expect(live).toHaveAttribute("aria-atomic", "true");
    const seen: string[] = [];
    let last = live.textContent;
    const type = (v: string) => {
      fireEvent.change(ta, { target: { value: v } });
      if (live.textContent !== last) { seen.push(live.textContent ?? ""); last = live.textContent; }
    };
    for (let i = 1; i <= 10; i++) type("x".repeat(i));
    expect(seen).toEqual(["8 / 10 characters", "9 / 10 characters", "10 / 10 characters"]);
  });

  test("jumping straight past several thresholds (paste) announces once", () => {
    const { container } = render(<Textarea id="t" maxLength={100} showCount />);
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "x".repeat(95) } });
    expect(container.querySelector("[aria-live=polite]")!.textContent).toBe("95 / 100 characters");
  });

  test("starting above a threshold (defaultValue) does not announce on mount", () => {
    const { container } = render(<Textarea id="t" maxLength={10} showCount defaultValue="xxxxxxxxx" />);
    expect(container.querySelector("[aria-live=polite]")!.textContent).toBe("");
  });

  test("falling below then re-crossing a threshold at a DIFFERENT length re-announces", () => {
    const { container } = render(<Textarea id="t" maxLength={100} showCount />);
    const ta = container.querySelector("textarea")!;
    const live = container.querySelector("[aria-live=polite]")!;
    fireEvent.change(ta, { target: { value: "x".repeat(80) } });
    fireEvent.change(ta, { target: { value: "x".repeat(70) } });
    fireEvent.change(ta, { target: { value: "x".repeat(81) } });
    expect(live.textContent).toBe("81 / 100 characters");
  });

  // DEFECT D5 (minor): re-crossing at the SAME length sets identical text, so the
  // live region does not change and nothing is re-announced.
  test("DEFECT D5: re-crossing a threshold at the same length re-announces (live region content changes)", () => {
    const { container } = render(<Textarea id="t" maxLength={10} showCount />);
    const ta = container.querySelector("textarea")!;
    const live = container.querySelector("[aria-live=polite]")!;
    const mutations: string[] = [];
    const obs = new MutationObserver(() => mutations.push(live.textContent ?? ""));
    fireEvent.change(ta, { target: { value: "x".repeat(8) } });
    obs.observe(live, { childList: true, characterData: true, subtree: true });
    fireEvent.change(ta, { target: { value: "x".repeat(7) } });
    fireEvent.change(ta, { target: { value: "x".repeat(8) } });
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        obs.disconnect();
        try { expect(mutations.length).toBeGreaterThan(0); resolve(); } catch (e) { reject(e); }
      }, 0);
    });
  });

  test("controlled value drives the counter; onChange still called", () => {
    const onChange = mock(() => {});
    function Host() {
      const [v, setV] = useState("ab");
      return <Textarea id="t" maxLength={5} showCount value={v} onChange={(e) => { onChange(); setV(e.target.value); }} />;
    }
    const { container } = render(<Host />);
    expect(container.querySelector("#t-count")!.textContent).toBe("2 / 5 characters");
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "abcd" } });
    expect(container.querySelector("#t-count")!.textContent).toBe("4 / 5 characters");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("autoResize uses field-sizing-content class, no inline style, no JS height logic", () => {
    const { container } = render(<Textarea id="t" autoResize defaultValue={"a\n".repeat(50)} />);
    const ta = container.querySelector("textarea")!;
    expect(ta).toHaveClass("field-sizing-content");
    expect(ta).not.toHaveAttribute("style");
    expect(src("Textarea/Textarea.tsx")).not.toMatch(/scrollHeight|style=|\.style\./);
  });

  test("posts as a normal field (client and no-JS)", () => {
    const { container } = render(<form><Textarea id="t" name="body" defaultValue="hello" showCount maxLength={50} /></form>);
    expect(formData(container).get("body")).toBe("hello");
    const host = staticDom(renderToStaticMarkup(<form><Textarea id="t2" name="body" defaultValue="hi" /></form>));
    expect(new FormData(host.querySelector("form")!).get("body")).toBe("hi");
    host.remove();
  });

  test("ref + className last (on the textarea)", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea id="t" ref={ref} className="mt-2" showCount maxLength={9} />);
    expect(ref.current?.tagName).toBe("TEXTAREA");
    expect(ref.current?.className.endsWith("mt-2")).toBe(true);
  });

  test("type contract: id required", () => {
    // @ts-expect-error id required
    const compileOnly = () => <Textarea />;
    expect(typeof compileOnly).toBe("function");
  });
});

// ------------------------------------------------ Rating errorText (in-flight)
describe("Rating input errorText (added during QA)", () => {
  test("errorText -> role=alert, aria-invalid, linked after describedBy", () => {
    render(<><p id="h">Hint</p><Rating mode="input" name="r" label="R" describedBy="h" errorText="Pick a rating" /></>);
    const g = screen.getByRole("radiogroup", { name: "R" });
    expect(g).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a rating");
    expect(g).toHaveAccessibleDescription("Hint Pick a rating");
  });

  test("errorText='' does not mark invalid (contrast with RadioGroup D3)", () => {
    render(<Rating mode="input" name="r" label="R" errorText="" />);
    expect(screen.getByRole("radiogroup")).not.toHaveAttribute("aria-invalid");
  });
});
