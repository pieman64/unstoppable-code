import { BRAND } from '@canopy/brand/current';
import { authorizeCursorMcpTool } from '../tool-approval';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';

it('auto-allows an unlisted watch only on the authenticated main surface, including Plan mode', async () => {
  const check = jest.fn().mockResolvedValue({ decision: 'deny' });
  const context = {
    approval: {
      check,
      setMode: jest.fn(),
      dispose: jest.fn(),
      reevaluatePendingApprovals: jest.fn(),
    },
    cwd: '/work',
    toolCallId: 'call',
    planMode: true,
    managedToolNames: [],
    signal: new AbortController().signal,
  };
  for (const name of [
    'WatchDelegates',
    `mcp__${BRAND.tools.namespace}__WatchDelegates`,
    `${BRAND.tools.namespace}_watch_delegates`,
  ]) {
    expect(
      await authorizeCursorMcpTool(
        {
          server: cursorCanopyMcpServerNames('default').main,
          tool: name,
          args: {},
        },
        context,
      ),
    ).toEqual({ decision: 'allow' });
  }
  expect(check).not.toHaveBeenCalled();
  const abort = new AbortController();
  abort.abort();
  expect(
    await authorizeCursorMcpTool(
      {
        server: cursorCanopyMcpServerNames('default').main,
        tool: 'WatchDelegates',
        args: {},
      },
      { ...context, signal: abort.signal },
    ),
  ).toEqual({ decision: 'deny' });
});
