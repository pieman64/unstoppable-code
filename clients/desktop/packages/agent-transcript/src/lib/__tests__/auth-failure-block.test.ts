import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import type { PersistedChatBlock } from '../../types';

const failure: AuthDependencyFailure = {
  dependencyClass: 'mcp',
  dependencyId: 'srv-1:cfg-1',
  displayName: 'Prod MCP server',
  failureClass: 'expired',
  recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
};

describe('PersistedChatBlock authFailure', () => {
  it('accepts an auth failure on a tool_result block', () => {
    const block: PersistedChatBlock = {
      type: 'tool_result',
      toolUseId: 'tu-1',
      toolName: 'mcp__prod__query',
      output: 'HTTP 401',
      isError: true,
      authFailure: failure,
    };
    expect(block.type === 'tool_result' && block.authFailure?.displayName).toBe(
      'Prod MCP server',
    );
  });

  it('accepts an auth failure on a text block', () => {
    const block: PersistedChatBlock = {
      type: 'text',
      text: "You're not signed in to Claude.",
      authFailure: {
        dependencyClass: 'provider',
        dependencyId: 'claude',
        displayName: 'Claude',
        failureClass: 'unauthenticated',
        recovery: { kind: 'provider_terminal', provider: 'claude' },
      },
    };
    expect(block.type === 'text' && block.authFailure?.dependencyId).toBe(
      'claude',
    );
  });

  it('keeps the field optional so legacy blocks still typecheck', () => {
    const block: PersistedChatBlock = { type: 'text', text: 'hello' };
    expect(block.type === 'text' && block.authFailure).toBeUndefined();
  });
});
