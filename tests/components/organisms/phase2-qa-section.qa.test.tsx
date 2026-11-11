// QA (QA-W4-organisms-B / T90): T77 QASection + buildQaHref.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QaActionFn, QaVoteActionFn } from "@/components/molecules/_contracts/qa-actions";
import {
  ASK_QUESTION_DISCLOSURE_ID,
  QA_EMPTY_MESSAGE,
  QA_HEADING,
  QA_PAGE_EMPTY_MESSAGE,
  QA_PAGE_PARAM,
  QA_SECTION_ID,
  QA_SECTION_PAGE_SIZE,
  QA_VISIBLE_ANSWERS,
  QASection,
  buildQaHref,
  type QASectionActions,
  type QASectionProps,
} from "@/components/organisms/QASection";
import { ProductRail } from "@/components/organisms/ProductRail";
import { isAllowedInternalHref } from "@/content/routes";
import { QA_PAGE_SIZE, type AnswerView, type QaListResult, type QuestionView } from "@/server/qa/qa-service";
import { expectFocused } from "@/test/dom-assertions";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; ‮evil`;
const ROOT = join(import.meta.dir, "../../../src/components/organisms");
const BASE = "/products/desk-lamp";

function answer(qid: string, n: number, over: Partial<AnswerView> = {}): AnswerView {
  return {
    id: `${qid}-a${n}`,
    questionId: qid,
    displayName: `QA Answerer ${n}`,
    body: `QA answer ${n} for ${qid}`,
    isStore: false,
    helpfulCount: 0,
    status: "published",
    createdAt: "2026-11-05T10:00:00.000Z",
    ...over,
  };
}

function question(n: number, answers = 0, over: Partial<QuestionView> = {}): QuestionView {
  const id = `qa-q-${n}`;
  return {
    id,
    productId: "prod-1",
    displayName: `QA Asker ${n}`,
    body: `QA question number ${n}?`,
    helpfulCount: 0,
    status: "published",
    createdAt: "2026-11-04T10:00:00.000Z",
    answers: Array.from({ length: answers }, (_, i) => answer(id, i + 1)),
    ...over,
  };
}

function list(over: Partial<QaListResult> = {}): QaListResult {
  return { items: [1, 2, 3, 4, 5].map((n) => question(n, n - 1)), total: 23, page: 1, pageCount: 5, ...over };
}

const ask: QaActionFn = async () => null;
const vote: QaVoteActionFn = async () => null;
const actions: QASectionActions = { askQuestion: ask, answerQuestion: ask, voteQuestion: vote, voteAnswer: vote };

function props(over: Partial<QASectionProps> = {}): QASectionProps {
  return {
    productId: "prod-1",
    productSlug: "desk-lamp",
    list: list(),
    basePath: BASE,
    actions,
    viewer: { signedInName: null },
    ...over,
  };
}

const STATES: Record<string, Partial<QASectionProps>> = {
  populated: {},
  empty: { list: { items: [], total: 0, page: 1, pageCount: 0 } },
  "page-past-end": { list: { items: [], total: 23, page: 9, pageCount: 5 } },
  "signed-in": { viewer: { signedInName: "Ada" } },
  "last-page": { list: list({ items: [question(21), question(22), question(23)], page: 5 }) },
};

function section(container: HTMLElement): HTMLElement {
  const el = container.querySelector(`section#${QA_SECTION_ID}`);
  if (!(el instanceof HTMLElement)) throw new Error("no section#questions");
  return el;
}

