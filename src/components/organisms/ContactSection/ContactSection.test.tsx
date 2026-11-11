import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContactActionFn, ContactActionState } from "@/components/molecules/_contracts/contact-actions";
import { isAllowedInternalHref } from "@/content/routes";
import {
  CONTACT_SECTION_HELP_HEADING,
  CONTACT_SECTION_INTRO,
  ContactSection,
  DEFAULT_CONTACT_HELP_LINKS,
} from "./index";

const HOSTILE = `<script>alert(1)</script><img src=x onerror="alert(2)">`;

function fixed(result: ContactActionState): { action: ContactActionFn; calls: FormData[] } {
  const calls: FormData[] = [];
  const action: ContactActionFn = async (_prev, formData) => {
    calls.push(formData);
    return result;
  };
  return { action, calls };
}

const noop = fixed(null).action;

function fill(): void {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByLabelText(/^Topic/), { target: { value: "shipping" } });
  fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Where is my parcel please?" } });
}

describe("ContactSection", () => {
  test("renderToStaticMarkup works: heading, intro, form, help links", () => {
    const html = renderToStaticMarkup(<ContactSection action={noop} />);
    expect(html).toContain("<h2");
    expect(html).toContain(CONTACT_SECTION_INTRO);
    expect(html).toContain('aria-label="Contact us"');
    expect(html).toContain(CONTACT_SECTION_HELP_HEADING);
  });

  test("labelled section, heading level, honest intro copy", () => {
    const { rerender } = render(<ContactSection action={noop} />);
    expect(screen.getByRole("region", { name: "Contact us" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Contact us" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: CONTACT_SECTION_HELP_HEADING })).toBeInTheDocument();
    expect(screen.getByText(CONTACT_SECTION_INTRO)).toBeInTheDocument();
    rerender(<ContactSection action={noop} headingLevel={1} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: CONTACT_SECTION_HELP_HEADING })).toBeInTheDocument();
  });

  test("default help links in an aside, all allowlisted", () => {
    render(<ContactSection action={noop} />);
    const aside = screen.getByRole("complementary", { name: CONTACT_SECTION_HELP_HEADING });
    const links = within(aside).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual(
      DEFAULT_CONTACT_HELP_LINKS.map((l) => [l.label, l.href]),
    );
    for (const l of DEFAULT_CONTACT_HELP_LINKS) expect(isAllowedInternalHref(l.href)).toBe(true);
  });

  test("custom help links: invalid hrefs omitted, hostile labels are text; aside dropped when empty", () => {
    const { container, rerender } = render(
      <ContactSection
        action={noop}
        helpLinks={[
          { label: HOSTILE, href: "/help" },
          { label: "Evil", href: "javascript:alert(1)" },
          { label: "Offsite", href: "https://evil.example" },
        ]}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    const aside = screen.getByRole("complementary");
    expect(within(aside).getAllByRole("link").map((a) => a.textContent)).toEqual([HOSTILE]);
    rerender(<ContactSection action={noop} helpLinks={[{ label: "Evil", href: "javascript:alert(1)" }]} />);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  test("every rendered href passes the allowlist (form included)", () => {
    const { container } = render(<ContactSection action={noop} orders={[{ id: "o1", label: "Order 1001" }]} />);
    for (const a of Array.from(container.querySelectorAll("a[href]"))) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
  });

  test("passes orders, initial topic/order, product slug and signed-in email to the form", () => {
    const { container } = render(
      <ContactSection
        action={noop}
        orders={[
          { id: "o1", label: "Order 1001" },
          { id: "o2", label: "Order 1002" },
        ]}
        initialTopic="ordering"
        initialOrderId="o2"
        productSlug="desk-lamp"
        signedInEmail="me@example.com"
      />,
    );
    expect(screen.getByLabelText(/^Topic/)).toHaveValue("ordering");
    expect(screen.getByLabelText("Which order?")).toHaveValue("o2");
    expect(screen.getByLabelText(/^Email/)).toHaveValue("me@example.com");
    expect(container.querySelector('input[type="hidden"][name="productSlug"]')).toHaveValue("desk-lamp");
  });

  test("no orders -> no order select", () => {
    render(<ContactSection action={noop} />);
    expect(screen.queryByLabelText("Which order?")).toBeNull();
  });

  test("success state: the reference number surfaces inside the section", async () => {
    const { action, calls } = fixed({ ok: true, reference: "C-ABCDEFGH", message: "Message sent" });
    render(<ContactSection action={action} />);
    fill();
    const form = screen.getByRole("form", { name: "Contact us" });
    fireEvent.submit(form);
    const code = await screen.findByText("C-ABCDEFGH");
    const section = screen.getByRole("region", { name: "Contact us" });
    expect(section.contains(code)).toBe(true);
    expect(code.tagName).toBe("CODE");
    expect(code.closest('[role="status"]')).toHaveTextContent("Your reference number is C-ABCDEFGH");
    expect(calls).toHaveLength(1);
  });
});

describe("ContactSection: Phase 3 look (T162)", () => {
  test("form on a white Card (still max-w-prose), aside is a sunken Card complementary landmark", () => {
    const { container } = render(<ContactSection action={noop} />);
    const card = container.querySelector('[data-slot="contact-form-card"]');
    expect(card).toHaveClass("bg-surface-raised", "rounded-lg", "max-w-prose");
    expect(card?.querySelector("form")).not.toBeNull();
    const aside = screen.getByRole("complementary", { name: CONTACT_SECTION_HELP_HEADING });
    expect(aside.tagName).toBe("ASIDE");
    expect(aside).toHaveClass("bg-surface-sunken", "rounded-lg");
  });
});
