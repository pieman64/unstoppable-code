'use client';

import { useCallback, useId, useState, type JSX } from 'react';
import {
  AgentVisualFrame,
  Button,
  DialogModal,
  SegmentedControl,
} from '@canopy/ui-shared/components';
import type { AgentVisualTheme } from '@canopy/ui-shared/lib';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  CHAT_VISUAL_TEST_IDS,
  type ChatVisualHost,
  type ChatVisualOwner,
} from './chat-visual-host';
import { saveChatVisualAsHtml } from './chat-visual-save';

export interface ChatVisualDialogProps {
  owner: ChatVisualOwner;
  document: string;
  host: ChatVisualHost;
  theme: AgentVisualTheme;
  initialTab: 'visual' | 'source';
  ownerDocument?: Document;
  onClose: () => void;
}

export function ChatVisualDialog({
  owner,
  document,
  host,
  theme,
  initialTab,
  ownerDocument,
  onClose,
}: ChatVisualDialogProps): JSX.Element {
  const [tab, setTab] = useState(initialTab);
  const ids = useId();
  const visualTabId = `${ids}-visual-tab`;
  const sourceTabId = `${ids}-source-tab`;
  const panelId = `${ids}-panel`;
  const onOpenLink = useCallback(
    (url: string): void => host.openLink(url),
    [host],
  );
  const save = useCallback(
    (): void =>
      saveChatVisualAsHtml({
        document,
        theme,
        title: owner.reference.title,
        ownerDocument,
      }),
    [document, theme, owner.reference.title, ownerDocument],
  );
  return (
    // Portalled out of the transcript and the Chat visuals panel, so their
    // session replay blocks do not reach the title or the source below.
    <DialogModal
      title={<span className={REPLAY_MASK_CLASS}>{owner.reference.title}</span>}
      onClose={onClose}
      dataTestId={CHAT_VISUAL_TEST_IDS.dialog}
      maxWidth="full"
      maxHeight="100%"
      height="min(90vh, 90dvh)"
      trapFocus
      ownerDocument={ownerDocument}
      topRightActions={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid={CHAT_VISUAL_TEST_IDS.saveButton}
          onClick={save}
        >
          Save as HTML
        </Button>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-3 px-5 pb-5 pt-3">
        {/* A row, so the track keeps its own width. */}
        <div className="flex">
          <SegmentedControl
            value={tab}
            onChange={setTab}
            label="Visual view"
            semantics="tabs"
            options={[
              {
                value: 'visual',
                label: 'Visual',
                id: visualTabId,
                controls: panelId,
              },
              {
                value: 'source',
                label: 'Source',
                id: sourceTabId,
                controls: panelId,
              },
            ]}
          />
        </div>
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={tab === 'visual' ? visualTabId : sourceTabId}
          className="flex min-h-0 flex-1 flex-col"
        >
          {tab === 'visual' ? (
            document.length > 0 ? (
              <AgentVisualFrame
                document={document}
                title={owner.reference.title}
                maxHeight={owner.reference.maxHeight}
                heights={owner.reference.heights}
                theme={theme}
                onOpenLink={onOpenLink}
                variant="expanded"
                frameUrl={host.frameUrl}
                testIds={CHAT_VISUAL_TEST_IDS}
              />
            ) : (
              <p className="text-s fg-secondary">This visual is empty.</p>
            )
          ) : (
            <pre
              data-testid={CHAT_VISUAL_TEST_IDS.sourceView}
              className={`${REPLAY_BLOCK_CLASS} min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-secondary p-3 font-mono text-xs fg-primary`}
              aria-label="Visual source"
            >
              {document.length > 100000
                ? `${document.slice(0, 100000)}\n… Source preview limited to 100,000 characters.`
                : document}
            </pre>
          )}
        </div>
      </div>
    </DialogModal>
  );
}
