import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QaActionFn, QaVoteActionFn } from "@/components/molecules/_contracts/qa-actions";
import { HOSTILE, fakeServerAction, tabOrder } from "@/components/molecules/QuestionForm/qa-test-helpers";
import { QA_PAGE_SIZE, type AnswerView, type QaListResult, type QuestionView } from "@/server/qa/qa-service";
import {
  ASK_QUESTION_DISCLOSURE_ID,
  QA_EMPTY_MESSAGE,
  QA_HEADING,
  QA_PAGE_EMPTY_MESSAGE,
  QA_SECTION_PAGE_SIZE,
  QASection,
  questionCountText,
  type QASectionActions,
  type QASectionProps,
} from "./index";

function answer(qid: string, n: number, over: Partial<AnswerView> = {}): AnswerView {
  return {
    id: `${qid}-a${n}`,
    questionId: qid,
    displayName: `Answerer ${n}`,
    body: `Answer ${n} to ${qid}`,
    isStore: false,
    helpfulCount: 0,
    status: "published",
    createdAt: "2026-11-05T10:00:00.000Z",
    ...over,
  };
}

function question(n: number, answers = 0, over: Partial<QuestionView> = {}): QuestionView {
  const id = `q-${n}`;
  return {
    id,
    productId: "p-1",
    displayName: `Asker ${n}`,
    body: `Question number ${n}?`,
    helpfulCount: n,
    status: "published",
    createdAt: "2026-11-04T10:00:00.000Z",
    answers: Array.from({ length: answers }, (_, i) => answer(id, i + 1)),
    ...over,
  };
}

function list(over: Partial<QaListResult> = {}): QaListResult {
  return {
    items: Array.from({ length: 5 }, (_, i) => question(i + 1, i)),
    total: 12,
    page: 1,
    pageCount: 3,
    ...over,
  };
}

const emptyList: QaListResult = { items: [], total: 0, page: 1, pageCount: 1 };

function noopActions(): QASectionActions {
  const action: QaActionFn = async () => null;
  const vote: QaVoteActionFn = async () => null;
  return { askQuestion: action, answerQuestion: action, voteQuestion: vote, voteAnswer: vote };
}

/** Actions that look like Next server references, so static markup shows real POST forms. */
function serverActions(): QASectionActions {
  return {
    askQuestion: fakeServerAction<QaActionFn>(async () => null),
    answerQuestion: fakeServerAction<QaActionFn>(async () => null),
    voteQuestion: fakeServerAction<QaVoteActionFn>(async () => null),
    voteAnswer: fakeServerAction<QaVoteActionFn>(async () => null),
  };
}

function props(over: Partial<QASectionProps> = {}): QASectionProps {
  return {
    productId: "p-1",
    productSlug: "oak-desk",
    list: list(),
    basePath: "/products/oak-desk",
    actions: noopActions(),
    viewer: { signedInName: null },
    ...over,
  };
}

function askDetails(container: HTMLElement): HTMLDetailsElement {
  const el = container.querySelector(`#${ASK_QUESTION_DISCLOSURE_ID}`);
  if (!(el instanceof HTMLDetailsElement)) throw new Error("no ask-question disclosure");
  return el;
}

