import {
  isAccountMcpConnectionEnabled,
  type AccountMcpConnection,
} from '@canopy/protocol/mcp-servers';

/**
 * Why chats and agents cannot use `connection`, or null when they can: it is
 * signed in and the user has not turned it off in the cloud.
 */
export function accountMcpConnectionUnusableReason(
  connection: Pick<AccountMcpConnection, 'status' | 'enabled'>,
): string | null {
  if (!isAccountMcpConnectionEnabled(connection))
    return 'Account MCP connection is turned off.';
  if (connection.status !== 'CONNECTED')
    return `Account MCP connection is ${connection.status}.`;
  return null;
}
