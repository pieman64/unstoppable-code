/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
import type { PluginMcpServerInfo } from '@canopy/protocol/plugins';
import type {
  PluginDetailMcpHealth,
  PluginDetailMcpHealthTarget,
  PluginDetailMcpServerHealth,
} from '@canopy/ui-app/capability';
import { MCP_MANAGEMENT_REASONS } from '@canopy/ui-shared/lib/mcp-card-display';
import type { UnifiedEntryBundledServerRow } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { usePluginMcpServerHealth } from '../usePluginMcpServerHealth';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const slack: PluginMcpServerInfo = {
  name: 'slack-mcp',
  type: 'http',
  url: 'https://mcp.slack.com/mcp',
};
const local: PluginMcpServerInfo = {
  name: 'local',
  type: 'command',
  command: 'npx',
};

const slackRow: UnifiedEntryBundledServerRow = {
  serverName: 'slack-mcp',
  endpoint: 'http:mcp.slack.com',
  entryId: 'entry-slack',
  serverId: 'srv-slack',
};

function indexEntry(
  overrides: Partial<McpServerIndexEntry> = {},
): McpServerIndexEntry {
  return {
    id: 'srv-slack',
    name: 'slack-mcp',
    description: '',
    type: 'http',
    configs: [{ id: 'cfg-1', name: 'Default' }],
    ...overrides,
  } as McpServerIndexEntry;
}

function statusEntry(
  overrides: Partial<McpServerStatusEntry> = {},
): McpServerStatusEntry {
  return {
    serverId: 'srv-slack',
    transport: 'http',
    connectionStatus: 'connected',
    reachability: 'reachable',
    configs: [],
    ...overrides,
  };
}

const loadIndex = jest.fn();
const listStatus = jest.fn();
const testConnection = jest.fn();
const onAuthChanged = jest.fn(() => (): void => {});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: PluginDetailMcpHealth | null = null;

function Probe({
  rows,
}: {
  rows?: readonly UnifiedEntryBundledServerRow[];
}): JSX.Element | null {
  latest = usePluginMcpServerHealth(rows);
  return null;
}

async function render(
  rows?: readonly UnifiedEntryBundledServerRow[],
): Promise<void> {
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(<Probe rows={rows} />);
    await Promise.resolve();
  });
}

function resolve(
  server: PluginMcpServerInfo,
): PluginDetailMcpServerHealth | undefined {
  if (!latest) throw new Error('hook did not render');
  return latest.resolve(server);
}

function targetOf(server: PluginMcpServerInfo): PluginDetailMcpHealthTarget {
  const health = resolve(server);
  if (health?.kind !== 'target') {
    throw new Error(`expected a target, got ${health?.kind ?? 'undefined'}`);
  }
  return health.target;
}

beforeEach(() => {
  loadIndex.mockResolvedValue({
    version: 1,
    servers: [indexEntry(), indexEntry({ id: 'srv-other', name: 'other' })],
  });
  listStatus.mockResolvedValue([statusEntry()]);
  testConnection.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: { loadIndex, listStatus, testConnection, onAuthChanged },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  jest.clearAllMocks();
});

