// QA (T70 / QA-W3-molecules-B): T59 QuestionCard, QuestionForm, AnswerForm (+ HelpfulVote).
// Independent of the implementer's colocated tests; imports only public entry points.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QuestionCard, HelpfulVote } from "@/components/molecules/QuestionCard";
import { QuestionForm } from "@/components/molecules/QuestionForm";
import { AnswerForm } from "@/components/molecules/AnswerForm";
import type {
  QaActionFn,
  QaActionState,
  QaEchoValues,
  QaVoteActionFn,
  QaVoteActionState,
} from "@/components/molecules/_contracts/qa-actions";
import { appError } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import type { AnswerView, QuestionView } from "@/server/qa/qa-service";
import { expectFocused } from "@/test/dom-assertions";

type Fields = Record<string, string>;

function snapshot(fd: FormData): Fields {
  const out: Fields = {};
  fd.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}

/** Action that stays pending until released. */
function gated<S>() {
  const calls: Fields[] = [];
  const resolvers: Array<(s: S) => void> = [];
  const action = (_prev: S, fd: FormData): Promise<S> => {
    calls.push(snapshot(fd));
    return new Promise<S>((res) => resolvers.push(res));
  };
  const release = async (s: S) => {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        resolvers.splice(0).forEach((r) => r(s));
        await new Promise((r) => setTimeout(r, 5));
      });
      if (resolvers.length === 0 && i > 2) break;
    }
  };
  return { action, calls, release };
}

function scripted<S>(steps: readonly S[], fallback: S) {
  const calls: Fields[] = [];
  const action = async (_prev: S, fd: FormData): Promise<S> => {
    calls.push(snapshot(fd));
    return steps[calls.length - 1] ?? fallback;
  };
  return { action, calls };
}

