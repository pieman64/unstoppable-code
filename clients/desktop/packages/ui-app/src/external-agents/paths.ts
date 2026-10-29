export const EXTERNAL_AGENTS_PATH = '/account/external-agents';

export function externalAgentPath(connectionId: string): string {
  return `${EXTERNAL_AGENTS_PATH}/${encodeURIComponent(connectionId)}`;
}

/** The page where the person confirms or declines one waiting request. */
export function externalAgentConfirmationPath(pendingActionId: string): string {
  return `${EXTERNAL_AGENTS_PATH}/confirm/${encodeURIComponent(pendingActionId)}`;
}

export const EXTERNAL_AGENTS_LABEL = 'External agents (MCP)';
