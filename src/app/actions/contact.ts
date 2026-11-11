"use server";

import { revalidatePath } from "next/cache";
import type { ContactActionState } from "@/components/molecules/_contracts/contact-actions";
import { getContactService } from "@/server/contact/contact-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { getOrCreateSessionId } from "@/server/session/session";
import { CONTACT_ACTION_FAILED, createContactActions, unexpectedErrorState, type ContactActions } from "./contact-core";

/**
 * Contact Server Action (T51). This file may only export async functions
 * (Next 16 `'use server'` rule). The wrapper builds the action with real deps
 * at call time (never at import time, so importing this module opens no DB)
 * and delegates to `contact-core.ts`. Signature `(prevState, formData)` is what
 * `useActionState` binds, so the form also works without JavaScript.
 */

export async function sendContactMessage(prevState: ContactActionState, formData: FormData): Promise<ContactActionState> {
  let built: ContactActions;
  try {
    built = createContactActions({
      service: getContactService(),
      limiter: getRateLimiter(),
      getOrCreateSessionId,
      revalidatePath,
    });
  } catch {
    // Opening the DB failed; still settle. Error code only.
    console.error(`[contact] ${CONTACT_ACTION_FAILED} action=init`);
    return unexpectedErrorState();
  }
  return built.sendContactMessage(prevState, formData);
}
