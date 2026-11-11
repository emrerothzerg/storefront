"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Ref } from "react";
import { Button } from "@/components/atoms/Button";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Icon } from "@/components/atoms/Icon";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { buildMailtoHref, resolveShareUrl } from "./share-utils";

export type ShareLinkSize = "sm" | "md";

export interface ShareLinkProps {
  /** Absolute URL or site path (made absolute with `absoluteUrl`). */
  url: string;
  /** Product name; used in the email subject and the native share sheet. */
  title: string;
  /** Optional message; defaults to `title` in the email body. */
  text?: string;
  /** Defaults to "md". */
  size?: ShareLinkSize;
  className?: string;
}

const COPIED_MESSAGE = "Link copied";
const COPY_HINT = "Press Ctrl/Cmd+C to copy";

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

const noopSubscribe = () => () => {};

function hasWebShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

interface ManualCopyFieldProps {
  id: string;
  url: string;
  inputRef?: Ref<HTMLInputElement>;
}

/** Readonly field with the URL: the no-JS and clipboard-failure path. */
function ManualCopyField({ id, url, inputRef }: ManualCopyFieldProps) {
  const hintId = `${id}-hint`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-small font-semibold text-text-primary">
        Link to share
      </label>
      <Input
        id={id}
        ref={inputRef}
        readOnly
        value={url}
        aria-describedby={hintId}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 font-mono text-small"
      />
      <p id={hintId} className="text-small text-text-secondary">
        {COPY_HINT}
      </p>
    </div>
  );
}

/**
 * Share menu on a native `<details>` (works without JS); every action is a
 * neutral secondary pill (Phase 3 look): Copy link (clipboard
 * with a readonly-field fallback), native Share (only when `navigator.share`
 * exists, detected after mount), and an "Email a friend" `mailto:` link.
 * No third-party scripts or widgets.
 */
export function ShareLink({ url, title, text, size = "md", className }: ShareLinkProps) {
  const shareUrl = resolveShareUrl(url);
  const mailto = buildMailtoHref(title, shareUrl, text);
  const baseId = useId();
  const fieldId = `share-url-${baseId}`;

  // Server and hydration render: false (static markup never has Share…).
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const canShare = useSyncExternalStore(noopSubscribe, hasWebShare, () => false);
  const [showField, setShowField] = useState(false);
  const [status, setStatus] = useState("");
  // Bumped on every successful copy; its parity toggles a hidden suffix so a
  // repeat copy still mutates the live region (identical text is not re-announced).
  const [copyCount, setCopyCount] = useState(0);
  const fieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!showField) return;
    const node = fieldRef.current;
    if (!node) return;
    node.focus();
    node.select();
  }, [showField]);

  const fallBackToField = () => {
    setStatus("");
    setShowField(true);
    // Already visible: re-select so Ctrl/Cmd+C copies straight away.
    fieldRef.current?.focus();
    fieldRef.current?.select();
  };

  const handleCopy = async () => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      fallBackToField();
      return;
    }
    try {
      await clipboard.writeText(shareUrl);
      setShowField(false);
      setStatus(COPIED_MESSAGE);
      setCopyCount((count) => count + 1);
    } catch {
      fallBackToField();
    }
  };

  const handleShare = async () => {
    try {
      await navigator.share({ title, text, url: shareUrl });
    } catch (error) {
      if (isAbortError(error)) return;
      fallBackToField();
    }
  };

  const textSize = size === "sm" ? "text-small" : "text-body";
  const buttonSize = size === "sm" ? "sm" : "md";

  return (
    <Disclosure
      summary={
        <span className={`inline-flex items-center gap-2 ${textSize}`}>
          <Icon name="share" size={size === "sm" ? "sm" : "md"} />
          Share
        </span>
      }
      className={["min-w-0 max-w-full", className].filter(Boolean).join(" ")}
    >
      <ul className="flex min-w-0 flex-col gap-2" aria-label={`Share ${title}`}>
        <li className="flex min-w-0 flex-col gap-2">
          <Button
            variant="secondary"
            size={buttonSize}
            onClick={handleCopy}
            disabled={!mounted}
            className="self-start"
          >
            <Icon name="copy" size="sm" />
            Copy link
          </Button>
          {mounted ? (
            showField ? (
              <ManualCopyField id={fieldId} url={shareUrl} inputRef={fieldRef} />
            ) : null
          ) : (
            <noscript>
              <ManualCopyField id={`${fieldId}-noscript`} url={shareUrl} />
            </noscript>
          )}
          <p role="status" aria-live="polite" aria-atomic="true" className="text-small text-text-secondary">
            {status}
            {status === COPIED_MESSAGE && copyCount % 2 === 0 ? <VisuallyHidden>.</VisuallyHidden> : null}
          </p>
        </li>
        {canShare ? (
          <li>
            <Button variant="secondary" size={buttonSize} onClick={handleShare}>
              <Icon name="share" size="sm" />
              Share…
            </Button>
          </li>
        ) : null}
        <li>
          <Link
            href={mailto}
            variant="button"
            buttonVariant="secondary"
            buttonSize={buttonSize}
          >
            <Icon name="mail" size="sm" />
            Email a friend
          </Link>
        </li>
      </ul>
    </Disclosure>
  );
}
