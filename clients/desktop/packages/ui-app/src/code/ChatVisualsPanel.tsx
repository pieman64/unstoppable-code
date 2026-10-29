'use client';

import { useEffect, useState, type JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  CHAT_VISUAL_TEST_IDS,
  ChatVisualHostProvider,
  type ChatVisualOwner,
} from './chat-visual-host';
import {
  useChatVisualReveal,
  useChatVisualsSource,
} from './chat-visuals-source';
import { ChatVisualBlock } from './ChatVisualBlock';

export interface ChatVisualsPanelProps {
  /** The key the chat publishes its visuals under. */
  sourceKey: string;
}

function ChatVisualsPanelItem({
  owner,
  revealRequest,
}: {
  owner: ChatVisualOwner;
  /** Set while this visual is the one to scroll to; changes on a repeat. */
  revealRequest: number | null;
}): JSX.Element {
  const [item, setItem] = useState<HTMLLIElement | null>(null);
  useEffect(() => {
    if (revealRequest !== null && item) item.scrollIntoView({ block: 'start' });
  }, [revealRequest, item]);
  return (
    <li
      ref={setItem}
      data-testid={CHAT_VISUAL_TEST_IDS.panelItem}
      data-tool-use-id={owner.toolUseId}
      className="flex scroll-mt-4 flex-col gap-2"
    >
      <h3 className={`${REPLAY_MASK_CLASS} text-s font-medium fg-primary`}>
        {owner.reference.title}
      </h3>
      <ChatVisualBlock owner={owner} variant="panel" />
    </li>
  );
}

function PanelMessage({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-s fg-secondary">
      {children}
    </div>
  );
}

/**
 * Every visual of one chat in a single scroll, in transcript order. The chat
 * publishes its visuals and their reader; this panel only lays them out, so it
 * is the same component on every host.
 */
export function ChatVisualsPanel({
  sourceKey,
}: ChatVisualsPanelProps): JSX.Element {
  const capabilities = useCapabilities();
  const source = useChatVisualsSource(sourceKey);
  const reveal = useChatVisualReveal(sourceKey);
  const enabled = capabilities.chatVisuals === true;
  return (
    <div
      data-testid={CHAT_VISUAL_TEST_IDS.panel}
      className="h-full min-h-0 overflow-y-auto"
    >
      {!enabled || !source ? (
        <PanelMessage>Open the chat to see its visuals</PanelMessage>
      ) : source.owners.length === 0 ? (
        <PanelMessage>
          Visuals an agent shows in this chat appear here
        </PanelMessage>
      ) : (
        // The chat's own host object, so a document the chat already read is
        // not read again. A panel entry has nothing to expand to.
        <ChatVisualHostProvider value={source.host}>
          <ol className="flex flex-col gap-8 px-5 py-4">
            {source.owners.map((owner) => (
              <ChatVisualsPanelItem
                key={owner.toolUseId}
                owner={owner}
                revealRequest={
                  reveal?.toolUseId === owner.toolUseId ? reveal.request : null
                }
              />
            ))}
          </ol>
        </ChatVisualHostProvider>
      )}
    </div>
  );
}
