import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appError } from "@/lib/result";
import * as service from "@/server/reviews/review-service";
import type { ReviewActionFn, ReviewActionState, ReviewEchoValues } from "../_contracts/review-actions";
import {
  ALREADY_REVIEWED_MESSAGE,
  DISPLAY_NAME_HINT,
  REVIEW_BODY_MAX,
  REVIEW_DISPLAY_NAME_MAX,
  REVIEW_FIELD_IDS,
  REVIEW_SUCCESS_MESSAGE,
  REVIEW_TITLE_MAX,
  ReviewForm,
  echoedRating,
  retryAfterText,
  summaryItems,
} from "./index";
import { expectFocused } from "@/test/dom-assertions";

type Fields = Record<string, string>;

function snapshot(formData: FormData): Fields {
  const out: Fields = {};
  formData.forEach((value, name) => {
    if (typeof value === "string") out[name] = value;
  });
  return out;
}

function scriptedAction(steps: ReadonlyArray<ReviewActionState>) {
  const calls: Fields[] = [];
  const action: ReviewActionFn = async (_prev, formData) => {
    calls.push(snapshot(formData));
    return steps[calls.length - 1] ?? null;
  };
  return { action, calls };
}

function controlledAction() {
  const calls: Fields[] = [];
  let resolveFn: (s: ReviewActionState) => void = () => {};
  const action: ReviewActionFn = (_prev, formData) => {
    calls.push(snapshot(formData));
    return new Promise<ReviewActionState>((res) => {
      resolveFn = res;
    });
  };
  return { action, calls, resolve: (s: ReviewActionState) => resolveFn(s) };
}

function failure(
  code: Parameters<typeof appError>[0],
  message: string,
  fieldErrors: Partial<Record<keyof ReviewEchoValues, string>> = {},
  values: ReviewEchoValues = {},
  retryAfterSeconds?: number,
): ReviewActionState {
  const base = { ok: false as const, error: appError(code, message), message, fieldErrors, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

const success: ReviewActionState = { ok: true, kind: "created", message: "Review posted.", reviewId: "r1" };

const PROPS = { productId: "p-123", productSlug: "oak-desk" } as const;

const form = () => document.getElementById("write-review") as HTMLFormElement;
const titleInput = () => document.getElementById(REVIEW_FIELD_IDS.title) as HTMLInputElement;
const bodyInput = () => document.getElementById(REVIEW_FIELD_IDS.body) as HTMLTextAreaElement;
const nameInput = () => document.getElementById(REVIEW_FIELD_IDS.displayName) as HTMLInputElement | null;
const star = (n: number) => screen.getByLabelText(`${n} out of 5 stars`) as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: /submit/i });

function fillValid() {
  fireEvent.click(star(4));
  fireEvent.change(titleInput(), { target: { value: "Sturdy" } });
  fireEvent.change(bodyInput(), { target: { value: "Solid desk, easy build." } });
  fireEvent.change(nameInput() as HTMLInputElement, { target: { value: "Ada" } });
}

describe("helpers", () => {
  test("caps equal the review service constants (cannot drift)", () => {
    expect(REVIEW_TITLE_MAX).toBe(service.REVIEW_TITLE_MAX);
    expect(REVIEW_BODY_MAX).toBe(service.REVIEW_BODY_MAX);
    expect(REVIEW_DISPLAY_NAME_MAX).toBe(service.REVIEW_DISPLAY_NAME_MAX);
    expect(DISPLAY_NAME_HINT).toContain(service.DEFAULT_DISPLAY_NAME);
  });

  test("retryAfterText rounds up to whole minutes with singular/plural and a fallback", () => {
    expect(retryAfterText(1)).toBe("Try again in 1 minute.");
    expect(retryAfterText(60)).toBe("Try again in 1 minute.");
    expect(retryAfterText(61)).toBe("Try again in 2 minutes.");
    expect(retryAfterText(3600)).toBe("Try again in 60 minutes.");
    expect(retryAfterText(undefined)).toBe("Try again later.");
    expect(retryAfterText(0)).toBe("Try again later.");
    expect(retryAfterText(Number.NaN)).toBe("Try again later.");
    expect(retryAfterText(-5)).toBe("Try again later.");
  });

  test("echoedRating accepts only a single digit 1-5", () => {
    expect(echoedRating("3")).toBe(3);
    for (const bad of [undefined, "", "0", "6", "3.5", " 3", "33", "x"]) expect(echoedRating(bad)).toBeUndefined();
  });

  test("summaryItems keeps form order, skips blanks and a hidden displayName", () => {
    const f = failure("VALIDATION_FAILED", "m", { displayName: "Too long", body: "Required", title: "  ", rating: "Pick" });
    if (f === null || f.ok) throw new Error("expected failure");
    expect(summaryItems(f, true).map((i) => i.id)).toEqual(["review-rating", "review-body", "review-display-name"]);
    expect(summaryItems(f, false).map((i) => i.id)).toEqual(["review-rating", "review-body"]);
  });
});

