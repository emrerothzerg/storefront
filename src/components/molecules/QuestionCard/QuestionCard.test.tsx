import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnswerView, QuestionView } from "@/server/qa/qa-service";
import type { QaVoteActionFn } from "../_contracts/qa-actions";
import {
  HOSTILE,
  controlledVote,
  fakeServerAction,
  pressTab,
  scriptedAction,
  snapshot,
  voteFailure,
  type Fields,
} from "../QuestionForm/qa-test-helpers";
import { QuestionCard, helpfulCountText } from "./index";
import { expectFocused } from "@/test/dom-assertions";

function answer(id: string, over: Partial<AnswerView> = {}): AnswerView {
  return {
    id,
    questionId: "q-1",
    displayName: `Answerer ${id}`,
    body: `Answer body ${id}`,
    isStore: false,
    helpfulCount: 0,
    status: "published",
    createdAt: "2026-11-05T10:00:00.000Z",
    ...over,
  };
}

function question(over: Partial<QuestionView> = {}): QuestionView {
  return {
    id: "q-1",
    productId: "p-1",
    displayName: "Asker",
    body: "Does it fit a 27 inch monitor?",
    helpfulCount: 4,
    status: "published",
    createdAt: "2026-11-04T10:00:00.000Z",
    answers: [],
    ...over,
  };
}

function recordingVote(): { action: QaVoteActionFn; calls: Fields[] } {
  const calls: Fields[] = [];
  const action: QaVoteActionFn = async (_p, fd) => {
    calls.push(snapshot(fd));
    return null;
  };
  return { action, calls };
}

const noopVote: QaVoteActionFn = async () => null;

function renderCard(q: QuestionView, extra: { voteQuestion?: QaVoteActionFn; voteAnswer?: QaVoteActionFn; maxVisibleAnswers?: number } = {}) {
  return render(
    <QuestionCard
      question={q}
      voteQuestion={extra.voteQuestion ?? noopVote}
      voteAnswer={extra.voteAnswer ?? noopVote}
      answerAction={scriptedAction([]).action}
      productSlug="oak-desk"
      maxVisibleAnswers={extra.maxVisibleAnswers}
    />,
  );
}

describe("helpfulCountText", () => {
  test("singular/plural", () => {
    expect(helpfulCountText(1)).toBe("1 person found this helpful");
    expect(helpfulCountText(3)).toBe("3 people found this helpful");
  });
});

describe("QuestionCard no-JS markup", () => {
  test("article with POST vote forms (hidden ids), collapsed <details> for extra answers and the answer form", () => {
    const vq = fakeServerAction<QaVoteActionFn>(async () => null);
    const va = fakeServerAction<QaVoteActionFn>(async () => null);
    const html = renderToStaticMarkup(
      <QuestionCard
        question={question({ answers: [answer("a1"), answer("a2"), answer("a3")] })}
        voteQuestion={vq}
        voteAnswer={va}
        answerAction={fakeServerAction(scriptedAction([]).action)}
        productSlug="oak-desk"
      />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("article")).not.toBeNull();
    const forms = [...doc.querySelectorAll("form")];
    // 1 question vote + 3 answer votes + 1 answer form
    expect(forms).toHaveLength(5);
    for (const f of forms) {
      expect(f.getAttribute("method")).toBe("POST");
      expect(f.querySelector('input[type="hidden"][name="productSlug"]')?.getAttribute("value")).toBe("oak-desk");
    }
    expect(forms[0]?.querySelector('input[name="questionId"]')?.getAttribute("value")).toBe("q-1");
    const answerIds = [...doc.querySelectorAll('input[type="hidden"][name="answerId"]')].map((i) => i.getAttribute("value"));
    expect(answerIds).toEqual(["a1", "a2", "a3"]);
    const details = [...doc.querySelectorAll("details")];
    expect(details.map((d) => d.querySelector("summary")?.textContent)).toEqual(["See all 3 answers", "Answer this question"]);
    expect(details.every((d) => !d.hasAttribute("open"))).toBe(true);
    expect(details[0]?.querySelector('input[name="answerId"]')?.getAttribute("value")).toBe("a3");
    // Helpful counts are never posted.
    expect(doc.querySelector('[name="helpfulCount"]')).toBeNull();
  });
});

