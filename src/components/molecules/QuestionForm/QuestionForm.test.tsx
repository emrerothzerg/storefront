import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as service from "@/server/qa/qa-service";
import {
  ANSWER_MAX_LENGTH,
  DISPLAY_NAME_MAX,
  QUESTION_MAX_LENGTH,
  QUESTION_SUCCESS_TEXT,
  QuestionForm,
} from "./index";
import { QUESTION_MIN_LENGTH, formatQaDate, retryText } from "./qa-shared";
import { HOSTILE, controlledAction, fakeServerAction, qaFailure, scriptedAction } from "./qa-test-helpers";

const PROPS = { productId: "p-1", productSlug: "oak-desk" } as const;

const bodyField = () => screen.getByRole("textbox", { name: /your question/i }) as HTMLTextAreaElement;
const nameField = () => screen.queryByRole("textbox", { name: /display name/i }) as HTMLInputElement | null;
const submit = () => screen.getByRole("button", { name: /^(loading )?ask$/i });
const form = () => screen.getByRole("form", { name: "Ask a question" }) as HTMLFormElement;

describe("qa-shared", () => {
  test("caps equal the Q&A service constants (cannot drift)", () => {
    expect(QUESTION_MAX_LENGTH).toBe(service.QUESTION_MAX_LENGTH);
    expect(QUESTION_MIN_LENGTH).toBe(service.QUESTION_MIN_LENGTH);
    expect(ANSWER_MAX_LENGTH).toBe(service.ANSWER_MAX_LENGTH);
    expect(DISPLAY_NAME_MAX).toBe(service.DISPLAY_NAME_MAX_LENGTH);
    expect([QUESTION_MAX_LENGTH, ANSWER_MAX_LENGTH, DISPLAY_NAME_MAX]).toEqual([300, 1000, 50]);
  });

  test("retryText rounds up to minutes and ignores bad input", () => {
    expect(retryText(30)).toBe("Try again in less than a minute.");
    expect(retryText(60)).toBe("Try again in about 1 minute.");
    expect(retryText(61)).toBe("Try again in about 2 minutes.");
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(retryText(bad)).toBeNull();
  });

  test("formatQaDate uses the UTC calendar date and tolerates bad input", () => {
    expect(formatQaDate("2026-11-06T23:59:00.000Z")).toBe("November 6, 2026");
    expect(formatQaDate("not a date")).toBe("");
  });
});