describe("ReviewForm no-JS markup (renderToStaticMarkup)", () => {
  test("plain <form> with every named field, hidden ids and caps", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ReviewForm action={action} {...PROPS} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const f = doc.querySelector("form");
    expect(f?.id).toBe("write-review");
    expect(f?.getAttribute("aria-label")).toBe("Write a review");
    const named = (n: string) => f?.querySelectorAll(`[name="${n}"]`) ?? [];
    expect((named("productId")[0] as HTMLInputElement).getAttribute("type")).toBe("hidden");
    expect(named("productId")[0]?.getAttribute("value")).toBe("p-123");
    expect(named("productSlug")[0]?.getAttribute("value")).toBe("oak-desk");
    expect(named("rating")).toHaveLength(5);
    expect([...named("rating")].map((r) => r.getAttribute("value"))).toEqual(["1", "2", "3", "4", "5"]);
    expect(named("title")[0]?.getAttribute("maxlength")).toBe("100");
    expect(named("body")[0]?.tagName).toBe("TEXTAREA");
    expect(named("body")[0]?.getAttribute("maxlength")).toBe("2000");
    expect(named("body")[0]?.getAttribute("rows")).toBe("5");
    expect(named("displayName")[0]?.getAttribute("maxlength")).toBe("50");
    expect(named("displayName")[0]?.hasAttribute("required")).toBe(false);
    expect(named("title")[0]?.hasAttribute("required")).toBe(true);
    expect(named("body")[0]?.hasAttribute("required")).toBe(true);
    const submit = f?.querySelector('button[type="submit"]');
    expect(submit?.textContent).toBe("Submit review");
    expect(submit?.hasAttribute("disabled")).toBe(false);
    // Required marked in visible text, not colour only.
    expect(html.match(/\(required\)/g)?.length).toBe(3);
    // The Rating atom renders the marker itself; the label is passed plain (D-T58-1).
    expect(html).not.toContain("(required) (required)");
    expect(html).toContain(DISPLAY_NAME_HINT);
    expect(html).not.toContain("outline-none");
  });

  test("counter is wired: count text linked to the textarea plus a polite live region", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ReviewForm action={action} {...PROPS} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.getElementById(REVIEW_FIELD_IDS.body);
    expect(body?.getAttribute("aria-describedby")).toContain("review-body-count");
    expect(doc.getElementById("review-body-count")?.textContent).toContain("0 / 2000");
    expect(doc.querySelector('[data-testid="textarea-live"]')?.getAttribute("aria-live")).toBe("polite");
  });

  test("headingId labels the form instead of aria-label", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ReviewForm action={action} {...PROPS} headingId="reviews-h" />);
    expect(html).toContain('aria-labelledby="reviews-h"');
    expect(html).not.toContain('aria-label="Write a review"');
  });

  test("signed in: 'Posting as <name>' text and no displayName input (name escaped)", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(
      <ReviewForm action={action} {...PROPS} signedInName={'<img src=x onerror="alert(1)">'} />,
    );
    expect(html).not.toContain('name="displayName"');
    expect(html).toContain("Posting as &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  test("blank signedInName falls back to the guest name field", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ReviewForm action={action} {...PROPS} signedInName="   " />);
    expect(html).toContain('name="displayName"');
  });

  test("alreadyReviewed renders only a notice", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ReviewForm action={action} {...PROPS} alreadyReviewed />);
    expect(html).not.toContain("<form");
    expect(html).toContain(ALREADY_REVIEWED_MESSAGE);
    expect(html).toContain('role="status"');
  });
});