describe("QASection", () => {
  test("page size mirrors the service QA_PAGE_SIZE (5)", () => {
    expect(QA_SECTION_PAGE_SIZE).toBe(QA_PAGE_SIZE);
    expect(QA_SECTION_PAGE_SIZE).toBe(5);
  });

  test("questionCountText singular/plural/invalid", () => {
    expect(questionCountText(12)).toBe("12 questions");
    expect(questionCountText(1)).toBe("1 question");
    expect(questionCountText(0)).toBe("0 questions");
    expect(questionCountText(Number.NaN)).toBe("0 questions");
    expect(questionCountText(1234)).toBe("1,234 questions");
  });

  test("criterion 4: section #questions labelled by the heading; total in text", () => {
    const { container } = render(<QASection {...props()} />);
    const section = container.querySelector("section#questions");
    expect(section).not.toBeNull();
    const heading = screen.getByRole("heading", { level: 2, name: QA_HEADING });
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
    expect(screen.getByRole("region", { name: QA_HEADING })).toBe(section as HTMLElement);
    expect(screen.getByTestId("questions-count")).toHaveTextContent("12 questions");
  });

  test("headingLevel 3", () => {
    render(<QASection {...props({ headingLevel: 3 })} />);
    expect(screen.getByRole("heading", { level: 3, name: QA_HEADING })).toBeInTheDocument();
  });

  test("criterion 1: list is an <ol> of QuestionCards with summary and the collapsed ask form on top", () => {
    const { container } = render(<QASection {...props()} />);
    const ol = screen.getByRole("list", { name: "Questions" });
    expect(ol.tagName).toBe("OL");
    const items = within(ol).getAllByRole("listitem").filter((li) => li.parentElement === ol);
    expect(items).toHaveLength(5);
    expect(within(items[0] as HTMLElement).getByRole("article")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–5 of 12 questions")).toBeInTheDocument();
    const details = askDetails(container);
    expect(details.open).toBe(false);
    expect(within(details).getByRole("form", { name: "Ask a question" })).toBeInTheDocument();
    // Ask form precedes the list.
    expect(details.compareDocumentPosition(ol) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(QA_EMPTY_MESSAGE)).toBeNull();
  });

  test("criterion 1: empty state message with the ask form OPEN; no list/pagination", () => {
    const { container } = render(<QASection {...props({ list: emptyList })} />);
    expect(screen.getByText(QA_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByTestId("questions-count")).toHaveTextContent("0 questions");
    expect(askDetails(container).open).toBe(true);
    expect(screen.getByLabelText(/Your question/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Questions" })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  test("criterion 1: pagination links are GET hrefs with qpage and #questions; current page marked", () => {
    render(<QASection {...props({ list: list({ page: 2 }) })} />);
    const nav = screen.getByRole("navigation", { name: "Questions pagination" });
    expect(within(nav).getByRole("link", { name: "Page 3" })).toHaveAttribute(
      "href",
      "/products/oak-desk?qpage=3#questions",
    );
    expect(within(nav).getByRole("link", { name: "Page 1" })).toHaveAttribute("href", "/products/oak-desk#questions");
    expect(within(nav).getByRole("link", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Showing 6–10 of 12 questions")).toBeInTheDocument();
  });

  test("extraParams are preserved on pagination links", () => {
    render(<QASection {...props({ extraParams: { sort: "recent", rpage: "2" } })} />);
    const nav = screen.getByRole("navigation", { name: "Questions pagination" });
    expect(within(nav).getByRole("link", { name: "Page 2" })).toHaveAttribute(
      "href",
      "/products/oak-desk?sort=recent&rpage=2&qpage=2#questions",
    );
  });

  test("1 page or pageCount 0 -> no pagination", () => {
    const { unmount } = render(
      <QASection {...props({ list: list({ items: [question(1)], total: 1, pageCount: 1 }) })} />,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByTestId("questions-count")).toHaveTextContent("1 question");
    unmount();
    render(<QASection {...props({ list: list({ items: [question(1)], total: 1, pageCount: 0 }) })} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  test("page beyond the last page: explains and links to page 1", () => {
    render(<QASection {...props({ list: list({ items: [], page: 9 }) })} />);
    expect(screen.getByText(QA_PAGE_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the first page of questions" })).toHaveAttribute(
      "href",
      "/products/oak-desk#questions",
    );
    expect(screen.queryByText(QA_EMPTY_MESSAGE)).toBeNull();
  });

  test("criterion 2: first 2 answers visible, rest behind 'See all N answers' <details>", () => {
    render(<QASection {...props({ list: list({ items: [question(1, 5)], total: 1, pageCount: 1 }) })} />);
    const card = screen.getByRole("article");
    const visible = within(card).getByRole("list", { name: "Answers (5)" });
    expect(within(visible).getAllByRole("listitem")).toHaveLength(2);
    const summary = within(card).getByText("See all 5 answers");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(within(details as HTMLElement).getAllByRole("listitem")).toHaveLength(3);
  });

  test("signed-in name reaches the ask and answer forms", () => {
    render(<QASection {...props({ viewer: { signedInName: "Ann" }, list: list({ items: [question(1)], total: 1, pageCount: 1 }) })} />);
    expect(screen.getAllByText("Posting as Ann").length).toBeGreaterThanOrEqual(2);
  });

  test("criterion 3: hostile question/answer/name text renders as text only", () => {
    const hostile = question(1, 0, {
      body: HOSTILE,
      displayName: '<img src=x onerror="alert(3)">',
      answers: [answer("q-1", 1, { body: `<b>bold</b>${HOSTILE}`, displayName: "<i>x</i>" })],
    });
    const p = props({ list: list({ items: [hostile], total: 1, pageCount: 1 }) });
    const markup = renderToStaticMarkup(<QASection {...p} />);
    expect(markup).not.toContain("<script>alert");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<b>");
    expect(markup).not.toContain("<i>");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const { container } = render(<QASection {...p} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("i")).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
  });

  test("renderToStaticMarkup: #questions, <details> collapsed parts, POST forms, GET pagination links", () => {
    const markup = renderToStaticMarkup(
      <QASection
        {...props({
          actions: serverActions(),
          list: list({ items: [question(1, 4), question(2, 1)], page: 2 }),
        })}
      />,
    );
    expect(markup).toContain('id="questions"');
    expect(markup).toContain('aria-labelledby="questions-heading"');
    expect(markup).toMatch(/<details[^>]*id="ask-question"/);
    expect(markup).not.toMatch(/<details[^>]*id="ask-question"[^>]*\sopen=/);
    expect(markup).toContain("See all 4 answers");
    expect(markup).toContain('method="POST"');
    expect(markup).toMatch(/encType="multipart\/form-data"/i);
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain('href="/products/oak-desk?qpage=3#questions"');
    expect(markup).toContain('href="/products/oak-desk#questions"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('name="productId" value="p-1"');
  });

  test("renderToStaticMarkup empty state: ask form details rendered open", () => {
    const markup = renderToStaticMarkup(<QASection {...props({ actions: serverActions(), list: emptyList })} />);
    expect(markup).toMatch(/<details[^>]*id="ask-question"[^>]*\sopen=""/);
    expect(markup).toContain(QA_EMPTY_MESSAGE);
  });

  test("criterion 4: forms keyboard-reachable (summary, then fields once open)", () => {
    const { container, unmount } = render(<QASection {...props()} />);
    const order = tabOrder(container);
    const summary = askDetails(container).querySelector("summary");
    expect(order).toContain(summary as HTMLElement);
    // Each card's answer form is reachable via its own summary or fields.
    const cards = screen.getAllByRole("article");
    for (const card of cards) {
      expect(order.some((el) => card.contains(el))).toBe(true);
    }
    unmount();
    const empty = render(<QASection {...props({ list: emptyList })} />);
    const emptyOrder = tabOrder(empty.container);
    expect(emptyOrder).toContain(screen.getByLabelText(/Your question/));
    expect(emptyOrder).toContain(screen.getByRole("button", { name: "Ask" }));
  });

  test("320px-safe: shrinkable containers, no fixed wide widths", () => {
    const { container } = render(<QASection {...props()} />);
    expect(container.querySelector("section#questions")).toHaveClass("min-w-0");
    expect(screen.getByRole("list", { name: "Questions" })).toHaveClass("min-w-0");
    expect(container.innerHTML).not.toMatch(/\b(w|min-w)-\d{3,}\b/);
  });
});

describe("QASection: Phase 3 restyle (T160)", () => {
  test("empty state on a light-grey band; ask form open in a white card disclosure", () => {
    const { container } = render(<QASection {...props({ list: emptyList })} />);
    expect(screen.getByTestId("questions-empty").closest(".bg-surface-sunken")).not.toBeNull();
    const details = askDetails(container);
    expect(details.open).toBe(true);
    expect(details).toHaveClass("rounded-lg", "bg-surface-raised", "shadow-sm");
    expect(within(details).getByRole("form", { name: "Ask a question" })).toBeInTheDocument();
  });

  test("page past the end: grey band and a pill link back to page 1 (href unchanged)", () => {
    render(<QASection {...props({ list: list({ items: [], page: 9 }) })} />);
    const band = screen.getByTestId("questions-page-empty");
    expect(band).toHaveClass("bg-surface-sunken", "rounded-lg");
    const link = within(band).getByRole("link", { name: "Go to the first page of questions" });
    expect(link).toHaveAttribute("href", "/products/oak-desk#questions");
    expect(link).toHaveClass("rounded-full", "min-h-touch");
  });

  test("questions render as white cards inside the ordered list; heading level kept", () => {
    const { container } = render(<QASection {...props({ headingLevel: 3 })} />);
    expect(screen.getByRole("heading", { level: 3, name: QA_HEADING })).toHaveAttribute("id", "questions-heading");
    const ol = screen.getByRole("list", { name: "Questions" });
    const cards = ol.querySelectorAll(":scope > li > article");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card).toHaveClass("bg-surface-raised", "rounded-lg");
    expect(container.querySelectorAll("section#questions")).toHaveLength(1);
  });

  test("hostile question text stays text", () => {
    const { container } = render(
      <QASection {...props({ list: list({ items: [question(1, 0, { body: HOSTILE })], total: 1, pageCount: 1 }) })} />,
    );
    expect(container.querySelector("section#questions img[onerror], section#questions script")).toBeNull();
    expect(screen.getByRole("list", { name: "Questions" })).toHaveTextContent(HOSTILE);
  });
});
