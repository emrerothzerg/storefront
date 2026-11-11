import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { appError } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import type { ReviewView } from "@/server/reviews/review-service";
import type { VoteActionFn, VoteActionState } from "../_contracts/review-actions";
import { ReviewCard, formatReviewDate, voteErrorMessage } from "./ReviewCard";

const base: ReviewView = {
  id: "rev-1",
  productId: "prod-1",
  displayName: "Jane Doe",
  rating: 4,
  title: "Sturdy and quiet",
  body: "First paragraph.\n\nSecond paragraph.",
  verifiedPurchase: false,
  helpfulCount: 3,
  status: "published",
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:00:00.000Z",
};

function review(over: Partial<ReviewView> = {}): ReviewView {
  return { ...base, ...over };
}

type Call = { reviewId: FormDataEntryValue | null; productSlug: FormDataEntryValue | null };

function recordingAction(result: VoteActionState): { action: VoteActionFn; calls: Call[] } {
  const calls: Call[] = [];
  const action: VoteActionFn = async (_prev, fd) => {
    calls.push({ reviewId: fd.get("reviewId"), productSlug: fd.get("productSlug") });
    return result;
  };
  return { action, calls };
}

function failure(code: ErrorCode, message: string, retryAfterSeconds?: number): VoteActionState {
  return retryAfterSeconds === undefined
    ? { ok: false, error: appError(code, message), message }
    : { ok: false, error: appError(code, message), message, retryAfterSeconds };
}

const success: VoteActionState = { ok: true, helpfulCount: 4, message: "Thanks" };
const noop: VoteActionFn = async () => null;

function helpfulButton(): HTMLElement {
  return screen.getByRole("button", { name: /helpful/i });
}

function submit(): void {
  const form = helpfulButton().closest("form");
  if (!form) throw new Error("no form");
  fireEvent.submit(form);
}

describe("formatReviewDate", () => {
  test("formats ISO in en-US (UTC) and rejects garbage", () => {
    expect(formatReviewDate("2026-11-07T23:30:00.000Z")).toBe("November 7, 2026");
    expect(formatReviewDate("not a date")).toBeNull();
    expect(formatReviewDate("")).toBeNull();
    expect(formatReviewDate("   ")).toBeNull();
    // Strict ISO (D-T61-1 shared weakness): no calendar rollover, no local-time strings.
    expect(formatReviewDate("2026-02-31T10:00:00.000Z")).toBeNull();
    expect(formatReviewDate("2026-11-07T10:00:00")).toBeNull();
    expect(formatReviewDate("2026-11-07")).toBeNull();
    expect(formatReviewDate("2026-11-07T23:30:00-05:00")).toBe("November 8, 2026");
  });
});

describe("voteErrorMessage", () => {
  test("rate limit rounds up to whole minutes; falls back without a retry time", () => {
    const limited = failure("RATE_LIMITED", "x", 61);
    if (limited?.ok !== false) throw new Error("bad fixture");
    expect(voteErrorMessage(limited)).toBe("Too many votes. Try again in 2 minutes.");
    const one = failure("RATE_LIMITED", "x", 30);
    if (one?.ok !== false) throw new Error("bad fixture");
    expect(voteErrorMessage(one)).toBe("Too many votes. Try again in 1 minute.");
    const none = failure("RATE_LIMITED", "x");
    if (none?.ok !== false) throw new Error("bad fixture");
    expect(voteErrorMessage(none)).toBe("Too many votes. Try again later.");
  });

  test("unknown codes use the server's user-safe message", () => {
    const other = failure("INVALID_INPUT", "Please try again.");
    if (other?.ok !== false) throw new Error("bad fixture");
    expect(voteErrorMessage(other)).toBe("Please try again.");
  });
});

