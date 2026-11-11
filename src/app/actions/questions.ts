"use server";

import { revalidatePath } from "next/cache";
import type { QaActionState, QaVoteActionState } from "@/components/molecules/_contracts/qa-actions";
import { getQaService } from "@/server/qa/qa-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { readCurrentUser } from "@/server/session/current-user";
import { getOrCreateSessionId, readAuthToken } from "@/server/session/session";
import {
  QA_ACTION_FAILED,
  createQaActions,
  echoQaValues,
  unexpectedQaState,
  unexpectedVoteState,
  type QaActions,
  type QaPostTarget,
} from "./questions-core";

/**
 * Q&A Server Actions (T47). This file may only export async functions
 * (Next 16 `'use server'` rule). Each wrapper builds the actions with real
 * deps at call time (never at import time, so importing this module opens no
 * DB) and delegates to `questions-core.ts`. Signature `(prevState, formData)`
 * is what `useActionState` binds, so the forms also work without JavaScript.
 */

/** Null when the DB cannot be opened; the caller settles with a generic state. */
function build(name: string): QaActions | null {
  try {
    return createQaActions({
      service: getQaService(),
      limiter: getRateLimiter(),
      getOrCreateSessionId,
      readCurrentUser,
      revalidatePath,
    });
  } catch {
    // Error code only.
    console.error(`[qa] ${QA_ACTION_FAILED} action=${name} stage=init`);
    return null;
  }
}

/**
 * Generic "unavailable" state that still echoes the contract fields (body,
 * and displayName for guests only; never ids). With the DB down the account
 * cannot be resolved, so any `sf_auth` cookie (or an unreadable cookie store)
 * counts as signed in and the posted displayName is omitted.
 */
async function unavailable(formData: FormData, target: QaPostTarget): Promise<QaActionState> {
  try {
    let signedIn = true;
    try {
      signedIn = (await readAuthToken()) !== null;
    } catch {
      // Cookie store unavailable: keep the conservative default.
    }
    return unexpectedQaState(echoQaValues(formData, target, signedIn));
  } catch {
    return unexpectedQaState();
  }
}

export async function askQuestion(prevState: QaActionState, formData: FormData): Promise<QaActionState> {
  const actions = build("ask");
  return actions === null ? unavailable(formData, "question") : actions.askQuestion(prevState, formData);
}

export async function answerQuestion(prevState: QaActionState, formData: FormData): Promise<QaActionState> {
  const actions = build("answer");
  return actions === null ? unavailable(formData, "answer") : actions.answerQuestion(prevState, formData);
}

export async function voteQuestion(prevState: QaVoteActionState, formData: FormData): Promise<QaVoteActionState> {
  const actions = build("voteQuestion");
  return actions === null ? unexpectedVoteState() : actions.voteQuestion(prevState, formData);
}

export async function voteAnswer(prevState: QaVoteActionState, formData: FormData): Promise<QaVoteActionState> {
  const actions = build("voteAnswer");
  return actions === null ? unexpectedVoteState() : actions.voteAnswer(prevState, formData);
}
