import { describe, expect, mock, spyOn, test } from "bun:test";
import { StrictMode, createRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Drawer } from "./Drawer";
import type { DrawerProps } from "./Drawer";
import { expectFocused } from "@/test/dom-assertions";

// happy-dom 21 implements showModal()/close() and the `close` event, but not
// Escape -> `cancel`. Tests dispatch the cancellable `cancel` event the way a
// browser does and only close natively if it was not prevented.
function pressEscape(dialog: HTMLDialogElement) {
  act(() => {
    const event = new Event("cancel", { cancelable: true });
    const notPrevented = dialog.dispatchEvent(event);
    if (notPrevented) dialog.close();
  });
}

function Harness(props: Partial<DrawerProps> & { onCloseSpy?: () => void }) {
  const { onCloseSpy, ...rest } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open menu
      </button>
      <Drawer
        title="Shop by department"
        {...rest}
        open={open}
        onClose={() => {
          onCloseSpy?.();
          setOpen(false);
        }}
      >
        <a href="/electronics">Electronics</a>
      </Drawer>
    </>
  );
}

const getDialog = () => document.querySelector("dialog") as HTMLDialogElement;

function openViaButton() {
  const opener = screen.getByRole("button", { name: "Open menu" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("Drawer", () => {
  test("closed by default: dialog not open and not in the a11y tree", () => {
    render(<Harness />);
    expect(getDialog().open).toBe(false);
    expect(getDialog()).not.toHaveAttribute("open");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("opens with showModal, named by its title, z-modal", () => {
    const original = HTMLDialogElement.prototype.showModal;
    const spy = mock(function (this: HTMLDialogElement) {
      original.call(this);
    });
    HTMLDialogElement.prototype.showModal = spy;
    try {
      render(<Harness />);
      openViaButton();
      expect(spy).toHaveBeenCalledTimes(1);
      const dialog = screen.getByRole("dialog", { name: "Shop by department" });
      expect((dialog as HTMLDialogElement).open).toBe(true);
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveClass("z-modal", "open:flex", "shadow-lg", "backdrop:bg-scrim");
      expect(screen.getByRole("heading", { level: 2, name: "Shop by department" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Electronics" })).toBeInTheDocument();
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
  });

  test("Close button (Icon close, 44px) closes and returns focus to the opener", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} />);
    const opener = openViaButton();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveClass("size-touch");
    expect(close.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(close);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(getDialog().open).toBe(false);
    expectFocused(opener);
  });

  test("Escape (cancel event) requests close once and restores focus", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} />);
    const opener = openViaButton();
    pressEscape(getDialog());
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(getDialog().open).toBe(false);
    expectFocused(opener);
  });

  test("Escape is a request: a parent that keeps it open keeps it open", () => {
    const onClose = mock();
    render(<Drawer open title="Filters" onClose={onClose} />);
    pressEscape(getDialog());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getDialog().open).toBe(true);
  });

  test("native close (form method=dialog) notifies the parent", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} />);
    openViaButton();
    act(() => getDialog().close());
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  test("backdrop click closes; clicks inside the panel do not", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} />);
    openViaButton();
    fireEvent.click(screen.getByRole("heading", { name: "Shop by department" }));
    expect(onCloseSpy).not.toHaveBeenCalled();
    fireEvent.click(getDialog());
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(getDialog().open).toBe(false);
  });

  test("closeOnBackdrop=false ignores backdrop clicks", () => {
    const onCloseSpy = mock();
    render(<Harness onCloseSpy={onCloseSpy} closeOnBackdrop={false} />);
    openViaButton();
    fireEvent.click(getDialog());
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(getDialog().open).toBe(true);
  });

  test("locks body scroll while open and restores the previous value on close", () => {
    document.body.style.overflow = "scroll";
    render(<Harness />);
    openViaButton();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });

  test("unmounting while open restores scroll", () => {
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
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Unmount", hidden: true }));
    expect(document.body.style.overflow).toBe("");
  });

  test("open on mount shows the modal", () => {
    render(<Drawer open title="Menu" onClose={() => {}} />);
    expect(getDialog().open).toBe(true);
  });

  test.each([
    ["left", "left-0", "-translate-x-full", "starting:open:-translate-x-full"],
    ["right", "right-0", "translate-x-full", "starting:open:translate-x-full"],
    ["bottom", "bottom-0", "translate-y-full", "starting:open:translate-y-full"],
  ] as const)("side %s positions and slides from that edge", (side, edge, closed, start) => {
    render(<Drawer open side={side} title="T" onClose={() => {}} />);
    expect(getDialog()).toHaveAttribute("data-side", side);
    expect(getDialog()).toHaveClass(edge, closed, start, "max-w-full");
    // Visible edge facing the page (crisp panel edge against the scrim).
    const pageEdge = { left: "border-e", right: "border-s", bottom: "border-t" }[side];
    expect(getDialog()).toHaveClass(pageEdge, "border-border-strong", "shadow-lg");
  });

  test.each([
    ["left", "sm", "w-72"],
    ["right", "md", "w-80"],
    ["left", "lg", "w-96"],
    ["bottom", "sm", "max-h-1/2"],
    ["bottom", "md", "max-h-3/4"],
    ["bottom", "lg", "max-h-dvh"],
  ] as const)("side %s size %s -> %s", (side, size, cls) => {
    render(<Drawer open side={side} size={size} title="T" onClose={() => {}} />);
    expect(getDialog()).toHaveClass(cls);
  });

  test("slide transition uses Tailwind scale durations and is reduced-motion safe", () => {
    render(<Drawer open title="T" onClose={() => {}} />);
    expect(getDialog()).toHaveClass("duration-300", "motion-reduce:transition-none");
    expect(getDialog().className).not.toMatch(/\[/);
  });

  test("footer renders below the body only when given", () => {
    const { rerender } = render(<Drawer open title="Filters" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Show results" })).toBeNull();
    rerender(
      <Drawer
        open
        title="Filters"
        onClose={() => {}}
        footer={<button type="button">Show results</button>}
      >
        body
      </Drawer>,
    );
    expect(screen.getByRole("button", { name: "Show results" }).parentElement).toHaveClass(
      "border-t",
    );
  });

  test("custom close label", () => {
    render(<Drawer open title="T" closeLabel="Close menu" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Close menu" })).toBeInTheDocument();
  });

  test("forwards object and callback refs; merges className last; calls onClick", () => {
    const ref = createRef<HTMLDialogElement>();
    const onClick = mock();
    const { unmount } = render(
      <Drawer ref={ref} open title="T" onClose={() => {}} onClick={onClick} className="x-drawer" />,
    );
    expect(ref.current).toBe(getDialog());
    expect(ref.current?.className.endsWith("x-drawer")).toBe(true);
    fireEvent.click(screen.getByRole("heading", { name: "T" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();
    const holder: { node: HTMLDialogElement | null } = { node: null };
    render(
      <Drawer
        ref={(n) => {
          holder.node = n;
        }}
        open
        title="T"
        onClose={() => {}}
      />,
    );
    expect(holder.node).toBe(getDialog());
  });

  describe("StrictMode (effects run, clean up and re-run)", () => {
    test("mounted open keeps the scroll lock; closing restores it", () => {
      document.body.style.overflow = "auto";
      function Strict() {
        const [open, setOpen] = useState(true);
        return (
          <StrictMode>
            <Drawer open={open} title="Menu" onClose={() => setOpen(false)} />
          </StrictMode>
        );
      }
      render(<Strict />);
      expect(getDialog().open).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(getDialog().open).toBe(false);
      expect(document.body.style.overflow).toBe("auto");
      document.body.style.overflow = "";
    });

    test("three open/close cycles stay balanced and return focus each time", () => {
      document.body.style.overflow = "clip";
      render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
      for (let i = 0; i < 3; i += 1) {
        const opener = openViaButton();
        expect(getDialog().open).toBe(true);
        expect(document.body.style.overflow).toBe("hidden");
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(getDialog().open).toBe(false);
        expect(document.body.style.overflow).toBe("clip");
        expectFocused(opener);
      }
      document.body.style.overflow = "";
    });

    test("Escape under StrictMode restores scroll and focus", () => {
      render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
      const opener = openViaButton();
      pressEscape(getDialog());
      expect(getDialog().open).toBe(false);
      expect(document.body.style.overflow).toBe("");
      expectFocused(opener);
    });
  });

  describe("title must be non-empty", () => {
    test.each([[""], ["   "]])("title=%p logs a development warning", (title) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        render(<Drawer open={false} title={title} onClose={() => {}} />);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain("Drawer: `title` must be non-empty");
      } finally {
        warn.mockRestore();
      }
    });

    test("a real title does not warn", () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        render(<Drawer open={false} title="Filters" onClose={() => {}} />);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
