'use client';

import { Fragment, type JSX, type ReactNode } from 'react';
import {
  Markdown,
  SubagentRunDivider,
  SubagentTaskBubble,
  SubagentUserMessageBubble,
  type AgentSentReceivingContext,
  type AnySubagentChatTranscriptItem,
} from '@canopy/ui-shared';

type AuthoredItemKind = 'task' | 'follow_up' | 'divider' | 'user';

/** Rows the host renders itself: its content blocks or parts. */
export type SubagentTranscriptContentItem<
  TItem extends AnySubagentChatTranscriptItem,
> = Exclude<TItem, { readonly kind: AuthoredItemKind }>;

export interface SubagentTranscriptRowsProps<
  TItem extends AnySubagentChatTranscriptItem,
> {
  readonly items: readonly TItem[];
  /** Renders a row that is not an authored bubble or a run divider. */
  readonly renderContent: (
    item: SubagentTranscriptContentItem<TItem>,
  ) => ReactNode;
  /**
   * The chat that received agent-sent user messages, so their titles omit
   * redundant labels. Defaults to the nearest receiving-context provider.
   */
  readonly receivingContext?: AgentSentReceivingContext;
}

function isContentItem<TItem extends AnySubagentChatTranscriptItem>(
  item: TItem,
): item is SubagentTranscriptContentItem<TItem> & TItem {
  return (
    item.kind !== 'task' &&
    item.kind !== 'follow_up' &&
    item.kind !== 'divider' &&
    item.kind !== 'user'
  );
}

/**
 * A subagent transcript's rows: the shared task, follow-up, run divider and
 * user bubbles, with the host's own renderer for content rows.
 */
export function SubagentTranscriptRows<
  TItem extends AnySubagentChatTranscriptItem,
>({
  items,
  renderContent,
  receivingContext,
}: SubagentTranscriptRowsProps<TItem>): JSX.Element {
  return (
    <>
      {items.map((item) => {
        if (isContentItem(item)) {
          return <Fragment key={item.key}>{renderContent(item)}</Fragment>;
        }
        const row: AnySubagentChatTranscriptItem = item;
        switch (row.kind) {
          case 'task':
            return (
              <SubagentTaskBubble
                key={row.key}
                kind="task"
                sender={row.sender}
                text={row.text}
                {...(row.shownTexts !== undefined
                  ? { shownTexts: row.shownTexts }
                  : {})}
              />
            );
          case 'follow_up':
            return (
              <SubagentTaskBubble
                key={row.key}
                kind="follow_up"
                sender={row.sender}
                text={row.text}
              />
            );
          case 'divider':
            return (
              <SubagentRunDivider
                key={row.key}
                runGeneration={row.runGeneration}
              />
            );
          case 'user':
            return (
              <SubagentUserMessageBubble
                key={row.key}
                copyText={row.text}
                steering={row.steering}
                agentSent={row.agentSent}
                receivingContext={receivingContext}
              >
                <Markdown>{row.text}</Markdown>
              </SubagentUserMessageBubble>
            );
          default:
            return null;
        }
      })}
    </>
  );
}
