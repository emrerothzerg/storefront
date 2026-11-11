/// <reference lib="dom" />
// Detects a React async action (form action, useActionState dispatch,
// startTransition(async ...)) that a test file left pending forever.
//
// Why: React 19 entangles every transition that starts while ANY async action
// is still pending, and the entanglement is module-global in react-dom. bun
// test runs many files in one process with one react-dom instance, so a single
// never-settled action (e.g. a controlled promise that is never resolved at
// the end of a test) makes every later form action in that process wait
// forever. Those tests then fail at the Testing Library waitFor/findBy timeout
// (about 1,000 ms) in files that are innocent. The leak cannot be undone from
// outside (the pending promise belongs to the test), so the preload reports
// which file caused it and the sharded runner lists it in its summary.
import { act, createElement, useEffect, useTransition } from "react";
import { createRoot } from "react-dom/client";

/** Marker printed to stderr; scripts/test-sharded.ts greps for it. */
export const LEAK_MARKER = "[test-setup] LEAKED-REACT-ACTION";

const SETTLE_POLL_MS = 25;

interface ProbeProps {
  readonly onPendingChange: (pending: boolean) => void;
}

function Probe({ onPendingChange }: ProbeProps) {
  const [isPending, startTransition] = useTransition();
  useEffect(() => {
    startTransition(async () => {});
  }, []);
  useEffect(() => {
    onPendingChange(isPending);
  }, [isPending, onPendingChange]);
  return null;
}

/**
 * Starts an empty async transition in a detached root and reports whether it
 * settles within `timeoutMs`. Healthy process: settles inside the first act().
 * Entangled with a leaked action: stays pending until the timeout.
 */
export async function asyncActionsSettle(timeoutMs: number): Promise<boolean> {
  const host = document.createElement("div");
  const root = createRoot(host);
  let pending = true;
  const onPendingChange = (value: boolean) => {
    pending = value;
  };
  try {
    await act(async () => {
      root.render(createElement(Probe, { onPendingChange }));
    });
    const deadline = Date.now() + timeoutMs;
    while (pending && Date.now() < deadline) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      });
    }
    return !pending;
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
}

/** Relative path of a test file for messages. */
export function displayPath(file: string, cwd: string = process.cwd()): string {
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}

export function leakMessage(file: string): string {
  return (
    `${LEAK_MARKER} ${displayPath(file)}: a React async action (form action / useActionState / ` +
    `startTransition(async)) was still pending after this file's tests ended. React entangles every later ` +
    `transition with it, so form tests that run after this file in the same bun process will time out. ` +
    `Resolve or reject every controlled action promise before each test ends.`
  );
}
