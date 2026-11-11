import { Card } from "@/components/atoms/Card";
import { Heading, Text } from "@/components/atoms/Typography";
import type { ContactMessageView } from "@/server/contact/contact-service";

import { CONTACT_TOPIC_TEXT, formatAccountDate, isoForTimeElement } from "./page-parts";

export interface MessagesViewProps {
  readonly messages: readonly ContactMessageView[];
}

export const MESSAGES_HEADING = "Your messages";
export const MESSAGES_EMPTY_TEXT = "You haven't sent us any messages.";
/** The contact service has no reply workflow: every stored message is "Received". */
export const MESSAGE_STATUS_TEXT = "Received";

const REFERENCE = /^C-[0-9A-Z]{8}$/;

/**
 * `/account/messages` body (T98). Text only: reference, topic, date, status
 * and the owner's own message excerpt (React text, SR3). No name, email or
 * order id is rendered.
 */
export function MessagesView({ messages }: MessagesViewProps) {
  return (
    <section aria-labelledby="messages-heading" className="flex min-w-0 flex-col gap-4">
      <Heading level={1} id="messages-heading">
        {MESSAGES_HEADING}
      </Heading>
      <Text variant="small" tone="secondary">
        Messages you sent from the contact form. This demo store does not send email replies.
      </Text>
      {messages.length === 0 ? (
        <Card tone="sunken">
          <Text tone="secondary">{MESSAGES_EMPTY_TEXT}</Text>
        </Card>
      ) : (
        <ul role="list" aria-label="Sent messages" className="flex min-w-0 flex-col gap-3">
          {messages.map((m) => {
            const reference = REFERENCE.test(m.reference) ? m.reference : "Unavailable";
            const date = formatAccountDate(m.createdAt);
            const dateTime = isoForTimeElement(m.createdAt);
            return (
              <Card as="li" key={m.reference} className="flex flex-col gap-2">
                <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-small sm:grid-cols-2">
                  <div className="flex min-w-0 gap-2">
                    <dt className="text-text-secondary">Reference</dt>
                    <dd>
                      <code>{reference}</code>
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <dt className="text-text-secondary">Topic</dt>
                    <dd className="break-words">{CONTACT_TOPIC_TEXT[m.topic] ?? CONTACT_TOPIC_TEXT.other}</dd>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <dt className="text-text-secondary">Sent</dt>
                    <dd>{date !== null && dateTime !== null ? <time dateTime={dateTime}>{date}</time> : "Unknown date"}</dd>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <dt className="text-text-secondary">Status</dt>
                    <dd>{MESSAGE_STATUS_TEXT}</dd>
                  </div>
                </dl>
                <Text className="min-w-0 whitespace-pre-line break-words">{m.excerpt}</Text>
              </Card>
            );
          })}
        </ul>
      )}
    </section>
  );
}
