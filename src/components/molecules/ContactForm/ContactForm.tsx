"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import { Button } from "@/components/atoms/Button";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Select, type SelectOption } from "@/components/atoms/Select";
import { Textarea } from "@/components/atoms/Textarea";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import {
  CONTACT_FIELD,
  initialContactActionState,
  type ContactActionFn,
  type ContactActionState,
  type ContactEchoValues,
} from "../_contracts/contact-actions";

/**
 * Mirror of `CONTACT_TOPICS` in `src/server/contact/contact-service.ts`.
 * Molecules never import server modules (that file imports bun:sqlite); the
 * colocated test asserts both lists stay equal.
 */
export const CONTACT_TOPICS = [
  "ordering",
  "payments",
  "shipping",
  "returns",
  "lists",
  "reviews",
  "account",
  "accessibility",
  "product",
  "feedback",
  "other",
] as const;

export type ContactTopicValue = (typeof CONTACT_TOPICS)[number];

export const CONTACT_TOPIC_LABELS: Readonly<Record<ContactTopicValue, string>> = {
  ordering: "Placing an order",
  payments: "Payments and billing",
  shipping: "Shipping and delivery",
  returns: "Returns and refunds",
  lists: "Wish lists and saved items",
  reviews: "Reviews and questions",
  account: "Your account",
  accessibility: "Accessibility",
  product: "A product",
  feedback: "Feedback about the site",
  other: "Something else",
};

/** Mirrors the service limits (BACKLOG-phase2.md, Input limits). */
export const CONTACT_LIMITS = { name: 80, email: 254, messageMin: 10, message: 2000 } as const;

export const CONTACT_COPY = {
  submit: "Send message",
  pending: "Sending…",
  messageHint: "10–2000 characters",
  honeypotLabel: "Leave this field empty",
  orderLabel: "Which order?",
  noOrder: "Not about an order",
  topicPlaceholder: "Choose a topic",
  summaryTitle: "Please fix the following",
  network:
    "We couldn't reach the store, so your message was not sent. Check your connection and try again.",
} as const;

function topicLabel(topic: string): string {
  return (CONTACT_TOPIC_LABELS as Readonly<Record<string, string>>)[topic] ?? topic;
}

export interface ContactOrderOption {
  readonly id: string;
  readonly label: string;
}

export interface ContactFormProps {
  /** Server action matching the contact contract (`sendContactMessage`). */
  action: ContactActionFn;
  /** Allowed topic values; defaults to `CONTACT_TOPICS`. */
  topics?: readonly string[];
  /** Signed-in visitor's orders. The "Which order?" select renders only when non-empty. */
  orders?: readonly ContactOrderOption[];
  initialTopic?: string;
  initialOrderId?: string;
  /** Posted as a hidden field when given (e.g. a question about a product). */
  productSlug?: string;
  /** Prefills the email field. */
  signedInEmail?: string | null;
  /** Prefix for field ids (error summary links point at `#<prefix>-<field>`). Default "contact". */
  idPrefix?: string;
  className?: string;
}

type FieldKey = keyof ContactEchoValues;

const FIELD_ORDER: readonly FieldKey[] = ["name", "email", "topic", "orderId", "message"];
const FIELD_LABELS: Readonly<Record<FieldKey, string>> = {
  name: "Name",
  email: "Email",
  topic: "Topic",
  orderId: "Order",
  message: "Message",
};

