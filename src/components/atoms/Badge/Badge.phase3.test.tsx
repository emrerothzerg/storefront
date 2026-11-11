import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { BADGE_PRESETS, Badge, type BadgeTone } from "./Badge";

const list = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");

describe("Badge phase 3", () => {
  test("defaults: square corners, caption text, semibold, subtle", () => {
    render(<Badge tone="neutral">New</Badge>);
    const el = screen.getByText("New");
    for (const c of ["rounded-sm", "text-caption", "font-semibold", "bg-surface-sunken"]) expect(list(el)).toContain(c);
  });

  test.each<[BadgeTone, string, string]>([
    ["accent", "bg-accent-subtle", "text-accent"],
    ["promo", "bg-promo-subtle", "text-text-primary"],
    ["deal", "bg-deal-subtle", "text-deal"],
  ])("new subtle tone %s -> %s %s", (tone, bg, fg) => {
    render(<Badge tone={tone}>{tone}</Badge>);
    const el = screen.getByText(tone);
    expect(list(el)).toContain(bg);
    expect(list(el)).toContain(fg);
  });

  test.each<[BadgeTone, string, string]>([
    ["neutral", "bg-surface-inverse", "text-text-inverse"],
    ["success", "bg-success", "text-text-on-accent"],
    ["warning", "bg-warning", "text-text-on-accent"],
    ["danger", "bg-danger", "text-text-on-accent"],
    ["info", "bg-info", "text-text-on-accent"],
    ["accent", "bg-accent", "text-text-on-accent"],
    ["promo", "bg-promo", "text-text-primary"],
    ["deal", "bg-deal", "text-text-on-accent"],
  ])("solid %s -> %s %s", (tone, bg, fg) => {
    const html = renderToStaticMarkup(<Badge tone={tone} emphasis="solid">Label</Badge>);
    expect(html).toContain(` ${bg} ${fg}`);
  });

  test('shape="pill" and size="md"', () => {
    render(<Badge tone="info" shape="pill" size="md">Pill</Badge>);
    const el = screen.getByText("Pill");
    expect(list(el)).toContain("rounded-full");
    expect(list(el)).toContain("text-small");
    expect(list(el)).not.toContain("rounded-sm");
  });

  test("presets spread into the props: New / Online only / Deal / highlight", () => {
    const html = renderToStaticMarkup(
      <>
        <Badge {...BADGE_PRESETS.new}>New</Badge>
        <Badge {...BADGE_PRESETS.onlineOnly}>Online only</Badge>
        <Badge {...BADGE_PRESETS.deal}>Deal</Badge>
        <Badge {...BADGE_PRESETS.highlight}>Best seller</Badge>
      </>,
    );
    expect(html).toContain("bg-promo text-text-primary\">New<");
    expect(html).toContain("bg-accent-subtle text-accent\">Online only<");
    expect(html).toContain("bg-deal text-text-on-accent\">Deal<");
    expect(html).toContain("bg-surface-inverse text-text-inverse\">Best seller<");
  });

  test("text stays required for every tone (no colour-only badge)", () => {
    const html = renderToStaticMarkup(<Badge tone="deal" emphasis="solid">{"  "}</Badge>);
    expect(html).toBe("");
  });
});
