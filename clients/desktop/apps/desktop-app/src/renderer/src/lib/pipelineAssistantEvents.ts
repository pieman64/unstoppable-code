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
