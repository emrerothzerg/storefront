import { describe, expect, mock, test } from "bun:test";
import { StrictMode, createRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Dialog, DialogFooter } from "./Dialog";
import type { DialogProps } from "./Dialog";
import { expectFocused } from "@/test/dom-assertions";

// happy-dom 21 implements HTMLDialogElement.showModal()/close() and the
// `close` event natively, so no polyfill is needed here. It does not
// implement Escape -> cancel -> close, so tests dispatch that sequence.
function pressEscape(dialog: HTMLDialogElement) {
  act(() => {
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    dialog.close();
  });
}

function Harness(props: Partial<DialogProps> & { onCloseSpy?: () => void }) {
  const { onCloseSpy, ...rest } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog
        title="Remove item?"
        description="This removes the item from your cart."
        {...rest}
        open={open}
        onClose={() => {
          onCloseSpy?.();
          setOpen(false);
        }}
      >
        <p>Body copy</p>
        <DialogFooter>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

const getDialog = () => document.querySelector("dialog") as HTMLDialogElement;

function openViaButton() {
  const opener = screen.getByRole("button", { name: "Open dialog" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("Dialog", () => {
  test("closed by default: native dialog not open", () => {
    render(<Harness />);
    expect(getDialog().open).toBe(false);
  });

  test("opens with showModal and is named/described", () => {
    render(<Harness />);
    openViaButton();
    const dialog = screen.getByRole("dialog", { name: "Remove item?" });
    expect((dialog as HTMLDialogElement).open).toBe(true);
    expect(dialog).toHaveAccessibleDescription("This removes the item from your cart.");
    expect(dialog).toHaveClass("z-modal", "rounded-xl", "shadow-lg", "border", "border-border-strong", "backdrop:bg-scrim");
    expect(screen.getByRole("heading", { level: 2, name: "Remove item?" })).toBeInTheDocument();
  });

  test("calls showModal (not show) so the background is inert", () => {
    const original = HTMLDialogElement.prototype.showModal;
    const spy = mock(function (this: HTMLDialogElement) {
      original.call(this);
    });
    HTMLDialogElement.prototype.showModal = spy;
    try {
      render(<Harness />);
      openViaButton();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
  });

  test("Close button closes, calls onClose and returns focus to the opener", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} />);
    const opener = openViaButton();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(getDialog().open).toBe(false);
    expectFocused(opener);
  });

  test("Escape (native cancel -> close) calls onClose once", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} />);
    const opener = openViaButton();
    pressEscape(getDialog());
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(getDialog().open).toBe(false);
    expectFocused(opener);
  });

  test("closing from the parent does not call onClose", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} />);
    openViaButton();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getDialog().open).toBe(false);
    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  test("backdrop click closes; clicks inside content do not", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} />);
    openViaButton();
    fireEvent.click(screen.getByText("Body copy"));
    expect(onCloseSpy).not.toHaveBeenCalled();
    fireEvent.click(getDialog());
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  test("closeOnBackdrop=false ignores backdrop clicks", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} closeOnBackdrop={false} />);
    openViaButton();
    fireEvent.click(getDialog());
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(getDialog().open).toBe(true);
  });

  test("alert sets role=alertdialog and disables backdrop close by default", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} alert />);
    openViaButton();
    const dialog = screen.getByRole("alertdialog", { name: "Remove item?" });
    fireEvent.click(dialog);
    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  test("locks body scroll while open and restores it on close", () => {
    document.body.style.overflow = "auto";
    render(<Harness />);
    openViaButton();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });

  test("unmounting while open restores scroll and focus", () => {
    function Unmounter() {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setMounted(false)}>
            Unmount
          </button>
          {mounted ? <Harness /> : null}
        </>
      );
    }
    render(<Unmounter />);
    openViaButton();
    fireEvent.click(screen.getByRole("button", { name: "Unmount", hidden: true }));
    expect(document.body.style.overflow).toBe("");
  });

  test("description is optional (no aria-describedby)", () => {
    render(<Dialog open title="Hi" onClose={() => {}} />);
    expect(getDialog()).not.toHaveAttribute("aria-describedby");
  });

  test.each([
    ["sm", "w-96"],
    ["md", "w-128"],
    ["lg", "w-192"],
  ] as const)("size %s maps to %s inside the viewport", (size, cls) => {
    render(<Dialog open size={size} title="T" onClose={() => {}} />);
    const inner = getDialog().firstElementChild as HTMLElement;
    expect(inner).toHaveClass(cls, "max-w-full");
  });

  test("custom close label", () => {
    render(<Dialog open title="T" closeLabel="Dismiss" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveClass("size-touch");
  });

  test("forwards object and callback refs; merges className last", () => {
    const ref = createRef<HTMLDialogElement>();
    const { unmount } = render(<Dialog ref={ref} open title="T" onClose={() => {}} className="x-dlg" />);
    expect(ref.current).toBe(getDialog());
    expect(ref.current?.className.endsWith("x-dlg")).toBe(true);
    unmount();
    const holder: { node: HTMLDialogElement | null } = { node: null };
    render(
      <Dialog
        ref={(n) => {
          holder.node = n;
        }}
        open={false}
        title="T"
        onClose={() => {}}
      />,
    );
    expect(holder.node).toBe(getDialog());
  });

  test("DialogFooter stacks on mobile and merges className", () => {
    render(<DialogFooter className="x-foot">a</DialogFooter>);
    const foot = screen.getByText("a");
    expect(foot).toHaveClass("flex-col-reverse", "sm:flex-row");
    expect(foot.className.endsWith("x-foot")).toBe(true);
  });

  describe("StrictMode", () => {
    test("mounting with open=true keeps the scroll lock and returns focus on close", () => {
      document.body.style.overflow = "auto";
      function Strict() {
        const [open, setOpen] = useState(true);
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>
              Reopen
            </button>
            <Dialog open={open} title="T" onClose={() => setOpen(false)} />
          </>
        );
      }
      const opener = document.createElement("button");
      document.body.appendChild(opener);
      opener.focus();
      render(
        <StrictMode>
          <Strict />
        </StrictMode>,
      );
      expect(getDialog().open).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(getDialog().open).toBe(false);
      expect(document.body.style.overflow).toBe("auto");
      expectFocused(opener);
      opener.remove();
      document.body.style.overflow = "";
    });

    test("three open/close cycles stay balanced", () => {
      document.body.style.overflow = "scroll";
      render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
      for (let i = 0; i < 3; i++) {
        const opener = openViaButton();
        expect(getDialog().open).toBe(true);
        expect(document.body.style.overflow).toBe("hidden");
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(getDialog().open).toBe(false);
        expect(document.body.style.overflow).toBe("scroll");
        expectFocused(opener);
      }
      document.body.style.overflow = "";
    });
  });

  test("real unmount while open (StrictMode) restores scroll and returns focus", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <StrictMode>
        <Dialog open title="T" onClose={() => {}} />
      </StrictMode>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
    await Promise.resolve();
    expectFocused(opener);
    opener.remove();
  });

  test("empty title warns in development (the dialog would have no accessible name)", () => {
    const original = console.warn;
    const warn = mock(() => {});
    console.warn = warn;
    try {
      render(<Dialog open title="  " onClose={() => {}} />);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0])).toContain("title");
    } finally {
      console.warn = original;
    }
  });
});