describe("T77.1 empty state with the ask form; <= 5 per page with pagination links", () => {
  test("empty: message, count '0 questions', ask form OPEN, no list, no pagination", () => {
    const { container } = render(<QASection {...props(STATES.empty)} />);
    expect(screen.getByText(QA_EMPTY_MESSAGE)).toBeInTheDocument();
    const details = container.querySelector(`details#${ASK_QUESTION_DISCLOSURE_ID}`) as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(within(details).getByRole("form", { name: "Ask a question" })).toBeInTheDocument();
    expect(container.querySelector("ol, nav")).toBeNull();
    expect(screen.getByText("0 questions")).toBeInTheDocument();
  });

  test("populated: page size matches the service; one list item per question; pagination nav", () => {
    expect(QA_SECTION_PAGE_SIZE).toBe(QA_PAGE_SIZE);
    const { container } = render(<QASection {...props()} />);
    const lists = section(container).querySelectorAll(":scope ol, :scope > ul");
    expect(lists).toHaveLength(1);
    const items = (lists[0] as HTMLElement).querySelectorAll(":scope > li");
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items).toHaveLength(5);
    expect(screen.getByRole("navigation", { name: "Questions pagination" })).toBeInTheDocument();
    // ask form collapsed when there are questions
    expect((container.querySelector(`details#${ASK_QUESTION_DISCLOSURE_ID}`) as HTMLDetailsElement).open).toBe(false);
  });

  test("pagination: hrefs built by buildQaHref, end in #questions, exactly one aria-current=page, all allowed", () => {
    const { container } = render(
      <QASection {...props({ list: list({ page: 3 }), extraParams: { sort: "recent", rpage: "2" } })} />,
    );
    const nav = screen.getByRole("navigation", { name: "Questions pagination" });
    const links = [...nav.querySelectorAll("a[href]")];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      const href = a.getAttribute("href") ?? "";
      expect(href.endsWith(`#${QA_SECTION_ID}`)).toBe(true);
      expect(href.startsWith(`${BASE}?sort=recent&rpage=2`) || href === `${BASE}?sort=recent&rpage=2#questions`).toBe(true);
      expect(isAllowedInternalHref(href)).toBe(true);
    }
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: "Page 1" })).toHaveAttribute("href", `${BASE}?sort=recent&rpage=2#questions`);
    expect(within(nav).getByRole("link", { name: "Page 4" })).toHaveAttribute(
      "href",
      `${BASE}?sort=recent&rpage=2&qpage=4#questions`,
    );
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("page past the end: message + link back to page 1, still has #questions and the ask form", () => {
    const { container } = render(<QASection {...props(STATES["page-past-end"])} />);
    expect(screen.getByText(QA_PAGE_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the first page of questions" })).toHaveAttribute("href", `${BASE}#questions`);
    expect(container.querySelector(`#${ASK_QUESTION_DISCLOSURE_ID}`)).not.toBeNull();
  });

  test("garbage list numbers (NaN, negative, Infinity) never render NaN and fall back to page 1", () => {
    const { container } = render(
      <QASection {...props({ list: list({ total: Number.NaN, page: -4, pageCount: Number.POSITIVE_INFINITY }) })} />,
    );
    expect(container.textContent ?? "").not.toMatch(/NaN|Infinity/);
  });
});

