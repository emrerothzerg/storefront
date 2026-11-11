import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { appError } from "@/lib/result";
import type { ListActionFn, ListActionState } from "../_contracts/list-actions";
import {
  COPY_FALLBACK_MESSAGE,
  LINK_COPIED_MESSAGE,
  SAVE_FOR_LATER_SHARE_TEXT,
  STOP_SHARING_CONFIRM_LABEL,
  ShareListPanel,
  type ShareListPanelProps,
  safeSiteBase,
  shareUrlFor,
} from "./ShareListPanel";
import { expectFocused } from "@/test/dom-assertions";

type Posted = Record<string, string>;
const SITE = "https://shop.example.com";
const TOKEN = "tok_ABCdef123";

function recording(results: ListActionState[]) {
  const calls: Posted[] = [];
  const action: ListActionFn = async (_prev, formData) => {
    const posted: Posted = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") posted[key] = value;
    });
    calls.push(posted);
    return results[Math.min(calls.length - 1, results.length - 1)] ?? null;
  };
  return { action, calls };
}

const sharing = (sharePath: string | null, message: string): ListActionState => ({
  ok: true,
  kind: "sharing",
  message,
  listId: "L1",
  sharePath,
});

function setup(props: Partial<ShareListPanelProps> = {}, results: ListActionState[] = [sharing(null, "Sharing is off.")]) {
  const rec = recording(results);
  const utils = render(
    <ShareListPanel
      listId="L1"
      listName="Birthday"
      kind="wishlist"
      isPublic
      shareToken={TOKEN}
      action={rec.action}
      siteUrl={SITE}
      {...props}
    />,
  );
  return { ...utils, calls: rec.calls };
}

const noop: ListActionFn = async () => null;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else setClipboard(undefined);
});

