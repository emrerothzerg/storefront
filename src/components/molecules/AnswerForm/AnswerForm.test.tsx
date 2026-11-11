import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ANSWER_MAX_LENGTH } from "../QuestionForm/qa-shared";
import {
  HOSTILE,
  controlledAction,
  fakeServerAction,
  pressTab,
  qaFailure,
  scriptedAction,
} from "../QuestionForm/qa-test-helpers";
import { ANSWER_FORM_LABEL, ANSWER_SUCCESS_TEXT, AnswerForm } from "./index";
import { expectFocused } from "@/test/dom-assertions";

const PROPS = { questionId: "q-1", productSlug: "oak-desk" } as const;

const details = () => document.querySelector("details") as HTMLDetailsElement;
const summary = () => document.querySelector("summary") as HTMLElement;
const bodyField = () => document.querySelector('textarea[name="body"]') as HTMLTextAreaElement;
const nameField = () => document.querySelector('input[name="displayName"]') as HTMLInputElement | null;
const form = () => document.querySelector("form") as HTMLFormElement;
const submit = () => screen.getByRole("button", { name: /post answer/i });

describe("AnswerForm no-JS markup", () => {
  test("collapsed native <details> holding a plain POST form with hidden ids", () => {
    const html = renderToStaticMarkup(<AnswerForm action={fakeServerAction(async () => null)} {...PROPS} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const d = doc.querySelector("details");
    expect(d).not.toBeNull();
    expect(d?.hasAttribute("open")).toBe(false);
    expect(d?.querySelector("summary")?.textContent).toBe("Answer this question");
    const f = d?.querySelector("form");
    expect(f?.getAttribute("method")).toBe("POST");
    expect(f?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(f?.querySelector('input[type="hidden"][name="questionId"]')?.getAttribute("value")).toBe("q-1");
    expect(f?.querySelector('input[type="hidden"][name="productSlug"]')?.getAttribute("value")).toBe("oak-desk");
    const body = f?.querySelector('textarea[name="body"]');
    expect(body?.getAttribute("maxlength")).toBe(String(ANSWER_MAX_LENGTH));
    expect(body?.getAttribute("maxlength")).toBe("1000");
    expect(body?.getAttribute("rows")).toBe("3");
    expect(body?.hasAttribute("required")).toBe(true);
    expect(f?.querySelector('input[name="displayName"]')?.getAttribute("maxlength")).toBe("50");
    expect(f?.querySelector('button[type="submit"]')?.textContent).toBe("Post answer");
  });

  test("defaultOpen renders the open attribute", () => {
    const html = renderToStaticMarkup(<AnswerForm action={scriptedAction([]).action} {...PROPS} defaultOpen />);
    expect(new DOMParser().parseFromString(html, "text/html").querySelector("details")?.hasAttribute("open")).toBe(true);
  });
});

describe("AnswerForm", () => {
  test("keyboard: summary is in the Tab order; after expanding, Tab reaches the answer field, name and submit", () => {
    render(
      <>
        <AnswerForm action={scriptedAction([]).action} {...PROPS} />
        <button type="button">after</button>
      </>,
    );
    summary().focus();
    expectFocused(summary());
    // Collapsed: Tab skips the hidden form.
    expect(pressTab()?.textContent).toBe("after");
    summary().focus();
    details().open = true;
    expect(pressTab()).toBe(bodyField());
    expectFocused(bodyField());
    expect(pressTab()).toBe(nameField());
    expect(pressTab()).toBe(submit());
  });

  test("signed in: hides the name field and shows 'Posting as <name>'", () => {
    render(<AnswerForm action={scriptedAction([]).action} {...PROPS} signedInName="Jane" defaultOpen />);
    expect(nameField()).toBeNull();
    expect(screen.getByText("Posting as Jane")).toBeInTheDocument();
  });

  test("posts questionId, slug, body and name", async () => {
    const { action, calls } = scriptedAction([null]);
    render(<AnswerForm action={action} {...PROPS} defaultOpen />);
    fireEvent.change(bodyField(), { target: { value: "Yes,\nit fits." } });
    fireEvent.change(nameField() as HTMLInputElement, { target: { value: "Ben" } });
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ questionId: "q-1", productSlug: "oak-desk", body: "Yes,\nit fits.", displayName: "Ben" });
  });

  test("pending: busy submit, double submit swallowed", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<AnswerForm action={action} {...PROPS} defaultOpen />);
    fireEvent.submit(form());
    await waitFor(() => expect(submit()).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(submit());
    expect(calls).toHaveLength(1);
    await act(async () => resolve({ ok: true, kind: "answered", id: "a1", message: "ok" }));
    await waitFor(() => expect(submit()).not.toHaveAttribute("aria-busy"));
  });

  test("validation failure: opens the Disclosure, alert + linked field error, values persist", async () => {
    const { action } = scriptedAction([
      qaFailure("VALIDATION_FAILED", "Please check your answer.", { body: "Too many links." }, { body: HOSTILE, displayName: "Ben" }),
    ]);
    render(<AnswerForm action={action} {...PROPS} />);
    fireEvent.submit(form());
    const err = await screen.findByText("Too many links.");
    expect(details().open).toBe(true);
    expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("Please check your answer."))).toBe(true);
    expect(bodyField()).toHaveAttribute("aria-invalid", "true");
    expect(bodyField().getAttribute("aria-describedby")).toContain(err.id);
    expect(bodyField().value).toBe(HOSTILE);
    expect(nameField()?.value).toBe("Ben");
    expect(document.querySelector("script, img")).toBeNull();
  });

  test("LIMIT_REACHED: warning notice and the submit is disabled", async () => {
    const { action } = scriptedAction([
      qaFailure("LIMIT_REACHED", "You can post up to 3 answers to a question.", {}, { body: "One more" }),
    ]);
    render(<AnswerForm action={action} {...PROPS} defaultOpen />);
    fireEvent.submit(form());
    const title = await screen.findByText("Answer limit reached");
    expect(title.closest('[role="alert"]')?.textContent).toContain("You can post up to 3 answers to a question.");
    expect(submit()).toBeDisabled();
  });

  test("RATE_LIMITED: warning with retry hint, submit stays enabled", async () => {
    const { action } = scriptedAction([qaFailure("RATE_LIMITED", "Slow down.", {}, {}, 30)]);
    render(<AnswerForm action={action} {...PROPS} defaultOpen />);
    fireEvent.submit(form());
    const title = await screen.findByText("Too many posts");
    expect(title.closest('[role="alert"]')?.textContent).toContain("Slow down. Try again in less than a minute.");
    expect(submit()).not.toBeDisabled();
  });

  test("success: notice in a polite live region outside the Disclosure, field cleared", async () => {
    const { action } = scriptedAction([{ ok: true, kind: "answered", id: "a1", message: "ok" }]);
    const { container } = render(<AnswerForm action={action} {...PROPS} defaultOpen />);
    const live = container.querySelector('[aria-live="polite"]:not([data-testid])');
    expect(live).not.toBeNull();
    expect(live?.closest("details")).toBeNull();
    fireEvent.change(bodyField(), { target: { value: "Yes" } });
    fireEvent.submit(form());
    const msg = await screen.findByText(ANSWER_SUCCESS_TEXT);
    expect(msg.closest('[aria-live="polite"]')).toBe(live);
    expect(bodyField().value).toBe("");
  });
});

