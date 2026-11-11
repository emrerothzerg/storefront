"use client";

import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonVariant } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Dialog } from "@/components/atoms/Dialog";
import { Icon } from "@/components/atoms/Icon";
import { Input } from "@/components/atoms/Input";
import { Heading, type HeadingLevel } from "@/components/atoms/Typography";
import { getSiteUrl } from "@/lib/seo/site";
import {
  LIST_FIELD,
  initialListActionState,
  sharedListPath,
  type ListActionFn,
  type ListActionState,
  type ListSharingMode,
} from "../_contracts/list-actions";
import { isListFailure, listErrorMessage } from "../WishlistButton/list-error-message";

export type ShareListKind = "wishlist" | "save_for_later";

export interface ShareListPanelProps {
  listId: string;
  /** Rendered as text only. */
  listName: string;
  kind: ShareListKind;
  isPublic: boolean;
  /** Ignored unless `isPublic`; the link is never rendered for a private list. */
  shareToken: string | null;
  /** `setListSharing` server action. */
  action: ListActionFn;
  /**
   * Origin (+ base path) for the absolute link. Must be an absolute http(s) URL
   * without credentials; anything else (or omitted) falls back to `getSiteUrl()`
   * (NEXT_PUBLIC_SITE_URL).
   */
  siteUrl?: string;
  /** Defaults to 2. */
  headingLevel?: Exclude<HeadingLevel, 1>;
  className?: string;
}

export const SAVE_FOR_LATER_SHARE_TEXT = "Saved items cannot be shared";
export const STOP_SHARING_CONFIRM_LABEL = "I understand the old link will stop working";
export const LINK_COPIED_MESSAGE = "Link copied";
export const COPY_FALLBACK_MESSAGE = "Copy the link from the field: press Ctrl/Cmd+C.";

interface FocusRequest {
  readonly target: "link" | "enable";
  readonly n: number;
}

const noopSubscribe = () => () => {};

/** Share path from a settled `setListSharing` result; `undefined` = no sharing result. */
function sharePathFromState(state: ListActionState): string | null | undefined {
  if (state === null || state.ok !== true || state.kind !== "sharing") return undefined;
  return typeof state.sharePath === "string" && state.sharePath !== "" ? state.sharePath : null;
}

function initialPath(isPublic: boolean, shareToken: string | null): string | null {
  return isPublic && typeof shareToken === "string" && shareToken !== "" ? sharedListPath(shareToken) : null;
}

/**
 * `siteUrl` as a safe base: an absolute http(s) URL without credentials
 * (the same rule `getSiteUrl()` applies to NEXT_PUBLIC_SITE_URL), normalised
 * to origin + path without trailing slashes. Anything else (`javascript:`,
 * `data:`, protocol-relative `//host`, relative paths, credentials) yields
 * `null` so the caller falls back to `getSiteUrl()`.
 */
