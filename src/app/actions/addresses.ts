"use server";

import { revalidatePath } from "next/cache";
import type { AddressActionState } from "@/components/molecules/_contracts/address-actions";
import { getAddressService } from "@/server/addresses/address-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { getOrCreateSessionId, readSessionId } from "@/server/session/session";
import {
  ADDRESS_ACTION_FAILED,
  createAddressActions,
  echoValues,
  parseAddressForm,
  unexpectedErrorState,
  type AddressActions,
} from "./addresses-core";

/**
 * Address Server Actions (T49). This file may only export async functions
 * (Next 16 `'use server'` rule). Each wrapper builds the actions with real
 * deps at call time (never at import time, so importing this module opens no
 * DB) and delegates to `addresses-core.ts`. Signature `(prev, formData)` is
 * what `useActionState` binds, so the forms also work without JavaScript.
 */

type Name = keyof AddressActions;

async function run(name: Name, prev: AddressActionState, formData: FormData): Promise<AddressActionState> {
  let built: AddressActions;
  try {
    built = createAddressActions({
      service: getAddressService(),
      limiter: getRateLimiter(),
      getOrCreateSessionId,
      readSessionId,
      revalidatePath,
    });
  } catch {
    // Opening the DB failed; still settle. Error code only.
    console.error(`[addresses] ${ADDRESS_ACTION_FAILED} action=init`);
    if (name !== "saveAddress") return unexpectedErrorState();
    try {
      return unexpectedErrorState(echoValues(parseAddressForm(formData)));
    } catch {
      return unexpectedErrorState();
    }
  }
  return built[name](prev, formData);
}

export async function saveAddress(prev: AddressActionState, formData: FormData): Promise<AddressActionState> {
  return run("saveAddress", prev, formData);
}

export async function deleteAddress(prev: AddressActionState, formData: FormData): Promise<AddressActionState> {
  return run("deleteAddress", prev, formData);
}

export async function setDefaultAddress(prev: AddressActionState, formData: FormData): Promise<AddressActionState> {
  return run("setDefaultAddress", prev, formData);
}
