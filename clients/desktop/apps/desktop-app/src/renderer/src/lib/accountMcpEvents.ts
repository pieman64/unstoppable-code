export const ACCOUNT_MCP_ACTION_EVENT = 'canopy:account-mcp-action';
const ACCOUNT_MCP_OPERATIONS = [
  'connect',
  'reconnect',
  'disconnect',
  'promote',
  'edit',
] as const;
export interface AccountMcpActionEventDetail {
  operation: (typeof ACCOUNT_MCP_OPERATIONS)[number];
  serverId: string;
  acknowledge: () => void;
  refuse?: (message: string) => void;
}
export function isAccountMcpActionEventDetail(
  value: unknown,
): value is AccountMcpActionEventDetail {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operation' in value &&
    ACCOUNT_MCP_OPERATIONS.some(
      (operation): boolean => operation === value.operation,
    ) &&
    'serverId' in value &&
    typeof value.serverId === 'string' &&
    'acknowledge' in value &&
    typeof value.acknowledge === 'function' &&
    (!('refuse' in value) || typeof value.refuse === 'function')
  );
}
