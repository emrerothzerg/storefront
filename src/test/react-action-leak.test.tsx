import { describe, expect, test } from "bun:test";
import { act, useEffect, useTransition } from "react";
import { render } from "@testing-library/react";
import { LEAK_MARKER, asyncActionsSettle, displayPath, leakMessage } from "./react-action-leak";

function StartsPendingAction({ until }: { readonly until: Promise<void> }) {
  const [, startTransition] = useTransition();
  useEffect(() => {
    startTransition(async () => {
      await until;
    });
  }, [until]);
  return null;
}

describe("asyncActionsSettle", () => {
  test("true when no async action is pending", async () => {
    expect(await asyncActionsSettle(200)).toBe(true);
  });

  test("false while another async action is pending, true again once it settles", async () => {
    let release: () => void = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = render(<StartsPendingAction until={until} />);
    try {
      expect(await asyncActionsSettle(60)).toBe(false);
    } finally {
      // Settle it inside the test so this file does not poison later files.
      await act(async () => release());
      view.unmount();
    }
    expect(await asyncActionsSettle(500)).toBe(true);
  });
});

describe("messages", () => {
  test("displayPath strips the working directory", () => {
    expect(displayPath("/repo/src/a.test.ts", "/repo")).toBe("src/a.test.ts");
    expect(displayPath("/elsewhere/a.test.ts", "/repo")).toBe("/elsewhere/a.test.ts");
  });

  test("leakMessage starts with the marker the sharded runner greps for", () => {
    const message = leakMessage(`${process.cwd()}/src/x/Form.test.tsx`);
    expect(message.startsWith(`${LEAK_MARKER} src/x/Form.test.tsx: `)).toBe(true);
    expect(message).toContain("Resolve or reject every controlled action promise");
  });
});