describe("buildQaHref", () => {
  test("drops page 1 and invalid pages; keeps valid pages", () => {
    expect(buildQaHref(BASE)).toBe(`${BASE}#questions`);
    for (const bad of [1, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      expect(buildQaHref(BASE, { qpage: bad })).toBe(`${BASE}#questions`);
    }
    expect(buildQaHref(BASE, { qpage: 2 })).toBe(`${BASE}?${QA_PAGE_PARAM}=2#questions`);
  });

  test("patch with qpage: undefined removes the page; absent patch keeps it", () => {
    expect(buildQaHref(BASE, { qpage: 3 }, {})).toBe(`${BASE}?qpage=3#questions`);
    expect(buildQaHref(BASE, { qpage: 3 }, { qpage: undefined })).toBe(`${BASE}#questions`);
    expect(buildQaHref(BASE, { qpage: 3 }, { qpage: 4 })).toBe(`${BASE}?qpage=4#questions`);
  });

  test("strips query and fragment from basePath", () => {
    expect(buildQaHref(`${BASE}?qpage=9&x=1#reviews`, { qpage: 2 })).toBe(`${BASE}?qpage=2#questions`);
    expect(buildQaHref(`${BASE}#frag`)).toBe(`${BASE}#questions`);
  });

  test("extra params kept in order, encoded; qpage / empty name / undefined ignored; arrays repeated", () => {
    const href = buildQaHref(BASE, {
      qpage: 2,
      extra: { qpage: "7", "": "x", sort: "recent", stars: ["5", "4"], skip: undefined, q: "a&b=c#d" },
    });
    expect(href).toBe(`${BASE}?sort=recent&stars=5&stars=4&q=a%26b%3Dc%23d&qpage=2#questions`);
    const url = new URL(href, "https://shop.test");
    expect(url.searchParams.getAll("qpage")).toEqual(["2"]);
    expect(url.hash).toBe("#questions");
  });
});

describe("T77.2 first 2 answers, 'See all N answers' Disclosure (no-JS friendly)", () => {
  test("5 answers: 2 visible, 3 inside a closed <details> whose summary reads 'See all 5 answers'", () => {
    const q = question(1, 5);
    const { container } = render(<QASection {...props({ list: list({ items: [q], total: 1, pageCount: 1 }) })} />);
    expect(QA_VISIBLE_ANSWERS).toBe(2);
    const visibleList = screen.getByRole("list", { name: "Answers (5)" });
    expect(within(visibleList).getAllByRole("listitem")).toHaveLength(2);
    const summary = [...container.querySelectorAll("summary")].find((s) => s.textContent?.includes("See all 5 answers"));
    expect(summary).toBeDefined();
    const details = summary?.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelectorAll("li")).toHaveLength(3);
    // no-JS: the hidden answers are in the static HTML inside <details>
    const html = renderToStaticMarkup(<QASection {...props({ list: list({ items: [q], total: 1, pageCount: 1 }) })} />);
    expect(html).toContain("See all 5 answers");
    expect(html).toContain("QA answer 5 for qa-q-1");
  });

  test("exactly 2 answers: no 'See all' disclosure", () => {
    const { container } = render(
      <QASection {...props({ list: list({ items: [question(1, 2)], total: 1, pageCount: 1 }) })} />,
    );
    expect(container.textContent).not.toContain("See all");
  });
});