describe("ShareListPanel: states", () => {
  test("save_for_later: disabled state with explanation, no form, no link", () => {
    const { container } = setup({ kind: "save_for_later", isPublic: true, shareToken: TOKEN });
    expect(screen.getByText(SAVE_FOR_LATER_SHARE_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share this list" })).toBeDisabled();
    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  test("private list never renders the link, even if a token is passed", () => {
    const html = renderToStaticMarkup(
      <ShareListPanel listId="L1" listName="Birthday" kind="wishlist" isPublic={false} shareToken={TOKEN} action={noop} siteUrl={SITE} />,
    );
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("/lists/shared/");
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain('type="hidden" name="listId" value="L1"');
    expect(html).toContain('type="hidden" name="mode" value="enable"');
    expect(html).toContain("Share this list");
  });

  test("public static markup (no JS): readonly link, rotate form, checkbox-guarded disable form, no JS-only controls", () => {
    const html = renderToStaticMarkup(
      <ShareListPanel listId="L1" listName="Birthday" kind="wishlist" isPublic shareToken={TOKEN} action={noop} siteUrl={SITE} />,
    );
    expect(html).toContain(`value="${SITE}/lists/shared/${TOKEN}"`);
    expect(html).toMatch(/readOnly=""|readonly=""/);
    expect(html.match(/<form/g)).toHaveLength(2);
    expect(html).toContain('name="mode" value="rotate"');
    expect(html).toContain('name="mode" value="disable"');
    expect(html).toMatch(/name="confirm"[^>]*value="yes"|value="yes"[^>]*name="confirm"/);
    expect(html).toContain('required=""');
    expect(html).toContain(STOP_SHARING_CONFIRM_LABEL);
    expect(html).not.toContain("Copy link");
    expect(html).not.toContain("<dialog");
  });

  test("hostile list name is text", () => {
    const html = renderToStaticMarkup(
      <ShareListPanel listId="L1" listName={'<img src=x onerror="1">'} kind="wishlist" isPublic={false} shareToken={null} action={noop} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
  });

  test("siteUrl trailing slashes are trimmed; default uses the configured site URL", () => {
    expect(shareUrlFor("https://a.example/", "/lists/shared/x")).toBe("https://a.example/lists/shared/x");
    setup({ siteUrl: undefined });
    const input = screen.getByRole("textbox", { name: "Link to this list" });
    expect((input as HTMLInputElement).value).toMatch(/^https?:\/\/.+\/lists\/shared\/tok_ABCdef123$/);
  });

  test("safeSiteBase accepts http(s) origins (+ base path) and rejects everything else (D-T60-3)", () => {
    expect(safeSiteBase("https://a.example")).toBe("https://a.example");
    expect(safeSiteBase(" http://a.example/store/// ")).toBe("http://a.example/store");
    expect(safeSiteBase("https://a.example/?q=1#h")).toBe("https://a.example");
    for (const bad of [
      undefined,
      "",
      "   ",
      "javascript:alert(1)//",
      "data:text/html,x",
      "//evil.example",
      "/relative",
      "ftp://a.example",
      "https://user:pw@a.example",
      "https://user@a.example",
      "not a url",
    ]) {
      expect(safeSiteBase(bad)).toBeNull();
    }
  });

  test("hostile siteUrl falls back to the configured site URL in the rendered link", () => {
    for (const bad of ["javascript:alert(1)//", "//evil.example", "data:text/html,x", "https://u:p@a.example"]) {
      const { unmount } = setup({ siteUrl: bad });
      const value = (screen.getByRole("textbox", { name: "Link to this list" }) as HTMLInputElement).value;
      expect(value).toMatch(/^https?:\/\/[^/@]+(\/[^@]*)?\/lists\/shared\/tok_ABCdef123$/);
      expect(value).not.toMatch(/javascript:|data:|evil|u:p@/);
      unmount();
    }
  });
});

describe("ShareListPanel: with JS", () => {
  test("enable: posts listId + mode, then shows and focuses the link", async () => {
    const { calls } = setup({ isPublic: false, shareToken: null }, [sharing("/lists/shared/newTok", "Sharing is on.")]);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share this list" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ listId: "L1", mode: "enable" });
    const input = await screen.findByRole("textbox", { name: "Link to this list" });
    expect(input).toHaveValue(`${SITE}/lists/shared/newTok`);
    expect(input).toHaveAttribute("readonly");
    await waitFor(() => expectFocused(input));
    expect(screen.getByTestId("share-status")).toHaveTextContent("Sharing is on.");
  });

  test("rotate: posts mode rotate and shows the new link", async () => {
    const { calls } = setup({}, [sharing("/lists/shared/rotated", "A new link was created.")]);
    fireEvent.click(screen.getByRole("button", { name: "Get a new link" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ listId: "L1", mode: "rotate" });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Link to this list" })).toHaveValue(`${SITE}/lists/shared/rotated`),
    );
  });

  test("stop sharing opens a confirm dialog; Cancel posts nothing", async () => {
    const { calls } = setup();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Stop sharing this list?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(calls).toHaveLength(0);
  });

  test("confirming disables: posts mode disable, link disappears, Share button focused", async () => {
    const { calls, container } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ listId: "L1", mode: "disable", confirm: "yes" });
    const share = await screen.findByRole("button", { name: "Share this list" });
    expect(container.innerHTML).not.toContain("/lists/shared/");
    await waitFor(() => expectFocused(share));
    expect(screen.getByTestId("share-status")).toHaveTextContent("Sharing is off.");
  });

  test("Copy link uses the clipboard API and announces", async () => {
    const written: string[] = [];
    setClipboard({ writeText: async (text: string) => void written.push(text) });
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(written).toEqual([`${SITE}/lists/shared/${TOKEN}`]);
    expect(screen.getByTestId("share-status")).toHaveTextContent(LINK_COPIED_MESSAGE);
    expect(screen.getByTestId("share-status")).toHaveAttribute("aria-live", "polite");
  });

  test.each([
    ["missing", undefined],
    ["rejecting", { writeText: async () => Promise.reject(new Error("denied")) }],
  ])("Copy link with %s clipboard falls back to the selected readonly field", async (_label, clipboard) => {
    setClipboard(clipboard);
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    const input = screen.getByRole("textbox", { name: "Link to this list" });
    expectFocused(input);
    expect(screen.getByTestId("share-status")).toHaveTextContent(COPY_FALLBACK_MESSAGE);
  });

  test("errors go to role=alert", async () => {
    setup({}, [{ ok: false, error: appError("FORBIDDEN", "This list can't be shared."), message: "This list can't be shared." }]);
    fireEvent.click(screen.getByRole("button", { name: "Get a new link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This list can't be shared.");
    // Link unchanged after a failure.
    expect(screen.getByRole("textbox", { name: "Link to this list" })).toHaveValue(`${SITE}/lists/shared/${TOKEN}`);
  });

  test("props re-sync: server turning sharing off hides the link", () => {
    const { rerender } = setup();
    rerender(
      <ShareListPanel listId="L1" listName="Birthday" kind="wishlist" isPublic={false} shareToken={null} action={noop} siteUrl={SITE} />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("keyboard: controls are native buttons; heading names the region", () => {
    setup();
    expect(screen.getByRole("region", { name: "Share Birthday" })).toBeInTheDocument();
    for (const b of screen.getAllByRole("button")) expect(b.tagName).toBe("BUTTON");
  });
});
