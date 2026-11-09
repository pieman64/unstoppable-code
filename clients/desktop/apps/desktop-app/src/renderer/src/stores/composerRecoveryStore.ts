import type { Descendant } from 'slate';
import {
  composerRecoveryTranscriptHead,
  createComposerRecoveryStore,
  type ComposerRecoveryTranscriptHead,
  type ComposerRecoveryTranscriptMessage,
} from '@canopy/ui-app/composer-recovery';
import type { AttachmentMeta } from '@canopy/desktop-shared/types';
import { messageHasAgentActivity } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import type { EditorSelectionContext } from '@/lib/editorSelectionContext';
import { chatBannerKey } from '@/stores/aiCreditsBannerStore';
import type {
  ChatMessage,
  QueuedChatMessage,
  QueuedWithoutDispatchLocation,
} from '@/stores/chat/types';

/** Composer inputs a send reserves, returned with the editor value. */
export interface DesktopComposerReservedInputs {
  attachments: readonly AttachmentMeta[];
  selections: readonly EditorSelectionContext[];
  revertAttachmentPath?: string;
}

/**
 * Desktop binding of the shared composer recovery lifecycle (CAN-5348). The
 * chat event subscription records no-billing refusals; `ChatInput` records
 * submissions and restores them. Both key by {@link chatBannerKey}.
 */
export const composerRecoveryStore = createComposerRecoveryStore<
  Descendant[],
  DesktopComposerReservedInputs
>();

export const composerRecoveryKey = chatBannerKey;

/** Reservation rollback belongs to its send even after recovery is superseded. */
export function restoreRejectedComposerInputs(
  key: string,
  generation: number,
  restore: () => void,
): void {
  if (composerRecoveryStore.get(key)?.generation !== generation) {
    restore();
    return;
  }
  if (!composerRecoveryStore.claim(key, generation)) return;
  try {
    restore();
    composerRecoveryStore.settle(key, generation, 'reserved-inputs-restored');
  } finally {
    composerRecoveryStore.unclaim(key, generation);
  }
}

/**
 * A host-queued send is recovered by its queue row, which holds it after a
 * credit refusal, so a later refusal of its dispatch must not also return it
 * to the composer (CAN-5618). Releases only this submission's generation.
 */
export function handOffComposerRecoveryToQueue(
  key: string | undefined,
  generation: number | undefined,
  location: QueuedWithoutDispatchLocation,
): void {
  if (location !== 'host' || key === undefined || generation === undefined) {
    return;
  }
  composerRecoveryStore.release(key, generation);
}

/**
 * Messaging reports acceptance immediately before its synchronous queue callback,
 * including late acknowledgement. Keep refusal recovery pending until that
 * callback has had the opportunity to transfer this submission to its queue.
 */
export function settleAcceptedComposerRecovery(
  key: string | undefined,
  generation: number | undefined,
): void {
  if (key === undefined || generation === undefined) return;
  queueMicrotask(() =>
    composerRecoveryStore.settle(key, generation, 'accepted'),
  );
}

/** Credit-held host queue rows by `hostQueueEntryId`, with their latest text. */
export type HeldQueueRows = ReadonlyMap<string, string>;

/**
 * Main marks every credit-held row `retryable`; funding clears only its
 * `insufficient_credits` block, and the row stays until it is retried.
 */
function isCreditHeldQueueRow(row: QueuedChatMessage): boolean {
  return (
    row.retryable === true || row.retryBlockedReason === 'insufficient_credits'
  );
}

/**
 * Advance held-row tracking to a queue snapshot. A tracked row stays tracked,
 * with its edited text, after funding clears its hold flags; it is released
 * only when it leaves the queue (retried, sent, or deleted).
 */
export function advanceHeldQueueRows(
  held: HeldQueueRows,
  rows: readonly QueuedChatMessage[] | undefined,
): { held: Map<string, string>; releasedTexts: string[] } {
  const next = new Map<string, string>();
  if (!rows) return { held: next, releasedTexts: [] };
  const present = new Map<string, QueuedChatMessage>();
  for (const row of rows) {
    if (row.hostQueueEntryId !== undefined) {
      present.set(row.hostQueueEntryId, row);
    }
  }
  const releasedTexts: string[] = [];
  for (const [entryId, text] of held) {
    const row = present.get(entryId);
    if (row) next.set(entryId, row.text);
    else releasedTexts.push(text);
  }
  for (const [entryId, row] of present) {
    if (isCreditHeldQueueRow(row)) next.set(entryId, row.text);
  }
  return { held: next, releasedTexts };
}

/**
 * Whether a composer draft is exactly a released held row's prompt. Only outer
 * whitespace is ignored; identical text the user typed independently matches.
 */
export function draftMatchesReleasedHeldRow(
  draftText: string,
  releasedTexts: readonly string[],
): boolean {
  const draft = draftText.trim();
  return (
    draft.length > 0 && releasedTexts.some((text) => text.trim() === draft)
  );
}

/** Current composer inputs that must survive a held-row release. */
export interface HeldQueueDraft {
  key: string | undefined;
  text: string;
  occupancy: {
    attachments: boolean;
    selections: boolean;
    revertAttachment: boolean;
    fileReferences: boolean;
    scheduledSend: boolean;
    queuedEdit: boolean;
    terminal: boolean;
    stashedDraft: boolean;
  };
}

/**
 * Observe only valid queue snapshots for one composer. Missing snapshots and
 * identity changes reset observation, never synthesize deletion. Read editor
 * state only on a real release, and consume it before any recursive draft save.
 */
export function bindHeldQueueComposerRecovery(port: {
  subscribe: (listener: () => void) => () => void;
  readQueue: () =>
    | { key: string; rows: readonly QueuedChatMessage[] }
    | undefined;
  readDraft: () => HeldQueueDraft | undefined;
  clearDraft: () => void;
}): () => void {
  const initial = port.readQueue();
  let key = initial?.key;
  let rows = initial?.rows;
  let held: HeldQueueRows = advanceHeldQueueRows(new Map(), rows).held;
  return port.subscribe(() => {
    const current = port.readQueue();
    if (!current || current.key !== key) {
      key = current?.key;
      rows = current?.rows;
      held = advanceHeldQueueRows(new Map(), rows).held;
      return;
    }
    if (current.rows === rows) return;
    rows = current.rows;
    const next = advanceHeldQueueRows(held, rows);
    held = next.held;
    if (next.releasedTexts.length === 0) return;
    const draft = port.readDraft();
    if (
      !draft ||
      draft.key !== key ||
      Object.values(draft.occupancy).some(Boolean) ||
      !draftMatchesReleasedHeldRow(draft.text, next.releasedTexts)
    )
      return;
    port.clearDraft();
  });
}

/** Project a desktop transcript for recovery decisions. */
export function composerRecoveryTranscript(
  messages: readonly ChatMessage[],
): ComposerRecoveryTranscriptMessage[] {
  return messages.map((message) => ({
    id: message.id,
    isUser: message.role === 'user',
    hasAgentActivity: messageHasAgentActivity(message),
  }));
}

/** Newest committed user message, for binding a refusal to its turn. */
export function composerRecoveryHead(
  messages: readonly ChatMessage[],
): ComposerRecoveryTranscriptHead {
  return composerRecoveryTranscriptHead(composerRecoveryTranscript(messages));
}