describe("T77.3 hostile text renders as text", () => {
  test("hostile question, answer and display names: no script/img injected; text present", () => {
    const q = question(1, 3, {
      body: HOSTILE,
      displayName: HOSTILE,
      answers: [answer("qa-q-1", 1, { body: HOSTILE, displayName: HOSTILE, isStore: true }), answer("qa-q-1", 2), answer("qa-q-1", 3, { body: HOSTILE })],
    });
    const p = props({ list: list({ items: [q], total: 1, pageCount: 1 }), viewer: { signedInName: HOSTILE } });
    const { container } = render(<QASection {...p} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
    expect(screen.getByText("Store answer")).toBeInTheDocument();
    const html = renderToStaticMarkup(<QASection {...p} />);
    expect(html).not.toContain("<script>alert(2)");
    expect(html).not.toContain("<img src=x");
  });
});

describe("T77.4 landmarks, ids, keyboard reachability", () => {
  for (const [name, over] of Object.entries(STATES)) {
    test(`${name}: section#questions labelled '${QA_HEADING}', #ask-question present, ids unique, headings not skipped`, () => {
      const { container } = render(<QASection {...props(over)} />);
      const sec = section(container);
      expect(screen.getByRole("region", { name: QA_HEADING })).toBe(sec);
      expect(sec.querySelectorAll(`#${ASK_QUESTION_DISCLOSURE_ID}`)).toHaveLength(1);
      const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
      expect(new Set(ids).size).toBe(ids.length);
      const levels = [...sec.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
      expect(levels[0]).toBe(2);
      for (let i = 1; i < levels.length; i++) expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
      const html = renderToStaticMarkup(<QASection {...props(over)} />);
      expect(html).toContain(`id="${QA_SECTION_ID}"`);
      expect(html).toContain(`id="${ASK_QUESTION_DISCLOSURE_ID}"`);
    });
  }

  test("headingLevel 3 renders an h3 heading and no h1/h2", () => {
    const { container } = render(<QASection {...props({ headingLevel: 3 })} />);
    expect(screen.getByRole("heading", { level: 3, name: QA_HEADING })).toBeInTheDocument();
    expect(container.querySelector("h1, h2")).toBeNull();
  });

  test("ask form present for guests (with name field) AND signed-in viewers (posting as, no name field)", () => {
    const guest = render(<QASection {...props(STATES.empty)} />);
    const gForm = within(guest.container).getByRole("form", { name: "Ask a question" });
    expect(gForm.querySelector('textarea[name="body"]')).not.toBeNull();
    expect(gForm.querySelector('input[name="displayName"]')).not.toBeNull();
    guest.unmount();
    const user = render(<QASection {...props({ ...STATES.empty, viewer: { signedInName: "Ada" } })} />);
    const uForm = within(user.container).getByRole("form", { name: "Ask a question" });
    expect(uForm.querySelector('textarea[name="body"]')).not.toBeNull();
    expect(uForm.querySelector('input[name="displayName"]')).toBeNull();
    expect(user.container.textContent).toContain("Ada");
  });

  test("ask form posts productId/productSlug/body (+displayName for guests) and maxLength mirrors the caps", () => {
    const { container } = render(<QASection {...props(STATES.empty)} />);
    const f = within(container).getByRole("form", { name: "Ask a question" }) as HTMLFormElement;
    const names = new Set([...new FormData(f).keys()]);
    expect([...names].sort()).toEqual(["body", "displayName", "productId", "productSlug"]);
    expect(f.querySelector("textarea")?.getAttribute("maxlength")).toBe("300");
    expect(f.querySelector('input[name="displayName"]')?.getAttribute("maxlength")).toBe("50");
  });

  test("keyboard: summaries are reachable, opening 'Ask a question' exposes the textarea", () => {
    const { container } = render(<QASection {...props()} />);
    const askSummary = container.querySelector(`details#${ASK_QUESTION_DISCLOSURE_ID} > summary`) as HTMLElement;
    expect(askSummary).not.toBeNull();
    askSummary.focus();
    expectFocused(askSummary);
    fireEvent.click(askSummary);
    expect((container.querySelector(`details#${ASK_QUESTION_DISCLOSURE_ID}`) as HTMLDetailsElement).open).toBe(true);
    const ta = container.querySelector(`details#${ASK_QUESTION_DISCLOSURE_ID} textarea`) as HTMLTextAreaElement;
    ta.focus();
    expectFocused(ta);
  });

  test("next to a ProductRail on the same page: region names and ids stay unique", () => {
    const { container } = render(
      <main>
        <QASection {...props()} />
        <ProductRail
          title="Customers also viewed"
          products={[{ id: "x1", slug: "x-1", name: "X", description: "", priceCents: 1, currency: "USD", imageUrl: "/i.jpg", stock: 1 }]}
        />
      </main>,
    );
    const names = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label") ?? r.getAttribute("aria-labelledby"));
    expect(new Set(names).size).toBe(names.length);
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("DEFECT D-T77-1 evidence (fixed in FIX-org-B): each open answer form is named 'Answer this question: <question>'", () => {
    const { container } = render(<QASection {...props()} />);
    for (const s of container.querySelectorAll("summary")) {
      if (s.textContent === "Answer this question") fireEvent.click(s);
    }
    for (const n of [1, 2, 3, 4, 5]) {
      expect(screen.getByRole("form", { name: `Answer this question: QA question number ${n}?` })).toBeInTheDocument();
    }
  });

  test("DEFECT D-T77-1: open answer forms are uniquely named form landmarks (SR6)", () => {
    const { container } = render(<QASection {...props()} />);
    for (const s of container.querySelectorAll("summary")) {
      if (s.textContent === "Answer this question") fireEvent.click(s);
    }
    const named = screen.getAllByRole("form").map((f) => f.getAttribute("aria-label") ?? f.getAttribute("aria-labelledby"));
    expect(new Set(named).size).toBe(named.length);
  });
});

describe("QASection source rules", () => {
  test("no `use client` in the wrapper; server import is type-only; no inline style / raw HTML", () => {
    for (const f of ["QASection.tsx", "qa-href.ts"]) {
      const src = readFileSync(join(ROOT, "QASection", f), "utf8");
      expect(src).not.toMatch(/^\s*['"]use client['"]/m);
      for (const line of src.split("\n").filter((l) => l.includes("@/server/"))) expect(line).toMatch(/^import type /);
      expect(src).not.toMatch(/style=|dangerouslySetInnerHTML/);
    }
  });
});
