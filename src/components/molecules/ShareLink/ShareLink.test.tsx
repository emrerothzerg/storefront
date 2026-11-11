import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareLink } from "./ShareLink";
import { expectFocused } from "@/test/dom-assertions";

const SITE = "https://shop.example.com";
let savedSite: string | undefined;

type NavigatorKey = "clipboard" | "share";
const overridden = new Set<NavigatorKey>();

function setNavigator(key: NavigatorKey, value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  overridden.add(key);
}

beforeEach(() => {
  savedSite = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
});

afterEach(() => {
  for (const key of overridden) {
    // Removes the own property so the prototype getter (if any) shows again.
    Reflect.deleteProperty(navigator, key);
  }
  overridden.clear();
  if (savedSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = savedSite;
});

function openMenu() {
  const summary = screen.getByText("Share", { selector: "summary *" });
  const details = summary.closest("details");
  if (!details) throw new Error("details not found");
  details.open = true;
  return details;
}

function mailtoLink(): HTMLAnchorElement {
  const link = screen.getByRole("link", { name: /email a friend/i });
  return link as HTMLAnchorElement;
}

describe("ShareLink static markup (no JS)", () => {
  test("has the Share disclosure, Copy control, mailto link, noscript field and NO Web Share button", () => {
    setNavigator("share", () => Promise.resolve());
    const html = renderToStaticMarkup(<ShareLink url="/products/lamp" title="Desk Lamp" />);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Copy link");
    expect(html).toContain('href="mailto:?subject=Check%20out%20Desk%20Lamp&amp;body=Desk%20Lamp%0Ahttps%3A%2F%2Fshop.example.com%2Fproducts%2Flamp"');
    expect(html).not.toContain("Share…");
    // No-JS copy path: readonly field with the absolute URL inside <noscript>.
    expect(html).toMatch(/<noscript>.*readOnly=""|<noscript>.*readonly=""/s);
    expect(html).toContain(`value="${SITE}/products/lamp"`);
    expect(html).toContain("Press Ctrl/Cmd+C to copy");
    // No third-party scripts or widgets (criterion 4).
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
  });

  test("hostile titles render as text", () => {
    const html = renderToStaticMarkup(
      <ShareLink url="/p/x" title={'<img src=x onerror=alert(1)>"&'} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("ShareLink (hydrated)", () => {
  test("mailto href decodes back to the exact subject and body (criterion 1)", () => {
    const title = "Salt & Pepper? #1\nSet ☕🎉";
    render(<ShareLink url="/products/salt" title={title} text={"Gift idea & more"} />);
    const parsed = new URL(mailtoLink().getAttribute("href") ?? "");
    expect(parsed.protocol).toBe("mailto:");
    expect(parsed.searchParams.get("subject")).toBe(`Check out ${title}`);
    expect(parsed.searchParams.get("body")).toBe(`Gift idea & more\n${SITE}/products/salt`);
  });

  test("absolute url passes through unchanged", () => {
    render(<ShareLink url="https://other.example.com/x" title="X" />);
    const parsed = new URL(mailtoLink().getAttribute("href") ?? "");
    expect(parsed.searchParams.get("body")).toBe("X\nhttps://other.example.com/x");
  });

  test("Copy link writes the absolute URL and announces 'Link copied' in a polite live region (criterion 2)", async () => {
    const writeText = mock((text: string) => Promise.resolve(text));
    setNavigator("clipboard", { writeText });
    render(<ShareLink url="/products/lamp" title="Lamp" />);
    openMenu();
    const copy = screen.getByRole("button", { name: /copy link/i });
    await waitFor(() => expect(copy).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenCalledWith(`${SITE}/products/lamp`);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(status).toHaveTextContent("Link copied"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("clipboard rejection shows a readonly, selected field with the URL and the hint (criterion 2)", async () => {
    setNavigator("clipboard", { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) });
    render(<ShareLink url="/products/lamp" title="Lamp" />);
    openMenu();
    const copy = screen.getByRole("button", { name: /copy link/i });
    await waitFor(() => expect(copy).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(copy);
    });
    const field = (await screen.findByRole("textbox", { name: "Link to share" })) as HTMLInputElement;
    expect(field).toHaveAttribute("readonly");
    expect(field.value).toBe(`${SITE}/products/lamp`);
    expect(field).toHaveAccessibleDescription("Press Ctrl/Cmd+C to copy");
    expectFocused(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  test("missing clipboard API falls back to the readonly field", async () => {
    setNavigator("clipboard", undefined);
    render(<ShareLink url="/products/lamp" title="Lamp" />);
    openMenu();
    const copy = screen.getByRole("button", { name: /copy link/i });
    await waitFor(() => expect(copy).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(await screen.findByRole("textbox", { name: "Link to share" })).toHaveAttribute("readonly");
  });

  test("synchronous throw from writeText also falls back", async () => {
    setNavigator("clipboard", {
      writeText: () => {
        throw new Error("boom");
      },
    });
    render(<ShareLink url="/p" title="P" />);
    const copy = screen.getByRole("button", { name: /copy link/i });
    await waitFor(() => expect(copy).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(await screen.findByRole("textbox", { name: "Link to share" })).toBeInTheDocument();
  });

  test("no Share… button when navigator.share is absent", async () => {
    setNavigator("share", undefined);
    render(<ShareLink url="/p" title="P" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy link/i })).not.toBeDisabled());
    expect(screen.queryByRole("button", { name: "Share…" })).toBeNull();
  });

  test("Share… appears after mount when navigator.share exists and passes title/text/url", async () => {
    const share = mock((data: ShareData) => Promise.resolve(void data));
    setNavigator("share", share);
    render(<ShareLink url="/products/lamp" title="Lamp" text="Nice lamp" />);
    const button = await screen.findByRole("button", { name: "Share…" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(share).toHaveBeenCalledWith({ title: "Lamp", text: "Nice lamp", url: `${SITE}/products/lamp` });
  });

  test("AbortError from navigator.share is ignored", async () => {
    setNavigator("share", () => Promise.reject(new DOMException("cancelled", "AbortError")));
    render(<ShareLink url="/p" title="P" />);
    const button = await screen.findByRole("button", { name: "Share…" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  test("other navigator.share errors fall back to the readonly field", async () => {
    setNavigator("share", () => Promise.reject(new Error("not allowed")));
    render(<ShareLink url="/p" title="P" />);
    const button = await screen.findByRole("button", { name: "Share…" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(await screen.findByRole("textbox", { name: "Link to share" })).toBeInTheDocument();
  });

  test("icons are decorative and size sm uses small text", () => {
    const { container } = render(<ShareLink url="/p" title="P" size="sm" />);
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
    expect(container.querySelector("summary .text-small")).not.toBeNull();
  });

  test("hostile title is rendered as text in the hydrated tree", () => {
    const hostile = "<b>bold</b><script>x</script>";
    const { container } = render(<ShareLink url="/p" title={hostile} />);
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("list")).toHaveAccessibleName(`Share ${hostile}`);
  });

  test("D-T67-1: every successful copy mutates the live region; visible copy stays 'Link copied'", async () => {
    setNavigator("clipboard", { writeText: () => Promise.resolve() });
    render(<ShareLink url="/products/lamp" title="Lamp" />);
    openMenu();
    const copy = screen.getByRole("button", { name: /copy link/i });
    await waitFor(() => expect(copy).not.toBeDisabled());
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-atomic", "true");
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(status.textContent ?? ""));
    observer.observe(status, { childList: true, subtree: true, characterData: true });
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(copy);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      texts.push(status.textContent ?? "");
      // Sighted users only ever see "Link copied"; the suffix is sr-only.
      const visible = [...status.childNodes]
        .filter((node) => !(node instanceof HTMLElement && node.classList.contains("sr-only")))
        .map((node) => node.textContent)
        .join("");
      expect(visible).toBe("Link copied");
    }
    observer.disconnect();
    expect(texts).toEqual(["Link copied", "Link copied.", "Link copied"]);
    expect(seen.filter((t) => t.includes("copied")).length).toBeGreaterThanOrEqual(3);
  });
});

describe("ShareLink Phase 3 look (T145)", () => {
  test("Copy link and Email a friend are matching secondary 44px pills (size follows the size prop)", () => {
    for (const [size, sizeClass] of [
      ["sm", "text-small"],
      ["md", "text-body"],
    ] as const) {
      const { container, unmount } = render(<ShareLink url="/products/oak-desk" title="Oak Desk" size={size} />);
      const details = container.querySelector("details") as HTMLDetailsElement;
      details.open = true;
      const copy = screen.getByRole("button", { name: "Copy link" });
      const email = screen.getByRole("link", { name: "Email a friend" });
      for (const el of [copy, email]) {
        expect(el).toHaveClass("rounded-full", "min-h-touch", "border-border-strong", "bg-surface-raised", sizeClass);
      }
      expect(email.getAttribute("href")).toMatch(/^mailto:\?subject=/);
      unmount();
    }
  });
});
