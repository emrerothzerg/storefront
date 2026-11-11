/** A plain `<form action>` function (React 19). */
export type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * Binds `prevState = null` on a `(prevState, formData)` Server Action so it
 * can be posted by a plain `<form action>` (works without JavaScript, SR2).
 * Server references support `.bind`; the returned state is ignored because
 * the actions revalidate the page themselves.
 */
export function asFormAction(fn: (prev: null, formData: FormData) => Promise<unknown>): FormAction {
  return fn.bind(null, null) as FormAction;
}
