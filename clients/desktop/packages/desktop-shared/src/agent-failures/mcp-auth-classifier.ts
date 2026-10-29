import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import { toAuthDiagnosticDetail } from './auth-diagnostic-detail';

export interface McpAuthFailureInput {
  serverId: string;
  configId: string;
  /** User-facing server name, taken from the proxy route. */
  displayName: string;
  /** Upstream HTTP status that triggered the classification. */
  statusCode: number;
  /** Raw diagnostic; redacted before it leaves this function. */
  diagnostic: string;
}

/**
 * Classify an upstream MCP response as an authentication failure, or decline.
 *
 * `null` means 'not an authentication failure' and is the guard that keeps a
 * 500 or a 404 from producing a reconnect prompt. A 403 is deliberately NOT
 * recoverable: the token authenticated fine and was refused on scope, so
 * re-running OAuth with the same grant would not fix it.
 */
export function classifyMcpAuthFailure(
  input: McpAuthFailureInput,
): AuthDependencyFailure | null {
  const { serverId, configId, displayName, statusCode } = input;
  const detail = toAuthDiagnosticDetail(input.diagnostic);
  const dependencyId = `${serverId}:${configId}`;

  if (statusCode === 401) {
    return {
      dependencyClass: 'mcp',
      dependencyId,
      displayName,
      failureClass: 'expired',
      recovery: { kind: 'mcp_oauth', serverId, configId },
      detail,
    };
  }

  if (statusCode === 403) {
    return {
      dependencyClass: 'mcp',
      dependencyId,
      displayName,
      failureClass: 'insufficient_scope',
      recovery: { kind: 'none' },
      detail,
    };
  }

  return null;
}