function minutesFrom(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

function focusField(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return; // native fragment navigation
  event.preventDefault();
  target.focus();
  target.scrollIntoView?.({ block: "center" });
}

export function ContactForm({
  action,
  topics = CONTACT_TOPICS,
  orders = [],
  initialTopic,
  initialOrderId,
  productSlug,
  signedInEmail,
  idPrefix = "contact",
  className,
}: ContactFormProps) {
  // No JS / before hydration: the form posts through useActionState.
  const [peState, peFormAction, pePending] = useActionState(action, initialContactActionState);
  // With JS: `onSubmit` calls the action directly so a network failure keeps
  // the typed values instead of hitting the error boundary.
  const [clientState, setClientState] = useState<ContactActionState | undefined>(undefined);
  const [networkError, setNetworkError] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const feedbackRef = useRef<HTMLDivElement>(null);

  const state = clientState === undefined ? peState : clientState;
  const pending = isPending || pePending;

  // Every settled state remounts the fields: success clears them, failure
  // refills them from `state.values` (React applies a changed Select
  // defaultValue only on mount).
  const [seen, setSeen] = useState({ state, version: 0 });
  let version = seen.version;
  if (seen.state !== state) {
    version = seen.version + 1;
    setSeen({ state, version });
  }

  const [feedbackVersion, setFeedbackVersion] = useState(0);
  useEffect(() => {
    if (feedbackVersion > 0) feedbackRef.current?.focus();
  }, [feedbackVersion]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || pending) return; // double-submit guard
    inFlight.current = true;
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      try {
        const next = await action(state, formData);
        startTransition(() => {
          setClientState(next ?? null);
          setNetworkError(false);
          if (next?.ok === false) setFeedbackVersion((v) => v + 1);
        });
      } catch {
        startTransition(() => {
          setNetworkError(true);
          setFeedbackVersion((v) => v + 1);
        });
      } finally {
        inFlight.current = false;
      }
    });
  };

  const failure = state?.ok === false ? state : null;
  const values: ContactEchoValues = failure?.values ?? {};
  const fieldErrors = failure?.fieldErrors ?? {};
  const ids: Readonly<Record<FieldKey, string>> = {
    name: `${idPrefix}-name`,
    email: `${idPrefix}-email`,
    topic: `${idPrefix}-topic`,
    orderId: `${idPrefix}-order`,
    message: `${idPrefix}-message`,
  };

  const hasOrders = orders.length > 0;
  const topicOptions: SelectOption[] = topics.map((t) => ({ value: t, label: topicLabel(t) }));
  const orderOptions: SelectOption[] = [
    { value: "", label: CONTACT_COPY.noOrder },
    ...orders.map((o) => ({ value: o.id, label: o.label })),
  ];
  const topicDefault =
    values.topic !== undefined && topics.includes(values.topic)
      ? values.topic
      : initialTopic !== undefined && topics.includes(initialTopic)
        ? initialTopic
        : undefined;
  const orderCandidate = values.orderId ?? initialOrderId ?? "";
  const orderDefault = orders.some((o) => o.id === orderCandidate) ? orderCandidate : "";

  let feedback: ReactNode = null;
  if (networkError) {
    feedback = (
      <Notice ref={feedbackRef} tabIndex={-1} tone="danger" title="Your message was not sent">
        {CONTACT_COPY.network}
      </Notice>
    );
  } else if (failure) {
    const code = failure.error.code;
    const items = FIELD_ORDER.flatMap((field) => {
      const message = fieldErrors[field];
      if (message === undefined || message === "") return [];
      if (field === "orderId" && !hasOrders) return [];
      return [{ field, id: ids[field], message }];
    });
    if (items.length > 0) {
      feedback = (
        <Notice ref={feedbackRef} tabIndex={-1} tone="danger" title={CONTACT_COPY.summaryTitle}>
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.field}>
                <Link
                  href={`#${item.id}`}
                  className="inline-flex min-h-touch items-center"
                  onClick={(e) => focusField(e, item.id)}
                >
                  {`${FIELD_LABELS[item.field]}: ${item.message}`}
                </Link>
              </li>
            ))}
          </ul>
        </Notice>
      );
    } else if (code === "DUPLICATE") {
      feedback = (
        <Notice ref={feedbackRef} tabIndex={-1} tone="warning" title="You already sent this message">
          We received the same message from you in the last 10 minutes, so we didn&apos;t send it again.
        </Notice>
      );
    } else if (code === "RATE_LIMITED") {
      const minutes = minutesFrom(failure.retryAfterSeconds);
      feedback = (
        <Notice ref={feedbackRef} tabIndex={-1} tone="warning" title="You've sent several messages recently">
          {`Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`}
        </Notice>
      );
    } else {
      feedback = (
        <Notice ref={feedbackRef} tabIndex={-1} tone="danger" title="Your message was not sent">
          {failure.message}
        </Notice>
      );
    }
  }

  return (
    <form
      action={peFormAction}
      onSubmit={onSubmit}
      aria-label="Contact us"
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <div aria-live="polite" aria-atomic="true">
        {state?.ok === true && !networkError ? (
          <Notice tone="success" title="Message sent">
            Thanks! Your reference number is{" "}
            <code className="font-mono break-all">{state.reference}</code>. Keep it for follow-ups.
          </Notice>
        ) : null}
      </div>
      {feedback}
      {productSlug !== undefined && productSlug !== "" ? (
        <input type="hidden" name={CONTACT_FIELD.productSlug} value={productSlug} />
      ) : null}
      <div key={version} className="flex flex-col gap-4">
        <FormField id={ids.name} label="Name" required error={fieldErrors.name}>
          {(p) => (
            <Input
              {...p}
              name={CONTACT_FIELD.name}
              autoComplete="name"
              maxLength={CONTACT_LIMITS.name}
              defaultValue={values.name ?? ""}
            />
          )}
        </FormField>
        <FormField id={ids.email} label="Email" required error={fieldErrors.email}>
          {(p) => (
            <Input
              {...p}
              type="email"
              name={CONTACT_FIELD.email}
              autoComplete="email"
              maxLength={CONTACT_LIMITS.email}
              defaultValue={values.email ?? signedInEmail ?? ""}
            />
          )}
        </FormField>
        <FormField id={ids.topic} label="Topic" required error={fieldErrors.topic}>
          {(p) => (
            <Select
              {...p}
              name={CONTACT_FIELD.topic}
              options={topicOptions}
              placeholder={CONTACT_COPY.topicPlaceholder}
              defaultValue={topicDefault}
            />
          )}
        </FormField>
        {hasOrders ? (
          <FormField id={ids.orderId} label={CONTACT_COPY.orderLabel} error={fieldErrors.orderId}>
            {(p) => (
              <Select {...p} name={CONTACT_FIELD.orderId} options={orderOptions} defaultValue={orderDefault} />
            )}
          </FormField>
        ) : null}
        <FormField
          id={ids.message}
          label="Message"
          required
          hint={CONTACT_COPY.messageHint}
          error={fieldErrors.message}
        >
          {(p) => (
            <Textarea
              {...p}
              name={CONTACT_FIELD.message}
              rows={6}
              minLength={CONTACT_LIMITS.messageMin}
              maxLength={CONTACT_LIMITS.message}
              showCount
              defaultValue={values.message ?? ""}
            />
          )}
        </FormField>
        {/* Honeypot (D14): hidden from sighted users and assistive tech; people never fill it. */}
        <VisuallyHidden as="div" aria-hidden="true">
          <label htmlFor={`${idPrefix}-website`}>{CONTACT_COPY.honeypotLabel}</label>
          <Input
            id={`${idPrefix}-website`}
            name={CONTACT_FIELD.website}
            type="text"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            defaultValue=""
          />
        </VisuallyHidden>
      </div>
      <Button type="submit" fullWidth loading={pending} className="sm:w-auto sm:self-start">
        {pending ? CONTACT_COPY.pending : CONTACT_COPY.submit}
      </Button>
    </form>
  );
}
