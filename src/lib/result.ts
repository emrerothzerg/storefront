import { ERROR_CODES, type ErrorCode } from "./types";

/**
 * Application error. Plain data only so it survives JSON serialization
 * (server actions return results to client components).
 */
export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Builds an `AppError`, omitting `details` when not given. */
export function appError(
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Shorthand for `err(appError(...))`. */
export function fail(
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Err<AppError> {
  return err(appError(code, message, details));
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

/** Runtime check for values received over the wire. */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isErrorCode(v.code) || typeof v.message !== "string") return false;
  return (
    v.details === undefined ||
    (typeof v.details === "object" && v.details !== null && !Array.isArray(v.details))
  );
}

export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function andThen<T, U, E, F = E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? fn(result.value) : result;
}
