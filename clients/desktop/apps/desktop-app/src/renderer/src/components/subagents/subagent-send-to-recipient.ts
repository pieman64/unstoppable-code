import { isLiveSubagentStatus } from '@canopy/agent-transcript';
import type { SubagentRecipient, SubagentTree } from '@canopy/ui-shared';
import type {
  SubagentCommandResult,
  SubagentMessageResult,
} from '@canopy/ui-app/subagents';
import { useChatStore } from '@/stores/chatStore';
import { extractIpcErrorMessage } from '@/lib/errors';
import { revealWorktreeChatPanel } from '@/lib/panels/plan-panel-open';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';
import {
  useSubagentComposerStore,
  subagentDraftKey,
} from '@canopy/ui-app/subagents';
import { messageManagedSubagent } from './subagent-commands';
import type { SubagentHostScope } from './subagent-scope';

export interface SendToSubagentRecipientRequest {
  readonly scope: SubagentHostScope;
  readonly rootChatId: string;
  readonly tree: SubagentTree;
  readonly recipient: SubagentRecipient;
  /** Includes the selected subagent's reference text when sent from the composer. */
  readonly text: string;
}

export interface SendToSubagentRecipientOptions {
  /** Test seam for the managed-follow-up deduplication id. */
  readonly createOperationId?: () => string;
}

const RECIPIENT_UNAVAILABLE_ERROR = 'This recipient is no longer available.';
const ROOT_SEND_FAILED_ERROR = "Couldn't send a message to the root chat.";
const RECIPIENT_QUEUE_FAILED_ERROR =
  "Couldn't queue a message for this recipient.";

/** Sends to a parent/root chat and reveals it only after the send is accepted. */
export async function sendToSubagentRecipient(
  request: SendToSubagentRecipientRequest,
  options: SendToSubagentRecipientOptions = {},
): Promise<SubagentCommandResult> {
  const { recipient, scope, rootChatId, tree, text } = request;

  if (recipient.kind === 'root') {
    if (recipient.id !== rootChatId || tree.root.id !== rootChatId) {
      return { ok: false, error: RECIPIENT_UNAVAILABLE_ERROR };
    }
    let preDispatchRejected = false;
    let dispatchRejected = false;
    try {
      await useChatStore.getState().sendMessage(
        text,
        undefined,
        {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId: rootChatId,
        },
        undefined,
        {
          throwOnDispatchFailure: true,
          onPreDispatchRejected: (): void => {
            preDispatchRejected = true;
          },
          onDispatchRejected: (): void => {
            dispatchRejected = true;
          },
        },
      );
    } catch (error: unknown) {
      return {
        ok: false,
        error: extractIpcErrorMessage(error) || ROOT_SEND_FAILED_ERROR,
      };
    }
    if (preDispatchRejected || dispatchRejected) {
      return { ok: false, error: ROOT_SEND_FAILED_ERROR };
    }
    // The message was accepted: report success even if the reveal fails, so
    // the composer clears and a retry cannot send it a second time.
    try {
      revealWorktreeChatPanel(scope, rootChatId);
    } catch {
      // Navigation is best effort once the send is accepted.
    }
    return { ok: true };
  }

  if (recipient.kind !== 'ancestor') {
    return { ok: false, error: RECIPIENT_UNAVAILABLE_ERROR };
  }
  const parent = tree.nodes.get(recipient.id);
  if (!parent || parent.kind !== 'managed' || !recipient.canMessage) {
    return { ok: false, error: RECIPIENT_UNAVAILABLE_ERROR };
  }

  if (isLiveSubagentStatus(parent.status)) {
    try {
      const key = subagentDraftKey(rootChatId, parent.id);
      const store = useSubagentComposerStore.getState();
      store.ensureDraft(key, parent.id);
      store.enqueueDraft(key, text);
    } catch (error: unknown) {
      return {
        ok: false,
        error: extractIpcErrorMessage(error) || RECIPIENT_QUEUE_FAILED_ERROR,
      };
    }
  } else {
    let result: SubagentMessageResult;
    try {
      result = await messageManagedSubagent(scope, rootChatId, parent.id, {
        operation: 'follow_up',
        message: text,
        operationId:
          options.createOperationId?.() ?? globalThis.crypto.randomUUID(),
      });
    } catch (error: unknown) {
      return {
        ok: false,
        error: extractIpcErrorMessage(error) || RECIPIENT_UNAVAILABLE_ERROR,
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || RECIPIENT_UNAVAILABLE_ERROR,
      };
    }
  }

  // The message was sent or queued: navigation is best effort, so a failed
  // open never makes the composer keep (and later resend) the text.
  try {
    await openSubagentChatPanel(scope, {
      rootChatId,
      subagentId: parent.id,
      subagentKind: parent.kind,
      title: parent.title,
    });
  } catch {
    // The parent's panel could not open; its queue still holds the message.
  }
  return { ok: true };
}
