export const PIPELINE_ASSISTANT_OPEN_EVENT = 'canopy:pipelines-open-assistant';

let pendingOpenRequest = false;

/**
 * Asks the Pipelines page to show the Pipeline Assistant drawer. A mounted
 * page handles the event; a page that mounts later (the caller usually
 * navigates there first) consumes the pending request instead, so an explicit
 * open never depends on the drawer's conversation-based default (CAN-3980).
 */
export function requestPipelineAssistantOpen(): void {
  pendingOpenRequest = true;
  window.dispatchEvent(new CustomEvent(PIPELINE_ASSISTANT_OPEN_EVENT));
}

/** Takes the pending open request, if any. */
export function consumePipelineAssistantOpenRequest(): boolean {
  const pending = pendingOpenRequest;
  pendingOpenRequest = false;
  return pending;
}

export const PIPELINE_ASSISTANT_NEW_CHAT_EVENT =
  'canopy:pipelines-new-assistant-chat';

let pendingNewChatRequest = false;

/**
 * Asks the Pipeline Assistant to start a new chat, for a new workflow
 * (CAN-4319). Ask before the workflow opens: the edit view's assistant
 * takes it as soon as its chats have loaded, before its composer can be typed
 * in, so nothing typed lands in a chat it then replaces. A mounted, loaded
 * edit view handles the event; one that mounts later takes the pending
 * request. Withdraw it with {@link consumePipelineAssistantNewChatRequest}
 * when the workflow does not open.
 */
export function requestPipelineAssistantNewChat(): void {
  pendingNewChatRequest = true;
  window.dispatchEvent(new CustomEvent(PIPELINE_ASSISTANT_NEW_CHAT_EVENT));
}

/** Takes the pending new-chat request, if any. */
export function consumePipelineAssistantNewChatRequest(): boolean {
  const pending = pendingNewChatRequest;
  pendingNewChatRequest = false;
  return pending;
}

/**
 * Puts the cursor in the shown Pipeline Assistant's composer, for a prompt
 * that points at the assistant (CAN-4319): the edit view's assistant is the
 * only composer on the page while a workflow is open.
 */
export function focusPipelineAssistantComposer(): void {
  document.dispatchEvent(new CustomEvent('canopy:focus-chat-input'));
}