describe("ReviewForm interactions", () => {
  test("posts exactly the contract fields", async () => {
    const { action, calls } = scriptedAction([success]);
    render(<ReviewForm action={action} {...PROPS} />);
    fillValid();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      productId: "p-123",
      productSlug: "oak-desk",
      rating: "4",
      title: "Sturdy",
      body: "Solid desk, easy build.",
      displayName: "Ada",
    });
  });

  test("signed in: no displayName is posted", async () => {
    const { action, calls } = scriptedAction([success]);
    render(<ReviewForm action={action} {...PROPS} signedInName="Jane" />);
    expect(screen.getByText("Posting as Jane")).toBeInTheDocument();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).not.toHaveProperty("displayName");
  });

  test("pending: 'Submitting…', aria-busy, double submit/click sends one request", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<ReviewForm action={action} {...PROPS} />);
    fillValid();
    fireEvent.submit(form());
    fireEvent.submit(form());
    const button = submitButton();
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveTextContent("Submitting…");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(form());
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
    await act(async () => resolve(success));
    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    expect(button).toHaveTextContent("Submit review");
    // Usable again afterwards.
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => resolve(success));
  });

  test("validation error: summary focused, links to fields, aria wiring, values persist", async () => {
    const values = { rating: "2", title: "Meh", body: "x".repeat(10), displayName: "Bo" };
    const state = failure(
      "VALIDATION_FAILED",
      "Some fields need attention.",
      { rating: "Choose a rating.", title: "Title is too long.", body: "Reviews can contain at most 2 links." },
      values,
    );
    const { action } = scriptedAction([state]);
    render(<ReviewForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("review-error-summary");
    expect(summary).toHaveAttribute("role", "alert");
    await waitFor(() => expectFocused(summary));
    expect(summary).toHaveTextContent("Please fix the following");

    const links = summary.querySelectorAll("a");
    expect([...links].map((a) => a.getAttribute("href"))).toEqual(["#review-rating", "#review-title", "#review-body"]);
    expect(links[1]).toHaveTextContent("Title: Title is too long.");

    // Each invalid field: aria-invalid + aria-describedby -> its error text.
    for (const [id, msg] of [
      [REVIEW_FIELD_IDS.title, "Title is too long."],
      [REVIEW_FIELD_IDS.body, "Reviews can contain at most 2 links."],
      [REVIEW_FIELD_IDS.rating, "Choose a rating."],
    ] as const) {
      const el = document.getElementById(id);
      expect(el).toHaveAttribute("aria-invalid", "true");
      const describedBy = el?.getAttribute("aria-describedby") ?? "";
      expect(describedBy).toContain(`${id}-error`);
      expect(document.getElementById(`${id}-error`)).toHaveTextContent(msg);
    }
    expect(nameInput()).not.toHaveAttribute("aria-invalid");

    // Entered values persist.
    expect(titleInput().value).toBe("Meh");
    expect(bodyInput().value).toBe("x".repeat(10));
    expect(nameInput()?.value).toBe("Bo");
    expect(star(2).checked).toBe(true);
    expect(screen.getByText("10 / 2000", { exact: false })).toBeInTheDocument();

    // Clicking a summary link focuses the field (rating -> its checked radio).
    fireEvent.click(links[1] as HTMLAnchorElement);
    expectFocused(titleInput());
    fireEvent.click(links[0] as HTMLAnchorElement);
    expectFocused(star(2));
  });

  test("RATE_LIMITED: alert with retry minutes, form stays usable", async () => {
    const limited = failure(
      "RATE_LIMITED",
      "You have posted several reviews recently. Please try again in 12 minutes.",
      {},
      { rating: "5", title: "Great", body: "Love it" },
      700,
    );
    const { action, calls } = scriptedAction([limited, success]);
    render(<ReviewForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("review-error-summary");
    expect(summary).toHaveAttribute("role", "alert");
    expect(summary).toHaveTextContent("Try again in 12 minutes.");
    await waitFor(() => expectFocused(summary));
    expect(titleInput().value).toBe("Great");
    expect(submitButton()).not.toHaveAttribute("aria-disabled");
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    await screen.findByText(REVIEW_SUCCESS_MESSAGE);
  });

  test("DUPLICATE: alert with the message, form stays usable", async () => {
    const dup = failure("DUPLICATE", "You already reviewed this product.", {}, { title: "Again" });
    const { action, calls } = scriptedAction([dup, dup]);
    render(<ReviewForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("review-error-summary");
    expect(summary).toHaveTextContent("You already reviewed this product.");
    expect(titleInput().value).toBe("Again");
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  test("other errors (no field errors) show the message", async () => {
    const { action } = scriptedAction([failure("PRODUCT_NOT_FOUND", "This product is no longer available.")]);
    render(<ReviewForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("review-error-summary");
    expect(summary).toHaveTextContent("This product is no longer available.");
    expect(summary.querySelector("a")).toBeNull();
  });

  test("success: polite confirmation and the form is cleared", async () => {
    const { action } = scriptedAction([success]);
    render(<ReviewForm action={action} {...PROPS} />);
    fillValid();
    fireEvent.submit(form());
    const msg = await screen.findByText(REVIEW_SUCCESS_MESSAGE);
    expect(msg.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByTestId("review-error-summary")).toBeNull();
    expect(titleInput().value).toBe("");
    expect(bodyInput().value).toBe("");
    expect(nameInput()?.value).toBe("");
    expect([1, 2, 3, 4, 5].some((n) => star(n).checked)).toBe(false);
    expect(screen.getByText("0 / 2000", { exact: false })).toBeInTheDocument();
  });

  test("hostile echoed values and messages render as text", async () => {
    const evil = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const state = failure(
      "VALIDATION_FAILED",
      evil,
      { title: evil, displayName: evil },
      { title: evil.slice(0, 100), body: evil, displayName: evil.slice(0, 50), rating: '"><script>' },
    );
    const { action } = scriptedAction([state]);
    const { container } = render(<ReviewForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    await screen.findByTestId("review-error-summary");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(titleInput().value).toBe(evil.slice(0, 100));
    expect(bodyInput().value).toBe(evil);
    expect([1, 2, 3, 4, 5].some((n) => star(n).checked)).toBe(false);
    expect(document.getElementById(`${REVIEW_FIELD_IDS.title}-error`)?.textContent).toBe(evil);
  });

  test("every control has an accessible name; 320px-safe classes (no fixed widths)", () => {
    const { action } = scriptedAction([]);
    const { container } = render(<ReviewForm action={action} {...PROPS} />);
    for (const control of container.querySelectorAll("input:not([type=hidden]), textarea, button")) {
      expect(control).toHaveAccessibleName();
    }
    const tokens = [...container.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    const fixedWidths = tokens.filter((t) => /^(w|min-w)-(\d+|screen|\[.*\])$/.test(t) && t !== "min-w-0");
    expect(fixedWidths).toEqual([]);
  });
});

describe("ReviewForm double-submit guard release", () => {
  test("rating legend reads 'Overall rating (required)' exactly once", () => {
    const { container } = render(<ReviewForm action={scriptedAction([]).action} {...PROPS} />);
    expect(container.querySelector("legend")?.textContent).toBe("Overall rating (required)");
  });

  test("a submit fired immediately after the action settles with an error is accepted", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<ReviewForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => resolve(failure("DUPLICATE", "You already reviewed this product.")));
    // No waitFor before the resubmit: the guard is released when the action
    // settles, not in a later passive effect.
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => resolve(success));
  });

  test("guard holds while in flight, then releases after each settle (three rounds)", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<ReviewForm action={action} {...PROPS} />);
    for (let round = 1; round <= 3; round += 1) {
      fireEvent.submit(form());
      fireEvent.submit(form());
      await waitFor(() => expect(calls).toHaveLength(round));
      await act(async () => resolve(failure("DUPLICATE", "dup")));
    }
    expect(calls).toHaveLength(3);
  });
});

describe("ReviewForm: no-JS submission with a server action (consistency ai, D-T97-1)", () => {
  // Mimics what a Next server reference exposes to React's SSR: `$$FORM_ACTION`,
  // kept across `.bind` (useActionState binds the previous state).
  function serverLikeAction(): ReviewActionFn {
    const formFields = () => ({
      name: "$ACTION_REF_1",
      action: "",
      encType: "multipart/form-data",
      method: "POST",
      data: null,
    });
    return Object.assign(async (): Promise<ReviewActionState> => null, {
      $$FORM_ACTION: formFields,
      bind(): unknown {
        return Object.assign(async () => null, { $$FORM_ACTION: formFields });
      },
    });
  }

  function serverForm(props: { signedInName?: string | null } = {}): Element | null {
    const html = renderToStaticMarkup(
      <ReviewForm action={serverLikeAction()} productId="prod_oak-desk" productSlug="oak-desk" {...props} />,
    );
    return new DOMParser().parseFromString(html, "text/html").querySelector("form#write-review");
  }

  test("server markup is a real POST form (method, multipart enctype, no javascript: action)", () => {
    for (const signedInName of [null, "Ada"]) {
      const form = serverForm({ signedInName });
      expect(form).not.toBeNull();
      expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
      expect(form?.getAttribute("action") ?? "").not.toContain("javascript:");
      expect(form?.querySelector('input[name="productId"]')?.getAttribute("value")).toBe("prod_oak-desk");
      expect(form?.querySelector('input[name="productSlug"]')?.getAttribute("value")).toBe("oak-desk");
    }
  });

  test("after hydration the wrapped action still submits and the double-submit guard is released", async () => {
    const calls: Fields[] = [];
    const action: ReviewActionFn = async (_prev, formData) => {
      calls.push(snapshot(formData));
      return { ok: false, error: appError("VALIDATION_FAILED", "Check the form"), message: "Check the form", fieldErrors: {}, values: {} };
    };
    const { container } = render(<ReviewForm action={action} productId="prod_oak-desk" productSlug="oak-desk" />);
    const form = container.querySelector("form");
    if (!form) throw new Error("form missing");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(2));
  });
});
