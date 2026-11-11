"use client";

import { useActionState, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Dialog, DialogFooter } from "@/components/atoms/Dialog";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Radio } from "@/components/atoms/Radio";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import type { SavedAddress } from "@/lib/types";
import { DEFAULT_COUNTRIES } from "../AddressFields";
import {
  ADDRESS_DELETE_CONFIRM_VALUE,
  ADDRESS_FIELD,
  initialAddressActionState,
  type AddressActionFn,
  type AddressActionState,
} from "../_contracts/address-actions";

export const DELETE_DIALOG_TITLE = "Delete this address?";
export const DELETE_CONFIRM_LABEL = "Yes, delete this address";
export const DEFAULT_BADGE_TEXT = "Default";

export interface AddressCardActions {
  /** `deleteAddress` server action (posts `addressId` + `confirm=yes`). */
  readonly delete: AddressActionFn;
  /** `setDefaultAddress` server action (posts `addressId`). */
  readonly setDefault: AddressActionFn;
}

export interface AddressCardSelectable {
  /** Radio group name, e.g. "addressId" in the checkout form. */
  readonly name: string;
  readonly value: string;
  /** Initial selection (uncontrolled: `defaultChecked`). */
  readonly checked: boolean;
}

export interface AddressCardProps {
  address: SavedAddress;
  /**
   * Mutation forms (Set as default, Delete). Omit to render a read-only card;
   * they are never rendered in `selectable` mode because the card then sits
   * inside the checkout `<form>` and forms cannot nest.
   */
  actions?: AddressCardActions;
  /** Link to an edit view, e.g. `/account/addresses?edit=<id>` (works without JS). */
  editHref?: string;
  /** Client-side edit toggle; wins over `editHref` when both are given. */
  onEdit?: () => void;
  /** Radio-card mode for checkout: a native radio named by the card heading. */
  selectable?: AddressCardSelectable;
  /** Tighter padding. */
  compact?: boolean;
  /** Heading level of the card title. Defaults to 3. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/** Country name from the AddressFields list, else the stored code. */
export function countryName(code: string): string {
  const upper = code.toUpperCase();
  return DEFAULT_COUNTRIES.find((c) => c.value === upper)?.label ?? code;
}

/** Card heading: the label when present, else the full name. */
export function addressTitle(address: SavedAddress): string {
  const label = address.label.trim();
  return label !== "" ? label : address.fullName;
}

/** One-line summary for the delete dialog, e.g. "Home: Jane Doe, 1 Main St, Springfield". */
export function addressSummary(address: SavedAddress): string {
  const parts = [address.fullName, address.line1, address.line2, address.city]
    .map((p) => (p ?? "").trim())
    .filter((p) => p !== "");
  const label = address.label.trim();
  return label !== "" ? `${label}: ${parts.join(", ")}` : parts.join(", ");
}

/** "Springfield, IL 62704" (blank parts dropped). */
export function cityLine(address: SavedAddress): string {
  const regionPostal = [address.region, address.postalCode].map((p) => p.trim()).filter((p) => p !== "").join(" ");
  return [address.city.trim(), regionPostal].filter((p) => p !== "").join(", ");
}

const noopSubscribe = () => () => {};
/** False during SSR and hydration, true afterwards (no hydration mismatch). */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

type Failure = Extract<NonNullable<AddressActionState>, { ok: false }>;

function failureOf(state: AddressActionState): Failure | null {
  return state !== null && !state.ok ? state : null;
}

function StatusNotices({ states }: { states: ReadonlyArray<AddressActionState> }) {
  const failures = states.map(failureOf).filter((f): f is Failure => f !== null);
  const successes = states.filter((s) => s !== null && s.ok);
  return (
    <>
      {failures.map((f, i) => (
        <Notice key={`err-${i}`} tone="danger" className="break-words">
          {f.message}
        </Notice>
      ))}
      <div aria-live="polite" aria-atomic="true">
        {successes.map((s, i) => (s ? <Notice key={`ok-${i}`} tone="success">{s.message}</Notice> : null))}
      </div>
    </>
  );
}

/**
 * Saved address read view. All address text is rendered as React text with
 * `break-words`. Actions post without JavaScript: "Set as default" is a
 * one-button form; "Delete" is a `<details>` step with a required confirm
 * checkbox, upgraded after hydration to a confirm Dialog.
 */
export function AddressCard({
  address,
  actions,
  editHref,
  onEdit,
  selectable,
  compact = false,
  headingLevel = 3,
  className,
}: AddressCardProps) {
  const uid = useId();
  const headingId = `${uid}-title`;
  const textId = `${uid}-text`;
  const choiceId = `${uid}-choice`;
  const Heading = `h${headingLevel}` as const;
  const title = addressTitle(address);
  const showForms = actions !== undefined && selectable === undefined;
  const hasLabel = address.label.trim() !== "";
  const line2 = address.line2?.trim() ?? "";
  const phone = address.phone?.trim() ?? "";
  const city = cityLine(address);

  return (
    <Card
      as="article"
      aria-labelledby={headingId}
      padding={compact ? "sm" : "md"}
      className={["flex flex-col break-words", compact ? "gap-2" : "gap-3", className].filter(Boolean).join(" ")}
    >
      {selectable ? (
        <Radio
          name={selectable.name}
          value={selectable.value}
          defaultChecked={selectable.checked}
          label={<span id={choiceId}>Deliver to this address</span>}
          aria-labelledby={`${choiceId} ${headingId}`}
          aria-describedby={textId}
        />
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Heading id={headingId} className="min-w-0 text-h4 text-text-primary break-words">
          {title}
        </Heading>
        {address.isDefault ? (
          <Badge tone="success" icon={<Icon name="check" size="sm" />}>
            {DEFAULT_BADGE_TEXT}
          </Badge>
        ) : null}
      </div>
      <div id={textId} className="flex min-w-0 flex-col text-body text-text-primary break-words">
        {hasLabel ? <p>{address.fullName}</p> : null}
        <p>{address.line1}</p>
        {line2 !== "" ? <p>{line2}</p> : null}
        {city !== "" ? <p>{city}</p> : null}
        <p>{countryName(address.country)}</p>
        {phone !== "" ? <p className="text-text-secondary">{`Phone: ${phone}`}</p> : null}
      </div>
      {showForms || onEdit || editHref ? (
        <AddressCardActionsRow
          address={address}
          title={title}
          actions={showForms ? actions : undefined}
          editHref={editHref}
          onEdit={onEdit}
        />
      ) : null}
    </Card>
  );
}

function AddressCardActionsRow({
  address,
  title,
  actions,
  editHref,
  onEdit,
}: {
  address: SavedAddress;
  title: string;
  actions: AddressCardActions | undefined;
  editHref: string | undefined;
  onEdit: (() => void) | undefined;
}) {
  const named = (verb: string): ReactNode => (
    <>
      {verb}
      <VisuallyHidden>{`, ${title}`}</VisuallyHidden>
    </>
  );

  let edit: ReactNode = null;
  if (onEdit) {
    edit = (
      <Button variant="ghost" size="sm" onClick={onEdit}>
        {named("Edit")}
      </Button>
    );
  } else if (editHref) {
    edit = (
      <Link href={editHref} variant="nav" className="px-3 text-small text-accent underline">
        {named("Edit")}
      </Link>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {edit}
        {actions ? <MutationForms address={address} actions={actions} named={named} /> : null}
      </div>
    </div>
  );
}

function MutationForms({
  address,
  actions,
  named,
}: {
  address: SavedAddress;
  actions: AddressCardActions;
  named: (verb: string) => ReactNode;
}) {
  const [defaultState, defaultAction, defaultPending] = useActionState(actions.setDefault, initialAddressActionState);
  const [deleteState, deleteAction, deletePending] = useActionState(actions.delete, initialAddressActionState);
  const hydrated = useHydrated();
  const [dialogOpen, setDialogOpen] = useState(false);
  const confirmId = useId();

  // Close the dialog once the delete settles; any error shows on the card.
  // Derived during render (React's "store previous value" pattern).
  const [seenDelete, setSeenDelete] = useState<AddressActionState>(deleteState);
  if (seenDelete !== deleteState) {
    setSeenDelete(deleteState);
    setDialogOpen(false);
  }

  const summary = addressSummary(address);

  return (
    <>
      {!address.isDefault ? (
        <form action={defaultAction}>
          <input type="hidden" name={ADDRESS_FIELD.addressId} value={address.id} />
          <Button type="submit" variant="ghost" size="sm" loading={defaultPending}>
            {named("Set as default")}
          </Button>
        </form>
      ) : null}
      {hydrated ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => setDialogOpen(true)} aria-haspopup="dialog">
            {named("Delete")}
          </Button>
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            title={DELETE_DIALOG_TITLE}
            description={summary}
            alert
            size="sm"
            className="break-words"
          >
            <form action={deleteAction}>
              <input type="hidden" name={ADDRESS_FIELD.addressId} value={address.id} />
              <input type="hidden" name={ADDRESS_FIELD.confirm} value={ADDRESS_DELETE_CONFIRM_VALUE} />
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" loading={deletePending}>
                  Delete
                </Button>
              </DialogFooter>
            </form>
          </Dialog>
        </>
      ) : (
        <Disclosure summary={named("Delete…")} variant="bordered" className="min-w-0">
          <form action={deleteAction} className="flex flex-col gap-2">
            <input type="hidden" name={ADDRESS_FIELD.addressId} value={address.id} />
            <Checkbox
              id={confirmId}
              name={ADDRESS_FIELD.confirm}
              value={ADDRESS_DELETE_CONFIRM_VALUE}
              label={DELETE_CONFIRM_LABEL}
              required
            />
            <div>
              <Button type="submit" variant="danger" size="sm" loading={deletePending}>
                {named("Delete")}
              </Button>
            </div>
          </form>
        </Disclosure>
      )}
      <div className="flex w-full min-w-0 flex-col gap-2">
        <StatusNotices states={[defaultState, deleteState]} />
      </div>
    </>
  );
}
