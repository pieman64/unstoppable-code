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

/**
 * The pending new-chat request: the `workflowEditKey` of the item it was made
 * for, or `null` for whichever item opens next (a new draft, whose key is not
 * known when it asks).
 */
let pendingNewChatRequest: { readonly itemKey: string | null } | null = null;

/**
 * Asks the Pipeline Assistant to start a new chat, for a new workflow
 * (CAN-4319) or an opened saved one. Ask before the edit view's assistant
 * picks its chat: it takes the request as soon as its chats have loaded,
 * before its composer can be typed in, so nothing typed lands in a chat it
 * then replaces. A mounted, loaded edit view handles the event; one that
 * mounts later takes the pending request. Withdraw it with
 * {@link consumePipelineAssistantNewChatRequest} when the workflow does not
 * open. A request for `itemKey` applies only while that item is shown, so one
 * left behind (its edit view failed to load or closed first) never moves a
 * later item's chat.
 */
export function requestPipelineAssistantNewChat(
  itemKey: string | null = null,
): void {
  pendingNewChatRequest = { itemKey };
  window.dispatchEvent(new CustomEvent(PIPELINE_ASSISTANT_NEW_CHAT_EVENT));
}

/**
 * Takes the pending new-chat request, if any. With `shownItemKey`, a request
 * made for another item is dropped and answers false.
 */
export function consumePipelineAssistantNewChatRequest(
  shownItemKey?: string,
): boolean {
  const pending = pendingNewChatRequest;
  pendingNewChatRequest = null;
  if (pending === null) return false;
  return (
    pending.itemKey === null ||
    shownItemKey === undefined ||
    pending.itemKey === shownItemKey
  );
}

/**
 * Puts the cursor in the shown Pipeline Assistant's composer, for a prompt
 * that points at the assistant (CAN-4319): the edit view's assistant is the
 * only composer on the page while a workflow is open.
 */
export function focusPipelineAssistantComposer(): void {
  document.dispatchEvent(new CustomEvent('canopy:focus-chat-input'));
}
