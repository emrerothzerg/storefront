import { describe, expect, mock, test } from "bun:test";
import { StrictMode } from "react";
import { render } from "@testing-library/react";
import type { RecordViewBeacon, ViewActionState } from "@/components/molecules/_contracts/view-actions";
import { ViewTracker } from "./ViewTracker";

function beacon(impl?: () => Promise<ViewActionState>) {
  return mock<RecordViewBeacon>(impl ?? (async () => ({ ok: true, kind: "recorded" })));
}

describe("ViewTracker", () => {
  test("armed: calls the beacon once after mount with id and slug, renders nothing", () => {
    const recordView = beacon();
    const { container } = render(
      <ViewTracker productId="prod_a" productSlug="a" recorded={false} recordView={recordView} />,
    );
    expect(container.innerHTML).toBe("");
    expect(recordView).toHaveBeenCalledTimes(1);
    expect(recordView).toHaveBeenCalledWith({ productId: "prod_a", productSlug: "a" });
  });

  test("inert when the server already recorded the view", () => {
    const recordView = beacon();
    render(<ViewTracker productId="prod_a" productSlug="a" recorded recordView={recordView} />);
    expect(recordView).not.toHaveBeenCalled();
  });

  test("StrictMode double effects and re-renders still send once", () => {
    const recordView = beacon();
    const { rerender } = render(
      <StrictMode>
        <ViewTracker productId="prod_a" productSlug="a" recorded={false} recordView={recordView} />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <ViewTracker productId="prod_a" productSlug="a" recorded={false} recordView={recordView} />
      </StrictMode>,
    );
    expect(recordView).toHaveBeenCalledTimes(1);
  });

  test("a different product is tracked again", () => {
    const recordView = beacon();
    const { rerender } = render(
      <ViewTracker productId="prod_a" productSlug="a" recorded={false} recordView={recordView} />,
    );
    rerender(<ViewTracker productId="prod_b" productSlug="b" recorded={false} recordView={recordView} />);
    expect(recordView).toHaveBeenCalledTimes(2);
    expect(recordView).toHaveBeenLastCalledWith({ productId: "prod_b", productSlug: "b" });
  });

  test("rejecting or throwing actions are swallowed", async () => {
    const rejecting = beacon(async () => {
      throw new Error("network");
    });
    expect(() =>
      render(<ViewTracker productId="prod_a" productSlug="a" recorded={false} recordView={rejecting} />),
    ).not.toThrow();
    const throwing = mock<RecordViewBeacon>(() => {
      throw new Error("sync");
    });
    expect(() =>
      render(<ViewTracker productId="prod_c" productSlug="c" recorded={false} recordView={throwing} />),
    ).not.toThrow();
    await Promise.resolve();
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(throwing).toHaveBeenCalledTimes(1);
  });
});
