import { Button, type ButtonProps, type ButtonVariant } from "../Button";
import { Icon, type IconName, type IconSize } from "../Icon";

export type IconButtonVariant = "ghost" | "outline" | "solid";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps
  extends Omit<
    ButtonProps,
    "children" | "variant" | "size" | "fullWidth" | "aria-label" | "aria-pressed"
  > {
  /** Icon from the Icon set. */
  icon: IconName;
  /** Required accessible name (rendered as `aria-label`). Describe the action: "Add to wishlist". */
  label: string;
  /** Defaults to "ghost". `outline` = Button secondary, `solid` = Button primary. */
  variant?: IconButtonVariant;
  /**
   * Icon size 16 / 20 / 24px. The hit area is 44x44 for sm and md and 48x48
   * for lg. Defaults to "md".
   */
  size?: IconButtonSize;
  /**
   * Toggle state (favourite / heart). When defined, renders `aria-pressed`
   * and a pressed style. Leave undefined for a plain action button. Swap the
   * icon yourself if wanted (e.g. `heart` -> `heart-filled`).
   */
  pressed?: boolean;
}

// Colours come straight from Button's variants (no duplicated tokens).
const buttonVariant: Record<IconButtonVariant, ButtonVariant> = {
  ghost: "ghost",
  outline: "secondary",
  solid: "primary",
};

// Pressed style: variant-prefixed utilities sort after Button's base colours,
// so they win without conflicting. All pairs are verified in globals.css.
const pressedClasses: Record<IconButtonVariant, string> = {
  ghost: "aria-pressed:bg-accent-subtle",
  outline: "aria-pressed:border-accent aria-pressed:bg-accent-subtle aria-pressed:text-accent",
  solid: "aria-pressed:bg-accent-active",
};

// Button size "sm" is used for every size: its px-3 padding fits a 16/20/24px
// icon inside the square box set here, and min-h-touch/min-w-touch stay.
const boxClasses: Record<IconButtonSize, string> = {
  sm: "size-touch",
  md: "size-touch",
  lg: "size-12",
};

/**
 * Icon-only button. Wraps Button (so loading, disabled and click-swallowing
 * behave identically) and forces an accessible name via `label`.
 * `padding="none"` (from ButtonProps) drops the inner px-3/py-1 while the
 * square 44/48px box stays.
 */
export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  pressed,
  loading = false,
  className,
  ...rest
}: IconButtonProps) {
  const classes = ["shrink-0", boxClasses[size], pressedClasses[variant], className]
    .filter(Boolean)
    .join(" ");
  const iconSize: IconSize = size;
  return (
    <Button
      {...rest}
      variant={buttonVariant[variant]}
      size="sm"
      loading={loading}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={classes}
    >
      {loading ? null : <Icon name={icon} size={iconSize} />}
    </Button>
  );
}