function qaFail(
  code: ErrorCode,
  message: string,
  fieldErrors: Partial<Record<keyof QaEchoValues, string>> = {},
  values: QaEchoValues = {},
  retryAfterSeconds?: number,
): QaActionState {
  const base = { ok: false as const, error: appError(code, message), message, fieldErrors, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

function voteFail(code: ErrorCode, message: string, retryAfterSeconds?: number): QaVoteActionState {
  const base = { ok: false as const, error: appError(code, message), message };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

// Mimics a Next server-action reference so renderToStaticMarkup emits a real POST form.
const formMeta = (prefix: string) => ({
  name: `$ACTION_ID_qa${prefix}`,
  action: "",
  encType: "multipart/form-data",
  method: "POST",
  data: null,
});
function serverRef<F extends (...args: never[]) => unknown>(fn: F): F {
  const bind = (thisArg: unknown, ...args: unknown[]) =>
    Object.assign(Function.prototype.bind.call(fn, thisArg, ...args), { $$FORM_ACTION: formMeta });
  return Object.assign(fn, { $$FORM_ACTION: formMeta, bind });
}

const HOSTILE = [
  `<script>window.__pwned = 1</script>`,
  `<img src=x onerror="window.__pwned=1">`,
  `"><svg onload=alert(1)>`,
  `<a href="javascript:alert(1)">click</a>`,
];
const RTL = "‮مرحبا بالعالم שלום";

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

const nullVote: QaVoteActionFn = async () => null;
const nullAction: QaActionFn = async () => null;

function card(q: QuestionView, extra: Partial<Parameters<typeof QuestionCard>[0]> = {}) {
  return (
    <QuestionCard
      question={q}
      voteQuestion={nullVote}
      voteAnswer={nullVote}
      answerAction={nullAction}
      productSlug="oak-desk"
      {...extra}
    />
  );
}

// The Disclosure chevron is a legitimate <svg>; injected markup would carry handlers or these tags.
const INJECTED = "script, img, iframe, a[href^='javascript'], [onerror], [onload], svg[onload]";

// ---------------------------------------------------------------------------
// Criterion 1: plain text only, store badge
// ---------------------------------------------------------------------------
describe("T59 criterion 1: text rendering", () => {
  test("hostile question/answer/name strings create no elements and appear verbatim as text", () => {
    for (const evil of HOSTILE) {
      const q = question({
        body: evil,
        displayName: evil,
        answers: [answer("a1", { body: evil, displayName: evil }), answer("a2", { body: `x\n${evil}`, displayName: evil })],
      });
      const { container, unmount } = render(card(q));
      const article = container.querySelector("article");
      expect(article).not.toBeNull();
      // Only allowed images: none (Avatar is decorative initials, no <img> with src=x)
      expect(container.querySelectorAll(INJECTED).length).toBe(0);
      expect(article?.textContent ?? "").toContain(evil);
      unmount();
    }
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });

  test("hostile text in static markup is entity-escaped", () => {
    const evil = HOSTILE[0] ?? "";
    const html = renderToStaticMarkup(card(question({ body: evil, answers: [answer("a1", { body: evil })] })));
    // React appends its own form-replay <script> for plain-function actions; the user text must not appear raw.
    expect(html).not.toContain("<script>window");
    expect(html).toContain("&lt;script&gt;window.__pwned = 1&lt;/script&gt;");
  });

  test("10k-char and RTL text render as text (no truncation by the UI, break-words present)", () => {
    const long = "W".repeat(10_000);
    const { container } = render(card(question({ body: long, displayName: RTL, answers: [answer("a1", { body: RTL })] })));
    expect(container.textContent).toContain(long);
    expect(container.textContent).toContain(RTL);
    const bodyEl = screen.getByText(long, { exact: false });
    expect(bodyEl.className).toContain("break-words");
  });

  test("store answers carry a text 'Store answer' badge; customer answers do not", () => {
    const q = question({ answers: [answer("a1", { isStore: true }), answer("a2")] });
    render(card(q));
    const items = within(screen.getByRole("list", { name: /Answers/ })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("Store answer")).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).queryByText("Store answer")).toBeNull();
  });

  test("a customer cannot fake the badge with a display name: badge only from isStore", () => {
    const q = question({ answers: [answer("a1", { displayName: "Store answer", isStore: false })] });
    const { container } = render(card(q));
    // the only "Store answer" text is the display name inside the byline, not a Badge element
    const matches = within(container).getAllByText("Store answer");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.tagName).toBe("SPAN");
    expect(matches[0]?.className).toContain("font-semibold");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: caps and announced errors
// ---------------------------------------------------------------------------
describe("T59 criterion 2: caps mirror the input-limits table; errors announced", () => {
  test("QuestionForm: body minLength 10 / maxLength 300, display name maxLength 50", () => {
    render(<QuestionForm action={nullAction} productId="p-1" productSlug="oak-desk" />);
    const body = screen.getByRole("textbox", { name: /Your question/ });
    expect(body).toHaveAttribute("maxlength", "300");
    expect(body).toHaveAttribute("minlength", "10");
    expect(body).toHaveAttribute("name", "body");
    expect(body).toBeRequired();
    const name = screen.getByRole("textbox", { name: /Display name/ });
    expect(name).toHaveAttribute("maxlength", "50");
    expect(name).toHaveAttribute("name", "displayName");
  });

  test("AnswerForm: body maxLength 1000, display name 50", () => {
    render(<AnswerForm action={nullAction} questionId="q-1" productSlug="oak-desk" defaultOpen />);
    expect(screen.getByRole("textbox", { name: /Your answer/ })).toHaveAttribute("maxlength", "1000");
    expect(screen.getByRole("textbox", { name: /Display name/ })).toHaveAttribute("maxlength", "50");
  });

  test("signed-in shoppers see 'Posting as <name>' and no name field; whitespace-only name keeps the field", () => {
    const { unmount } = render(
      <QuestionForm action={nullAction} productId="p-1" productSlug="oak-desk" signedInName={HOSTILE[0]} />,
    );
    expect(screen.queryByRole("textbox", { name: /Display name/ })).toBeNull();
    expect(screen.getByText(`Posting as ${HOSTILE[0]}`)).toBeInTheDocument();
    expect(document.querySelectorAll("script").length).toBe(0);
    unmount();
    render(<QuestionForm action={nullAction} productId="p-1" productSlug="oak-desk" signedInName="   " />);
    expect(screen.getByRole("textbox", { name: /Display name/ })).toBeInTheDocument();
  });

  test("QuestionForm failure: role=alert summary, field error linked via aria-describedby, echoed values re-filled", async () => {
    const { action } = scripted<QaActionState>(
      [qaFail("VALIDATION_FAILED", "Check your question.", { body: "Question is too short." }, { body: "short?", displayName: "Bo" })],
      null,
    );
    render(<QuestionForm action={action} productId="p-1" productSlug="oak-desk" />);
    fireEvent.submit(screen.getByRole("form", { name: "Ask a question" }));
    const alert = (await screen.findAllByRole("alert"))[0];
    expect(alert).toHaveTextContent("Check your question.");
    const body = screen.getByRole("textbox", { name: /Your question/ });
    expect(body).toHaveAttribute("aria-invalid", "true");
    const describedBy = (body.getAttribute("aria-describedby") ?? "").split(/\s+/);
    const texts = describedBy.map((id) => document.getElementById(id)?.textContent ?? "");
    expect(texts.join(" ")).toContain("Question is too short.");
    expect(body).toHaveValue("short?");
    expect(screen.getByRole("textbox", { name: /Display name/ })).toHaveValue("Bo");
  });

  test("RATE_LIMITED adds a retry hint; LIMIT_REACHED disables 'Post answer'", async () => {
    const ask = scripted<QaActionState>([qaFail("RATE_LIMITED", "Too many questions.", {}, {}, 125)], null);
    const { unmount } = render(<QuestionForm action={ask.action} productId="p-1" productSlug="oak-desk" />);
    fireEvent.submit(screen.getByRole("form", { name: "Ask a question" }));
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Too many questions. Try again in about 3 minutes.");
    unmount();

    const ans = scripted<QaActionState>([qaFail("LIMIT_REACHED", "You can post 3 answers per question.")], null);
    render(<AnswerForm action={ans.action} questionId="q-1" productSlug="oak-desk" defaultOpen />);
    fireEvent.submit(screen.getByRole("form", { name: "Answer this question" }));
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("You can post 3 answers per question.");
    expect(screen.getByRole("button", { name: "Post answer" })).toBeDisabled();
  });

  test("AnswerForm reopens itself after a failure so the error is visible", async () => {
    const ans = scripted<QaActionState>([qaFail("TOO_LONG", "Answer too long.", { body: "Max 1000." }, { body: "abc" })], null);
    const { container } = render(<AnswerForm action={ans.action} questionId="q-1" productSlug="oak-desk" />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // submit through the form even though it is collapsed (as a no-JS replay would land here)
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });
    await waitFor(() => expect(details.open).toBe(true));
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Answer too long.");
  });

  test("success messages land in a polite live region", async () => {
    const ask = scripted<QaActionState>([{ ok: true, kind: "asked", id: "q-9", message: "ok" }], null);
    render(<QuestionForm action={ask.action} productId="p-1" productSlug="oak-desk" />);
    fireEvent.submit(screen.getByRole("form", { name: "Ask a question" }));
    const msg = await screen.findByText("Your question was posted.");
    expect(msg.closest("[aria-live='polite']")).not.toBeNull();
  });

  test("forms post only the contract fields (no helpfulCount, isStore, sessionId)", async () => {
    const ask = scripted<QaActionState>([null], null);
    render(<QuestionForm action={ask.action} productId="p-1" productSlug="oak-desk" />);
    fireEvent.change(screen.getByRole("textbox", { name: /Your question/ }), { target: { value: "Is it solid oak?" } });
    fireEvent.submit(screen.getByRole("form", { name: "Ask a question" }));
    await waitFor(() => expect(ask.calls).toHaveLength(1));
    expect(Object.keys(ask.calls[0] ?? {}).filter((k) => !k.startsWith("$ACTION")).sort()).toEqual(
      ["body", "displayName", "productId", "productSlug"].sort(),
    );
    expect(ask.calls[0]?.productId).toBe("p-1");
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: votes
// ---------------------------------------------------------------------------
describe("T59 criterion 3: votes, counts, pending, own content", () => {
  test("vote buttons show counts and post only the target id + slug", async () => {
    const qv = scripted<QaVoteActionState>([{ ok: true, helpfulCount: 5, message: "Thanks for your feedback." }], null);
    const av = scripted<QaVoteActionState>([null], null);
    render(card(question({ helpfulCount: 4, answers: [answer("a1", { helpfulCount: 2 })] }), { voteQuestion: qv.action, voteAnswer: av.action }));
    fireEvent.click(screen.getByRole("button", { name: "Helpful (4)" }));
    await waitFor(() => expect(qv.calls).toHaveLength(1));
    expect(qv.calls[0]).toEqual(expect.objectContaining({ questionId: "q-1", productSlug: "oak-desk" }));
    expect(Object.keys(qv.calls[0] ?? {})).not.toContain("helpfulCount");
    expect(await screen.findByText("You found this helpful")).toBeInTheDocument();
    expect(screen.getByText("5 people found this helpful")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Helpful (2)" }));
    await waitFor(() => expect(av.calls).toHaveLength(1));
    expect(av.calls[0]).toEqual(expect.objectContaining({ answerId: "a1", productSlug: "oak-desk" }));
  });

  test("pending state is per form: question vote pending does not busy the answer vote or the answer form", async () => {
    const qv = gated<QaVoteActionState>();
    render(card(question({ answers: [answer("a1", { helpfulCount: 1 })] }), { voteQuestion: qv.action }));
    fireEvent.click(screen.getByRole("button", { name: "Helpful (4)" }));
    await waitFor(() => expect(qv.calls).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Helpful \(4\)/ })).toHaveAttribute("aria-busy", "true"),
    );
    const answerBtn = screen.getByRole("button", { name: "Helpful (1)" });
    expect(answerBtn).not.toHaveAttribute("aria-busy", "true");
    expect(answerBtn).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Post answer", hidden: true })).not.toHaveAttribute("aria-busy", "true");
    await qv.release(null);
  });

  test("own question / own answer: no vote button, count still shown when > 0", () => {
    render(card(question({ isOwn: true, helpfulCount: 3, answers: [answer("a1", { isOwn: true, helpfulCount: 0 })] })));
    expect(screen.queryByRole("button", { name: /Helpful/ })).toBeNull();
    expect(screen.getByText("3 people found this helpful")).toBeInTheDocument();
  });

  test("DUPLICATE and ALREADY_VOTED both read 'You found this helpful' (no error)", async () => {
    for (const code of ["DUPLICATE", "ALREADY_VOTED"] as const) {
      const v = scripted<QaVoteActionState>([voteFail(code, "Already voted.")], null);
      const { unmount } = render(
        <HelpfulVote action={v.action} target="question" targetId="q-1" productSlug="oak-desk" helpfulCount={2} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Helpful (2)" }));
      expect(await screen.findByText("You found this helpful")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: /Helpful/ })).toBeNull();
      unmount();
    }
  });

  test("FORBIDDEN / RATE_LIMITED vote failures are announced; button stays available", async () => {
    const v = scripted<QaVoteActionState>([voteFail("RATE_LIMITED", "Slow down.", 30)], null);
    render(<HelpfulVote action={v.action} target="answer" targetId="a-1" productSlug="oak-desk" helpfulCount={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Helpful (0)" }));
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Slow down. Try again in less than a minute.");
    expect(screen.getByRole("button", { name: "Helpful (0)" })).toBeInTheDocument();
  });

  test("votedByViewer renders the voted state server-side; corrupt counts render as 0", () => {
    render(
      <>
        <HelpfulVote action={nullVote} target="question" targetId="q-1" productSlug="s" helpfulCount={7} votedByViewer />
        <HelpfulVote action={nullVote} target="question" targetId="q-2" productSlug="s" helpfulCount={Number.NaN} />
        <HelpfulVote action={nullVote} target="question" targetId="q-3" productSlug="s" helpfulCount={-4} />
      </>,
    );
    expect(screen.getByText("7 people found this helpful")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Helpful (0)" })).toHaveLength(2);
  });

  test("singular count text: '1 person found this helpful'", () => {
    render(card(question({ isOwn: true, helpfulCount: 1 })));
    expect(screen.getByText("1 person found this helpful")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: no-JS + keyboard
// ---------------------------------------------------------------------------
const FOCUSABLE = "a[href], button, input:not([type='hidden']), select, textarea, summary";
function keyboardReachable(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.hasAttribute("disabled") || el.getAttribute("tabindex") === "-1") return false;
    let node: Element | null = el;
    while (node) {
      const details: HTMLDetailsElement | null = node.parentElement?.closest("details") ?? null;
      if (!details) return true;
      const ownSummary = node.tagName === "SUMMARY" && node.parentElement === details;
      if (!details.open && !ownSummary) return false;
      node = details;
    }
    return true;
  });
}

describe("T59 criterion 4: no-JS markup and keyboard", () => {
  test("static markup: <details> without open, POST multipart forms with hidden ids and no client-only state", () => {
    const q = question({ answers: [answer("a1"), answer("a2"), answer("a3"), answer("a4")] });
    const html = renderToStaticMarkup(
      <QuestionCard
        question={q}
        voteQuestion={serverRef<QaVoteActionFn>(async () => null)}
        voteAnswer={serverRef<QaVoteActionFn>(async () => null)}
        answerAction={serverRef<QaActionFn>(async () => null)}
        productSlug="oak-desk"
      />,
    );
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const details = [...doc.querySelectorAll("details")];
    expect(details.length).toBe(2); // "See all 4 answers" + "Answer this question"
    for (const d of details) expect(d.hasAttribute("open")).toBe(false);
    expect(details.map((d) => d.querySelector("summary")?.textContent?.trim())).toEqual([
      "See all 4 answers",
      "Answer this question",
    ]);
    const forms = [...doc.querySelectorAll("form")];
    // 1 question vote + 4 answer votes + 1 answer form
    expect(forms.length).toBe(6);
    for (const f of forms) {
      expect(f.getAttribute("method")?.toUpperCase()).toBe("POST");
      expect(f.getAttribute("action") ?? "").not.toContain("javascript");
    }
    expect(doc.querySelector("input[type=hidden][name=questionId][value='q-1']")).not.toBeNull();
    expect(doc.querySelector("input[type=hidden][name=answerId][value='a4']")).not.toBeNull();
    expect(doc.querySelectorAll("input[type=hidden][name=productSlug][value='oak-desk']").length).toBe(6);
    expect(html).not.toContain("javascript:");
  });

  test("QuestionForm static markup posts without JS (POST + hidden productId)", () => {
    const html = renderToStaticMarkup(
      <QuestionForm action={serverRef<QaActionFn>(async () => null)} productId="p-1" productSlug="oak-desk" />,
    );
    expect(html).toMatch(/<form[^>]*method="POST"/i);
    expect(html).toContain('name="productId" value="p-1"');
    expect(html).not.toContain("javascript:");
  });

  test("'See all N answers': first 2 visible, rest inside a closed <details>", () => {
    const answers = [answer("a1"), answer("a2"), answer("a3"), answer("a4"), answer("a5")];
    const { container } = render(card(question({ answers })));
    const details = [...container.querySelectorAll("details")];
    const seeAll = details.find((d) => d.querySelector("summary")?.textContent?.includes("See all 5 answers"));
    expect(seeAll).toBeDefined();
    expect(seeAll?.open).toBe(false);
    expect(within(seeAll as HTMLElement).getByText("Answer body a3")).toBeInTheDocument();
    expect(within(seeAll as HTMLElement).queryByText("Answer body a1")).toBeNull();
    // with <= maxVisible answers, no "See all" disclosure
    const { container: c2 } = render(card(question({ id: "q-2", answers: [answer("a1"), answer("a2")] })));
    expect(c2.textContent).not.toContain("See all");
  });

  test("maxVisibleAnswers invalid values fall back to 2", () => {
    const answers = [answer("a1"), answer("a2"), answer("a3")];
    const { container } = render(card(question({ answers }), { maxVisibleAnswers: -1 }));
    expect(container.textContent).toContain("See all 3 answers");
  });

  test("AnswerForm fields are unreachable while closed and reachable by Tab once the summary opens it", () => {
    const { container } = render(card(question()));
    const details = [...container.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")?.textContent?.includes("Answer this question"),
    ) as HTMLDetailsElement;
    const summary = details.querySelector("summary") as HTMLElement;
    const textarea = within(details).getByRole("textbox", { name: /Your answer/, hidden: true });
    expect(keyboardReachable()).not.toContain(textarea);
    expect(keyboardReachable()).toContain(summary);
    summary.focus();
    expectFocused(summary);
    // Enter/Space on a summary toggles natively; emulate the browser's toggle.
    act(() => {
      details.open = true;
    });
    const order = keyboardReachable();
    const idx = order.indexOf(summary);
    expect(order[idx + 1]).toBe(textarea);
    const name = within(details).getByRole("textbox", { name: /Display name/ });
    const submit = within(details).getByRole("button", { name: "Post answer" });
    expect(order.slice(idx + 1, idx + 4)).toEqual([textarea, name, submit]);
  });

  test("answer form posts questionId + productSlug + body", async () => {
    const a = scripted<QaActionState>([null], null);
    render(<AnswerForm action={a.action} questionId="q-7" productSlug="oak-desk" defaultOpen />);
    fireEvent.change(screen.getByRole("textbox", { name: /Your answer/ }), { target: { value: "Yes it does." } });
    fireEvent.submit(screen.getByRole("form", { name: "Answer this question" }));
    await waitFor(() => expect(a.calls).toHaveLength(1));
    expect(a.calls[0]).toEqual(expect.objectContaining({ questionId: "q-7", productSlug: "oak-desk", body: "Yes it does." }));
  });
});
