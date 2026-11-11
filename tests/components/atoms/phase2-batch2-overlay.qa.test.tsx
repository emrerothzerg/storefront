// QA (QA-W0-D2, criteria 6, 7, 12): Dialog, Toast, and cross-cutting source checks for batch 2.
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { StrictMode, act, createRef, useEffect, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Dialog, DialogFooter } from "@/components/atoms/Dialog";
import {
  DEFAULT_TOAST_DURATION_MS,
  ToastProvider,
  ToastViewport,
  useToast,
  type ToastApi,
  type ToastOptions,
} from "@/components/atoms/Toast";
import { expectFocused } from "@/test/dom-assertions";

// ------------------------------------------------------------------ 6 Dialog
function pressEscape(dialog: HTMLDialogElement) {
  // happy-dom has showModal/close but no Escape -> cancel -> close; dispatch the browser sequence.
  act(() => {
    const proceed = dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    if (proceed) dialog.close();
  });
}

function DialogHarness(props: {
  alert?: boolean;
  closeOnBackdrop?: boolean;
  description?: string;
  onCloseSpy?: () => void;
  ignoreClose?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        title="Remove item?"
        description={props.description}
        alert={props.alert}
        closeOnBackdrop={props.closeOnBackdrop}
        onClose={() => {
          props.onCloseSpy?.();
          if (!props.ignoreClose) setOpen(false);
        }}
      >
        <p>Body</p>
        <DialogFooter>
          <button type="button">Confirm</button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

const dlg = () => document.querySelector("dialog") as HTMLDialogElement;

function openViaKeyboard() {
  const opener = screen.getByRole("button", { name: "Open" });
  act(() => opener.focus());
  fireEvent.click(opener);
  return opener;
}

describe("Dialog (criterion 6)", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  test("native <dialog> opened with showModal(); title -> aria-labelledby; description -> aria-describedby", () => {
    render(<DialogHarness description="This removes it from your cart." />);
    expect(dlg().open).toBe(false);
    openViaKeyboard();
    const d = dlg();
    expect(d.tagName).toBe("DIALOG");
    expect(d.open).toBe(true);
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(document.getElementById(d.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Remove item?");
    expect(document.getElementById(d.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "This removes it from your cart.",
    );
    expect(screen.getByRole("dialog", { name: "Remove item?" })).toBe(d);
    expect(d.className.split(" ")).toContain("z-modal");
    expect(d).not.toHaveAttribute("role");
  });

  test("no description -> no aria-describedby", () => {
    render(<DialogHarness />);
    openViaKeyboard();
    expect(dlg()).not.toHaveAttribute("aria-describedby");
  });

  test("Escape (cancel) closes once, restores body overflow and returns focus to the opener", () => {
    const onClose = mock(() => {});
    document.body.style.overflow = "scroll";
    render(<DialogHarness onCloseSpy={onClose} />);
    const opener = openViaKeyboard();
    expect(document.body.style.overflow).toBe("hidden");
    pressEscape(dlg());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dlg().open).toBe(false);
    expect(document.body.style.overflow).toBe("scroll");
    expectFocused(opener);
  });

  test("Close button: named 'Close', 44px, closes and returns focus", () => {
    const onClose = mock(() => {});
    render(<DialogHarness onCloseSpy={onClose} />);
    const opener = openViaKeyboard();
    const close = within(dlg()).getByRole("button", { name: "Close" });
    expect(close.className.split(" ")).toContain("size-touch");
    expect(close).toHaveAttribute("type", "button");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dlg().open).toBe(false);
    expectFocused(opener);
    expect(document.body.style.overflow).toBe("");
  });

  test("backdrop click closes; clicks inside content do not", () => {
    const onClose = mock(() => {});
    render(<DialogHarness onCloseSpy={onClose} />);
    openViaKeyboard();
    fireEvent.click(screen.getByText("Body"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dlg());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("closeOnBackdrop=false: backdrop click ignored, Escape still closes", () => {
    const onClose = mock(() => {});
    render(<DialogHarness closeOnBackdrop={false} onCloseSpy={onClose} />);
    openViaKeyboard();
    fireEvent.click(dlg());
    expect(onClose).not.toHaveBeenCalled();
    pressEscape(dlg());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("alert: role=alertdialog, named by title, backdrop click ignored", () => {
    const onClose = mock(() => {});
    render(<DialogHarness alert onCloseSpy={onClose} />);
    openViaKeyboard();
    expect(screen.getByRole("alertdialog", { name: "Remove item?" })).toBe(dlg());
    fireEvent.click(dlg());
    expect(onClose).not.toHaveBeenCalled();
  });

  test("closing via the open prop does not call onClose (no double notification)", () => {
    const onClose = mock(() => {});
    function P() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>
            ext
          </button>
          <Dialog open={open} title="t" onClose={onClose} />
        </>
      );
    }
    render(<P />);
    expect(dlg().open).toBe(true);
    act(() => dlg().querySelector("button")?.blur());
    fireEvent.click(screen.getByText("ext", { selector: "button" }));
    expect(dlg().open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("unmount while open restores scroll lock; opener detached does not throw", () => {
    document.body.style.overflow = "auto";
    function P({ show }: { show: boolean }) {
      return show ? <Dialog open title="t" onClose={() => {}} /> : null;
    }
    const { rerender } = render(<P show />);
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<P show={false} />);
    expect(document.body.style.overflow).toBe("auto");
  });

  test("nested/stacked dialogs restore overflow in order", () => {
    document.body.style.overflow = "visible";
    function P() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(false);
      return (
        <>
          <Dialog open={a} title="A" onClose={() => setA(false)}>
            <button type="button" onClick={() => setB(true)}>
              openB
            </button>
          </Dialog>
          <Dialog open={b} title="B" onClose={() => setB(false)} />
        </>
      );
    }
    render(<P />);
    fireEvent.click(screen.getByText("openB"));
    const [, bEl] = Array.from(document.querySelectorAll("dialog"));
    fireEvent.click(within(bEl as HTMLElement).getByRole("button", { name: "Close" }));
    expect(document.body.style.overflow).toBe("hidden");
    const [aEl] = Array.from(document.querySelectorAll("dialog"));
    fireEvent.click(within(aEl as HTMLElement).getByRole("button", { name: "Close" }));
    expect(document.body.style.overflow).toBe("visible");
  });

  test("closeLabel override; className merged last; ref forwarded; DialogFooter ref/className", () => {
    const ref = createRef<HTMLDialogElement>();
    const fref = createRef<HTMLDivElement>();
    render(
      <Dialog open title="t" onClose={() => {}} ref={ref} className="qa-last" closeLabel="Close cart">
        <DialogFooter ref={fref} className="qa-foot">
          x
        </DialogFooter>
      </Dialog>,
    );
    expect(ref.current?.tagName).toBe("DIALOG");
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
    expect(screen.getByRole("button", { name: "Close cart" })).toBeInTheDocument();
    expect(fref.current?.className.split(" ").at(-1)).toBe("qa-foot");
  });

  // D2-8 was reproduced against the 17:24 Dialog and fixed in the 17:29 revision; kept as regression tests.
  test("StrictMode: mounted with open=true keeps the scroll lock; close restores it and returns focus", () => {
    document.body.style.overflow = "clip";
    function P() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Opener
          </button>
          {open ? <Dialog open title="t" onClose={() => setOpen(false)} /> : null}
        </>
      );
    }
    render(
      <StrictMode>
        <P />
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    act(() => opener.focus());
    fireEvent.click(opener);
    expect(dlg().open).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    pressEscape(dlg());
    expect(document.body.style.overflow).toBe("clip");
    expectFocused(opener);
  });

  test("real unmount while open returns focus to the opener (after microtask)", async () => {
    function P({ show }: { show: boolean }) {
      return (
        <>
          <button type="button">Op</button>
          {show ? <Dialog open title="t" onClose={() => {}} /> : null}
        </>
      );
    }
    const { rerender } = render(<P show={false} />);
    const op = screen.getByRole("button", { name: "Op" });
    act(() => op.focus());
    rerender(<P show />);
    act(() => (dlg().querySelector("button") as HTMLButtonElement).focus());
    rerender(<P show={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expectFocused(op);
  });

  // Was a defect at first read (bg-surface-page/80); fixed by the 17:24 token adoption.
  test("backdrop uses the scrim token (declared on ::backdrop for older engines)", () => {
    render(<Dialog open title="t" onClose={() => {}} />);
    expect(dlg().className.split(" ")).toContain("backdrop:bg-scrim");
  });
});

// ------------------------------------------------------------------- 7 Toast
let api: ToastApi | null = null;
function Grab() {
  const t = useToast();
  useEffect(() => {
    api = t;
  });
  return null;
}
const push = (o: ToastOptions) => {
  let id = "";
  act(() => {
    id = api!.toast(o);
  });
  return id;
};

describe("Toast (criterion 7)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    api = null;
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const advance = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  const regions = () => ({
    polite: document.querySelector('[role="status"][aria-live="polite"]') as HTMLElement,
    urgent: document.querySelector('[role="alert"]') as HTMLElement,
  });

  test("useToast outside provider throws a clear error", () => {
    function Bad() {
      useToast();
      return null;
    }
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });

  test("both live regions exist (empty) before any toast; viewport is z-toast, labelled", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    const { polite, urgent } = regions();
    expect(polite).not.toBeNull();
    expect(urgent).not.toBeNull();
    expect(polite.childElementCount).toBe(0);
    const vp = screen.getByRole("region", { name: "Notifications" });
    expect(vp.className.split(" ")).toContain("z-toast");
  });

  test("info/success go to the polite region, warning/danger to role=alert; tone prefix for SR", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    const addedId = push({ title: "Added", tone: "success" });
    push({ title: "FYI" });
    push({ title: "Low stock", tone: "warning" });
    const { polite, urgent } = regions();
    const para = (root: HTMLElement, text: string) =>
      within(root).getByText((_c, el) => el?.tagName === "P" && el.textContent === text);
    expect(para(polite, "Success: Added")).toBeInTheDocument();
    expect(para(polite, "Info: FYI")).toBeInTheDocument();
    expect(para(urgent, "Warning: Low stock")).toBeInTheDocument();
    expect(within(polite).queryByText((_, el) => el?.textContent === "Warning: Low stock")).toBeNull();
    const sr = within(polite).getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Success: ");
    expect(sr.className.split(" ")).toContain("sr-only");
    act(() => api!.dismiss(addedId)); // free a visible slot (max 3)
    push({ title: "Failed", tone: "danger" });
    expect(para(urgent, "Error: Failed")).toBeInTheDocument();
  });

  test("max 3 visible; the 4th queues and appears when one is dismissed", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    const ids = [1, 2, 3, 4].map((n) => push({ title: `T${n}`, tone: "danger" }));
    expect(document.querySelectorAll("[data-toast-id]")).toHaveLength(3);
    expect(screen.queryByText("T4")).toBeNull();
    act(() => api!.dismiss(ids[0]!));
    expect(screen.getByText("T4")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-toast-id]")).toHaveLength(3);
  });

  test("auto-dismiss: info/success after 6s; warning/danger never by default", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    expect(DEFAULT_TOAST_DURATION_MS).toBe(6000);
    push({ title: "I" });
    push({ title: "S", tone: "success" });
    push({ title: "W", tone: "warning" });
    advance(5999);
    expect(screen.getByText("I")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("I")).toBeNull();
    expect(screen.queryByText("S")).toBeNull();
    push({ title: "D", tone: "danger" });
    advance(10 * 60_000);
    expect(screen.getByText("W")).toBeInTheDocument();
    expect(screen.getByText("D")).toBeInTheDocument();
  });

  test("queued toast's timer starts only when it becomes visible", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    [1, 2, 3, 4].forEach((n) => push({ title: `Q${n}` }));
    advance(6000);
    expect(screen.getByText("Q4")).toBeInTheDocument();
    advance(5999);
    expect(screen.getByText("Q4")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Q4")).toBeNull();
  });

  test("pause on hover and on focus; full timer after leaving", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    push({ title: "Hover me" });
    const item = document.querySelector("[data-toast-id]") as HTMLElement;
    advance(3000);
    fireEvent.mouseEnter(item);
    advance(60_000);
    expect(screen.getByText("Hover me")).toBeInTheDocument();
    fireEvent.mouseLeave(item);
    advance(5999);
    expect(screen.getByText("Hover me")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Hover me")).toBeNull();

    push({ title: "Focus me" });
    const dismissBtn = screen.getByRole("button", { name: "Dismiss notification: Focus me" });
    act(() => dismissBtn.focus());
    advance(60_000);
    expect(screen.getByText("Focus me")).toBeInTheDocument();
  });

  test("keyboard-only: dismiss button (44px) and Escape inside the toast", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    push({ title: "One", tone: "danger" });
    push({ title: "Two", tone: "danger" });
    const btn = screen.getByRole("button", { name: "Dismiss notification: One" });
    expect(btn.className.split(" ")).toContain("size-touch");
    fireEvent.click(btn);
    expect(screen.queryByText("One")).toBeNull();
    const two = screen.getByRole("button", { name: "Dismiss notification: Two" });
    act(() => two.focus());
    fireEvent.keyDown(two, { key: "Escape" });
    expect(screen.queryByText("Two")).toBeNull();
  });

  test("action button runs the callback and dismisses", () => {
    const onClick = mock(() => {});
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    push({ title: "Added", tone: "success", action: { label: "View cart", onClick } });
    fireEvent.click(screen.getByRole("button", { name: "View cart" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Added")).toBeNull();
  });

  test("reduced motion: no animation/transition utilities outside motion-safe in toast markup", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    push({ title: "m", tone: "success", action: { label: "a", onClick: () => {} } });
    const vp = screen.getByRole("region", { name: "Notifications" });
    const toastEl = vp.querySelector("[data-toast-id]") as HTMLElement;
    const classes = [toastEl, ...Array.from(toastEl.querySelectorAll("*"))].flatMap((e) =>
      (e.getAttribute("class") ?? "").split(/\s+/),
    );
    expect(classes.filter((c) => /^(animate-|transition$|transition-(all|transform|opacity))/.test(c))).toEqual([]);
  });

  test("dismiss of unknown id is a no-op; durationMs null keeps info; explicit duration honoured", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    act(() => api!.dismiss("nope"));
    push({ title: "Sticky", durationMs: null });
    push({ title: "Quick", durationMs: 1000 });
    advance(1000);
    expect(screen.queryByText("Quick")).toBeNull();
    advance(60_000);
    expect(screen.getByText("Sticky")).toBeInTheDocument();
  });

  test("10k toasts: only maxVisible rendered; maxVisible 0/-1 clamps to 1; custom viewport placement", () => {
    const { unmount } = render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    act(() => {
      for (let i = 0; i < 10_000; i++) api!.toast({ title: `n${i}`, tone: "danger" });
    });
    expect(document.querySelectorAll("[data-toast-id]")).toHaveLength(3);
    unmount();
    for (const maxVisible of [0, -1]) {
      const r = render(
        <ToastProvider maxVisible={maxVisible}>
          <Grab />
        </ToastProvider>,
      );
      push({ title: "a", tone: "danger" });
      push({ title: "b", tone: "danger" });
      expect(document.querySelectorAll("[data-toast-id]")).toHaveLength(1);
      r.unmount();
    }
    const ref = createRef<HTMLDivElement>();
    render(
      <ToastProvider viewport={false}>
        <Grab />
        <ToastViewport ref={ref} className="qa-last" label="Alerts" />
      </ToastProvider>,
    );
    expect(screen.getAllByRole("region", { name: "Alerts" })).toHaveLength(1);
    expect(ref.current?.className.split(" ").at(-1)).toBe("qa-last");
  });

  // D2-10: maxVisible=NaN -> Math.max(1, NaN) = NaN -> slice(0, NaN) = [] -> no toast ever shows.
  test("DEFECT D2-10: maxVisible=NaN still shows toasts", () => {
    render(
      <ToastProvider maxVisible={Number.NaN}>
        <Grab />
      </ToastProvider>,
    );
    push({ title: "visible?", tone: "danger" });
    expect(screen.queryByText("visible?")).not.toBeNull();
  });

  // D2-11: durationMs Infinity (or anything > 2^31-1 ms, or negative/NaN) is passed straight to
  // setTimeout, which clamps it to ~1ms: the toast vanishes immediately instead of persisting.
  test("DEFECT D2-11: durationMs=Infinity does not dismiss immediately", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    push({ title: "forever", durationMs: Number.POSITIVE_INFINITY });
    advance(50);
    expect(screen.queryByText("forever")).not.toBeNull();
  });
});

// ------------------------------------------------------------ 12 cross-cutting
const ATOMS = join(import.meta.dir, "../../../src/components/atoms");
const FOLDERS = [
  "Skeleton",
  "ProgressBar",
  "Table",
  "Tabs",
  "Tooltip",
  "Disclosure",
  "Dialog",
  "Toast",
  "Breadcrumb",
  "Pagination",
  "SearchField",
];

function sources(includeTests: boolean): Array<[string, string]> {
  return FOLDERS.flatMap((f) =>
    readdirSync(join(ATOMS, f))
      .filter((n) => /\.tsx?$/.test(n) && (includeTests || !n.includes(".test.")))
      .map((n) => [`${f}/${n}`, readFileSync(join(ATOMS, f, n), "utf8")] as [string, string]),
  );
}

describe("Cross-cutting (criterion 12)", () => {
  test("each folder has X.tsx, X.test.tsx, index.ts", () => {
    for (const f of FOLDERS) {
      for (const n of [`${f}.tsx`, `${f}.test.tsx`, "index.ts"]) {
        expect(statSync(join(ATOMS, f, n)).isFile()).toBe(true);
      }
    }
  });

  test("no any / @ts-ignore / @ts-expect-error / eslint-disable (sources and tests)", () => {
    const hits = sources(true).flatMap(([file, src]) =>
      src
        .split("\n")
        .map((line, i) => [file, i + 1, line] as const)
        .filter(([, , l]) => /(:\s*any\b|<any>|\bas any\b|any\[\]|@ts-ignore|@ts-expect-error|eslint-disable)/.test(l)),
    );
    expect(hits).toEqual([]);
  });

  test("no raw hex, no arbitrary values, no bare z-<n>, no palette, no outline-none", () => {
    const bad = /#[0-9a-fA-F]{3,8}\b|[a-z-]+-\[[^\]]+\]|\bz-\d+\b|\b(bg|text|border)-(gray|slate|zinc|neutral|stone|red|blue|green|white|black)\b|outline-none/;
    const hits = sources(false).flatMap(([file, src]) =>
      src
        .split("\n")
        .map((line, i) => [file, i + 1, line.trim()] as const)
        .filter(([, , l]) => !l.startsWith("//") && !l.startsWith("*") && bad.test(l)),
    );
    expect(hits).toEqual([]);
  });

  test("the only style= in batch 2 is ProgressBar's fill width", () => {
    const hits = sources(false).flatMap(([file, src]) =>
      src
        .split("\n")
        .map((line, i) => `${file}:${i + 1}:${line.trim()}`)
        .filter((l) => /\bstyle=\{/.test(l)),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^ProgressBar\/ProgressBar\.tsx:\d+:style=\{indeterminate \? undefined : \{ width: `\$\{percent\}%` \}\}$/);
  });

  test("imports only react, react-dom, next/link and sibling atoms (no new dependencies)", () => {
    const allowed = new Set(["react", "next/link"]);
    const external = sources(false).flatMap(([file, src]) =>
      [...src.matchAll(/from "([^"]+)"/g)]
        .map((m) => m[1]!)
        .filter((s) => !s.startsWith(".") && !allowed.has(s))
        .map((s) => `${file}: ${s}`),
    );
    expect(external).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["next", "react", "react-dom"]);
  });

  test("every component signature destructures ref and merges className last in its class list", () => {
    for (const [file, src] of sources(false)) {
      if (file.endsWith("index.ts")) continue;
      const exported = [...src.matchAll(/export function ([A-Z]\w*)\(\{([^}]*)\}/g)];
      for (const [, name, params] of exported) {
        if (name === "ToastProvider") continue; // context provider renders no element of its own
        expect({ name, hasRef: /\bref\b/.test(params!) }).toEqual({ name, hasRef: true });
      }
    }
  });
});
