/** Fragment every Q&A URL ends with (the section id). */
export const QA_SECTION_ID = "questions";

/** URL search param for the 1-based Q&A page (D9: list state lives in the URL). */
export const QA_PAGE_PARAM = "qpage";

/** Other search params to carry along (e.g. the reviews section's `sort`/`stars`/`rpage`). */
export type QaExtraParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Current Q&A list state as reflected in the URL. */
export interface QaUrlState {
  /** 1-based page; 1 / invalid is omitted. */
  readonly qpage?: number;
  /** Unrelated params preserved verbatim (in insertion order, before `qpage`). A `qpage` key here is ignored. */
  readonly extra?: QaExtraParams;
}

/** A key that is PRESENT (even as `undefined`) replaces the current value; an absent key keeps it. */
export interface QaHrefPatch {
  readonly qpage?: number | undefined;
}

/**
 * `${basePath}?${extra}&qpage=N#questions`. Page 1 and invalid pages are
 * omitted; any query or fragment already on `basePath` is discarded (pass
 * params to keep in `state.extra`). Pure.
 */
export function buildQaHref(basePath: string, state: QaUrlState = {}, patch: QaHrefPatch = {}): string {
  const qpage = Object.prototype.hasOwnProperty.call(patch, "qpage") ? patch.qpage : state.qpage;

  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(state.extra ?? {})) {
    if (name === "" || name === QA_PAGE_PARAM || value === undefined) continue;
    if (typeof value === "string") {
      params.append(name, value);
    } else {
      for (const v of value) if (typeof v === "string") params.append(name, v);
    }
  }
  if (typeof qpage === "number" && Number.isSafeInteger(qpage) && qpage > 1) {
    params.set(QA_PAGE_PARAM, String(qpage));
  }

  const path = basePath.split(/[?#]/, 1)[0] ?? "";
  const search = params.toString();
  return `${path}${search ? `?${search}` : ""}#${QA_SECTION_ID}`;
}