describe('usePluginMcpServerHealth', () => {
  it('resolves a matched bundled server to its device index target', async () => {
    await render([slackRow]);
    const target = targetOf(slack);
    expect(target.targetKey).toBe('srv-slack');
    expect(target.configs).toEqual([{ id: 'cfg-1', name: 'Default' }]);
    expect(target.status).toEqual(statusEntry());
    expect(latest?.formatTimestamp).toEqual(expect.any(Function));
  });

  it('tests through the device IPC with the server and configuration ids', async () => {
    await render([slackRow]);
    const action = targetOf(slack).testConnection;
    if (!action?.available) throw new Error('expected an available test');
    await expect(action.run('cfg-1')).resolves.toEqual({ success: true });
    expect(testConnection).toHaveBeenCalledWith('srv-slack', 'cfg-1');
  });

  it('unwraps the Electron IPC wrapper from a failed test', async () => {
    testConnection.mockRejectedValue(
      new Error(
        "Error invoking remote method 'mcp-servers:test-connection': Error: Server is down",
      ),
    );
    await render([slackRow]);
    const action = targetOf(slack).testConnection;
    if (!action?.available) throw new Error('expected an available test');
    await expect(action.run('cfg-1')).rejects.toThrow(/^Server is down$/);
  });

  it('re-reads status after a test and keeps the target meanwhile', async () => {
    await render([slackRow]);
    expect(listStatus).toHaveBeenCalledTimes(1);
    let finishRead: (value: McpServerStatusEntry[]) => void = () => {};
    listStatus.mockReturnValueOnce(
      new Promise<McpServerStatusEntry[]>((done) => {
        finishRead = done;
      }),
    );
    await act(async () => {
      targetOf(slack).onTested?.();
      await Promise.resolve();
    });
    expect(listStatus).toHaveBeenCalledTimes(2);
    expect(resolve(slack)?.kind).toBe('target');
    await act(async () => {
      finishRead([statusEntry({ connectionStatus: 'unreachable' })]);
      await Promise.resolve();
    });
    expect(targetOf(slack).status?.connectionStatus).toBe('unreachable');
  });

  it('disables testing for account-scoped servers', async () => {
    loadIndex.mockResolvedValue({
      version: 1,
      servers: [indexEntry({ scope: 'account' })],
    });
    await render([slackRow]);
    expect(targetOf(slack).testConnection).toEqual({
      available: false,
      reason: MCP_MANAGEMENT_REASONS.cloudTest,
    });
  });

  it('disables testing for provider-handled servers', async () => {
    loadIndex.mockResolvedValue({
      version: 1,
      servers: [indexEntry({ authHandler: 'provider' })],
    });
    await render([slackRow]);
    expect(targetOf(slack).testConnection).toEqual({
      available: false,
      reason: MCP_MANAGEMENT_REASONS.provider,
    });
  });

  it('disables testing when the cached status reports the provider handler', async () => {
    listStatus.mockResolvedValue([statusEntry({ handler: 'provider' })]);
    await render([slackRow]);
    expect(targetOf(slack).testConnection).toEqual({
      available: false,
      reason: MCP_MANAGEMENT_REASONS.provider,
    });
  });

  it('returns undefined for a server with no bundled row or no rows', async () => {
    await render([slackRow]);
    expect(resolve(local)).toBeUndefined();
    expect(
      resolve({ ...slack, url: 'https://elsewhere.example.com/mcp' }),
    ).toBeUndefined();
    await render(undefined);
    expect(resolve(slack)).toBeUndefined();
  });

  it('reads Not configured yet when the index has no entry for the row', async () => {
    loadIndex.mockResolvedValue({ version: 1, servers: [] });
    await render([slackRow]);
    expect(resolve(slack)).toEqual({
      kind: 'unavailable',
      reason: 'Not configured yet',
    });
  });

  it('reads loading until the first index read settles', async () => {
    loadIndex.mockReturnValue(new Promise(() => {}));
    await render([slackRow]);
    expect(resolve(slack)).toEqual({ kind: 'loading' });
  });

  it('treats a failed index read as no device configuration', async () => {
    loadIndex.mockRejectedValue(new Error('no handler'));
    await render([slackRow]);
    expect(resolve(slack)).toEqual({
      kind: 'unavailable',
      reason: 'Not configured yet',
    });
  });

  it('reads the index once while the server set is unchanged', async () => {
    await render([slackRow]);
    await render([{ ...slackRow }]);
    await render([{ ...slackRow, entryId: 'entry-again' }, slackRow]);
    expect(loadIndex).toHaveBeenCalledTimes(1);
  });

  it('resolves two bundled rows sharing a server id to the same target', async () => {
    const mirror: PluginMcpServerInfo = {
      name: 'slack-mirror',
      type: 'http',
      url: 'https://mcp.slack.com/v2',
    };
    await render([
      slackRow,
      { ...slackRow, serverName: 'slack-mirror', entryId: 'entry-mirror' },
    ]);
    expect(targetOf(mirror).targetKey).toBe(targetOf(slack).targetKey);
  });
});
