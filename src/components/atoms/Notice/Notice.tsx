import type { HTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "../Icon";
import { IconButton } from "../IconButton";

export type NoticeTone = "info" | "success" | "warning" | "danger";

export interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "role"> {
  tone: NoticeTone;
  /** Bold first line in the tone colour. */
  title?: ReactNode;
  /** Message body (text-primary on the tint). */
  children?: ReactNode;
  /** Shows a "Dismiss" icon button when given. */
  onDismiss?: () => void;
  /** Accessible name of the dismiss button. Defaults to "Dismiss". */
  dismissLabel?: string;
  ref?: Ref<HTMLDivElement>;
}

// Only verified pairs: tone text / text-primary / accent on the tone tint.
const toneClasses: Record<NoticeTone, { box: string; accent: string; icon: IconName }> = {
  info: { box: "border-info bg-info-subtle", accent: "text-info", icon: "info" },
  success: { box: "border-success bg-success-subtle", accent: "text-success", icon: "check-circle" },
  warning: { box: "border-warning bg-warning-subtle", accent: "text-warning", icon: "warning" },
  danger: { box: "border-danger bg-danger-subtle", accent: "text-danger", icon: "error-circle" },
};

/**
 * Inline status message. info/success -> `role="status"` (polite);
 * warning/danger -> `role="alert"` (assertive). Each tone has its own icon
 * shape, so meaning never relies on colour alone.
 */
export function Notice({
  tone,
  title,
  children,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
  ref,
  ...rest
}: NoticeProps) {
  const t = toneClasses[tone];
  const role = tone === "warning" || tone === "danger" ? "alert" : "status";
  const classes = [
    "flex items-start gap-3 rounded-md border p-4 text-small text-text-primary",
    t.box,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div {...rest} ref={ref} role={role} data-tone={tone} className={classes}>
      <Icon name={t.icon} size="md" className={`mt-0.5 ${t.accent}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title != null ? <p className={`font-semibold ${t.accent}`}>{title}</p> : null}
        {children != null ? <div>{children}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton
          icon="close"
          size="sm"
          label={dismissLabel}
          onClick={onDismiss}
          className="-my-3 -mr-3"
        />
      ) : null}
    </div>
  );
}