describe("QuestionCard", () => {
  test("hostile question/answer/name text renders as text nodes only", () => {
    renderCard(
      question({
        body: HOSTILE,
        displayName: HOSTILE,
        answers: [answer("a1", { body: HOSTILE, displayName: HOSTILE })],
      }),
    );
    expect(document.querySelector("article script, article img")).toBeNull();
    expect(document.querySelector("script, img")).toBeNull();
    const article = screen.getByRole("article");
    expect(article.textContent).toContain(HOSTILE);
  });

  test("shows asker name and UTC date in a <time>", () => {
    renderCard(question());
    const time = screen.getByText("November 4, 2026");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", "2026-11-04T10:00:00.000Z");
    expect(screen.getByText("Asker")).toBeInTheDocument();
  });

  test("store answers carry a 'Store answer' text badge; others do not", () => {
    renderCard(question({ answers: [answer("a1", { isStore: true, displayName: "Oak & Co" }), answer("a2")] }));
    const items = within(screen.getByRole("list", { name: "Answers (2)" })).getAllByRole("listitem");
    expect(within(items[0] as HTMLElement).getByText("Store answer")).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).queryByText("Store answer")).toBeNull();
  });

  test("answer body keeps line breaks (whitespace-pre-line)", () => {
    renderCard(question({ answers: [answer("a1", { body: "Line one\nLine two" })] }));
    const p = screen.getByText((_, el) => el?.textContent === "Line one\nLine two" && el.tagName === "P");
    expect(p.className).toContain("whitespace-pre-line");
  });

  test("no answers: says so and still offers the answer form", () => {
    renderCard(question());
    expect(screen.getByText("No answers yet.")).toBeInTheDocument();
    expect(screen.getByText("Answer this question")).toBeInTheDocument();
  });

  test("maxVisibleAnswers: extra answers live in a 'See all N answers' Disclosure", () => {
    renderCard(question({ answers: [answer("a1"), answer("a2"), answer("a3"), answer("a4")] }), { maxVisibleAnswers: 1 });
    expect(within(screen.getByRole("list", { name: "Answers (4)" })).getAllByRole("listitem")).toHaveLength(1);
    const summary = screen.getByText("See all 4 answers");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getAllByRole("listitem", { hidden: true })).toHaveLength(3);
  });

  test("all answers visible when count <= limit (no 'See all')", () => {
    renderCard(question({ answers: [answer("a1"), answer("a2")] }));
    expect(screen.queryByText(/See all/)).toBeNull();
  });

  test("question vote: shows count, posts questionId + slug only", async () => {
    const { action, calls } = recordingVote();
    renderCard(question(), { voteQuestion: action });
    fireEvent.click(screen.getByRole("button", { name: "Helpful (4)" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ questionId: "q-1", productSlug: "oak-desk" });
  });

  test("answer vote posts answerId", async () => {
    const { action, calls } = recordingVote();
    renderCard(question({ helpfulCount: 0, answers: [answer("a1", { helpfulCount: 2 })] }), { voteAnswer: action });
    fireEvent.click(screen.getByRole("button", { name: "Helpful (2)" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ answerId: "a1", productSlug: "oak-desk" });
  });

  test("vote pending is per form; success updates count and shows 'You found this helpful'", async () => {
    const q = controlledVote();
    renderCard(question({ answers: [answer("a1", { helpfulCount: 1 })] }), { voteQuestion: q.action });
    fireEvent.click(screen.getByRole("button", { name: "Helpful (4)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Helpful \(4\)/ })).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("button", { name: "Helpful (1)" })).not.toHaveAttribute("aria-busy");
    await act(async () => q.resolve({ ok: true, helpfulCount: 5, message: "Thanks for your feedback." }));
    await screen.findByText("You found this helpful");
    expect(screen.getByText("5 people found this helpful")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Helpful \(4\)/ })).toBeNull();
    expect(screen.getByText("Thanks for your feedback.").closest('[aria-live="polite"]')).not.toBeNull();
  });

  test("vote failure (FORBIDDEN / RATE_LIMITED) is announced in an alert and keeps the button", async () => {
    const q = controlledVote();
    renderCard(question(), { voteQuestion: q.action });
    fireEvent.click(screen.getByRole("button", { name: "Helpful (4)" }));
    await waitFor(() => expect(q.calls).toHaveLength(1));
    await act(async () => q.resolve(voteFailure("RATE_LIMITED", "Too many votes.", 90)));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many votes. Try again in about 2 minutes.");
    expect(screen.getByRole("button", { name: "Helpful (4)" })).toBeInTheDocument();
  });

  test("DUPLICATE vote counts as already voted (no alert)", async () => {
    const q = controlledVote();
    renderCard(question(), { voteQuestion: q.action });
    fireEvent.click(screen.getByRole("button", { name: "Helpful (4)" }));
    await waitFor(() => expect(q.calls).toHaveLength(1));
    await act(async () => q.resolve(voteFailure("DUPLICATE", "Already voted.")));
    await screen.findByText("You found this helpful");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("own question/answer: no vote button, count still shown as text", () => {
    renderCard(question({ isOwn: true, answers: [answer("a1", { isOwn: true, helpfulCount: 1 })] }));
    expect(screen.queryByRole("button", { name: /Helpful/ })).toBeNull();
    expect(screen.getByText("4 people found this helpful")).toBeInTheDocument();
    expect(screen.getByText("1 person found this helpful")).toBeInTheDocument();
    expect(document.querySelector('input[name="questionId"][type="hidden"]')).not.toBeNull(); // answer form only
    expect(document.querySelector('input[name="answerId"]')).toBeNull();
  });

  test("votedByViewer: 'You found this helpful', no button", () => {
    renderCard(question({ votedByViewer: true }));
    expect(screen.getByText("You found this helpful")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Helpful/ })).toBeNull();
  });

  test("keyboard: the inline AnswerForm is reachable with Tab after expanding", () => {
    renderCard(question({ answers: [answer("a1")] }));
    const summary = screen.getByText("Answer this question").closest("summary") as HTMLElement;
    summary.focus();
    (summary.parentElement as HTMLDetailsElement).open = true;
    const next = pressTab();
    expect(next?.tagName).toBe("TEXTAREA");
    expect(next).toHaveAttribute("name", "body");
    expectFocused(next);
  });

  test("320px-safe: long unbroken text wraps (break-words / min-w-0)", () => {
    renderCard(question({ body: "x".repeat(300), answers: [answer("a1", { body: "y".repeat(500) })] }));
    const article = screen.getByRole("article");
    expect(article.className).toContain("min-w-0");
    expect(screen.getByText("y".repeat(500)).className).toContain("break-words");
    expect(article.innerHTML).not.toMatch(/\bw-\[|min-w-\[|\[\d+px\]/);
  });
});

describe("QuestionCard distinguishable names (FIX-org-B)", () => {
  test("answer form is named by the question; helpful buttons are described by their question/answer text", () => {
    const q = question({ body: HOSTILE, answers: [answer("a1", { body: "First answer" })] });
    const { container } = renderCard(q);
    fireEvent.click(screen.getByText("Answer this question"));
    expect(screen.getByRole("form", { name: `Answer this question: ${HOSTILE}` })).toBeInTheDocument();
    const [qButton, aButton] = screen.getAllByRole("button", { name: /^Helpful/ });
    const qDesc = document.getElementById(qButton?.getAttribute("aria-describedby") ?? "");
    const aDesc = document.getElementById(aButton?.getAttribute("aria-describedby") ?? "");
    expect(qDesc?.textContent).toBe(HOSTILE);
    expect(aDesc?.textContent).toBe("First answer");
    expect(container.querySelector("script, img[onerror]")).toBeNull();
  });

  test("two cards produce distinct ids and form names", () => {
    render(
      <>
        <QuestionCard question={question({ id: "q-1", body: "One?" })} voteQuestion={noopVote} voteAnswer={noopVote} answerAction={scriptedAction([]).action} productSlug="oak-desk" />
        <QuestionCard question={question({ id: "q-2", body: "Two?" })} voteQuestion={noopVote} voteAnswer={noopVote} answerAction={scriptedAction([]).action} productSlug="oak-desk" />
      </>,
    );
    const buttons = screen.getAllByRole("button", { name: /^Helpful/ });
    const described = buttons.map((b) => b.getAttribute("aria-describedby"));
    expect(new Set(described).size).toBe(2);
    expect(screen.getAllByRole("form", { hidden: true }).length).toBeGreaterThan(0);
    const names = [...document.querySelectorAll("form[aria-labelledby]")].map((f) => f.getAttribute("aria-labelledby"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

describe("QuestionCard read-only mode (CONS-B4 an)", () => {
  test("without answerAction: no answer form, no textarea, no questionId input", () => {
    const { container } = render(
      <QuestionCard
        question={question({ isOwn: true, answers: [answer("a1")] })}
        voteQuestion={noopVote}
        voteAnswer={noopVote}
        productSlug="oak-desk"
      />,
    );
    expect(screen.queryByText("Answer this question")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('input[name="questionId"]')).toBeNull();
    // The own question has no vote form; another shopper's answer keeps its own (vote actions given).
    expect(screen.getAllByRole("button", { name: /^Helpful/ })).toHaveLength(1);
    // Own question: count as text, no question vote form; the answer is still listed.
    expect(screen.getByText("4 people found this helpful")).toBeInTheDocument();
    expect(screen.getByText("Answer body a1")).toBeInTheDocument();
  });

  test("no-JS markup without answerAction has no answer <details>", () => {
    const html = renderToStaticMarkup(
      <QuestionCard question={question({ isOwn: true })} voteQuestion={noopVote} voteAnswer={noopVote} productSlug="oak-desk" />,
    );
    expect(html).not.toContain("Answer this question");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("No answers yet.");
  });

  test("badge slot renders next to the asker line; absent by default", () => {
    const { rerender } = render(
      <QuestionCard
        question={question()}
        voteQuestion={noopVote}
        voteAnswer={noopVote}
        productSlug="oak-desk"
        badge={<span data-testid="status-badge">Not published</span>}
      />,
    );
    const badge = screen.getByTestId("status-badge");
    expect(badge).toHaveTextContent("Not published");
    expect(badge.parentElement?.textContent).toContain("Asked by");
    rerender(<QuestionCard question={question()} voteQuestion={noopVote} voteAnswer={noopVote} productSlug="oak-desk" />);
    expect(screen.queryByText("Not published")).toBeNull();
  });
});

describe("QuestionCard without vote actions (CONS-B4 an)", () => {
  test("no answerAction and no vote actions: no <form> at all; counts as text", () => {
    const { container } = render(
      <QuestionCard
        question={question({ helpfulCount: 1, answers: [answer("a1", { helpfulCount: 3 }), answer("a2")] })}
        productSlug="oak-desk"
      />,
    );
    expect(container.querySelector("form, textarea, button")).toBeNull();
    expect(screen.getByText("1 person found this helpful")).toBeInTheDocument();
    expect(screen.getByText("3 people found this helpful")).toBeInTheDocument();
    // Zero counts render nothing.
    expect(screen.getAllByText(/found this helpful/)).toHaveLength(2);
  });

  test("only voteAnswer: the question shows its count as text, answers keep their forms", () => {
    render(<QuestionCard question={question({ answers: [answer("a1")] })} voteAnswer={noopVote} productSlug="oak-desk" />);
    expect(screen.getByText("4 people found this helpful")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Helpful/ })).toHaveLength(1);
    expect(document.querySelector('input[name="answerId"]')).not.toBeNull();
    expect(document.querySelector('input[name="questionId"]')).toBeNull();
  });
});
