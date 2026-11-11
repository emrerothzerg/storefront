"use client";

import { createContext, useContext, type ChangeEvent } from "react";

export type RadioSize = "sm" | "md" | "lg";

export interface RadioGroupContextValue {
  name: string;
  /** Controlled selected value; undefined when the group is uncontrolled. */
  value: string | undefined;
  defaultValue: string | undefined;
  onChange: ((value: string, event: ChangeEvent<HTMLInputElement>) => void) | undefined;
  required: boolean;
  invalid: boolean;
  size: RadioSize;
}

export const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export function useRadioGroup(): RadioGroupContextValue | null {
  return useContext(RadioGroupContext);
}
