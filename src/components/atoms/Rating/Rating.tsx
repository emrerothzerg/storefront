"use client";

import { useId } from "react";
import type { ChangeEvent, FieldsetHTMLAttributes, HTMLAttributes, Ref } from "react";
import { Icon, type IconName, type IconSize } from "../Icon";

export type RatingSize = "sm" | "md" | "lg";
/**
 * Display layouts. `full`: five stars + "(count)" (default). `compact`: one
 * filled star + the numeric value + "(count)" for dense product grids.
 */
export type RatingVariant = "full" | "compact";

export const RATING_MAX = 5;

export interface RatingDisplayProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  mode?: "display";
  /** 0-5. Clamped; non-finite values count as 0. Stars round to the nearest half. */
  value: number;
  /** Number of ratings. Renders "(1,234)" next to the stars. */
  count?: number;
  /** Defaults to "md". */
  size?: RatingSize;
  /** Defaults to "full". */
  variant?: RatingVariant;
  /**
   * `full` only: show the numeric value ("4.6") before the stars. `compact`
   * always shows it. Visual only; the announced text is unchanged.
   */
  showValue?: boolean;
  ref?: Ref<HTMLSpanElement>;
}

export interface RatingInputProps
  extends Omit<
    FieldsetHTMLAttributes<HTMLFieldSetElement>,
    "children" | "onChange" | "defaultValue" | "role"
  > {
  mode: "input";
  /** Group label (rendered as `<legend>`), e.g. "Overall rating". */
  label: string;
  /** Keep the legend for assistive tech only. */
  hideLabel?: boolean;
  /** Form field name; the selected star count (1-5) posts as its value. */
  name: string;
  /** Controlled value (1-5), or `null` for no selection. */
  value?: number | null;
  /** Uncontrolled initial value (1-5). */
  defaultValue?: number;
  /** Called with the newly selected star count. */
  onChange?: (value: number, event: ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  /**
   * Show a visible "(required)" marker after the legend text (aria-hidden,
   * like FormField: `aria-required` already announces it). Defaults to
   * `required`. Pass the plain label ("Overall rating"), not
   * "Overall rating (required)". Not rendered when `hideLabel` is set.
   */
  requiredMarker?: boolean;
  /** Sets `aria-invalid` on the radiogroup and a danger outline. */
  invalid?: boolean;
  /** Id(s) of extra hint text describing the group. */
  describedBy?: string;
  /**
   * Error message rendered under the stars with `role="alert"`, linked to the
   * group with `aria-describedby` and implying `invalid` (same as RadioGroup).
   */
  errorText?: string;
  disabled?: boolean;
  size?: RatingSize;
  ref?: Ref<HTMLFieldSetElement>;
}

export type RatingProps = RatingDisplayProps | RatingInputProps;

const iconSize: Record<RatingSize, IconSize> = { sm: "sm", md: "md", lg: "lg" };
const textSize: Record<RatingSize, string> = {
  sm: "text-caption",
  md: "text-small",
  lg: "text-body",
};

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en-US");

/** Clamp to [0, 5]; NaN/Infinity -> 0. */
export function clampRating(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(RATING_MAX, Math.max(0, value));
}

/** Star icons for a value, rounded to the nearest half star. */
export function starIcons(value: number): IconName[] {
  const rounded = Math.round(clampRating(value) * 2) / 2;
  return Array.from({ length: RATING_MAX }, (_, i) => {
    const star = i + 1;
    if (rounded >= star) return "star-filled";
    if (rounded >= star - 0.5) return "star-half";
    return "star";
  });
}

function join(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function RatingDisplay({
  value,
  count,
  size = "md",
  variant = "full",
  showValue = false,
  className,
  ref,
  mode: _mode,
  ...rest
}: RatingDisplayProps) {
  void _mode;
  const clamped = clampRating(value);
  const showCount = count !== undefined && Number.isFinite(count) && count >= 0;
  const countText = showCount ? integer.format(Math.trunc(count)) : "";
  const compact = variant === "compact";
  // One decimal always ("4.0"), so values line up in a grid.
  const valueText = clamped.toFixed(1);
  return (
    <span
      {...rest}
      ref={ref}
      className={join("inline-flex items-center gap-1", textSize[size], className)}
    >
      <span className="sr-only">{`${decimal.format(clamped)} out of ${RATING_MAX} stars`}</span>
      {!compact && showValue ? (
        <span aria-hidden="true" className="font-semibold text-text-primary" data-testid="rating-value">
          {valueText}
        </span>
      ) : null}
      <span aria-hidden="true" className="inline-flex text-rating" data-testid="rating-stars">
        {compact ? (
          <Icon name="star-filled" size={iconSize[size]} />
        ) : (
          starIcons(clamped).map((name, i) => <Icon key={i} name={name} size={iconSize[size]} />)
        )}
      </span>
      {compact ? (
        <span aria-hidden="true" className="font-semibold text-text-primary" data-testid="rating-value">
          {valueText}
        </span>
      ) : null}
      {showCount ? (
        <>
          <span aria-hidden="true" className="text-text-secondary">{`(${countText})`}</span>
          <span className="sr-only">{`, ${countText} ${Math.trunc(count) === 1 ? "rating" : "ratings"}`}</span>
        </>
      ) : null}
    </span>
  );
}

/*
 * CSS-only fill (no JS state, works before hydration and without JS).
 * DOM order is 1..5 so native arrow keys move the expected way. Each label is
 * a `peer/star`; the star row is `group/rating`. Rules on each label's `fill`
 * (the svg inherits it via `fill-inherit`), resolved by SPECIFICITY rather
 * than Tailwind's variant order:
 *   (0,1,0) fill-none                                   default empty
 *   (0,2,0) group-has-checked -> fill                   something is checked: fill all...
 *   (0,2,0) peer-has-checked  -> none  (sorts later)    ...except labels after the checked one
 *   (0,2,0) group-hover       -> fill                   hovering: fill all...
 *   (0,3,0) group-hover + peer-has-checked -> fill      ...including those after the checked one
 *   (0,2,0) peer-hover        -> none  (sorts later)    ...except labels after the hovered one
 *   (0,4,0) group-hover + peer-hover + peer-has-checked -> none
 * Hover rules sit inside `@media (hover: hover)`, so touch devices skip the preview.
 */
const starLabelFill = [
  "fill-none",
  "group-has-checked/rating:fill-current",
  "peer-has-checked/star:fill-none",
  "group-hover/rating:fill-current",
  "group-hover/rating:peer-has-checked/star:fill-current",
  "peer-hover/star:fill-none",
  "group-hover/rating:peer-hover/star:peer-has-checked/star:fill-none",
].join(" ");

const starLabel = join(
  "peer/star relative inline-flex size-touch cursor-pointer items-center justify-center rounded-md text-rating",
  "has-disabled:cursor-not-allowed",
  starLabelFill,
);

/**
 * The native radio is a transparent, borderless (`appearance-none`) layer over
 * the whole 44px label, so the keyboard focus ring is drawn by the radio itself
 * through the base `:focus-visible` rule. That lets the base
 * `.bg-surface-inverse :focus-visible` rule turn it white on dark bands
 * (D-T131-4); a colour utility on the label would pin it blue.
 */
const starInput =
  "absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-md bg-transparent disabled:cursor-not-allowed";

function RatingInput({
  label,
  hideLabel = false,
  name,
  value,
  defaultValue,
  onChange,
  required = false,
  requiredMarker,
  invalid = false,
  describedBy,
  errorText,
  disabled = false,
  size = "md",
  className,
  ref,
  mode: _mode,
  ...rest
}: RatingInputProps) {
  void _mode;
  const controlled = value !== undefined;
  const autoId = useId();
  const errorId = errorText?.trim() ? `${rest.id ?? `rating-${autoId}`}-error` : undefined;
  const ariaDescribedBy = [describedBy, errorId].filter(Boolean).join(" ") || undefined;
  const isInvalid = invalid || errorId !== undefined;
  const showMarker = !hideLabel && (requiredMarker ?? required);
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(Number(event.target.value), event);
  };

  return (
    <fieldset
      {...rest}
      ref={ref}
      role="radiogroup"
      disabled={disabled}
      aria-invalid={isInvalid ? "true" : undefined}
      aria-required={required ? "true" : undefined}
      aria-describedby={ariaDescribedBy}
      className={join("m-0 min-w-0 border-0 p-0", disabled && "opacity-50", className)}
    >
      <legend className={hideLabel ? "sr-only" : join("mb-1 text-text-primary", textSize[size])}>
        {label}
        {showMarker ? (
          <span className="text-text-secondary" aria-hidden="true">
            {" "}
            (required)
          </span>
        ) : null}
      </legend>
      <div
        className={join(
          "group/rating inline-flex rounded-md",
          isInvalid && "outline-2 outline-offset-2 outline-danger",
        )}
      >
        {Array.from({ length: RATING_MAX }, (_, i) => {
          const star = i + 1;
          const checkedProps = controlled
            ? { checked: value === star, onChange: handleChange }
            : {
                defaultChecked: defaultValue === star,
                ...(onChange ? { onChange: handleChange } : {}),
              };
          return (
            <label key={star} className={starLabel}>
              <input
                type="radio"
                name={name}
                value={String(star)}
                required={required}
                className={starInput}
                {...checkedProps}
              />
              <Icon name="star" size={iconSize[size]} className="fill-inherit" />
              <span className="sr-only">{`${star} out of ${RATING_MAX} stars`}</span>
            </label>
          );
        })}
      </div>
      {errorId ? (
        <p id={errorId} role="alert" className="mt-1 text-small text-danger">
          {errorText}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * Star rating.
 * - Display (default): `<Rating value={4.3} count={1234} />` -> stars
 *   (aria-hidden) + "4.3 out of 5 stars" for assistive tech + "(1,234)".
 * - Input: `<Rating mode="input" name="rating" label="Your rating" required />`
 *   -> legend "Your rating (required)" (marker aria-hidden; opt out with
 *   `requiredMarker={false}`) + a fieldset radiogroup of 5 native radios ("1 out of 5 stars" ... "5 out of 5 stars"). The
 *   value posts with a plain `<form>` without JavaScript.
 */
export function Rating(props: RatingProps) {
  if (props.mode === "input") return <RatingInput {...props} />;
  return <RatingDisplay {...props} />;
}
