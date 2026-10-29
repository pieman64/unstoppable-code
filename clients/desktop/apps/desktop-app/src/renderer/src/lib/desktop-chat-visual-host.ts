import type {
  ChatVisualReadRequest,
  ChatVisualReadResult,
} from '@canopy/desktop-shared/types';
import type { ChatMessage } from '@/stores/chat/types';
import type { ChatVisualHost, ChatVisualOwner } from '@canopy/ui-app';
import { readVisualRanges } from '@canopy/ui-app';
import { desktopChatVisualsKey } from './desktop-chat-visuals-key';
import { expandDesktopChatVisual } from './panels/chat-visuals-panel-open';

export { desktopChatVisualsKey };

export type DesktopChatVisualScope = Pick<
  ChatVisualReadRequest,
  | 'projectId'
  | 'worktreeId'
  | 'chatId'
  | 'archivedContainerId'
  | 'standaloneHistory'
>;

function decodeVisualRange(response: ChatVisualReadResult): Uint8Array {
  const binary = atob(response.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type VisualResultBlock = Extract<
  ChatMessage['blocks'][number],
  { type: 'tool_result' }
>;

const ownersByBlock = new WeakMap<VisualResultBlock, ChatVisualOwner>();

function createPanelExpand(
  scope: Pick<DesktopChatVisualScope, 'projectId' | 'worktreeId' | 'chatId'>,
): (owner: ChatVisualOwner) => Promise<boolean> {
  const visualScope = {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  };
  return (owner) => expandDesktopChatVisual(visualScope, owner);
}

/**
 * Every visual the loaded messages carry, in transcript order. An owner is
 * kept per block, so a streaming transcript that rebuilds its message list
 * hands the panel the same objects.
 */
export function collectDesktopChatVisualOwners(
  messages: readonly ChatMessage[],
): ChatVisualOwner[] {
  const owners: ChatVisualOwner[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || !block.visualRef || block.isError)
        continue;
      let owner = ownersByBlock.get(block);
      if (
        !owner ||
        owner.messageId !== message.id ||
        owner.reference !== block.visualRef
      ) {
        owner = {
          messageId: message.id,
          toolUseId: block.toolUseId,
          reference: block.visualRef,
        };
        ownersByBlock.set(block, owner);
      }
      owners.push(owner);
    }
  }
  return owners;
}

export function createDesktopChatVisualHost(
  scope: DesktopChatVisualScope,
  readRange: (
    request: ChatVisualReadRequest,
  ) => Promise<ChatVisualReadResult> = (request) =>
    window.api.chat.readVisual(request),
  openExternal: (url: string) => void = (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  options?: { readonly expandInPanel?: boolean },
): ChatVisualHost {
  return {
    ...(options?.expandInPanel ? { expand: createPanelExpand(scope) } : {}),
    read: (owner, signal) =>
      readVisualRanges(
        async (offset, limit, readSignal) => {
          readSignal.throwIfAborted();
          const response = await readRange({
            ...scope,
            messageId: owner.messageId,
            toolUseId: owner.toolUseId,
            reference: owner.reference,
            offset,
            limit,
          });
          readSignal.throwIfAborted();
          return { ...response, bytes: decodeVisualRange(response) };
        },
        owner.reference,
        signal,
      ),
    openLink: openExternal,
  };
}