describe("ReviewCard", () => {
  test("renders an article with stars, title heading, name, date and body", () => {
    render(<ReviewCard review={review()} voteAction={noop} productSlug="desk" />);
    const article = screen.getByRole("article", { name: "Sturdy and quiet" });
    expect(article.tagName).toBe("ARTICLE");
    expect(screen.getByRole("heading", { level: 3, name: "Sturdy and quiet" })).toBeInTheDocument();
    expect(screen.getByText("4 out of 5 stars")).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    const time = article.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-11-07T10:00:00.000Z");
    expect(time).toHaveTextContent("November 7, 2026");
    expect(screen.getByText(/First paragraph\./)).toHaveClass("whitespace-pre-line", "break-words");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  test("avatar shows initials and is decorative (name is shown next to it)", () => {
    const { container } = render(<ReviewCard review={review()} voteAction={noop} productSlug="desk" />);
    expect(screen.queryByRole("img", { name: "Jane Doe" })).toBeNull();
    expect(container.textContent).toContain("JD");
  });

  test("invalid date is omitted (no 'Invalid Date')", () => {
    const { container } = render(
      <ReviewCard review={review({ createdAt: "garbage" })} voteAction={noop} productSlug="desk" />,
    );
    expect(container.querySelector("time")).toBeNull();
    expect(container.textContent).not.toContain("Invalid");
    expect(screen.queryByText(/Reviewed on/)).toBeNull();
  });

  test("Verified Purchase badge only when the prop is true, as text", () => {
    const { rerender } = render(<ReviewCard review={review()} voteAction={noop} productSlug="desk" />);
    expect(screen.queryByText("Verified Purchase")).toBeNull();
    rerender(<ReviewCard review={review({ verifiedPurchase: true })} voteAction={noop} productSlug="desk" />);
    expect(screen.getByText("Verified Purchase")).toBeVisible();
  });

  test("hostile title, name and body render as text; no script/img elements are created", () => {
    const hostile = review({
      title: "<script>alert('t')</script>",
      displayName: '<img src=x onerror="alert(1)">',
      body: "<img src=x onerror=alert(2)><script>alert(3)</script>",
    });
    const { container } = render(<ReviewCard review={hostile} voteAction={noop} productSlug="desk" />);
    expect(screen.getByRole("heading", { name: "<script>alert('t')</script>" })).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(2)><script>alert(3)</script>")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();

    // Server HTML: React appends its own form-replay <script> after the root, so inspect the article.
    const html = renderToStaticMarkup(<ReviewCard review={hostile} voteAction={noop} productSlug="desk" />);
    const article = new DOMParser().parseFromString(html, "text/html").querySelector("article");
    expect(article).not.toBeNull();
    expect(article?.querySelector("script")).toBeNull();
    expect(article?.querySelector("img")).toBeNull();
    expect(article?.querySelector("[onerror]")).toBeNull();
    expect(html).toContain("&lt;script&gt;alert(3)&lt;/script&gt;");
  });

  test("long unbroken words wrap (break-words + min-w-0 on the card and text)", () => {
    const long = "a".repeat(500);
    const { container } = render(
      <ReviewCard review={review({ title: long, body: long, displayName: long })} voteAction={noop} productSlug="desk" />,
    );
    const article = container.querySelector("article");
    expect(article).toHaveClass("min-w-0", "break-words");
    expect(screen.getByRole("heading")).toHaveClass("break-words", "min-w-0");
    for (const el of screen.getAllByText(long)) expect(el).toHaveClass("break-words");
    const classes = Array.from(container.querySelectorAll("[class]"))
      .map((el) => el.getAttribute("class") ?? "")
      .join(" ");
    expect(classes).not.toMatch(/\[/);
    expect(classes).not.toMatch(/(^|\s)w-(?!full)\d/);
  });

  test("no-JS shape: static markup has a real form with hidden reviewId/productSlug and a submit button", () => {
    const html = renderToStaticMarkup(<ReviewCard review={review()} voteAction={noop} productSlug="oak-desk" />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector("form");
    expect(form).not.toBeNull();
    expect(form?.querySelector('input[type="hidden"][name="reviewId"]')?.getAttribute("value")).toBe("rev-1");
    expect(form?.querySelector('input[type="hidden"][name="productSlug"]')?.getAttribute("value")).toBe("oak-desk");
    const button = form?.querySelector("button");
    expect(button?.getAttribute("type")).toBe("submit");
    expect(button?.textContent).toBe("Helpful (3)");
    expect(button?.hasAttribute("disabled")).toBe(false);
  });

  test("no-JS shape with a server action: form adopts the action's POST/multipart attributes", () => {
    // Mimics what a Next server reference exposes to React's SSR: `$$FORM_ACTION`,
    // kept across `.bind` (useActionState binds the previous state).
    const formFields = () => ({
      name: "$ACTION_REF_1",
      action: "",
      encType: "multipart/form-data",
      method: "POST",
      data: null,
    });
    const serverLike: VoteActionFn = Object.assign(async (): Promise<VoteActionState> => null, {
      $$FORM_ACTION: formFields,
      bind(): unknown {
        return Object.assign(async () => null, { $$FORM_ACTION: formFields });
      },
    });
    const html = renderToStaticMarkup(
      <ReviewCard review={review()} voteAction={serverLike} productSlug="oak-desk" />,
    );
    const form = new DOMParser().parseFromString(html, "text/html").querySelector("form");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form?.getAttribute("action") ?? "").not.toContain("javascript:");
    expect(form?.querySelector('input[name="reviewId"]')?.getAttribute("value")).toBe("rev-1");
  });

  test("submits reviewId and productSlug as FormData", async () => {
    const { action, calls } = recordingAction(success);
    render(<ReviewCard review={review()} voteAction={action} productSlug="oak-desk" />);
    expect(helpfulButton()).toHaveTextContent("Helpful (3)");
    submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ reviewId: "rev-1", productSlug: "oak-desk" });
  });

  test("pending: button is aria-disabled + aria-busy and extra clicks do not resubmit", async () => {
    let count = 0;
    let release: (s: VoteActionState) => void = () => {};
    const slow: VoteActionFn = () => {
      count += 1;
      return new Promise<VoteActionState>((res) => {
        release = res;
      });
    };
    try {
      render(<ReviewCard review={review()} voteAction={slow} productSlug="desk" />);
      const button = helpfulButton();
      fireEvent.click(button);
      await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
      fireEvent.click(button);
      await new Promise((r) => setTimeout(r, 20));
      expect(count).toBe(1);
    } finally {
      await act(async () => release(success));
    }
  });

  test("success: 'Thanks for your feedback' in a polite live region, button replaced, count updated", async () => {
    const { action } = recordingAction(success);
    const { container } = render(<ReviewCard review={review()} voteAction={action} productSlug="desk" />);
    const region = container.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(region).not.toBeNull();
    expect(region).toBeEmptyDOMElement();
    submit();
    await waitFor(() => expect(region).toHaveTextContent("Thanks for your feedback"));
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.getByText("4 people found this helpful")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("votedByViewer: 'You found this helpful' and no button or form", () => {
    const { container } = render(
      <ReviewCard review={review({ votedByViewer: true })} voteAction={noop} productSlug="desk" />,
    );
    expect(screen.getByText("You found this helpful")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });

  test("isOwn: no vote form or button", () => {
    const { container } = render(<ReviewCard review={review({ isOwn: true })} voteAction={noop} productSlug="desk" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.getByText("3 people found this helpful")).toBeInTheDocument();
  });

  test.each([
    ["DUPLICATE", "You already marked this review as helpful.", false],
    ["NOT_FOUND", "This review is no longer available.", false],
    ["FORBIDDEN", "You can't vote on your own review.", false],
  ] as const)("%s error is shown in role=alert and removes the button", async (code, text, keepsButton) => {
    const { action } = recordingAction(failure(code, "server message"));
    render(<ReviewCard review={review()} voteAction={action} productSlug="desk" />);
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).toHaveClass("text-danger");
    expect(screen.queryByRole("button") !== null).toBe(keepsButton);
  });

  test("RATE_LIMITED shows minutes in role=alert and keeps the button for a later retry", async () => {
    const { action, calls } = recordingAction(failure("RATE_LIMITED", "Slow down", 300));
    render(<ReviewCard review={review()} voteAction={action} productSlug="desk" />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many votes. Try again in 5 minutes.");
    expect(helpfulButton()).not.toHaveAttribute("aria-busy");
    submit();
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  test("helpful count of 0 or corrupt shows 'Helpful (0)' and no NaN", () => {
    const { container } = render(
      <ReviewCard review={review({ helpfulCount: Number.NaN })} voteAction={noop} productSlug="desk" />,
    );
    expect(helpfulButton()).toHaveTextContent("Helpful (0)");
    expect(container.textContent).not.toContain("NaN");
  });

  test("blank title renders no heading; blank name falls back to 'Anonymous shopper'", () => {
    render(<ReviewCard review={review({ title: "  ", displayName: " " })} voteAction={noop} productSlug="desk" />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Anonymous shopper")).toBeInTheDocument();
  });

  test("headingLevel, className and ref", () => {
    let node: HTMLElement | null = null;
    render(
      <ReviewCard
        review={review()}
        voteAction={noop}
        productSlug="desk"
        headingLevel={4}
        className="mt-2"
        ref={(el) => {
          node = el;
        }}
      />,
    );
    expect(screen.getByRole("heading", { level: 4 })).toBeInTheDocument();
    expect(node).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole("article")).toHaveClass("mt-2");
  });
});

describe("ReviewCard helpful button names (a11y)", () => {
  const vote: VoteActionFn = async () => null;

  test("each 'Helpful (N)' button is described by its own review title", () => {
    render(
      <>
        <ReviewCard review={review({ id: "a", title: "First take" })} voteAction={vote} productSlug="desk" />
        <ReviewCard review={review({ id: "b", title: "Second take" })} voteAction={vote} productSlug="desk" />
      </>,
    );
    const buttons = screen.getAllByRole("button", { name: "Helpful (3)" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleDescription("First take");
    expect(buttons[1]).toHaveAccessibleDescription("Second take");
    const ids = buttons.map((b) => b.getAttribute("aria-describedby"));
    expect(new Set(ids).size).toBe(2);
  });

  test("untitled review: described by the reviewer name", () => {
    render(<ReviewCard review={review({ title: "   ", displayName: "Ada" })} voteAction={vote} productSlug="desk" />);
    expect(screen.getByRole("button", { name: "Helpful (3)" })).toHaveAccessibleDescription("Ada");
  });

  test("hostile title still renders as text in the description", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { container } = render(<ReviewCard review={review({ title: hostile })} voteAction={vote} productSlug="desk" />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Helpful (3)" })).toHaveAccessibleDescription(hostile);
  });
});
