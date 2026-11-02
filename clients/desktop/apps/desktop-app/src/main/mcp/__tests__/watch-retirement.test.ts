import { BRAND } from '@canopy/brand/current';
import {
  McpHttpProxyService,
  type CanopyWorktreeSessionRoute,
} from '../http-proxy-service';
import { watchDelegatesCompatibilityResult } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';

jest.mock('../../canopy-tools/core', () => ({
  executeCanopyInjectedTool: jest.fn(),
}));

describe('unlisted watch MCP membership', () => {
  it.each(['claude', 'cursor', 'copilot', 'opencode'] as const)(
    'routes historical %s calls through the session callback without listing them',
    async (providerType) => {
      const service = new McpHttpProxyService();
      const invoke = jest.fn((_name: string, input: unknown) =>
        Promise.resolve({
          text: JSON.stringify(watchDelegatesCompatibilityResult(input)),
          isError: false,
        }),
      );
      const route: CanopyWorktreeSessionRoute = {
        sessionKey: 'p/w/c',
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sdkSessionId: 'native',
        authToken: 'test-token',
        createdAt: 0,
        hookHandler: () => {},
        providerType,
        managedDelegation: { tools: [], invoke },
      };
      for (const name of [
        'WatchDelegates',
        `mcp__${BRAND.tools.namespace}__WatchDelegates`,
        `${BRAND.tools.namespace}_watch_delegates`,
      ]) {
        const response = await service['handleCanopyMcpJsonRpc'](route, {
          jsonrpc: '2.0',
          id: 'call',
          method: 'tools/call',
          params: { name, arguments: { mode: 'all' } },
        });
        expect(invoke).toHaveBeenLastCalledWith(
          name,
          { mode: 'all' },
          { requestId: 'call' },
        );
        expect(JSON.stringify(response)).toContain(
          'delegation-notices-automatic',
        );
      }
      const response = await service['handleCanopyMcpJsonRpc'](route, {
        jsonrpc: '2.0',
        id: 'list',
        method: 'tools/list',
      });
      expect(JSON.stringify(response)).not.toContain('WatchDelegates');
      invoke.mockClear();
      await service['handleCanopyMcpJsonRpc'](
        { ...route, managedDelegation: { tools: [], invoke, exclusive: true } },
        {
          jsonrpc: '2.0',
          id: 'child',
          method: 'tools/call',
          params: { name: 'WatchDelegates', arguments: {} },
        },
      ).then((result) =>
        expect(JSON.stringify(result)).toContain('not available'),
      );
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