describe("AnswerForm accessible name (D-T77-1)", () => {
  test("without questionLabelId the form is named 'Answer this question'", () => {
    render(<AnswerForm action={fakeServerAction(async () => null)} {...PROPS} defaultOpen />);
    expect(form()).toHaveAttribute("aria-label", ANSWER_FORM_LABEL);
    expect(form().hasAttribute("aria-labelledby")).toBe(false);
  });

  test("with questionLabelId the form is labelled by a hidden prefix plus the question text", () => {
    render(
      <>
        <p id="q-text">{HOSTILE}</p>
        <AnswerForm action={fakeServerAction(async () => null)} {...PROPS} questionLabelId="q-text" defaultOpen />
      </>,
    );
    expect(form().hasAttribute("aria-label")).toBe(false);
    const ids = (form().getAttribute("aria-labelledby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe("q-text");
    const prefix = document.getElementById(ids[0] ?? "");
    expect(prefix?.hidden).toBe(true);
    expect(prefix?.textContent).toBe(`${ANSWER_FORM_LABEL}:`);
    expect(screen.getByRole("form", { name: `${ANSWER_FORM_LABEL}: ${HOSTILE}` })).toBe(form());
    expect(document.querySelector("script, img[onerror]")).toBeNull();
  });

  test("two instances get distinct prefix ids", () => {
    render(
      <>
        <p id="a">First?</p>
        <p id="b">Second?</p>
        <AnswerForm action={fakeServerAction(async () => null)} {...PROPS} questionLabelId="a" defaultOpen />
        <AnswerForm action={fakeServerAction(async () => null)} {...PROPS} questionLabelId="b" defaultOpen />
      </>,
    );
    expect(screen.getByRole("form", { name: `${ANSWER_FORM_LABEL}: First?` })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: `${ANSWER_FORM_LABEL}: Second?` })).toBeInTheDocument();
  });
});