describe("QuestionForm no-JS markup", () => {
  test("server action renders a plain POST multipart form with hidden ids and capped fields", () => {
    const html = renderToStaticMarkup(<QuestionForm action={fakeServerAction(async () => null)} {...PROPS} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const f = doc.querySelector("form");
    expect(f?.getAttribute("method")).toBe("POST");
    expect(f?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(f?.querySelector('input[type="hidden"][name^="$ACTION_ID_"]')).not.toBeNull();
    expect(f?.querySelector('input[type="hidden"][name="productId"]')?.getAttribute("value")).toBe("p-1");
    expect(f?.querySelector('input[type="hidden"][name="productSlug"]')?.getAttribute("value")).toBe("oak-desk");
    const body = f?.querySelector('textarea[name="body"]');
    expect(body?.getAttribute("maxlength")).toBe("300");
    expect(body?.getAttribute("minlength")).toBe("10");
    expect(body?.getAttribute("rows")).toBe("3");
    expect(body?.hasAttribute("required")).toBe(true);
    const name = f?.querySelector('input[name="displayName"]');
    expect(name?.getAttribute("maxlength")).toBe("50");
    expect(name?.hasAttribute("required")).toBe(false);
    expect(f?.querySelector('button[type="submit"]')?.textContent).toBe("Ask");
    expect(html).not.toContain("outline-none");
  });
});

describe("QuestionForm", () => {
  test("labels the question field and links its hint", () => {
    render(<QuestionForm action={scriptedAction([]).action} {...PROPS} />);
    expect(bodyField()).toHaveAttribute("name", "body");
    expect(bodyField()).toHaveAttribute("maxLength", "300");
    expect(bodyField().getAttribute("aria-describedby")).toContain("-hint");
    expect(nameField()).not.toBeNull();
  });

  test("signed in: no name field, shows 'Posting as <name>' as text", () => {
    render(<QuestionForm action={scriptedAction([]).action} {...PROPS} signedInName={`  ${HOSTILE} `} />);
    expect(nameField()).toBeNull();
    expect(screen.getByText(`Posting as ${HOSTILE}`)).toBeInTheDocument();
    expect(document.querySelector("script, img")).toBeNull();
  });

  test("blank signedInName counts as signed out", () => {
    render(<QuestionForm action={scriptedAction([]).action} {...PROPS} signedInName="   " />);
    expect(nameField()).not.toBeNull();
  });

  test("posts ids, body and display name as FormData strings", async () => {
    const { action, calls } = scriptedAction([null]);
    render(<QuestionForm action={action} {...PROPS} />);
    fireEvent.change(bodyField(), { target: { value: "Does it fit a 27 inch monitor?" } });
    fireEvent.change(nameField() as HTMLInputElement, { target: { value: "Ada" } });
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      productId: "p-1",
      productSlug: "oak-desk",
      body: "Does it fit a 27 inch monitor?",
      displayName: "Ada",
    });
  });

  test("pending: submit is busy and a second submit is swallowed", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<QuestionForm action={action} {...PROPS} />);
    fireEvent.change(bodyField(), { target: { value: "Is the top solid oak?" } });
    fireEvent.submit(form());
    await waitFor(() => expect(submit()).toHaveAttribute("aria-busy", "true"));
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(submit());
    expect(calls).toHaveLength(1);
    await act(async () => resolve({ ok: true, kind: "asked", id: "q1", message: "Posted" }));
    await waitFor(() => expect(submit()).not.toHaveAttribute("aria-busy"));
  });

  test("validation failure: alert summary, field error linked + aria-invalid, values persist", async () => {
    const { action } = scriptedAction([
      qaFailure(
        "VALIDATION_FAILED",
        "Please check your question.",
        { body: "Question must be at least 10 characters." },
        { body: "Short?", displayName: "Ada" },
      ),
    ]);
    render(<QuestionForm action={action} {...PROPS} />);
    fireEvent.change(bodyField(), { target: { value: "Short?" } });
    fireEvent.submit(form());
    await screen.findByText("Please fix the following");
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("Please check your question."))).toBe(true);
    const body = bodyField();
    expect(body).toHaveAttribute("aria-invalid", "true");
    const errorEl = screen.getByText("Question must be at least 10 characters.");
    expect(body.getAttribute("aria-describedby")?.split(" ")).toContain(errorEl.id);
    expect(body.value).toBe("Short?");
    expect(nameField()?.value).toBe("Ada");
  });

  test("display name error is linked to the name field", async () => {
    const { action } = scriptedAction([
      qaFailure("TOO_LONG", "Name too long.", { displayName: "Use 50 characters or fewer." }, { body: "Is it oak?", displayName: "x" }),
    ]);
    render(<QuestionForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    const err = await screen.findByText("Use 50 characters or fewer.");
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(nameField()?.getAttribute("aria-describedby")).toContain(err.id);
    expect(bodyField()).not.toHaveAttribute("aria-invalid");
  });

  test("DUPLICATE shows a warning notice", async () => {
    const { action } = scriptedAction([
      qaFailure("DUPLICATE", "This question was already asked.", { body: "This question was already asked." }, { body: "Is it oak?" }),
    ]);
    render(<QuestionForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    const title = await screen.findByText("Already posted");
    expect(title.closest('[role="alert"]')).toHaveAttribute("data-tone", "warning");
  });

  test("RATE_LIMITED shows a warning notice with a retry hint", async () => {
    const { action } = scriptedAction([qaFailure("RATE_LIMITED", "You're posting too fast.", {}, { body: "Is it oak?" }, 125)]);
    render(<QuestionForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    const title = await screen.findByText("Too many posts");
    const notice = title.closest('[role="alert"]');
    expect(notice?.textContent).toContain("You're posting too fast. Try again in about 3 minutes.");
    expect(bodyField().value).toBe("Is it oak?");
  });

  test("echoed hostile values stay text (no script/img elements)", async () => {
    const { action } = scriptedAction([qaFailure("VALIDATION_FAILED", "Bad.", {}, { body: HOSTILE, displayName: HOSTILE })]);
    render(<QuestionForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    await screen.findByText("Please fix the following");
    expect(bodyField().value).toBe(HOSTILE);
    expect(document.querySelector("script, img")).toBeNull();
  });

  test("success: notice in a polite live region, fields cleared", async () => {
    const { action } = scriptedAction([
      qaFailure("VALIDATION_FAILED", "Bad.", {}, { body: "Is it oak?" }),
      { ok: true, kind: "asked", id: "q1", message: "Thanks" },
    ]);
    render(<QuestionForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    await screen.findByText("Please fix the following");
    fireEvent.submit(form());
    const msg = await screen.findByText(QUESTION_SUCCESS_TEXT);
    expect(msg.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByText("Please fix the following")).toBeNull();
    expect(bodyField().value).toBe("");
    expect(bodyField()).not.toHaveAttribute("aria-invalid");
  });

  test("live region exists before any submission", () => {
    const { container } = render(<QuestionForm action={scriptedAction([]).action} {...PROPS} />);
    expect(container.querySelector('form > [aria-live="polite"]')).not.toBeNull();
  });
});