export function safeSiteBase(siteUrl: string | undefined): string | null {
  if (typeof siteUrl !== "string") return null;
  const raw = siteUrl.trim();
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function shareUrlFor(siteUrl: string, path: string): string {
  return `${siteUrl.trim().replace(/\/+$/, "")}${path}`;
}

function PendingSubmit({ variant, children }: { variant: ButtonVariant; children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" loading={pending}>
      {children}
    </Button>
  );
}

function HiddenFields({ listId, mode }: { listId: string; mode: ListSharingMode }) {
  return (
    <>
      <input type="hidden" name={LIST_FIELD.listId} value={listId} />
      <input type="hidden" name={LIST_FIELD.mode} value={mode} />
    </>
  );
}

/**
 * Owner-only sharing controls for one wish list. Private: "Share this list"
 * (mode enable). Public: the link in a readonly field + "Copy link"
 * (clipboard, falling back to selecting the field), "Get a new link" (mode
 * rotate) and "Stop sharing" (mode disable): a confirm Dialog with JS, a
 * required "I understand..." checkbox without JS. Save-for-later lists render
 * a disabled state. The link is never rendered for a private list.
 */
export function ShareListPanel({
  listId,
  listName,
  kind,
  isPublic,
  shareToken,
  action,
  siteUrl,
  headingLevel = 2,
  className,
}: ShareListPanelProps) {
  const uid = useId();
  const headingId = `share-list-heading-${uid}`;
  const linkId = `share-list-link-${uid}`;
  const confirmId = `share-list-confirm-${uid}`;
  const [state, formAction] = useActionState(action, initialListActionState);

  const [sharePath, setSharePath] = useState<string | null>(() => {
    const fromState = sharePathFromState(state);
    return fromState !== undefined ? fromState : initialPath(isPublic, shareToken);
  });
  const propKey = `${isPublic ? "1" : "0"}|${shareToken ?? ""}`;
  const [syncedKey, setSyncedKey] = useState(propKey);
  if (syncedKey !== propKey) {
    setSyncedKey(propKey);
    setSharePath(initialPath(isPublic, shareToken));
  }

  // false in server markup and during hydration, true afterwards (JS-only controls).
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [seenState, setSeenState] = useState(state);
  if (seenState !== state) {
    setSeenState(state);
    setCopyStatus("");
    const fromState = sharePathFromState(state);
    if (fromState !== undefined) {
      setSharePath(fromState);
      setConfirmOpen(false);
      const target = fromState === null ? "enable" : "link";
      setFocusRequest((prev) => ({ target, n: (prev?.n ?? 0) + 1 }));
    }
  }

  const linkRef = useRef<HTMLInputElement>(null);
  const enableRef = useRef<HTMLDivElement>(null);
  // After a sharing change the control the user acted on is gone; move focus to its successor.
  useEffect(() => {
    if (focusRequest?.target === "link") linkRef.current?.focus();
    if (focusRequest?.target === "enable") enableRef.current?.querySelector("button")?.focus();
  }, [focusRequest]);

  const base = safeSiteBase(siteUrl) ?? getSiteUrl();
  const url = sharePath !== null ? shareUrlFor(base, sharePath) : null;
  const error = isListFailure(state) ? listErrorMessage(state) : null;
  const success = state !== null && state.ok === true ? state.message : "";

  const fallBackToField = () => {
    setCopyStatus(COPY_FALLBACK_MESSAGE);
    linkRef.current?.focus();
    linkRef.current?.select();
  };

  const handleCopy = async () => {
    if (url === null) return;
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      fallBackToField();
      return;
    }
    try {
      await clipboard.writeText(url);
      setCopyStatus(LINK_COPIED_MESSAGE);
    } catch {
      fallBackToField();
    }
  };

  const wrapper = ["flex flex-col gap-3", className].filter(Boolean).join(" ");

  let body: ReactNode;
  if (kind === "save_for_later") {
    body = (
      <>
        <p className="text-small text-text-secondary">{SAVE_FOR_LATER_SHARE_TEXT}</p>
        <div>
          <Button type="button" variant="secondary" size="sm" disabled>
            <Icon name="share" size="sm" />
            Share this list
          </Button>
        </div>
      </>
    );
  } else if (url === null) {
    body = (
      <>
        <p className="text-small text-text-secondary">Only you can see this list.</p>
        <form action={formAction}>
          <HiddenFields listId={listId} mode="enable" />
          <div ref={enableRef}>
            <PendingSubmit variant="primary">
              <Icon name="share" size="sm" />
              Share this list
            </PendingSubmit>
          </div>
        </form>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-small text-text-secondary">
          Anyone with this link can view the list. They cannot change it.
        </p>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={linkId} className="text-small font-semibold text-text-primary">
            Link to this list
          </label>
          <div className="flex min-w-0 flex-col gap-2 xs:flex-row">
            <Input
              id={linkId}
              ref={linkRef}
              readOnly
              value={url}
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 font-mono text-small"
            />
            {mounted ? (
              <Button type="button" variant="secondary" size="sm" onClick={handleCopy}>
                <Icon name="copy" size="sm" />
                Copy link
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <form action={formAction}>
            <HiddenFields listId={listId} mode="rotate" />
            <PendingSubmit variant="secondary">Get a new link</PendingSubmit>
          </form>
          {mounted ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
              Stop sharing
            </Button>
          ) : (
            <form action={formAction} className="flex min-w-0 flex-col gap-1">
              <HiddenFields listId={listId} mode="disable" />
              <Checkbox
                id={confirmId}
                name={LIST_FIELD.confirm}
                value="yes"
                required
                label={STOP_SHARING_CONFIRM_LABEL}
              />
              <div>
                <PendingSubmit variant="danger">Stop sharing</PendingSubmit>
              </div>
            </form>
          )}
        </div>
      </>
    );
  }

  return (
    <Card as="section" aria-labelledby={headingId} className={wrapper}>
      <Heading level={headingLevel} size="h4" id={headingId} className="break-words">
        Share {listName}
      </Heading>
      {body}
      {/* Kept mounted while public/private flips so it closes (and releases focus) before unmounting. */}
      {mounted && kind !== "save_for_later" ? (
        <Dialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Stop sharing this list?"
          description="The current link will stop working for everyone who has it. You can share again later with a new link."
          alert
          size="sm"
        >
          <form action={formAction} className="flex flex-wrap justify-end gap-2">
            <HiddenFields listId={listId} mode="disable" />
            <input type="hidden" name={LIST_FIELD.confirm} value="yes" />
            <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <PendingSubmit variant="danger">Stop sharing</PendingSubmit>
          </form>
        </Dialog>
      ) : null}
      <p aria-live="polite" aria-atomic="true" className="text-small text-text-primary" data-testid="share-status">
        {copyStatus !== "" ? copyStatus : success}
      </p>
      {error ? (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
