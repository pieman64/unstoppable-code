import type {
  ChatApi,
  ChatCommandRequest,
  ChatCommandResult,
  ChatGetStateRequest,
  ChatInterestDeclaration,
  ChatStateChangedEvent,
  ChatStateScopesDeclaration,
  ChatStateSnapshot,
  ChatTranscriptPageRequest,
  ChatTranscriptSearchRequest,
  ChatTranscriptSearchResult,
  ChatToolOutputCancelRequest,
  ChatToolOutputRequest,
  ChatToolOutputResponse,
  ChatVisualReadRequest,
  ChatVisualReadResult,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createListenerFanout } from '@canopy/desktop-shared/lib/listener-fanout';

type ChatStateIpc = {
  invoke(
    channel: typeof IPC_CHANNELS.chatSearchTranscript,
    request: ChatTranscriptSearchRequest,
  ): Promise<ChatTranscriptSearchResult>;
  invoke(
    channel: typeof IPC_CHANNELS.chatCancelTranscriptSearch,
    requestId: string,
  ): Promise<void>;
  invoke(
    channel: typeof IPC_CHANNELS.chatGetTranscriptPage,
    request: ChatTranscriptPageRequest,
  ): Promise<TranscriptPage>;
  invoke(
    channel: typeof IPC_CHANNELS.chatReadToolOutput,
    request: ChatToolOutputRequest,
  ): Promise<ChatToolOutputResponse>;
  invoke(
    channel: typeof IPC_CHANNELS.chatReadVisual,
    request: ChatVisualReadRequest,
  ): Promise<ChatVisualReadResult>;
  invoke(
    channel: typeof IPC_CHANNELS.chatCancelToolOutput,
    request: ChatToolOutputCancelRequest,
  ): Promise<void>;
  invoke(
    channel: typeof IPC_CHANNELS.chatGetState,
    request: ChatGetStateRequest,
  ): Promise<ChatStateSnapshot>;
  invoke(
    channel: typeof IPC_CHANNELS.chatCommand,
    request: ChatCommandRequest,
  ): Promise<ChatCommandResult>;
  invoke(
    channel: typeof IPC_CHANNELS.chatSetStateScopes,
    declaration: ChatStateScopesDeclaration,
  ): Promise<void>;
  invoke(
    channel: typeof IPC_CHANNELS.chatSetInterest,
    declaration: ChatInterestDeclaration,
  ): Promise<void>;
  on(
    channel: string,
    listener: (event: unknown, payload: ChatStateChangedEvent) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (event: unknown, payload: ChatStateChangedEvent) => void,
  ): void;
};

export type ChatStateApi = Pick<
  ChatApi,
  | 'searchTranscript'
  | 'cancelTranscriptSearch'
  | 'getState'
  | 'getTranscriptPage'
  | 'readToolOutput'
  | 'readVisual'
  | 'cancelToolOutput'
  | 'command'
  | 'onStateChanged'
  | 'setStateScopes'
  | 'setInterest'
>;

/** Build the revisioned chat bridge against an injectable IPC renderer seam. */
export function createChatStateApi(ipc: ChatStateIpc): ChatStateApi {
  // One `chat:state-changed` IPC listener per page, however many subscribers.
  const subscribeToStateChanges = createListenerFanout<ChatStateChangedEvent>(
    (dispatch) => {
      const handler = (_event: unknown, payload: ChatStateChangedEvent): void =>
        dispatch(payload);
      ipc.on(IPC_CHANNELS.chatStateChanged, handler);
      return (): void => {
        ipc.removeListener(IPC_CHANNELS.chatStateChanged, handler);
      };
    },
  );
  return {
    searchTranscript: (request) =>
      ipc.invoke(IPC_CHANNELS.chatSearchTranscript, request),
    cancelTranscriptSearch: (requestId) =>
      ipc.invoke(IPC_CHANNELS.chatCancelTranscriptSearch, requestId),
    getTranscriptPage: (request) =>
      ipc.invoke(IPC_CHANNELS.chatGetTranscriptPage, request),
    readToolOutput: (request) =>
      ipc.invoke(IPC_CHANNELS.chatReadToolOutput, request),
    readVisual: (request) => ipc.invoke(IPC_CHANNELS.chatReadVisual, request),
    cancelToolOutput: (request) =>
      ipc.invoke(IPC_CHANNELS.chatCancelToolOutput, request),
    getState: (request: ChatGetStateRequest) =>
      ipc.invoke(IPC_CHANNELS.chatGetState, request),
    command: (request: ChatCommandRequest) =>
      ipc.invoke(IPC_CHANNELS.chatCommand, request),
    setStateScopes: (declaration: ChatStateScopesDeclaration) =>
      ipc.invoke(IPC_CHANNELS.chatSetStateScopes, declaration),
    setInterest: (declaration: ChatInterestDeclaration) =>
      ipc.invoke(IPC_CHANNELS.chatSetInterest, declaration),
    onStateChanged: (listener) => subscribeToStateChanges(listener),
  };
}
